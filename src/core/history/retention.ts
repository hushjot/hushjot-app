/**
 * How long a version is kept: every version for a day, one an hour for a week,
 * one a day for thirty days.
 *
 * ## Decided at capture, not re-decided later
 *
 * The tier is fixed when a version is taken, from what this device has already
 * captured for the note: the first capture in a UTC day is kept 30 days, the
 * first in a UTC hour 7 days, anything else 24 hours. A deleted note's final
 * text is always kept the full 30 days — that is what Recently deleted promises.
 *
 * Choosing *first* in the bucket rather than last is not a compromise. Versions
 * are pre-images (`policy.ts`): the first one of a day is the note as the
 * previous working period left it, which is exactly the "one a day" worth
 * keeping. Keeping the last instead would mean rewriting an older record's
 * expiry each time a newer one arrived — and once versions sync, those records
 * are immutable on the backend.
 *
 * `expireAt` is the only thing pruning consults, so a synced version expiring
 * by a backend TTL and a local one expiring here agree by construction.
 *
 * ## The size cap
 *
 * Expiry bounds time, not bytes, and one pasted log file per hour could still
 * fill a quota. Over the cap, eviction goes shortest-lived tier first, oldest
 * first, down to 90 % so the next capture does not trigger another pass. It
 * never takes a note's newest version, nor an unexpired delete version, until
 * nothing else is left: those are the two a user is most likely to come looking
 * for.
 */
import type { VersionReason } from './record.ts';

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
export const TIER_DAY_MS = DAY_MS;
export const TIER_WEEK_MS = 7 * DAY_MS;
export const TIER_MONTH_MS = 30 * DAY_MS;
export const DEFAULT_CAP_BYTES = 50 * 1024 * 1024;

export function utcHourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/**
 * How long to keep a version captured at `capturedAt`.
 *
 * @param hasInDay whether this note already has a capture in the same UTC day
 * @param hasInHour whether it already has one in the same UTC hour
 */
export function tierFor(reason: VersionReason, hasInDay: boolean, hasInHour: boolean): number {
  if (reason === 'delete') return TIER_MONTH_MS;
  if (!hasInDay) return TIER_MONTH_MS;
  if (!hasInHour) return TIER_WEEK_MS;
  return TIER_DAY_MS;
}

/** What pruning needs to know about a version, without its bytes. */
export interface VersionSummary {
  id: string;
  noteId: string;
  capturedAt: number;
  expireAt: number;
  bytes: number;
  reason: VersionReason;
}

/**
 * Ids to delete: everything expired, then — only if the rest still exceeds
 * `capBytes` — the cheapest-to-lose versions until the total is at 90 % of it.
 */
export function planPrune(
  versions: readonly VersionSummary[],
  now: number,
  capBytes = DEFAULT_CAP_BYTES,
): string[] {
  const doomed: string[] = [];
  const live: VersionSummary[] = [];
  let total = 0;
  for (const v of versions) {
    if (v.expireAt <= now) doomed.push(v.id);
    else {
      live.push(v);
      total += v.bytes;
    }
  }
  if (total <= capBytes) return doomed;

  const newest = new Map<string, VersionSummary>();
  for (const v of live) {
    const held = newest.get(v.noteId);
    if (!held || v.capturedAt > held.capturedAt) newest.set(v.noteId, v);
  }
  const protectedIds = new Set<string>();
  for (const v of newest.values()) protectedIds.add(v.id);
  for (const v of live) if (v.reason === 'delete') protectedIds.add(v.id);

  // Shortest tier first (it was always going to go soonest), then oldest.
  const byCheapness = (a: VersionSummary, b: VersionSummary) =>
    a.expireAt - a.capturedAt - (b.expireAt - b.capturedAt) || a.capturedAt - b.capturedAt;
  const ordinary = live.filter((v) => !protectedIds.has(v.id)).sort(byCheapness);
  const guarded = live.filter((v) => protectedIds.has(v.id)).sort(byCheapness);

  const target = capBytes * 0.9;
  for (const v of [...ordinary, ...guarded]) {
    if (total <= target) break;
    doomed.push(v.id);
    total -= v.bytes;
  }
  return doomed;
}
