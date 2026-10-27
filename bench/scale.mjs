/**
 * Scale benchmark: does the assembled app still meet Spike 3's budgets?
 *
 * Spike 3 measured the storage layout in isolation (41 ms to an interactive
 * list at 10,000 notes). This seeds the real database and measures the real
 * app, which additionally pays for Svelte, the virtualized list, the search
 * worker and the editor.
 *
 * §27 asks for 100 / 1,000 / 10,000-note datasets, so all three run.
 */
import { chromium } from 'playwright';
import { enterApp, seedEncryptedNotes } from './lib/app.mjs';
import { build, preview } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-scale');

const SIZES = [100, 1000, 10_000];
const BUDGETS = {
  startupMs: 1500,
  listDomNodes: 60,
  noteOpenP95Ms: 50,
  searchP95Ms: 50,
  keystrokeP95Ms: 16,
  /**
   * Reload to the sidebar's Tags section: the index has decrypted and read
   * every body. 941 ms at 10,000 notes when this was added.
   */
  tagsReadyMs: 3000,
  tagFilterP95Ms: 50,
  tagSearchP95Ms: 50,
  /** `in:folder` — a filter over a map the query already walks, so no slower. */
  scopedSearchP95Ms: 50,
  /**
   * `"exact phrase"` gets its own budget, an order of magnitude larger, because
   * it is the one query that does I/O: the index cannot judge adjacency without
   * positions, and storing those would let it reconstruct a note, so the worker
   * re-reads and decrypts candidate bodies instead (`core/search/phrase.ts`).
   * Bounded by VERIFY_MAX and by an early exit at the caller's limit, which is
   * what keeps the measured number (25 ms at 10,000 notes) in the same class as
   * every other query. The budget is deliberately far above that rather than
   * close to it: the point is to catch either bound being lost — walking the
   * collection instead of stopping would be seconds, not milliseconds — not to
   * police frame-level noise on a slower machine.
   */
  phraseSearchP95Ms: 200,
  /**
   * `[[` completion: fifteen characters typed into an open popup, each of which
   * makes `wikiLinkCompletion` walk every title in the collection. Generous on
   * purpose, and for the reason the phrase budget gives — the point is to catch
   * the cheap `startsWith`/`includes` pre-filter being replaced by something
   * that scores 10,000 titles properly, which would be seconds rather than
   * milliseconds, not to police frame noise on a slower machine.
   */
  linkCompletionMs: 1000,
};

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5187, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const rows = [];
const failures = [];

const percentile = (samples, p) => {
  const s = [...samples].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2);
};

for (const size of SIZES) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Create the vault first: the seeder encrypts with the device key the app
  // stores on unlock, so seeded notes are indistinguishable from real ones.
  await enterApp(page, base);
  await page.waitForTimeout(300);
  await seedEncryptedNotes(page, size, { folders: true });

  // Reload uses the remembered device key, so this measures the everyday
  // startup path rather than a passphrase derivation.
  const startedAt = Date.now();
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.list .row', { timeout: 30_000 });
  const startupMs = Date.now() - startedAt;
  const firstRowPinned = (await page.locator('.list .row').first().locator('.pin-mark').count()) > 0;

  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(200);

  const domNodes = await page.locator('.list .row').count();

  // --- note open latency, driven through the UI ---------------------------
  const openSamples = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('.list .row')];
    const samples = [];
    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const t = performance.now();
      rows[i % rows.length].click();
      await new Promise(requestAnimationFrame);
      document.querySelector('.cm-content')?.offsetHeight;
      samples.push(performance.now() - t);
    }
    return samples;
  });

  // --- the index build, seen from the sidebar ------------------------------
  await page.waitForSelector('#sidebar-tags', { timeout: 30_000 });
  const tagsReadyMs = Date.now() - startedAt;

  // --- tag filter latency: click to a rendered, filtered list -------------
  const tagFilterSamples = await page.evaluate(async () => {
    const samples = [];
    const buttons = [...document.querySelectorAll('#sidebar-tags button.folder')].slice(0, 25);
    for (const button of buttons) {
      const label = button.getAttribute('title');
      const t = performance.now();
      button.click();
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const heading = document.querySelector('.section.grow h2')?.textContent?.trim();
        if (heading === label && document.querySelector('.list .row')) break;
      }
      samples.push(performance.now() - t);
    }
    document.querySelector('.folders .folder')?.click(); // back to All notes
    return samples;
  });

  // --- search latency, end to end through the worker ----------------------
  const searchSamples = await page.evaluate(async () => {
    const samples = [];
    const terms = ['post', 'docker', 'hostname', 'token', 'rust'];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      // Drive the real palette input so the measurement includes the worker
      // round trip and the Svelte re-render, not just the index lookup.
      const input = document.querySelector('.palette .input');
      if (!input) return samples;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, terms[i % terms.length] + (i % 3));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise(requestAnimationFrame);
      samples.push(performance.now() - t);
    }
    return samples;
  });

  // The palette must be open for the search measurement above.
  const searchReady = searchSamples.length > 0;
  let realSearch = searchSamples;
  if (!searchReady) {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.palette');
    realSearch = await page.evaluate(async () => {
      const samples = [];
      const terms = ['post', 'docker', 'hostname', 'token', 'rust'];
      const input = document.querySelector('.palette .input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (let i = 0; i < 25; i++) {
        const t = performance.now();
        setter.call(input, terms[i % terms.length] + (i % 3));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise(requestAnimationFrame);
        samples.push(performance.now() - t);
      }
      return samples;
    });
    await page.keyboard.press('Escape');
  }

  // --- `#tag term` search through the palette ------------------------------
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette');
  const tagSearchSamples = await page.evaluate(async () => {
    const samples = [];
    const input = document.querySelector('.palette .input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      setter.call(input, `#t${(i * 7) % 200} note`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise(requestAnimationFrame);
      samples.push(performance.now() - t);
    }
    return samples;
  });
  await page.keyboard.press('Escape');

  // --- `in:folder` scoping through the palette -----------------------------
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette');
  const scopedSearchSamples = await page.evaluate(async () => {
    const samples = [];
    const input = document.querySelector('.palette .input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const terms = ['postgres', 'docker', 'rust', 'redis', 'nginx'];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      setter.call(input, `in:Work ${terms[i % terms.length]}`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise(requestAnimationFrame);
      samples.push(performance.now() - t);
    }
    return samples;
  });
  // A latency number over an empty result list measures nothing, and the folder
  // fixture is easy to break without noticing (a seeded folder that never lands
  // leaves `in:` matching nothing while every timing still passes).
  const scopedHits = await page.evaluate(
    () => document.querySelectorAll('.palette .results li:not(.empty)').length,
  );
  await page.keyboard.press('Escape');

  // --- `"exact phrase"` through the palette --------------------------------
  //
  // This one waits for the results to actually change, and the others do not.
  // The difference is real: every other query is answered from memory inside a
  // frame, while a phrase sends the worker off to decrypt candidate bodies. A
  // sample that stopped at the next rAF — as the blocks above do — would record
  // main-thread responsiveness, pass unconditionally, and gate nothing.
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette');
  const phraseResult = await page.evaluate(async () => {
    const samples = [];
    const input = document.querySelector('.palette .input');
    const list = document.querySelector('.palette .results');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    const settled = () =>
      new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => resolve(true));
        });
        observer.observe(list, { childList: true, subtree: true });
        // A query that changes nothing on screen must not hang the bench.
        setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, 5000);
      });

    let timedOut = false;
    for (let i = 0; i < 15; i++) {
      // The two phrases are planted in disjoint notes, so every query really
      // does replace the list — an alternation that returned the same rows
      // would render nothing and never settle.
      const query = i % 2 === 0 ? '"connection pool"' : '"cache warms slowly"';
      const t = performance.now();
      const wait = settled();
      setter.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!(await wait)) timedOut = true;
      samples.push(performance.now() - t);
    }
    return { samples, timedOut };
  });
  const phraseSearchSamples = phraseResult.samples;
  const phraseHits = await page.evaluate(
    () => document.querySelectorAll('.palette .results li:not(.empty)').length,
  );
  await page.keyboard.press('Escape');

  // --- typing latency with the full collection loaded ---------------------
  const keySamples = await page.evaluate(async () => {
    const content = document.querySelector('.cm-content');
    if (!content) return [];
    content.focus();
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      document.execCommand('insertText', false, 'x');
      content.offsetHeight;
      samples.push(performance.now() - t);
      await new Promise(requestAnimationFrame);
    }
    return samples;
  });

  // --- the `[[` completion over the whole collection ------------------------
  //
  // Its own measurement rather than a case in the keystroke loop above, because
  // the cost is a different cost and it is NOT on the typing path: CodeMirror
  // debounces the completion off the keystroke, so timing `insertText` would
  // record nothing and pass unconditionally — the same trap the phrase block
  // below documents. What this times is what the user waits for: from the last
  // character typed to a ranked list on screen, with `wikiLinkCompletion`
  // having filtered every title in the vault to get there.
  const linkCompletion = await page.evaluate(async () => {
    const content = document.querySelector('.cm-content');
    if (!content) return { ms: null, options: 0 };
    content.focus();

    const options = () => document.querySelectorAll('.cm-tooltip-autocomplete li').length;
    const settled = async (deadlineMs) => {
      const until = performance.now() + deadlineMs;
      while (performance.now() < until) {
        if (options() > 0) return true;
        await new Promise(requestAnimationFrame);
      }
      return false;
    };

    // Open it on a bare `[[` first and let it settle, so the number below is a
    // re-rank and not a first paint of the tooltip.
    document.execCommand('insertText', false, '\n[[');
    if (!(await settled(5000))) return { ms: null, options: 0 };
    const before = options();

    // A prefix every seeded title shares down to the last character: titles are
    // `<topic> note <n>`, so this narrows thousands of rows to a handful and
    // every intermediate query still matches something. A query that matched
    // nothing would close the popup and time a disappearance.
    const t = performance.now();
    for (const ch of 'postgres note 4'.split('')) {
      document.execCommand('insertText', false, ch);
      await new Promise(requestAnimationFrame);
    }
    const ok = await settled(5000);
    return { ms: ok ? Math.round(performance.now() - t) : null, options: options(), before };
  });
  await page.keyboard.press('Escape');

  const heapMB = await page.evaluate(() =>
    performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
  );

  const row = {
    notes: size,
    startupMs,
    listDomNodes: domNodes,
    noteOpenP95: percentile(openSamples, 95),
    searchP95: realSearch.length ? percentile(realSearch, 95) : null,
    keystrokeP95: keySamples.length ? percentile(keySamples, 95) : null,
    linkCompletionMs: linkCompletion.ms,
    tagsReadyMs,
    tagFilterP95: tagFilterSamples.length ? percentile(tagFilterSamples, 95) : null,
    tagSearchP95: tagSearchSamples.length ? percentile(tagSearchSamples, 95) : null,
    scopedSearchP95: scopedSearchSamples.length ? percentile(scopedSearchSamples, 95) : null,
    phraseSearchP95: phraseSearchSamples.length ? percentile(phraseSearchSamples, 95) : null,
    heapMB,
  };
  rows.push(row);

  const assert = (name, actual, budget) => {
    if (actual != null && actual > budget) {
      failures.push(`${size} notes: ${name} ${actual} > ${budget}`);
    }
  };
  assert('startup', row.startupMs, BUDGETS.startupMs);
  assert('list DOM nodes', row.listDomNodes, BUDGETS.listDomNodes);
  assert('note open p95', row.noteOpenP95, BUDGETS.noteOpenP95Ms);
  assert('search p95', row.searchP95, BUDGETS.searchP95Ms);
  assert('keystroke p95', row.keystrokeP95, BUDGETS.keystrokeP95Ms);
  assert('[[ completion', row.linkCompletionMs, BUDGETS.linkCompletionMs);
  assert('tags ready', row.tagsReadyMs, BUDGETS.tagsReadyMs);
  assert('tag filter p95', row.tagFilterP95, BUDGETS.tagFilterP95Ms);
  assert('#tag search p95', row.tagSearchP95, BUDGETS.tagSearchP95Ms);
  assert('in:folder search p95', row.scopedSearchP95, BUDGETS.scopedSearchP95Ms);
  assert('"phrase" search p95', row.phraseSearchP95, BUDGETS.phraseSearchP95Ms);
  // A phrase that matched nothing would make the budget above meaningless —
  // the verifier would be timing an empty loop.
  if (!scopedHits) failures.push(`${size} notes: an in:folder search matched nothing`);
  if (!phraseHits) failures.push(`${size} notes: a phrase search matched nothing`);
  // Without this the budget above would be timing a popup that never opened.
  if (!linkCompletion.options) failures.push(`${size} notes: the [[ completion offered nothing`);
  // A timeout would otherwise be recorded as a slow-but-passing sample.
  if (phraseResult.timedOut) failures.push(`${size} notes: a phrase search never rendered`);
  if (!firstRowPinned) failures.push(`${size} notes: the first row is not a pinned note`);
  if (!tagFilterSamples.length) failures.push(`${size} notes: no tags were listed`);

  if (errors.length) failures.push(`${size} notes: ${errors.length} page errors — ${errors[0]}`);

  console.log(`  ${size} notes → startup ${startupMs}ms, ${domNodes} DOM rows`);
  await context.close();
}

await browser.close();
await server.close();

writeFileSync(resolve(here, 'results-scale.json'), JSON.stringify({ budgets: BUDGETS, rows }, null, 2));

console.log('');
console.table(rows);

if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
console.log('\nAll scale budgets pass.\n');
