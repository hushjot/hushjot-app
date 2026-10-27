/**
 * Byte and encoding helpers shared by the crypto layer.
 *
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, and
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`. Pinning to
 * `ArrayBuffer` keeps every call site assignable without casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function alloc(length: number): Bytes {
  return new Uint8Array(length) as Bytes;
}

/**
 * `crypto.getRandomValues` rejects requests over 65,536 bytes, so fill in
 * chunks. Nothing here asks for more than 32 bytes today, but a caller that
 * eventually does should get random data rather than a QuotaExceededError.
 */
export function randomBytes(length: number): Bytes {
  const out = alloc(length);
  const MAX = 65_536;
  for (let offset = 0; offset < length; offset += MAX) {
    crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + MAX)));
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = alloc(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time comparison. Not strictly required anywhere here — AES-GCM's
 * tag check is already constant-time inside WebCrypto — but any byte
 * comparison we add later should default to this rather than `===`.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// --- base64 ---------------------------------------------------------------
// localStorage holds strings only, so the crash journal needs its ciphertext
// encoded. Chunked to avoid blowing the argument limit on large inputs.

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text);
  const out = alloc(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- base64url ------------------------------------------------------------
// A URL fragment is the one place bytes have to survive being pasted into a
// chat message, and `+` and `/` do not: they are legal in a fragment but chat
// clients, terminals and Markdown autolinkers all treat them as boundaries or
// escape them. RFC 4648 §5's alphabet avoids that, and dropping the `=`
// padding removes the other character that gets percent-encoded on the way.
//
// Only ever applied to fixed-length values (a 16-byte share id, a 32-byte
// key), so the padding is recoverable from the length and nothing has to be
// stored to decode it.

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The inverse. Throws on anything outside the alphabet rather than letting
 * `atob` improvise, so a mangled link fails where it can be reported instead
 * of producing bytes that later fail a GCM tag check and look like a wrong key.
 */
export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return fromBase64(padded);
}
