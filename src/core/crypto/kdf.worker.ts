/**
 * Key-derivation worker.
 *
 * Argon2id is the one deliberately slow operation in the product: 94.7 ms at
 * m=64 MiB, t=3 on an M4 (Spike 2) and 232.7 ms on a Google Pixel 9a — and
 * 456 ms there for the *first* derivation on a cold page, where this worker's
 * own startup and the lazy wasm fetch dominate. Running any of that on the main
 * thread would freeze the UI for the duration, which is why it lives here.
 *
 * It runs exactly once per unlock. It is never on the typing path.
 */
/// <reference lib="webworker" />
import { argon2id } from 'hash-wasm';

export interface DeriveRequest {
  seq: number;
  passphrase: string;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export type DeriveResponse =
  | { seq: number; ok: true; key: Uint8Array; ms: number }
  | { seq: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<DeriveRequest>) => {
  const req = event.data;
  const started = performance.now();

  try {
    const key = await argon2id({
      password: req.passphrase,
      salt: req.salt,
      memorySize: req.memoryKiB,
      iterations: req.iterations,
      parallelism: req.parallelism,
      hashLength: 32,
      outputType: 'binary',
    });

    const response: DeriveResponse = {
      seq: req.seq,
      ok: true,
      key,
      ms: performance.now() - started,
    };
    // Transfer rather than copy, so the derived key is not duplicated across
    // two heaps any longer than necessary.
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, [key.buffer]);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'derivation failed';

    // A `script-src` without `'wasm-unsafe-eval'` refuses to compile the
    // Argon2id module, and it surfaces here as a bare `CompileError` — which
    // reads like a corrupt build, not a policy problem. That ambiguity cost a
    // long debugging session once; say what it actually is. Note the policy
    // that governs this worker comes from *its own* response headers, not from
    // the page's, so the page can look fine while this is blocked.
    const wasmBlocked = typeof WebAssembly === 'undefined' || name === 'CompileError';

    const response: DeriveResponse = {
      seq: req.seq,
      ok: false,
      // Never echo the passphrase or salt into an error message (§29).
      error: wasmBlocked
        ? "WebAssembly is unavailable in this worker — the Content-Security-Policy serving it must allow 'wasm-unsafe-eval'"
        : name,
    };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
