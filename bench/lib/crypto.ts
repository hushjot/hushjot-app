/**
 * Prototype of the versioned encryption envelope, used by spikes 3 and 4 so the
 * benchmarks measure the real cost of the design rather than a stand-in.
 *
 * Binary layout (no base64 anywhere — see plan issue #4):
 *   [0]      version  (u8)
 *   [1]      alg id   (u8)   1 = AES-256-GCM
 *   [2..14)  nonce    (12 bytes, random per encryption, never reused)
 *   [14..]   ciphertext || GCM tag
 */

export const ENVELOPE_VERSION = 1;
export const ALG_AES_256_GCM = 1;
const NONCE_BYTES = 12;
const HEADER_BYTES = 2 + NONCE_BYTES;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** Import raw key bytes as a non-extractable CryptoKey (the device-unlock shape). */
export async function importDek(raw: BufferSource, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);
}

/**
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, and
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`. Pinning the
 * parameter to `ArrayBuffer` keeps every call site assignable.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export async function encryptEnvelope(key: CryptoKey, plaintext: string): Promise<Bytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)) as Bytes;
  const data = encoder.encode(plaintext) as Bytes;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data),
  );

  const out = new Uint8Array(HEADER_BYTES + ct.length) as Bytes;
  out[0] = ENVELOPE_VERSION;
  out[1] = ALG_AES_256_GCM;
  out.set(nonce, 2);
  out.set(ct, HEADER_BYTES);
  return out;
}

export async function decryptEnvelope(key: CryptoKey, envelope: Bytes): Promise<string> {
  const version = envelope[0];
  const alg = envelope[1];
  if (version !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${version}`);
  if (alg !== ALG_AES_256_GCM) throw new Error(`unsupported alg ${alg}`);

  const nonce = envelope.subarray(2, HEADER_BYTES);
  const ct = envelope.subarray(HEADER_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return decoder.decode(pt);
}

/** The meta/body split from plan issue #3. */
export interface NoteMeta {
  t: string; // title
  f: string | null; // folderId
  u: number; // updatedAt
}

export const encodeMeta = (m: NoteMeta): string => JSON.stringify(m);
export const decodeMeta = (s: string): NoteMeta => JSON.parse(s) as NoteMeta;
