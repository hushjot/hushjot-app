/**
 * The key record: how a passphrase and a recovery code each reach the same
 * data-encryption key.
 *
 * ```
 * DEK  = crypto.getRandomValues(32)          random, never derived
 *
 * passphrase ──Argon2id(salt_p)──► KEK_p ──► wrap(DEK)  ─┐
 *                                                        ├─► same DEK
 * recovery   ──HKDF(salt_r)─────► KEK_r ──► wrap(DEK)  ─┘
 * ```
 *
 * The DEK is random rather than derived from the passphrase. That is what makes
 * a passphrase *change* cheap: re-wrap one 32-byte key instead of re-encrypting
 * every note. It is also what lets two independent secrets open the same vault
 * without either knowing about the other.
 *
 * The record contains only ciphertext, salts and parameters. Everything in it
 * can be stored on a server the user does not trust — which is exactly what
 * Phase 4 will do with it.
 *
 * There is no verifier field: AES-GCM's authentication tag already fails on the
 * wrong key, so a failed unwrap *is* the wrong-passphrase signal. Adding a
 * separate verifier would hand an offline attacker a cheaper oracle than the
 * real one.
 */
import { generateDek, seal, open, exportKey, importKey, DecryptError } from './envelope.ts';
import {
  DEFAULT_ARGON2_PARAMS,
  deriveKekFromPassphrase,
  deriveKekFromRecoveryCode,
  type Argon2Params,
} from './kdf.ts';
import { randomBytes, toBase64, fromBase64, type Bytes } from './bytes.ts';

export const KEY_RECORD_VERSION = 1;
const SALT_BYTES = 32;

export interface KeyRecord {
  version: number;
  /** Argon2id parameters and salt for the passphrase path. */
  passphrase: Argon2Params & { salt: Bytes };
  /** HKDF salt for the recovery-code path. */
  recovery: { name: string; salt: Bytes };
  /** DEK sealed under the passphrase-derived KEK. */
  wrappedByPassphrase: Bytes;
  /** DEK sealed under the recovery-code-derived KEK. */
  wrappedByRecovery: Bytes;
  createdAt: number;
}

export class WrongSecretError extends Error {
  constructor() {
    super('The passphrase or recovery code is incorrect.');
    this.name = 'WrongSecretError';
  }
}

export interface CreatedVault {
  record: KeyRecord;
  dek: CryptoKey;
}

/**
 * Create a brand new vault. Returns the record to persist and the unwrapped
 * DEK, so the caller does not have to immediately unlock what it just created.
 */
export async function createKeyRecord(
  passphrase: string,
  recoveryCode: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
  now = Date.now(),
): Promise<CreatedVault> {
  const passphraseSalt = randomBytes(SALT_BYTES);
  const recoverySalt = randomBytes(SALT_BYTES);

  // Extractable only long enough to wrap it twice; the copy handed back to the
  // caller is re-imported as non-extractable below.
  const dek = await generateDek(true);
  const raw = await exportKey(dek);

  const [kekPassphrase, kekRecovery] = await Promise.all([
    deriveKekFromPassphrase(passphrase, passphraseSalt, params).then((d) => d.key),
    deriveKekFromRecoveryCode(recoveryCode, recoverySalt),
  ]);

  const [wrappedByPassphrase, wrappedByRecovery] = await Promise.all([
    seal(kekPassphrase, raw),
    seal(kekRecovery, raw),
  ]);

  const record: KeyRecord = {
    version: KEY_RECORD_VERSION,
    passphrase: { ...params, salt: passphraseSalt },
    recovery: { name: 'HKDF-SHA256', salt: recoverySalt },
    wrappedByPassphrase,
    wrappedByRecovery,
    createdAt: now,
  };

  const usable = await importKey(raw, false);
  raw.fill(0); // best effort; JS gives no guarantee, but leaving it is worse
  return { record, dek: usable };
}

export async function unlockWithPassphrase(
  record: KeyRecord,
  passphrase: string,
): Promise<CryptoKey> {
  const raw = await unwrapWithPassphrase(record, passphrase);
  const key = await importKey(raw, false);
  raw.fill(0);
  return key;
}

export async function unlockWithRecoveryCode(
  record: KeyRecord,
  recoveryCode: string,
): Promise<CryptoKey> {
  const raw = await unwrapWithRecoveryCode(record, recoveryCode);
  const key = await importKey(raw, false);
  raw.fill(0);
  return key;
}

/**
 * Change the passphrase by re-wrapping the same DEK under a new KEK.
 *
 * The notes are untouched: nothing is re-encrypted, and the recovery code keeps
 * working because its wrapped copy is independent.
 */
export async function changePassphrase(
  record: KeyRecord,
  currentPassphrase: string,
  newPassphrase: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<KeyRecord> {
  const raw = await unwrapWithPassphrase(record, currentPassphrase);

  const salt = randomBytes(SALT_BYTES);
  const { key } = await deriveKekFromPassphrase(newPassphrase, salt, params);
  const wrappedByPassphrase = await seal(key, raw);
  raw.fill(0);

  return { ...record, passphrase: { ...params, salt }, wrappedByPassphrase };
}

/**
 * Issue a new recovery code, invalidating the old one. Also the repair path
 * for "I still have my passphrase but lost the paper".
 */
export async function rotateRecoveryCode(
  record: KeyRecord,
  passphrase: string,
  newRecoveryCode: string,
): Promise<KeyRecord> {
  const raw = await unwrapWithPassphrase(record, passphrase);

  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKekFromRecoveryCode(newRecoveryCode, salt);
  const wrappedByRecovery = await seal(kek, raw);
  raw.fill(0);

  return { ...record, recovery: { name: 'HKDF-SHA256', salt }, wrappedByRecovery };
}

/**
 * Set a new passphrase using the recovery code as the authenticating secret.
 *
 * The flow `docs/security.md` has promised since Phase 3 — "lost the
 * passphrase, have the code" — and the one `changePassphrase` above cannot
 * serve, because it asks for the very thing this user does not have. Unlocking
 * with the code is not enough on its own: the key that comes back is imported
 * non-extractable, precisely so nothing can read its bytes out, so a re-wrap
 * has to go back to a secret and unwrap again.
 *
 * It touches the passphrase half and nothing else. Carrying `recovery.salt`
 * and `wrappedByRecovery` through untouched is deliberate: the code is the
 * only secret this user has demonstrably still got, and invalidating it in the
 * same act that mints a passphrase they have not yet proved they can retype
 * would leave them with nothing. Re-issuing is a separate, later step —
 * `rotateRecoveryCode` above, which the new passphrase now authenticates.
 */
export async function setPassphraseWithRecoveryCode(
  record: KeyRecord,
  recoveryCode: string,
  newPassphrase: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<KeyRecord> {
  const raw = await unwrapWithRecoveryCode(record, recoveryCode);

  const salt = randomBytes(SALT_BYTES);
  const { key } = await deriveKekFromPassphrase(newPassphrase, salt, params);
  const wrappedByPassphrase = await seal(key, raw);
  raw.fill(0);

  return { ...record, passphrase: { ...params, salt }, wrappedByPassphrase };
}

/**
 * Unwrap to raw bytes.
 *
 * Callers that only need to *use* the key immediately import it as
 * non-extractable and zero these bytes; the re-wrapping flows need the raw
 * material itself, which is why this returns bytes rather than a CryptoKey.
 */
async function unwrapRaw(kek: CryptoKey, wrapped: Bytes): Promise<Bytes> {
  try {
    return await open(kek, wrapped);
  } catch (error) {
    // A failed tag check means the wrong secret — or a corrupted record. The
    // user-facing distinction is not ours to guess.
    if (error instanceof DecryptError) throw new WrongSecretError();
    throw error;
  }
}

async function unwrapWithPassphrase(record: KeyRecord, passphrase: string): Promise<Bytes> {
  assertVersion(record);
  const { key } = await deriveKekFromPassphrase(
    passphrase,
    record.passphrase.salt,
    record.passphrase,
  );
  return unwrapRaw(key, record.wrappedByPassphrase);
}

async function unwrapWithRecoveryCode(record: KeyRecord, recoveryCode: string): Promise<Bytes> {
  assertVersion(record);
  const kek = await deriveKekFromRecoveryCode(recoveryCode, record.recovery.salt);
  return unwrapRaw(kek, record.wrappedByRecovery);
}

function assertVersion(record: KeyRecord): void {
  if (record.version !== KEY_RECORD_VERSION) {
    throw new Error(`unsupported key record version ${record.version}`);
  }
}

// --- portable serialisation ------------------------------------------------

/**
 * The key record has to survive a round trip through a backend that may not
 * have a byte type, so its salts and wrapped keys are base64 here.
 *
 * Note payloads deliberately do *not* do this — they use a native byte type,
 * because base64 would cost a third of Firestore's per-document budget. The
 * key record is a couple of hundred bytes, so portability wins over density.
 */
export interface SerializedKeyRecord {
  version: number;
  passphrase: { name: string; memoryKiB: number; iterations: number; parallelism: number; salt: string };
  recovery: { name: string; salt: string };
  wrappedByPassphrase: string;
  wrappedByRecovery: string;
  createdAt: number;
}

export function serializeKeyRecord(record: KeyRecord): SerializedKeyRecord {
  return {
    version: record.version,
    passphrase: {
      name: record.passphrase.name,
      memoryKiB: record.passphrase.memoryKiB,
      iterations: record.passphrase.iterations,
      parallelism: record.passphrase.parallelism,
      salt: toBase64(record.passphrase.salt),
    },
    recovery: { name: record.recovery.name, salt: toBase64(record.recovery.salt) },
    wrappedByPassphrase: toBase64(record.wrappedByPassphrase),
    wrappedByRecovery: toBase64(record.wrappedByRecovery),
    createdAt: record.createdAt,
  };
}

export function deserializeKeyRecord(value: unknown): KeyRecord {
  const raw = value as SerializedKeyRecord;
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'number') {
    throw new Error('malformed key record');
  }
  return {
    version: raw.version,
    passphrase: {
      name: raw.passphrase.name,
      memoryKiB: raw.passphrase.memoryKiB,
      iterations: raw.passphrase.iterations,
      parallelism: raw.passphrase.parallelism,
      salt: fromBase64(raw.passphrase.salt),
    },
    recovery: { name: raw.recovery.name, salt: fromBase64(raw.recovery.salt) },
    wrappedByPassphrase: fromBase64(raw.wrappedByPassphrase),
    wrappedByRecovery: fromBase64(raw.wrappedByRecovery),
    createdAt: raw.createdAt,
  };
}

/**
 * Whether two serialized key records are the same record.
 *
 * Narrow on purpose. A key record carries no identifier, so this can never
 * prove that two *different* records wrap the same DEK — `changePassphrase`
 * re-randomises the salts for an unchanged key, and a successful unwrap shows
 * only that the secret matched. What it can prove is the other direction:
 * identical bytes are identical bytes, so `true` here means one record that
 * two places happen to hold. Callers must treat `false` as "cannot tell",
 * never as "different vault" — see `core/sync/backfill.ts`.
 *
 * Field by field rather than `JSON.stringify`: the remote copy has been
 * through Firestore as a map, and nothing guarantees it comes back with its
 * keys in the order `serializeKeyRecord` wrote them.
 */
export function sameKeyRecord(a: unknown, b: unknown): boolean {
  if (!isSerializedKeyRecord(a) || !isSerializedKeyRecord(b)) return false;
  return (
    a.version === b.version &&
    a.createdAt === b.createdAt &&
    a.wrappedByPassphrase === b.wrappedByPassphrase &&
    a.wrappedByRecovery === b.wrappedByRecovery &&
    a.passphrase.name === b.passphrase.name &&
    a.passphrase.salt === b.passphrase.salt &&
    a.passphrase.memoryKiB === b.passphrase.memoryKiB &&
    a.passphrase.iterations === b.passphrase.iterations &&
    a.passphrase.parallelism === b.passphrase.parallelism &&
    a.recovery.name === b.recovery.name &&
    a.recovery.salt === b.recovery.salt
  );
}

/**
 * Whether two serialized key records are demonstrably *different vaults*.
 *
 * The one inequality that can be shown, and only because of how `createdAt`
 * is handled: it is stamped once, by `createKeyRecord`, and every re-wrap —
 * `changePassphrase`, `rotateRecoveryCode`, `setPassphraseWithRecoveryCode` —
 * carries it through with `...record`. So two records with different stamps
 * were minted by two `createKeyRecord` calls, with two random DEKs. The
 * converse does not hold (equal stamps prove nothing), which is why this is a
 * separate question from `sameKeyRecord` and not its negation.
 *
 * Asked by exactly one caller: a device bound to the account's vault, checking
 * whether the account has since been reset and given a new one
 * (`accountResetElsewhere` in `core/sync/backfill.ts`). False for anything it
 * cannot read, like `sameKeyRecord`, because one side comes off the network.
 */
export function differentVaults(a: unknown, b: unknown): boolean {
  if (!isSerializedKeyRecord(a) || !isSerializedKeyRecord(b)) return false;
  return a.createdAt !== b.createdAt;
}

/**
 * A structural check, not a validation: `sameKeyRecord` must answer `false`
 * for anything it cannot read rather than throw, because one of its two
 * arguments comes off the network.
 */
function isSerializedKeyRecord(value: unknown): value is SerializedKeyRecord {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<SerializedKeyRecord>;
  return (
    typeof raw.version === 'number' &&
    typeof raw.createdAt === 'number' &&
    typeof raw.wrappedByPassphrase === 'string' &&
    typeof raw.wrappedByRecovery === 'string' &&
    typeof raw.passphrase?.salt === 'string' &&
    typeof raw.recovery?.salt === 'string'
  );
}
