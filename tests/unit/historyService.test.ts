import { describe, expect, it } from 'vitest';
import { generateDek } from '../../src/core/crypto/envelope.ts';
import { encryptedCodec } from '../../src/core/repo/encryptedCodec.ts';
import { createHistoryService, PRUNE_INTERVAL_MS, UPLOAD_MARGIN_MS } from '../../src/core/history/service.ts';
import { noteIdOf, sealIdOf, type VersionRecord } from '../../src/core/history/record.ts';
import { DAY_MS, HOUR_MS, TIER_DAY_MS, TIER_MONTH_MS, TIER_WEEK_MS } from '../../src/core/history/retention.ts';
import type { HistoryStore } from '../../src/core/history/store.ts';
import type { RawNote } from '../../src/core/repo/noteRepository.ts';

const key = await generateDek();
const codec = encryptedCodec(() => key);

function memoryStore(): HistoryStore & { rows: Map<string, VersionRecord>; meta: Map<string, unknown> } {
  const rows = new Map<string, VersionRecord>();
  const meta = new Map<string, unknown>();
  const forNote = (noteId: string) =>
    [...rows.values()].filter((r) => r.noteId === noteId).sort((a, b) => b.capturedAt - a.capturedAt);
  return {
    rows,
    meta,
    add: async (record) => {
      if (rows.has(record.id)) return false;
      rows.set(record.id, record);
      return true;
    },
    put: async (record) => void rows.set(record.id, record),
    listForNote: async (noteId) => forNote(noteId),
    latestForNote: async (noteId) => forNote(noteId)[0],
    get: async (id) => rows.get(id),
    countCaptured: async (noteId, from, to) =>
      forNote(noteId).filter((r) => r.capturedAt >= from && r.capturedAt < to).length,
    noteIds: async () => new Set([...rows.keys()].map(noteIdOf)),
    summaries: async () =>
      [...rows.values()].map(({ id, noteId, capturedAt, expireAt, bytes, reason }) => ({
        id,
        noteId,
        capturedAt,
        expireAt,
        bytes,
        reason,
      })),
    remove: async (ids) => ids.forEach((id) => rows.delete(id)),
    withState: async (state, maxCount) =>
      [...rows.values()]
        .filter((r) => r.state === state)
        .sort((a, b) => a.capturedAt - b.capturedAt)
        .slice(0, maxCount ?? Infinity),
    setState: async (ids, state) => {
      for (const id of ids) {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, state });
      }
    },
    moveState: async (from, to) => {
      for (const [id, row] of rows) if (row.state === from) rows.set(id, { ...row, state: to });
    },
    getMeta: async <T,>(k: string) => meta.get(k) as T | undefined,
    setMeta: async (k, value) => void meta.set(k, value),
    close: () => {},
  };
}

async function raw(id: string, content: string, updatedAt = 1): Promise<RawNote> {
  return {
    id,
    meta: (await codec.encodeNoteMeta(id, { title: content.slice(0, 10), folderId: 'f1', pinnedAt: null })) as Uint8Array,
    body: (await codec.encodeBody(id, content)) as Uint8Array,
    updatedAt,
    revision: 1,
    deleted: false,
  };
}

function setup(start = Date.UTC(2026, 8, 17, 9)) {
  let clock = start;
  const store = memoryStore();
  const notes = new Map<string, RawNote>();
  const service = createHistoryService({
    store,
    repo: { loadRawNotes: async (ids) => ids.flatMap((id) => notes.get(id) ?? []) },
    codec,
    now: () => clock,
  });
  return { store, notes, service, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe('history service', () => {
  it('stores the ciphertext byte for byte, keyed by the body nonce', async () => {
    const { store, service } = setup();
    const row = await raw('n1', 'hello world', 42);
    await service.capture([row], 'edit');

    const [version] = await store.listForNote('n1');
    expect(version!.body).toBe(row.body);
    expect(version!.meta).toBe(row.meta);
    expect(version!.id).toBe(`n1:${sealIdOf(row.body as Uint8Array)}`);
    expect(version!.at).toBe(42);
    expect(await service.decodeBody(version!)).toBe('hello world');
    expect((await service.decodeMeta(version!)).folderId).toBe('f1');
  });

  it('skips tombstones, empty notes and pre-vault plaintext rows', async () => {
    const { store, service } = setup();
    await service.capture(
      [
        { ...(await raw('gone', 'text')), deleted: true },
        await raw('empty', ''),
        { id: 'plain', meta: '{}', body: 'plaintext', updatedAt: 1, revision: 1, deleted: false },
      ],
      'edit',
    );
    expect(store.rows.size).toBe(0);
  });

  it('does not keep the same text twice, even under a fresh nonce', async () => {
    const { store, service, advance } = setup();
    await service.capture([await raw('n1', 'draft')], 'edit');
    advance(HOUR_MS);
    await service.capture([await raw('n1', 'draft')], 'edit');
    advance(HOUR_MS);
    await service.capture([await raw('n1', 'draft two')], 'edit');
    expect(store.rows.size).toBe(2);
  });

  it('assigns month, week and day tiers from what this note already has', async () => {
    const { store, service, advance } = setup(Date.UTC(2026, 8, 17, 9, 0));
    await service.capture([await raw('n1', 'one')], 'edit');
    advance(10 * 60_000);
    await service.capture([await raw('n1', 'two')], 'edit');
    advance(HOUR_MS);
    await service.capture([await raw('n1', 'three')], 'edit');
    advance(DAY_MS);
    await service.capture([await raw('n1', 'four')], 'edit');

    const tiers = (await store.listForNote('n1')).reverse().map((v) => v.expireAt - v.capturedAt);
    expect(tiers).toEqual([TIER_MONTH_MS, TIER_DAY_MS, TIER_WEEK_MS, TIER_MONTH_MS]);
  });

  it('keeps a deleted note’s final text for a month, even if an ordinary version holds the same bytes', async () => {
    const { store, service, advance } = setup();
    const row = await raw('n1', 'last words');
    await service.capture([await raw('n1', 'earlier')], 'edit');
    advance(10 * 60_000);
    await service.capture([row], 'edit');
    expect((await store.latestForNote('n1'))!.expireAt - (await store.latestForNote('n1'))!.capturedAt).toBe(TIER_DAY_MS);

    await service.capture([row], 'delete');
    const latest = (await store.latestForNote('n1'))!;
    expect(latest.reason).toBe('delete');
    expect(latest.expireAt).toBeGreaterThanOrEqual(latest.capturedAt + TIER_MONTH_MS);
    expect(store.rows.size).toBe(2);
  });

  it('captures by id through the repository', async () => {
    const { store, notes, service } = setup();
    notes.set('n1', await raw('n1', 'from the database'));
    await service.captureIds(['n1', 'missing'], 'restore');
    expect([...(await service.noteIds())]).toEqual(['n1']);
    expect((await store.latestForNote('n1'))!.reason).toBe('restore');
  });

  it('keeps a version whose text it cannot compare', async () => {
    const other = encryptedCodec(() => key);
    const store = memoryStore();
    let locked = false;
    const service = createHistoryService({
      store,
      repo: { loadRawNotes: async () => [] },
      codec: {
        decodeBody: (id, v) => (locked ? Promise.reject(new Error('locked')) : other.decodeBody(id, v)),
        decodeNoteMeta: (id, v) => other.decodeNoteMeta(id, v),
      },
    });
    await service.capture([await raw('n1', 'same')], 'edit');
    locked = true;
    await service.capture([await raw('n1', 'same')], 'edit');
    expect(store.rows.size).toBe(2);
  });

  it('prunes expired versions at most once per interval', async () => {
    const { store, service, advance } = setup();
    await service.capture([await raw('n1', 'one')], 'edit');
    advance(10 * 60_000);
    await service.capture([await raw('n1', 'two')], 'edit');
    advance(2 * DAY_MS);

    await service.maybePrune();
    expect(store.rows.size).toBe(1);

    advance(TIER_MONTH_MS);
    await service.maybePrune();
    expect(store.rows.size).toBe(0);

    await service.capture([await raw('n1', 'three')], 'edit');
    advance(TIER_MONTH_MS + 1);
    await service.maybePrune();
    expect(store.rows.size).toBe(0);
  });

  it('does not prune again within the interval', async () => {
    const { store, service, advance } = setup();
    await service.maybePrune();
    await service.capture([await raw('n1', 'one')], 'edit');
    advance(PRUNE_INTERVAL_MS / 2 + TIER_MONTH_MS);
    store.meta.set('prunedAt', Date.UTC(2026, 8, 17, 9) + TIER_MONTH_MS);
    await service.maybePrune();
    expect(store.rows.size).toBe(1);
  });

  describe('upload queue', () => {
    it('queues what it captures, and mirrors as already on the backend', async () => {
      const { store, service } = setup();
      await service.capture([await raw('n1', 'kept here')], 'edit');
      await service.mirror(await raw('n2', 'deleted elsewhere'));
      expect((await store.latestForNote('n1'))!.state).toBe('queued');
      const mirrored = (await store.latestForNote('n2'))!;
      expect(mirrored.state).toBe('remote');
      expect(mirrored.reason).toBe('delete');
      expect(await service.pending(10, Infinity)).toHaveLength(1);
    });

    it('bounds a page by bytes, but always returns at least one', async () => {
      const { service, advance } = setup();
      for (const text of ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)]) {
        await service.capture([await raw(text[0]!, text)], 'edit');
        advance(1);
      }
      expect(await service.pending(10, 1)).toHaveLength(1);
      expect(await service.pending(10, 1_000)).toHaveLength(2);
      expect(await service.pending(2, Infinity)).toHaveLength(2);
    });

    it('retires a version that would expire before it could usefully upload', async () => {
      const { store, service, advance } = setup();
      await service.capture([await raw('n1', 'one')], 'edit');
      advance(10 * 60_000);
      await service.capture([await raw('n1', 'two')], 'edit'); // day tier
      advance(TIER_DAY_MS - UPLOAD_MARGIN_MS);

      const page = await service.pending(10, Infinity);
      expect(page.map((v) => v.reason)).toHaveLength(1);
      const states = (await store.listForNote('n1')).map((v) => v.state).sort();
      expect(states).toEqual(['local', 'queued']);
    });

    it('marks, retires and filters by note', async () => {
      const { store, service, advance } = setup();
      await service.capture([await raw('n1', 'one')], 'edit');
      advance(1);
      await service.capture([await raw('n2', 'two')], 'edit');
      expect((await service.pendingFor('n2')).map((v) => v.noteId)).toEqual(['n2']);

      const [first] = await service.pending(1, Infinity);
      await service.markPushed([first!.id]);
      expect((await store.get(first!.id))!.state).toBe('pushed');

      await service.retireAll();
      expect(await service.pending(10, Infinity)).toEqual([]);
      expect((await store.latestForNote('n2'))!.state).toBe('local');
    });
  });

  describe('versions from the account', () => {
    it('stores new ones as remote, skips expired ones, and settles a matching queued upload', async () => {
      const { store, service, now } = setup();
      const row = await raw('n1', 'shared text');
      await service.capture([row], 'edit');
      const sealId = sealIdOf(row.body as Uint8Array)!;

      const added = await service.addRemote([
        { noteId: 'n1', id: sealId, meta: row.meta as never, body: row.body as never, at: 1, reason: 'edit', expireAt: now() + DAY_MS },
        { noteId: 'n1', id: 'f'.repeat(24), meta: row.meta as never, body: row.body as never, at: 2, reason: 'delete', expireAt: now() + DAY_MS, createdAt: 5 },
        { noteId: 'n1', id: 'e'.repeat(24), meta: row.meta as never, body: row.body as never, at: 3, reason: 'edit', expireAt: now() - 1 },
      ]);

      expect(added).toBe(1);
      expect((await store.get(`n1:${sealId}`))!.state).toBe('pushed');
      expect((await store.get(`n1:${'f'.repeat(24)}`))).toMatchObject({ state: 'remote', capturedAt: 5, reason: 'delete' });
      expect(store.rows.size).toBe(2);
    });
  });
});
