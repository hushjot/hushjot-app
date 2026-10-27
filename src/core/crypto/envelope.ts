/**
 * The versioned authenticated-encryption envelope.
 *
 * AES-256-GCM via WebCrypto — a mature, audited primitive from the platform.
 * Nothing here invents cryptography (§33.6); this module is framing and
 * versioning around `crypto.subtle`.
 *
 * ## Wire format
 *
 * ```
 * [0]      version  (u8)   1 = header-only AAD, 2 = bound to a record
 * [1]      alg id   (u8)   1 = AES-256-GCM
 * [2..14)  nonce    (12 bytes, random per encryption, never reused)
 * [14..]   ciphertext || 16-byte GCM tag
 * ```
 *
 * The version and algorithm bytes are what make a future format change a
 * migration rather than a break (§13). They are also **authenticated**: they
 * are passed to GCM as additional authenticated data, so an attacker cannot
 * strip the header down to a weaker algorithm without the tag check failing.
 *
 * ## Version 2: bound to a record
 *
 * Version 1 authenticated the header and nothing else, so every record sealed
 * under the vault key was interchangeable: a valid body from note A, put in
 * note B's slot by whoever holds the database, decrypted without complaint and
 * showed B with A's text. GCM proves the bytes were not modified; it says
 * nothing about *where* they belong unless it is told.
 *
 * Version 2 tells it. A caller that names a record context (`recordContext`
 * in `binding.ts`: the record kind and its id) gets a version-2 envelope whose AAD is
 * the header followed by that context, so the tag only verifies in the slot it
 * was sealed for. The wire format is otherwise identical — the context is not
 * stored, the opener supplies it — so no blob grows by a byte.
 *
 * Sealing without a context still writes version 1, deliberately. The key
 * record's wraps and a share's payload are each sealed under a key that seals
 * exactly one thing, so there is nothing to swap them with, and changing them
 * would mean migrating key records for no gain.
 *
 * What binding does not cover is **rollback**: an older valid sealing of the
 * *same* record still verifies in that record's slot. Against the server that
 * is the revision compare-and-swap's job, not this module's — see
 * `docs/security.md` § "Encryption envelope".
 *
 * ## The legacy window
 *
 * Vaults created before version 2 hold version-1 records, and so do the
 * server's copies of notes nobody has edited since and the thirty days of
 * history behind them. Opening a version-1 envelope where a context was asked
 * for is therefore still allowed while `ACCEPT_UNBOUND_LEGACY` is true;
 * `repo/migrateToEncrypted.ts` re-seals a device's own records on first unlock.
 * While the window is open, substituting a *version-1* envelope is still
 * possible, which is why closing it is a planned release rather than a hope.
 *
 * ## Nonces
 *
 * A fresh 96-bit random nonce per encryption. GCM fails catastrophically on
 * nonce reuse under the same key, so nonces are never derived from a counter
 * that could restart — for example after a device restore from backup.
 * At 2^32 encryptions the random-collision probability is still around 2^-33;
 * a notepad will not approach that.
 */
import { alloc, randomBytes, utf8, fromUtf8, type Bytes } from './bytes.ts';

/** The unbound format: AAD is the header alone. */
export const ENVELOPE_VERSION = 1;
/** The bound format: AAD is the header followed by the record context. */
export const ENVELOPE_VERSION_BOUND = 2;
export const ALG_AES_256_GCM = 1;

/**
 * Whether a version-1 envelope may be opened where a record context is given.
 * True until every vault has been re-sealed — see "The legacy window" above.
 * Turning it off is a format change: it moves `FORMAT_VERSION`, and the
 * release that does it adds the test that a version-1 record is then refused.
 * A constant rather than an option on `open` so the build folds the branch
 * away: the share viewer's budget has no bytes to spare for an unused path.
 */
export const ACCEPT_UNBOUND_LEGACY = true;


const NONCE_BYTES = 12;
const TAG_BITS = 128;
const HEADER_BYTES = 2 + NONCE_BYTES;

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

/** Generate a fresh 256-bit data-encryption key. */
export function generateDek(extractable = true): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Import raw key bytes. `extractable: false` produces a key JavaScript can use
 * but cannot read — the form the device-unlock key is stored in.
 *
 * Takes `Bytes` rather than `BufferSource`, which is what every caller passes
 * anyway. The wider DOM type is deliberately kept out of the signature:
 * it is a type *alias*, so unlike an interface it cannot be re-declared for a
 * consumer of `@hushjot/core` that has no DOM lib, and a Node CLI should not
 * have to pull in `lib.dom` to name an argument.
 */
export function importKey(raw: Bytes, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);
}

export async function exportKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key)) as Bytes;
}

/** The header doubles as additional authenticated data. */
function header(version: number): Bytes {
  const h = alloc(2);
  h[0] = version;
  h[1] = ALG_AES_256_GCM;
  return h;
}

/** The header, followed by the record context when there is one. */
function aadFor(head: Uint8Array, context: string | undefined): Bytes {
  if (context === undefined) return head as Bytes;
  const ctx = utf8(context);
  const out = alloc(head.length + ctx.length);
  out.set(head, 0);
  out.set(ctx, head.length);
  return out;
}

/**
 * Seal `plaintext`. With a `context` the envelope is version 2 and opens only
 * under that same context; without one it is version 1.
 */
export async function seal(key: CryptoKey, plaintext: Uint8Array, context?: string): Promise<Bytes> {
  const head = header(context === undefined ? ENVELOPE_VERSION : ENVELOPE_VERSION_BOUND);
  const nonce = randomBytes(NONCE_BYTES);

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aadFor(head, context), tagLength: TAG_BITS },
      key,
      plaintext as BufferSource,
    ),
  );

  const out = alloc(HEADER_BYTES + ct.length);
  out.set(head, 0);
  out.set(nonce, 2);
  out.set(ct, HEADER_BYTES);
  return out;
}

/**
 * Open an envelope. Pass the same `context` it was sealed under: a version-2
 * envelope refuses to open without it, and a version-1 envelope opened with
 * one is accepted only while the legacy window is open.
 */
export async function open(key: CryptoKey, envelope: Uint8Array, context?: string): Promise<Bytes> {
  if (envelope.length < HEADER_BYTES + TAG_BITS / 8) {
    throw new DecryptError('envelope too short');
  }

  const version = envelope[0]!;
  const alg = envelope[1]!;
  const bound = version === ENVELOPE_VERSION_BOUND;
  if (!bound && version !== ENVELOPE_VERSION) {
    throw new DecryptError(`unsupported envelope version ${version}`);
  }
  if (alg !== ALG_AES_256_GCM) {
    throw new DecryptError(`unsupported algorithm ${alg}`);
  }
  // A bound envelope needs its context. An unbound one opened under a context
  // is accepted only while the legacy window is open. Either way it is the
  // same error as a failed tag: a record in the wrong slot should look exactly
  // like a tampered one. (Terse on purpose: this function is on the share
  // viewer's 57 KB critical path.)
  if (bound ? context === undefined : context !== undefined && !ACCEPT_UNBOUND_LEGACY) {
    throw new DecryptError('authentication failed');
  }

  // A version-1 envelope was sealed with the header alone, whatever the caller
  // now expects of it.
  const aad = aadFor(envelope.subarray(0, 2), bound ? context : undefined);
  const nonce = envelope.subarray(2, HEADER_BYTES) as Bytes;
  const ct = envelope.subarray(HEADER_BYTES) as Bytes;

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BITS },
      key,
      ct as BufferSource,
    );
    return new Uint8Array(plain) as Bytes;
  } catch {
    // WebCrypto deliberately gives no detail on why authentication failed, and
    // neither do we: a wrong key, a tampered payload and a record in the wrong
    // slot must look identical.
    throw new DecryptError('authentication failed');
  }
}

export async function sealText(key: CryptoKey, text: string, context?: string): Promise<Bytes> {
  return seal(key, utf8(text), context);
}

export async function openText(key: CryptoKey, envelope: Uint8Array, context?: string): Promise<string> {
  return fromUtf8(await open(key, envelope, context));
}
