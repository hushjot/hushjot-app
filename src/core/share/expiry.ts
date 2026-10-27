/**
 * How long a link lives.
 *
 * The tiers are the ones a person actually means when they paste a link into a
 * chat: "look at this now", "today", "this week", "keep it around". Seven days
 * is the default because a share is usually read within minutes and the long
 * tail is someone coming back to it after a weekend.
 *
 * ## The ceiling is the security control, not the default
 *
 * `SHARE_MAX_MS` mirrors the note-version ceiling in `firestore.rules`: 31
 * days, one more than the longest tier, so a clock skew of a few seconds
 * cannot reject a legitimate 30-day link. The rules enforce it; this file only
 * has to agree. Without a ceiling a client could park text on the backend
 * forever.
 *
 * ## Expiry is enforced on read
 *
 * Firestore's TTL policy (`firestore.indexes.blaze.json`) deletes an expired
 * share, but only typically within a day of `expireAt`, so what actually makes
 * an expired link stop working is the read rule, `expireAt > request.time`.
 * Until the sweep the ciphertext stays in Firestore — unreadable, but present,
 * exactly as note versions are. `docs/security.md` says so out loud.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface ExpiryTier {
  /** Stable id, so a stored preference survives a wording change. */
  id: 'hour' | 'day' | 'week' | 'month';
  label: string;
  ms: number;
}

export const EXPIRY_TIERS: readonly ExpiryTier[] = [
  { id: 'hour', label: '1 hour', ms: HOUR_MS },
  { id: 'day', label: '1 day', ms: DAY_MS },
  { id: 'week', label: '7 days', ms: 7 * DAY_MS },
  { id: 'month', label: '30 days', ms: 30 * DAY_MS },
];

export const DEFAULT_TIER: ExpiryTier['id'] = 'week';

/** One more than the longest tier, matching the rules. */
export const SHARE_MAX_MS = 31 * DAY_MS;

export function tierById(id: string): ExpiryTier {
  return EXPIRY_TIERS.find((t) => t.id === id) ?? EXPIRY_TIERS[2]!;
}

/** The absolute expiry for a tier, clamped so the rules can never refuse it. */
export function expiryAt(tier: ExpiryTier['id'], now = Date.now()): number {
  return now + Math.min(tierById(tier).ms, SHARE_MAX_MS - MINUTE_MS);
}

/** "in 6 days", "in 3 hours", "in 12 minutes", or "expired". */
export function describeRemaining(expireAt: number, now = Date.now()): string {
  const left = expireAt - now;
  if (left <= 0) return 'expired';
  if (left >= DAY_MS) {
    const days = Math.round(left / DAY_MS);
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  if (left >= HOUR_MS) {
    const hours = Math.round(left / HOUR_MS);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(left / MINUTE_MS));
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
