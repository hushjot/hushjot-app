/**
 * A cost lockdown, against the real emulators — a correctness gate, not a budget.
 *
 * The cost kill switch swaps the Firestore rules for
 * a ruleset that refuses every client. Every request then fails with the same
 * `permission-denied` an account with no plan gets, and before the pause state
 * existed the app read it exactly that way. What this proves needs the rules,
 * the adapter, the engine and the UI in one browser, so it is a bench:
 *
 *   1. a signed-in device that hits the lockdown says **"Sync paused"**, never
 *      "needs a plan", stays signed in, mints no conflict copies, and offers no
 *      way to buy a plan;
 *   2. a **brand-new device** that signs in during the lockdown is not offered
 *      a passphrase to create — that would fork the account's vault — and is
 *      told why it is waiting;
 *   3. when the real rules come back, both recover **without a reload**: the
 *      first device uploads what was written during the pause, and the new one
 *      adopts the account's vault, unlocks it, and seeds no second set of
 *      welcome notes.
 *
 * The recovery waits out `PAUSE_RECHECK_MIN_MS` (a minute) before nudging
 * with a focus event, because that rate limit is part of what is being tested:
 * during a lockdown every probe is a billable read.
 *
 * Run via `npm run bench:lockdown`, which starts the emulators.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount, setRules } from './emulatorAccounts.mjs';
import { lockdownRules, normalRules } from './lib/lockdown.mjs';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-lockdown');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const FIRESTORE_HOST = '127.0.0.1:8085';
const PASSPHRASE = 'a sufficiently long passphrase';
const PASSWORD = 'test-password-123';
/** `PAUSE_RECHECK_MIN_MS` in `src/core/sync/pause.ts`, plus a margin. */
const RECHECK_WAIT_MS = 62_000;

console.log('Building app…');
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
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5196, strictPort: true } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();

const results = [];
const check = (name, ok, detail = '') => results.push({ check: name, verdict: ok ? 'pass' : 'FAIL', detail });

const uidOf = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('firebase:authUser:')) return JSON.parse(localStorage.getItem(key)).uid;
    }
    return '';
  });

async function noteCount(uid) {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!res.ok) return -1;
  return ((await res.json()).documents ?? []).length;
}

async function until(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const syncKind = (page) => page.getAttribute('button.sync', 'data-kind');
const bodyText = (page) => page.evaluate(() => document.body.innerText);

const account = `lockdown-${Date.now()}@example.test`;
await provisionAccount(account, PASSWORD);

try {
  // --- device A: signed in, syncing, then locked down ----------------------
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await a.goto(base, { waitUntil: 'load' });
  await chooseStart(a, 'device');
  await a.fill('#new-pass', PASSPHRASE);
  await a.fill('#confirm-pass', PASSPHRASE);
  await a.click('.local button[type="submit"]');
  await a.waitForSelector('.code', { timeout: 30_000 });
  await a.check('.check input');
  await a.click('button.primary');
  await a.waitForSelector('.cm-content', { timeout: 30_000 });

  await a.click('button[aria-label^="Account"]');
  await a.waitForSelector('#account-email', { timeout: 10_000 });
  await a.fill('#account-email', account);
  await a.fill('#account-password', PASSWORD);
  await a.click('.panel button[type="submit"]');
  await a.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });

  const uid = await until(() => uidOf(a));
  // The welcome notes, seeded after the first cycle and pushed by the next.
  const before = await until(async () => {
    const n = await noteCount(uid);
    return n > 0 && (await syncKind(a)) === 'synced' ? n : 0;
  });
  check('device A syncs before the lockdown', before > 0, `${before} notes on the backend`);

  await setRules(lockdownRules());

  await a.click('button.primary');
  await a.waitForTimeout(300);
  await a.keyboard.type('# PausedMarker\n\nwritten during the lockdown\n');
  const paused = await until(async () => (await syncKind(a)) === 'paused', 20_000);
  check('a refused cycle reads as "Sync paused"', paused, `indicator: ${await syncKind(a)}`);
  const textA = await bodyText(a);
  check('with the calm banner', /Sync is paused for maintenance/.test(textA));
  check('and never "no active sync plan"', !/no active sync plan/i.test(textA));
  check('nothing was signed out', ((await a.getAttribute('button.sync', 'title')) ?? '').includes(account));
  check('and no conflict copy was made', textA.split('conflict copy').length === 1);

  await a.click('button[aria-label^="Account"]');
  await a.waitForSelector('.panel', { timeout: 10_000 });
  const panel = (await a.textContent('.panel')) ?? '';
  check('the account panel says paused', /Sync paused/.test(panel) && /Unavailable while sync is paused/.test(panel), panel.slice(0, 160));
  check('and offers no way to buy a plan', !/Get sync/.test(panel));
  await a.keyboard.press('Escape');
  await a.waitForSelector('.panel', { state: 'detached', timeout: 10_000 });

  // --- device B: brand new, signs in during the lockdown -------------------
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  let createOffered = false;
  await b.goto(base, { waitUntil: 'load' });
  await chooseStart(b, 'account');
  await b.waitForSelector('.account #account-email', { timeout: 10_000 });
  await b.fill('#account-email', account);
  await b.fill('#account-password', PASSWORD);
  await b.click('.account button[type="submit"]');
  const heldPaused = await until(async () => /Sync is paused/.test((await b.textContent('#step-title').catch(() => '')) ?? ''), 20_000);
  check('a new device is told sync is paused', heldPaused, (await b.textContent('#step-title').catch(() => '')) ?? '');
  const field = b.locator('#new-pass');
  createOffered = (await field.count()) > 0 && (await field.isEnabled());
  check('and is not offered a passphrase to create', !createOffered);
  check('and has seeded nothing', (await b.locator('.cm-content').count()) === 0);

  // --- the real rules come back --------------------------------------------
  await setRules(normalRules());
  // The recheck is rate-limited to one probe a minute; wait it out, then do
  // what a user does: come back to the tab.
  await new Promise((r) => setTimeout(r, RECHECK_WAIT_MS));
  await a.evaluate(() => window.dispatchEvent(new Event('focus')));
  await b.evaluate(() => window.dispatchEvent(new Event('focus')));

  const resumed = await until(async () => {
    const kind = await syncKind(a);
    return kind !== 'paused' && !/Sync is paused for maintenance/.test(await bodyText(a));
  }, 30_000);
  check('device A resumes without a reload', resumed, `indicator: ${await syncKind(a)}`);
  const after = await until(async () => ((await noteCount(uid)) > before ? noteCount(uid) : 0), 30_000);
  check('and uploads what was written during the pause', after === before + 1, `${before} → ${after}`);

  // B adopts the account's vault: the create step becomes an unlock prompt.
  const unlock = await b.waitForSelector('#pass', { timeout: 30_000 }).then(() => true, () => false);
  check('the new device adopts the vault once sync resumes', unlock);
  if (unlock) {
    await b.fill('#pass', PASSPHRASE);
    await b.click('.local button[type="submit"]');
    await b.waitForSelector('.cm-content', { timeout: 30_000 });
    const titles = await until(async () => {
      const t = await b.locator('.list .title').allTextContents();
      return t.some((x) => x.includes('PausedMarker')) ? t : null;
    }, 30_000);
    const list = titles ?? (await b.locator('.list .title').allTextContents());
    check('and receives the notes written during the pause', list.some((x) => x.includes('PausedMarker')), list.join(' | ').slice(0, 120));
    check(
      'without seeding a second welcome note',
      list.filter((x) => x.includes('Welcome to HushJot')).length === 1,
      list.join(' | ').slice(0, 120),
    );
  }

  await ctxA.close();
  await ctxB.close();
} catch (error) {
  check('the journey completed', false, String(error).slice(0, 200));
} finally {
  // Never leave the emulator locked for whatever runs next.
  await setRules(normalRules()).catch(() => {});
}

console.table(results);
const failed = results.filter((r) => r.verdict === 'FAIL');
await browser.close();
await server.httpServer.close();
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.check).join(', '));
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
