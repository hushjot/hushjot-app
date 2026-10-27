/**
 * Spike 2 — Argon2id unlock cost.
 *
 * Budget: < 1.5 s at 4x CPU throttle (a mid-range phone proxy).
 *
 * Argon2id is the one deliberately slow operation in the product. It runs once
 * per unlock, in a worker.
 *
 * **Trim order, corrected.** This file originally said to lower memory before
 * iterations, which had the trade backwards. Memory-hardness is the entire
 * reason this is Argon2id rather than PBKDF2 — it is what denies an attacker
 * the GPU and ASIC advantage. Going from t=3 to t=2 makes each guess 1.5x
 * cheaper; going from 64 MiB to 32 MiB halves the attacker's memory cost per
 * parallel guess, which concedes more. So if the budget cannot be met:
 * iterations first, memory only if that is not enough, and never below the
 * OWASP floor of m=19 MiB / t=2. `docs/security.md` holds the same rule.
 *
 * In the event the trim order never had to be applied: the real-hardware run on
 * 21 Sep 2026 came in at 232.7 ms on a Pixel 9a, meeting the budget at the
 * first rung. The rule stands for the next device.
 *
 * This spike runs on a laptop and could not settle the question by itself —
 * CDP throttling models CPU scheduling, not memory bandwidth.
 * `npm run bench:kdfDevice` is the real-hardware harness.
 */
import { summarize, roundSummary, round } from '../lib/stats.ts';

interface Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

const CANDIDATES: Params[] = [
  { memoryKiB: 65536, iterations: 3, parallelism: 1 }, // 64 MiB — the plan's default
  { memoryKiB: 65536, iterations: 2, parallelism: 1 },
  { memoryKiB: 32768, iterations: 3, parallelism: 1 }, // 32 MiB fallback
  { memoryKiB: 19456, iterations: 2, parallelism: 1 }, // OWASP minimum-ish
];

function runOnce(worker: Worker, params: Params, salt: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      worker.removeEventListener('message', onMessage);
      const res = ev.data as { ok: boolean; ms: number; error?: string };
      if (res.ok) resolve(res.ms);
      else reject(new Error(res.error ?? 'kdf failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({
      password: 'correct horse battery staple',
      salt: Array.from(salt),
      ...params,
    });
  });
}

async function run() {
  const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
  const salt = crypto.getRandomValues(new Uint8Array(32));

  // Measure the cost of loading the wasm module itself — it is lazy-loaded, so
  // the very first unlock on a device pays this on top of the KDF.
  const coldStart = performance.now();
  await runOnce(worker, CANDIDATES[0]!, salt);
  const coldMs = performance.now() - coldStart;

  const results: Record<string, unknown> = {};
  for (const params of CANDIDATES) {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await runOnce(worker, params, salt));
    const label = `m=${params.memoryKiB / 1024}MiB,t=${params.iterations},p=${params.parallelism}`;
    results[label] = roundSummary(summarize(samples), 1);
  }

  worker.terminate();

  return {
    coldFirstUnlockMs: round(coldMs, 1),
    warmByParams: results,
  };
}

declare global {
  interface Window {
    __spike: () => Promise<unknown>;
  }
}

window.__spike = run;
