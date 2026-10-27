/**
 * Quick capture — a correctness gate, not a budget.
 *
 * Like `bench:share` and `bench:vault`, what this checks has no meaning
 * outside a real browser: the claim is about a service worker, a POST that no
 * `fetch()` in a test can stand in for, and what is and is not left behind
 * afterwards. Six things, and each one has already been wrong somewhere in a
 * design like this:
 *
 *   1. the manifest declares a **POST** share target inside the app's scope.
 *      A `GET` target works just as well and puts the user's note in a query
 *      string — the address bar, session history, and Hosting's access log.
 *      That regression would be invisible in every other test here;
 *   2. a share from *outside the origin* — which is what the OS share sheet
 *      is — becomes a note with the composed body, open in the editor. The
 *      form is submitted from `about:blank` because our own pages cannot do
 *      it: `firebase.json` sets `form-action 'none'`;
 *   3. nothing is left in the URL afterwards, so a reload cannot re-submit
 *      someone's note;
 *   4. **nothing plaintext is left on disk.** The worker holds the share in
 *      memory on purpose (`src/sw.js`), and "in memory" is one refactor away
 *      from "in the Cache API". The shared text must appear in no cache entry
 *      and in no IndexedDB record — the note itself is there, encrypted;
 *   5. the iOS arm — a `c1.` fragment — produces the same note, and a
 *      malformed one produces nothing at all rather than half a note;
 *   6. the handoff survives an unlock. The worker's copy is claimed at boot
 *      and held by the page, because a passphrase takes as long as it takes.
 *
 * Built in production mode, unlike `bench:share`: `registerServiceWorker()`
 * returns early unless `import.meta.env.PROD`, so a development build would
 * test none of this and still pass.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-capture');

const PASSPHRASE = 'a sufficiently long passphrase';
/** Distinctive enough that finding it in a cache or a database means something. */
const SECRET = 'quokka-zeppelin-marzipan-7413'; // gitleaks:allow (a planted fake)

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5196, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];

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

/** Wait until a service worker is not just registered but controlling. */
const swReady = (page) =>
  page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });

/**
 * What the Android share sheet does, as exactly as a browser can be made to do
 * it: a cross-origin, top-level, multipart POST to the manifest's action.
 */
async function shareTo(page, fields) {
  await page.goto('about:blank');
  await page.evaluate(
    ({ action, fields }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.enctype = 'multipart/form-data';
      form.action = action;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
    },
    { action: `${base}/capture`, fields },
  );
}

const editorHas = (page, needle) =>
  page.waitForFunction(
    (text) => (document.querySelector('.cm-content')?.textContent ?? '').includes(text),
    needle,
    { timeout: 30_000 },
  );

async function createVault(page, { remember = true } = {}) {
  await page.goto(base, { waitUntil: 'load' });
  await chooseStart(page, 'device');
  await page.waitForSelector('#new-pass', { timeout: 20_000 });
  await page.fill('#new-pass', PASSPHRASE);
  await page.fill('#confirm-pass', PASSPHRASE);
  if (!remember) await page.uncheck('.check input');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.code', { timeout: 40_000 });
  await page.check('.check input');
  await page.click('button.primary');
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
}

// --- 1. the manifest ------------------------------------------------------
await scenario('the share target is declared', async () => {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  const target = manifest.share_target;

  check('the manifest declares a share target', Boolean(target));
  check(
    'the share target is a POST',
    target?.method?.toUpperCase() === 'POST',
    `method ${target?.method} — a GET target puts the note in a query string`,
  );
  check('it is multipart, as POST requires', target?.enctype === 'multipart/form-data', String(target?.enctype));
  check(
    'the action is inside the app scope',
    typeof target?.action === 'string' && target.action.startsWith(manifest.scope ?? '/'),
    `${target?.action} vs scope ${manifest.scope}`,
  );
  check(
    'it asks for title, text and url',
    ['title', 'text', 'url'].every((field) => target?.params?.[field] === field),
    JSON.stringify(target?.params),
  );
});

// --- 2-5. an unlocked device ---------------------------------------------
await scenario('capture on an unlocked device', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 120)));

  await createVault(page);
  await swReady(page);

  // --- 2. the Android arm ------------------------------------------------
  await shareTo(page, {
    title: 'A shared headline',
    text: `${SECRET} is the body of the share.`,
    url: 'https://example.com/shared',
  });

  await editorHas(page, SECRET);
  check('a share from the OS becomes an open note', true);

  const body = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
  check('the title became a heading', body.includes('# A shared headline'), body.slice(0, 80));
  check('the url was appended', body.includes('https://example.com/shared'));

  const flash = await page.locator('.flash').first().textContent();
  check('the capture is undoable', /Captured/.test(flash ?? '') && /Undo/.test(flash ?? ''), flash ?? 'no flash');

  // --- 3. nothing left in the URL ----------------------------------------
  const where = await page.evaluate(() => location.pathname + location.search + location.hash);
  check('the address bar is back to /', where === '/', where);

  // --- 4. nothing plaintext on disk --------------------------------------
  const cacheHits = await page.evaluate(async (needle) => {
    const hits = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname === '/capture') hits.push(`entry ${request.url}`);
        const response = await cache.match(request);
        const text = await response.clone().text().catch(() => '');
        if (text.includes(needle)) hits.push(`body of ${request.url}`);
      }
    }
    return hits;
  }, SECRET);
  check('the share is in no cache entry', cacheHits.length === 0, cacheHits.slice(0, 2).join(' | '));

  // The note is on disk — it is a note. It must be there as ciphertext, which
  // is the whole point of routing a capture through the vault rather than
  // parking it anywhere convenient.
  const dbHits = await page.evaluate(async (needle) => {
    const db = await new Promise((res, rej) => {
      const request = indexedDB.open('teksto');
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    });
    const decoder = new TextDecoder();
    const hits = [];
    for (const store of ['noteMeta', 'noteBody']) {
      if (!db.objectStoreNames.contains(store)) continue;
      const rows = await new Promise((res, rej) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => res(request.result);
        request.onerror = () => rej(request.error);
      });
      for (const row of rows) {
        for (const value of Object.values(row)) {
          const bytes = value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer) : null;
          const text = bytes ? decoder.decode(bytes) : typeof value === 'string' ? value : '';
          if (text.includes(needle)) hits.push(`${store}/${row.id}`);
        }
      }
    }
    db.close();
    return hits;
  }, SECRET);
  check('the captured note is stored as ciphertext', dbHits.length === 0, dbHits.slice(0, 2).join(' | '));

  // --- 5. the iOS arm ----------------------------------------------------
  const before = await page.locator('.list .row').count();
  const iosText = `${SECRET} from a Shortcut. Dots. And. More.`;
  await page.goto(`${base}/#c1.${encodeURIComponent(iosText)}`, { waitUntil: 'load' });
  await editorHas(page, 'from a Shortcut');
  check('a capture fragment becomes a note', true);
  check(
    'every dot after the first survives',
    (await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')).includes('Dots. And. More.'),
  );
  const afterIos = await page.evaluate(() => location.pathname + location.hash);
  check('the fragment is cleared', afterIos === '/', afterIos);

  const counted = await page.locator('.list .row').count();
  check('exactly one note was added', counted === before + 1, `${before} → ${counted}`);

  // A fragment nobody can read must produce nothing, not half a note.
  await page.goto(`${base}/#c1.%E0%A4%A`, { waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await page.waitForTimeout(500);
  const afterBad = await page.locator('.list .row').count();
  check('a malformed fragment creates nothing', afterBad === counted, `${counted} → ${afterBad}`);

  check('no page errors throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

  await context.close();
});

// --- 6. the handoff survives an unlock -----------------------------------
await scenario('capture on a locked device', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await createVault(page, { remember: false });
  await swReady(page);

  await shareTo(page, { text: `${SECRET} while locked` });

  // The claim happens at boot, before any of this — which is the point.
  await chooseStart(page, 'device');
  await page.waitForSelector('#pass', { timeout: 30_000 });
  check('a share arriving at a locked vault shows the unlock screen', true);

  await page.fill('#pass', PASSPHRASE);
  await page.click('button[type="submit"]');

  await editorHas(page, `${SECRET} while locked`);
  check('the share is written once the vault is open', true);

  await context.close();
});

await browser.close();
await server.close();

console.log('');
console.table(results);

if (failures.length) {
  console.error(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nAll quick-capture checks pass.\n');
