import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  planPrune,
  tierFor,
  TIER_DAY_MS,
  TIER_MONTH_MS,
  TIER_WEEK_MS,
  utcDayStart,
  utcHourStart,
  type VersionSummary,
} from '../../src/core/history/retention.ts';

describe('tierFor', () => {
  it('keeps the first capture of a day for a month, of an hour for a week, the rest a day', () => {
    expect(tierFor('edit', false, false)).toBe(TIER_MONTH_MS);
    expect(tierFor('edit', true, false)).toBe(TIER_WEEK_MS);
    expect(tierFor('edit', true, true)).toBe(TIER_DAY_MS);
  });

  it('always keeps a deleted note for a month', () => {
    expect(tierFor('delete', true, true)).toBe(TIER_MONTH_MS);
  });

  it('buckets by UTC hour and day', () => {
    const at = Date.UTC(2026, 8, 17, 13, 59, 59, 999);
    expect(utcHourStart(at)).toBe(Date.UTC(2026, 8, 17, 13));
    expect(utcHourStart(at + 1)).toBe(Date.UTC(2026, 8, 17, 14));
    expect(utcDayStart(at)).toBe(Date.UTC(2026, 8, 17));
    expect(utcDayStart(Date.UTC(2026, 8, 18))).toBe(Date.UTC(2026, 8, 18));
  });
});

function v(id: string, noteId: string, capturedAt: number, tier: number, bytes = 100, reason: VersionSummary['reason'] = 'edit'): VersionSummary {
  return { id, noteId, capturedAt, expireAt: capturedAt + tier, bytes, reason };
}

describe('planPrune', () => {
  const now = 100 * DAY_MS;

  it('removes expired versions and nothing else while under the cap', () => {
    const plan = planPrune(
      [v('old', 'n', now - 2 * DAY_MS, TIER_DAY_MS), v('fresh', 'n', now - HOUR_MS, TIER_DAY_MS)],
      now,
      10_000,
    );
    expect(plan).toEqual(['old']);
  });

  it('over the cap, evicts the shortest tier first, oldest first, down to 90 %', () => {
    const versions = [
      v('month', 'n', now - 5 * HOUR_MS, TIER_MONTH_MS),
      v('week', 'n', now - 4 * HOUR_MS, TIER_WEEK_MS),
      v('day-old', 'n', now - 3 * HOUR_MS, TIER_DAY_MS),
      v('day-new', 'n', now - 2 * HOUR_MS, TIER_DAY_MS),
      v('newest', 'n', now - HOUR_MS, TIER_DAY_MS),
    ];
    // 500 bytes, cap 350 → target 315 → two evictions.
    expect(planPrune(versions, now, 350)).toEqual(['day-old', 'day-new']);
  });

  it('protects each note’s newest version and unexpired delete versions until nothing else is left', () => {
    const versions = [
      v('a-old', 'a', now - 3 * HOUR_MS, TIER_MONTH_MS),
      v('a-new', 'a', now - HOUR_MS, TIER_DAY_MS),
      v('b-deleted', 'b', now - 2 * HOUR_MS, TIER_MONTH_MS, 100, 'delete'),
      v('b-newer', 'b', now - HOUR_MS / 2, TIER_DAY_MS),
    ];
    expect(planPrune(versions, now, 250)).toEqual(['a-old', 'a-new']);
  });
});
