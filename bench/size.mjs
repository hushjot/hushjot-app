/**
 * Bundle budget regression gate for the real application.
 *
 * "Eager" bytes = every chunk reachable from **one entry** without crossing a
 * dynamic import, plus every stylesheet that entry pulls in. That is what a
 * user downloads before they can type, and it is the number §7 and §28
 * actually care about.
 *
 * Phase 0 set the budget at 160 KB gzipped for the app. Exceeding it fails the
 * build.
 *
 * ## One budget per document, not one for the build
 *
 * There are two HTML entries (`vite.config.ts`): the app, and the share viewer
 * at `/s/`, which a recipient loads *instead of* the app. Summing them would
 * produce a number that means nothing — nobody downloads both — while still
 * looking like a critical-path figure, and the viewer's Markdown renderer
 * would quietly eat the app's headroom. So each entry is walked from its own
 * root and measured against its own budget, and a chunk both of them import is
 * charged to both, because each document really does fetch it.
 *
 * ## Stylesheets
 *
 * A dynamic import saves JavaScript but never CSS: Vite hoists a lazy
 * component's stylesheet into the document's `<link>` set, so it is
 * render-blocking whether or not its code is. CSS is therefore attributed by
 * walking static *and* dynamic imports from the entry and taking every
 * `importedCss` on the way — which is the same "charge it eagerly" rule the
 * single-budget version had, made per entry.
 *
 * The one-off comparison that chose `markdownLean` over
 * `@codemirror/lang-markdown` lives in `bench/size-ab.mjs`.
 */
import { build } from 'vite';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-app');

/**
 * Budget per entry, keyed by the HTML document it belongs to.
 *
 * The app's 160 KB is Phase 0's. The viewer's is its first real measurement
 * (48.3 KB) plus about 15 %, and is deliberately tight: almost all of it is the
 * Markdown parser and the Svelte runtime, both of which it genuinely needs, and
 * anything that moves it much is something the page a stranger opens should not
 * be downloading. It has already caught one — `@codemirror/language`, reached
 * through the preview renderer's syntax highlighting, put the whole editor
 * runtime on this page and the budget failed by 47 KB.
 *
 * Raised from 56 to 57 for the page's own chrome rather than a dependency: the
 * phone header's "Aa" and "⋯" popovers and the end-of-note link to hushjot.com
 * cost 0.9 KB, on a page that had 0.1 KB left. A leak of the kind above is
 * tens of kilobytes, so the gate still catches what it exists to catch.
 *
 * Raised from 57 to 58 when the page was 0.2 KB over already (envelope binding
 * had used the last of the headroom) and the mermaid hook in `render.ts` added
 * 0.1 KB more. That hook is a dynamic import and nothing else: mermaid itself
 * stays off this page unless a shared note has a diagram.
 *
 * Raised from 58 to 59 for a dependency refresh (Oct 2026) that cleared every
 * `npm audit` advisory: Svelte 5.57's runtime and the lezer/CodeMirror patch
 * releases added 1.0 KB to a page with 0.3 KB left, and none of it is
 * avoidable without pinning a runtime the page genuinely needs. Vite stays on 7
 * for this page's sake — Vite 8's Rolldown would not split the Svelte runtime
 * per entry and parked its own helpers in a chunk of Mermaid's d3 code, which
 * cost ~3 KB more even after tuning its chunking options.
 */
const BUDGETS_KB = {
  'index.html': 160,
  's/index.html': 59,
};

rmSync(outDir, { recursive: true, force: true });

const result = await build({
  root: repoRoot,
  logLevel: 'error',
  build: { outDir, emptyOutDir: true, reportCompressedSize: false },
});

const bundle = Array.isArray(result) ? result[0] : result;
const chunks = bundle.output.filter((o) => o.type === 'chunk');
const byFile = new Map(chunks.map((c) => [c.fileName, c]));

/** Walk from one chunk, following `pick` (static imports, or both kinds). */
function walk(start, pick) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = byFile.get(file);
    if (chunk) for (const imported of pick(chunk)) queue.push(imported);
  }
  return seen;
}

const measure = (fileName) => {
  const raw = readFileSync(resolve(outDir, fileName));
  return {
    file: fileName.replace(/^assets\//, ''),
    rawKB: +(raw.length / 1024).toFixed(1),
    gzipKB: +(gzipSync(raw, { level: 9 }).length / 1024).toFixed(1),
    brotliKB: +(brotliCompressSync(raw).length / 1024).toFixed(1),
  };
};

const cache = new Map();
const sized = (fileName) => {
  if (!cache.has(fileName)) cache.set(fileName, measure(fileName));
  return cache.get(fileName);
};

const entries = chunks.filter((c) => c.isEntry);
const documents = Object.keys(BUDGETS_KB);

/**
 * Which entry chunk belongs to which HTML document.
 *
 * Rollup names an entry after its input key (`index`, `share`), which is not
 * the document's path, so the mapping comes from the HTML itself: each shell
 * names its own entry script.
 *
 * Matched on `src="/…"` rather than a bare substring, because both documents
 * also carry `<link rel="modulepreload">` for chunks they share — a looser
 * match would charge a shared chunk's whole graph to whichever document the
 * loop happened to reach first.
 */
const htmlFor = (entry) =>
  documents.find((doc) => {
    const html = bundle.output.find((o) => o.type === 'asset' && o.fileName === doc);
    return typeof html?.source === 'string' && html.source.includes(`src="/${entry.fileName}"`);
  });

const report = [];
let failed = false;

for (const entry of entries) {
  const document = htmlFor(entry);
  if (!document) {
    console.error(`\nNo budget for entry ${entry.fileName}: it is in no HTML document this gate knows about.`);
    failed = true;
    continue;
  }

  const eager = walk(entry.fileName, (c) => c.imports);
  // CSS follows dynamic imports too: a lazy component's stylesheet is still a
  // `<link>` in the document, so it blocks the first paint regardless.
  const anyImport = walk(entry.fileName, (c) => [...c.imports, ...c.dynamicImports]);
  const styles = new Set();
  for (const file of anyImport) {
    for (const css of byFile.get(file)?.viteMetadata?.importedCss ?? []) styles.add(css);
  }

  const rows = [...[...eager].map(sized), ...[...styles].map(sized)].sort((a, b) => b.gzipKB - a.gzipKB);
  const sum = (field) => +rows.reduce((acc, r) => acc + r[field], 0).toFixed(1);

  const budgetKB = BUDGETS_KB[document];
  const gzipKB = sum('gzipKB');
  const entryReport = {
    document,
    entry: entry.fileName,
    eagerFiles: eager,
    budgetKB,
    eager: { gzipKB, brotliKB: sum('brotliKB'), rawKB: sum('rawKB'), chunks: eager.size, styles: styles.size },
    headroomKB: +(budgetKB - gzipKB).toFixed(1),
    pass: gzipKB < budgetKB,
    largestEager: rows.slice(0, 8),
  };
  if (!entryReport.pass) failed = true;
  report.push(entryReport);
}

// Lazy = reachable from no entry without crossing a dynamic import. Mostly the
// ~130 code grammars, plus every dialog.
const anyEager = new Set(report.flatMap((r) => [...r.eagerFiles]));
const lazyChunks = chunks.filter((c) => !anyEager.has(c.fileName));
const lazyGzipKB = +lazyChunks.reduce((acc, c) => acc + sized(c.fileName).gzipKB, 0).toFixed(1);

const summary = {
  budgets: BUDGETS_KB,
  entries: report.map(({ eagerFiles: _files, ...rest }) => rest),
  lazy: { gzipKB: lazyGzipKB, chunks: lazyChunks.length },
  pass: !failed,
};

rmSync(outDir, { recursive: true, force: true });
writeFileSync(resolve(here, 'results-size.json'), JSON.stringify(summary, null, 2));

for (const r of report) {
  console.log(
    `\n${r.document.padEnd(13)} ${r.eager.gzipKB} KB gzip / ${r.eager.brotliKB} KB brotli ` +
      `across ${r.eager.chunks} chunk(s) + ${r.eager.styles} stylesheet(s)`,
  );
  console.log(
    `${' '.repeat(13)} Budget ${r.budgetKB} KB: ${r.pass ? 'PASS' : 'FAIL'} (${r.headroomKB} KB headroom)`,
  );
}
console.log(
  `\nLazy:         ${lazyGzipKB} KB gzip across ${lazyChunks.length} chunks ` +
    `(code grammars and dialogs — fetched on first use)\n`,
);
console.table(report.flatMap((r) => r.largestEager.map((row) => ({ document: r.document, ...row }))));

if (failed) {
  const over = report.filter((r) => !r.pass);
  for (const r of over) {
    console.error(
      `\n${r.document} exceeds its budget by ${-r.headroomKB} KB. ` +
        `Move something behind a dynamic import before landing this.`,
    );
  }
  console.error('');
}

process.exit(failed ? 1 : 0);
