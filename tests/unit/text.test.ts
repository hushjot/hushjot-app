import { describe, it, expect } from 'vitest';
import { countWords } from '../../src/core/notes/text.ts';
import { relativeTime } from '../../src/ui/format.ts';

describe('countWords', () => {
  it('counts whitespace-separated runs', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('handles empty and whitespace-only input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('does not double-count runs of whitespace', () => {
    expect(countWords('one   two\n\n\nthree\t\tfour')).toBe(4);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(countWords('  padded  ')).toBe(1);
  });

  it('counts Markdown markup as written', () => {
    // Counting the source, not a stripped render — see the note in text.ts.
    expect(countWords('# Heading')).toBe(2);
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);

  it('says "just now" for the last few seconds', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now');
  });

  it('uses minutes, then hours, then days', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toMatch(/5/);
    expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/3/);
    expect(relativeTime(now - 2 * 86_400_000, now)).toMatch(/2/);
  });

  it('switches to an absolute date beyond a week', () => {
    const out = relativeTime(now - 30 * 86_400_000, now);
    expect(out).not.toMatch(/ago/);
    expect(out).toMatch(/\d/);
  });
});
