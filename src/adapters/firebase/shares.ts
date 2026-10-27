/**
 * Shared links in Firestore: `shares/{shareId}`, and the owner's record of
 * each at `users/{uid}/shares/{shareId}`.
 *
 * Separated from `adapter.ts` for the reason `versions.ts` is: these are real
 * queries against a real server, and the emulator tests reach them here without
 * building a browser adapter (which calls `initializeAuth` and needs a DOM).
 *
 * ## Two documents, and why they are not one
 *
 * The public document holds ciphertext, a server timestamp and an expiry. It
 * deliberately carries **no owner id**, because a recipient can read it: an
 * owner field would let anyone holding two links tell they came from the same
 * account. So ownership is proved out of band, by the private record under the
 * user's own path, which the rules `get()` on every publish and delete.
 *
 * That private record is also what the "Shared links" dialog lists. It holds
 * the note id, the expiry, and the link's key **sealed under the vault** — so
 * the owner can copy a link again, or re-publish an edited note to the same
 * URL, from any of their devices, and the backend still cannot open anything.
 * The public document never holds the key; handing it to every recipient is
 * the one thing a per-share key exists to prevent.
 *
 * ## Publish is one commit; revoke is two deletes, in order
 *
 * Publish writes the private record, the public blob and the meter in **one
 * commit**. The rules authorise the blob by the record as the commit leaves it
 * (`getAfter`), and meter the publish like any other push — against this
 * month's links and today's pushes — which a separate, unmetered blob write
 * would escape. One commit also means no failure can leave half a publish.
 * (It used to be record first, blob second, each its own write; the order was
 * what let the blob's rule find the record, and a crash between them left an
 * orphan record.)
 *
 * Revoke is still two deletes: public blob first, private record second. The
 * blob is the thing that is readable, so it goes first; and deleting the
 * record first would remove the very proof the delete rule needs, stranding
 * the blob until it expired.
 *
 * ## Expiry, and what parking the TTL means here
 *
 * The rules refuse to *read* an expired share, so a link stops working the
 * moment it expires whether or not anything has deleted it. The TTL policy
 * that would delete it needs the Blaze plan and is parked in
 * `firestore.indexes.blaze.json` (docs/firebase-setup.md, "Version and share
 * expiry"), so today the ciphertext stays. `listShares` filters expired rows
 * itself for the same reason `listVersionPage` does.
 *
 * Reading a share is *not* here. That path has no session, no SDK and no
 * adapter — see `shareRest.ts`.
 */
import {
  doc,
  getDocs,
  writeBatch,
  deleteDoc,
  collection,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
  Bytes,
  type Firestore,
} from 'firebase/firestore';
import type { RemoteShare, ShareIndexEntry } from '../../core/sync/adapter.ts';
import { count } from './opCount.ts';
import { countMeter, meterInto } from './usage.ts';

const SCHEMA_VERSION = 1;

const publicShare = (db: Firestore, id: string) => doc(db, `shares/${id}`);
const indexCol = (db: Firestore, uid: string) => collection(db, `users/${uid}/shares`);

/**
 * Publish or re-publish. "Update link" is the same call with the same id and
 * the same key, which is what lets a link survive an edit without changing.
 */
export async function publishShare(
  db: Firestore,
  uid: string,
  share: RemoteShare,
  index: Omit<ShareIndexEntry, 'expireAt' | 'createdAt'>,
  /** Start a new push window: the caller saw the current one full. */
  reset = false,
): Promise<void> {
  const expireAt = Timestamp.fromMillis(share.expireAt);

  // Publishing is metered per month and counts as a push, in the same commit
  // as both documents (`./usage.ts`). A re-publish to the same link counts
  // again; that is rare, and it does upload the note again.
  const batch = writeBatch(db);
  batch.set(doc(indexCol(db, uid), share.id), {
    v: SCHEMA_VERSION,
    noteId: index.noteId,
    key: Bytes.fromUint8Array(index.key),
    expireAt,
    createdAt: serverTimestamp(),
  });
  batch.set(publicShare(db, share.id), {
    v: SCHEMA_VERSION,
    payload: Bytes.fromUint8Array(share.payload),
    createdAt: serverTimestamp(),
    expireAt,
  });
  meterInto(batch, db, uid, `shares/${share.id}`, { shares: 1, reset });
  await batch.commit();
  // The rules look up the private record to authorise the blob, which is one
  // more billed read than a note push costs.
  count('shares', 1, 2);
  countMeter();
}

/**
 * Withdraw a link. Public blob first, owner's record second.
 *
 * Revoking is idempotent, and the argument for swallowing that one
 * `permission-denied` is narrow enough to write down: the delete rule on the
 * public document is `signedIn() && exists(<the owner's record>)` and nothing
 * else — no allowlist check, so a withdrawn invitation still lets someone take
 * their links down. A caller that already holds a uid is signed in, so the only
 * remaining way to be refused is that the record is gone, which means the share
 * was already revoked. A session that died mid-call reports `unauthenticated`
 * instead and still propagates.
 *
 * That also makes the retry path work: a revoke whose second delete failed
 * leaves an orphan record, and running it again deletes an absent blob (fine)
 * and then the record.
 */
export async function revokeShare(db: Firestore, uid: string, id: string): Promise<void> {
  try {
    await deleteDoc(publicShare(db, id));
    count('shares', 1, 1);
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'permission-denied') throw error;
  }
  await deleteDoc(doc(indexCol(db, uid), id));
  count('shares', 0, 1);
}

/**
 * Every link this account has published and not yet lost.
 *
 * Newest first, and expired rows are dropped here rather than filtered in a
 * query: `expireAt` and `createdAt` in one `where`/`orderBy` pair would need a
 * composite index, and the list is small enough that the whole thing is one
 * page. An expired row is gone as far as anyone reading is concerned, the same
 * way an expired version is.
 */
export async function listShares(db: Firestore, uid: string): Promise<ShareIndexEntry[]> {
  const snapshot = await getDocs(query(indexCol(db, uid), orderBy('createdAt', 'desc')));
  count('shares', Math.max(1, snapshot.size), 0);

  const now = Date.now();
  const out: ShareIndexEntry[] = [];
  for (const row of snapshot.docs) {
    const data = row.data();
    const expire = data.expireAt;
    const created = data.createdAt;
    const expireAt = expire instanceof Timestamp ? expire.toMillis() : 0;
    if (expireAt <= now) continue;
    const key = data.key;
    if (!(key instanceof Bytes)) continue;
    out.push({
      id: row.id,
      noteId: typeof data.noteId === 'string' ? data.noteId : '',
      key: key.toUint8Array() as ShareIndexEntry['key'],
      expireAt,
      createdAt: created instanceof Timestamp ? created.toMillis() : 0,
    });
  }
  return out;
}
