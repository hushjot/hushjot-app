/**
 * One-shot migrations of the stored records: from a pre-vault (plaintext)
 * database, and from unbound version-1 envelopes to bound version-2 ones.
 *
 * Phase 2 stored readable JSON and text; Phase 3 stores ciphertext under the
 * same schema. A database written before the vault existed therefore has notes
 * the encrypted codec cannot read — they would render as "Unreadable note"
 * forever, which is not data loss but is indistinguishable from it to the
 * person looking at it.
 *
 * So at vault creation, any plaintext record is re-encrypted in place.
 *
 * §25 lists "app upgrade changes encrypted payload version" as a scenario that
 * must be tested, and this is the first instance of it. The second is
 * `resealLegacyRecords`, below.
 */
import { openDb, req, txDone } from './idb.ts';
import {
  DB_NAME,
  DB_VERSION,
  STORE_FOLDERS,
  STORE_KV,
  STORE_NOTE_BODY,
  STORE_NOTE_META,
  upgrade,
  type StoredFolder,
  type StoredNoteBody,
  type StoredNoteMeta,
} from './schema.ts';
import { seal, open } from '../crypto/envelope.ts';
import { recordContext, isUnboundEnvelope, type RecordKind } from '../crypto/binding.ts';
import { utf8 } from '../crypto/bytes.ts';
import { sealIdOf } from '../history/record.ts';
import type { NoteSyncState } from '../sync/state.ts';

export interface MigrationResult {
  notes: number;
  folders: number;
}

/** A record still in the Phase 2 plaintext form is a string, not bytes. */
const isPlaintext = (value: unknown): value is string => typeof value === 'string';

/**
 * Re-encrypt every plaintext record with `key`. Safe to call unconditionally:
 * a database that is already encrypted, or empty, is left untouched.
 */
export async function migratePlaintextRecords(
  key: CryptoKey,
  dbName = DB_NAME,
): Promise<MigrationResult> {
  const db = await openDb({ name: dbName, version: DB_VERSION, upgrade });

  try {
    const [metaRows, bodyRows, folderRows] = await Promise.all([
      req(db.transaction(STORE_NOTE_META).objectStore(STORE_NOTE_META).getAll()) as Promise<
        StoredNoteMeta[]
      >,
      req(db.transaction(STORE_NOTE_BODY).objectStore(STORE_NOTE_BODY).getAll()) as Promise<
        StoredNoteBody[]
      >,
      req(db.transaction(STORE_FOLDERS).objectStore(STORE_FOLDERS).getAll()) as Promise<
        StoredFolder[]
      >,
    ]);

    const staleMeta = metaRows.filter((r) => isPlaintext(r.meta));
    const staleBody = bodyRows.filter((r) => isPlaintext(r.body));
    const staleFolders = folderRows.filter((r) => isPlaintext(r.data));

    if (staleMeta.length === 0 && staleBody.length === 0 && staleFolders.length === 0) {
      return { notes: 0, folders: 0 };
    }

    // Seal everything before opening the write transaction: an IndexedDB
    // transaction auto-commits once its request queue drains, and awaiting
    // crypto inside one would let it close underneath us.
    const [sealedMeta, sealedBody, sealedFolders] = await Promise.all([
      Promise.all(
        staleMeta.map(async (row) => ({
          ...row,
          meta: await seal(key, utf8(row.meta as string), recordContext('note-meta', row.id)),
        })),
      ),
      Promise.all(
        staleBody.map(async (row) => ({
          ...row,
          body: await seal(key, utf8(row.body as string), recordContext('note-body', row.id)),
        })),
      ),
      Promise.all(
        staleFolders.map(async (row) => ({
          ...row,
          data: await seal(key, utf8(row.data as string), recordContext('folder', row.id)),
        })),
      ),
    ]);

    const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY, STORE_FOLDERS], 'readwrite');
    const metaStore = tx.objectStore(STORE_NOTE_META);
    const bodyStore = tx.objectStore(STORE_NOTE_BODY);
    const folderStore = tx.objectStore(STORE_FOLDERS);

    for (const row of sealedMeta) metaStore.put(row);
    for (const row of sealedBody) bodyStore.put(row);
    for (const row of sealedFolders) folderStore.put(row);

    // One transaction for the whole migration: either the database is fully
    // encrypted afterwards or it is untouched, never half-converted.
    await txDone(tx);

    return { notes: sealedMeta.length, folders: sealedFolders.length };
  } finally {
    db.close();
  }
}

/**
 * Set once a database holds no version-1 envelope this device wrote, so the
 * re-seal costs one key read on every unlock after the first. Lives in `kv`
 * beside the sync cursor; the name is new, so it is `hushjot:` rather than one
 * of the frozen `teksto:` identifiers.
 */
export const RESEALED_KEY = 'hushjot:envelopeBound';

export interface ResealResult {
  notes: number;
  folders: number;
}

/** Same bytes, compared by value: the guard against a write we raced. */
function sameBytes(a: unknown, b: Uint8Array): boolean {
  if (!(a instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Mark a database as already bound — for a vault created by this build, whose
 * every record is sealed bound from the start, so its first unlock does not
 * read every body just to learn there is nothing to do.
 */
export async function markResealed(dbName = DB_NAME): Promise<void> {
  const db = await openDb({ name: dbName, version: DB_VERSION, upgrade });
  try {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put(true, RESEALED_KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/**
 * Re-seal every version-1 record on this device as a bound version-2 one.
 *
 * Unlike the plaintext migration this runs with the workspace live — it is
 * reached from the first unlock after an upgrade, not from vault creation — so
 * three things are different:
 *
 * - **A write may land between our read and our put.** Each row is put only if
 *   its stored blob is still, byte for byte, the one that was re-sealed; a row
 *   that moved on was rewritten by this build, which seals bound anyway.
 * - **Nothing is queued for sync.** The plaintext is unchanged, so this is not
 *   an edit, and pushing it would race other devices doing the same and the
 *   backend's newer revisions — a stale re-seal losing a compare-and-swap reads
 *   as a text conflict and forks the note. The server keeps its version-1 copy
 *   until the note is next edited, which the legacy window covers.
 * - **The sync state's `bodySeal` follows the body.** It records the nonce of
 *   the body the backend agreed to, and is how a rejected pin or move proves it
 *   was metadata only (`sync/state.ts`). A re-sealed body draws a new nonce, so
 *   where the old one matched, the new one is recorded in its place — the text
 *   is still the agreed text. Leaving it would make the next pin that loses a
 *   race fork the note.
 *
 * History versions are not touched: re-sealing one would change its id, which
 * is derived from the nonce and mirrored on the server. They age out within
 * thirty days, inside the legacy window.
 *
 * Unreadable records are skipped rather than failed — they were unreadable
 * before, and stay exactly as they were.
 */
export async function resealLegacyRecords(key: CryptoKey, dbName = DB_NAME): Promise<ResealResult> {
  const db = await openDb({ name: dbName, version: DB_VERSION, upgrade });

  try {
    if ((await req(db.transaction(STORE_KV).objectStore(STORE_KV).get(RESEALED_KEY))) === true) {
      return { notes: 0, folders: 0 };
    }

    const [metaRows, bodyRows, folderRows] = await Promise.all([
      req(db.transaction(STORE_NOTE_META).objectStore(STORE_NOTE_META).getAll()) as Promise<StoredNoteMeta[]>,
      req(db.transaction(STORE_NOTE_BODY).objectStore(STORE_NOTE_BODY).getAll()) as Promise<StoredNoteBody[]>,
      req(db.transaction(STORE_FOLDERS).objectStore(STORE_FOLDERS).getAll()) as Promise<StoredFolder[]>,
    ]);

    const unbound = (value: unknown): value is Uint8Array =>
      value instanceof Uint8Array && isUnboundEnvelope(value);

    async function reseal(kind: RecordKind, id: string, old: Uint8Array): Promise<Uint8Array | null> {
      try {
        const context = recordContext(kind, id);
        return await seal(key, await open(key, old, context), context);
      } catch {
        return null;
      }
    }

    // Seal everything before opening the write transaction, for the reason the
    // plaintext migration gives.
    const [metas, bodies, folders] = await Promise.all([
      Promise.all(
        metaRows.filter((r) => unbound(r.meta)).map(async (r) => ({ id: r.id, old: r.meta as Uint8Array, next: await reseal('note-meta', r.id, r.meta as Uint8Array) })),
      ),
      Promise.all(
        bodyRows.filter((r) => unbound(r.body)).map(async (r) => ({ id: r.id, old: r.body as Uint8Array, next: await reseal('note-body', r.id, r.body as Uint8Array) })),
      ),
      Promise.all(
        folderRows.filter((r) => unbound(r.data)).map(async (r) => ({ id: r.id, old: r.data as Uint8Array, next: await reseal('folder', r.id, r.data as Uint8Array) })),
      ),
    ]);

    const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY, STORE_FOLDERS, STORE_KV], 'readwrite');
    const metaStore = tx.objectStore(STORE_NOTE_META);
    const bodyStore = tx.objectStore(STORE_NOTE_BODY);
    const folderStore = tx.objectStore(STORE_FOLDERS);
    const kv = tx.objectStore(STORE_KV);
    const touchedNotes = new Set<string>();
    let touchedFolders = 0;

    // Callbacks rather than `await`: every request here is chained from the
    // previous one's success, which keeps the transaction alive without
    // yielding to anything that is not IndexedDB.
    for (const m of metas) {
      if (!m.next) continue;
      const next = m.next;
      const get = metaStore.get(m.id);
      get.onsuccess = () => {
        const row = get.result as StoredNoteMeta | undefined;
        if (!row || !sameBytes(row.meta, m.old)) return;
        metaStore.put({ ...row, meta: next });
        touchedNotes.add(m.id);
      };
    }
    for (const b of bodies) {
      if (!b.next) continue;
      const next = b.next;
      const get = bodyStore.get(b.id);
      get.onsuccess = () => {
        const row = get.result as StoredNoteBody | undefined;
        if (!row || !sameBytes(row.body, b.old)) return;
        bodyStore.put({ ...row, body: next });
        touchedNotes.add(b.id);
        const stateKey = `sync:note:${b.id}`;
        const state = kv.get(stateKey);
        state.onsuccess = () => {
          const current = state.result as NoteSyncState | undefined;
          const oldSeal = sealIdOf(b.old);
          const newSeal = sealIdOf(next);
          if (current?.bodySeal && oldSeal && newSeal && current.bodySeal === oldSeal) {
            kv.put({ ...current, bodySeal: newSeal }, stateKey);
          }
        };
      };
    }
    for (const f of folders) {
      if (!f.next) continue;
      const next = f.next;
      const get = folderStore.get(f.id);
      get.onsuccess = () => {
        const row = get.result as StoredFolder | undefined;
        if (!row || !sameBytes(row.data, f.old)) return;
        folderStore.put({ ...row, data: next });
        touchedFolders++;
      };
    }

    // Done even if something was skipped: a record that would not open is
    // damaged, not pending, and retrying would read every body on every unlock
    // to fail at the same place.
    kv.put(true, RESEALED_KEY);

    await txDone(tx);
    return { notes: touchedNotes.size, folders: touchedFolders };
  } finally {
    db.close();
  }
}
