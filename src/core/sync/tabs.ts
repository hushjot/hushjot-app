/**
 * Multi-tab coordination (§16 lists "multiple browser tabs"; plan issue #5).
 *
 * Without this, every open tab runs its own sync engine against the same
 * database. The revision compare-and-swap keeps that *safe* — the loser is
 * rejected and its text preserved — but it is wasteful, and it manufactures
 * conflict copies out of what is really one user typing in one place.
 *
 * So exactly one tab syncs:
 *
 * ```
 * leader     holds a Web Lock, owns the backend connection, broadcasts results
 * follower   edits and persists locally, nudges the leader, applies broadcasts
 * ```
 *
 * Leadership is about the *backend*, not about the database. Every tab writes
 * to the same IndexedDB, and each one holds its own in-memory copy of the note
 * list — so a write in one tab is invisible in the next until somebody says so.
 * That used to be nobody: the only messages were "leader, go and sync" and
 * "leader here, a pull landed", and neither describes one tab writing a note.
 * `local` is the message that does, and it travels in every direction rather
 * than towards the leader, because the staleness it fixes is not the leader's
 * privilege.
 *
 * The Web Locks API is the right primitive because the browser releases the
 * lock when the holder goes away — including a crash or a force-quit, which no
 * heartbeat scheme handles cleanly. When the leader's tab closes, a waiting tab
 * acquires the lock and takes over with no coordination of our own.
 *
 * Where Web Locks is unavailable the app falls back to every tab syncing, which
 * is exactly the Phase 4 behaviour: safe, just chattier.
 *
 * ## Two lifetimes: the channel and the lock
 *
 * The lock belongs to the sync engine, which exists only with an account. The
 * channel does not. It used to be opened by the coordinator, so both halves of
 * `local` — announcing a write and refreshing on one — lived inside the engine,
 * and every tab without one went deaf: local-only mode, a signed-out tab, an
 * unapproved account, and the seconds after sign-in before the engine starts.
 * Two windows side by side then disagreed about which notes existed until one
 * of them was focused, and a tab in that last window did not wake the leader
 * either, so its writes waited on the 60 s backstop.
 *
 * So the channel is opened by the workspace, which lives as long as the vault
 * is unlocked, and lent to the coordinator. The workspace announces writes and
 * refreshes on siblings' (`watchSiblingWrites`); the engine only listens, to
 * route `local` into the leader's cadence and to hear `changed` and `synced`.
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const LOCK_NAME = 'teksto:sync-leader';
const CHANNEL_NAME = 'teksto:sync';

export type TabRole = 'leader' | 'follower' | 'uncoordinated';

export type TabMessage =
  /**
   * This tab wrote to the database we share. Every other tab should reload the
   * list it is holding in memory, and the leader should also sync.
   *
   * Sent by any tab in any role, with or without a sync engine — it replaces the follower-only `wake`, whose
   * whole meaning ("leader, go and sync") this contains. A `BroadcastChannel`
   * never delivers to its own sender, so a tab is never told about its own
   * write and cannot refresh itself into a loop.
   *
   * Receivers must coalesce: this is posted from the write-scheduler drain,
   * which runs several times a second while somebody types.
   *
   * `immediate` carries the same distinction the local path has — a structural
   * change (note created, deleted, moved; folder added, renamed, deleted) skips
   * the typing debounce. The leader routes on it rather than syncing on the
   * spot, which is what a sibling's keystrokes used to make it do.
   */
  | { type: 'local'; immediate: boolean }
  /** The leader applied remote changes; followers should reload. */
  | { type: 'changed' }
  /**
   * The leader completed a sync cycle, so the shared database now reflects
   * whatever the account holds. Distinct from `changed`, which only fires when
   * something actually moved: a follower waiting to find out whether the
   * account is empty needs to hear "I looked", not "I found something".
   *
   * Only the first one of a session does anything — the receiver's handler is a
   * one-shot latch — so this is not a general "something happened" signal.
   */
  | { type: 'synced' }
  /**
   * A follower was brought back into view and wants what the account holds
   * now. Only the leader acts on it, by syncing on the nudge.
   *
   * Not the retired `wake`: that carried writes, which `local` now does for
   * every tab. This carries none and asks nothing of other followers. It exists
   * because the leader may be a hidden tab with its backstop stretched to
   * fifteen minutes while the user is working in a different one.
   */
  | { type: 'resync' }
  /**
   * This tab is deleting the shared databases — "remove all data from this
   * device". Every other tab must let go of its connection and stop showing
   * notes that are about to not exist.
   *
   * It is a message rather than something the platform handles, and that is
   * not belt-and-braces. `deleteDatabase` fires `versionchange` on the other
   * connections, but `deleteDb` resolves on `onblocked` (`core/repo/idb.ts`),
   * so a tab that holds on turns a delete into a *pending* delete that the
   * caller is told succeeded — and meanwhile that tab still has the key in
   * memory and the notes on screen, which is the whole thing the user was
   * trying to undo.
   *
   * Posted before the sender tears anything down, because the channel is the
   * workspace's and the workspace is about to close it.
   */
  | { type: 'reset' };

/**
 * The message bus between tabs, independent of who holds the lock.
 *
 * Several listeners share one `BroadcastChannel` rather than opening one each:
 * a channel never delivers to its own sender, but two channel objects in the
 * same tab are two senders, so a tab with separate ones would hear its own
 * writes and refresh itself on every pause in typing.
 */
export interface TabChannel {
  /** Tell the other tabs. Never delivered back to this tab. */
  post(message: TabMessage): void;
  subscribe(handler: (message: TabMessage) => void): () => void;
  close(): void;
}

export function createTabChannel(): TabChannel {
  const handlers = new Set<(message: TabMessage) => void>();
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      for (const handler of [...handlers]) handler(event.data);
    };
  } catch {
    // No BroadcastChannel: tabs cannot talk, so each falls back to syncing on
    // its own timers and refreshing on focus. Still correct, just less live.
  }

  return {
    post(message) {
      try {
        channel?.postMessage(message);
      } catch {
        // A closed channel is not worth failing a write over.
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      channel = undefined;
    },
  };
}

/** A channel with nobody on the other end: tests, and single-participant contexts. */
export function nullTabChannel(): TabChannel {
  return { post() {}, subscribe: () => () => {}, close() {} };
}

/**
 * How often a tab reloads its view because a sibling tab wrote something.
 *
 * A rate limit, not a debounce, and the distinction is the whole design. The
 * announcement arrives on the *sender's* write-scheduler drain, which fires
 * several times a second while somebody types — so a timer restarted by each
 * message would be restarted faster than it could ever expire, and the other
 * tab would show nothing at all until the typing stopped. This one is armed by
 * the first message of a burst and not touched again until it fires.
 *
 * A second is chosen against the measurement, not by feel: reloading the list
 * is ~41 ms at 10,000 notes (Spike 3 — read, decrypt, sort), so one per second
 * is a few percent of a core in a tab the user is not even looking at, and the
 * other tab is current within a second of a pause. It is also two orders of
 * magnitude inside the 3 s sync ceiling, so this is never what makes a change
 * feel slow to arrive.
 */
export const SIBLING_REFRESH_MS = 1_000;

/**
 * Call `refresh` when another tab writes to the database this one shares.
 *
 * Coalesced, and that is a correctness budget rather than a nicety: each
 * refresh costs a full `loadAllMeta()` — one AES-GCM open per note on the main
 * thread — and answering every message would hand a 10,000-note library a
 * decrypt storm in the *idle* tab, paid for by typing in the other one.
 *
 * Returns the teardown, which also cancels a refresh already armed: one firing
 * into a workspace that has been shut down would read a closed repository.
 */
export function watchSiblingWrites(
  channel: TabChannel,
  refresh: () => void,
  intervalMs = SIBLING_REFRESH_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const unsubscribe = channel.subscribe((message) => {
    if (message.type !== 'local' || stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) refresh();
    }, intervalMs);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

export interface TabCoordinator {
  readonly role: TabRole;
  /**
   * Resolves once the role is settled: either this tab took the lock, or it
   * waited long enough to conclude another tab holds it.
   *
   * A follower can never simply await leadership — the lock request stays
   * pending until the leader goes away, which may be hours. So this races
   * acquisition against a short grace period. If leadership arrives later,
   * `onBecomeLeader` still fires and the tab starts syncing then.
   */
  readonly ready: Promise<void>;
  /** Tell the other tabs something happened. */
  post(message: TabMessage): void;
  stop(): void;
}

export interface CoordinatorOptions {
  /**
   * The bus to listen and post on. Borrowed, never closed by the coordinator:
   * it outlives the engine (see "Two lifetimes" above).
   */
  channel: TabChannel;
  /** This tab became the syncing tab. */
  onBecomeLeader: () => void;
  /** A message arrived from another tab. */
  onMessage: (message: TabMessage) => void;
  /** How long to wait for the lock before assuming another tab holds it. */
  graceMs?: number;
}

export function supportsLeaderElection(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator;
}

export function createTabCoordinator(options: CoordinatorOptions): TabCoordinator {
  const { channel, onBecomeLeader, onMessage, graceMs = 300 } = options;

  let role: TabRole = 'follower';
  let stopped = false;
  let releaseLock: (() => void) | undefined;
  let settle: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const settleOnce = () => {
    settle?.();
    settle = undefined;
  };

  const unsubscribe = channel.subscribe((message) => {
    if (!stopped) onMessage(message);
  });

  if (!supportsLeaderElection()) {
    role = 'uncoordinated';
    // Nothing to wait for — start syncing immediately.
    queueMicrotask(() => {
      if (!stopped) onBecomeLeader();
      settleOnce();
    });
  } else {
    // Do not wait forever: a follower's request stays pending for as long as
    // the leader lives, and `start()` must not hang on that.
    const grace = setTimeout(settleOnce, graceMs);

    void navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => {
      if (stopped) return;
      role = 'leader';
      clearTimeout(grace);
      onBecomeLeader();
      settleOnce();

      // Hold the lock for as long as this tab lives. The promise returned to
      // `request` is what keeps it: resolving would hand leadership away, so
      // it resolves only when `stop()` is called or the tab goes away and the
      // browser releases it for us.
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
  }

  return {
    get role() {
      return role;
    },

    ready,

    post(message) {
      if (stopped) return;
      channel.post(message);
    },

    stop() {
      stopped = true;
      settleOnce();
      releaseLock?.();
      releaseLock = undefined;
      unsubscribe();
    },
  };
}

/**
 * A coordinator for contexts where there is only ever one participant: tests,
 * and any environment without a usable lock manager.
 *
 * Exists so the engine can be exercised without depending on Web Locks, which
 * behaves inconsistently under test runners that use worker threads.
 */
export function singleTabCoordinator(options: CoordinatorOptions): TabCoordinator {
  let stopped = false;
  const ready = Promise.resolve();
  queueMicrotask(() => {
    if (!stopped) options.onBecomeLeader();
  });

  return {
    role: 'uncoordinated',
    ready,
    post() {},
    stop() {
      stopped = true;
    },
  };
}
