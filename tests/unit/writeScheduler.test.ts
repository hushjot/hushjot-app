import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWriteScheduler } from '../../src/core/repo/writeScheduler.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let queued promise callbacks run without advancing the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('createWriteScheduler', () => {
  it('does not write until the idle delay elapses', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 250 });

    s.schedule('a', 'v1');
    await settle();
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(['v1']);
  });

  it('collapses repeated edits to one key into a single write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 250 });

    for (const v of ['v1', 'v2', 'v3']) {
      s.schedule('a', v);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(['v3']);
  });

  it('checkpoints during continuous typing via the latency ceiling', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({
      write,
      idleMs: 250,
      maxLatencyMs: 1000,
    });

    // Type without ever pausing long enough to trigger the idle debounce.
    for (let i = 0; i < 20; i++) {
      s.schedule('a', `v${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(write).toHaveBeenCalled();
  });

  it('writes every dirty key in one batch', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 100 });

    s.schedule('a', 'A');
    s.schedule('b', 'B');
    await vi.advanceTimersByTimeAsync(100);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]!.sort()).toEqual(['A', 'B']);
  });

  it('flush writes immediately', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 10_000 });

    s.schedule('a', 'v1');
    await s.flush();

    expect(write).toHaveBeenCalledWith(['v1']);
    expect(s.pending).toBe(false);
  });

  it('flush on an empty queue is a no-op', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write });
    await s.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps edits made during an in-flight write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = vi.fn().mockImplementation(() => gate);
    const s = createWriteScheduler<string, string>({ write, idleMs: 50 });

    s.schedule('a', 'first');
    await vi.advanceTimersByTimeAsync(50);
    expect(write).toHaveBeenCalledWith(['first']);

    // Edit arrives while the first write is still in flight.
    s.schedule('a', 'second');
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(50);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(['second']);
  });

  it('requeues a failed write rather than dropping the data', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk on fire'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const s = createWriteScheduler<string, string>({ write, onError, idleMs: 50 });

    s.schedule('a', 'precious');
    await vi.advanceTimersByTimeAsync(50);

    expect(onError).toHaveBeenCalledTimes(1);
    // The value must still be queued, not lost.
    expect(s.pending).toBe(true);

    await s.flush();
    expect(write).toHaveBeenLastCalledWith(['precious']);
    expect(s.pending).toBe(false);
  });

  it('does not let a failed write clobber a newer edit', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 50, onError: () => {} });

    s.schedule('a', 'old');
    const failing = vi.advanceTimersByTimeAsync(50);
    s.schedule('a', 'new'); // newer edit lands while the write is failing
    await failing;

    await s.flush();
    // The retry must carry the newer value, never resurrect the stale one.
    expect(write).toHaveBeenLastCalledWith(['new']);
  });

  it('stops retrying a permanently failing write', async () => {
    const write = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const onError = vi.fn();
    const s = createWriteScheduler<string, string>({ write, onError, idleMs: 50 });

    s.schedule('a', 'v');
    await vi.advanceTimersByTimeAsync(60_000);

    // Bounded, not an infinite spin — but the data is still queued.
    expect(write.mock.calls.length).toBeLessThanOrEqual(6);
    expect(s.pending).toBe(true);
  });

  it('reports pending state transitions', async () => {
    const onStateChange = vi.fn();
    const s = createWriteScheduler<string, string>({
      write: vi.fn().mockResolvedValue(undefined),
      onStateChange,
      idleMs: 50,
    });

    s.schedule('a', 'v');
    expect(onStateChange).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(50);
    expect(onStateChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores work scheduled after dispose', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const s = createWriteScheduler<string, string>({ write, idleMs: 50 });

    s.dispose();
    s.schedule('a', 'v');
    await vi.advanceTimersByTimeAsync(1000);

    expect(write).not.toHaveBeenCalled();
  });
});
