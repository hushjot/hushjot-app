/**
 * Synced note history, across real devices, against the emulators.
 *
 * `bench:history` proves history works on one device. This proves the part
 * that only exists between devices: a version one device keeps reaches the
 * account, another device can browse it without having taken it, a delete's
 * final text lands before the tombstone does, and a device that never had the
 * note at all can bring it back from Recently deleted — under the same id, so
 * the first device sees it return rather than a copy.
 *
 * Also asserts the cost claim: versions are passengers on sync cycles notes
 * already cause, so their writes are counted and reported, and no version
 * upload may happen for an account whose vault is not this device's.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount } from './emulatorAccounts.mjs';
import { meterBrowser, formatOps } from './firestoreOps.mjs';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-history-sync');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const FIRESTORE_HOST = '127.0.0.1:8085';
const PASSPHRASE = 'a sufficiently long passphrase';
const PASSWORD = 'test-password-123';

console.log('Building app…');
await build({
  root: repoRoot,
  logLevel: 'error',
  // Development mode: the CSP only allows the emulator origins outside production.
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
const ops = meterBrowser(browser);
const results = [];
const failures = [];
const pageErrors = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

let step = '';
async function scenario(name, fn) {
  step = 'start';
  ops.takeTotal();
  try {
    await fn();
  } catch (err) {
    check(name, false, `[${step}] ${String(err).split('\n')[0].slice(0, 140)}`);
  }
  results.push({ check: `${name}: Firestore ops`, verdict: 'info', detail: formatOps(ops.takeTotal()) });
}

async function newPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e}`));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));
  page.on('dialog', (d) => void d.accept());
  return page;
}

async function enterVault(page) {
  await chooseStart(page, 'device');
  if (await page.locator('#new-pass').count()) {
    await page.fill('#new-pass', PASSPHRASE);
    await page.fill('#confirm-pass', PASSPHRASE);
    await page.click('.local button[type="submit"]');
    await page.waitForSelector('.code', { timeout: 30_000 });
    await page.check('.check input');
    await page.click('button.primary');
  } else if (await page.locator('#pass').count()) {
    await page.fill('#pass', PASSPHRASE);
    await page.click('.local button[type="submit"]');
  }
  await page.waitForSelector('.cm-content, .editor-pane .empty', { timeout: 30_000 });
}

async function signInInApp(page, email) {
  await page.click('button[aria-label^="Account"]');
  await page.waitForSelector('.panel #account-email', { timeout: 10_000 });
  await page.fill('#account-email', email);
  await page.fill('#account-password', PASSWORD);
  await page.click('.panel button[type="submit"]');
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
}

/** A second device: sign in on the vault screen, then unlock with the account's passphrase. */
async function joinDevice(email) {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await chooseStart(page, 'account');
  await page.waitForSelector('.account #account-email', { timeout: 10_000 });
  await page.fill('#account-email', email);
  await page.fill('#account-password', PASSWORD);
  await page.click('.account button[type="submit"]');
  await page.waitForSelector('#pass', { timeout: 25_000 });
  await page.fill('#pass', PASSPHRASE);
  await page.click('.local button[type="submit"]');
  await page.waitForSelector('.cm-content, .editor-pane .empty', { timeout: 30_000 });
  return page;
}

const titles = (page) => page.locator('.list .title').allTextContents();

const waitForTitle = (page, needle, present = true, timeout = 45_000) =>
  page.waitForFunction(
    ([text, want]) =>
      [...document.querySelectorAll('.list .title')].some((el) => el.textContent?.includes(text)) === want,
    [needle, present],
    { timeout },
  );

const uidOf = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('firebase:authUser:')) return JSON.parse(localStorage.getItem(key)).uid;
    }
    return '';
  });

async function rest(path) {
  const res = await fetch(`http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  return res.ok ? res.json() : {};
}

/** Every version document in the account, read around the rules. */
async function remoteVersions(uid) {
  const out = [];
  const notes = (await rest(`users/${uid}/notes?pageSize=300`)).documents ?? [];
  for (const note of notes) {
    const noteId = note.name.split('/').pop();
    for (const v of (await rest(`users/${uid}/notes/${noteId}/versions?pageSize=300`)).documents ?? []) {
      out.push({ noteId, id: v.name.split('/').pop(), reason: v.fields.reason.stringValue, createdAt: v.createTime });
    }
  }
  return out;
}

async function poll(fn, ok, tries = 40, delay = 500) {
  let value;
  for (let i = 0; i < tries; i++) {
    value = await fn();
    if (ok(value)) return value;
    await new Promise((r) => setTimeout(r, delay));
  }
  return value;
}

const account = `history-${Date.now()}@example.test`;
const marker = `HistorySyncProbe${Date.now()}`;
let pageA;
let uid = '';

await scenario('a version kept on one device reaches the account', async () => {
  step = 'device A';
  await provisionAccount(account, PASSWORD);
  const contextA = await browser.newContext();
  pageA = await newPage(contextA);
  await pageA.goto(base, { waitUntil: 'load' });
  await enterVault(pageA);
  await signInInApp(pageA, account);
  await pageA.waitForTimeout(2500);
  uid = await uidOf(pageA);

  step = 'first draft';
  await pageA.click('header.topbar .primary');
  await pageA.waitForTimeout(300);
  await pageA.keyboard.type(`# ${marker}\n\nfirst draft`);
  await pageA.waitForTimeout(4500);

  step = 'second session';
  await pageA.reload({ waitUntil: 'load' });
  await enterVault(pageA);
  await pageA.waitForTimeout(1500);
  await pageA.locator('.list .title', { hasText: marker }).first().click();
  await pageA.waitForTimeout(400);
  await pageA.click('.tile .cm-content');
  await pageA.keyboard.press('ControlOrMeta+End');
  await pageA.keyboard.type('\nsecond draft');

  const versions = await poll(() => remoteVersions(uid), (v) => v.length >= 1);
  check('the version reached Firestore', versions.length === 1, JSON.stringify(versions));
  check('its id is a 24-hex nonce', /^[0-9a-f]{24}$/.test(versions[0]?.id ?? ''));
});

let pageB;
await scenario('another device browses a version it never took', async () => {
  step = 'device B';
  pageB = await joinDevice(account);
  await waitForTitle(pageB, marker);
  await pageB.locator('.list .title', { hasText: marker }).first().click();
  await pageB.waitForTimeout(1500);

  step = 'history panel';
  await pageB.click('.tile-history');
  await pageB.waitForSelector('.diff .line.added', { timeout: 20_000 });
  const added = await pageB.locator('.diff .line.added').allInnerTexts();
  check('device B sees the version from device A', added.some((t) => t.includes('second draft')), added.join('|'));
  await pageB.keyboard.press('Escape');

  step = 'no re-upload';
  await pageB.waitForTimeout(4000);
  check('browsing does not write any versions', (await remoteVersions(uid)).length === 1);
});

await scenario('a delete travels with its text', async () => {
  step = 'delete on A';
  // Two clicks: the note row carries only the pin and `⋯`, and Delete is in the menu.
  await pageA.click(`button[aria-label="More actions for ${marker}"]`);
  await pageA.locator('[role="dialog"] button', { hasText: 'Delete' }).click();
  const versions = await poll(() => remoteVersions(uid), (v) => v.some((x) => x.reason === 'delete'));
  check('the final text reached Firestore as a delete version', versions.some((v) => v.reason === 'delete'));

  step = 'tombstone on B';
  await waitForTitle(pageB, marker, false);
  await pageB.click('button[aria-label="Recently deleted notes"]');
  await pageB.waitForSelector('[aria-labelledby="deleted-title"] .plain', { timeout: 20_000 });
  const text = await pageB.locator('[aria-labelledby="deleted-title"] .plain').innerText();
  check('device B offers it back from Recently deleted', text.includes('second draft'), text.slice(0, 80));
  await pageB.keyboard.press('Escape');
});

await scenario('a device that never had the note restores it', async () => {
  step = 'device C';
  const pageC = await joinDevice(account);
  await pageC.waitForTimeout(3000);
  check('device C does not list the deleted note', !(await titles(pageC)).some((t) => t.includes(marker)));

  step = 'recently deleted on C';
  await pageC.click('button[aria-label="Recently deleted notes"]');
  await pageC.waitForSelector(`[aria-labelledby="deleted-title"] .row:has-text("${marker}")`, { timeout: 20_000 });
  await pageC.locator('[aria-labelledby="deleted-title"] .row', { hasText: marker }).click();
  await pageC.waitForSelector('[aria-labelledby="deleted-title"] .plain', { timeout: 20_000 });
  check(
    'device C fetches the text from the account',
    (await pageC.locator('[aria-labelledby="deleted-title"] .plain').innerText()).includes('second draft'),
  );

  step = 'restore on C';
  await pageC.click('[aria-labelledby="deleted-title"] .actions .primary');
  await waitForTitle(pageC, marker);

  step = 'back on A';
  await waitForTitle(pageA, marker, true, 45_000);
  const onA = (await titles(pageA)).filter((t) => t.includes(marker)).length;
  check('device A sees the same note return, not a copy', onA === 1, `${onA} rows`);
});

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
await server.close();

console.table(results);
if (failures.length > 0) {
  console.error(`\n${failures.length} synced-history check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nSynced note history: all checks passed.');
