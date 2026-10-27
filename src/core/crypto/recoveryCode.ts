/**
 * Recovery codes.
 *
 * The recovery code is the *entire* account-recovery story. There is no reset
 * link, because a reset link that restored access to notes would mean the
 * server could decrypt them — the backdoor §13 explicitly forbids. Lose both
 * the passphrase and the code and the notes are unrecoverable. The UI has to
 * say that plainly rather than bury it.
 *
 * ## Format
 *
 * 160 bits from `crypto.getRandomValues`, rendered in Crockford base32:
 *
 * ```
 * K7Q4-9XMV-2ZWR-8DHC-6BTN-4YFJ-3GKP-1SAE
 * ```
 *
 * Crockford's alphabet omits I, L, O and U — the characters people misread as
 * 1, 1, 0 and each other — which matters for something a user will write on
 * paper and type back months later. Input is normalised before use, so case,
 * spacing, dashes and the classic O/0 and I/1 confusions all still work.
 */
import { randomBytes } from './bytes.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENTROPY_BYTES = 20; // 160 bits
const GROUP = 4;

/** Characters users commonly substitute, mapped back to the real alphabet. */
const CONFUSABLES: Record<string, string> = {
  O: '0',
  o: '0',
  I: '1',
  i: '1',
  L: '1',
  l: '1',
  U: 'V',
  u: 'V',
};

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh recovery code, already grouped for reading aloud and writing down. */
export function generateRecoveryCode(): string {
  return format(encodeBase32(randomBytes(ENTROPY_BYTES)));
}

export function format(code: string): string {
  const clean = canonicalize(code);
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += GROUP) {
    groups.push(clean.slice(i, i + GROUP));
  }
  return groups.join('-');
}

/**
 * Strip formatting and repair the usual transcription mistakes. This is what
 * the KDF actually consumes, so a code typed as `k7q4 9xmv…` derives the same
 * key as one typed `K7Q4-9XMV-…`.
 */
export function canonicalize(code: string): string {
  let out = '';
  for (const ch of code) {
    if (ch === '-' || ch === ' ' || ch === '\t' || ch === '\n') continue;
    const mapped = CONFUSABLES[ch] ?? ch.toUpperCase();
    out += mapped;
  }
  return out;
}

/** Structural check only — it cannot tell a wrong code from a right one. */
export function looksLikeRecoveryCode(code: string): boolean {
  const clean = canonicalize(code);
  if (clean.length !== Math.ceil((ENTROPY_BYTES * 8) / 5)) return false;
  for (const ch of clean) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}
