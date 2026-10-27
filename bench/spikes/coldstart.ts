/**
 * Spike 3 — cold start with a large note collection.
 *
 * Budget: < 400 ms from "open the app" to an interactive, scrollable note list.
 *
 * This spike exists to test plan issue #3. It compares three storage layouts
 * head to head on identical data:
 *
 *   A. one record, one ciphertext  (the spec's §14 shape) — decrypt everything
 *   B. one record, split ciphertexts — read whole records, decrypt meta only
 *   C. two object stores — read the meta store only, decrypt meta only
 *
 * B isolates the cost of decryption; C additionally avoids paying to
 * deserialize body bytes out of IndexedDB that we are not going to use.
 */
import { generateNotes, type SyntheticNote } from '../fixtures/notes.ts';
import {
  generateDek,
  encryptEnvelope,
  decryptEnvelope,
  encodeMeta,
  decodeMeta,
  type NoteMeta,
  type Bytes,
} from '../lib/crypto.ts';
import { openDb, deleteDb, req, txDone } from '../lib/idb.ts';
import { round } from '../lib/stats.ts';

const DB_NAME = 'hushjot-bench-coldstart';
const ROW_HEIGHT = 44;

interface SeedStats {
  count: number;
  plaintextBytes: number;
  metaCipherBytes: number;
  bodyCipherBytes: number;
  seedMs: number;
}

async function seed(key: CryptoKey, notes: SyntheticNote[]): Promise<SeedStats> {
  await deleteDb(DB_NAME);
  const db = await openDb(DB_NAME, 1, (d) => {
    // Layout A + B share this store; C uses the split pair.
    d.createObjectStore('combined', { keyPath: 'id' });
    d.createObjectStore('noteMeta', { keyPath: 'id' });
    d.createObjectStore('noteBody', { keyPath: 'id' });
  });

  const t0 = performance.now();
  let plaintextBytes = 0;
  let metaCipherBytes = 0;
  let bodyCipherBytes = 0;

  const CHUNK = 500;
  for (let i = 0; i < notes.length; i += CHUNK) {
    const slice = notes.slice(i, i + CHUNK);

    const prepared = await Promise.all(
      slice.map(async (n) => {
        const meta: NoteMeta = { t: n.title, f: n.folderId, u: n.updatedAt };
        const [metaCipher, bodyCipher, wholeCipher] = await Promise.all([
          encryptEnvelope(key, encodeMeta(meta)),
          encryptEnvelope(key, n.content),
          encryptEnvelope(key, JSON.stringify({ ...meta, c: n.content })),
        ]);
        plaintextBytes += n.title.length + n.content.length;
        metaCipherBytes += metaCipher.byteLength;
        bodyCipherBytes += bodyCipher.byteLength;
        return { n, metaCipher, bodyCipher, wholeCipher };
      }),
    );

    const tx = db.transaction(['combined', 'noteMeta', 'noteBody'], 'readwrite');
    const combined = tx.objectStore('combined');
    const metaStore = tx.objectStore('noteMeta');
    const bodyStore = tx.objectStore('noteBody');

    for (const p of prepared) {
      combined.put({
        id: p.n.id,
        wholeCipher: p.wholeCipher,
        metaCipher: p.metaCipher,
        bodyCipher: p.bodyCipher,
        updatedAt: p.n.updatedAt,
        revision: p.n.revision,
      });
      metaStore.put({
        id: p.n.id,
        metaCipher: p.metaCipher,
        updatedAt: p.n.updatedAt,
        revision: p.n.revision,
      });
      bodyStore.put({ id: p.n.id, bodyCipher: p.bodyCipher });
    }
    await txDone(tx);
  }

  const seedMs = performance.now() - t0;
  db.close();
  return { count: notes.length, plaintextBytes, metaCipherBytes, bodyCipherBytes, seedMs };
}

/** Decrypt in bounded batches — 10k un-batched awaits add measurable overhead. */
async function decryptAll(
  key: CryptoKey,
  items: Bytes[],
  batch = 256,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < items.length; i += batch) {
    const chunk = await Promise.all(
      items.slice(i, i + batch).map((c) => decryptEnvelope(key, c)),
    );
    out.push(...chunk);
  }
  return out;
}

interface ListRow {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: number;
}

/** Virtualized list: render only the visible window, never 10k DOM nodes (§27). */
function renderVirtualList(rows: ListRow[]): number {
  const container = document.getElementById('list')!;
  container.replaceChildren();

  const spacer = document.createElement('div');
  spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
  spacer.style.position = 'relative';
  container.appendChild(spacer);

  const draw = () => {
    const start = Math.max(0, Math.floor(container.scrollTop / ROW_HEIGHT) - 2);
    const visible = Math.ceil(container.clientHeight / ROW_HEIGHT) + 4;
    const frag = document.createDocumentFragment();
    for (let i = start; i < Math.min(rows.length, start + visible); i++) {
      const r = rows[i]!;
      const el = document.createElement('div');
      el.className = 'row';
      el.style.position = 'absolute';
      el.style.top = `${i * ROW_HEIGHT}px`;
      el.style.left = '0';
      el.style.right = '0';
      const b = document.createElement('b');
      b.textContent = r.title;
      const s = document.createElement('span');
      s.textContent = r.folderId ?? 'unfiled';
      el.append(b, s);
      frag.appendChild(el);
    }
    spacer.replaceChildren(frag);
  };

  container.onscroll = draw;
  draw();
  container.offsetHeight; // force layout
  return spacer.childElementCount;
}

/** The simplest search index that could work: token -> note ids (§11). */
function buildIndex(docs: { id: string; text: string }[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const raw of doc.text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (raw.length < 2 || raw.length > 32 || seen.has(raw)) continue;
      seen.add(raw);
      let bucket = index.get(raw);
      if (!bucket) index.set(raw, (bucket = new Set()));
      bucket.add(doc.id);
    }
  }
  return index;
}

async function run() {
  const key = await generateDek();
  const notes = generateNotes({ count: 10_000, medianBytes: 1200 });
  const seedStats = await seed(key, notes);

  const results: Record<string, unknown> = {};

  // --- Layout A: single ciphertext, decrypt everything ---------------------
  {
    const db = await openDb(DB_NAME, 1, () => {});
    const t0 = performance.now();
    const recs = (await req(
      db.transaction('combined').objectStore('combined').getAll(),
    )) as { id: string; wholeCipher: Bytes }[];
    const readMs = performance.now() - t0;

    const t1 = performance.now();
    const plaintexts = await decryptAll(key, recs.map((r) => r.wholeCipher));
    const decryptMs = performance.now() - t1;

    const t2 = performance.now();
    const rows: ListRow[] = plaintexts.map((p, i) => {
      const o = JSON.parse(p) as NoteMeta & { c: string };
      return { id: recs[i]!.id, title: o.t, folderId: o.f, updatedAt: o.u };
    });
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const nodes = renderVirtualList(rows);
    const renderMs = performance.now() - t2;

    results.A_singleCiphertext = {
      idbReadMs: round(readMs),
      decryptMs: round(decryptMs),
      parseSortRenderMs: round(renderMs),
      totalToInteractiveMs: round(readMs + decryptMs + renderMs),
      domNodes: nodes,
    };
    db.close();
  }

  // --- Layout B: split ciphertexts, one store, decrypt meta only -----------
  {
    const db = await openDb(DB_NAME, 1, () => {});
    const t0 = performance.now();
    const recs = (await req(
      db.transaction('combined').objectStore('combined').getAll(),
    )) as { id: string; metaCipher: Bytes; updatedAt: number }[];
    const readMs = performance.now() - t0;

    const t1 = performance.now();
    const metas = await decryptAll(key, recs.map((r) => r.metaCipher));
    const decryptMs = performance.now() - t1;

    const t2 = performance.now();
    const rows: ListRow[] = metas.map((m, i) => {
      const o = decodeMeta(m);
      return { id: recs[i]!.id, title: o.t, folderId: o.f, updatedAt: o.u };
    });
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const nodes = renderVirtualList(rows);
    const renderMs = performance.now() - t2;

    results.B_splitCipherSameStore = {
      idbReadMs: round(readMs),
      decryptMs: round(decryptMs),
      parseSortRenderMs: round(renderMs),
      totalToInteractiveMs: round(readMs + decryptMs + renderMs),
      domNodes: nodes,
    };
    db.close();
  }

  // --- Layout C: separate meta store (the proposal) ------------------------
  let indexStats: Record<string, unknown> = {};
  {
    const db = await openDb(DB_NAME, 1, () => {});
    const t0 = performance.now();
    const recs = (await req(
      db.transaction('noteMeta').objectStore('noteMeta').getAll(),
    )) as { id: string; metaCipher: Bytes; updatedAt: number }[];
    const readMs = performance.now() - t0;

    const t1 = performance.now();
    const metas = await decryptAll(key, recs.map((r) => r.metaCipher));
    const decryptMs = performance.now() - t1;

    const t2 = performance.now();
    const rows: ListRow[] = metas.map((m, i) => {
      const o = decodeMeta(m);
      return { id: recs[i]!.id, title: o.t, folderId: o.f, updatedAt: o.u };
    });
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const nodes = renderVirtualList(rows);
    const renderMs = performance.now() - t2;

    results.C_separateMetaStore = {
      idbReadMs: round(readMs),
      decryptMs: round(decryptMs),
      parseSortRenderMs: round(renderMs),
      totalToInteractiveMs: round(readMs + decryptMs + renderMs),
      domNodes: nodes,
    };

    // --- opening one note: the on-demand body decrypt ---------------------
    const openSamples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const target = rows[i * 37 % rows.length]!;
      const t = performance.now();
      const rec = (await req(
        db.transaction('noteBody').objectStore('noteBody').get(target.id),
      )) as { bodyCipher: Bytes };
      await decryptEnvelope(key, rec.bodyCipher);
      openSamples.push(performance.now() - t);
    }
    const sorted = openSamples.sort((a, b) => a - b);
    results.noteOpenMs = {
      p50: round(sorted[Math.floor(sorted.length * 0.5)]!, 3),
      p95: round(sorted[Math.floor(sorted.length * 0.95)]!, 3),
      max: round(sorted[sorted.length - 1]!, 3),
    };

    // --- background search index sweep (never blocks the list) ------------
    const t3 = performance.now();
    const bodies = (await req(
      db.transaction('noteBody').objectStore('noteBody').getAll(),
    )) as { id: string; bodyCipher: Bytes }[];
    const bodyReadMs = performance.now() - t3;

    const t4 = performance.now();
    const texts = await decryptAll(key, bodies.map((b) => b.bodyCipher));
    const bodyDecryptMs = performance.now() - t4;

    const t5 = performance.now();
    const index = buildIndex(texts.map((text, i) => ({ id: bodies[i]!.id, text })));
    const indexBuildMs = performance.now() - t5;

    // Search latency on the built index.
    const queries = ['postgres', 'docker', 'rust', 'select', 'timeout', 'kubernetes'];
    const searchSamples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const q = queries[i % queries.length]!;
      const t = performance.now();
      const hits = new Set<string>();
      for (const [token, ids] of index) {
        if (token.startsWith(q)) for (const id of ids) hits.add(id);
      }
      searchSamples.push(performance.now() - t);
      if (i === 0) indexStats.sampleHitCount = hits.size;
    }
    const ss = searchSamples.sort((a, b) => a - b);

    indexStats = {
      ...indexStats,
      bodyReadMs: round(bodyReadMs),
      bodyDecryptMs: round(bodyDecryptMs),
      indexBuildMs: round(indexBuildMs),
      totalIndexSweepMs: round(bodyReadMs + bodyDecryptMs + indexBuildMs),
      uniqueTokens: index.size,
      searchPrefixScanMs: {
        p50: round(ss[Math.floor(ss.length * 0.5)]!, 3),
        p95: round(ss[Math.floor(ss.length * 0.95)]!, 3),
      },
    };
    db.close();
  }

  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

  await deleteDb(DB_NAME);

  return {
    seed: {
      ...seedStats,
      seedMs: round(seedStats.seedMs),
      plaintextMB: round(seedStats.plaintextBytes / 1e6),
      metaCipherMB: round(seedStats.metaCipherBytes / 1e6),
      bodyCipherMB: round(seedStats.bodyCipherBytes / 1e6),
    },
    layouts: results,
    searchIndex: indexStats,
    heapMB: mem ? round(mem.usedJSHeapSize / 1e6) : null,
  };
}

declare global {
  interface Window {
    __spike: () => Promise<unknown>;
  }
}

window.__spike = run;
