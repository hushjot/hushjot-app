/**
 * Phase 2 verification: persistence, search, and the §25 reliability scenarios.
 *
 * These are behavioural checks rather than latency budgets — they answer
 * "does the user's text survive?", which §25 ranks above every optimisation.
 *
 * Each scenario is isolated: one failure records itself and the rest still run,
 * so a single break never hides the state of everything else.
 */
import { chromium } from 'playwright';
import { enterApp } from './lib/app.mjs';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-phase2');

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5183, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];
const pageErrors = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err).split('\n')[0].slice(0, 120));
  }
}

async function newPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e}`));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));
  return page;
}

/** Load the app and wait until the editor is live. */
async function openApp(context) {
  const page = await newPage(context);
  await enterApp(page, base);
  await page.waitForTimeout(350);
  return page;
}

/**
 * Each stored note body's size in bytes, straight out of IndexedDB.
 *
 * Two things make the naive assertions wrong here:
 *
 * - `.cm-content`'s textContent only holds the *rendered* viewport, so text
 *   scrolled out of view is simply not in the DOM.
 * - Since Phase 3 the stored bodies are ciphertext, so grepping them for a
 *   plaintext marker can never succeed — and if it ever did, that would be a
 *   catastrophic failure rather than a passing test.
 *
 * So persistence is asserted two ways instead: the derived **title** reaching
 * the note list proves the content round-tripped through encryption, and the
 * ciphertext **growing** proves the note was appended to rather than replaced.
 *
 * ## Measure `byteLength`, never `String(bytes).length`
 *
 * A stored body is a `Uint8Array`, and `String(new Uint8Array([1, 200]))` is
 * `"1,200"` — the decimal rendering, whose length depends on how many bytes
 * happen to be three digits rather than one. This originally compared those
 * string lengths, and since AES-GCM re-randomises every byte on each save
 * (fresh nonce), the two measurements were independent draws with a spread of
 * roughly ±47 characters on a note this size — against a signal of ~86 for the
 * marker being typed. That is a one-in-ten failure for a check that is
 * deterministic when it counts bytes: the envelope is length-preserving, so
 * appending n characters always adds exactly n bytes.
 */
const bodySizes = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('teksto');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('noteBody').objectStore('noteBody').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            db.close();
            // A legacy pre-Phase-3 row is still a plaintext string; everything
            // written since is ciphertext bytes.
            resolve(
              req.result.map((r) => (typeof r.body === 'string' ? r.body.length : r.body.byteLength)),
            );
          };
        };
      }),
  );

/**
 * Ask the app's own search whether a marker survived.
 *
 * Stronger than inspecting the DOM or the database: a hit means the text was
 * persisted, encrypted, decrypted again by the search worker, and indexed. It
 * also sidesteps keyboard-navigation differences between platforms — an
 * earlier version of this used Ctrl+Home to place the marker on line 1, which
 * silently does nothing in CodeMirror on macOS.
 */
async function findsInSearch(page, marker) {
  await page.waitForTimeout(900); // let the worker finish its index build
  await openFinder(page);
  await page.keyboard.type(marker);
  await page.waitForTimeout(400);
  const hits = await page.locator('.result').count();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });
  return hits > 0;
}

/** Largest body in the database — a proxy for "the welcome note is intact". */
const longestBody = async (page) =>
  (await bodySizes(page)).reduce((max, size) => Math.max(max, size), 0);

/** Open the finder and confirm its input actually holds focus. */
async function openFinder(page) {
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette');
  await page.waitForFunction(
    () => document.activeElement?.classList.contains('input') === true,
    null,
    { timeout: 5000 },
  );
}

// One persistent context keeps IndexedDB alive across page loads, which is the
// entire point of these checks.
const context = await browser.newContext();

await scenario('seed + reload', async () => {
  const page = await openApp(context);
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length >= 2);
  check('first run seeds notes', (await page.locator('.list .row').count()) >= 2);

  const lengthBefore = await longestBody(page);

  const marker = `persisted${Date.now()}`;
  await page.click('.cm-content');
  await page.keyboard.type(` ${marker} `);

  await page.waitForTimeout(600); // past the idle debounce
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(400);

  check('typed text survives a reload', await findsInSearch(page, marker));

  // The note must have *grown*, not been replaced. This is the regression
  // guard for the bug where an editor mounted before its body loaded
  // persisted its empty document over the real text.
  const lengthAfter = await longestBody(page);
  check(
    'existing note text is not clobbered by an edit',
    lengthAfter > lengthBefore,
    `ciphertext ${lengthBefore} -> ${lengthAfter} bytes`,
  );
  await page.close();
});

await scenario('teardown flush', async () => {
  const page = await openApp(context);
  const marker = `flushed${Date.now()}`;
  await page.click('.cm-content');
  await page.keyboard.type(` ${marker} `);

  // Leave well inside the debounce window: only the pagehide flush can save
  // this text (§25, "user types and immediately closes tab").
  await page.waitForTimeout(60);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(500);

  check('pagehide flush saves text typed just before unload', await findsInSearch(page, marker));
  await page.close();
});

await scenario('new note persistence', async () => {
  const page = await openApp(context);
  const before = await page.locator('.list .row').count();

  await page.click('button.primary');
  await page.waitForTimeout(250);

  const marker = `brandnew${Date.now()}`;
  await page.keyboard.type(`# ${marker}`);
  await page.waitForTimeout(600);

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(400);

  const after = await page.locator('.list .row').count();
  check('new note persists across reload', after === before + 1, `${before} -> ${after}`);

  const titles = await page.locator('.list .title').allTextContents();
  check('derived title reaches the note list', titles.some((t) => t.includes(marker)));
  await page.close();
});

await scenario('finder content search', async () => {
  const page = await openApp(context);
  await page.waitForTimeout(700); // let the worker finish its index build

  await openFinder(page);
  // "customers" appears only inside the SQL fence in the welcome note body,
  // never in a title — so a hit proves content is indexed.
  await page.keyboard.type('customers');
  await page.waitForTimeout(350);

  const hits = await page.locator('.result .title').allTextContents();
  check('finder matches note content, not just titles', hits.length > 0, `hits: ${hits.length}`);

  await page.keyboard.press('Enter');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });
  check('Enter opens the highlighted result', true);
  await page.close();
});

await scenario('finder narrowing', async () => {
  const page = await openApp(context);
  await page.waitForTimeout(700);

  await openFinder(page);
  await page.keyboard.type('note');
  await page.waitForTimeout(300);
  const broad = await page.locator('.result').count();

  await page.keyboard.type(' zzzznotarealword');
  await page.waitForTimeout(300);
  const narrow = await page.locator('.result').count();

  check('extra terms narrow the result set', broad > 0 && narrow === 0, `${broad} -> ${narrow}`);

  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });
  check('Escape closes the finder', true);
  await page.close();
});

await scenario('finder keyboard navigation', async () => {
  const page = await openApp(context);
  await page.waitForTimeout(700);

  await openFinder(page);
  // Empty query lists recent notes, so navigation has something to move over.
  const count = await page.locator('.result').count();
  check('empty query lists recent notes', count > 1, `${count} rows`);

  const firstActive = await page.locator('.result.active .title').textContent();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  const secondActive = await page.locator('.result.active .title').textContent();

  check('ArrowDown moves the highlight', firstActive !== secondActive, `${firstActive} -> ${secondActive}`);

  await page.keyboard.press('Escape');
  await page.close();
});

await scenario('cold-load search', async () => {
  const page = await openApp(context);
  await page.waitForTimeout(900); // index rebuilds from IndexedDB, not memory

  await openFinder(page);
  await page.keyboard.type('docker');
  await page.waitForTimeout(350);

  const hits = await page.locator('.result').count();
  check('search works after a cold load', hits > 0, `hits: ${hits}`);
  await page.close();
});

await context.close();
await browser.close();
await server.close();

console.log('');
console.table(results);

if (pageErrors.length) {
  console.error(`\nPage/console errors (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 10)) console.error('  ' + e);
}

if (failures.length || pageErrors.length) {
  console.error(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nAll Phase 2 checks pass.\n');
