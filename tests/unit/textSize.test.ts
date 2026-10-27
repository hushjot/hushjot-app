import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEXT_SIZE,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  TEXT_SIZES,
  nearestTextSize,
  normalizeTextSize,
  stepTextSize,
} from '../../src/ui/textSize.ts';

describe('stepTextSize', () => {
  it('walks the whole ladder in both directions', () => {
    let size: number = MIN_TEXT_SIZE;
    const up = [size];
    for (let i = 0; i < TEXT_SIZES.length; i += 1) {
      size = stepTextSize(size, 1);
      if (up[up.length - 1] !== size) up.push(size);
    }
    expect(up).toEqual([...TEXT_SIZES]);

    const down = [size];
    for (let i = 0; i < TEXT_SIZES.length; i += 1) {
      size = stepTextSize(size, -1);
      if (down[down.length - 1] !== size) down.push(size);
    }
    expect(down).toEqual([...TEXT_SIZES].reverse());
  });

  it('clamps rather than wrapping at either end', () => {
    expect(stepTextSize(MIN_TEXT_SIZE, -1)).toBe(MIN_TEXT_SIZE);
    expect(stepTextSize(MAX_TEXT_SIZE, 1)).toBe(MAX_TEXT_SIZE);
  });

  it('steps off a size that is not on the ladder', () => {
    // A value saved before the ladder changed must not get stuck: 21 snaps to
    // 20 first, then steps from there.
    expect(stepTextSize(21, 1)).toBe(24);
    expect(stepTextSize(21, -1)).toBe(18);
  });
});

describe('nearestTextSize', () => {
  it('snaps to the closest rung, ties going to the smaller one', () => {
    expect(nearestTextSize(14)).toBe(14);
    expect(nearestTextSize(15)).toBe(14);
    expect(nearestTextSize(22)).toBe(20);
    expect(nearestTextSize(1)).toBe(MIN_TEXT_SIZE);
    expect(nearestTextSize(400)).toBe(MAX_TEXT_SIZE);
  });
});

describe('normalizeTextSize', () => {
  it('defaults when nothing has been saved', () => {
    expect(normalizeTextSize(null)).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize('')).toBe(DEFAULT_TEXT_SIZE);
  });

  it('defaults on a corrupt value rather than throwing', () => {
    expect(normalizeTextSize('huge')).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize('NaN')).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize('Infinity')).toBe(DEFAULT_TEXT_SIZE);
  });

  it('defaults on a value outside the ladder, in either direction', () => {
    expect(normalizeTextSize('4')).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize('96')).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize('-14')).toBe(DEFAULT_TEXT_SIZE);
  });

  it('accepts every size it can write', () => {
    for (const size of TEXT_SIZES) {
      expect(normalizeTextSize(String(size))).toBe(size);
    }
  });

  it('snaps a value that lands between rungs', () => {
    expect(normalizeTextSize('21')).toBe(20);
    // Exactly between two rungs resolves to the smaller one.
    expect(normalizeTextSize('19')).toBe(18);
  });
});
