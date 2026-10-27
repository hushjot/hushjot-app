import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAUSE_POLL_MS,
  PAUSE_RECHECK_MIN_MS,
  createPauseWatch,
  type PauseVerdict,
} from '../../src/core/sync/pause.ts';

/**
 * The wait at the end of a cost lockdown (`core/sync/pause.ts`). Each probe is
 * a billable read while every other request is refused, so what matters here
 * is how few of them there are, and that the first refused probe — the normal
 * rules are back — ends the wait exactly once.
 */
describe('the pause watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(verdicts: PauseVerdict[], hidden = () => false) {
    const probe = vi.fn(async () => verdicts.shift() ?? 'paused');
    const onResume = vi.fn();
    const w = createPauseWatch({ probe, onResume, isHidden: hidden });
    return { w, probe, onResume };
  }

  it('sends nothing on start, then one probe per interval', async () => {
    const { w, probe } = watch([]);
    w.start();
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS - 1);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    w.stop();
  });

  it('resumes once when the sentinel is refused again, and stops', async () => {
    const { w, probe, onResume } = watch(['paused', 'running']);
    w.start();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(w.active).toBe(false);
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 4);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown answer, or a probe that throws, as still paused', async () => {
    const probe = vi
      .fn<() => Promise<PauseVerdict>>()
      .mockResolvedValueOnce('unknown')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('running');
    const onResume = vi.fn();
    const w = createPauseWatch({ probe, onResume });
    w.start();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2);
    expect(onResume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not probe while the tab is hidden', async () => {
    let hidden = true;
    const { w, probe } = watch([], () => hidden);
    w.start();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 5);
    expect(probe).not.toHaveBeenCalled();
    hidden = false;
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('rechecks at once when asked, but never twice within the minimum gap', async () => {
    const { w, probe } = watch([]);
    w.start();
    // The caller probed just before starting the watch.
    await w.recheck();
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PAUSE_RECHECK_MIN_MS);
    await w.recheck();
    expect(probe).toHaveBeenCalledTimes(1);
    await w.recheck();
    await w.recheck();
    expect(probe).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('a recheck that finds the rules back resumes immediately', async () => {
    const { w, onResume } = watch(['running']);
    w.start();
    await vi.advanceTimersByTimeAsync(PAUSE_RECHECK_MIN_MS);
    await w.recheck();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('a stopped watch neither probes nor resumes', async () => {
    const { w, probe, onResume } = watch(['running']);
    w.start();
    w.stop();
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 3);
    await w.recheck();
    expect(probe).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });
});
