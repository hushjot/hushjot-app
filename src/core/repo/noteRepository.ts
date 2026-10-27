/**
 * The local note repository — the app's source of truth for interactive
 * operations (§6). Firestore becomes a synchronisation backend behind this in
 * Phase 4; nothing above this layer will need to know.
 *
 * Two rules shape the API:
 *
 * 1. **Metadata and bodies are fetched separately.** `loadAllMeta()` is the
 *    cold-start path and never touches a body. `loadBody(id)` is the note-open
 *    path. Spike 3 measured 41 ms and 0.3 ms respectively at 10,000 notes.
 * 2. **Nothing here is on the typing path.** Callers mutate memory and persist
 *    on a debounce; the repository is free to be async.
 */
import { openDb, req, txDone } from './idb.ts';
import {
  DB_NAME,
  DB_VERSION,
  INDEX_UPDATED_AT,
  STORE_FOLDERS,
  STORE_KV,
  STORE_NOTE_BODY,
  STORE_NOTE_META,
  STORE_SYNC_QUEUE,
  upgrade,
  type QueuedChange,
  type StoredFolder,
  type StoredNoteBody,
  type StoredNoteMeta,
} from './schema.ts';
import { plaintextCodec, type Codec } from './codec.ts';
import { isSweepable } from '../sync/backfill.ts';
import type { Encoded } from './schema.ts';
import { excerptOf } from '../notes/model.ts';
import type { NoteMeta } from '../notes/model.ts';
import type { Folder } from '../notes/folders.ts';

export interface PersistedNote {
  id: string;
  title: string;
  folderId: string | null;
  pinnedAt: number | null;
  content: string;
  updatedAt: number;
  createdAt: number;
  revision: number;
}

/** Note metadata plus the revision, which sync and the crash journal need. */
export type PersistedMeta = NoteMeta & { revision: number };

/**
 * A note exactly as stored: ciphertext plus the reconciliation fields.
 *
 * The sync engine works in these, never in decoded notes. Moving stored bytes
 * straight to the backend means the engine never needs the key, and a note is
 * never decrypted and re-encrypted just to be uploaded.
 */
export interface RawNote {
  id: string;
  meta: Encoded;
  body: Encoded | undefined;
  updatedAt: number;
  revision: number;
  deleted: boolean;
}

export interface RawFolder {
  id: string;
  data: Encoded;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface NoteRepository {
  loadAllMeta(): Promise<PersistedMeta[]>;
  loadBody(id: string): Promise<string | null>;
  loadFolders(): Promise<Folder[]>;
  /**
   * Has this database ever held a note? Counts tombstones, which is the whole
   * point: `loadAllMeta` hides them, so a user who deleted every note looks
   * like a brand-new one to anything that asks how many notes are visible.
   */
  hasAnyNote(): Promise<boolean>;
  /**
   * Claim the one-time right to write first-run content, returning true to
   * exactly one caller ever.
   *
   * Read-then-write in a single transaction rather than a `get` followed by a
   * `set`: two tabs opening a fresh install do both run the check, and with a
   * gap between the two halves both would win and the user would get two of
   * every seed note — the bug this whole mechanism exists to stop.
   */
  claimFirstRun(): Promise<boolean>;
  /** Record that first-run content is settled, without writing any. */
  markFirstRunDone(): Promise<void>;
  /** Whether the first-run claim has already been made. */
  firstRunDone(): Promise<boolean>;
  /**
   * The account this database's contents belong to, if one has claimed it.
   *
   * Survives sign-out on purpose. `clearSyncState()` deletes the cursor, the
   * anchors and the queue so the next account cannot inherit them, but that
   * leaves nothing to say whose notes are still sitting here — and a sweep
   * keyed on "never pushed" would then upload them into whoever signs in next.
   * This is the memory that makes that distinguishable.
   */
  owner(): Promise<string | undefined>;
  setOwner(uid: string): Promise<void>;
  /**
   * Ids this device could upload, tombstones included and pre-vault plaintext
   * records excluded. Reads keys and encoded blobs only — a queue row needs an
   * id, not a decoded title, and decoding 10,000 metas to build one would cost
   * more than the sweep it feeds.
   */
  sweepableIds(): Promise<{ notes: string[]; folders: string[] }>;
  putNote(note: PersistedNote): Promise<void>;
  putNotes(notes: readonly PersistedNote[]): Promise<void>;
  /** Metadata only — used when a note moves folder without its text changing. */
  putNoteMeta(meta: NoteMeta & { revision: number }): Promise<void>;
  deleteNote(id: string, at?: number): Promise<void>;
  putFolder(folder: Folder): Promise<void>;
  deleteFolder(id: string, at?: number): Promise<void>;
  // --- raw access, for the sync engine ------------------------------------
  /** Stored ciphertext for one note, undecoded. */
  loadRawNote(id: string): Promise<RawNote | null>;
  /**
   * Stored ciphertext for several notes, in one read transaction that is
   * opened *synchronously*, before this returns its promise.
   *
   * That is the point of it. History keeps the text a save is about to
   * replace, and IndexedDB will not start a read-write transaction until every
   * overlapping transaction created before it has finished — so calling this
   * ahead of `putNotes` sees the old rows, without the save waiting for it.
   */
  loadRawNotes(ids: readonly string[]): Promise<RawNote[]>;
  /**
   * Deleted notes whose tombstone is at or after `since`, newest first, with
   * their decoded title and folder (the tombstone keeps the sealed meta).
   */
  loadTombstones(since: number): Promise<(PersistedMeta & { deleted: true })[]>;
  loadRawFolder(id: string): Promise<RawFolder | null>;
  /** Write ciphertext straight from the backend, without decoding it. */
  putRawNote(note: RawNote): Promise<void>;
  putRawFolder(folder: RawFolder): Promise<void>;

  // --- outbound queue -------------------------------------------------------
  enqueue(id: string, kind: 'note' | 'folder', at?: number): Promise<void>;
  /**
   * Queue many records in one transaction.
   *
   * The backfill sweep can carry 10,000 entries, and `enqueue` opens its own
   * transaction per call — which is the entire cost at that size. Same shape as
   * `putNotes` and the plaintext migration: one transaction, N puts, either all
   * of it lands or none of it does.
   */
  enqueueMany(entries: readonly { id: string; kind: 'note' | 'folder' }[], at?: number): Promise<void>;
  /**
   * Remove a queue entry.
   *
   * Pass the `token` the entry carried when it was read and the delete becomes
   * conditional: an entry re-queued in the meantime survives. That is the
   * difference between "the change I just pushed is done" and "this note has
   * nothing left to push", and the two stop being the same thing as soon as a
   * push takes a few hundred milliseconds to come back.
   */
  dequeue(id: string, token?: string): Promise<void>;
  queued(): Promise<QueuedChange[]>;
  /** True when this note or folder has local changes waiting to be pushed. */
  isQueued(id: string): Promise<boolean>;

  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /**
   * Drop everything that describes this device's relationship with one backend
   * account: the delta cursor, the per-note revision anchors, and the outbound
   * queue.
   *
   * Signing out used to leave all of it behind, so signing in as a second user
   * on the same device pushed the first user's queued notes — encrypted with
   * the first user's key — into the second user's account, and resumed pulling
   * from a cursor that belongs to a different change stream, hiding everything
   * older than it.
   *
   * The notes themselves are deliberately untouched: local-only use is a
   * supported mode, and deleting a user's text because they signed out of a
   * sync account would be exactly the silent data loss §25 forbids.
   */
  clearSyncState(): Promise<void>;
  close(): void;
}

export interface RepositoryOptions {
  codec?: Codec;
  dbName?: string;
  /** Invoked when another tab upgrades the schema and closes this connection. */
  onVersionChange?: () => void;
}

/**
 * The first-run marker.
 *
 * Deliberately **not** namespaced `sync:` — `clearSyncState()` deletes every
 * key with that prefix on sign-out, which would re-arm first-run content and
 * hand the next sign-in a fresh pair of seed notes to duplicate.
 */
const FIRST_RUN_KEY = 'app:seeded';

/**
 * The account binding. Outside the `sync:` namespace for the same reason as
 * `app:seeded`: `clearSyncState()` deletes every `sync:*` key on sign-out, and
 * this is the one fact that must outlive a sign-out to be any use.
 *
 * `app:vaultAccount` (`core/sync/backfill.ts`) is the third of these and the
 * one with a hazard attached. It claims that this device's key opens the
 * account's notes, so it must never outlive the key it is talking about. It
 * does not today, because `vaultStorage` writes the key record into *this*
 * database and store, and `clearAll()` deletes the database whole. Splitting
 * the vault's storage from the notes' would break that, and would have to
 * clear the marker by hand.
 */
const OWNER_KEY = 'app:owner';

export async function openRepository(
  options: RepositoryOptions = {},
): Promise<NoteRepository> {
  const { codec = plaintextCodec, dbName = DB_NAME, onVersionChange } = options;

  const db = await openDb({
    name: dbName,
    version: DB_VERSION,
    upgrade,
    ...(onVersionChange ? { onVersionChange } : {}),
  });

  const repo: NoteRepository = {
    async loadAllMeta() {
      // Read by the updatedAt index so records arrive already ordered, which
      // saves sorting the common case at startup.
      const rows = (await req(
        db
          .transaction(STORE_NOTE_META)
          .objectStore(STORE_NOTE_META)
          .index(INDEX_UPDATED_AT)
          .getAll(),
      )) as StoredNoteMeta[];

      // Newest first, skipping tombstones.
      const live: StoredNoteMeta[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (!row.deleted) live.push(row);
      }

      // Decode in bounded batches. Awaiting each record individually costs one
      // microtask hop per note, which is measurable at 10,000 (Spike 3).
      const out: PersistedMeta[] = [];
      const BATCH = 256;
      for (let i = 0; i < live.length; i += BATCH) {
        const decoded = await Promise.all(
          live.slice(i, i + BATCH).map(async (row): Promise<PersistedMeta> => {
            try {
              const payload = await codec.decodeNoteMeta(row.id, row.meta);
              return {
                id: row.id,
                title: payload.title,
                folderId: payload.folderId,
                pinnedAt: payload.pinnedAt,
                updatedAt: row.updatedAt,
                // The one place a missing created date is resolved, so nothing
                // above this line needs a `??`. `updatedAt` is the only
                // defensible fallback and it is the *note's* own value rather
                // than a clock, so every device resolves the same number for
                // the same note — and the value freezes into the sealed record
                // on that note's next write. No migration pass, no schema bump.
                createdAt: payload.createdAt ?? row.updatedAt,
                revision: row.revision,
                ...(payload.excerpt ? { excerpt: payload.excerpt } : {}),
              };
            } catch {
              // A record we cannot decode is surfaced, not dropped: losing a
              // note silently is worse than showing it as unreadable (§25).
              return {
                id: row.id,
                title: 'Unreadable note',
                folderId: null,
                pinnedAt: null,
                updatedAt: row.updatedAt,
                createdAt: row.updatedAt,
                revision: row.revision,
              };
            }
          }),
        );
        out.push(...decoded);
      }
      return out;
    },

    async loadBody(id) {
      const row = (await req(
        db.transaction(STORE_NOTE_BODY).objectStore(STORE_NOTE_BODY).get(id),
      )) as StoredNoteBody | undefined;
      if (!row) return null;
      return codec.decodeBody(id, row.body);
    },

    async loadFolders() {
      const rows = (await req(
        db.transaction(STORE_FOLDERS).objectStore(STORE_FOLDERS).getAll(),
      )) as StoredFolder[];

      const out: Folder[] = [];
      for (const row of rows) {
        if (row.deleted) continue;
        try {
          const payload = await codec.decodeFolder(row.id, row.data);
          out.push({
            id: row.id,
            name: payload.name,
            parentId: payload.parentId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt ?? row.createdAt,
          });
        } catch {
          out.push({
            id: row.id,
            name: 'Unreadable folder',
            parentId: null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt ?? row.createdAt,
          });
        }
      }
      return out;
    },

    async hasAnyNote() {
      const count = (await req(
        db.transaction(STORE_NOTE_META).objectStore(STORE_NOTE_META).count(),
      )) as number;
      return count > 0;
    },

    async claimFirstRun() {
      // The await below resolves from an IndexedDB callback in the same task,
      // so the transaction is still active for the put — the same reasoning as
      // `deleteNote`. Awaiting anything else here (a codec call, a fetch) would
      // let it auto-commit underneath us and reopen the two-tab race.
      const tx = db.transaction(STORE_KV, 'readwrite');
      const store = tx.objectStore(STORE_KV);
      const existing = await req(store.get(FIRST_RUN_KEY));
      const unclaimed = existing === undefined;
      if (unclaimed) store.put(true, FIRST_RUN_KEY);
      await txDone(tx);
      return unclaimed;
    },

    async markFirstRunDone() {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(true, FIRST_RUN_KEY);
      await txDone(tx);
    },

    async firstRunDone() {
      const value = await req(
        db.transaction(STORE_KV).objectStore(STORE_KV).get(FIRST_RUN_KEY),
      );
      return value !== undefined;
    },

    async owner() {
      return (await req(db.transaction(STORE_KV).objectStore(STORE_KV).get(OWNER_KEY))) as
        | string
        | undefined;
    },

    async setOwner(uid) {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(uid, OWNER_KEY);
      await txDone(tx);
    },

    async sweepableIds() {
      // One read per store, and only the encoded blob is inspected — no codec,
      // no key, no decode. `getAll` rather than `getAllKeys` because the
      // plaintext test needs the blob; the rows carry ciphertext we never look
      // inside, so this is bytes moved, not notes opened.
      const tx = db.transaction([STORE_NOTE_META, STORE_FOLDERS]);
      const [noteRows, folderRows] = (await Promise.all([
        req(tx.objectStore(STORE_NOTE_META).getAll()),
        req(tx.objectStore(STORE_FOLDERS).getAll()),
      ])) as [StoredNoteMeta[], StoredFolder[]];

      return {
        notes: noteRows.filter((row) => isSweepable({ encoded: row.meta })).map((row) => row.id),
        folders: folderRows
          .filter((row) => isSweepable({ encoded: row.data }))
          .map((row) => row.id),
      };
    },

    async putNote(note) {
      await repo.putNotes([note]);
    },

    async putNotes(notes) {
      if (notes.length === 0) return;

      // Encode before opening the transaction. An IndexedDB transaction
      // auto-commits once its request queue drains, so awaiting anything
      // slow *inside* one is how you get mysterious TransactionInactiveError.
      const encoded = await Promise.all(
        notes.map(async (note) => ({
          meta: {
            id: note.id,
            meta: await codec.encodeNoteMeta(note.id, {
              title: note.title,
              folderId: note.folderId,
              pinnedAt: note.pinnedAt,
              // Derived here rather than by the caller: this is the only write
              // path that holds the body, so deriving it anywhere else would
              // mean a second definition that could disagree with this one.
              excerpt: excerptOf(note.content),
              createdAt: note.createdAt,
            }),
            updatedAt: note.updatedAt,
            revision: note.revision,
            deleted: false,
          } satisfies StoredNoteMeta,
          body: {
            id: note.id,
            body: await codec.encodeBody(note.id, note.content),
          } satisfies StoredNoteBody,
        })),
      );

      const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY], 'readwrite');
      const metaStore = tx.objectStore(STORE_NOTE_META);
      const bodyStore = tx.objectStore(STORE_NOTE_BODY);
      for (const row of encoded) {
        metaStore.put(row.meta);
        bodyStore.put(row.body);
      }
      await txDone(tx);
    },

    async putNoteMeta(meta) {
      const row: StoredNoteMeta = {
        id: meta.id,
        meta: await codec.encodeNoteMeta(meta.id, {
          title: meta.title,
          folderId: meta.folderId,
          pinnedAt: meta.pinnedAt,
          // Carried through, never re-derived: this path has no body to derive
          // from. It is the pin-and-move write (`Workspace.#writeMeta`), and
          // dropping the field here would silently blank the excerpt of every
          // note the user ever pins or files.
          ...(meta.excerpt ? { excerpt: meta.excerpt } : {}),
          // The same trap, one field along: dropping this would reset the
          // created date of every note the user ever pins or files, and the
          // reset would sync.
          createdAt: meta.createdAt,
        }),
        updatedAt: meta.updatedAt,
        revision: meta.revision,
        deleted: false,
      };
      const tx = db.transaction(STORE_NOTE_META, 'readwrite');
      tx.objectStore(STORE_NOTE_META).put(row);
      await txDone(tx);
    },

    async deleteNote(id, at = Date.now()) {
      // Tombstone the metadata so Phase 4 can propagate the deletion, but drop
      // the body immediately — there is no reason to keep the text of a note
      // the user deleted.
      //
      // The await below is safe where the one in `putNotes` would not be: it
      // resolves from an IndexedDB callback in the same task, so the
      // transaction stays active. Awaiting anything else here (a codec call,
      // a fetch) would let the transaction auto-commit underneath us.
      const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY], 'readwrite');
      const metaStore = tx.objectStore(STORE_NOTE_META);

      const existing = (await req(metaStore.get(id))) as StoredNoteMeta | undefined;
      if (existing) {
        metaStore.put({
          ...existing,
          deleted: true,
          updatedAt: at,
          revision: existing.revision + 1,
        });
      }
      tx.objectStore(STORE_NOTE_BODY).delete(id);
      await txDone(tx);
    },

    async putFolder(folder) {
      const row: StoredFolder = {
        id: folder.id,
        data: await codec.encodeFolder(folder.id, { name: folder.name, parentId: folder.parentId }),
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        deleted: false,
      };
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).put(row);
      await txDone(tx);
    },

    async deleteFolder(id, at = Date.now()) {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      const store = tx.objectStore(STORE_FOLDERS);
      const existing = (await req(store.get(id))) as StoredFolder | undefined;
      // A tombstone is a mutation like any other, so it advances `updatedAt`.
      // Without that the receiving device cannot tell it is newer than the
      // copy it already holds.
      if (existing) store.put({ ...existing, deleted: true, updatedAt: at });
      await txDone(tx);
    },

    async loadRawNote(id) {
      const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY]);
      const meta = (await req(tx.objectStore(STORE_NOTE_META).get(id))) as
        | StoredNoteMeta
        | undefined;
      if (!meta) return null;
      const body = (await req(tx.objectStore(STORE_NOTE_BODY).get(id))) as
        | StoredNoteBody
        | undefined;

      return {
        id: meta.id,
        meta: meta.meta,
        body: body?.body,
        updatedAt: meta.updatedAt,
        revision: meta.revision,
        deleted: meta.deleted,
      };
    },

    loadRawNotes(ids) {
      if (ids.length === 0) return Promise.resolve([]);
      // No `async` and no await before this line: the transaction must exist
      // before the caller's `putNotes` opens its own. See the interface.
      const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY]);
      const metaStore = tx.objectStore(STORE_NOTE_META);
      const bodyStore = tx.objectStore(STORE_NOTE_BODY);
      return Promise.all(
        ids.map(async (id): Promise<RawNote | null> => {
          const [meta, body] = (await Promise.all([req(metaStore.get(id)), req(bodyStore.get(id))])) as [
            StoredNoteMeta | undefined,
            StoredNoteBody | undefined,
          ];
          if (!meta) return null;
          return {
            id: meta.id,
            meta: meta.meta,
            body: body?.body,
            updatedAt: meta.updatedAt,
            revision: meta.revision,
            deleted: meta.deleted,
          };
        }),
      ).then((rows) => rows.filter((row): row is RawNote => row !== null));
    },

    async loadTombstones(since) {
      const rows = (await req(
        db
          .transaction(STORE_NOTE_META)
          .objectStore(STORE_NOTE_META)
          .index(INDEX_UPDATED_AT)
          .getAll(IDBKeyRange.lowerBound(since)),
      )) as StoredNoteMeta[];

      const out: (PersistedMeta & { deleted: true })[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (!row.deleted) continue;
        let title = 'Unreadable note';
        let folderId: string | null = null;
        let pinnedAt: number | null = null;
        let createdAt: number | undefined;
        try {
          ({ title, folderId, pinnedAt, createdAt } = await codec.decodeNoteMeta(row.id, row.meta));
        } catch {
          // Surfaced as unreadable rather than dropped (§25).
        }
        out.push({
          id: row.id,
          title,
          folderId,
          pinnedAt,
          updatedAt: row.updatedAt,
          // Resolved the same way `loadAllMeta` resolves it: Recently deleted
          // sorts these itself, but a restore puts the meta straight back.
          createdAt: createdAt ?? row.updatedAt,
          revision: row.revision,
          deleted: true,
        });
      }
      return out;
    },

    async loadRawFolder(id) {
      const row = (await req(
        db.transaction(STORE_FOLDERS).objectStore(STORE_FOLDERS).get(id),
      )) as StoredFolder | undefined;
      if (!row) return null;
      return {
        id: row.id,
        data: row.data,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? row.createdAt,
        deleted: row.deleted,
      };
    },

    async putRawNote(note) {
      const tx = db.transaction([STORE_NOTE_META, STORE_NOTE_BODY], 'readwrite');
      tx.objectStore(STORE_NOTE_META).put({
        id: note.id,
        meta: note.meta,
        updatedAt: note.updatedAt,
        revision: note.revision,
        deleted: note.deleted,
      } satisfies StoredNoteMeta);

      if (note.body !== undefined) {
        tx.objectStore(STORE_NOTE_BODY).put({ id: note.id, body: note.body } satisfies StoredNoteBody);
      } else if (note.deleted) {
        // A tombstone arriving from another device: drop the local body too.
        tx.objectStore(STORE_NOTE_BODY).delete(note.id);
      }
      await txDone(tx);
    },

    async putRawFolder(folder) {
      const tx = db.transaction(STORE_FOLDERS, 'readwrite');
      tx.objectStore(STORE_FOLDERS).put({
        id: folder.id,
        data: folder.data,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        deleted: folder.deleted,
      } satisfies StoredFolder);
      await txDone(tx);
    },

    async enqueue(id, kind, at = Date.now()) {
      const tx = db.transaction(STORE_SYNC_QUEUE, 'readwrite');
      // Keyed by id, so repeated edits to one note collapse to one entry. The
      // token changes every time, which is how a push identifies the entry it
      // actually sent.
      tx.objectStore(STORE_SYNC_QUEUE).put({
        id,
        kind,
        queuedAt: at,
        token: crypto.randomUUID(),
      } satisfies QueuedChange);
      await txDone(tx);
    },

    async enqueueMany(entries, at = Date.now()) {
      if (entries.length === 0) return;
      const tx = db.transaction(STORE_SYNC_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_SYNC_QUEUE);
      for (const entry of entries) {
        store.put({
          id: entry.id,
          kind: entry.kind,
          queuedAt: at,
          token: crypto.randomUUID(),
        } satisfies QueuedChange);
      }
      await txDone(tx);
    },

    async dequeue(id, token) {
      const tx = db.transaction(STORE_SYNC_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_SYNC_QUEUE);

      if (token !== undefined) {
        // The await resolves from an IndexedDB callback in the same task, so
        // the transaction stays active — the same reasoning as `deleteNote`.
        const existing = (await req(store.get(id))) as QueuedChange | undefined;
        // A different token means the user edited this note while the push was
        // in flight. Deleting it here would strand that edit: written locally,
        // never queued again, and never reconciled until something else
        // happened to touch the note.
        if (existing && existing.token !== token) {
          await txDone(tx);
          return;
        }
      }

      store.delete(id);
      await txDone(tx);
    },

    async queued() {
      const rows = (await req(
        db.transaction(STORE_SYNC_QUEUE).objectStore(STORE_SYNC_QUEUE).getAll(),
      )) as QueuedChange[];
      // Oldest first: a change that has been waiting longest goes first.
      return rows.sort((a, b) => a.queuedAt - b.queuedAt);
    },

    async isQueued(id) {
      const row = (await req(
        db.transaction(STORE_SYNC_QUEUE).objectStore(STORE_SYNC_QUEUE).get(id),
      )) as QueuedChange | undefined;
      return row !== undefined;
    },


    async get<T>(key: string) {
      return (await req(db.transaction(STORE_KV).objectStore(STORE_KV).get(key))) as
        | T
        | undefined;
    },

    async set(key, value) {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(value, key);
      await txDone(tx);
    },

    async clearSyncState() {
      const tx = db.transaction([STORE_KV, STORE_SYNC_QUEUE], 'readwrite');
      const kv = tx.objectStore(STORE_KV);
      const keys = (await req(kv.getAllKeys())) as IDBValidKey[];
      for (const key of keys) {
        // Everything sync owns is namespaced `sync:`. Anything else in this
        // store belongs to another subsystem and is none of our business.
        if (typeof key === 'string' && key.startsWith('sync:')) kv.delete(key);
      }
      tx.objectStore(STORE_SYNC_QUEUE).clear();
      await txDone(tx);
    },

    close() {
      db.close();
    },
  };

  return repo;
}
