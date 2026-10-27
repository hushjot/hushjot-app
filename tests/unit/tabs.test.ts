import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  watchSiblingWrites,
  type TabChannel,
  type TabMessage,
} from '../../src/core/sync/tabs.ts';

/**
 * The workspace's half of multi-tab: reloading this tab's list when a sibling
 * writes. It lived inside the sync engine, which meant a tab with no account —
 * local-only mode — never heard a sibling at all. These tests stand on the
 * channel alone, with no engine in sight, because that is the case that broke.
 */

/** A channel whose incoming messages the test delivers by hand. */
function inbox() {
  const handlers = new Set<(m: TabMessage) => void>();
  const channel: TabChannel = {
    post() {},
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
    },
  };
  const deliver = (m: TabMessage) => {
    for (const h of handlers) h(m);
  };
  return { channel, deliver };
}

const local = { type: 'local', immediate: false } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('watchSiblingWrites', () => {
  it("refreshes after a sibling's write, with no engine involved", async () => {
    vi.useFakeTimers();
    const { channel, deliver } = inbox();
    const refresh = vi.fn();
    watchSiblingWrites(channel, refresh);

    deliver({ type: 'local', immediate: true });
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('costs one refresh per second however fast the sibling types', async () => {
    // The announcement rides the write-scheduler drain, several times a second.
    // A restarting debounce here would be restarted faster than it could fire
    // and the other tab would show nothing at all until the typing stopped —
    // the trap `bench/RESULTS.md` names as "debouncing a debounced stream".
    vi.useFakeTimers();
    const { channel, deliver } = inbox();
    const refresh = vi.fn();
    watchSiblingWrites(channel, refresh);

    for (let i = 0; i < 20; i++) {
      deliver(local);
      await vi.advanceTimersByTimeAsync(150);
    }

    // Three seconds of continuous typing next door: three refreshes, not
    // twenty — and, crucially, not zero.
    expect(refresh.mock.calls.length).toBeGreaterThan(0);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('ignores messages about the backend', async () => {
    // `changed` and `synced` are the engine's; a pull is reported through it.
    vi.useFakeTimers();
    const { channel, deliver } = inbox();
    const refresh = vi.fn();
    watchSiblingWrites(channel, refresh);

    deliver({ type: 'changed' });
    deliver({ type: 'synced' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('fires no pending refresh after it stops', async () => {
    // Stopped on lock, when the repository it would read is being closed.
    vi.useFakeTimers();
    const { channel, deliver } = inbox();
    const refresh = vi.fn();
    const stop = watchSiblingWrites(channel, refresh);

    deliver(local);
    stop();
    deliver(local);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
