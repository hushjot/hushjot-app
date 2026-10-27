/**
 * IndexedDB schema.
 *
 * The layout is the one Spike 3 measured as fastest by a wide margin:
 * note metadata and note bodies live in **separate object stores**, so cold
 * start reads ~0.9 MB of metadata instead of deserializing ~31 MB of bodies it
 * is not going to display. 183 ms → 41 ms at 10,000 notes (bench/RESULTS.md).
 *
 * ## What is stored in the clear
 *
 * Only `id`, `updatedAt`, `revision` and `deleted` are plaintext columns. They
 * are the fields sync needs to order and reconcile records, and they match the
 * plaintext fields the spec's own Firestore model exposes (§14). `revision`
 * here is the *local* edit counter, not the backend's; the two are different
 * numbers, and what the backend holds is tracked in the `kv` store instead —
 * see `src/core/sync/state.ts`.
 *
 * Title and folder membership live *inside* the encoded meta blob, not as
 * indexed columns. That is deliberate: an index cannot be built over a value
 * the database cannot read, so anything we index is something we have promised
 * not to encrypt. Spike 3 showed sorting and filtering 10,000 notes in memory
 * costs ~3.4 ms, so there is nothing to buy by leaking those fields.
 *
 * ## Phase 2 caveat
 *
 * Blobs pass through `PLAINTEXT_CODEC` today. Encryption arrives in Phase 3 by
 * swapping the codec — no schema change, no migration. Until then this database
 * holds readable notes, which is why §13's local-security documentation is a
 * Phase 3 deliverable rather than a Phase 2 one.
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
export const DB_NAME = 'teksto';
export const DB_VERSION = 2;

export const STORE_NOTE_META = 'noteMeta';
export const STORE_NOTE_BODY = 'noteBody';
export const STORE_FOLDERS = 'folders';
export const STORE_KV = 'kv';
/** Ids waiting to be pushed to the backend. Durable, so a reload keeps them. */
export const STORE_SYNC_QUEUE = 'syncQueue';

export const INDEX_UPDATED_AT = 'byUpdatedAt';

/**
 * Whatever the codec produces. Declared in `codec.ts` — it is a property of the
 * codec, not of the database — and re-exported here because every store below
 * is described in terms of it.
 */
import type { Encoded } from './codec.ts';
export type { Encoded };

export interface StoredNoteMeta {
  id: string;
  /** Encoded `{ title, folderId, pinnedAt }`. */
  meta: Encoded;
  updatedAt: number;
  revision: number;
  /** Tombstone rather than removal, so deletions can propagate in Phase 4. */
  deleted: boolean;
}

export interface StoredNoteBody {
  id: string;
  /** Encoded note content. */
  body: Encoded;
}

/** One entry in the outbound queue. */
export interface QueuedChange {
  id: string;
  kind: 'note' | 'folder';
  queuedAt: number;
  /**
   * Identifies this particular entry, so a push that takes a second to come
   * back can tell "the change I sent" from "a change made since". A timestamp
   * is not enough: two edits can share a millisecond, and two tabs keep
   * separate clocks-of-record. Absent on rows written before this existed,
   * which simply makes their removal unconditional, as it was then.
   */
  token?: string;
}

export interface StoredFolder {
  id: string;
  /** Encoded `{ name, parentId }`. */
  data: Encoded;
  createdAt: number;
  /**
   * Last mutation, for sync ordering. Optional because rows written before
   * folders could be renamed do not have it; read it as `?? createdAt`, which
   * is exactly right for a folder that has only ever been created. Adding it
   * needs no migration — nothing indexes it, and object stores are schemaless.
   */
  updatedAt?: number;
  deleted: boolean;
}

export function upgrade(db: IDBDatabase, _tx: IDBTransaction, fromVersion: number): void {
  // v0 -> v1: initial schema.
  if (fromVersion < 1) {
    const meta = db.createObjectStore(STORE_NOTE_META, { keyPath: 'id' });
    // The only index we can honestly keep once bodies are encrypted: it drives
    // recency ordering and, later, delta sync cursors.
    meta.createIndex(INDEX_UPDATED_AT, 'updatedAt', { unique: false });

    db.createObjectStore(STORE_NOTE_BODY, { keyPath: 'id' });
    db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
    db.createObjectStore(STORE_KV);
  }

  // v1 -> v2: the outbound sync queue. Introduced with Phase 4; a database
  // created before it simply gains an empty store.
  if (fromVersion < 2) {
    if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
      db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: 'id' });
    }
  }

  // Future versions append their migrations here. Never edit an existing
  // block: a user's database may be at any prior version.
}
