/**
 * Phase 6 verification: PWA install, offline cold start, mobile layout.
 *
 * The headline check is the **offline cold start**: kill the network entirely,
 * reload, and require the app to boot and show the user's notes. §17 says the
 * app must be usable offline once loaded, and this is the only test that
 * proves the service worker actually delivers that rather than merely being
 * registered.
 */
import { chromium, devices } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-phase6');

const PASSPHRASE = 'a sufficiently long passphrase';

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5195, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];
let serverClosed = false;

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err).split('\n')[0].slice(0, 140));
  }
}

async function enterVault(page) {
  await chooseStart(page, 'device');
  if (await page.locator('#new-pass').count()) {
    await page.fill('#new-pass', PASSPHRASE);
    await page.fill('#confirm-pass', PASSPHRASE);
    await page.click('.local button[type="submit"]');
    await page.waitForSelector('.code', { timeout: 40_000 });
    await page.check('.check input');
    await page.click('button.primary');
  } else if (await page.locator('#pass').count()) {
    await page.fill('#pass', PASSPHRASE);
    await page.click('.local button[type="submit"]');
  }
  await page.waitForSelector('.list .row', { timeout: 40_000 });
}

/** Wait until a service worker is not just registered but controlling. */
const swReady = (page) =>
  page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null,
    null,
    { timeout: 30_000 },
  );

// --- 1. manifest and icons -----------------------------------------------
await scenario('manifest and icons', async () => {
  const manifestRes = await fetch(`${base}/manifest.webmanifest`);
  check('the manifest is served', manifestRes.ok, `HTTP ${manifestRes.status}`);

  const manifest = await manifestRes.json();
  check('the manifest declares a standalone display mode', manifest.display === 'standalone');
  check('the manifest has a start_url and scope', Boolean(manifest.start_url && manifest.scope));
  check(
    'the manifest has an icon of at least 192px',
    (manifest.icons ?? []).some((i) => /(^|\s)192x192|512x512/.test(i.sizes)),
  );
  check(
    'the manifest has a maskable icon',
    (manifest.icons ?? []).some((i) => i.purpose === 'maskable'),
  );

  for (const icon of manifest.icons ?? []) {
    const res = await fetch(`${base}${icon.src}`);
    if (!res.ok) check(`icon ${icon.src} is served`, false, `HTTP ${res.status}`);
  }
  check('every declared icon is reachable', true);

  const apple = await fetch(`${base}/icons/apple-touch-icon.png`);
  check('the iOS home-screen icon is served', apple.ok, `HTTP ${apple.status}`);
});

// --- 2. the security policy actually reaches the browser -----------------
await scenario('content security policy', async () => {
  const html = await (await fetch(`${base}/index.html`)).text();
  check('a CSP is present in the shell', html.includes('Content-Security-Policy'));
  check("script-src is restricted to 'self'", /script-src &#39;self&#39;|script-src 'self'/.test(html));
  const scriptSrc = (html.replace(/&#39;/g, "'").match(/script-src[^;"]*/) ?? [''])[0];
  check('no unsafe-inline is allowed for scripts', !scriptSrc.includes('unsafe-inline'));
  // Argon2id is WebAssembly, and `WebAssembly.compile` is refused without this
  // token. Dropping it does not break the build or any unit test — it breaks
  // vault creation on the deployed site, and only there. Assert it stays.
  check("WebAssembly is permitted via 'wasm-unsafe-eval'", scriptSrc.includes("'wasm-unsafe-eval'"));
  // ...and that the far broader `'unsafe-eval'` was not reached for instead.
  check(
    'no bare unsafe-eval is allowed for scripts',
    !/(^|\s)'unsafe-eval'/.test(scriptSrc),
  );
});

// --- 3. the *served* policy, which is a different file and a different trap
// The meta tag above governs the document. It does not govern a worker: a
// worker fetched over HTTP takes its policy from its own response headers, so
// what reaches the Argon2id worker comes from firebase.json and nothing here
// can observe it — `vite preview` sends no headers at all. Assert the config.
await scenario('the served header policy', async () => {
  const config = JSON.parse(await readFile(resolve(repoRoot, 'firebase.json'), 'utf8'));
  const blocks = config.hosting.headers;
  const cspOf = (source) =>
    blocks.find((b) => b.source === source)?.headers.find((h) => h.key === 'Content-Security-Policy')?.value;

  const assetCsp = cspOf('/assets/**');
  check('assets are served their own CSP', Boolean(assetCsp));
  check(
    "the worker policy allows 'wasm-unsafe-eval'",
    Boolean(assetCsp?.includes("'wasm-unsafe-eval'")),
    'without it Argon2id cannot compile and no vault can be created',
  );

  // Firebase applies later matching blocks over earlier ones, so the narrow
  // /assets/** block is only effective while it stays after the catch-all.
  const order = blocks.map((b) => b.source);
  check(
    '/assets/** overrides the catch-all (it comes after **)',
    order.indexOf('/assets/**') > order.indexOf('**'),
    `order: ${order.join(' ')}`,
  );

  // The document policy is free to change — index.html is no-cache. The asset
  // policy is not: it is baked into responses cached for a year, so changing
  // it only reaches browsers whose asset URLs also changed.
  const cache = blocks
    .find((b) => b.source === '/assets/**')
    ?.headers.find((h) => h.key === 'Cache-Control')?.value;
  check('assets stay immutably cached', Boolean(cache?.includes('immutable')), cache ?? 'missing');
});

// --- 3b. Subresource Integrity on the shell ------------------------------
// The hash has to match the bytes actually served. A wrong one does not
// degrade gracefully — the browser refuses the script and the app is dead for
// everyone — and it looks exactly like a working plugin until someone loads
// the page. The first version of `tools/vite-plugin-sri.mjs` shipped hashes
// computed from a chunk's pre-write `code`, which was wrong for every file.
await scenario('subresource integrity', async () => {
  const html = await readFile(resolve(outDir, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\/([^"]+)"[^>]*?>/g)];
  const withIntegrity = tags.filter((t) => t[0].includes('integrity='));

  check(
    'the shell entry and stylesheet carry integrity attributes',
    withIntegrity.length >= 2,
    `${withIntegrity.length} of ${tags.length} local tags`,
  );

  for (const tag of withIntegrity) {
    const digest = tag[0].match(/integrity="sha384-([^"]+)"/)?.[1];
    const actual = createHash('sha384')
      .update(await readFile(resolve(outDir, tag[1])))
      .digest('base64');
    check(`integrity matches the served bytes for ${tag[1]}`, digest === actual, digest ? '' : 'no sha384');
  }
});

// --- 3c. a new build waits for the user ----------------------------------
// The update gate (docs/security.md § "A malicious or coerced host"). Its
// whole value is that a swapped build cannot arrive silently, and every way it
// can break is invisible: leave `skipWaiting()` in install and the new build
// runs unannounced; serve navigations network-first and it runs anyway while
// the new worker politely waits; break the banner and nobody can ever accept
// an update again. None of that shows up in a normal build or test run.
//
// "Build B" is simulated by editing the emitted files rather than running a
// second Vite build: a new `BUILD_VERSION` in sw.js is exactly what the
// browser reacts to, and mutating tracked source mid-benchmark risks leaving
// the repo dirty if this process dies.
await scenario('a new build waits for consent', async () => {
  const htmlPath = resolve(outDir, 'index.html');
  const swPath = resolve(outDir, 'sw.js');
  const htmlBefore = await readFile(htmlPath, 'utf8');
  const swBefore = await readFile(swPath, 'utf8');
  const MARKER = 'phase6-build-b-marker';

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(base, { waitUntil: 'load' });
    await enterVault(page);
    await swReady(page);
    await page.waitForSelector('.app', { timeout: 30_000 });

    // Deploy "B" over the same directory.
    await writeFile(htmlPath, htmlBefore.replace('</head>', `<meta name="${MARKER}" content="1" /></head>`));
    await writeFile(swPath, swBefore.replace(/const BUILD_VERSION = "\w+"/, 'const BUILD_VERSION = "phase6bbbbbb"'));

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.app', { timeout: 30_000 });

    check(
      'the new build does not run until it is accepted',
      !(await page.content()).includes(MARKER),
      'the shell must come from this worker\'s own precache',
    );

    let banner = null;
    for (let i = 0; i < 25 && !banner; i++) {
      await page.waitForTimeout(1000);
      banner = await page
        .locator('.banner', { hasText: 'new version' })
        .first()
        .textContent()
        .catch(() => null);
    }
    check('the user is told a new version is waiting', Boolean(banner), banner ? '' : 'no banner appeared');

    if (banner) {
      await page.getByRole('button', { name: 'Apply and reload' }).click();
      await page
        .waitForFunction((m) => document.documentElement.innerHTML.includes(m), MARKER, { timeout: 30_000 })
        .catch(() => {});
      check('accepting it actually applies the new build', (await page.content()).includes(MARKER));
    }
  } finally {
    // Always restore, or every later scenario runs against a half-built shell.
    await writeFile(htmlPath, htmlBefore);
    await writeFile(swPath, swBefore);
    await page.close();
    await context.close();
  }
});

// --- 4. the code grammars are NOT precached ------------------------------
await scenario('precache scope', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await swReady(page);

  const entries = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith('teksto-shell-'));
    if (!shell) return [];
    const keys = await (await caches.open(shell)).keys();
    return keys.map((r) => new URL(r.url).pathname);
  });

  // Precaching twenty language grammars would mean downloading Kotlin support
  // in order to install a notepad.
  // Measure the *precache manifest*, not the live cache: the runtime handler
  // legitimately adds grammar chunks and workers as they are used, so the live
  // cache grows and asserting on it would test the wrong thing.
  const precached = await page.evaluate(async () => {
    const text = await (await fetch('/sw.js')).text();
    return JSON.parse(text.match(/const BUILD_ASSETS = (\[[\s\S]*?\]);/)[1]);
  });
  // Every first-level dynamic import is precached on purpose: a feature that
  // cannot open offline is a feature the PWA does not really have. That is the
  // editor, the Markdown preview, the CodeMirror core they share, the Argon2id
  // KDF, the export/import, history and share dialogs, the passphrase
  // generator, and "remove all data from this device" — which has to work
  // offline precisely because the machine it is most needed on may not be the
  // user's. The share viewer's own shell and chunks are in here too, and have
  // to be: the navigation branch in `sw.js` answers `/s/` from this manifest,
  // so a viewer that is not precached is a share link that opens the notepad.
  //
  // So the number grows with the app, and a hand-written cap on it decays into
  // noise: this one said 15 while the build had drifted to 25, which is a gate
  // that has stopped gating. The cap below is today's figure plus room for a
  // few more dialogs, and it is the *ratio* underneath that carries the real
  // claim, because the thing being guarded against would not arrive one chunk
  // at a time.
  check('the precache stays small', precached.length <= 56, `${precached.length} entries precached`);

  // The claim, stated as the shape of the build rather than as a magic number:
  // the shell is a small fraction of the JavaScript here, and the bulk is the
  // ~130 code grammars. Precaching those would have a user downloading Kotlin
  // support in order to install a notepad — and they would arrive all at once,
  // so any ratio well under 1 catches it. Read off disk rather than guessed, so
  // the check keeps describing whatever the build actually is.
  //
  // The fraction was 0.15 and is now 0.25, for the reason the paragraph above
  // predicts: quick capture added three first-level chunks and the build was
  // already sitting on 0.15 by a rounding-up. A ratio one feature away from
  // firing is a ratio that reports growth, not the failure it was written for,
  // and the sharp end of this pair is the absolute cap above — a grammar leak
  // would put 130 chunks in here and trip both by a mile.
  const allJs = (await readdir(resolve(outDir, 'assets'))).filter((f) => f.endsWith('.js'));
  const precachedJs = precached.filter((p) => p.endsWith('.js'));
  check(
    'the code grammars are not precached',
    precachedJs.length <= Math.ceil(allJs.length * 0.25),
    `${precachedJs.length} of ${allJs.length} JS chunks: ${precachedJs.join(' ')}`,
  );
  check(
    'the editor is precached, so offline start is usable',
    entries.some((p) => /Editor.*\.js$/.test(p)),
    '',
  );

  await page.close();
  await context.close();
});

// --- 5. mobile layout -----------------------------------------------------
await scenario('mobile layout', async () => {
  const phone = devices['Pixel 7'] ?? devices['Pixel 5'];
  const context = await browser.newContext({ ...phone });
  const page = await context.newPage();

  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check('the note list does not overflow horizontally', !overflow);

  // Hover-only row controls are unreachable on a touch screen. A note row now
  // carries two: the pin, and the `⋯` that every other action is behind — so
  // `⋯` is what the `hover: none` reserve exists for, and if it cannot be hit
  // with a finger then deleting, filing and exporting are all unreachable.
  // Scoped to `.list` because the folder rows carry a `⋯` of their own.
  const more = page.locator('.list .more').first();
  const moreBox = await more.boundingBox();
  check('the row menu is reachable by touch', await more.isVisible());
  check(
    'the row menu is a usable touch target',
    Boolean(moreBox && moreBox.width >= 40 && moreBox.height >= 40),
    moreBox ? `${Math.round(moreBox.width)}x${Math.round(moreBox.height)}` : 'no box',
  );

  const pinBox = await page.locator('.list .pin').first().boundingBox();
  check(
    'the pin control is a usable touch target',
    Boolean(pinBox && pinBox.width >= 40 && pinBox.height >= 40),
    pinBox ? `${Math.round(pinBox.width)}x${Math.round(pinBox.height)}` : 'no box',
  );

  // Filing and deleting are only reachable from that menu, so its own items
  // have to be finger-sized too.
  await more.click();
  await page.waitForSelector('[role="dialog"] button');
  for (const label of ['Move to…', 'Delete']) {
    const item = page.locator('[role="dialog"] button', { hasText: label }).first();
    const itemBox = await item.boundingBox();
    check(
      `the menu's ${label} is a usable touch target`,
      Boolean(itemBox && itemBox.width >= 40 && itemBox.height >= 40),
      itemBox ? `${Math.round(itemBox.width)}x${Math.round(itemBox.height)}` : 'no box',
    );
  }
  // A phone shows one note at a time; there is nothing to open beside it.
  check(
    'the menu omits "Open beside" on a phone',
    (await page.locator('[role="dialog"] button', { hasText: 'Open beside' }).count()) === 0,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });

  // Swipe right to pin. Driven through CDP because Playwright's mouse reports
  // `pointerType: 'mouse'`, which the gesture deliberately ignores — a drag
  // with a mouse in a narrow window must not delete a note.
  const pinsBefore = await page.locator('.list .pin-mark').count();
  const rowBox = await page.locator('.list .row-wrap').first().boundingBox();
  if (!rowBox) throw new Error('no note row to swipe');
  const touch = await page.context().newCDPSession(page);
  const y = Math.round(rowBox.y + rowBox.height / 2);
  const x0 = Math.round(rowBox.x + 40);
  const send = (type, x) =>
    touch.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await send('touchStart', x0);
  for (const dx of [20, 60, 110, 150]) await send('touchMove', x0 + dx);
  await send('touchEnd', x0 + 150);
  await page.waitForTimeout(400);
  const pinsAfter = await page.locator('.list .pin-mark').count();
  check(
    'swiping a note row right pins it',
    pinsAfter === pinsBefore + 1,
    `${pinsBefore} → ${pinsAfter} pinned`,
  );

  // The swipe must not also open the note: the row is a button, and the
  // pointer went down and up inside it.
  check(
    'a committed swipe does not open the note',
    (await page.locator('.cm-content').count()) === 0,
  );

  await page.locator('.list .row').first().click();
  await page.waitForSelector('.cm-content', { timeout: 20_000 });
  const backVisible = await page.locator('button.back').isVisible();
  check('the editor offers a way back to the list', backVisible);

  const editorOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check('the editor does not overflow horizontally', !editorOverflow);

  await page.close();
  await context.close();
});

// --- 3. offline cold start (the headline) ---------------------------------
/**
 * Genuinely offline: the origin is shut down rather than emulated.
 *
 * `context.setOffline(true)` is not usable here. CDP's offline emulation
 * blocks renderer-initiated subresource loads *before* the service worker sees
 * them, so `<script src>` fails with ERR_FAILED even when the very same URL
 * returns 200 from the cache via `fetch()`. Closing the server reproduces the
 * real condition — the origin is unreachable — and lets the worker do its job.
 *
 * Runs last, because the server does not come back.
 */
await scenario('offline cold start', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);

  const marker = `OfflineBootWitness${Date.now()}`;
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.cm-content', { timeout: 20_000 });
  await page.click('.cm-content');
  await page.keyboard.type(` ${marker} `);
  await page.waitForTimeout(1200);

  await swReady(page);
  check('a service worker takes control', true);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith('teksto-shell-'));
    if (!shell) return 0;
    return (await (await caches.open(shell)).keys()).length;
  });
  check('the shell is precached', cached > 5, `${cached} entries`);

  // Now take the origin away entirely and start from scratch.
  await server.close();
  serverClosed = true;
  await page.reload({ waitUntil: 'load' });

  await page.waitForSelector('.list .row, .cm-content, .card', { timeout: 30_000 });
  check('the app boots with the network down', true);

  // Booting is not enough — the notes have to be there and readable.
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.cm-content', { timeout: 20_000 });
  await page.waitForTimeout(1500);

  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette', { timeout: 15_000 });
  await page.keyboard.type(marker);
  await page.waitForTimeout(900);
  const hits = await page.locator('.result').count();
  check('notes are readable and searchable offline', hits > 0, `${hits} hits`);
  await page.keyboard.press('Escape');

  // And editing must still work — §17 forbids disabling the editor.
  const offlineMarker = `TypedWhileOffline${Date.now()}`;
  await page.click('.cm-content');
  await page.keyboard.type(` ${offlineMarker} `);
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.list .row', { timeout: 30_000 });
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.cm-content', { timeout: 20_000 });
  await page.waitForTimeout(1500);

  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette', { timeout: 15_000 });
  await page.keyboard.type(offlineMarker);
  await page.waitForTimeout(900);
  const offlineHits = await page.locator('.result').count();
  check('edits made offline survive an offline reload', offlineHits > 0, `${offlineHits} hits`);

  check('no page errors during the offline boot', errors.length === 0, errors.slice(0, 2).join(' | '));

  // The worker's scope is the whole origin, so without the shell table in
  // `sw.js` this navigation would be answered from the app's precached
  // `index.html` and a recipient would be shown a notepad. Offline is the
  // sharpest form of the test: there is no network to fall back to, so what
  // renders is whatever the worker chose.
  await page.goto(`${base}/s/#s1.AAAABBBBCCCCDDDDEEEEFF.${'A'.repeat(43)}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const viewer = await page.evaluate(() => ({
    hasViewer: !!document.getElementById('viewer'),
    hasApp: !!document.getElementById('app'),
    title: document.title,
  }));
  check(
    'a share link opens the viewer, not the app',
    viewer.hasViewer && !viewer.hasApp,
    `#viewer ${viewer.hasViewer} · #app ${viewer.hasApp} · “${viewer.title}”`,
  );

  await page.close();
  await context.close();
});


await browser.close();
if (!serverClosed) await server.close();

console.log('');
console.table(results);

if (failures.length) {
  console.error(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nAll Phase 6 checks pass.\n');
