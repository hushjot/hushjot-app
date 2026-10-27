/**
 * The history database: note versions, as ciphertext, in a database of its own.
 *
 * ## Why not a store in `teksto`
 *
 * A new object store means a `DB_VERSION` bump, and `openDb` rejects an upgrade
 * that another open tab blocks — `Workspace.init` then falls back to an empty
 * in-memory workspace, and a user with a second tab open upgrades into "my
 * notes are gone" (`core/sync/state.ts` has the full story). A separate
 * database cannot do that to the notes. If *this* one is blocked, unavailable
 * or full, history is off for the session and nothing else notices.
 *
 * It also keeps the note database's own scans honest: `clearSyncState` walks
 * every `kv` key, and 50 MB of versions there would be walked with it.
 *
 * ## What is readable here
 *
 * `id`, `noteId`, `sealId` (a nonce already in the clear inside the body),
 * `at`, `capturedAt`, `expireAt`, `reason`, `bytes` and `state`. The title,
 * folder and text are the sealed blobs copied from the note database. See
 * docs/security.md § "What is stored, and where".
 *
 * ## The upload queue is an index, not a store
 *
 * A version waiting to go to the backend is a version whose `state` is
 * `queued`. The `byState` index answers "what is left to send" in capture order
 * without a second copy of anything, and marking one sent is a field change on
 * the record itself — so a version can never be in the queue and gone, or sent
 * and still queued.
 *
 * ## Summaries without bodies
 *
 * Pruning has to see every version's size and expiry, and a version's value is
 * its whole body. The `bySummary` index holds exactly those fields in its key,
 * so a key cursor over it walks 50,000 versions without loading one byte of
 * ciphertext.
 */
import { openDb, req, txDone } from '../repo/idb.ts';
import { noteIdOf, type VersionReason, type VersionRecord, type VersionState } from './record.ts';
import type { VersionSummary } from './retention.ts';
import { HISTORY_DB_NAME } from './names.ts';
const HISTORY_DB_VERSION = 2;

const STORE_VERSIONS = 'versions';
const STORE_META = 'meta';
const INDEX_BY_NOTE = 'byNote';
const INDEX_SUMMARY = 'bySummary';
const INDEX_BY_STATE = 'byState';

function upgrade(db: IDBDatabase, tx: IDBTransaction, fromVersion: number): void {
  if (fromVersion < 1) {
    const versions = db.createObjectStore(STORE_VERSIONS, { keyPath: 'id' });
    versions.createIndex(INDEX_BY_NOTE, ['noteId', 'capturedAt'], { unique: false });
    versions.createIndex(INDEX_SUMMARY, ['expireAt', 'capturedAt', 'bytes', 'reason'], { unique: false });
    db.createObjectStore(STORE_META);
  }
  // v1 -> v2: the upload queue, for synced history.
  if (fromVersion < 2) {
    tx.objectStore(STORE_VERSIONS).createIndex(INDEX_BY_STATE, ['state', 'capturedAt'], { unique: false });
  }
  // Future versions append their migrations here. Never edit an existing block.
}

export interface HistoryStore {
  /** Store a version. False when one with this id already exists. */
  add(record: VersionRecord): Promise<boolean>;
  /** Store a version, replacing one with the same id. */
  put(record: VersionRecord): Promise<void>;
  /** One note's versions, newest capture first. */
  listForNote(noteId: string): Promise<VersionRecord[]>;
  latestForNote(noteId: string): Promise<VersionRecord | undefined>;
  get(id: string): Promise<VersionRecord | undefined>;
  /** Captures of `noteId` in `[from, to)`. */
  countCaptured(noteId: string, from: number, to: number): Promise<number>;
  /** Note ids that have at least one version. Keys only. */
  noteIds(): Promise<Set<string>>;
  summaries(): Promise<VersionSummary[]>;
  /** Delete in slices, yielding between them so no task runs long. */
  remove(ids: readonly string[]): Promise<void>;
  /** Versions in `state`, oldest capture first. */
  withState(state: VersionState, maxCount?: number): Promise<VersionRecord[]>;
  /** Move each existing version in `ids` to `state`. Missing ids are ignored. */
  setState(ids: readonly string[], state: VersionState): Promise<void>;
  /** Move every version in `from` to `to`. */
  moveState(from: VersionState, to: VersionState): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  close(): void;
}

export async function openHistoryStore(name = HISTORY_DB_NAME): Promise<HistoryStore> {
  const db = await openDb({ name, version: HISTORY_DB_VERSION, upgrade });
  const versions = (mode: IDBTransactionMode = 'readonly') =>
    db.transaction(STORE_VERSIONS, mode).objectStore(STORE_VERSIONS);
  const byNote = (noteId: string) =>
    IDBKeyRange.bound([noteId, -Infinity], [noteId, Infinity]);

  return {
    async add(record) {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const store = tx.objectStore(STORE_VERSIONS);
      // Resolves from an IndexedDB callback in the same task, so the
      // transaction is still active for the put.
      const existing = await req(store.getKey(record.id));
      if (existing !== undefined) {
        await txDone(tx);
        return false;
      }
      store.put(record);
      await txDone(tx);
      return true;
    },

    async put(record) {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      tx.objectStore(STORE_VERSIONS).put(record);
      await txDone(tx);
    },

    async listForNote(noteId) {
      const rows = (await req(versions().index(INDEX_BY_NOTE).getAll(byNote(noteId)))) as VersionRecord[];
      return rows.reverse();
    },

    async latestForNote(noteId) {
      const cursor = await req(versions().index(INDEX_BY_NOTE).openCursor(byNote(noteId), 'prev'));
      return (cursor?.value as VersionRecord | undefined) ?? undefined;
    },

    async get(id) {
      return (await req(versions().get(id))) as VersionRecord | undefined;
    },

    async countCaptured(noteId, from, to) {
      const range = IDBKeyRange.bound([noteId, from], [noteId, to], false, true);
      return req(versions().index(INDEX_BY_NOTE).count(range));
    },

    async noteIds() {
      const keys = (await req(versions().getAllKeys())) as string[];
      return new Set(keys.map(noteIdOf));
    },

    async summaries() {
      const out: VersionSummary[] = [];
      const request = versions().index(INDEX_SUMMARY).openKeyCursor();
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const [expireAt, capturedAt, bytes, reason] = cursor.key as [number, number, number, VersionReason];
          const id = cursor.primaryKey as string;
          out.push({ id, noteId: noteIdOf(id), expireAt, capturedAt, bytes, reason });
          cursor.continue();
        };
      });
      return out;
    },

    async remove(ids) {
      const SLICE = 500;
      for (let i = 0; i < ids.length; i += SLICE) {
        const tx = db.transaction(STORE_VERSIONS, 'readwrite');
        const store = tx.objectStore(STORE_VERSIONS);
        for (const id of ids.slice(i, i + SLICE)) store.delete(id);
        await txDone(tx);
        if (i + SLICE < ids.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },

    async withState(state, maxCount) {
      const range = IDBKeyRange.bound([state, -Infinity], [state, Infinity]);
      return (await req(versions().index(INDEX_BY_STATE).getAll(range, maxCount))) as VersionRecord[];
    },

    async setState(ids, state) {
      if (ids.length === 0) return;
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const store = tx.objectStore(STORE_VERSIONS);
      // Every read is issued up front and each write happens in its read's
      // callback, so the transaction never goes idle between them.
      for (const id of ids) {
        const read = store.get(id);
        read.onsuccess = () => {
          const record = read.result as VersionRecord | undefined;
          if (record && record.state !== state) store.put({ ...record, state });
        };
      }
      await txDone(tx);
    },

    async moveState(from, to) {
      const tx = db.transaction(STORE_VERSIONS, 'readwrite');
      const range = IDBKeyRange.bound([from, -Infinity], [from, Infinity]);
      const request = tx.objectStore(STORE_VERSIONS).index(INDEX_BY_STATE).openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.update({ ...(cursor.value as VersionRecord), state: to });
        cursor.continue();
      };
      await txDone(tx);
    },

    async getMeta<T>(key: string) {
      return (await req(db.transaction(STORE_META).objectStore(STORE_META).get(key))) as T | undefined;
    },

    async setMeta(key, value) {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(value, key);
      await txDone(tx);
    },

    close() {
      db.close();
    },
  };
}
