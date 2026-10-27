/**
 * What a share link actually points at: one sealed blob, and the key that
 * opens it.
 *
 * ## The key is fresh, and it is never the DEK
 *
 * The vault's data key is imported non-extractable (`envelope.ts`,
 * `importKey(raw, false)`), so it could not be put in a URL even if that were
 * wanted — and it must not be, because a link is handed to someone else. Each
 * share mints its own 256-bit key from the same CSPRNG, uses it for one
 * document, and forgets it. A leaked link therefore exposes exactly one
 * snapshot of one note and nothing else: not the vault, not the account, not
 * the other shares.
 *
 * The envelope is the existing one (§33.6 — nothing here invents
 * cryptography), so a share blob is byte-shaped exactly like a note body and
 * the same tag check is what rejects a wrong key.
 *
 * ## Why a snapshot
 *
 * The payload is the note's text as it stood when the link was made. Keeping
 * it live would mean re-sealing on every sync cycle for every shared note —
 * a write per cycle per share — and would publish each keystroke the moment it
 * was typed. Re-publishing is one button and one write.
 */
import { generateDek, exportKey, importKey, sealText, openText } from '../crypto/envelope.ts';
import { fromBase64Url, toBase64Url, type Bytes } from '../crypto/bytes.ts';

export const SHARE_PAYLOAD_VERSION = 1;

/**
 * Matches the rules' `isCiphertext` cap, which is itself under Firestore's
 * 1 MiB per document. Checked here as well so an oversized note gets a
 * sentence rather than an opaque write failure from the backend.
 */
export const MAX_SHARE_BYTES = 900 * 1024;

export interface SharePayload {
  /** Derived from the body, as everywhere else — there is no title field. */
  title: string;
  /** The note's Markdown, which still contains the title line. */
  body: string;
  /** When the note was last edited, for "shared as it stood on …". */
  updatedAt: number;
}

export class ShareTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`a share of ${bytes} bytes exceeds the ${MAX_SHARE_BYTES} byte limit`);
    this.name = 'ShareTooLargeError';
  }
}

export class ShareFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareFormatError';
  }
}

/**
 * A key for exactly one share, and its base64url form for the fragment.
 *
 * The usable copy is re-imported non-extractable, so the only readable form of
 * the key is the string the caller is about to put in a link. The raw bytes are
 * zeroed — best effort, as in `keyRecord.ts`; JavaScript gives no guarantee,
 * but leaving them is worse.
 */
export async function newShareKey(): Promise<{ key: CryptoKey; encoded: string }> {
  const generated = await generateDek(true);
  const raw = await exportKey(generated);
  const encoded = toBase64Url(raw);
  const key = await importKey(raw, false);
  raw.fill(0);
  return { key, encoded };
}

/**
 * The key a link carries, as something `open` can use.
 *
 * `async` so that a mangled fragment rejects rather than throwing
 * synchronously: the viewer has one `catch` for "this link does not work", and
 * a key that is the wrong length must land in it beside a failed fetch.
 */
export async function importShareKey(encoded: string): Promise<CryptoKey> {
  let raw;
  try {
    raw = fromBase64Url(encoded);
  } catch {
    throw new ShareFormatError('share key is not base64url');
  }
  if (raw.length !== 32) throw new ShareFormatError('share key is not 256 bits');
  return importKey(raw, false);
}

export async function sealShare(key: CryptoKey, payload: SharePayload): Promise<Bytes> {
  const sealed = await sealText(
    key,
    JSON.stringify({
      v: SHARE_PAYLOAD_VERSION,
      title: payload.title,
      body: payload.body,
      updatedAt: payload.updatedAt,
    }),
  );
  if (sealed.length > MAX_SHARE_BYTES) throw new ShareTooLargeError(sealed.length);
  return sealed;
}

/**
 * Open a share blob.
 *
 * A wrong key throws `DecryptError` from the envelope, indistinguishably from
 * tampering, as it does everywhere else. `ShareFormatError` means the key was
 * right and the contents were not — which can only be a newer format, so the
 * viewer says so rather than blaming the key.
 */
export async function openShare(key: CryptoKey, sealed: Uint8Array): Promise<SharePayload> {
  const text = await openText(key, sealed);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ShareFormatError('share payload is not JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ShareFormatError('share payload is not an object');
  }
  const value = raw as Record<string, unknown>;
  if (value.v !== SHARE_PAYLOAD_VERSION) {
    throw new ShareFormatError(`unsupported share payload version ${String(value.v)}`);
  }
  if (typeof value.body !== 'string') throw new ShareFormatError('share payload has no body');
  return {
    title: typeof value.title === 'string' ? value.title : '',
    body: value.body,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}
