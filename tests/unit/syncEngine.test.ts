import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSyncEngine } from '../../src/core/sync/engine.ts';
import {
  RevisionConflictError,
  PayloadTooLargeError,
  SessionExpiredError,
  SyncNotApprovedError,
  TransientSyncError,
  type SyncAdapter,
  type RemoteNote,
} from '../../src/core/sync/adapter.ts';
import { PushLimitError, QuotaExceededError, meterDelta } from '../../src/core/sync/usage.ts';
import type { NoteRepository, RawNote, RawFolder } from '../../src/core/repo/noteRepository.ts';
import type { QueuedChange } from '../../src/core/repo/schema.ts';
import { saveSyncState, type NoteSyncState } from '../../src/core/sync/state.ts';
import {
  singleTabCoordinator,
  type CoordinatorOptions,
  type TabChannel,
  type TabMessage,
} from '../../src/core/sync/tabs.ts';

/**
 * Sync-engine behaviour under the failure modes §25 lists. These are the paths
 * where data goes missing if they are wrong, so they are tested against fakes
 * rather than only end to end — a browser test cannot easily produce a
 * corrupted payload or an expired token on demand.
 */

const bytes = (n: number) => new Uint8Array([1, 1, n, n, n]) as Uint8Array<ArrayBuffer>;

function fakeRepo(): NoteRepository & {
  notes: Map<string, RawNote>;
  folders: Map<string, RawFolder>;
  queue: string[];
  kv: Map<string, unknown>;
  base(id: string): number | undefined;
} {
  const notes = new Map<string, RawNote>();
  const folders = new Map<string, RawFolder>();
  const queue: QueuedChange[] = [];
  const kv = new Map<string, unknown>();
  let tokens = 0;

  return {
    notes,
    folders,
    kv,
    base: (id) => (kv.get(`sync:note:${id}`) as NoteSyncState | undefined)?.base,
    get queue() {
      return queue.map((q) => q.id);
    },
    loadAllMeta: async () => [],
    loadBody: async () => null,
    loadFolders: async () => [],
    hasAnyNote: async () => notes.size > 0,
    claimFirstRun: async () => {
      if (kv.has('app:seeded')) return false;
      kv.set('app:seeded', true);
      return true;
    },
    markFirstRunDone: async () => {
      kv.set('app:seeded', true);
    },
    firstRunDone: async () => kv.has('app:seeded'),
    owner: async () => kv.get('app:owner') as string | undefined,
    setOwner: async (uid) => {
      kv.set('app:owner', uid);
    },
    sweepableIds: async () => ({
      notes: [...notes.keys()],
      folders: [...folders.keys()],
    }),
    enqueueMany: async (entries, at = 0) => {
      for (const entry of entries) {
        queue.push({ id: entry.id, kind: entry.kind, queuedAt: at, token: `t${++tokens}` });
      }
    },
    putNote: async () => {},
    putNotes: async () => {},
    putNoteMeta: async () => {},
    deleteNote: async () => {},
    putFolder: async () => {},
    deleteFolder: async () => {},
    loadRawNote: async (id) => notes.get(id) ?? null,
    loadRawNotes: async (ids) => ids.flatMap((id) => notes.get(id) ?? []),
    loadTombstones: async () => [],
    loadRawFolder: async (id) => folders.get(id) ?? null,
    putRawNote: async (note) => {
      notes.set(note.id, note as RawNote);
    },
    putRawFolder: async (folder) => {
      folders.set(folder.id, folder as RawFolder);
    },
    enqueue: async (id, kind, at = Date.now()) => {
      const existing = queue.findIndex((q) => q.id === id);
      if (existing >= 0) queue.splice(existing, 1);
      queue.push({ id, kind, queuedAt: at, token: `t${++tokens}` });
    },
    dequeue: async (id, token) => {
      const index = queue.findIndex((q) => q.id === id);
      if (index < 0) return;
      // The real store refuses to remove an entry that has been re-queued
      // since; a fake that always removed it would hide that bug.
      if (token !== undefined && queue[index]!.token !== token) return;
      queue.splice(index, 1);
    },
    queued: async () => [...queue],
    isQueued: async (id) => queue.some((q) => q.id === id),
    get: async (key) => kv.get(key) as never,
    set: async (key, value) => {
      kv.set(key, value);
    },
    clearSyncState: async () => {
      for (const key of [...kv.keys()]) if (key.startsWith('sync:')) kv.delete(key);
      queue.length = 0;
    },
    close: () => {},
  };
}

function fakeAdapter(overrides: Partial<SyncAdapter> = {}): SyncAdapter {
  return {
    user: { uid: 'u1', email: 'a@b.c' },
    onAuthChange: () => () => {},
    authReady: Promise.resolve(),
    signIn: async () => ({ uid: 'u1', email: 'a@b.c' }),
    sendVerification: async () => {},
    resetPassword: async () => {},
    checkApproval: async () => 'approved' as const,
    loadEntitlement: async () => null,
    signOut: async () => {},
    loadKeyRecord: async () => null,
    saveKeyRecord: async () => {},
    loadKeyDocument: async () => ({ record: null, resetAt: null }),
    resetVault: async () => {},
    pushNote: async () => {},
    pushFolder: async () => {},
    loadUsage: async () => null,
    pull: async () => ({ notes: [], folders: [], cursor: null, hasMore: false }),
    fetchNote: async () => null,
    pushVersions: async () => ({ refused: [] }),
    listVersions: async () => ({ versions: [], cursor: null, hasMore: false }),
    // Shares are a user action with their own button, never anything the
    // engine reaches for; present here only to satisfy the interface.
    publishShare: async () => {},
    revokeShare: async () => {},
    listShares: async () => [],
    subscribe: () => () => {},
    dispose: () => {},
    ...overrides,
  };
}

const encrypted = (id: string, revision: number, deleted = false): RawNote => ({
  id,
  meta: bytes(revision),
  body: deleted ? undefined : bytes(revision + 100),
  updatedAt: 1000 + revision,
  revision,
  deleted,
});

const sealedFolder = (id: string, updatedAt: number, deleted = false): RawFolder => ({
  id,
  data: bytes(updatedAt % 200),
  createdAt: 1000,
  updatedAt,
  deleted,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('account binding and backfill', () => {
  it('sweeps an unclaimed database on first sign-in', async () => {
    // The reported gap: a month of local-only notes was never queued, so
    // signing in left it on the device behind a green "Saved".
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 4));
    repo.notes.set('n2', encrypted('n2', 2));

    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => true,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).toHaveBeenCalledTimes(2);
    expect(repo.kv.get('app:owner')).toBe('u1');
    engine.stop();
  });

  it('uploads nothing when the database belongs to a different account', async () => {
    // A create cannot be taken back: the rules refuse deletes outright, so
    // one user's library landing in another's is permanent.
    const repo = fakeRepo();
    repo.kv.set('app:owner', 'someone-else');
    repo.notes.set('n1', encrypted('n1', 4));

    const pushNote = vi.fn();
    const onForeignOwner = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => true,
      onForeignOwner,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    expect(onForeignOwner).toHaveBeenCalled();
    // The previous account's bookkeeping is gone, and the binding is now ours.
    expect(repo.kv.get('app:owner')).toBe('u1');
    // And the sweep is retired for this library. Without that the device is
    // now bound to this account, so the next reload would classify as 'same',
    // find no marker, and upload the previous account's notes after all.
    expect(repo.kv.get('sync:backfilled')).toBe(true);
    engine.stop();
  });

  it('still refuses after a reload, once bound to the new account', async () => {
    const repo = fakeRepo();
    repo.kv.set('app:owner', 'someone-else');
    repo.notes.set('n1', encrypted('n1', 4));

    const pushNote = vi.fn();
    const first = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => true,
    });
    await first.start();
    await first.syncNow();
    first.stop();

    // A fresh engine, as a reload would build: same database, now recorded as
    // belonging to this account.
    const second = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => true,
    });
    await second.start();
    await second.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    second.stop();
  });

  it('uploads nothing when the account was set up with a different vault', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 4));

    const pushNote = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => false,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    engine.stop();
  });

  it('waits rather than sweeping while the vault answer is unknown', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 4));

    let owns: boolean | null = null;
    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => owns,
    });

    await engine.start();
    await engine.syncNow();
    expect(pushNote).not.toHaveBeenCalled();

    // The answer lands, and the next cycle acts on it rather than having
    // latched "no" on the strength of a null.
    owns = true;
    await engine.syncNow();
    expect(pushNote).toHaveBeenCalledOnce();
    engine.stop();
  });

  it('does not sweep a second time', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 4));
    repo.kv.set('sync:backfilled', true);

    const pushNote = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      vaultOwnsAccount: () => true,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    engine.stop();
  });
});

describe('pushing a large queue', () => {
  it('bounds a cycle and still pulls, then finishes the rest', async () => {
    // `push()` used to drain the whole queue in one cycle. A backfill makes
    // that thousands of serial round trips with `pull()` queued behind them
    // the entire time — and `onFirstSync` with it, which the first-run gate
    // waits on, so a new device would sit empty for the duration.
    const repo = fakeRepo();
    const entries: { id: string; kind: 'note' }[] = [];
    for (let i = 0; i < 250; i++) {
      const id = `n${i}`;
      repo.notes.set(id, encrypted(id, 1));
      entries.push({ id, kind: 'note' });
    }
    await repo.enqueueMany(entries);

    const pushNote = vi.fn().mockResolvedValue(undefined);
    // Record how much of the queue had been sent by the time each pull ran.
    // That is the property under test: a pull must not wait behind the whole
    // backlog, however large the backlog is.
    const pushesBeforeEachPull: number[] = [];
    const pull = vi.fn().mockImplementation(async () => {
      pushesBeforeEachPull.push(pushNote.mock.calls.length);
      return { notes: [], folders: [], cursor: null, hasMore: false };
    });
    const onFirstSync = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, pull }),
      repo,
      vaultOwnsAccount: () => true,
      onFirstSync,
    });

    await engine.start();
    await engine.syncNow();

    // The first pull came after one page, not after all 250.
    expect(pushesBeforeEachPull[0]).toBe(200);
    // And it took more than one cycle to clear, rather than one long one.
    expect(pushesBeforeEachPull.length).toBeGreaterThan(1);
    expect(onFirstSync).toHaveBeenCalled();

    // Nothing is dropped by paging: the queue still empties.
    expect(pushNote).toHaveBeenCalledTimes(250);
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('reports the outstanding count as the queue drains', async () => {
    // Without this the account panel froze for the whole drain: `pending` was
    // only copied on a status *change*, and the status sat on 'syncing'.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    repo.notes.set('n2', encrypted('n2', 1));
    await repo.enqueueMany([
      { id: 'n1', kind: 'note' },
      { id: 'n2', kind: 'note' },
    ]);

    const seen: number[] = [];
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote: vi.fn().mockResolvedValue(undefined) }),
      repo,
      onPending: (n) => seen.push(n),
    });

    await engine.start();
    await engine.syncNow();

    expect(seen).toContain(2);
    expect(seen.at(-1)).toBe(0);
    engine.stop();
  });
});

describe('pushing', () => {
  it('uploads a queued note and clears it from the queue', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 3));
    await repo.enqueue('n1', 'note');

    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({ createCoordinator: singleTabCoordinator, adapter: fakeAdapter({ pushNote }), repo });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).toHaveBeenCalledOnce();
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('refuses to upload a record that is not encrypted', async () => {
    // A plaintext record reaching the backend would be a silent breach of the
    // entire promise, so it must fail loudly rather than be "handled".
    const repo = fakeRepo();
    repo.notes.set('n1', { ...encrypted('n1', 1), meta: 'plaintext title' as never });
    await repo.enqueue('n1', 'note');

    const pushNote = vi.fn();
    const engine = createSyncEngine({ createCoordinator: singleTabCoordinator, adapter: fakeAdapter({ pushNote }), repo });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    // Still queued: nothing was lost, it just did not go.
    expect(repo.queue).toEqual(['n1']);
    engine.stop();
  });

  it('keeps a note queued when the backend is unreachable', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new TransientSyncError('offline')),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.queue).toEqual(['n1']);
    expect(engine.status).toBe('offline');
    engine.stop();
  });

  it('parks an oversized note rather than dropping it from the queue', async () => {
    const repo = fakeRepo();
    repo.notes.set('big', encrypted('big', 1));
    repo.notes.set('small', encrypted('small', 1));
    await repo.enqueue('big', 'note');
    await repo.enqueue('small', 'note');

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockImplementation((note: RemoteNote) => {
          if (note.id === 'big') throw new PayloadTooLargeError('big', 2_000_000);
          return Promise.resolve();
        }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    // It stays queued on purpose. The queue entry is what tells a pull this
    // note holds local text the backend has not got; dropping it would let the
    // stale remote copy overwrite the note on the next pull.
    expect(repo.queue).toContain('big');
    expect(repo.notes.has('big')).toBe(true);

    // But it is not retried, and it does not block the note behind it.
    await engine.syncNow();
    expect(repo.queue).not.toContain('small');
    engine.stop();
  });

  it('pushes the backend revision plus one, however far local editing has run', async () => {
    // The reported bug, in miniature. The local revision counts keystrokes, so
    // it leaps between pushes; the rules accept exactly one step past what is
    // stored. Pushing the local number means every push after the first is
    // rejected, read as a conflict, and answered with a duplicate note.
    const repo = fakeRepo();
    const pushNote = vi.fn().mockResolvedValue(undefined);
    const createConflictCopy = vi.fn();

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      createConflictCopy,
    });
    await engine.start();

    // Ten rounds of "type a few characters, pause": the local revision climbs
    // by an arbitrary amount each time.
    let local = 0;
    for (let round = 0; round < 10; round++) {
      local += 1 + round * 3;
      repo.notes.set('n1', encrypted('n1', local));
      await repo.enqueue('n1', 'note');
      await engine.syncNow();
    }

    expect(pushNote.mock.calls.map(([note]) => (note as RemoteNote).revision)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(createConflictCopy).not.toHaveBeenCalled();
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('bootstraps from the backend when it has no record of a note', async () => {
    // A note synced before this bookkeeping existed. One read tells us where
    // the backend actually is, instead of guessing from the local counter.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 300));
    await repo.enqueue('n1', 'note');

    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote,
        fetchNote: vi.fn().mockResolvedValue({
          id: 'n1',
          meta: bytes(6),
          revision: 6,
          updatedAt: 6000,
          deleted: false,
        }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect((pushNote.mock.calls[0]![0] as RemoteNote).revision).toBe(7);
    expect(repo.base('n1')).toBe(7);
    engine.stop();
  });

  it('keeps an edit made while a push was in flight', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockImplementation(async () => {
          // The user types while the request is out, and the write scheduler
          // queues the newer text under the same id.
          await repo.enqueue('n1', 'note');
        }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    // The ack clears the change it sent, not the one made since.
    expect(repo.queue).toContain('n1');
    engine.stop();
  });
});

describe('conflicts', () => {
  it('preserves the local version when the backend rejects a stale revision', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 5));
    await repo.enqueue('n1', 'note');
    // We last saw the backend at revision 3; it is now at 9, so another device
    // moved it. That is what makes this a conflict rather than a bad push.
    await saveSyncState(repo, 'n1', { base: 3 });

    const remote: RemoteNote = {
      id: 'n1',
      meta: bytes(9),
      body: bytes(99),
      revision: 9,
      updatedAt: 9000,
      deleted: false,
    };

    // The real implementation writes the copy to the store before returning
    // its id. A fake that only returns an id would leave the engine queueing
    // something that does not exist — which it correctly drops.
    const createConflictCopy = vi.fn().mockImplementation(async () => {
      repo.notes.set('copy-1', encrypted('copy-1', 1));
      return 'copy-1';
    });
    const onConflict = vi.fn();

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new RevisionConflictError('n1', 5)),
        fetchNote: vi.fn().mockResolvedValue(remote),
      }),
      repo,
      createConflictCopy,
      onConflict,
    });

    await engine.start();
    await engine.syncNow();

    // The local text was copied somewhere it cannot be overwritten, and the
    // remote version went with it so the copy can decline a pointless
    // duplicate...
    expect(createConflictCopy).toHaveBeenCalledWith('n1', remote);
    // ...the remote version took the original id. Its stored revision is the
    // local counter stepped forward, not the backend's — those are different
    // numbers — and the backend's is recorded separately.
    expect(repo.notes.get('n1')?.revision).toBe(6);
    expect(repo.base('n1')).toBe(9);
    // ...the copy is queued to sync in its own right...
    expect(repo.queue).toContain('copy-1');
    // ...and the user is told.
    expect(onConflict).toHaveBeenCalledWith({ noteId: 'n1', copyId: 'copy-1' });
    engine.stop();
  });

  it('still adopts the remote version when the copy cannot be made', async () => {
    // A tombstone has no body to copy. Losing the remote edit as well would
    // turn one problem into two.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 5, true));
    await repo.enqueue('n1', 'note');
    await saveSyncState(repo, 'n1', { base: 3 });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new RevisionConflictError('n1', 5)),
        fetchNote: vi.fn().mockResolvedValue({
          id: 'n1',
          meta: bytes(7),
          body: bytes(77),
          revision: 7,
          updatedAt: 7000,
          deleted: false,
        }),
      }),
      repo,
      createConflictCopy: async () => null,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.notes.get('n1')?.revision).toBe(6);
    expect(repo.base('n1')).toBe(7);
    expect(repo.notes.get('n1')?.deleted).toBe(false);
    engine.stop();
  });

  it('adopts its own write instead of forking when the acknowledgement is lost', async () => {
    // The write landed; the reply did not. The backend already holds exactly
    // what we sent, so forking here would duplicate a note over a dropped
    // packet — and then do it again on the retry.
    const repo = fakeRepo();
    const local = encrypted('n1', 5);
    repo.notes.set('n1', local);
    await repo.enqueue('n1', 'note');
    await saveSyncState(repo, 'n1', { base: 3 });

    const createConflictCopy = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new RevisionConflictError('n1', 4)),
        // base + 1, and our own updatedAt: this is our write coming back.
        fetchNote: vi.fn().mockResolvedValue({
          id: 'n1',
          meta: bytes(4),
          body: bytes(44),
          revision: 4,
          updatedAt: local.updatedAt,
          deleted: false,
        }),
      }),
      repo,
      createConflictCopy,
    });

    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).not.toHaveBeenCalled();
    expect(repo.base('n1')).toBe(4);
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('does not fork when the rejected document does not exist', async () => {
    // A create refused for some reason other than the compare-and-swap — a
    // payload the rules dislike, reported with the same `permission-denied`.
    // There is no other version to preserve, and minting a copy would mint
    // another on the next attempt, and another.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 5));
    await repo.enqueue('n1', 'note');

    const createConflictCopy = vi.fn();
    const pushNote = vi.fn().mockRejectedValue(new RevisionConflictError('n1', 1));
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, fetchNote: vi.fn().mockResolvedValue(null) }),
      repo,
      createConflictCopy,
    });

    await engine.start();
    await engine.syncNow();
    await engine.syncNow();

    expect(createConflictCopy).not.toHaveBeenCalled();
    // Parked, not dropped: the text is still there and still queued.
    expect(repo.queue).toContain('n1');
    expect(pushNote).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it('does not fork when the backend has not moved', async () => {
    // The compare-and-swap rejects exactly when the stored revision differs
    // from the one we anchored to. If it matches, the rejection came from
    // somewhere else and is not a conflict.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 5));
    await repo.enqueue('n1', 'note');
    await saveSyncState(repo, 'n1', { base: 3 });

    const createConflictCopy = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new RevisionConflictError('n1', 4)),
        fetchNote: vi.fn().mockResolvedValue({
          id: 'n1',
          meta: bytes(3),
          body: bytes(33),
          revision: 3,
          updatedAt: 3000,
          deleted: false,
        }),
      }),
      repo,
      createConflictCopy,
    });

    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).not.toHaveBeenCalled();
    expect(repo.queue).toContain('n1');
    engine.stop();
  });

  it('mints at most one copy for a note that keeps conflicting', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 5));
    await saveSyncState(repo, 'n1', { base: 3 });

    let backend = 9;
    const createConflictCopy = vi.fn().mockImplementation(async () => {
      repo.notes.set('copy-1', encrypted('copy-1', 1));
      return 'copy-1';
    });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockImplementation((note: RemoteNote) => {
          if (note.id !== 'n1') return Promise.resolve();
          throw new RevisionConflictError('n1', note.revision);
        }),
        // Always a step further on, so every push is a fresh "conflict".
        fetchNote: vi.fn().mockImplementation(async () => ({
          id: 'n1',
          meta: bytes(1),
          body: bytes(11),
          revision: ++backend,
          updatedAt: 9000 + backend,
          deleted: false,
        })),
      }),
      repo,
      createConflictCopy,
    });

    await engine.start();
    for (let round = 0; round < 5; round++) {
      await engine.queueNote('n1');
      await engine.syncNow();
    }

    // Once. Four identical notes is the symptom this whole change exists for.
    expect(createConflictCopy).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

describe('a conflict over metadata only', () => {
  /** An envelope-shaped body whose nonce is `n` repeated: what `sealIdOf` reads. */
  const sealed = (n: number) => {
    const out = new Uint8Array(40) as Uint8Array<ArrayBuffer>;
    out.set([1, 1]);
    out.fill(n, 2, 14);
    return out;
  };
  const sealOf = (n: number) => n.toString(16).padStart(2, '0').repeat(12);

  /** Local: a pin on revision 5, body untouched since base 3. Remote: an edit, at 9. */
  async function setup(options: { bodySeal?: string | undefined; localBody?: number } = {}) {
    const repo = fakeRepo();
    repo.notes.set('n1', { ...encrypted('n1', 5), meta: bytes(55), body: sealed(options.localBody ?? 3) });
    await repo.enqueue('n1', 'note');
    const bodySeal = 'bodySeal' in options ? options.bodySeal : sealOf(3);
    await saveSyncState(repo, 'n1', bodySeal === undefined ? { base: 3 } : { base: 3, bodySeal });
    const remote: RemoteNote = {
      id: 'n1',
      meta: bytes(9),
      body: sealed(9),
      revision: 9,
      updatedAt: 9000,
      deleted: false,
    };
    const pushNote = vi.fn().mockRejectedValueOnce(new RevisionConflictError('n1', 4));
    const createConflictCopy = vi.fn().mockResolvedValue(null);
    return { repo, remote, pushNote, createConflictCopy };
  }

  it('keeps the pin, takes the remote text, and mints no copy', async () => {
    const { repo, remote, pushNote, createConflictCopy } = await setup();
    const merged = bytes(77);
    const rebaseMeta = vi.fn().mockResolvedValue(merged);

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, fetchNote: vi.fn().mockResolvedValue(remote) }),
      repo,
      createConflictCopy,
      rebaseMeta,
    });
    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).not.toHaveBeenCalled();
    expect(rebaseMeta).toHaveBeenCalledWith('n1', bytes(55), remote.meta);
    const stored = repo.notes.get('n1')!;
    expect(stored.body).toBe(remote.body);
    expect(stored.meta).toBe(merged);
    expect(stored.revision).toBe(6);
    // Stamped past the remote write, so its push is never mistaken for it.
    expect(stored.updatedAt).toBeGreaterThan(remote.updatedAt);

    // Left queued, so the merge goes up at the adopted base.
    expect(pushNote).toHaveBeenCalledTimes(2);
    expect(repo.base('n1')).toBe(10);
    expect(pushNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 10, meta: merged, body: remote.body }),
      // It replaces the remote version it was merged onto.
      remote.meta.length + remote.body!.length,
    );
    expect(repo.queue).toEqual([]);
    expect((repo.kv.get('sync:note:n1') as NoteSyncState).bodySeal).toBe(sealOf(9));
    engine.stop();
  });

  it('simply adopts the remote when there is nothing of ours to keep', async () => {
    const { repo, remote, pushNote, createConflictCopy } = await setup();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, fetchNote: vi.fn().mockResolvedValue(remote) }),
      repo,
      createConflictCopy,
      rebaseMeta: vi.fn().mockResolvedValue(null),
    });
    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).not.toHaveBeenCalled();
    expect(repo.notes.get('n1')?.meta).toBe(remote.meta);
    expect(repo.notes.get('n1')?.updatedAt).toBe(remote.updatedAt);
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('still preserves the local text when the body changed here', async () => {
    const { repo, remote, pushNote, createConflictCopy } = await setup({ localBody: 4 });
    const rebaseMeta = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, fetchNote: vi.fn().mockResolvedValue(remote) }),
      repo,
      createConflictCopy,
      rebaseMeta,
    });
    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).toHaveBeenCalledWith('n1', remote);
    expect(rebaseMeta).not.toHaveBeenCalled();
    engine.stop();
  });

  it('treats an unknown base body as changed', async () => {
    const { repo, remote, pushNote, createConflictCopy } = await setup({ bodySeal: undefined });
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, fetchNote: vi.fn().mockResolvedValue(remote) }),
      repo,
      createConflictCopy,
      rebaseMeta: vi.fn(),
    });
    await engine.start();
    await engine.syncNow();

    expect(createConflictCopy).toHaveBeenCalled();
    engine.stop();
  });

  it('records the body it pushed and the body it pulled', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', { ...encrypted('n1', 2), body: sealed(21) });
    await repo.enqueue('n1', 'note');
    await saveSyncState(repo, 'n1', { base: 1 });
    const incoming: RemoteNote = { id: 'n2', meta: bytes(3), body: sealed(33), revision: 3, updatedAt: 3, deleted: false };

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: async () => ({ notes: [incoming], folders: [], cursor: null, hasMore: false }),
      }),
      repo,
    });
    await engine.start();
    await engine.syncNow();

    expect((repo.kv.get('sync:note:n1') as NoteSyncState).bodySeal).toBe(sealOf(21));
    expect((repo.kv.get('sync:note:n2') as NoteSyncState).bodySeal).toBe(sealOf(33));
    engine.stop();
  });
});

describe('pulling', () => {
  it('applies a newer remote revision', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 2));

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [{ id: 'n1', meta: bytes(4), body: bytes(44), revision: 4, updatedAt: 4000, deleted: false }],
            folders: [],
            cursor: '100',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '100', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    // The local revision steps forward rather than adopting the backend's, so
    // it stays monotonic for the crash journal and for the editor's "has this
    // note changed" check. Where the backend is gets recorded separately.
    expect(repo.notes.get('n1')?.revision).toBe(3);
    expect(repo.base('n1')).toBe(4);
    engine.stop();
  });

  it('never overwrites a note with local edits still queued', async () => {
    // Our copy has unpushed edits. A stale remote must not win, or the user's
    // work vanishes on the next sync. The queue entry is the evidence — the
    // local revision counts keystrokes and says nothing about the backend.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 9));
    await repo.enqueue('n1', 'note');
    await saveSyncState(repo, 'n1', { base: 2 });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [{ id: 'n1', meta: bytes(3), body: bytes(33), revision: 3, updatedAt: 3000, deleted: false }],
            folders: [],
            cursor: '50',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '50', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.notes.get('n1')?.revision).toBe(9);
    engine.stop();
  });

  it('records a remote revision it declined to apply', async () => {
    // Seeing a newer version and skipping it is not the same as not seeing it.
    // Without the record, a note with no anchor would bootstrap onto the
    // backend's current revision on its next push and overwrite this very
    // change — no rejection, no conflict copy, no trace.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 9));

    const pushNote = vi.fn().mockResolvedValue(undefined);
    const createConflictCopy = vi.fn().mockResolvedValue(null);
    const remote = {
      id: 'n1',
      meta: bytes(7),
      body: bytes(77),
      revision: 7,
      updatedAt: 7000,
      deleted: false,
    };

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote,
        pull: vi
          .fn()
          .mockImplementationOnce(async () => {
            // The user types while the pull is in flight, so the note is queued
            // by the time the incoming version is considered.
            await repo.enqueue('n1', 'note');
            return { notes: [remote], folders: [], cursor: '70', hasMore: false };
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '70', hasMore: false }),
        fetchNote: vi.fn().mockResolvedValue(remote),
      }),
      repo,
      createConflictCopy,
    });

    await engine.start();
    // Chains behind the sync that leadership starts, which is the one that
    // pulls and records the sighting.
    await engine.syncNow();

    // The push then treats it as the divergence it is. Without the record it
    // would have anchored to revision 7 — the very version it declined to
    // apply — and stepped straight over it with a write the backend accepts.
    expect(pushNote).not.toHaveBeenCalled();
    expect(createConflictCopy).toHaveBeenCalledWith('n1', remote);
    engine.stop();
  });

  it('leaves a note alone when nothing local has ever been synced', async () => {
    // Migration. A note caught by the duplicate loop sits at a local revision
    // far past the backend, which froze where it stopped accepting writes.
    // With no record of the backend yet, the local revision is the only
    // evidence there is, and adopting the remote would roll the note back.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 300));

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [{ id: 'n1', meta: bytes(6), body: bytes(66), revision: 6, updatedAt: 6000, deleted: false }],
            folders: [],
            cursor: '60',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '60', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.notes.get('n1')?.revision).toBe(300);
    engine.stop();
  });

  it('reports no change when the only remote note is our own write', async () => {
    // Every self-echo used to cost a full metadata reload and a search-index
    // rebuild in every open tab.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 4));
    await saveSyncState(repo, 'n1', { base: 4 });

    const onRemoteChange = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [{ id: 'n1', meta: bytes(4), body: bytes(44), revision: 4, updatedAt: 4000, deleted: false }],
            folders: [],
            cursor: '40',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '40', hasMore: false }),
      }),
      repo,
      onRemoteChange,
    });

    await engine.start();
    await engine.syncNow();

    expect(onRemoteChange).not.toHaveBeenCalled();
    engine.stop();
  });

  it('applies an incoming tombstone and drops the body', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 2));

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [{ id: 'n1', meta: bytes(3), revision: 3, updatedAt: 3000, deleted: true }],
            folders: [],
            cursor: '60',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '60', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    const stored = repo.notes.get('n1');
    expect(stored?.deleted).toBe(true);
    expect(stored?.body).toBeUndefined();
    engine.stop();
  });

  it('persists the cursor so the next sync is a delta', async () => {
    const repo = fakeRepo();
    const pull = vi.fn().mockResolvedValue({ notes: [], folders: [], cursor: '777', hasMore: false });
    const engine = createSyncEngine({ createCoordinator: singleTabCoordinator, adapter: fakeAdapter({ pull }), repo });

    await engine.start();
    await engine.syncNow();

    expect(await repo.get('sync:cursor')).toBe('777');
    engine.stop();
  });
});

describe('flushing before a round trip', () => {
  it('pushes text that the hook flushes, in the same cycle', async () => {
    // Text sitting in an unflushed write debounce has no queue entry, and the
    // queue entry is what stops a pull from overwriting it. Flushing first is
    // what keeps that race a conflict rather than a silent loss.
    const repo = fakeRepo();
    const pushNote = vi.fn().mockResolvedValue(undefined);

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
      beforeSync: async () => {
        if (repo.notes.has('n1')) return;
        repo.notes.set('n1', encrypted('n1', 4));
        await repo.enqueue('n1', 'note');
      },
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).toHaveBeenCalledTimes(1);
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('does not sync again just because the hook ran', async () => {
    // A hook that creates work on every call would sync in a loop.
    const repo = fakeRepo();
    const beforeSync = vi.fn().mockResolvedValue(undefined);

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter(),
      repo,
      beforeSync,
    });

    await engine.start();
    await engine.syncNow();
    const calls = beforeSync.mock.calls.length;

    await vi.waitFor(() => expect(engine.status).toBe('idle'));
    expect(beforeSync.mock.calls.length).toBe(calls);
    engine.stop();
  });
});

describe('session expiry', () => {
  it('stops syncing and reports it, without losing queued work', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const onSessionExpired = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new SessionExpiredError()),
      }),
      repo,
      onSessionExpired,
    });

    await engine.start();
    await engine.syncNow();

    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(engine.status).toBe('signed-out');
    // The note is still queued: signing in again resumes where this stopped.
    expect(repo.queue).toEqual(['n1']);
    engine.stop();
  });
});

describe('not approved', () => {
  /**
   * The regression this guards is expensive to rediscover.
   *
   * Firestore reports "your revision is stale" and "you may not write here at
   * all" with the same `permission-denied` code. The adapter tells them apart;
   * if it ever stops, the engine reads an authorisation failure as a conflict,
   * mints a local conflict copy, pushes it, is denied again — and duplicates
   * the note on a timer for as long as the app is open.
   */
  it('stops syncing without minting a conflict copy', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const onNotApproved = vi.fn();
    const createConflictCopy = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pushNote: vi.fn().mockRejectedValue(new SyncNotApprovedError()),
      }),
      repo,
      onNotApproved,
      createConflictCopy,
    });

    await engine.start();
    await engine.syncNow();

    expect(onNotApproved).toHaveBeenCalledOnce();
    expect(engine.status).toBe('not-approved');
    // The whole point: no duplicate note was created.
    expect(createConflictCopy).not.toHaveBeenCalled();
    // And nothing was dropped — approval later drains the queue as it stands.
    expect(repo.queue).toEqual(['n1']);
    engine.stop();
  });

  it('does not keep retrying once denied', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const pushNote = vi.fn().mockRejectedValue(new SyncNotApprovedError());
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
    });

    await engine.start();
    await engine.syncNow();
    await engine.syncNow();

    // The latch holds: a second attempt never reaches the backend.
    expect(pushNote).toHaveBeenCalledOnce();
    engine.stop();
  });
});

/**
 * The cost kill switch refuses every client with the same code a refused
 * account gets (`core/sync/pause.ts`). Read as non-approval, it told paying
 * users their plan had lapsed and released the first-run gate on empty
 * devices, which then seeded welcome notes that duplicated after the restore.
 */
describe('a refusal during a cost lockdown', () => {
  function lockedDown(probe: SyncAdapter['probePause']) {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    const pushNote = vi.fn().mockRejectedValue(new SyncNotApprovedError());
    const pull = vi.fn().mockRejectedValue(new SyncNotApprovedError());
    const unsubscribe = vi.fn();
    const hooks = {
      onNotApproved: vi.fn(),
      onPaused: vi.fn(),
      onFirstSync: vi.fn(),
      createConflictCopy: vi.fn(),
    };
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote, pull, ...(probe ? { probePause: probe } : {}), subscribe: () => unsubscribe }),
      repo,
      vaultOwnsAccount: () => true,
      ...hooks,
    });
    return { repo, engine, pushNote, pull, unsubscribe, ...hooks };
  }

  it('reports a pause, not a missing plan, and keeps everything queued', async () => {
    const probe = vi.fn(async () => 'paused' as const);
    const t = lockedDown(probe);
    await t.repo.enqueue('n1', 'note');
    await t.engine.start();
    await t.engine.syncNow();

    expect(probe).toHaveBeenCalledOnce();
    expect(t.engine.status).toBe('paused');
    expect(t.onPaused).toHaveBeenCalledOnce();
    expect(t.onNotApproved).not.toHaveBeenCalled();
    expect(t.createConflictCopy).not.toHaveBeenCalled();
    expect(t.repo.queue).toEqual(['n1']);
    t.engine.stop();
  });

  it('does not release the first-run wait', async () => {
    // An empty device must not seed welcome notes during a lockdown: the
    // account has not said what it holds, and seeded notes would sync up as
    // duplicates once the rules are back.
    const t = lockedDown(async () => 'paused');
    await t.engine.start();
    await t.engine.syncNow();
    expect(t.engine.status).toBe('paused');
    expect(t.onFirstSync).not.toHaveBeenCalled();
    t.engine.stop();
  });

  it('latches: no more requests, no timers, and the listener is closed', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => 'paused' as const);
      const t = lockedDown(probe);
      const requests = () => t.pull.mock.calls.length + t.pushNote.mock.calls.length;
      await t.engine.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests()).toBe(1);
      expect(t.engine.status).toBe('paused');
      expect(t.unsubscribe).toHaveBeenCalledOnce();

      await t.engine.queueNote('n1');
      await t.engine.syncNow();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(requests()).toBe(1);
      expect(probe).toHaveBeenCalledOnce();
      t.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is still non-approval when the sentinel is refused too', async () => {
    const t = lockedDown(async () => 'running');
    await t.engine.start();
    await t.engine.syncNow();
    expect(t.engine.status).toBe('not-approved');
    expect(t.onNotApproved).toHaveBeenCalledOnce();
    expect(t.onPaused).not.toHaveBeenCalled();
    expect(t.onFirstSync).toHaveBeenCalledOnce();
    t.engine.stop();
  });

  it('decides nothing when the probe cannot get an answer', async () => {
    // Two cycles: the leader's own first one, then the explicit `syncNow`.
    const probe = vi
      .fn<() => Promise<'unknown' | 'paused'>>()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValue('paused');
    const t = lockedDown(probe);
    await t.engine.start();
    await t.engine.syncNow();
    expect(t.engine.status).toBe('offline');
    expect(t.onNotApproved).not.toHaveBeenCalled();
    expect(t.onPaused).not.toHaveBeenCalled();
    // Not latched: the next cycle asks again, and this time learns it.
    await t.engine.syncNow();
    expect(t.engine.status).toBe('paused');
    expect(t.onPaused).toHaveBeenCalledOnce();
    t.engine.stop();
  });

  it('a probe that throws counts as no answer', async () => {
    const t = lockedDown(() => Promise.reject(new Error('boom')));
    await t.engine.start();
    await t.engine.syncNow();
    expect(t.engine.status).toBe('offline');
    expect(t.onNotApproved).not.toHaveBeenCalled();
    t.engine.stop();
  });

  it('an adapter with no probe keeps the old behaviour', async () => {
    const t = lockedDown(undefined);
    await t.engine.start();
    await t.engine.syncNow();
    expect(t.engine.status).toBe('not-approved');
    expect(t.onNotApproved).toHaveBeenCalledOnce();
    t.engine.stop();
  });
});

describe('when signed out', () => {
  it('does not attempt to sync', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    await repo.enqueue('n1', 'note');

    const pushNote = vi.fn();
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ user: null, pushNote }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).not.toHaveBeenCalled();
    expect(repo.queue).toEqual(['n1']);
    engine.stop();
  });
});

describe('folders', () => {
  it('pushes a queued folder and clears it from the queue', async () => {
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 5000));
    await repo.enqueue('f1', 'folder');

    const pushFolder = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushFolder }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushFolder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f1', updatedAt: 5000, deleted: false }),
      // Never seen on the backend, so it replaces nothing.
      0,
    );
    expect(repo.queue).not.toContain('f1');
    engine.stop();
  });

  it('refuses to upload a folder that is not encrypted', async () => {
    const repo = fakeRepo();
    repo.folders.set('f1', { ...sealedFolder('f1', 5000), data: 'plaintext name' });
    await repo.enqueue('f1', 'folder');

    const pushFolder = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushFolder }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushFolder).not.toHaveBeenCalled();
    engine.stop();
  });

  it('applies a remote folder it has never seen', async () => {
    const repo = fakeRepo();
    const remote = sealedFolder('f1', 5000);

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({ notes: [], folders: [remote], cursor: '1', hasMore: false })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.folders.get('f1')?.updatedAt).toBe(5000);
    engine.stop();
  });

  it('applies a remote folder update to one it already has', async () => {
    // The regression. The old rule wrote only when the folder was absent
    // locally or was a tombstone, so every remote *change* to a folder this
    // device already held was silently discarded — a rename or a reparent made
    // on one machine never reached the other.
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 5000));
    const renamed = { ...sealedFolder('f1', 9000), data: bytes(42) };

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({ notes: [], folders: [renamed], cursor: '1', hasMore: false })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.folders.get('f1')?.updatedAt).toBe(9000);
    expect(repo.folders.get('f1')?.data).toEqual(bytes(42));
    engine.stop();
  });

  it('ignores a remote folder older than the local copy', async () => {
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 9000));

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [],
            folders: [sealedFolder('f1', 5000)],
            cursor: '1',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.folders.get('f1')?.updatedAt).toBe(9000);
    engine.stop();
  });

  it('reports no change when the only remote folder is our own write', async () => {
    // An echo must not report a change: the caller answers one with a full
    // metadata reload and a search-index rebuild, and a folder comes back on
    // the first pull after every push.
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 5000));
    const onRemoteChange = vi.fn();

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [],
            folders: [sealedFolder('f1', 5000)],
            cursor: '1',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
      onRemoteChange,
    });

    await engine.start();
    await engine.syncNow();

    expect(onRemoteChange).not.toHaveBeenCalled();
    engine.stop();
  });

  it('never overwrites a folder with a local rename still queued', async () => {
    // The same bargain `applyRemoteNote` strikes for a queued note: adopting
    // the remote version now would discard what the user just typed, and the
    // push is about to settle it either way.
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 5000));
    await repo.enqueue('f1', 'folder');

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        // The user renames again while the push is in flight, so the entry is
        // still in the queue when the pull that follows considers the remote
        // version. That is the window the guard exists for — a push and the
        // pull behind it run in the same cycle.
        pushFolder: vi.fn(async () => {
          repo.folders.set('f1', sealedFolder('f1', 7000));
          await repo.enqueue('f1', 'folder');
        }),
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [],
            folders: [{ ...sealedFolder('f1', 9000), data: bytes(99) }],
            cursor: '1',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.folders.get('f1')?.updatedAt).toBe(7000);
    expect(repo.queue).toContain('f1');
    engine.stop();
  });

  it('lets a tombstone win even when the local copy looks newer', async () => {
    // A deletion the user has already made must not be undone by a stale copy
    // arriving late from a device that had not heard about it.
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 9000));

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({
        pull: vi
          .fn()
          .mockResolvedValueOnce({
            notes: [],
            folders: [sealedFolder('f1', 1000, true)],
            cursor: '1',
            hasMore: false,
          })
          .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false }),
      }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(repo.folders.get('f1')?.deleted).toBe(true);
    engine.stop();
  });
});

describe('pull paging', () => {
  it('follows hasMore across pages, carrying the cursor forward', async () => {
    // No existing test drove the paging loop — every fake pull returned
    // `hasMore: false` — which is part of why a cursor bug survived in it.
    const repo = fakeRepo();
    const pull = vi
      .fn()
      .mockResolvedValueOnce({
        notes: [encrypted('n1', 1)],
        folders: [],
        cursor: 'a',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        notes: [],
        folders: [sealedFolder('f1', 5000)],
        cursor: 'b',
        hasMore: false,
      })
      .mockResolvedValue({ notes: [], folders: [], cursor: 'b', hasMore: false });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pull }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pull.mock.calls[0]?.[0]).toBe(null);
    expect(pull.mock.calls[1]?.[0]).toBe('a');
    // The folder arrived on the second page, which the old loop would still
    // have reached — the point is that it is reached and applied.
    expect(repo.folders.get('f1')?.updatedAt).toBe(5000);
    expect(repo.kv.get('sync:cursor')).toBe('b');
    engine.stop();
  });

  it('stops rather than spinning when a page claims more but does not advance', async () => {
    const repo = fakeRepo();
    const pull = vi.fn().mockResolvedValue({
      notes: [encrypted('n1', 1)],
      folders: [],
      cursor: null,
      hasMore: true,
    });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pull }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    // Without the guard this loop never returns and the test times out.
    expect(pull.mock.calls.length).toBeLessThan(4);
    engine.stop();
  });
});

describe('a bad record does not block the queue behind it', () => {
  it('parks an unencrypted note and still pushes the ones queued after it', async () => {
    // The queue is oldest-first and `pushOne` threw out of the loop, so a
    // record that could never succeed meant every note behind it went
    // unattempted — permanently, because nothing parked it and every cycle
    // threw at the same entry.
    const repo = fakeRepo();
    repo.notes.set('bad', { ...encrypted('bad', 1), meta: 'plaintext' });
    repo.notes.set('good', encrypted('good', 1));
    await repo.enqueue('bad', 'note');
    await repo.enqueue('good', 'note');

    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pushNote).toHaveBeenCalledTimes(1);
    expect(pushNote.mock.calls[0]?.[0].id).toBe('good');
    expect(repo.queue).not.toContain('good');
    // Kept, not dropped: the text is still there and still unsent.
    expect(repo.queue).toContain('bad');
    engine.stop();
  });

  it('leaves the whole queue alone when the backend is unreachable', async () => {
    // The opposite case: nothing is wrong with these records, so none of them
    // may be parked out of future attempts.
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 1));
    repo.notes.set('n2', encrypted('n2', 1));
    await repo.enqueue('n1', 'note');
    await repo.enqueue('n2', 'note');

    // Held down rather than counted, so it does not matter how many cycles
    // the engine runs before the test's own.
    let reachable = false;
    const pushNote = vi.fn(async () => {
      if (!reachable) throw new TransientSyncError('offline');
    });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushNote }),
      repo,
    });

    await engine.start();
    await engine.syncNow();
    expect(repo.queue).toEqual(['n1', 'n2']);

    // And they go as soon as it comes back, rather than needing a fresh edit.
    reachable = true;
    await engine.syncNow();
    expect(repo.queue).toEqual([]);
    engine.stop();
  });
});

describe('the repair backfill', () => {
  it('drops a cursor written before the current epoch, once', async () => {
    // A cursor is a claim that everything before it was delivered. The shared
    // notes/folders cursor made that claim falsely, and no fix to the code
    // that computes it recovers what was already skipped — only re-reading
    // from the beginning does.
    const repo = fakeRepo();
    repo.kv.set('sync:cursor', '1700000000000');

    const pull = vi.fn().mockResolvedValue({
      notes: [],
      folders: [],
      cursor: 'fresh',
      hasMore: false,
    });

    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pull }),
      repo,
    });

    await engine.start();
    await engine.syncNow();

    expect(pull.mock.calls[0]?.[0]).toBe(null);
    engine.stop();

    // Marked as done, so the next session is a normal delta rather than
    // another full read of the account.
    const second = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pull }),
      repo,
    });
    await second.start();
    await second.syncNow();
    expect(pull.mock.lastCall?.[0]).toBe('fresh');
    second.stop();
  });
});

/**
 * The cadence timers, which nothing used to cover.
 *
 * Two devices on one account took ten seconds to see each other's edits, and
 * the reason was not the backend: the idle debounce is restarted by every
 * queued change, changes are queued several times a second while someone
 * types, and so the debounce never expired and the ceiling was the only timer
 * that ever fired. These lock the shape of that fix rather than the numbers —
 * each case injects its own `idleMs`/`checkpointMs`.
 */
describe('cadence', () => {
  /** Start, let the leader's opening cycle finish, and forget it happened. */
  async function started(engine: ReturnType<typeof createSyncEngine>, spies: { mockClear(): void }[]) {
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const spy of spies) spy.mockClear();
  }

  it('checkpoints while typing keeps restarting the idle debounce', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pushNote = vi.fn().mockResolvedValue(undefined);
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pushNote }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await started(engine, [pushNote]);
      repo.notes.set('n1', encrypted('n1', 1));

      // A change every 300 ms: slower than the write debounce that produces
      // them in the app, still far faster than the 800 ms idle timer.
      for (let i = 0; i < 9; i++) {
        await engine.queueNote('n1');
        await vi.advanceTimersByTimeAsync(300);
      }

      // The point of the test. The idle timer has been re-armed nine times and
      // has never come close to firing.
      expect(pushNote).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(pushNote).toHaveBeenCalledTimes(1);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes on the idle debounce once the typing stops', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pushNote = vi.fn().mockResolvedValue(undefined);
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pushNote }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await started(engine, [pushNote]);
      repo.notes.set('n1', encrypted('n1', 1));

      await engine.queueNote('n1');
      await vi.advanceTimersByTimeAsync(799);
      expect(pushNote).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(pushNote).toHaveBeenCalledTimes(1);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncs a structural change without waiting for the typing debounce', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pushNote = vi.fn().mockResolvedValue(undefined);
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pushNote }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await started(engine, [pushNote]);
      repo.notes.set('n1', encrypted('n1', 1));

      await engine.queueNote('n1', true);
      await vi.advanceTimersByTimeAsync(150);
      expect(pushNote).toHaveBeenCalledTimes(1);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of structural changes into one cycle', async () => {
    // Deleting a folder enqueues a tombstone per note inside it, back to back.
    // A resettable timer here would reproduce the typing bug in miniature; one
    // that re-armed per entry would cost a round trip each.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pull = vi
        .fn()
        .mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
      const pushNote = vi.fn().mockResolvedValue(undefined);
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pull, pushNote }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await started(engine, [pull, pushNote]);
      for (const id of ['n1', 'n2', 'n3']) repo.notes.set(id, encrypted(id, 1));

      await engine.queueNote('n1', true);
      await engine.queueNote('n2', true);
      await engine.queueNote('n3', true);
      await vi.advanceTimersByTimeAsync(150);

      expect(pull).toHaveBeenCalledTimes(1);
      expect(pushNote).toHaveBeenCalledTimes(3);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps checking on the backstop when nothing is queued', async () => {
    // Remote changes arrive on a listener, and a device with an empty queue
    // used to arm no timer at all — so a listener that went quiet was never
    // noticed.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pull = vi
        .fn()
        .mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pull }),
        repo,
        vaultOwnsAccount: () => true,
      });
      await started(engine, [pull]);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(pull).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(pull).toHaveBeenCalledTimes(1);

      // And again, so it is a backstop rather than a single shot.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(pull).toHaveBeenCalledTimes(2);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stretches the backstop while the tab is hidden', async () => {
    // A pinned tab spends most of the day hidden, and a check a minute there
    // is 1,440 billed cycles nobody reads.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      let hidden = true;
      const pull = vi
        .fn()
        .mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pull }),
        repo,
        vaultOwnsAccount: () => true,
        isHidden: () => hidden,
      });
      await started(engine, [pull]);

      await vi.advanceTimersByTimeAsync(61_000);
      expect(pull).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15 * 60_000 - 60_000);
      expect(pull).toHaveBeenCalledTimes(1);

      // Coming back syncs (App.svelte does this) and restores the minute.
      hidden = false;
      await engine.syncNow();
      expect(pull).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(pull).toHaveBeenCalledTimes(3);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets failure backoff outlast the hidden backstop', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pull = vi.fn().mockRejectedValue(new TransientSyncError('down'));
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pull }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        isHidden: () => true,
      });
      await engine.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = pull.mock.calls.length;

      // Hidden and failing: never more often than every fifteen minutes.
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
      expect(pull).toHaveBeenCalledTimes(afterStart);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the backstop once the account is refused', async () => {
    // Otherwise a device that can never sync wakes every minute forever for a
    // cycle that returns on its first line.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pull = vi.fn().mockRejectedValue(new SyncNotApprovedError());
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pull }),
        repo,
        vaultOwnsAccount: () => true,
      });
      await engine.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(pull).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(300_000);
      expect(pull).toHaveBeenCalledTimes(1);

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a structural change outrun the failure backoff', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const pushNote = vi.fn().mockRejectedValue(new TransientSyncError('down'));
      const engine = createSyncEngine({
        createCoordinator: singleTabCoordinator,
        adapter: fakeAdapter({ pushNote }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await started(engine, [pushNote]);
      repo.notes.set('n1', encrypted('n1', 1));

      // One failure, so the streak is running.
      await engine.queueNote('n1', true);
      await vi.advanceTimersByTimeAsync(150);
      expect(pushNote).toHaveBeenCalledTimes(1);

      // A second structural change must not jump the stretched delay.
      pushNote.mockClear();
      await engine.queueNote('n1', true);
      await vi.advanceTimersByTimeAsync(150);
      expect(pushNote).not.toHaveBeenCalled();

      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Two tabs, one database — the engine's half.
 *
 * Reloading a sibling's list moved to the workspace (see `tabs.test.ts`), so
 * that it works with no engine at all. What stays here is what only the engine
 * can do: route a sibling's announcement into the leader's cadence, and tell
 * followers about pulls.
 */
describe('sibling tabs', () => {
  /**
   * One bus, delivering to every channel but the sender — the only
   * `BroadcastChannel` property these tests turn on.
   */
  function bus() {
    const members = new Set<Set<(m: TabMessage) => void>>();
    return () => {
      const handlers = new Set<(m: TabMessage) => void>();
      members.add(handlers);
      const channel: TabChannel = {
        post(message) {
          for (const other of members) if (other !== handlers) for (const h of other) h(message);
        },
        subscribe(handler) {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
        close() {
          members.delete(handlers);
        },
      };
      return channel;
    };
  }

  /** A coordinator with a fixed role, on the channel the engine lends it. */
  const fixedRole = (leader: boolean) => (options: CoordinatorOptions) => {
    const unsubscribe = options.channel.subscribe(options.onMessage);
    if (leader) queueMicrotask(() => options.onBecomeLeader());
    return {
      role: leader ? ('leader' as const) : ('follower' as const),
      ready: Promise.resolve(),
      post: (message: TabMessage) => options.channel.post(message),
      stop: unsubscribe,
    };
  };

  it("keeps a sibling's typing inside the leader's cadence", async () => {
    // The leader used to answer every one of these with `syncNow()` on the
    // spot, so a follower's keystrokes pushed straight past the idle debounce,
    // the ceiling and the failure backoff — one full round trip per burst.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const join = bus();
      const siblingChannel = join();
      const leaderPush = vi.fn().mockResolvedValue(undefined);
      const leader = createSyncEngine({
        createCoordinator: fixedRole(true),
        channel: join(),
        adapter: fakeAdapter({ pushNote: leaderPush }),
        repo,
        vaultOwnsAccount: () => true,
        idleMs: 800,
        checkpointMs: 3000,
      });
      await leader.start();
      await vi.advanceTimersByTimeAsync(0);
      leaderPush.mockClear();

      repo.notes.set('n1', encrypted('n1', 1));
      for (let i = 0; i < 5; i++) {
        await repo.enqueue('n1', 'note');
        siblingChannel.post({ type: 'local', immediate: false });
        await vi.advanceTimersByTimeAsync(300);
      }

      // 1.5 s of typing next door, and the idle timer has been re-armed rather
      // than bypassed.
      expect(leaderPush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(900);
      expect(leaderPush).toHaveBeenCalled();
      leader.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes a structural change from a tab with no engine on the nudge', async () => {
    // A tab whose engine has not started yet — the seconds after sign-in — or
    // never will, writes straight to the queue. It used to announce nothing,
    // so the leader found the entry only on its 60 s backstop.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const join = bus();
      const engineless = join();
      const leaderPush = vi.fn().mockResolvedValue(undefined);
      const leader = createSyncEngine({
        createCoordinator: fixedRole(true),
        channel: join(),
        adapter: fakeAdapter({ pushNote: leaderPush }),
        repo,
        vaultOwnsAccount: () => true,
      });
      await leader.start();
      await vi.advanceTimersByTimeAsync(0);
      leaderPush.mockClear();

      repo.notes.set('n1', encrypted('n1', 1));
      await repo.enqueue('n1', 'note');
      engineless.post({ type: 'local', immediate: true });
      await vi.advanceTimersByTimeAsync(200);

      expect(leaderPush).toHaveBeenCalled();
      leader.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks a hidden leader to sync when a follower is looked at', async () => {
    // Leadership goes to whichever tab took the lock first, which may be the
    // hidden one, with its backstop stretched to fifteen minutes.
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const join = bus();
      const leaderPull = vi
        .fn()
        .mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
      const leader = createSyncEngine({
        createCoordinator: fixedRole(true),
        channel: join(),
        adapter: fakeAdapter({ pull: leaderPull }),
        repo,
        vaultOwnsAccount: () => true,
        isHidden: () => true,
      });
      const followerPull = vi.fn();
      const follower = createSyncEngine({
        createCoordinator: fixedRole(false),
        channel: join(),
        adapter: fakeAdapter({ pull: followerPull }),
        repo,
      });
      await leader.start();
      await follower.start();
      await vi.advanceTimersByTimeAsync(0);
      leaderPull.mockClear();

      // A focus and a visibilitychange arrive together: one cycle, not two.
      void follower.syncNow();
      void follower.syncNow();
      await vi.advanceTimersByTimeAsync(200);

      expect(leaderPull).toHaveBeenCalledTimes(1);
      expect(followerPull).not.toHaveBeenCalled();
      leader.stop();
      follower.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not announce its own writes; the workspace does', async () => {
    // Announcing from both would post every write twice.
    const repo = fakeRepo();
    const join = bus();
    const listener = vi.fn();
    join().subscribe(listener);
    const engine = createSyncEngine({
      createCoordinator: fixedRole(true),
      channel: join(),
      adapter: fakeAdapter({}),
      repo,
    });
    await engine.start();
    repo.notes.set('n1', encrypted('n1', 1));
    await engine.queueNote('n1', true);
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'local' }));
    engine.stop();
  });

  it('leaves a borrowed channel open when it stops', async () => {
    // The channel outlives the engine: signing out must not deafen the tab.
    const repo = fakeRepo();
    const join = bus();
    const other = join();
    const shared = join();
    const heard = vi.fn();
    shared.subscribe(heard);
    const engine = createSyncEngine({
      createCoordinator: fixedRole(false),
      channel: shared,
      adapter: fakeAdapter({}),
      repo,
    });
    await engine.start();
    engine.stop();

    other.post({ type: 'local', immediate: false });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('note versions', () => {
  type Record = import('../../src/core/history/record.ts').VersionRecord;
  type Outbox = import('../../src/core/history/outbox.ts').HistoryOutbox;

  const version = (noteId: string, seal: string, extra: Partial<Record> = {}): Record => ({
    id: `${noteId}:${seal}`,
    noteId,
    sealId: seal,
    at: 1000,
    capturedAt: 1000,
    expireAt: Date.now() + 86_400_000,
    reason: 'edit',
    meta: bytes(1),
    body: bytes(2),
    bytes: 10,
    state: 'queued',
    ...extra,
  });

  function fakeOutbox(records: Record[]): Outbox & { records: Map<string, Record>; mirrored: RawNote[] } {
    const map = new Map(records.map((r) => [r.id, r]));
    const mirrored: RawNote[] = [];
    const setState = (ids: readonly string[], state: Record['state']) => {
      for (const id of ids) map.set(id, { ...map.get(id)!, state });
    };
    return {
      records: map,
      mirrored,
      pending: async (maxCount) => [...map.values()].filter((r) => r.state === 'queued').slice(0, maxCount),
      pendingFor: async (noteId) => [...map.values()].filter((r) => r.state === 'queued' && r.noteId === noteId),
      markPushed: async (ids) => setState(ids, 'pushed'),
      markLocal: async (ids) => setState(ids, 'local'),
      retireAll: async () => setState([...map.values()].filter((r) => r.state === 'queued').map((r) => r.id), 'local'),
      mirror: async (row) => void mirrored.push(row),
    };
  }

  async function run(options: {
    repo?: ReturnType<typeof fakeRepo>;
    outbox: ReturnType<typeof fakeOutbox>;
    adapter?: Partial<SyncAdapter>;
    vaultOwnsAccount?: boolean | null;
  }) {
    const repo = options.repo ?? fakeRepo();
    // Past the first-sign-in sweep, which would queue every note in the fake.
    if (!repo.kv.has('app:owner')) repo.kv.set('app:owner', 'u1');
    repo.kv.set('sync:backfilled', true);
    const vault = 'vaultOwnsAccount' in options ? options.vaultOwnsAccount! : true;
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter(options.adapter),
      repo,
      vaultOwnsAccount: () => vault,
      history: async () => options.outbox,
    });
    // `start()` runs the leader's first cycle; waiting on the chain settles it.
    await engine.start();
    await engine.syncNow();
    return { engine, repo };
  }

  it('uploads queued versions after the notes and before the pull', async () => {
    const order: string[] = [];
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 2));
    await repo.enqueue('n1', 'note');
    const outbox = fakeOutbox([version('n1', 'aa'), version('n2', 'bb')]);

    const { engine } = await run({
      repo,
      outbox,
      adapter: {
        pushNote: async () => void order.push('note'),
        pushVersions: async (v) => (order.push(`versions:${v.length}`), { refused: [] }),
        pull: async () => (order.push('pull'), { notes: [], folders: [], cursor: null, hasMore: false }),
      },
    });

    expect(order.slice(0, 3)).toEqual(['note', 'versions:2', 'pull']);
    expect([...outbox.records.values()].map((r) => r.state)).toEqual(['pushed', 'pushed']);
    engine.stop();
  });

  it('retires the versions the backend refused, and keeps going', async () => {
    const outbox = fakeOutbox([version('n1', 'aa'), version('n1', 'bb')]);
    const { engine } = await run({
      outbox,
      adapter: {
        pushVersions: async (v) => ({ refused: v.filter((x) => x.id === 'bb') }),
      },
    });
    expect(outbox.records.get('n1:aa')?.state).toBe('pushed');
    expect(outbox.records.get('n1:bb')?.state).toBe('local');
    expect(engine.status).toBe('idle');
    engine.stop();
  });

  it('uploads nothing until the vault is known to be the account’s', async () => {
    for (const answer of [null, false]) {
      const pushVersions = vi.fn();
      const outbox = fakeOutbox([version('n1', 'aa')]);
      const { engine } = await run({ outbox, adapter: { pushVersions }, vaultOwnsAccount: answer });
      expect(pushVersions).not.toHaveBeenCalled();
      expect(outbox.records.get('n1:aa')?.state).toBe('queued');
      engine.stop();
    }
  });

  it('retires queued versions when the database belongs to another account', async () => {
    const repo = fakeRepo();
    repo.kv.set('app:owner', 'someone-else');
    const pushVersions = vi.fn();
    const outbox = fakeOutbox([version('n1', 'aa')]);
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter({ pushVersions }),
      repo,
      vaultOwnsAccount: () => true,
      history: async () => outbox,
    });
    await engine.start();
    await engine.syncNow();
    expect(pushVersions).not.toHaveBeenCalled();
    expect(outbox.records.get('n1:aa')?.state).toBe('local');
    engine.stop();
  });

  it('sends a deleted note’s versions before its tombstone', async () => {
    const order: string[] = [];
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 3, true));
    await repo.enqueue('n1', 'note');
    const outbox = fakeOutbox([version('n1', 'aa', { reason: 'delete' })]);

    const { engine } = await run({
      repo,
      outbox,
      adapter: {
        pushVersions: async (v) => (order.push(`versions:${v.map((x) => x.id).join()}`), { refused: [] }),
        pushNote: async (note) => void order.push(`note:${note.deleted}`),
      },
    });
    expect(order).toEqual(['versions:aa', 'note:true']);
    engine.stop();
  });

  it('leaves versions pending, not local-only, when the push window is full', async () => {
    const outbox = fakeOutbox([version('n1', 'aa'), version('n1', 'bb')]);
    const pushVersions = vi.fn().mockRejectedValue(new PushLimitError(Date.now() + 60_000));
    const { engine } = await run({ outbox, adapter: { pushVersions } });
    expect(pushVersions).toHaveBeenCalledOnce();
    expect([...outbox.records.values()].map((r) => r.state)).toEqual(['queued', 'queued']);
    // Held, without a write spent on it, for the rest of the window.
    await engine.syncNow();
    expect(pushVersions).toHaveBeenCalledOnce();
    engine.stop();
  });

  it('never arms another cycle or counts versions as pending work', async () => {
    const pushVersions = vi.fn().mockResolvedValue({ refused: [] });
    const pull = vi.fn().mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
    const outbox = fakeOutbox(Array.from({ length: 250 }, (_, i) => version('n1', `s${i}`)));
    const { engine } = await run({ outbox, adapter: { pushVersions, pull } });

    // One page per cycle, and the backlog does not trigger a follow-up cycle:
    // however many cycles ran, each pushed one page and pulled once.
    const cycles = pull.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pull.mock.calls.length).toBe(cycles);
    expect(pushVersions.mock.calls.length).toBe(cycles);
    expect(pushVersions.mock.calls[0]![0]).toHaveLength(20);
    expect(engine.pendingCount).toBe(0);
    engine.stop();
  });

  it('lets an offline failure through, but not a broken history database', async () => {
    const offline = await run({
      outbox: fakeOutbox([version('n1', 'aa')]),
      adapter: { pushVersions: vi.fn().mockRejectedValue(new TransientSyncError('offline')) },
    });
    expect(offline.engine.status).toBe('offline');
    offline.engine.stop();

    const broken = fakeOutbox([version('n1', 'aa')]);
    broken.pending = async () => {
      throw new Error('IndexedDB quota');
    };
    const pull = vi.fn().mockResolvedValue({ notes: [], folders: [], cursor: null, hasMore: false });
    const { engine } = await run({ outbox: broken, adapter: { pull } });
    expect(pull).toHaveBeenCalled();
    expect(engine.status).toBe('idle');
    engine.stop();
  });

  it('keeps a copy of a note that a remote tombstone is about to erase', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', encrypted('n1', 2));
    await saveSyncState(repo, 'n1', { base: 2 });
    const outbox = fakeOutbox([]);
    const pull = vi
      .fn()
      .mockResolvedValueOnce({
        notes: [{ id: 'n1', meta: bytes(3), revision: 3, updatedAt: 3000, deleted: true }],
        folders: [],
        cursor: '1',
        hasMore: false,
      })
      .mockResolvedValue({ notes: [], folders: [], cursor: '1', hasMore: false });

    const { engine } = await run({ repo, outbox, adapter: { pull } });
    expect(outbox.mirrored.map((r) => r.id)).toEqual(['n1']);
    expect(outbox.mirrored[0]!.body).toEqual(bytes(102));
    expect(repo.notes.get('n1')?.deleted).toBe(true);

    // An echo of a tombstone already applied mirrors nothing.
    await engine.syncNow();
    expect(outbox.mirrored).toHaveLength(1);
    engine.stop();
  });
});

describe('the daily push limit', () => {
  const sized = (id: string, size: number): RawNote => ({
    id,
    meta: bytes(1),
    body: new Uint8Array(size - 5) as Uint8Array<ArrayBuffer>,
    updatedAt: 2000,
    revision: 5,
    deleted: false,
  });

  const run = async (repo: ReturnType<typeof fakeRepo>, adapter: Partial<SyncAdapter>, extra = {}) => {
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter(adapter),
      repo,
      ...extra,
    });
    await engine.start();
    await engine.syncNow();
    return engine;
  };

  it('holds every change without spending a write each, and says until when', async () => {
    const repo = fakeRepo();
    for (const id of ['a', 'b', 'c']) {
      repo.notes.set(id, sized(id, 50));
      await repo.enqueue(id, 'note');
    }
    repo.folders.set('f1', sealedFolder('f1', 4000));
    await repo.enqueue('f1', 'folder');
    const retryAt = Date.now() + 5 * 60 * 60_000;
    const pushNote = vi.fn().mockRejectedValue(new PushLimitError(retryAt));
    const pushFolder = vi.fn().mockResolvedValue(undefined);
    const pushVersions = vi.fn().mockResolvedValue({ refused: [] });
    const onPushLimit = vi.fn();
    const engine = await run(repo, { pushNote, pushFolder, pushVersions }, { onPushLimit });

    expect(pushNote).toHaveBeenCalledOnce();
    expect(pushFolder).not.toHaveBeenCalled();
    expect(pushVersions).not.toHaveBeenCalled();
    expect(onPushLimit).toHaveBeenLastCalledWith(4, retryAt);
    expect(repo.queue.sort()).toEqual(['a', 'b', 'c', 'f1']);

    // Another cycle inside the window still spends nothing.
    await engine.syncNow();
    expect(pushNote).toHaveBeenCalledOnce();
    engine.stop();
  });

  it('never retries sooner than its floor, whatever the meter said', async () => {
    // A window that by this device's clock is already over (a skewed clock,
    // or a server that disagreed) must not turn into a tight loop.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const repo = fakeRepo();
      repo.notes.set('a', sized('a', 50));
      await repo.enqueue('a', 'note');
      const pushNote = vi.fn().mockRejectedValueOnce(new PushLimitError(Date.now() - 1000)).mockResolvedValue(undefined);
      const onPushLimit = vi.fn();
      const engine = await run(repo, { pushNote }, { onPushLimit });
      expect(onPushLimit).toHaveBeenLastCalledWith(1, Date.now() + 15 * 60_000);

      vi.setSystemTime(Date.now() + 14 * 60_000);
      await engine.syncNow();
      expect(pushNote).toHaveBeenCalledOnce();

      vi.setSystemTime(Date.now() + 2 * 60_000);
      await engine.syncNow();
      expect(pushNote).toHaveBeenCalledTimes(2);
      expect(onPushLimit).toHaveBeenLastCalledWith(0, null);
      expect(repo.queue).toEqual([]);
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the storage meter', () => {
  /** A note whose stored size is exactly `size` bytes: a 5-byte meta and the rest body. */
  const sized = (id: string, size: number, deleted = false): RawNote => ({
    id,
    meta: bytes(1),
    body: deleted ? undefined : (new Uint8Array(size - 5) as Uint8Array<ArrayBuffer>),
    updatedAt: 2000,
    revision: 5,
    deleted,
  });

  const run = async (repo: ReturnType<typeof fakeRepo>, adapter: Partial<SyncAdapter>, extra = {}) => {
    const engine = createSyncEngine({
      createCoordinator: singleTabCoordinator,
      adapter: fakeAdapter(adapter),
      repo,
      ...extra,
    });
    await engine.start();
    await engine.syncNow();
    return engine;
  };

  it('tells the adapter what each push replaces, and remembers what it sent', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', sized('n1', 40));
    await repo.enqueue('n1', 'note');
    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = await run(repo, { pushNote });

    // Nothing on the backend: a create replaces nothing.
    expect(pushNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1' }), 0);
    expect((repo.kv.get('sync:note:n1') as NoteSyncState).baseBytes).toBe(40);

    repo.notes.set('n1', sized('n1', 25));
    await engine.queueNote('n1', true);
    await engine.syncNow();
    expect(pushNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1' }), 40);
    expect((repo.kv.get('sync:note:n1') as NoteSyncState).baseBytes).toBe(25);
    engine.stop();
  });

  it('reads an anchor from before the meter once, to learn its size', async () => {
    const repo = fakeRepo();
    repo.notes.set('n1', sized('n1', 40));
    await saveSyncState(repo, 'n1', { base: 3 });
    await repo.enqueue('n1', 'note');
    const remote: RemoteNote = { id: 'n1', meta: bytes(1), body: bytes(2), revision: 3, updatedAt: 1, deleted: false };
    const fetchNote = vi.fn().mockResolvedValue(remote);
    const pushNote = vi.fn().mockResolvedValue(undefined);
    const engine = await run(repo, { pushNote, fetchNote });

    expect(fetchNote).toHaveBeenCalledOnce();
    expect(pushNote).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), 10);
    engine.stop();
  });

  it('records what a pull delivered, so the next push replaces the right size', async () => {
    const repo = fakeRepo();
    const remote: RemoteNote = { id: 'n1', meta: bytes(1), body: bytes(2), revision: 7, updatedAt: 1, deleted: false };
    const pull = vi.fn().mockResolvedValueOnce({ notes: [remote], folders: [sealedFolder('f1', 3000)], cursor: 'c1', hasMore: false });
    const engine = await run(repo, { pull });
    expect((repo.kv.get('sync:note:n1') as NoteSyncState).baseBytes).toBe(10);
    expect(repo.kv.get('sync:folder:f1')).toEqual({ bytes: 5 });
    engine.stop();
  });

  it('holds changes back when storage is full, without an error per note', async () => {
    const repo = fakeRepo();
    for (const id of ['a', 'b', 'c']) {
      repo.notes.set(id, sized(id, 50));
      await repo.enqueue(id, 'note');
    }
    const pushNote = vi.fn().mockRejectedValue(new QuotaExceededError('a', 50, 1000, 1000));
    const onStorageFull = vi.fn();
    const engine = await run(repo, { pushNote }, { onStorageFull });

    // The first refusal latches: the others would grow the account too, so
    // they are held without spending a refused write each.
    expect(pushNote).toHaveBeenCalledOnce();
    expect(onStorageFull).toHaveBeenLastCalledWith(3);
    expect(repo.queue).toEqual(['a', 'b', 'c']);
    engine.stop();
  });

  it('lets a deletion through when full, and then retries what was waiting', async () => {
    const repo = fakeRepo();
    repo.notes.set('big', sized('big', 50));
    await repo.enqueue('big', 'note');
    repo.notes.set('old', sized('old', 9000, true));
    await saveSyncState(repo, 'old', { base: 2, baseBytes: 9000 });
    await repo.enqueue('old', 'note');

    // A backend with 9000 bytes allowed and all of them in use.
    let used = 9000;
    const pushNote = vi.fn().mockImplementation(async (note: RemoteNote, stored: number) => {
      const delta = meterDelta(note.meta.length + (note.body?.length ?? 0), stored);
      if (delta > 0 && used + delta > 9000) throw new QuotaExceededError(note.id, delta, used, 9000);
      used += delta;
    });
    const onStorageFull = vi.fn();
    const engine = await run(repo, { pushNote }, { onStorageFull });

    // The tombstone shrank the account, which released the held note, and the
    // next cycle sent it.
    expect(onStorageFull.mock.calls.map(([n]) => n)).toEqual([1, 0]);
    await engine.syncNow();
    expect(repo.queue).toEqual([]);
    engine.stop();
  });

  it('does not hold back a write that grows a note only inside the 1 KiB minimum', async () => {
    // Full, but 300 → 800 bytes moves the meter by nothing, so it is sent.
    const repo = fakeRepo();
    repo.notes.set('a', sized('a', 50));
    await repo.enqueue('a', 'note');
    repo.notes.set('b', sized('b', 800));
    await saveSyncState(repo, 'b', { base: 2, baseBytes: 300 });
    await repo.enqueue('b', 'note');
    const pushNote = vi.fn().mockImplementation(async (note: RemoteNote) => {
      if (note.id === 'a') throw new QuotaExceededError('a', 1024, 1000, 1000);
    });
    await run(repo, { pushNote });
    expect(pushNote.mock.calls.map(([n]) => (n as RemoteNote).id)).toEqual(['a', 'b']);
    expect(repo.queue).toEqual(['a']);
  });

  it('passes a folder the size the backend last held', async () => {
    const repo = fakeRepo();
    repo.folders.set('f1', sealedFolder('f1', 5000));
    repo.kv.set('sync:folder:f1', { bytes: 3 });
    await repo.enqueue('f1', 'folder');
    const pushFolder = vi.fn().mockResolvedValue(undefined);
    const engine = await run(repo, { pushFolder });
    expect(pushFolder).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }), 3);
    expect(repo.kv.get('sync:folder:f1')).toEqual({ bytes: 5 });
    engine.stop();
  });
});
