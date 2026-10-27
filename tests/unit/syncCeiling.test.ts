/**
 * The checkpoint ceiling stretches for large notes only (`ceilingFor` in
 * `core/sync/engine.ts`): every push and its echo move the whole note, so a
 * 3 s ceiling on a 900 KiB note is most of a heavy user's egress bill.
 */
import { describe, expect, it } from 'vitest';
import { ceilingFor } from '../../src/core/sync/engine.ts';

describe('ceilingFor', () => {
  it('leaves an ordinary note on the base ceiling', () => {
    expect(ceilingFor(0, 3_000)).toBe(3_000);
    expect(ceilingFor(5_000, 3_000)).toBe(3_000);
    expect(ceilingFor(64 * 1024, 3_000)).toBe(3_000);
  });

  it('stretches in proportion above 64 KiB, to ten times at the limit', () => {
    const mid = ceilingFor((64 + 900) * 512, 3_000);
    expect(mid).toBeGreaterThan(3_000);
    expect(mid).toBeLessThan(30_000);
    expect(ceilingFor(900 * 1024, 3_000)).toBe(30_000);
  });

  it('never stretches past ten times, whatever the size', () => {
    expect(ceilingFor(10 * 1024 * 1024, 3_000)).toBe(30_000);
  });
});
