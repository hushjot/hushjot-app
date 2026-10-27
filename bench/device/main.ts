/**
 * Argon2id on real hardware — security open item #2.
 *
 * ## Why this page exists at all
 *
 * Every Argon2id number in this repository was taken on a laptop, or on a
 * laptop pretending to be a phone. Neither settles the parameters, because
 * Argon2id is memory-hard *on purpose*: its cost is random access across a
 * 64 MiB buffer, so it is bound by memory bandwidth and cache, not by clock
 * speed. Chromium's CDP throttling scales CPU scheduling and nothing else,
 * which is why Spike 2 measured 94.7 ms at both 1x and 4x — the knob does not
 * touch the thing being measured. `bench/mobile.mjs` says so in its own header
 * and reports its figure as a bound, not a phone.
 *
 * So this is a page rather than a bench: it has to run on a physical device,
 * and nothing about that can be automated from here. `npm run bench:kdfDevice`
 * builds it and serves it on the LAN; you open it on the phone.
 *
 * ## What it measures, and why in this order
 *
 * - **Cold** first, on a fresh worker, wall-clock from the main thread — it
 *   includes worker startup and the lazy wasm fetch and instantiate, which is
 *   what the first unlock on a device actually pays.
 * - **Two passes** over the candidate grid, separated by a soak. A phone's
 *   first derivation is its fastest; the second pass is the one to quote,
 *   because a user unlocking after using the device for a while gets a warm,
 *   thermally-limited core, not a cold boost one.
 * - **Allocation failure as its own verdict.** This is the outcome that would
 *   make m=64 MiB unshippable, and it is not a slow unlock — it is no unlock
 *   at all, on a device whose notes are then unreachable. Latency alone hides
 *   it, so a refusal is recorded rather than dropped.
 *
 * ## Two deliberate limitations
 *
 * It drives `src/core/crypto/kdf.worker.ts` — the real one, not a copy — but
 * posts to it directly rather than going through `kdf.ts`. `deriveKekFromPassphrase`
 * finishes by calling `crypto.subtle.importKey`, and `subtle` does not exist on
 * a plain-http LAN origin. The import it skips costs microseconds and measures
 * nothing. **Do not "fix" this by routing through `kdf.ts`** — the page stops
 * working on the only kind of origin it can be served from.
 *
 * It also creates no vault, touches no IndexedDB, writes no `localStorage`,
 * and sends nothing anywhere. The result is a JSON blob to copy by hand.
 *
 * ## Two things the JSON cannot tell you
 *
 * **Which phone this was.** Chrome sends a reduced user-agent (`Android 10; K`
 * whatever the device), and `navigator.deviceMemory` is secure-context-gated,
 * so it is `null` here for the same reason `crypto.subtle` is missing. Write
 * the model into `bench/RESULTS.md` by hand; nothing in this file can.
 *
 * **Whether the screen stayed on.** A backgrounded or sleeping tab is
 * throttled, and the derivations it reports are plausible numbers that mean
 * nothing — the worst kind of result, because it does not look like a failure.
 * The Screen Wake Lock API would prevent it and is also secure-context-only,
 * so this detects it instead and says so loudly. It sits beside the
 * `allocation-failed` verdict: both are "a number exists, do not quote it".
 */
import type { DeriveRequest, DeriveResponse } from '../../src/core/crypto/kdf.worker.ts';
import { summarize, roundSummary, round, type Summary } from '../lib/stats.ts';

interface Candidate {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** The Spike 2 grid, unchanged, so these results sit beside that table. */
const CANDIDATES: Candidate[] = [
  { memoryKiB: 65536, iterations: 3, parallelism: 1 }, // the shipping default
  { memoryKiB: 65536, iterations: 2, parallelism: 1 }, // trim iterations first
  { memoryKiB: 32768, iterations: 3, parallelism: 1 }, // trim memory only if forced
  { memoryKiB: 19456, iterations: 2, parallelism: 1 }, // the OWASP floor
];

const RUNS_PER_CANDIDATE = 7;
const SOAK_MS = 45_000;

/** Generous: this exists to catch a wedged worker, not to fail a slow phone. */
const DERIVE_TIMEOUT_MS = 120_000;

const PASSPHRASE = 'a sufficiently long passphrase';

type Verdict = 'ok' | 'allocation-failed';

interface CandidateResult {
  label: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  verdict: Verdict;
  error?: string;
  summary?: Summary;
}

const label = (c: Candidate): string =>
  `m=${c.memoryKiB / 1024}MiB,t=${c.iterations},p=${c.parallelism}`;

// --- driving the real worker ------------------------------------------------

let seq = 0;

function newWorker(): Worker {
  return new Worker(new URL('../../src/core/crypto/kdf.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * One derivation. Resolves with the worker's own `performance.now()` delta, so
 * the number excludes postMessage overhead and matches what `kdf.ts` reports
 * back to the app.
 */
function derive(worker: Worker, candidate: Candidate, salt: Uint8Array): Promise<number> {
  const request: DeriveRequest = { seq: ++seq, passphrase: PASSPHRASE, salt, ...candidate };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no response in ${DERIVE_TIMEOUT_MS} ms — the worker is wedged or gone`));
    }, DERIVE_TIMEOUT_MS);

    const onMessage = (event: MessageEvent<DeriveResponse>) => {
      if (event.data.seq !== request.seq) return;
      cleanup();
      if (event.data.ok) resolve(event.data.ms);
      else reject(new Error(event.data.error));
    };

    // A hard out-of-memory kills the worker outright rather than throwing
    // inside it, and that arrives here and nowhere else.
    const onError = () => {
      cleanup();
      reject(new Error('the worker died — almost certainly out of memory'));
    };

    function cleanup(): void {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError);
    }

    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError);
    worker.postMessage(request);
  });
}

/**
 * A fresh worker per candidate. An allocation failure can leave the previous
 * one dead or its heap fragmented, and either would quietly contaminate every
 * row after it.
 */
async function measure(candidate: Candidate, salt: Uint8Array): Promise<CandidateResult> {
  const worker = newWorker();
  const base = { label: label(candidate), ...candidate };

  try {
    const samples: number[] = [];
    for (let i = 0; i < RUNS_PER_CANDIDATE; i++) samples.push(await derive(worker, candidate, salt));
    return { ...base, verdict: 'ok', summary: roundSummary(summarize(samples), 1) };
  } catch (error) {
    return {
      ...base,
      verdict: 'allocation-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    worker.terminate();
  }
}

// --- the page ---------------------------------------------------------------

/**
 * Sticky for the duration of a run. `visibilitychange` fires when the screen
 * sleeps as well as when the user switches apps, which is the whole point —
 * those are the same failure and neither announces itself in the timings.
 */
let backgrounded = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') backgrounded = true;
});

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const tableBody = document.querySelector<HTMLTableSectionElement>('#results tbody')!;
const jsonEl = document.querySelector<HTMLTextAreaElement>('#json')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;

function say(text: string): void {
  statusEl.textContent = text;
}

function addRow(pass: string, result: CandidateResult): void {
  const row = tableBody.insertRow();
  const cells = [
    pass,
    result.label,
    result.verdict === 'ok' ? `${result.summary?.p50}` : '—',
    result.verdict === 'ok' ? `${result.summary?.p95}` : '—',
    result.verdict === 'ok' ? `${result.summary?.max}` : '—',
    result.verdict === 'ok' ? 'ok' : `FAILED: ${result.error ?? ''}`,
  ];

  for (const value of cells) {
    // textContent, never innerHTML — the same rule the preview lives under.
    row.insertCell().textContent = value;
  }
  if (result.verdict !== 'ok') row.className = 'failed';
}

function environment(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    deviceMemoryGiB: nav.deviceMemory ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    measuredAt: new Date().toISOString(),
  };
}

async function runGrid(pass: string, salt: Uint8Array): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  for (const candidate of CANDIDATES) {
    say(`${pass}: ${label(candidate)} — ${RUNS_PER_CANDIDATE} derivations…`);
    const result = await measure(candidate, salt);
    addRow(pass, result);
    results.push(result);
  }
  return results;
}

/** Keep the default parameters running so the second pass meets a warm device. */
async function soak(salt: Uint8Array): Promise<number> {
  const worker = newWorker();
  const until = Date.now() + SOAK_MS;
  let derivations = 0;

  try {
    while (Date.now() < until) {
      say(`Soaking for thermal effects — ${Math.ceil((until - Date.now()) / 1000)} s left…`);
      await derive(worker, CANDIDATES[0]!, salt);
      derivations++;
    }
  } catch {
    // A failure here is not itself a result; the second pass will record it.
  } finally {
    worker.terminate();
  }
  return derivations;
}

async function run(): Promise<void> {
  runButton.disabled = true;
  tableBody.textContent = '';
  jsonEl.value = '';
  backgrounded = false;

  const salt = crypto.getRandomValues(new Uint8Array(32));

  say('Cold start: a fresh worker, including the lazy wasm fetch…');
  const coldWorker = newWorker();
  const coldStart = performance.now();
  let coldMs: number | null = null;
  try {
    await derive(coldWorker, CANDIDATES[0]!, salt);
    coldMs = round(performance.now() - coldStart, 1);
  } catch (error) {
    say(`Cold start failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    coldWorker.terminate();
  }

  const first = await runGrid('first', salt);
  const soakDerivations = await soak(salt);
  const second = await runGrid('second (warm)', salt);

  jsonEl.value = JSON.stringify(
    {
      note: 'Real-device Argon2id measurement. The "second" pass is the one to quote.',
      device: 'FILL IN THE HANDSET BY HAND — the reduced user-agent below cannot identify it',
      environment: environment(),
      backgroundedDuringRun: backgrounded,
      coldFirstUnlockMs: coldMs,
      soak: { seconds: SOAK_MS / 1000, derivations: soakDerivations },
      runsPerCandidate: RUNS_PER_CANDIDATE,
      first,
      second,
    },
    null,
    2,
  );

  const failed = [...first, ...second].filter((r) => r.verdict !== 'ok');

  if (backgrounded) {
    // Said first and said hardest: every number on screen is throttled, and
    // they look entirely reasonable.
    say(
      'DISCARD THIS RUN. The tab was hidden or the screen slept part way through, so these ' +
        'timings are throttled and mean nothing. Set the screen timeout to its longest, then run again.',
    );
  } else if (failed.length) {
    say(
      `Done — ${failed.length} candidate run(s) FAILED to allocate. That is the result that matters; paste the JSON into bench/RESULTS.md.`,
    );
  } else {
    say('Done. Copy the JSON below into bench/RESULTS.md, and add the phone model to it.');
  }

  statusEl.className = backgrounded ? 'discard' : '';
  runButton.disabled = false;
}

runButton.addEventListener('click', () => void run());
say('Ready. Put the phone on mains-off battery as a user would have it, then tap Run.');
