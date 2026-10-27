/**
 * Share a note by link — a correctness gate, not a budget.
 *
 * Like `bench:vault`, what it checks has no meaning outside a real browser.
 * The claim is about two pages, two storage states and a URL fragment, and
 * every part of it is invisible to a unit test:
 *
 *   1. a recipient with **no vault, no notes and no account** — a fresh
 *      browser context, which is what a stranger's browser is — can open the
 *      link and read the note;
 *   2. the link works without its fragment reaching anything. The bench
 *      records every request the viewer makes and asserts the share id never
 *      appears in a URL the viewer's own page fetched beyond the one Firestore
 *      document it must ask for, and that the key appears nowhere at all;
 *   3. dropping the fragment yields the "incomplete link" screen and **no
 *      fetch at all** — a half-parsed link must not go asking the backend for
 *      a document it has no key for;
 *   4. revoking works immediately, not at expiry, and a cost lockdown reads as
 *      "temporarily unavailable" rather than as an expired link;
 *   5. the viewer page carries none of the vault: no IndexedDB database, no
 *      key record, no unlock form. This is the property that makes a link from
 *      a stranger safe to click, and it is one refactor away from being untrue.
 *
 * Wrapped in `firebase emulators:exec`, so it needs no running emulator.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount, setRules } from './emulatorAccounts.mjs';
import { lockdownRules, normalRules } from './lib/lockdown.mjs';
import { chooseStart } from './lib/app.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repoRoot, 'bench/dist-share');
const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const PASSPHRASE = 'a sufficiently long passphrase';

await build({
  root: repoRoot,
  logLevel: 'error',
  mode: 'development',
  build: { outDir },
  define: {
    'import.meta.env.VITE_FIREBASE_EMULATORS': '"true"',
    'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(PROJECT),
  },
});
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5194, strictPort: true } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();

const out = [];
const check = (name, ok, detail = '') => out.push({ check: name, verdict: ok ? 'pass' : 'FAIL', detail });

const account = `share-${Date.now()}@example.test`;
await provisionAccount(account, 'test-password-123');

// --- the owner ------------------------------------------------------------

const owner = await browser.newContext();
const page = await owner.newPage();
await page.goto(base, { waitUntil: 'load' });

await chooseStart(page, 'device');
await page.waitForSelector('#new-pass', { timeout: 20_000 });
await page.fill('#new-pass', PASSPHRASE);
await page.fill('#confirm-pass', PASSPHRASE);
await page.click('.local button[type="submit"]');
await page.waitForSelector('.code', { timeout: 30_000 });
await page.check('.check input');
await page.click('button.primary');
await page.waitForSelector('.cm-content', { timeout: 30_000 });

// Before signing in, deliberately. This is the state the first attempt made
// unreachable: the entry point was gated on `syncStore.signedIn`, which is
// false here — and is also false for the first moments of every page load,
// and permanently false in a build with no backend configured. An always-on
// icon has none of those failure modes, and the dialog explains itself.
const sidebarIcon = page.locator('.sidebar .icon[aria-label="Shared links"]');
const iconCount = await sidebarIcon.count();
check('the sidebar offers Shared links without signing in', iconCount === 1, `${iconCount} found`);

// Guarded rather than assumed: a missing icon should print a FAIL row in the
// table like every other check, not throw out of the script on a click that
// can never land and leave no table at all.
if (iconCount === 1) {
  await sidebarIcon.click();
  await page.waitForSelector('#share-title', { timeout: 10_000 });
  const title = await page.textContent('#share-title');
  check('and it opens the list', title === 'Shared links', title ?? '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
} else {
  check('and it opens the list', false, 'no icon to click');
}

await page.click('button[aria-label^="Account"]');
await page.waitForSelector('#account-email', { timeout: 10_000 });
await page.fill('#account-email', account);
await page.fill('#account-password', 'test-password-123');
await page.click('.panel button[type="submit"]');
await page.waitForTimeout(4000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(3000);

const marker = `SharedGlyph${Date.now()}`;
await page.click('button.primary');
await page.waitForTimeout(300);
// The task line is here so the viewer can be asked about its checkboxes: the
// preview's are clickable in the app, and this page has nothing to click them
// into. No trailing newline — Enter off a task line continues the list. The
// code fence is inserted rather than typed, so no Enter handler reshapes it.
await page.keyboard.type(
  `# ${marker}\n\nSome **bold** text and a \`fence\`.\n\n- [x] done\n\nA [[Note Link]] too.`,
);
await page.keyboard.insertText('\n\n```js\nlet copied = 1;\n```');
await page.waitForTimeout(2500);

// Clipboard permission, so "copies to clipboard" is testable rather than a
// dialog that silently fails in a headless browser.
await owner.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });

// The second desktop surface, the way `export-import` has always had two: the
// sidebar icon above for reaching it, and this for finding it while you are
// already looking at your account. `shortcuts.test.ts` names both; only a DOM
// assertion can say whether either is really in the markup.
await page.click('button[aria-label^="Account"]');
await page.waitForSelector('.panel', { timeout: 10_000 });
const accountLinks = await page.locator('.panel .inline-link').allTextContents();
check(
  'Shared links is reachable by mouse on a desktop',
  accountLinks.some((t) => t.includes('Shared links')),
  accountLinks.map((t) => t.trim()).join(' · '),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.keyboard.press('Control+j');
await page.keyboard.press('Shift+S');
await page.waitForSelector('#share-title', { timeout: 20_000 });
await page.click('.row.primary');
await page.waitForSelector('input.link', { timeout: 30_000 });
const link = await page.inputValue('input.link');
check('publishing produces a link', /\/s\/#s1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(link), link.slice(0, 60));

const shareId = link.split('#')[1]?.split('.')[1] ?? '';
const shareKey = link.split('#')[1]?.split('.')[2] ?? '';

// --- the recipient: a browser that has never seen this app ----------------

const stranger = await browser.newContext();
const guest = await stranger.newPage();
const requested = [];
guest.on('request', (r) => requested.push(r.url()));
await guest.goto(link, { waitUntil: 'load' });
await guest.waitForSelector('.markdown h1, .message h1', { timeout: 30_000 });

const shown = await guest.textContent('.markdown');
check('a stranger with the link reads the note', (shown ?? '').includes(marker), (shown ?? '').slice(0, 40));

check(
  'the key is never in a URL anything fetched',
  requested.every((url) => !url.includes(shareKey)),
  requested.find((url) => url.includes(shareKey)) ?? '',
);
const idInUrls = requested.filter((url) => url.includes(shareId));
check(
  'only the Firestore document names the share id',
  idInUrls.every((url) => url.includes('/v1/projects/')),
  idInUrls.filter((url) => !url.includes('/v1/projects/')).join(' ') || `${idInUrls.length} request(s)`,
);

// A clickable checkbox would be an edit to a note this page cannot write to,
// and the renderer only enables one when its caller passed a way to write.
const boxes = await guest.$$eval('.markdown li.task input', (els) =>
  els.map((el) => ({ disabled: el.disabled, data: el.getAttribute('data-task') })),
);
check(
  'the viewer\u2019s task checkboxes are inert',
  boxes.length > 0 && boxes.every((b) => b.disabled),
  JSON.stringify(boxes),
);

// The same rule, one control along: a note link can only be followed by a page
// that holds the vault, and this page deliberately does not. So it renders as
// text saying it was a link rather than as a button that silently does nothing.
const noteLinks = await guest.$$eval('.markdown button.notelink', (els) =>
  els.map((el) => ({ disabled: el.disabled, data: el.getAttribute('data-note') })),
);
check(
  'the viewer\u2019s note links are inert',
  noteLinks.length > 0 && noteLinks.every((l) => l.disabled && l.data),
  JSON.stringify(noteLinks),
);

// Copying changes nothing, so unlike the two controls above the copy button is
// live here too — and it must put the code on the clipboard, not the icon's
// label or the block's indent.
await stranger.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
await guest.waitForSelector('.markdown pre button.copy-code', { timeout: 10_000 });
await guest.click('.markdown pre button.copy-code');
await guest.waitForSelector('.markdown pre button.copy-code.copied', { timeout: 5_000 }).catch(() => {});
const copiedCode = await guest.evaluate(() => navigator.clipboard.readText());
check('a code block\u2019s copy button copies exactly the code', copiedCode === 'let copied = 1;', JSON.stringify(copiedCode));

// The page a stranger opens has none of the vault on it.
const isolation = await guest.evaluate(async () => {
  const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
  return {
    databases: dbs.map((d) => d.name),
    localKeys: Object.keys(localStorage),
    unlockForm: !!document.querySelector('#new-pass, #pass'),
    app: !!document.getElementById('app'),
  };
});
check(
  'the viewer has no vault on it',
  !isolation.databases.includes('teksto') && !isolation.unlockForm && !isolation.app,
  JSON.stringify(isolation),
);
check(
  'the viewer stores nothing until the reader changes a preference',
  isolation.localKeys.filter((k) => k.startsWith('teksto:')).length === 0,
  isolation.localKeys.join(' '),
);

// Reading preferences are the app's own stores: one click flips the palette,
// one click grows the text, and the only things written are those choices.
const sizeBefore = await guest.evaluate(() => getComputedStyle(document.querySelector('.markdown')).fontSize);
const themeBefore = await guest.evaluate(() => document.documentElement.dataset.theme ?? null);
await guest.click('.theme-btn');
await guest.click('.textsize .ts-step:last-child');
await guest.selectOption('select.font', 'serif');
const prefs = await guest.evaluate(() => ({
  theme: document.documentElement.dataset.theme ?? null,
  size: getComputedStyle(document.querySelector('.markdown')).fontSize,
  font: document.documentElement.style.getPropertyValue('--preview-font'),
  keys: Object.keys(localStorage).filter((k) => k.startsWith('teksto:')),
}));
check('the theme toggle switches the palette', prefs.theme !== null && prefs.theme !== themeBefore, JSON.stringify(prefs));
check('larger text grows the note', parseFloat(prefs.size) > parseFloat(sizeBefore), `${sizeBefore} → ${prefs.size}`);
check('the font picker sets the font', prefs.font.includes('--serif'), prefs.font);
// The native select ignores height in Safari, so it is drawn without its
// appearance; this is the check that it still lines up with the buttons.
const heights = await guest.evaluate(() => ({
  font: document.querySelector('select.font').getBoundingClientRect().height,
  theme: document.querySelector('.theme-btn').getBoundingClientRect().height,
  copy: document.querySelector('.seg button').getBoundingClientRect().height,
}));
check(
  'the font picker is as tall as the buttons beside it',
  heights.font === heights.theme && heights.font === heights.copy,
  JSON.stringify(heights),
);
const allowedKeys = new Set(['teksto:theme', 'teksto:editor-font-size', 'teksto:editor-font']);
check(
  'and only those preferences are stored',
  prefs.keys.length > 0 && prefs.keys.every((k) => allowedKeys.has(k)),
  prefs.keys.join(' '),
);

// Source view, copy and download are the three things a recipient can do.
await guest.click('.seg button:last-child');
await guest.waitForSelector('pre.source', { timeout: 10_000 });
check('the source view shows the Markdown', ((await guest.textContent('pre.source')) ?? '').includes(`# ${marker}`));

// Back again: the toggle unmounts the article, so a renderer kept across it
// would be painting into a node that has left the document.
await guest.click('.seg button:first-child');
await guest.waitForSelector('.markdown h1', { timeout: 10_000 });
check('toggling back re-renders', ((await guest.textContent('.markdown')) ?? '').includes(marker));

// --- a link without its fragment -----------------------------------------

const bare = await stranger.newPage();
const bareRequests = [];
bare.on('request', (r) => bareRequests.push(r.url()));
await bare.goto(`${base}/s/`, { waitUntil: 'load' });
await bare.waitForSelector('.message h1', { timeout: 20_000 });
check('a link without its fragment says so', ((await bare.textContent('.message h1')) ?? '').includes('incomplete'));
check(
  'and asks the backend for nothing',
  bareRequests.every((url) => !url.includes('/v1/projects/')),
  bareRequests.filter((url) => url.includes('/v1/projects/')).join(' '),
);
await bare.close();

// --- save to my notes ----------------------------------------------------
// The viewer hands the app the *link*, never the decrypted text, so this is
// also the check that the app can open a share on its own — with a vault, but
// without the vault being involved in opening it.

const back = await owner.newPage();
await back.goto(link, { waitUntil: 'load' });
await back.waitForSelector('.markdown h1', { timeout: 30_000 });
await back.click('button.primary');
await back.waitForSelector('.cm-content, .list .row', { timeout: 30_000 });
check(
  'the link, not the plaintext, is what crossed',
  new URL(back.url()).pathname === '/' && !back.url().includes(marker),
  back.url().slice(0, 60),
);
// The offer shows the note it is offering — not a toast over whichever note
// was open last, which is what a tester read as "it opened the wrong note".
const offer = '[role="dialog"][aria-labelledby="incoming-title"]';
await back.waitForSelector(`${offer} .markdown h1`, { timeout: 20_000 });
check(
  'the offer shows the shared note before it is saved',
  ((await back.textContent(`${offer} .markdown`)) ?? '').includes(marker),
);
const before = (await back.locator('.list .title').allTextContents()).filter((t) => t.includes(marker)).length;
check('and nothing is written until it is accepted', before === 1, `${before} notes carry the marker`);
await back.click(`${offer} button.primary`);
await back.waitForSelector(offer, { state: 'detached', timeout: 20_000 });
await back.waitForTimeout(3000);
const titles = await back.locator('.list .title').allTextContents();
check('a shared note can be saved into your own notes', titles.filter((t) => t.includes(marker)).length >= 2, titles.join(' | ').slice(0, 80));
check('and the saved copy is the note that opens', ((await back.textContent('.cm-content')) ?? '').includes(marker));
await back.close();

// --- a cost lockdown -----------------------------------------------------
// The kill switch refuses every read, so a live link answers 403 exactly as an
// expired one does. It must not be called gone: one probe of the lockdown
// sentinel tells the two apart, and it names no share.

await setRules(lockdownRules());
const locked = await stranger.newPage();
const lockedRequests = [];
locked.on('request', (r) => lockedRequests.push(r.url()));
await locked.goto(link, { waitUntil: 'load' });
await locked.waitForSelector('.message h1, .markdown h1', { timeout: 30_000 });
const lockedTitle = (await locked.textContent('.message h1').catch(() => '')) ?? '';
check('a link opened during a lockdown says shared notes are unavailable', /temporarily unavailable/i.test(lockedTitle), lockedTitle);
check('and does not call the link gone', !/no longer available/.test(lockedTitle));
check(
  'and the probe names no share',
  lockedRequests.filter((url) => url.includes('/status/lockdown')).every((url) => !url.includes(shareId)),
  lockedRequests.filter((url) => url.includes('/v1/projects/')).join(' '),
);
await locked.close();
await setRules(normalRules());

const unlocked = await stranger.newPage();
await unlocked.goto(link, { waitUntil: 'load' });
await unlocked.waitForSelector('.message h1, .markdown h1', { timeout: 30_000 });
check('and the same link opens again once the rules are back', (await unlocked.locator('.markdown h1').count()) > 0);
await unlocked.close();

// --- revocation ----------------------------------------------------------

await page.click('.acts .danger, .panel .danger');
await page.waitForTimeout(3000);

const afterRevoke = await stranger.newPage();
await afterRevoke.goto(link, { waitUntil: 'load' });
await afterRevoke.waitForSelector('.message h1, .markdown h1', { timeout: 30_000 });
const gone = (await afterRevoke.textContent('.message h1')) ?? '';
check('a revoked link stops working at once', gone.includes('no longer available'), gone || 'note still rendered');
await afterRevoke.close();

await stranger.close();
await owner.close();

console.table(out);
const failed = out.filter((r) => r.verdict === 'FAIL');
await browser.close();
await server.httpServer.close();
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.check).join(', '));
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
