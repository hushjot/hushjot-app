import { describe, expect, it } from 'vitest';
import { diffLines, diffTexts, splitLines } from '../../src/core/history/diff.ts';

/** Rebuild both sides from an edit script. */
function sides(lines: NonNullable<ReturnType<typeof diffLines>>): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (line.kind !== 'added') before.push(line.text);
    if (line.kind !== 'removed') after.push(line.text);
  }
  return { before, after };
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('diffLines', () => {
  it('reproduces both inputs for random edits', () => {
    const random = seeded(7);
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
      const b = a.filter(() => random() > 0.25);
      for (let i = 0; i < 5; i++) b.splice(Math.floor(random() * (b.length + 1)), 0, String(Math.floor(random() * 6)));
      const script = diffLines(a, b, 1_000)!;
      expect(sides(script)).toEqual({ before: a, after: b });
    }
  });

  it('finds a minimal script for a single changed line', () => {
    const script = diffLines(['a', 'b', 'c'], ['a', 'x', 'c'], 100)!;
    expect(script.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'removed', text: 'b', oldLine: 2 },
      { kind: 'added', text: 'x', newLine: 2 },
    ]);
  });

  it('handles empty sides', () => {
    expect(sides(diffLines([], ['a', 'b'], 10)!)).toEqual({ before: [], after: ['a', 'b'] });
    expect(sides(diffLines(['a'], [], 10)!)).toEqual({ before: ['a'], after: [] });
    expect(diffLines([], [], 10)).toEqual([]);
  });

  it('gives up past the edit budget', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 20)).toBeNull();
  });
});

describe('diffTexts', () => {
  it('reports identical text', () => {
    expect(diffTexts('same', 'same')).toEqual({ kind: 'identical' });
    expect(diffTexts('a\r\nb', 'a\nb')).toEqual({ kind: 'identical' });
  });

  it('groups changes into hunks with context, and counts lines', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'line five').replace('line 30', 'line thirty\nplus one');
    const result = diffTexts(before, after);
    if (result.kind !== 'changes') throw new Error(result.kind);
    expect(result.hunks).toHaveLength(2);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.hunks[0]!.lines[0]).toMatchObject({ kind: 'same', text: 'line 2' });
  });

  it('keeps emoji and non-Latin text intact', () => {
    const result = diffTexts('日本語\n🙂', '日本語\n🙃');
    if (result.kind !== 'changes') throw new Error(result.kind);
    expect(result.hunks[0]!.lines.map((l) => l.text)).toEqual(['日本語', '🙂', '🙃']);
  });

  it('refuses inputs over the line cap', () => {
    expect(diffTexts('a\nb\nc', 'a\nb', { maxLines: 2 })).toEqual({ kind: 'too-large' });
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
  });
});
