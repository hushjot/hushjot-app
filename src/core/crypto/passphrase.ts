/**
 * Passphrase generation and strength estimation.
 *
 * Argon2id at m=64 MiB buys roughly 15-17 bits against offline guessing. That
 * is a multiplier on the passphrase, not a substitute for one — a ten-character
 * human choice can be worth less than the KDF adds, which is why
 * `docs/security.md` lists "a weak passphrase" under *not defended*. This
 * module is the other half of that trade, and tuning the KDF without it would
 * be sharpening the stronger blade.
 *
 * Two exports, and the first matters far more than the second.
 * `generatePassphrase` removes the choice: six words from a 1296-word list is
 * ~62 bits, and no amount of parameter tuning can argue its way into or out of
 * that. `estimateStrength` exists for the user who declines, and its only jobs
 * are to catch `password123` and to make the generator look like the easier
 * option.
 *
 * ## The estimate is a floor, not a score
 *
 * Several models run and the **lowest** one wins, because a real attacker also
 * gets to pick their best model. "correct horse battery staple" is 28
 * characters, which a charset model happily scores at 131 bits; the word model
 * scores it at 44, and 44 is the honest number. Nothing here is calibrated well
 * enough to be quoted as a crack time, so it reports bits and a verdict and
 * says plainly that it is a floor.
 *
 * `zxcvbn` estimates better. It is also ~800 KB to tell a user something they
 * can fix in one click on the generator, which is the wrong trade under §28 —
 * the same reasoning that left the search index and the service worker
 * hand-written.
 *
 * Both wordlists are behind `import()`. Nothing here is reachable from the
 * unlock path, and `bench:size` fails if any of it becomes eager.
 */

/** The wordlist length, asserted in `tests/unit/passphrase.test.ts`. */
const WORDLIST_SIZE = 1296;
const COMMON_SIZE = 1000;

/** 1296 is 6^4, so each word is exactly 10.34 bits. */
export const BITS_PER_WORD = Math.log2(WORDLIST_SIZE);

/** Six words, ~62 bits. Five would be ~52, which is within reach of a funded
 *  offline attack even at 64 MiB; seven is harder to retype for no real gain. */
export const DEFAULT_WORDS = 6;

/** Below this a passphrase is reported as weak; at or above STRONG_BITS, strong. */
const WEAK_BITS = 40;
const STRONG_BITS = 60;

export type Verdict = 'common' | 'weak' | 'fair' | 'strong';

export interface Strength {
  /** A conservative floor in bits. Never an upper bound. */
  bits: number;
  verdict: Verdict;
  /** The passphrase reduces to a well-known password plus a decoration. */
  common: boolean;
}

interface Lists {
  words: readonly string[];
  wordSet: ReadonlySet<string>;
  common: ReadonlySet<string>;
}

let listsPromise: Promise<Lists> | undefined;

/**
 * Both lists, loaded once and cached. Dynamic import: ~17 KB of static data
 * that must not land in the critical path, and that most users never reach
 * because they are unlocking rather than creating.
 */
function loadLists(): Promise<Lists> {
  listsPromise ??= Promise.all([import('./wordlist.ts'), import('./commonPasswords.ts')]).then(
    ([words, common]) => ({
      words: words.WORDS,
      wordSet: new Set(words.WORDS),
      common: new Set(common.COMMON_PASSWORDS),
    }),
  );
  return listsPromise;
}

/**
 * A machine-chosen passphrase. The words are the encoding, not the entropy —
 * the same split `recoveryCode.ts` makes between 160 random bits and the
 * Crockford base32 a human actually copies down.
 */
export async function generatePassphrase(words = DEFAULT_WORDS): Promise<string> {
  const { words: list } = await loadLists();
  const picked: string[] = [];
  for (let i = 0; i < words; i++) picked.push(list[randomBelow(list.length)]!);
  return picked.join(' ');
}

/** A conservative floor on how much guessing this passphrase would cost. */
export async function estimateStrength(passphrase: string): Promise<Strength> {
  const lists = await loadLists();
  if (passphrase === '') return { bits: 0, verdict: 'weak', common: false };

  const common = commonBits(passphrase, lists.common);
  const bits = Math.min(
    charsetBits(passphrase),
    repeatBits(passphrase),
    runBits(passphrase),
    wordBits(passphrase, lists.wordSet),
    common ?? Infinity,
  );

  return { bits: round(bits), verdict: verdictFor(bits, common !== null), common: common !== null };
}

function verdictFor(bits: number, common: boolean): Verdict {
  if (bits >= STRONG_BITS) return 'strong';
  if (common) return 'common';
  if (bits < WEAK_BITS) return 'weak';
  return 'fair';
}

/**
 * A uniform integer in `[0, bound)`.
 *
 * Rejection sampling rather than `% bound`: 2^32 is not a multiple of 1296, so
 * the modulo would leave the first 448 words very slightly likelier than the
 * rest. The bias is far too small to matter and exactly the kind of thing
 * nobody ever finds afterwards, so it is simply never introduced.
 */
function randomBelow(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % bound;
  }
}

// --- models ----------------------------------------------------------------
//
// Each returns a bit count, or Infinity when it does not apply. `estimateStrength`
// takes the minimum, so a model that does not fit simply abstains.

/** The naive model: every character an independent draw from its pool. */
function charsetBits(s: string): number {
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 33;
  return pool === 0 ? 0 : s.length * Math.log2(pool);
}

/** "abcabcabcabc" is three characters of choice and a repeat count, not twelve. */
function repeatBits(s: string): number {
  for (let unit = 1; unit <= s.length / 2; unit++) {
    if (s.length % unit !== 0) continue;
    const head = s.slice(0, unit);
    if (head.repeat(s.length / unit) === s) return charsetBits(head) + Math.log2(s.length / unit);
  }
  return Infinity;
}

/**
 * Keyboard and alphabet runs. `1234567890` scores 33 bits under the charset
 * model and is worth nothing at all; it is not on the common-password list
 * because that list is dominated by shorter entries.
 */
const RUNS = ['01234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function runBits(s: string): number {
  if (s.length < 4) return Infinity;
  const lower = s.toLowerCase();
  const reversed = [...lower].reverse().join('');
  const hit = RUNS.some((run) => run.includes(lower) || run.includes(reversed));
  // Which run, where it started, and which direction — a handful of bits.
  return hit ? Math.log2(RUNS.join('').length * 2) : Infinity;
}

/** An attacker's phrase dictionary, assumed generously small at ~2048 words. */
const GENERIC_WORD_BITS = 11;

/**
 * Words, not characters. This is the model that keeps a long phrase honest:
 * without it, any passphrase of real words is credited for its length rather
 * than for the much smaller number of choices that produced it.
 */
function wordBits(s: string, wordSet: ReadonlySet<string>): number {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < 2) return Infinity;
  // Digits or symbols in a token mean this is not a phrase; let charset judge it.
  if (!tokens.every((t) => /^[a-zA-Z'’-]+$/.test(t))) return Infinity;

  const fromList = tokens.every((t) => wordSet.has(t.toLowerCase()));
  return tokens.length * (fromList ? BITS_PER_WORD : GENERIC_WORD_BITS);
}

/** Substitutions people reach for, folded back before the lookup. */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/** Decoration around a known word is worth far less per character than a random draw. */
const DECORATION_BITS_PER_CHAR = 3.5;

/** The match has to account for at least this much of the string to count. */
const DOMINANT_FRACTION = 0.5;

/**
 * The common-password model, and the only one that can block a submission.
 *
 * Exact matching would be nearly useless at a ten-character minimum — only 51
 * of the top ten thousand leaked passwords are that long. What people actually
 * type is a short common word wearing a decoration: `password123`, `Monkey!!`,
 * `P4ssw0rd!x`. So this folds the obvious substitutions, finds the longest
 * known password *inside* the result, and charges only for the leftovers.
 *
 * The match must still dominate the string. Without that floor the model fires
 * on any long phrase that happens to contain a short common word, which would
 * block good passphrases — a far worse failure than missing a bad one.
 *
 * `null` is an abstention, not a clean bill of health.
 */
function commonBits(s: string, common: ReadonlySet<string>): number | null {
  const lower = s.toLowerCase();
  if (common.has(lower)) return Math.log2(COMMON_SIZE);

  const folded = lower.replace(/[013457@$]/g, (c) => LEET[c] ?? c);

  let match = '';
  for (const candidate of common) {
    if (candidate.length < 4 || candidate.length <= match.length) continue;
    if (folded.includes(candidate)) match = candidate;
  }
  if (match.length < folded.length * DOMINANT_FRACTION) return null;

  // Which entry it was, where in the string it sat, and whatever was typed
  // around it.
  const decoration = folded.length - match.length;
  return (
    Math.log2(COMMON_SIZE) + Math.log2(folded.length) + decoration * DECORATION_BITS_PER_CHAR
  );
}

const round = (bits: number): number => Math.round(bits * 10) / 10;
