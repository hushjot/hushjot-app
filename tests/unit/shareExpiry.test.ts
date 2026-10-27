import { describe, it, expect } from 'vitest';
import {
  EXPIRY_TIERS,
  DEFAULT_TIER,
  SHARE_MAX_MS,
  DAY_MS,
  HOUR_MS,
  tierById,
  expiryAt,
  describeRemaining,
} from '../../src/core/share/expiry.ts';

const NOW = 1_758_000_000_000;

describe('expiry tiers', () => {
  it('every tier stays inside the ceiling the rules enforce', () => {
    for (const tier of EXPIRY_TIERS) {
      expect(expiryAt(tier.id, NOW) - NOW).toBeLessThan(SHARE_MAX_MS);
      expect(expiryAt(tier.id, NOW)).toBeGreaterThan(NOW);
    }
  });

  it('defaults to a week', () => {
    expect(tierById(DEFAULT_TIER).ms).toBe(7 * DAY_MS);
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(tierById('nonsense').id).toBe(DEFAULT_TIER);
  });
});

describe('describeRemaining', () => {
  it('says what is left', () => {
    expect(describeRemaining(NOW + 6 * DAY_MS, NOW)).toBe('in 6 days');
    expect(describeRemaining(NOW + DAY_MS, NOW)).toBe('in 1 day');
    expect(describeRemaining(NOW + 3 * HOUR_MS, NOW)).toBe('in 3 hours');
    expect(describeRemaining(NOW + HOUR_MS, NOW)).toBe('in 1 hour');
    expect(describeRemaining(NOW + 12 * 60_000, NOW)).toBe('in 12 minutes');
  });

  it('never rounds a live link down to zero', () => {
    expect(describeRemaining(NOW + 1_000, NOW)).toBe('in 1 minute');
  });

  it('calls an expired link expired', () => {
    expect(describeRemaining(NOW, NOW)).toBe('expired');
    expect(describeRemaining(NOW - 1, NOW)).toBe('expired');
  });
});
