/**
 * Key derivation.
 *
 * Two derivations, deliberately different, because the inputs are different:
 *
 * - **Passphrase → KEK: Argon2id.** A human-chosen passphrase has low entropy,
 *   so the derivation must be expensive to make guessing expensive. Memory-hard
 *   specifically, to deny an attacker the GPU/ASIC advantage.
 *
 * - **Recovery code → KEK: HKDF-SHA-256.** The recovery code is 160 bits from
 *   a CSPRNG. Stretching it buys nothing — there is no dictionary to guess
 *   against, and 2^160 is already out of reach. Spending 100 ms of Argon2id on
 *   it would be cargo-culting the expensive option onto a case that does not
 *   need it.
 *
 * Parameters live in the key record rather than in this file, so they can be
 * retuned after real-device measurement without invalidating existing vaults.
 */
import { importKey } from './envelope.ts';
import { utf8, type Bytes } from './bytes.ts';
import type { DeriveRequest, DeriveResponse } from './kdf.worker.ts';

/**
 * Defaults from Spike 2. OWASP's floor is m=19 MiB, t=2; 64 MiB / t=3 is
 * comfortably above it and still measured under 100 ms on a laptop.
 *
 * **Settled on hardware, 21 Sep 2026**: 232.7 ms p50 on a Google Pixel 9a, with
 * no allocation failure at 64 MiB, against a 1.5 s budget. Earlier phone
 * figures were extrapolations — CDP throttling scales CPU scheduling while
 * Argon2id's cost is random access across 64 MiB — and they were pessimistic by
 * about double. `npm run bench:kdfDevice` re-runs it on a new device;
 * `docs/security.md` holds the decision rule, including that **iterations come
 * down before memory**, which the measurement meant never had to be applied.
 *
 * Retuning is safe. These are only the defaults for a *new* vault: the values
 * actually used are written into the key record and read back from it on every
 * unlock, so an existing vault keeps whatever it was created with.
 */
export const DEFAULT_ARGON2_PARAMS = {
  name: 'argon2id',
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
} as const;

export interface Argon2Params {
  name: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, (response: DeriveResponse) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<DeriveResponse>) => {
    const resolve = pending.get(event.data.seq);
    pending.delete(event.data.seq);
    resolve?.(event.data);
  };
  worker.onerror = () => {
    // Fail every in-flight derivation rather than leaving unlock hanging.
    for (const [key, resolve] of pending) {
      resolve({ seq: key, ok: false, error: 'kdf worker failed' });
    }
    pending.clear();
  };
  return worker;
}

export class KdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KdfError';
  }
}

export interface DerivedKey {
  key: CryptoKey;
  ms: number;
}

/** Derive a key-encryption key from a passphrase. Runs in the KDF worker. */
export function deriveKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<DerivedKey> {
  if (params.name !== 'argon2id') {
    return Promise.reject(new KdfError(`unsupported KDF "${params.name}"`));
  }

  const request: DeriveRequest = {
    seq: ++seq,
    passphrase,
    salt,
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };

  // No Worker: Node (where the crypto tests run) and the rare browser without
  // module-worker support. Correctness is identical; only the UI-blocking
  // behaviour differs, which is why the worker is the default rather than the
  // only path.
  if (typeof Worker === 'undefined') return deriveInline(request);

  return new Promise<DerivedKey>((resolve, reject) => {
    pending.set(request.seq, (response) => {
      if (!response.ok) {
        reject(new KdfError(response.error));
        return;
      }
      importKey(response.key as Bytes, false).then(
        (key) => resolve({ key, ms: response.ms }),
        (err: unknown) => reject(new KdfError(String(err))),
      );
    });
    ensureWorker().postMessage(request);
  });
}

/**
 * Derive a key-encryption key from a recovery code. HKDF, not Argon2id — see
 * the note at the top of this file.
 */
export async function deriveKekFromRecoveryCode(
  code: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(normalizeCode(code)), 'HKDF', false, [
    'deriveBits',
  ]);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      // Domain separation: this key material must never be usable in any other
      // context, even if the same code were somehow reused.
      // Frozen at the original name: see docs/security.md § "Frozen identifiers".
      info: utf8('teksto/recovery-kek/v1'),
    },
    material,
    256,
  );

  return importKey(new Uint8Array(bits), false);
}

/** Same derivation, on the calling thread. See the note at the call site. */
async function deriveInline(request: DeriveRequest): Promise<DerivedKey> {
  const started = Date.now();
  const { argon2id } = await import('hash-wasm');

  const raw = await argon2id({
    password: request.passphrase,
    salt: request.salt,
    memorySize: request.memoryKiB,
    iterations: request.iterations,
    parallelism: request.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });

  return { key: await importKey(raw as Bytes, false), ms: Date.now() - started };
}

/** Recovery codes are compared and derived in a canonical form. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Release the KDF worker. Called on logout. */
export function disposeKdf(): void {
  worker?.terminate();
  worker = undefined;
  pending.clear();
}

export type { Bytes };
