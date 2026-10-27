/**
 * Note versions in Firestore: `users/{uid}/notes/{noteId}/versions/{sealId}`.
 *
 * Separated from `adapter.ts` for the reason `pull.ts` is: these are real
 * queries against a real server, and the emulator tests reach them here without
 * building a browser adapter.
 *
 * ## Why a subcollection of the note
 *
 * The delta pull and the change listener both read `users/{uid}/notes`, and a
 * write to a subcollection is invisible to a query on its parent collection. So
 * uploading a hundred versions moves no pull cursor, wakes no listener on any
 * other device and bills no reads anywhere — versions cost what they cost to
 * write and to read on demand, and nothing else. A per-note path also makes the
 * one query history needs ("this note's versions, newest first") a plain
 * single-field ordering with no composite index.
 *
 * ## Immutable, and removed by the backend
 *
 * The rules allow create and nothing else. A version is removed by Firestore's
 * TTL policy on `expireAt`, not by a client, so a stolen session cannot erase
 * the history that protects against it overwriting notes. That policy needs the
 * Blaze plan and is parked in `firestore.indexes.blaze.json` until the project
 * has it (docs/firebase-setup.md, "Version and share expiry"); until then
 * nothing removes expired versions at all. Even with it, the sweep lags expiry
 * by a day or more.
 * Either way readers filter on `expireAt` themselves, which is why parking it
 * changes nothing a user sees.
 *
 * ## Writes
 *
 * **One version per commit**, each with its own meter write. It used to be one
 * batch per page, which the rules could only check per version against the
 * batch's total — so a modified client could under-count a page by up to 99
 * versions. A commit that names its one version in `lastDoc` and raises `hist`
 * by exactly that version's charge leaves nothing to under-count, and each one
 * is a push against the daily limit like any other write. The price is a meter
 * write per version instead of per page, and a request each; the engine keeps
 * pages small for that reason (`VERSION_PAGE`).
 *
 * The usual refusal is benign — the same sealing already written by another
 * device or by a retry whose acknowledgement was lost; a create on a document
 * that exists is an update, and updates are refused — and reading the
 * document back tells that apart from a malformed version or a revoked account.
 * A refusal the meter explains is not per version: over this month's history
 * budget the rest of the page stays on the device, and with the push window
 * full the page waits (`PushLimitError`) until the window rolls over.
 */
import {
  doc,
  getDoc,
  getDocs,
  writeBatch,
  collection,
  query,
  orderBy,
  documentId,
  startAfter,
  limit as fsLimit,
  serverTimestamp,
  Timestamp,
  Bytes,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { RemoteVersion, SyncCursor, VersionPage } from '../../core/sync/adapter.ts';
import {
  HISTORY_BYTES_PER_MONTH,
  PushLimitError,
  chargedBytes,
  countedNoteBytes,
  pushWindowFull,
} from '../../core/sync/usage.ts';
import type { Bytes as RawBytes } from '../../core/crypto/bytes.ts';
import { count } from './opCount.ts';
import { countMeter, meterInto, readUsageQuietly, windowRetryAt } from './usage.ts';

const SCHEMA_VERSION = 1;

/** Thrown when reading a document back is refused too: the account, not the version. */
export class VersionAccessDenied extends Error {}

const versionsCol = (db: Firestore, uid: string, noteId: string) =>
  collection(db, `users/${uid}/notes/${noteId}/versions`);

function toDoc(version: RemoteVersion): Record<string, unknown> {
  return {
    v: SCHEMA_VERSION,
    meta: Bytes.fromUint8Array(version.meta),
    body: Bytes.fromUint8Array(version.body),
    at: version.at,
    reason: version.reason,
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(version.expireAt),
  };
}

export function readVersion(noteId: string, snapshot: QueryDocumentSnapshot<DocumentData>): RemoteVersion {
  const data = snapshot.data();
  const created = data.createdAt;
  const expire = data.expireAt;
  const version: RemoteVersion = {
    noteId,
    id: snapshot.id,
    meta: (data.meta as Bytes).toUint8Array() as RawBytes,
    body: (data.body as Bytes).toUint8Array() as RawBytes,
    at: data.at as number,
    reason: data.reason as RemoteVersion['reason'],
    expireAt: expire instanceof Timestamp ? expire.toMillis() : 0,
  };
  if (created instanceof Timestamp) version.createdAt = created.toMillis();
  return version;
}

/** What a version counts for against this month's `hist`, minimum charge included. */
const versionBytes = (version: RemoteVersion) => chargedBytes(countedNoteBytes(version.meta, version.body));

const isPermissionDenied = (error: unknown) => (error as { code?: string } | null)?.code === 'permission-denied';

/**
 * Write versions, one commit each. Resolves with the ones the backend refused
 * for their own sake (or that this month's history budget cannot take); throws
 * `VersionAccessDenied` when it refuses the account, `PushLimitError` when the
 * push window is full, and passes any other error (offline, session) through
 * for the caller to classify. A version already written stays written when a
 * later one throws, which is harmless: re-uploading it is the benign refusal.
 */
export async function pushVersionBatch(
  db: Firestore,
  uid: string,
  versions: readonly RemoteVersion[],
): Promise<{ refused: RemoteVersion[] }> {
  const refused: RemoteVersion[] = [];

  // History is metered per month as it is uploaded, in the same commit
  // (`./usage.ts`): it expires by TTL, which runs no rules, so a stored total of
  // it could only ever go up.
  const write = async (version: RemoteVersion, reset: boolean) => {
    const ref = doc(versionsCol(db, uid, version.noteId), version.id);
    const batch = writeBatch(db);
    batch.set(ref, toDoc(version));
    meterInto(batch, db, uid, `notes/${version.noteId}/versions/${version.id}`, {
      history: versionBytes(version),
      reset,
    });
    await batch.commit();
    count('versions', 0, 1);
    countMeter();
  };

  for (let i = 0; i < versions.length; i++) {
    const version = versions[i]!;
    try {
      await write(version, false);
      continue;
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
    }

    let exists: boolean;
    try {
      exists = (await getDoc(doc(versionsCol(db, uid, version.noteId), version.id))).exists();
      count('probe', 1, 0);
    } catch (probe) {
      if (isPermissionDenied(probe)) throw new VersionAccessDenied();
      throw probe;
    }
    // Already written — by another device holding the same sealing, or by a
    // retry whose acknowledgement never arrived. The backend has it.
    if (exists) continue;

    const usage = await readUsageQuietly(db, uid);
    // Over this month's history budget, every version would be refused one by
    // one, at a write and two reads each. Keep the rest of the page on the
    // device instead: the history is still there, it is just not in the cloud
    // this month.
    if (usage && usage.historyThisMonth + versionBytes(version) > HISTORY_BYTES_PER_MONTH) {
      refused.push(...versions.slice(i));
      return { refused };
    }
    if (usage && pushWindowFull(usage)) {
      try {
        await write(version, true);
        continue;
      } catch (retry) {
        if (!isPermissionDenied(retry)) throw retry;
        throw new PushLimitError(windowRetryAt(usage));
      }
    }
    refused.push(version);
  }
  return { refused };
}

/** Cursor for a page of versions: the last one delivered, `(createdAt, id)`. */
function encodeCursor(last: RemoteVersion | undefined): SyncCursor {
  return last ? JSON.stringify({ at: last.createdAt ?? 0, id: last.id }) : null;
}

function decodeCursor(cursor: SyncCursor | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as { at?: unknown; id?: unknown };
    return typeof parsed.at === 'number' && typeof parsed.id === 'string' ? { at: parsed.at, id: parsed.id } : null;
  } catch {
    return null;
  }
}

/**
 * One page of a note's versions, newest first.
 *
 * Ordered by the server's `createdAt` and then the id, which is a total order:
 * versions written in the same millisecond (and, before uploads went one per
 * commit, every version of a batch) share a `createdAt`, so the timestamp
 * alone would skip ties across a page boundary. `documentId()` is
 * appended to every single-field index, so this needs no composite index.
 */
export async function listVersionPage(
  db: Firestore,
  uid: string,
  noteId: string,
  limit: number,
  cursor?: SyncCursor,
): Promise<VersionPage> {
  const ordered = query(versionsCol(db, uid, noteId), orderBy('createdAt', 'desc'), orderBy(documentId(), 'desc'));
  const from = decodeCursor(cursor);
  const page = from
    ? query(ordered, startAfter(Timestamp.fromMillis(from.at), from.id), fsLimit(limit))
    : query(ordered, fsLimit(limit));

  const snapshot = await getDocs(page);
  count('versions', Math.max(1, snapshot.size), 0);
  const all = snapshot.docs.map((d) => readVersion(noteId, d));
  const now = Date.now();
  return {
    // Nothing may have removed it yet — TTL lags expiry, and is parked until
    // Blaze — but an expired version is gone as far as anyone reading is concerned.
    versions: all.filter((v) => v.expireAt > now),
    cursor: encodeCursor(all[all.length - 1]) ?? cursor ?? null,
    hasMore: snapshot.size === limit,
  };
}
