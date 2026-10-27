/**
 * Spike 4 — debounced encrypt + IndexedDB write latency, and the teardown flush.
 *
 * Budget: p95 local write < 20 ms; zero data loss on pagehide.
 *
 * This spike tests the resolution of the §7/§13 contradiction:
 *   - keystrokes mutate memory only and are never awaited on crypto
 *   - the debounced write encrypts in a worker
 *   - the pagehide flush encrypts on the MAIN thread, because a worker
 *     round-trip is not guaranteed to complete during page teardown
 *
 * The main-thread flush is only defensible if AES-GCM on a realistic note is
 * genuinely sub-millisecond, so we measure that directly.
 */
import { generateNotes } from '../fixtures/notes.ts';
import { generateDek, encryptEnvelope, decryptEnvelope, type Bytes } from '../lib/crypto.ts';
import { openDb, deleteDb, req, txDone } from '../lib/idb.ts';
import { summarize, roundSummary, round } from '../lib/stats.ts';

const DB_NAME = 'hushjot-bench-persist';

async function run() {
  const key = await generateDek();
  const notes = generateNotes({ count: 60, medianBytes: 1200 });

  await deleteDb(DB_NAME);
  const db = await openDb(DB_NAME, 1, (d) => {
    d.createObjectStore('noteBody', { keyPath: 'id' });
  });

  // --- 1. main-thread encrypt cost by note size ---------------------------
  const encryptBySize: Record<string, unknown> = {};
  for (const size of [1_000, 10_000, 100_000, 500_000]) {
    const text = 'x'.repeat(size);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      await encryptEnvelope(key, text);
      samples.push(performance.now() - t);
    }
    encryptBySize[`${size / 1000}KB`] = roundSummary(summarize(samples), 3);
  }

  // --- 2. full debounced save cycle: encrypt + IDB write -------------------
  const saveSamples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const note = notes[i % notes.length]!;
    const t = performance.now();
    const cipher = await encryptEnvelope(key, note.content);
    const tx = db.transaction('noteBody', 'readwrite');
    tx.objectStore('noteBody').put({ id: note.id, bodyCipher: cipher, revision: i });
    await txDone(tx);
    saveSamples.push(performance.now() - t);
  }

  // --- 3. worker round-trip overhead (the debounced path) -----------------
  const worker = new Worker(new URL('./persist.worker.ts', import.meta.url), {
    type: 'module',
  });
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  await new Promise<void>((resolve) => {
    const onReady = (ev: MessageEvent) => {
      if ((ev.data as { type: string }).type === 'ready') {
        worker.removeEventListener('message', onReady);
        resolve();
      }
    };
    worker.addEventListener('message', onReady);
    worker.postMessage({ type: 'init', key: rawKey });
  });

  const workerSamples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const note = notes[i % notes.length]!;
    const t = performance.now();
    await new Promise<void>((resolve) => {
      const onDone = (ev: MessageEvent) => {
        const d = ev.data as { type: string; id: number };
        if (d.type === 'encrypted' && d.id === i) {
          worker.removeEventListener('message', onDone);
          resolve();
        }
      };
      worker.addEventListener('message', onDone);
      worker.postMessage({ type: 'encrypt', id: i, text: note.content });
    });
    workerSamples.push(performance.now() - t);
  }
  worker.terminate();

  // --- 4. teardown flush: how much can complete synchronously? ------------
  // We cannot truly kill the page here, but we can measure the wall-clock cost
  // of the flush path for a realistic dirty set, which is what determines
  // whether it fits in the teardown budget browsers actually give us.
  const dirty = notes.slice(0, 5);
  const flushStart = performance.now();
  const ciphers = await Promise.all(dirty.map((n) => encryptEnvelope(key, n.content)));
  const flushTx = db.transaction('noteBody', 'readwrite');
  const store = flushTx.objectStore('noteBody');
  dirty.forEach((n, i) => store.put({ id: n.id, bodyCipher: ciphers[i]!, revision: 9999 }));
  await txDone(flushTx);
  const flushMs = performance.now() - flushStart;

  // --- 5. round-trip integrity: nothing silently corrupted ----------------
  let verified = 0;
  let mismatched = 0;
  for (const n of dirty) {
    const rec = (await req(
      db.transaction('noteBody').objectStore('noteBody').get(n.id),
    )) as { bodyCipher: Bytes };
    const text = await decryptEnvelope(key, rec.bodyCipher);
    if (text === n.content) verified++;
    else mismatched++;
  }

  db.close();
  await deleteDb(DB_NAME);

  return {
    encryptOnlyByNoteSize: encryptBySize,
    fullSaveCycleMs: roundSummary(summarize(saveSamples), 3),
    workerRoundTripMs: roundSummary(summarize(workerSamples), 3),
    teardownFlush: {
      dirtyNotes: dirty.length,
      totalMs: round(flushMs, 3),
    },
    integrity: { verified, mismatched },
  };
}

declare global {
  interface Window {
    __spike: () => Promise<unknown>;
  }
}

window.__spike = run;
