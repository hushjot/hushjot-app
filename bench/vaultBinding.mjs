/**
 * Does this device still know that its vault is the account's?
 *
 * The bug this gate exists for: the answer lived in a variable in a Svelte
 * component, so it was re-derived from nothing on every page load. A device
 * read back the key record *it had published itself*, failed to recognise its
 * own handwriting, told the user their passphrase was wrong and retired its own
 * backfill. Session 1 was always fine; session 2 was always broken. Nothing in
 * the unit suite could see it, because the whole failure is the boundary
 * between one page load and the next — which is why this is a browser gate and
 * not a test.
 *
 * Four claims, in the order they have to hold:
 *   1. the answer survives a reload, and a second one;
 *   2. it is written down (`app:vaultAccount`), and names the account;
 *   3. an install that predates the marker heals itself — every device in the
 *      field is in this state, and a fix they have to act on is not a fix;
 *   4. a genuinely different vault is *still* refused. That refusal is the
 *      point of the whole area: notes sealed under a key an account cannot open
 *      are as permanent as notes pushed into the wrong account, because the
 *      rules refuse deletes.
 *
 * Two more live here because they are the same question asked backwards —
 * what does this device still know when it is supposed to know nothing?
 *
 *   5. signing out closes the vault. It used to sever only the account, so a
 *      user who signed out on a borrowed machine was left looking at their own
 *      decrypted notes with the panel still open. Nothing but a browser can
 *      see that, because the whole failure is what is on screen.
 *   6. "remove all data from this device" removes it — and is reachable from
 *      the *unlock* screen, which is the only exit for someone who has lost
 *      both the passphrase and the recovery code.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount } from './emulatorAccounts.mjs';
import { chooseStart } from './lib/app.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repoRoot, 'bench/dist-vault-binding');
const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const PASSPHRASE = 'a sufficiently long passphrase';

await build({
  root: repoRoot, logLevel: 'error', mode: 'development', build: { outDir },
  define: {
    'import.meta.env.VITE_FIREBASE_EMULATORS': '"true"',
    'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(PROJECT),
  },
});
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5193, strictPort: true } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();

const BANNER = /vault is not the one this account|passphrase is not the one this account/i;
const bannerText = async (page) =>
  (await page.locator('.banner').allTextContents()).find((t) => BANNER.test(t)) ?? null;

const out = [];
const check = (name, ok, detail = '') => out.push({ check: name, verdict: ok ? 'pass' : 'FAIL', detail });

const account = `vb-${Date.now()}@example.test`;
await provisionAccount(account, 'test-password-123');

const context = await browser.newContext();
const page = await context.newPage();
await page.goto(base, { waitUntil: 'load' });

// Create the vault, then sign in — the device that publishes the key record.
// "Use this device only" is now literally that journey: the wizard names the
// thing this harness was already testing.
await chooseStart(page, 'device');
await page.waitForSelector('#new-pass', { timeout: 20000 });
await page.fill('#new-pass', PASSPHRASE);
await page.fill('#confirm-pass', PASSPHRASE);
await page.click('.local button[type="submit"]');
await page.waitForSelector('.code', { timeout: 30000 });
await page.check('.check input');
await page.click('button.primary');
await page.waitForSelector('.cm-content', { timeout: 30000 });

await page.click('button[aria-label^="Account"]');
await page.waitForSelector('#account-email', { timeout: 10000 });
await page.fill('#account-email', account);
await page.fill('#account-password', 'test-password-123');
await page.click('.panel button[type="submit"]');
await page.waitForTimeout(4000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(3000);

check('session 1: no vault banner', (await bannerText(page)) === null, (await bannerText(page)) ?? '');

const marker = `VaultBannerGlyph${Date.now()}`;
await page.click('button.primary');
await page.waitForTimeout(300);
await page.keyboard.type(`# ${marker}\n`);
await page.waitForTimeout(3000);

// THE BUG: reload. The account now has the record this device published.
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.cm-content', { timeout: 30000 });
await page.waitForTimeout(6000);
const after = await bannerText(page);
check('session 2 (after reload): no vault banner', after === null, after ?? '');

// The marker must be on disk, uid-scoped.
const bound = await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('app:vaultAccount');
        g.onsuccess = () => res(g.result ?? null);
        g.onerror = () => res('ERR');
      };
      r.onerror = () => res('ERR');
    }),
);
check('app:vaultAccount written', typeof bound === 'string' && bound.length > 10, String(bound));

// And a third load, to be sure the answer is stable rather than re-derived.
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.cm-content', { timeout: 30000 });
await page.waitForTimeout(5000);
const third = await bannerText(page);
check('session 3: still no vault banner', third === null, third ?? '');
check('the note survived both reloads', (await page.locator('.list .title').allTextContents()).some((t) => t.includes(marker)));

// --- the heal: an install that predates the marker -------------------------
// Exactly the state every existing device is in today. Drop the marker and the
// only remaining evidence is that the account's record IS this device's record.
await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const tx = r.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('app:vaultAccount');
        tx.oncomplete = () => res(true);
      };
    }),
);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.cm-content', { timeout: 30000 });
await page.waitForTimeout(6000);
const healed = await bannerText(page);
check('heals an install with no marker', healed === null, healed ?? '');
const rebound = await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('app:vaultAccount');
        g.onsuccess = () => res(g.result ?? null);
      };
    }),
);
check('the marker is written back by the heal', typeof rebound === 'string', String(rebound));

// --- sign out must close the vault, not just the account -------------------
// The bug: signing out severed the account and left the notes on screen, the
// key in memory and the device key on disk. A user on a borrowed machine had
// done the one thing they knew to do, and it had not worked. Nothing in the
// unit suite can see this — it is entirely about what the page is showing.
await page.click('button[aria-label^="Account"]');
await page.waitForSelector('#account-email, .panel h2', { timeout: 10000 });
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.waitForSelector('#pass', { timeout: 20000 });
check('sign out reaches the unlock screen', (await page.locator('.cm-content').count()) === 0);
check('sign out closes the account panel', (await page.locator('.backdrop').count()) === 0);
const bodyAfterSignOut = (await page.locator('body').innerText()) ?? '';
check('no note text survives sign out', !bodyAfterSignOut.includes(marker), bodyAfterSignOut.slice(0, 120));
const keptKey = await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('vault:deviceKey');
        g.onsuccess = () => res(g.result === undefined ? null : 'present');
        g.onerror = () => res('ERR');
      };
      r.onerror = () => res('ERR');
    }),
);
check('sign out deletes the remembered device key', keptKey === null, String(keptKey));

// --- remove all data, from the unlock screen -------------------------------
// The only exit for someone who has lost both secrets. Before this existed
// they were stranded on this screen permanently.
await page.getByRole('button', { name: /Remove all data from this device/ }).click();
await page.waitForSelector('#remove-title', { timeout: 10000 });
check('the locked dialog offers no export', (await page.locator('.panel .secondary').count()) === 0);
check('remove is held behind the checkbox', await page.locator('.destructive').isDisabled());
await page.check('.confirm input');
await page.click('.destructive');

// It reloads itself; wait for the setup screen the way every other journey does.
await page.waitForTimeout(3000);
const restarted = await chooseStart(page, 'device');
check('a wiped device starts at the setup screen', restarted === true);

const remains = await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction(['kv', 'noteMeta']);
        const kv = tx.objectStore('kv');
        const out = {};
        const keys = ['vault:keyRecord', 'vault:deviceKey', 'app:owner', 'app:vaultAccount', 'app:seeded'];
        for (const k of keys) {
          const g = kv.get(k);
          g.onsuccess = () => {
            if (g.result !== undefined) out[k] = true;
          };
        }
        const notes = tx.objectStore('noteMeta').count();
        notes.onsuccess = () => {
          out.notes = notes.result;
        };
        tx.oncomplete = () => res(out);
        tx.onerror = () => res({ error: true });
      };
      r.onerror = () => res({ error: true });
    }),
);
check('no key record, owner or binding survives', Object.keys(remains).join(',') === 'notes', JSON.stringify(remains));
check('no notes survive', remains.notes === 0, JSON.stringify(remains));

const historyGone = await page.evaluate(async () =>
  (await indexedDB.databases()).every((d) => d.name !== 'teksto-history'),
);
check('the history database is gone', historyGone);

const leftover = await page.evaluate(() =>
  Object.keys(localStorage).filter((k) => k.startsWith('teksto:')),
);
check('no teksto: preference survives', leftover.length === 0, leftover.join(','));

await context.close();

// --- the safety property: a genuinely different vault must still refuse -----
// A device that makes its own vault *before* signing in meets an account that
// already holds someone else's record. Neither can read the other.
const other = await browser.newContext();
const p2 = await other.newPage();
await p2.goto(base, { waitUntil: 'load' });
await chooseStart(p2, 'device');
await p2.waitForSelector('#new-pass', { timeout: 20000 });
await p2.fill('#new-pass', 'an entirely different passphrase');
await p2.fill('#confirm-pass', 'an entirely different passphrase');
await p2.click('.local button[type="submit"]');
await p2.waitForSelector('.code', { timeout: 30000 });
await p2.check('.check input');
await p2.click('button.primary');
await p2.waitForSelector('.cm-content', { timeout: 30000 });
await p2.click('button[aria-label^="Account"]');
await p2.waitForSelector('#account-email', { timeout: 10000 });
await p2.fill('#account-email', account);
await p2.fill('#account-password', 'test-password-123');
await p2.click('.panel button[type="submit"]');
await p2.waitForTimeout(5000);
await p2.keyboard.press('Escape').catch(() => {});
await p2.waitForTimeout(5000);
const foreign = await bannerText(p2);
check('a different vault is still refused', foreign !== null, foreign ? 'banner shown' : 'NO BANNER');
const notBound = await p2.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('teksto');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('app:vaultAccount');
        g.onsuccess = () => res(g.result ?? null);
      };
    }),
);
check('a different vault does not claim the account', notBound === null, String(notBound));
await other.close();

console.table(out);
const failed = out.filter((r) => r.verdict === 'FAIL');
await browser.close();
await server.httpServer.close();
if (failed.length) { console.log('FAILED:', failed.map((f) => f.check).join(', ')); process.exit(1); }
console.log('ALL PASS');
process.exit(0);
