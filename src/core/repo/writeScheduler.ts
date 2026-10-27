/**
 * Debounced write scheduler.
 *
 * This is the mechanism behind "never press Save" (§4) and the resolution of
 * the §7/§13 tension: a keystroke marks a note dirty and returns, and the
 * scheduler decides when bytes actually move.
 *
 * Three triggers, in order of how much data they protect:
 *
 * - **Idle debounce** (~250 ms after typing stops) — the common case.
 * - **Maximum latency** (~2 s of continuous typing) — so a long uninterrupted
 *   burst still checkpoints. §8 asks for this at the *remote* layer; local
 *   writes are cheap enough (0.2 ms p95, Spike 4) to do it sooner.
 * - **Flush** — `pagehide`/`visibilitychange`, or an explicit call. Runs the
 *   write immediately.
 *
 * Encryption happens inside `write`, on the main thread. Spike 4 measured
 * AES-GCM on a 500 KB note at 0.5 ms, so the worker the plan originally
 * specified bought nothing and was dropped.
 */

export interface SchedulerOptions<T> {
  /** Persist the given batch. Rejections are reported, never swallowed. */
  write: (items: T[]) => Promise<void>;
  onError?: (error: unknown) => void;
  onStateChange?: (pending: boolean) => void;
  idleMs?: number;
  maxLatencyMs?: number;
}

export interface WriteScheduler<K, T> {
  /** Mark a value dirty. Synchronous and cheap — safe on the typing path. */
  schedule(key: K, value: T): void;
  /** Write everything pending now. Resolves once the store has it. */
  flush(): Promise<void>;
  /** True while anything is queued or in flight. */
  readonly pending: boolean;
  dispose(): void;
}

export function createWriteScheduler<K, T>(
  options: SchedulerOptions<T>,
): WriteScheduler<K, T> {
  const { write, onError, onStateChange, idleMs = 150, maxLatencyMs = 2000 } = options;

  // Keyed, so ten edits to one note collapse into one write rather than ten.
  const dirty = new Map<K, T>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let running = 0;
  let consecutiveFailures = 0;
  let disposed = false;
  let lastPending = false;

  const MAX_RETRIES = 4;
  const retryDelayMs = Math.max(idleMs * 4, 1000);

  const isPending = () => dirty.size > 0 || running > 0;

  function notify(): void {
    const now = isPending();
    if (now !== lastPending) {
      lastPending = now;
      onStateChange?.(now);
    }
  }

  function clearTimers(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    idleTimer = undefined;
    maxTimer = undefined;
    retryTimer = undefined;
  }

  async function run(): Promise<void> {
    clearTimers();
    if (dirty.size === 0) return;

    // Take the batch before awaiting, so edits made *during* the write land in
    // the next batch rather than being lost or written twice.
    const batch = [...dirty.entries()];
    dirty.clear();

    running++;
    notify();
    try {
      await write(batch.map(([, value]) => value));
      consecutiveFailures = 0;
    } catch (error) {
      // Requeue anything the user has not since re-edited, so a failed write
      // never silently discards their text (§25). A key already back in
      // `dirty` holds a newer value and must not be overwritten by this
      // stale one.
      for (const [key, value] of batch) {
        if (!dirty.has(key)) dirty.set(key, value);
      }
      onError?.(error);

      // Retry a transient failure, but give up after a few attempts rather
      // than spinning forever on a permanent one such as an exceeded quota.
      // The data stays queued either way; the next edit or flush retries it.
      consecutiveFailures++;
      if (!disposed && consecutiveFailures <= MAX_RETRIES) {
        retryTimer = setTimeout(() => void drain(), retryDelayMs * consecutiveFailures);
      }
    } finally {
      running--;
      notify();
    }
  }

  /** Serialise writes: never let two batches race the same store. */
  function drain(): Promise<void> {
    chain = chain.then(run);
    return chain;
  }

  return {
    schedule(key, value) {
      if (disposed) return;
      dirty.set(key, value);
      // A fresh edit means the user is still working: give a previously
      // failing write its full retry budget again.
      consecutiveFailures = 0;
      notify();

      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void drain(), idleMs);

      // Only start the ceiling timer once per burst, so continuous typing
      // still checkpoints instead of pushing the deadline forward forever.
      if (maxTimer === undefined) {
        maxTimer = setTimeout(() => void drain(), maxLatencyMs);
      }
    },

    async flush() {
      if (disposed) return;
      await drain();
    },

    get pending() {
      return isPending();
    },

    dispose() {
      disposed = true;
      clearTimers();
      dirty.clear();
    },
  };
}
