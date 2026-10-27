/**
 * Unlock worker. Argon2id runs here and only here — never on the typing path,
 * and never on the main thread (a 1s+ block would freeze the UI).
 */
import { argon2id } from 'hash-wasm';

export interface KdfRequest {
  password: string;
  salt: number[];
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface KdfResponse {
  ok: boolean;
  ms: number;
  keyHex?: string;
  error?: string;
}

self.onmessage = async (ev: MessageEvent<KdfRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  try {
    const keyHex = await argon2id({
      password: req.password,
      salt: new Uint8Array(req.salt),
      memorySize: req.memoryKiB,
      iterations: req.iterations,
      parallelism: req.parallelism,
      hashLength: 32,
      outputType: 'hex',
    });
    const res: KdfResponse = { ok: true, ms: performance.now() - t0, keyHex };
    self.postMessage(res);
  } catch (err) {
    const res: KdfResponse = {
      ok: false,
      ms: performance.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};
