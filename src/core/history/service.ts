/**
 * Taking, reading and pruning note versions. Loaded lazily: a session that
 * never pauses long enough to start a second editing session, deletes nothing
 * and never opens the history panel never downloads or opens any of this.
 *
 * ## A snapshot never fails a save
 *
 * Everything here is best-effort by contract. A full quota, a blocked database
 * or a locked vault costs a version, never a note: callers swallow the error
 * and the note write they were shadowing has already landed or goes ahead.
 *
 * ## Syncing
 *
 * Every version captured here starts `queued`, account or no account, for the
 * same reason notes do (`Workspace.#queue`): work done before a sign-in must
 * not be invisible to sync forever. Whether the queue may drain is the engine's
 * question, answered by the same account binding that gates notes. Versions
 * fetched from the backend arrive as `remote` and are never sent back; a copy
 * kept because a remote tombstone erased a note here is `remote` too, because
 * its text is what the backend already held.
 *
 * ## Duplicates
 *
 * Three layers, cheapest first. The same stored sealing is the same id
 * (`record.ts`), so `add` refuses it. A different sealing of the same text —
 * the note was saved again without changing, or moved to another folder — has
 * a new nonce but the same body length as the newest version, and only then are
 * the two decrypted and compared. A decrypt that fails (vault locked) keeps the
 * version: a spare copy is cheap, a missing one is not.
 */
import type { Codec } from '../repo/codec.ts';
import type { NoteRepository, RawNote } from '../repo/noteRepository.ts';
import type { NoteMetaPayload } from '../repo/codec.ts';
import {
  EMPTY_SEAL_BYTES,
  sealIdOf,
  versionId,
  type VersionReason,
  type VersionRecord,
  type VersionState,
} from './record.ts';
import type { HistoryOutbox } from './outbox.ts';
import type { RemoteVersion } from '../sync/adapter.ts';
import { DAY_MS, HOUR_MS, planPrune, tierFor, utcDayStart, utcHourStart } from './retention.ts';
import type { HistoryStore } from './store.ts';

/** How often pruning may run. It is idle work, and expiry is measured in days. */
export const PRUNE_INTERVAL_MS = 6 * HOUR_MS;

/**
 * A version this close to expiring is not worth a billed write: the backend
 * would remove it again almost at once, and its rules refuse an `expireAt` in
 * the past, which clock skew could otherwise turn a near miss into.
 */
export const UPLOAD_MARGIN_MS = 5 * 60_000;

export interface HistoryServiceOptions {
  store: HistoryStore;
  repo: Pick<NoteRepository, 'loadRawNotes'>;
  codec: Pick<Codec, 'decodeBody' | 'decodeNoteMeta'>;
  now?: () => number;
  capBytes?: number;
  /** Serialise pruning across tabs. Runs `task` directly when absent. */
  withLock?: (task: () => Promise<void>) => Promise<void>;
}

export interface HistoryService extends HistoryOutbox {
  /** Keep `rows` as versions. Rows without a sealed body are skipped. */
  capture(rows: readonly RawNote[], reason: VersionReason, state?: VersionState): Promise<void>;
  /** Store versions fetched from the backend. Returns how many were new here. */
  addRemote(versions: readonly RemoteVersion[]): Promise<number>;
  /** Read the notes' stored rows now and keep them. */
  captureIds(ids: readonly string[], reason: VersionReason): Promise<void>;
  list(noteId: string): Promise<VersionRecord[]>;
  latest(noteId: string): Promise<VersionRecord | undefined>;
  get(id: string): Promise<VersionRecord | undefined>;
  noteIds(): Promise<Set<string>>;
  decodeBody(record: VersionRecord): Promise<string>;
  decodeMeta(record: VersionRecord): Promise<NoteMetaPayload>;
  /** Prune if the last pass was long enough ago. */
  maybePrune(): Promise<void>;
  close(): void;
}

export function createHistoryService(options: HistoryServiceOptions): HistoryService {
  const { store, repo, codec, now = Date.now, capBytes, withLock = (task) => task() } = options;

  async function sameText(noteId: string, a: Uint8Array, b: Uint8Array): Promise<boolean> {
    if (a.length !== b.length) return false;
    try {
      const [left, right] = await Promise.all([codec.decodeBody(noteId, a), codec.decodeBody(noteId, b)]);
      return left === right;
    } catch {
      return false;
    }
  }

  async function captureOne(row: RawNote, reason: VersionReason, at: number, state: VersionState): Promise<void> {
    // A tombstone has no text left to keep; a string is a pre-vault plaintext
    // row, which must never be copied anywhere (§33.5).
    if (row.deleted || !(row.body instanceof Uint8Array) || !(row.meta instanceof Uint8Array)) return;
    if (row.body.length <= EMPTY_SEAL_BYTES) return;
    const sealId = sealIdOf(row.body);
    if (!sealId) return;

    const id = versionId(row.id, sealId);
    const latest = await store.latestForNote(row.id);
    if (latest && reason !== 'delete' && (latest.sealId === sealId || (await sameText(row.id, latest.body, row.body)))) {
      return;
    }

    const day = utcDayStart(at);
    const hour = utcHourStart(at);
    const [inDay, inHour] = await Promise.all([
      store.countCaptured(row.id, day, day + DAY_MS),
      store.countCaptured(row.id, hour, hour + HOUR_MS),
    ]);
    const expireAt = at + tierFor(reason, inDay > 0, inHour > 0);

    const record: VersionRecord = {
      id,
      noteId: row.id,
      sealId,
      at: row.updatedAt,
      capturedAt: at,
      expireAt,
      reason,
      meta: row.meta,
      body: row.body,
      bytes: row.meta.length + row.body.length,
      state,
    };

    if (reason === 'delete') {
      // The final text of a deleted note must get the full 30 days even when
      // an ordinary version already holds these exact bytes.
      const existing = await store.get(id);
      if (existing && existing.reason === 'delete' && existing.expireAt >= expireAt) return;
      await store.put(existing ? { ...existing, reason, expireAt: Math.max(existing.expireAt, expireAt) } : record);
      return;
    }
    await store.add(record);
  }

  const service: HistoryService = {
    async capture(rows, reason, state = 'queued') {
      const at = now();
      for (const row of rows) await captureOne(row, reason, at, state);
    },

    async addRemote(versions) {
      const at = now();
      let added = 0;
      for (const remote of versions) {
        if (remote.expireAt <= at) continue;
        const id = versionId(remote.noteId, remote.id);
        const record: VersionRecord = {
          id,
          noteId: remote.noteId,
          sealId: remote.id,
          at: remote.at,
          capturedAt: remote.createdAt ?? at,
          expireAt: remote.expireAt,
          reason: remote.reason,
          meta: remote.meta,
          body: remote.body,
          bytes: remote.meta.length + remote.body.length,
          state: 'remote',
        };
        if (await store.add(record)) {
          added++;
          continue;
        }
        // Already here. If it was still waiting to upload, the backend has it
        // now — another device sent the same sealing.
        const existing = await store.get(id);
        if (existing?.state === 'queued') await store.setState([id], 'pushed');
      }
      return added;
    },

    async pending(maxCount, maxBytes) {
      const at = now();
      const retire: string[] = [];
      const out: VersionRecord[] = [];
      let bytes = 0;
      for (const record of await store.withState('queued', maxCount)) {
        if (record.expireAt <= at + UPLOAD_MARGIN_MS) {
          retire.push(record.id);
          continue;
        }
        if (out.length > 0 && bytes + record.bytes > maxBytes) break;
        out.push(record);
        bytes += record.bytes;
      }
      await store.setState(retire, 'local');
      return out;
    },

    async pendingFor(noteId) {
      const at = now();
      return (await store.listForNote(noteId))
        .filter((r) => r.state === 'queued' && r.expireAt > at + UPLOAD_MARGIN_MS)
        .reverse();
    },

    markPushed: (ids) => store.setState(ids, 'pushed'),
    markLocal: (ids) => store.setState(ids, 'local'),
    retireAll: () => store.moveState('queued', 'local'),
    mirror: (row) => service.capture([row], 'delete', 'remote'),

    async captureIds(ids, reason) {
      if (ids.length === 0) return;
      await service.capture(await repo.loadRawNotes(ids), reason);
    },

    list: (noteId) => store.listForNote(noteId),
    latest: (noteId) => store.latestForNote(noteId),
    get: (id) => store.get(id),
    noteIds: () => store.noteIds(),
    decodeBody: (record) => codec.decodeBody(record.noteId, record.body),
    decodeMeta: (record) => codec.decodeNoteMeta(record.noteId, record.meta),

    async maybePrune() {
      const last = (await store.getMeta<number>('prunedAt')) ?? 0;
      if (now() - last < PRUNE_INTERVAL_MS) return;
      await withLock(async () => {
        const at = now();
        const doomed = planPrune(await store.summaries(), at, capBytes);
        await store.remove(doomed);
        await store.setMeta('prunedAt', at);
      });
    },

    close: () => store.close(),
  };
  return service;
}
