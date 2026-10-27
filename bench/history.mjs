/**
 * Note history: behavioural checks in a real browser.
 *
 * The unit tests cover the capture policy, retention and the diff with an
 * in-memory store. What they cannot stand on is the one boundary the design
 * depends on: that a read issued *before* `putNotes` sees the row as it was, so
 * a version really is the text the save replaced. IndexedDB promises this —
 * a read-write transaction waits for every overlapping transaction created
 * before it — and this harness checks the browser keeps the promise, both as a
 * bare primitive and end to end through the app.
 *
 * Then the user-visible flows: a version appears after a new editing session,
 * restoring it replaces the text, Undo puts it back, and a deleted note comes
 * back both from the flash and from Recently deleted.
 */
import { chromium } from 'playwright';
import { enterApp } from './lib/app.mjs';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-history');

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5187, strictPort: true } });
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
    check(name, false, String(err).split('\n')[0].slice(0, 160));
  }
}

const SAVE_MS = 2_600; // write scheduler: 150 ms idle, 2 s ceiling
const editorText = (page) => page.locator('.tile .cm-content').first().innerText();

const versionCount = (page) =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const open = indexedDB.open('teksto-history');
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('versions')) return res(0);
          const r = db.transaction('versions').objectStore('versions').count();
          r.onsuccess = () => {
            db.close();
            res(r.result);
          };
        };
      }),
  );

await scenario('read-before-write ordering', async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'load' });
  const seen = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ordering-probe', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res) => {
      const tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').put('old', 'k');
      tx.oncomplete = res;
    });
    // The shape of `#persist`: read issued, then an await on real async work
    // (encryption), then the write transaction opens.
    const read = new Promise((res) => {
      const r = db.transaction('s').objectStore('s').get('k');
      r.onsuccess = () => res(r.result);
    });
    await crypto.subtle.digest('SHA-256', new Uint8Array(1 << 20));
    await new Promise((res) => {
      const tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').put('new', 'k');
      tx.oncomplete = res;
    });
    const value = await read;
    db.close();
    indexedDB.deleteDatabase('ordering-probe');
    return value;
  });
  check('a read issued before a write sees the old row', seen === 'old', `saw ${seen}`);
  await page.close();
});

const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e}`));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));
page.on('dialog', (d) => void d.accept());

await scenario('a new editing session keeps the previous text', async () => {
  await enterApp(page, base);
  await page.click('header.topbar .primary');
  await page.waitForTimeout(300);
  await page.keyboard.type('# History probe\n\nfirst draft');
  await page.waitForTimeout(SAVE_MS);
  check('no version for a brand-new note', (await versionCount(page)) === 0);

  // A reload is a new page, so the next save starts a session.
  await page.reload({ waitUntil: 'load' });
  await enterApp(page, base);
  await page.waitForTimeout(400);
  await page.click('.tile .cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nsecond draft');
  await page.waitForTimeout(SAVE_MS + 600);
  check('one version after the second session', (await versionCount(page)) === 1, `${await versionCount(page)}`);
  check('typing survived', (await editorText(page)).includes('second draft'));
});

await scenario('history panel: compare, restore, undo', async () => {
  await page.click('.tile-history');
  await page.waitForSelector('[aria-labelledby="history-title"] .row[aria-selected="true"]');
  await page.waitForSelector('.diff .line.added', { timeout: 5_000 });
  const added = await page.locator('.diff .line.added').allInnerTexts();
  check('Changes shows what was added since', added.some((t) => t.includes('second draft')), added.join('|'));

  await page.click('[aria-labelledby="history-title"] .actions .primary');
  await page.waitForSelector('[aria-labelledby="history-title"]', { state: 'detached' });
  await page.waitForTimeout(300);
  const restored = await editorText(page);
  check('restore replaces the text', restored.includes('first draft') && !restored.includes('second draft'), restored);

  await page.click('.flash-action');
  await page.waitForTimeout(400);
  check('Undo brings the replaced text back', (await editorText(page)).includes('second draft'));

  await page.waitForTimeout(SAVE_MS);
  await page.click('.tile-history');
  await page.waitForSelector('[aria-labelledby="history-title"] .badge', { timeout: 5_000 });
  const badges = await page.locator('[aria-labelledby="history-title"] .badge').allInnerTexts();
  check('the restore kept a "Before restore" version', badges.includes('Before restore'), badges.join('|'));
  await page.keyboard.press('Escape');
});

/**
 * Delete from a note row. The row itself only carries the pin and `⋯` now, so
 * deleting is two clicks: the menu, then its Delete.
 */
async function deleteNoteRow(title) {
  const row = page.locator('.row-wrap', { hasText: title }).first();
  await row.hover();
  await row.locator('.row-action.more').click();
  await page.waitForSelector('[role="dialog"] button');
  await page.locator('[role="dialog"] button', { hasText: 'Delete' }).click();
}

await scenario('delete: Undo and Recently deleted', async () => {
  const title = 'History probe';
  await deleteNoteRow(title);
  await page.waitForSelector('.flash-action');
  check('the note left the list', (await page.locator('.row-wrap', { hasText: title }).count()) === 0);

  await page.click('.flash-action');
  await page.waitForSelector(`.row-wrap:has-text("${title}")`, { timeout: 5_000 });
  check('Undo restores the note with its latest text', (await editorText(page)).includes('second draft'));

  await page.waitForTimeout(500);
  await deleteNoteRow(title);
  await page.waitForTimeout(500);

  await page.click('button[aria-label="Recently deleted notes"]');
  await page.waitForSelector('[aria-labelledby="deleted-title"] .row');
  const listed = await page.locator('[aria-labelledby="deleted-title"] .row .title').allInnerTexts();
  check('Recently deleted lists it', listed.includes(title), listed.join('|'));
  await page.waitForSelector('[aria-labelledby="deleted-title"] .plain');
  check(
    'Recently deleted shows its text',
    (await page.locator('[aria-labelledby="deleted-title"] .plain').innerText()).includes('second draft'),
  );

  await page.click('[aria-labelledby="deleted-title"] .actions .primary');
  await page.waitForSelector(`.row-wrap:has-text("${title}")`, { timeout: 5_000 });
  await page.waitForTimeout(SAVE_MS);
  await page.reload({ waitUntil: 'load' });
  await enterApp(page, base);
  await page.waitForTimeout(500);
  check('the restored note survives a reload', (await page.locator('.row-wrap', { hasText: title }).count()) === 1);
});

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
await server.close();

console.table(results);
if (failures.length > 0) {
  console.error(`\n${failures.length} history check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nNote history: all checks passed.');
