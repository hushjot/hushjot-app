/**
 * A note version: a copy of the note's stored ciphertext, taken just before
 * something replaced it.
 *
 * ## Copied, never re-sealed
 *
 * A version holds the exact meta and body bytes the note database held. Taking
 * one needs no key, no decrypt and no encrypt, so a snapshot costs a read and
 * a put — nothing on it scales with the note's length except the bytes moved.
 * It also means a version can be taken while the vault is locked.
 *
 * ## The id is the body's nonce
 *
 * Every seal draws a fresh 96-bit random nonce (`core/crypto/envelope.ts`), so
 * the nonce names one particular sealing of one particular text. Two tabs, or
 * later two devices, capturing the same stored row therefore produce the same
 * id and collapse to one record without anyone reading the plaintext. The nonce
 * is already stored in the clear inside the envelope, so using it as a key
 * reveals nothing the ciphertext did not.
 */

/** Why the version was taken. Shown to the user for everything but `edit`. */
export type VersionReason = 'edit' | 'delete' | 'restore';

/**
 * Where the record stands relative to the backend. Phase A never leaves
 * `local`; the other states belong to sync, and exist here so the record does
 * not need a migration when it arrives.
 */
export type VersionState = 'queued' | 'pushed' | 'remote' | 'local';

export interface VersionRecord {
  /** `${noteId}:${sealId}` — unique per stored sealing of one note. */
  id: string;
  noteId: string;
  sealId: string;
  /** The stored note's `updatedAt`: when this text was last current. */
  at: number;
  /** When this device took the copy. Drives retention tiers. */
  capturedAt: number;
  expireAt: number;
  reason: VersionReason;
  /** Sealed `{ title, folderId, pinnedAt }`, byte for byte as the note database held it. */
  meta: Uint8Array;
  /** Sealed body, byte for byte. */
  body: Uint8Array;
  /** `meta.length + body.length`, so pruning can budget without loading either. */
  bytes: number;
  state: VersionState;
}

/** Envelope layout: `[version][alg][12-byte nonce][ciphertext || tag]`. */
const NONCE_START = 2;
const NONCE_END = 14;
/** Header plus GCM tag: the sealed size of an empty string. */
export const EMPTY_SEAL_BYTES = 30;

/** The body's nonce as 24 hex characters, or null for something that is not an envelope. */
export function sealIdOf(body: Uint8Array): string | null {
  if (body.length < EMPTY_SEAL_BYTES) return null;
  let out = '';
  for (let i = NONCE_START; i < NONCE_END; i++) out += body[i]!.toString(16).padStart(2, '0');
  return out;
}

export function versionId(noteId: string, sealId: string): string {
  return `${noteId}:${sealId}`;
}

/** The note id half of a version id. Note ids never contain `:`. */
export function noteIdOf(versionId: string): string {
  return versionId.slice(0, versionId.lastIndexOf(':'));
}
