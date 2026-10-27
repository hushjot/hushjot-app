import { describe, it, expect } from 'vitest';
import { planReplay, type JournalEntry } from '../../src/core/repo/journal.ts';

import { randomBytes } from '../../src/core/crypto/bytes.ts';

// The journal stores ciphertext; planReplay never looks inside it, so an
// opaque blob is exactly the right fixture here.
const entry = (id: string, revision: number): JournalEntry => ({
  id,
  revision,
  updatedAt: 1000,
  cipher: randomBytes(48),
});

describe('planReplay', () => {
  it('restores an entry whose write never landed', () => {
    const { restore } = planReplay([entry('a', 5)], new Map([['a', 4]]));
    expect(restore.map((e) => e.id)).toEqual(['a']);
  });

  it('ignores an entry the database already has', () => {
    const { restore, skipped } = planReplay([entry('a', 4)], new Map([['a', 4]]));
    expect(restore).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('never overwrites a newer database record', () => {
    // The write did land, and the user edited again elsewhere. The journal is
    // stale and must lose.
    const { restore } = planReplay([entry('a', 3)], new Map([['a', 7]]));
    expect(restore).toEqual([]);
  });

  it('never resurrects a deleted note', () => {
    // The id is absent from the database, so the user deleted it. A journal
    // entry bringing it back would be the app overruling the user.
    const { restore, skipped } = planReplay([entry('gone', 99)], new Map());
    expect(restore).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('handles an empty journal', () => {
    expect(planReplay([], new Map([['a', 1]]))).toEqual({ restore: [], skipped: 0 });
  });

  it('decides each entry independently', () => {
    const { restore } = planReplay(
      [entry('keep', 9), entry('stale', 1), entry('deleted', 9)],
      new Map([
        ['keep', 8],
        ['stale', 4],
      ]),
    );
    expect(restore.map((e) => e.id)).toEqual(['keep']);
  });
});
