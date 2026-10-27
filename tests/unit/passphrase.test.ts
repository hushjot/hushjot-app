import { describe, it, expect } from 'vitest';
import {
  generatePassphrase,
  estimateStrength,
  BITS_PER_WORD,
  DEFAULT_WORDS,
} from '../../src/core/crypto/passphrase.ts';
import { WORDS } from '../../src/core/crypto/wordlist.ts';
import { COMMON_PASSWORDS } from '../../src/core/crypto/commonPasswords.ts';

describe('wordlist', () => {
  // Every entropy claim in passphrase.ts and in the UI copy is arithmetic on
  // this number. If the list is ever re-vendored at a different size, the
  // claims become quietly wrong rather than loudly broken.
  it('is exactly 1296 words, so a word is 10.34 bits', () => {
    expect(WORDS).toHaveLength(1296);
    expect(BITS_PER_WORD).toBeCloseTo(10.34, 2);
  });

  it('has no duplicates', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });

  it('is short, lowercase and typeable', () => {
    for (const word of WORDS) {
      expect(word).toMatch(/^[a-z-]{3,6}$/);
    }
  });

  it('ships 1000 common passwords', () => {
    expect(COMMON_PASSWORDS).toHaveLength(1000);
    expect(new Set(COMMON_PASSWORDS).size).toBe(1000);
  });
});

describe('generatePassphrase', () => {
  it('returns the requested number of words, all from the list', async () => {
    const phrase = await generatePassphrase();
    const words = phrase.split(' ');

    expect(words).toHaveLength(DEFAULT_WORDS);
    for (const word of words) expect(WORDS).toContain(word);
  });

  it('does not repeat itself', async () => {
    const phrases = await Promise.all(Array.from({ length: 50 }, () => generatePassphrase()));
    expect(new Set(phrases).size).toBe(50);
  });

  it('reaches the whole list rather than a biased prefix', async () => {
    // The point of the rejection sampling in `randomBelow`. A modulo would
    // skew towards low indices; this checks the tail is reachable at all and
    // that the spread is not concentrated at one end.
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      for (const word of (await generatePassphrase()).split(' ')) seen.add(WORDS.indexOf(word));
    }

    const indices = [...seen];
    expect(indices.length).toBeGreaterThan(1000);
    expect(Math.max(...indices)).toBeGreaterThan(WORDS.length - 50);
    expect(Math.min(...indices)).toBeLessThan(50);
  });

  it('honours a smaller word count', async () => {
    expect((await generatePassphrase(4)).split(' ')).toHaveLength(4);
  });
});

describe('estimateStrength', () => {
  it('rates a generated passphrase strong, at the word model rather than the charset', async () => {
    const strength = await estimateStrength(await generatePassphrase());

    expect(strength.verdict).toBe('strong');
    expect(strength.common).toBe(false);
    // Six words, not thirty-odd characters: ~62 bits, nowhere near the ~140
    // a charset model would have claimed.
    expect(strength.bits).toBeCloseTo(DEFAULT_WORDS * BITS_PER_WORD, 0);
  });

  it('scores a phrase of real words by its words, not its length', async () => {
    const strength = await estimateStrength('correct horse battery staple');

    // 28 characters. The charset model would say 131 bits; four words is 44.
    expect(strength.bits).toBeLessThan(50);
  });

  it('flags a common password with a decoration bolted on', async () => {
    for (const bad of ['password123', 'Monkey1234', 'qwerty2024', 'letmein!!!', 'p4ssword99']) {
      const strength = await estimateStrength(bad);
      expect(strength.common, bad).toBe(true);
      expect(strength.verdict, bad).toBe('common');
    }
  });

  it('flags runs and repeats that the charset model would pass', async () => {
    expect((await estimateStrength('1234567890')).bits).toBeLessThan(10);
    expect((await estimateStrength('abcdefghijk')).bits).toBeLessThan(10);
    expect((await estimateStrength('qwertyuiop')).bits).toBeLessThan(10);
    expect((await estimateStrength('abcabcabcabc')).bits).toBeLessThan(20);
  });

  it('sees through leet substitutions and trailing letters', async () => {
    // The charset model scores this at ~66 bits: ten characters over a pool of
    // 95. Folding `0`->`o` finds `password` inside it, which is the honest read.
    const strength = await estimateStrength('P4ssw0rd!x');

    expect(strength.common).toBe(true);
    expect(strength.bits).toBeLessThan(30);
  });

  it('does not pretend to know a random string is human-chosen', async () => {
    // Ten characters drawn uniformly from 95 really is ~66 bits — marginally
    // more than a six-word phrase — and marking it down would be theatre. The
    // estimator cannot tell this from `Xk9#mQ2vLp` typed by a person, and does
    // not claim to. What the generator wins on is that its 62 bits are real.
    const random = await estimateStrength('Xk9#mQ2vLp');
    const generated = await estimateStrength(await generatePassphrase());

    expect(random.verdict).toBe('strong');
    expect(generated.verdict).toBe('strong');
  });

  it('does not flag an ordinary long passphrase as common', async () => {
    for (const good of ['the quiet harbour at dawn', 'ninety seven purple lanterns']) {
      const strength = await estimateStrength(good);
      expect(strength.common, good).toBe(false);
      expect(strength.verdict, good).not.toBe('common');
    }
  });

  it('reports an empty passphrase as zero rather than throwing', async () => {
    expect(await estimateStrength('')).toEqual({ bits: 0, verdict: 'weak', common: false });
  });
});
