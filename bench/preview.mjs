/**
 * Markdown preview regression gate.
 *
 * The preview is allowed to exist only if it costs the editor nothing (§10,
 * §33). So this measures the thing a unit test cannot: typing into the real
 * editor while a live split preview re-renders beside it. It also measures how
 * long the preview takes to catch up and to open on a large note.
 *
 * - **Keystroke p95 in split view** has the same 16 ms budget as the plain
 *   editor in bench/app.mjs. The preview must not add a frame to input.
 * - **Catch-up** covers the moment typing stops until the rendered text shows the
 *   edit. The component debounces 150 ms and yields to idle, so this is
 *   mostly that wait, not work.
 * - **Open on a large note:** the first render of a ~50 KB note, including
 *   fetching the preview chunk.
 * - **No console errors**, which is also how a CSP violation would show up (for
 *   example, the preview trying to load a remote image).
 */
import { chromium } from 'playwright';
import { enterApp } from './lib/app.mjs';
import { build, preview } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-preview');

const BUDGETS = {
  splitKeystrokeP95Ms: 16,
  catchUpMs: 1500,
  openLargeNoteMs: 500,
  longTasksWhileTyping: 0,
};

/** ~50 KB of every construct the preview renders, including a remote image. */
function largeNote() {
  const section = (i) => `## Section ${i}

Some **bold**, *italic*, ~~struck~~ and \`inline code\` with a [link](https://example.com/${i}).
A remote image that must never be fetched: ![pic](https://example.com/${i}.png)
Note links, one plain, one aliased, one that resolves to nothing:
[[Section ${i}]], [[Section ${i}|the section]], [[No Such Note ${i}]].

- [ ] a task
- [x] a finished task
  - nested item

> A quote with a longer line of prose so the paragraph wraps in a narrow tile.

\`\`\`js
function f${i}(a, b) {
  return a + b; // comment
}
\`\`\`

| col | value |
|:----|------:|
| a   | ${i}  |
`;
  let text = '# Large note\n\n';
  for (let i = 0; text.length < 50_000; i++) text += section(i);
  return text;
}

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5181, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const remoteImageRequests = [];
page.on('request', (r) => {
  if (r.url().startsWith('https://example.com/')) remoteImageRequests.push(r.url());
});

await enterApp(page, base);
const results = {};

// Replace the open note with the large one, in edit mode.
await page.evaluate((text) => {
  const content = document.querySelector('.cm-content');
  content.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, text);
}, largeNote());

// --- open split on a large note ------------------------------------------
results.openLargeNoteMs = await page.evaluate(async () => {
  const t = performance.now();
  document.querySelector('.view-switch button[aria-label="Editor and preview"]').click();
  for (;;) {
    const article = document.querySelector('.markdown');
    if (article && article.childElementCount > 100) break;
    await new Promise(requestAnimationFrame);
    if (performance.now() - t > 10_000) return null;
  }
  return Math.round(performance.now() - t);
});

// --- typing beside a live preview ---------------------------------------
const typing = await page.evaluate(async () => {
  const content = document.querySelector('.cm-content');
  content.focus();
  // Type at the top of the note, where re-rendering is most expensive
  // to get wrong: every block after the edit must be reused, not rebuilt.
  document.execCommand('selectAll');
  const sel = window.getSelection();
  sel.collapseToStart();
  // Two frames, and they are load-bearing. CodeMirror reads a DOM selection
  // change from its observer rather than synchronously, so without this the
  // caret is still at the end of the note: the first character went in down
  // there, and `firstLine()` below measured whichever line the viewport was
  // still showing instead of line 1. It read a plausible number and the check
  // at the bottom passed by luck, until a fixture change moved which line that
  // was. Anything that samples the rendered first line has to let the view
  // scroll to the caret first.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);

  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  observer.observe({ type: 'longtask', buffered: false });

  const token = 'zqxj';
  const TYPED = 120;
  const samples = [];
  // CodeMirror only renders the lines in view, so measure the edited line
  // rather than the whole document's text.
  const firstLine = () => content.querySelector('.cm-line')?.textContent.length ?? 0;
  const lengthBefore = firstLine();
  for (let i = 0; i < TYPED; i++) {
    const ch = i < 116 ? 'the quick brown fox '[i % 20] : token[i - 116];
    const t = performance.now();
    document.execCommand('insertText', false, ch);
    content.offsetHeight;
    samples.push(performance.now() - t);
    await new Promise(requestAnimationFrame);
  }
  const inserted = firstLine() - lengthBefore;

  const stopped = performance.now();
  let catchUpMs = null;
  while (performance.now() - stopped < 5000) {
    if (document.querySelector('.markdown')?.textContent.includes(token)) {
      catchUpMs = Math.round(performance.now() - stopped);
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  observer.disconnect();

  samples.sort((a, b) => a - b);
  const at = (p) => +samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)].toFixed(3);
  return { n: samples.length, inserted, typed: TYPED, p50: at(50), p95: at(95), max: at(100), catchUpMs, longTasks };
});
results.typing = typing;

// --- the preview really is what it claims to be ---------------------------
results.structure = await page.evaluate(() => {
  const article = document.querySelector('.markdown');
  return {
    headings: article.querySelectorAll('h2').length,
    tables: article.querySelectorAll('table').length,
    highlighted: article.querySelectorAll('pre code span[class^="tok-"]').length,
    images: article.querySelectorAll('img').length,
    imageLinks: article.querySelectorAll('a.image-link').length,
    noteLinks: article.querySelectorAll('button.notelink').length,
    // The app DID pass a resolver, so here they must be live — the mirror of
    // `bench/share.mjs`, where the viewer passes none and they must be inert.
    noteLinksLive: [...article.querySelectorAll('button.notelink')].every(
      (b) => !b.disabled && b.getAttribute('data-note'),
    ),
    safeTargets: [...article.querySelectorAll('a[href^="http"]')].every(
      (a) => a.target === '_blank' && a.rel.includes('noopener'),
    ),
  };
});

await page.screenshot({ path: resolve(outDir, 'split.png') });
await page.click('.view-switch button[aria-label="Preview only"]');
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(outDir, 'preview.png') });

// --- a mermaid fence becomes a diagram -------------------------------------
// Last, and on its own note text, so mermaid's chunks never sit inside the
// timings above. What it gates is that the diagram draws at all under the real
// CSP (a violation lands in `errors`), that mermaid's markup was adopted with
// no `<foreignObject>` in it, and that a theme change redraws it.
await page.click('.view-switch button[aria-label="Editor only"]');
await page.evaluate((text) => {
  const content = document.querySelector('.cm-content');
  content.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, text);
}, '# Diagram\n\n```mermaid\nflowchart LR\n  A[Write] --> B{Sealed?}\n  B --> C[(Sync)]\n```\n');
await page.click('.view-switch button[aria-label="Preview only"]');
const diagramDrawn = await page
  .waitForSelector('.markdown pre.mermaid.drawn svg', { timeout: 15_000 })
  .then(() => true, () => false);
const firstFill = await page.evaluate(() => getComputedStyle(document.querySelector('.markdown pre.mermaid svg .node rect, .markdown pre.mermaid svg .node polygon')).fill);
await page.evaluate(() => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
});
const redrawn = await page
  .waitForFunction(
    (before) => {
      const shape = document.querySelector('.markdown pre.mermaid svg .node rect, .markdown pre.mermaid svg .node polygon');
      return shape && getComputedStyle(shape).fill !== before;
    },
    firstFill,
    { timeout: 10_000 },
  )
  .then(() => true, () => false);
results.diagram = await page.evaluate(() => ({
  foreignObjects: document.querySelectorAll('.markdown foreignObject').length,
  errorShown: document.querySelectorAll('.markdown .mermaid-error').length,
}));
results.diagram.drawn = diagramDrawn;
results.diagram.redrawnOnTheme = redrawn;
await page.screenshot({ path: resolve(outDir, 'diagram.png') });

await context.close();
await browser.close();
await server.close();

const checks = [
  ['split keystroke p95 (ms)', typing.p95, BUDGETS.splitKeystrokeP95Ms],
  ['preview catch-up (ms)', typing.catchUpMs, BUDGETS.catchUpMs],
  ['open split on 50 KB note (ms)', results.openLargeNoteMs, BUDGETS.openLargeNoteMs],
  ['long tasks while typing', typing.longTasks.length, BUDGETS.longTasksWhileTyping],
];
const failures = checks.filter(([, actual, budget]) => actual == null || actual > budget);

const problems = [...errors];
// Exact, not a floor: every character typed must land on the line the caret was
// put on. A floor of 100 is what let the measurement above drift unnoticed.
if (!results.structure.noteLinks) problems.push('the preview rendered no note links');
if (!results.structure.noteLinksLive) {
  problems.push('a note link is inert in the app, which does have somewhere to navigate');
}
if (typing.inserted !== typing.typed) {
  problems.push(
    `typing inserted ${typing.inserted} of ${typing.typed} chars on the first line; ` +
      'input is not reaching the caret',
  );
}
if (remoteImageRequests.length) problems.push(`preview fetched remote images: ${remoteImageRequests[0]}`);
if (!results.structure.headings || !results.structure.tables) problems.push('preview did not render the note');
if (!results.structure.highlighted) problems.push('code fences were not highlighted');
if (results.structure.images) problems.push('remote images rendered as <img>');
if (!results.structure.safeTargets) problems.push('external links lack target/rel');
if (!results.diagram.drawn) problems.push('a mermaid fence was not drawn as a diagram');
if (results.diagram.errorShown) problems.push('a valid mermaid fence showed an error');
if (results.diagram.foreignObjects) problems.push('a diagram carries <foreignObject> into the page');
if (!results.diagram.redrawnOnTheme) problems.push('a diagram kept its colours across a theme change');

writeFileSync(
  resolve(here, 'results-preview.json'),
  JSON.stringify({ budgets: BUDGETS, results, failures: failures.map((f) => f[0]), problems }, null, 2),
);

console.table(
  checks.map(([check, actual, budget]) => ({
    check,
    actual: actual ?? 'n/a',
    budget,
    verdict: actual == null || actual > budget ? 'FAIL' : 'pass',
  })),
);
console.log('Structure:', results.structure);
console.log('Diagram:', results.diagram);
console.log(`Screenshots: ${outDir}/split.png, preview.png`);

if (problems.length) {
  console.error(`\nProblems (${problems.length}):`);
  for (const p of problems.slice(0, 10)) console.error('  ' + p);
}
if (failures.length || problems.length) process.exit(1);
