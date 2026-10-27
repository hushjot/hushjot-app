import { describe, expect, it } from 'vitest';
import { CaptureTracker, CHECKPOINT_MS, SESSION_GAP_MS } from '../../src/core/history/policy.ts';

describe('CaptureTracker', () => {
  it('keeps the text a note had before the first save this page makes', () => {
    const tracker = new CaptureTracker();
    expect(tracker.observe('a', 1_000)).toBe(true);
    expect(tracker.observe('b', 1_000)).toBe(true);
  });

  it('does not capture again while the session continues', () => {
    const tracker = new CaptureTracker();
    tracker.observe('a', 0);
    for (let t = 2_000; t < 60_000; t += 2_000) expect(tracker.observe('a', t)).toBe(false);
  });

  it('starts a new session after a quiet gap', () => {
    const tracker = new CaptureTracker();
    tracker.observe('a', 0);
    expect(tracker.observe('a', SESSION_GAP_MS - 1)).toBe(false);
    expect(tracker.observe('a', 2 * SESSION_GAP_MS)).toBe(true);
  });

  it('checkpoints a long unbroken session', () => {
    const tracker = new CaptureTracker();
    tracker.observe('a', 0);
    let captures = 0;
    // A save every 2 s for 25 minutes, never a gap.
    for (let t = 2_000; t <= 25 * 60_000; t += 2_000) if (tracker.observe('a', t)) captures++;
    expect(captures).toBe(Math.floor((25 * 60_000) / CHECKPOINT_MS));
  });

  it('recovers from a clock that went backwards', () => {
    const tracker = new CaptureTracker();
    tracker.observe('a', 1_000_000);
    expect(tracker.observe('a', 10)).toBe(true);
    expect(tracker.observe('a', 2_010)).toBe(false);
  });

  it('forgets everything on clear', () => {
    const tracker = new CaptureTracker();
    tracker.observe('a', 0);
    tracker.clear();
    expect(tracker.observe('a', 1)).toBe(true);
  });
});
