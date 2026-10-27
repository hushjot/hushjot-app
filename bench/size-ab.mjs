/**
 * Spike 5 — critical-path bundle budget, as an A/B.
 *
 *   eager : @codemirror/lang-markdown  (pulls in lang-html -> lang-css + lang-javascript)
 *   lean  : src/editor/markdownLean.ts (built directly on @lezer/markdown)
 *
 * "Eager" bytes = every chunk reachable from the entry without crossing a
 * dynamic import. That is what a user downloads before they can type.
 *
 * Budget: eager < 160 KB gzipped.
 */
import { build } from 'vite';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const BUDGET_KB = 160;

const VARIANTS = [
  { name: 'eager', entry: 'size/eager.ts' },
  { name: 'lean', entry: 'size/lean.ts' },
];

async function measure({ name, entry }) {
  const outDir = resolve(here, `dist-size-${name}`);
  rmSync(outDir, { recursive: true, force: true });

  const result = await build({
    root: repoRoot,
    configFile: false,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: 'esbuild',
      reportCompressedSize: false,
      chunkSizeWarningLimit: 10_000,
      rollupOptions: {
        input: resolve(here, entry),
        output: { entryFileNames: '[name].js', chunkFileNames: 'c-[hash].js' },
      },
    },
  });

  const bundle = Array.isArray(result) ? result[0] : result;
  const chunks = bundle.output.filter((o) => o.type === 'chunk');
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));

  // Reachable without crossing a dynamic import boundary = the critical path.
  const eager = new Set();
  const queue = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
  while (queue.length) {
    const file = queue.pop();
    if (eager.has(file)) continue;
    eager.add(file);
    const chunk = byFile.get(file);
    if (chunk) for (const imp of chunk.imports) queue.push(imp);
  }

  const rows = chunks
    .map((c) => {
      const raw = readFileSync(resolve(outDir, c.fileName));
      return {
        file: c.fileName,
        eager: eager.has(c.fileName),
        rawKB: +(raw.length / 1024).toFixed(1),
        gzipKB: +(gzipSync(raw, { level: 9 }).length / 1024).toFixed(1),
        brotliKB: +(brotliCompressSync(raw).length / 1024).toFixed(1),
      };
    })
    .sort((a, b) => b.gzipKB - a.gzipKB);

  const sum = (pred, field) =>
    +rows.filter(pred).reduce((acc, r) => acc + r[field], 0).toFixed(1);

  rmSync(outDir, { recursive: true, force: true });

  return {
    variant: name,
    eager: {
      gzipKB: sum((r) => r.eager, 'gzipKB'),
      brotliKB: sum((r) => r.eager, 'brotliKB'),
      rawKB: sum((r) => r.eager, 'rawKB'),
      chunks: rows.filter((r) => r.eager).length,
    },
    lazy: {
      gzipKB: sum((r) => !r.eager, 'gzipKB'),
      brotliKB: sum((r) => !r.eager, 'brotliKB'),
      chunks: rows.filter((r) => !r.eager).length,
    },
    largestEagerChunks: rows.filter((r) => r.eager).slice(0, 5),
  };
}

const measured = [];
for (const v of VARIANTS) {
  process.stdout.write(`Building ${v.name}… `);
  const m = await measure(v);
  m.pass = m.eager.gzipKB < BUDGET_KB;
  measured.push(m);
  console.log(`${m.eager.gzipKB} KB gzip eager, ${m.lazy.chunks} lazy chunks`);
}

const summary = {
  budgetKB: BUDGET_KB,
  variants: measured,
  recommended: measured.find((m) => m.pass)?.variant ?? null,
};

// Its own file: this is a one-off spike over two synthetic entries, and
// `size.mjs` — the gate — writes `results-size.json` in a different shape.
writeFileSync(resolve(here, 'results-size-ab.json'), JSON.stringify(summary, null, 2));

console.log('');
console.table(
  measured.map((m) => ({
    variant: m.variant,
    eagerGzipKB: m.eager.gzipKB,
    eagerBrotliKB: m.eager.brotliKB,
    lazyGzipKB: m.lazy.gzipKB,
    lazyChunks: m.lazy.chunks,
    budget: m.pass ? 'PASS' : 'FAIL',
  })),
);

for (const m of measured) {
  console.log(`\n${m.variant} — largest eager chunks:`);
  console.table(m.largestEagerChunks);
}

process.exit(summary.recommended ? 0 : 1);
