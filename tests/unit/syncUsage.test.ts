/**
 * The meter's shared definitions. The CLI and the billing API's backfill both
 * depend on these agreeing with the rules, so they are pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  BASE_STORAGE_BYTES,
  DAILY_PUSH_LIMIT,
  MIN_CHARGED_BYTES,
  PUSH_WINDOW_MS,
  chargedBytes,
  countedNoteBytes,
  meterDelta,
  pushWindowFull,
  usageMonth,
} from '../../src/core/sync/usage.ts';

describe('the storage meter', () => {
  it('buckets by UTC month, zero-padded', () => {
    expect(usageMonth(Date.UTC(2026, 0, 1))).toBe('202601');
    expect(usageMonth(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe('202610');
    // Midnight UTC on the 1st is the next month wherever the device is.
    expect(usageMonth(Date.UTC(2026, 10, 1))).toBe('202611');
  });

  it('counts meta and body, and a tombstone as its meta', () => {
    expect(countedNoteBytes(new Uint8Array(3), new Uint8Array(4))).toBe(7);
    expect(countedNoteBytes(new Uint8Array(3), undefined)).toBe(3);
    expect(countedNoteBytes(null, null)).toBe(0);
  });

  it('includes 1 GiB, as the billing API does', () => {
    expect(BASE_STORAGE_BYTES).toBe(1 << 30);
  });

  it('charges a stored document at least 1 KiB, and an absent one nothing', () => {
    // The rules' `charged()` and the billing API's recount use these numbers.
    expect(MIN_CHARGED_BYTES).toBe(1024);
    expect(chargedBytes(0)).toBe(0);
    expect(chargedBytes(1)).toBe(1024);
    expect(chargedBytes(1024)).toBe(1024);
    expect(chargedBytes(1025)).toBe(1025);
  });

  it('moves the meter by the change in charge, not in size', () => {
    expect(meterDelta(100, 0)).toBe(1024);
    expect(meterDelta(5000, 0)).toBe(5000);
    expect(meterDelta(900, 100)).toBe(0);
    expect(meterDelta(1500, 900)).toBe(1500 - 1024);
    // A tombstone keeps the floor: deleting frees what was above it.
    expect(meterDelta(30, 1500)).toBe(1024 - 1500);
    expect(meterDelta(30, 300)).toBe(0);
  });

  it('limits pushes to 20,000 a day', () => {
    expect(DAILY_PUSH_LIMIT).toBe(20_000);
    expect(PUSH_WINDOW_MS).toBe(86_400_000);
    expect(pushWindowFull({ pushesInWindow: 19_999 })).toBe(false);
    expect(pushWindowFull({ pushesInWindow: 20_000 })).toBe(true);
  });
});
