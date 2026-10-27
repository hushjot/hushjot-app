/**
 * Phase 4 verification: sync, against the real Firebase emulators.
 *
 * The two checks that matter most:
 *
 * - **Second device.** A fresh browser profile signs in, pulls the wrapped key
 *   record, unlocks with the same passphrase, and reads notes it never had
 *   locally. That is §31's "log into another device and retrieve/decrypt".
 * - **Firestore ciphertext audit.** Dump what the backend actually stored and
 *   grep it for plaintext. §31 requires that Firebase contain no plaintext
 *   note titles or bodies, and this is the only thing that proves it.
 *
 * Run via `npm run bench:phase4`, which starts the emulators for the duration.
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
const outDir = resolve(here, 'dist-phase4');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const FIRESTORE_HOST = '127.0.0.1:8085';

const PASSPHRASE = 'a sufficiently long passphrase';
const SENTINELS = {
  title: 'HeliotropeCascadeMarker',
  body: 'PeregrineWaveformToken',
};

console.log('Building app…');
await build({
  root: repoRoot,
  logLevel: 'error',
  // Development mode, because this build talks to the emulators: the CSP only
  // allows localhost origins outside production, so a production build here is
  // correctly blocked from reaching them.
  mode: 'development',
  build: { outDir },
  // Point the built app at the emulators.
  define: {
    'import.meta.env.VITE_FIREBASE_EMULATORS': '"true"',
    'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(PROJECT),
  },
});

const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5191, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
// Every scenario also reports what it cost in billed Firestore operations.
const ops = meterBrowser(browser);
const results = [];
const failures = [];
const pageErrors = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(name, fn) {
  ops.takeTotal();
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err).split('\n')[0].slice(0, 140));
  }
  results.push({ check: `${name}: Firestore ops`, verdict: 'info', detail: formatOps(ops.takeTotal()) });
}

/**
 * Network errors are *expected* during the offline scenario, so they are
 * filtered out rather than reported. Anything else fails the run — otherwise a
 * real error could hide among the deliberate ones.
 */
const EXPECTED_WHILE_OFFLINE =
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource|net::ERR/i;

async function newPage(context) {
  const page = await context.newPage();
  const record = (text) => {
    if (!EXPECTED_WHILE_OFFLINE.test(text)) pageErrors.push(text);
  };
  page.on('pageerror', (e) => record(`pageerror: ${e}`));
  page.on('console', (m) => m.type() === 'error' && record(`console: ${m.text()}`));
  return page;
}

/** Create the vault if this profile has none; otherwise unlock it. */
async function enterVault(page, passphrase = PASSPHRASE) {
  await chooseStart(page, 'device');

  if (await page.locator('#new-pass').count()) {
    await page.fill('#new-pass', passphrase);
    await page.fill('#confirm-pass', passphrase);
    await page.click('.local button[type="submit"]');
    await page.waitForSelector('.code', { timeout: 30_000 });
    await page.check('.check input');
    await page.click('button.primary');
  } else if (await page.locator('#pass').count()) {
    await page.fill('#pass', passphrase);
    await page.click('.local button[type="submit"]');
  }
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
}

/**
 * Sign out, then unlock again.
 *
 * Signing out now locks the vault — it used to sever only the account and
 * leave the notes on screen — so every journey that signs out mid-run has to
 * come back through the passphrase. The scenarios below are about what the
 * *queue* and the *account binding* do across a sign-out; the lock is
 * `bench:vault`'s subject, and is only asserted here enough to notice if it
 * stops happening.
 */
async function signOutAndUnlock(page, passphrase = PASSPHRASE) {
  await page.click('button[aria-label^="Account"]');
  await page.click('.panel button.secondary'); // Sign out
  await page.waitForSelector('#pass', { timeout: 20_000 });
  await enterVault(page, passphrase);
}

async function signIn(page, email, password, register) {
  // The signup form exists, but syncing needs a plan or an invitation, so a
  // first-time account is created and invited out of band here — the same
  // comp path the operator uses — rather than bought through Paddle.
  if (register) await provisionAccount(email, password);

  await page.click('button[aria-label^="Account"]');
  await page.waitForSelector('#account-email', { timeout: 10_000 });
  await page.fill('#account-email', email);
  await page.fill('#account-password', password);
  await page.click('.panel button[type="submit"]');
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
}

/** Everything the backend actually stored, as one searchable string. */
async function dumpFirestore(uid) {
  // The emulator enforces the security rules on REST reads too, so this needs
  // the owner token — without it the dump comes back 403 and an audit that
  // sees nothing would "pass" by looking at nothing.
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!res.ok) return `HTTP_${res.status}`;
  const json = await res.json();
  // Ciphertext arrives base64-encoded over the REST API; decode it so any
  // plaintext hiding in the bytes would be visible to the grep below.
  let out = JSON.stringify(json);
  for (const document of json.documents ?? []) {
    for (const field of Object.values(document.fields ?? {})) {
      if (typeof field.bytesValue === 'string') {
        out += ' ' + Buffer.from(field.bytesValue, 'base64').toString('latin1');
      }
    }
  }
  return out;
}

/** The signed-in uid, as the app itself persisted it. */
function readUid(page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('firebase:authUser:')) {
        return JSON.parse(localStorage.getItem(key)).uid;
      }
    }
    return '';
  });
}

/** One account's note documents, parsed. Empty when the collection is absent. */
async function listNotes(uid) {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!res.ok) return [];
  return (await res.json()).documents ?? [];
}

/**
 * The storage meter against the truth: what `users/{uid}/usage/current` says,
 * and what the account's notes and folders actually hold, counted the way
 * `core/sync/usage.ts` defines it, minimum charge included. Once the rules enforce the meter, any
 * difference refuses a write, so it has to be exact rather than close.
 */
async function meterAgainstStored(uid) {
  const base = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`;
  const get = async (path) => {
    const res = await fetch(`${base}/${path}`, { headers: { Authorization: 'Bearer owner' } });
    return res.ok ? res.json() : {};
  };
  const size = (doc, fields) =>
    fields.reduce((sum, f) => sum + Buffer.from(doc.fields?.[f]?.bytesValue ?? '', 'base64').length, 0);
  const notes = (await get('notes?pageSize=300')).documents ?? [];
  const folders = (await get('folders?pageSize=300')).documents ?? [];
  // Charged, as the rules charge it: never less than 1 KiB per document.
  const charged = (n) => (n <= 0 ? 0 : Math.max(n, 1024));
  const stored =
    notes.reduce((sum, d) => sum + charged(size(d, ['meta', 'body'])), 0) +
    folders.reduce((sum, d) => sum + charged(size(d, ['data'])), 0);
  const meter = Number((await get('usage/current')).fields?.bytes?.integerValue ?? NaN);
  return { meter, stored };
}

const isTombstone = (document) => document.fields?.deleted?.booleanValue === true;

/** Poll until `predicate` holds, so the assertion is not racing the debounce. */
async function until(page, predicate, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const account = `sync-${Date.now()}@example.test`;
const password = 'test-password-123';
let uid = '';

// --- device one: create, sign in, write, sync -----------------------------
await scenario('first device', async () => {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await signIn(page, account, password, true);
  await page.waitForTimeout(1500);

  await page.click('button.primary'); // + Note
  await page.waitForTimeout(300);
  await page.keyboard.type(`# ${SENTINELS.title}\n\n${SENTINELS.body}\n`);
  await page.waitForTimeout(1200);

  uid = await readUid(page);

  check('signed in and captured a uid', Boolean(uid), uid);

  // Poll rather than sleeping a fixed amount: the idle debounce is ~800 ms but
  // the round trip is not instant.
  let dump = '';
  for (let i = 0; i < 30; i++) {
    dump = await dumpFirestore(uid);
    if (dump.includes('"documents"')) break;
    await page.waitForTimeout(500);
  }

  check('the note reached Firestore', dump.includes('"documents"'), dump.slice(0, 60));
  check('Firestore holds no plaintext title', !dump.includes(SENTINELS.title));
  check('Firestore holds no plaintext body', !dump.includes(SENTINELS.body));

  await page.close();
  await context.close();
});

// --- device two: a fresh profile with only the account --------------------
await scenario('second device', async () => {
  // A brand new browser context: no IndexedDB, no vault, no device key.
  // Everything it learns has to come from the backend.
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });

  // The wizard asks how to start before it offers any form at all.
  await page.waitForSelector('#choose-account', { timeout: 20_000 });
  check('a fresh device is offered a choice of how to start', true);

  // The route that makes §31 reachable at all: sign in from the vault screen
  // so the wrapped key record can be pulled instead of a second, unrelated
  // vault being created.
  await chooseStart(page, 'account');
  await page.waitForSelector('.account #account-email', { timeout: 10_000 });
  await page.fill('#account-email', account);
  await page.fill('#account-password', password);
  await page.click('.account button[type="submit"]');

  // Having adopted the record, the device should now be asking to *unlock*
  // rather than to create.
  await page.waitForSelector('#pass', { timeout: 20_000 });
  check('signing in turns the fresh device into an unlock prompt', true);

  // The anti-fork property, as a standing gate. `Vault.create()` mints a fresh
  // random DEK, so a create form offered anywhere on this journey is how the
  // right passphrase produces the wrong vault, permanently. It must never have
  // been reachable — not before the sign-in, and not in the window between the
  // sign-in and the adoption landing.
  check(
    'the create form was never offered on the signed-in journey',
    (await page.locator('#new-pass').count()) === 0,
  );

  await page.fill('#pass', PASSPHRASE);
  await page.click('.local button[type="submit"]');
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  check('the existing passphrase unlocks on the new device', true);

  // Now the notes have to arrive and decrypt.
  await page.waitForFunction(
    (needle) =>
      [...document.querySelectorAll('.list .title')].some((el) =>
        el.textContent?.includes(needle),
      ),
    SENTINELS.title,
    { timeout: 40_000 },
  );
  check('the note synced and decrypted on the second device', true);

  // The reported bug: a device that starts from empty storage used to write
  // its own "Welcome to HushJot" and "Scratch" before the first pull, so the
  // account's copies arrived alongside them and the user had two of each —
  // real documents, propagating to every device. Duplicate titles are the
  // symptom, so assert against them directly.
  const seen = await page.locator('.list .title').allTextContents();
  const counts = new Map();
  for (const title of seen) counts.set(title, (counts.get(title) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
  check(
    'the second device has no duplicated notes',
    duplicated.length === 0,
    duplicated.map(([title, n]) => `${title} ×${n}`).join(' | ') || seen.join(' | '),
  );

  await page.close();
  await context.close();
});

// --- offline edit, then reconnect ----------------------------------------
await scenario('offline then reconnect', async () => {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await signIn(page, account, password, false);
  await page.waitForTimeout(2000);

  await context.setOffline(true);

  const offlineMarker = `OffshoreLanternGlyph${Date.now()}`;
  await page.click('button.primary');
  await page.waitForTimeout(300);
  await page.keyboard.type(`# ${offlineMarker}\n`);
  await page.waitForTimeout(1200);

  // The editor must stay usable with no network (§17: "do not disable the
  // editor simply because Firebase is unavailable").
  const stillEditable = await page.evaluate(
    () => document.querySelectorAll('.cm-content').length > 0,
  );
  check('the editor keeps working while offline', stillEditable);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  let dump = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    dump = await dumpFirestore(uid);
    if ((dump.match(/"name"/g) ?? []).length >= 2) break;
  }
  check(
    'the offline edit reached the backend after reconnect',
    dump.includes('"documents"') && !dump.includes(offlineMarker),
    'present as ciphertext, absent as plaintext',
  );

  // Prove it really arrived, by counting documents rather than trusting silence.
  const count = (dump.match(/"name"/g) ?? []).length;
  check('the backend holds more than one note', count >= 2, `${count} name fields`);

  let metered = { meter: NaN, stored: 0 };
  await until(page, async () => {
    metered = await meterAgainstStored(uid);
    return metered.meter === metered.stored;
  });
  check(
    'the storage meter equals what the account stores',
    metered.stored > 0 && metered.meter === metered.stored,
    `meter ${metered.meter}, stored ${metered.stored}`,
  );

  await page.close();
  await context.close();
});

// --- a device that was used without an account, then signs in -------------
//
// The gap this closes: `#queue` used to skip the outbound queue entirely with
// no account, so everything written during local-only use was invisible to
// sync for good. Signing in after a month of work left that month on the
// device, behind a green "Saved".
await scenario('local-only then sign in', async () => {
  const localAccount = `backfill-${Date.now()}@example.test`;
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);

  // Three notes and a deletion, all with no account anywhere in sight. The
  // two seed notes are here too, so the account should end up with five live
  // documents and one tombstone.
  const marks = ['AlluvialKestrelMark', 'TurbidSextantMark', 'DoomedCinderMark'];
  for (const mark of marks) {
    await page.click('button.primary');
    await page.waitForTimeout(250);
    await page.keyboard.type(`# ${mark}\n`);
    await page.waitForTimeout(600);
  }
  page.once('dialog', (dialog) => void dialog.accept());
  // Delete moved into the row's `⋯` menu; only the pin is left on the row.
  await page.click(`button[aria-label="More actions for ${marks[2]}"]`);
  await page.locator('[role="dialog"] button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(800);

  const localTitles = await page.locator('.list .title').allTextContents();
  check(
    'the local-only device has its notes and no account',
    localTitles.includes(marks[0]) && localTitles.includes(marks[1]),
    localTitles.join(' | '),
  );

  // Now an account appears.
  await signIn(page, localAccount, password, true);
  const localUid = await readUid(page);

  const arrived = await until(page, async () => {
    const documents = await listNotes(localUid);
    return documents.filter((d) => !isTombstone(d)).length >= 4;
  });

  const documents = await listNotes(localUid);
  const live = documents.filter((d) => !isTombstone(d));
  const tombstones = documents.filter(isTombstone);

  check(
    'notes written before signing in reach the account',
    arrived && live.length === 4,
    `${live.length} live of ${documents.length}`,
  );

  // Tombstones have to go up too. A deletion that never reaches the backend
  // comes back on the next pull and brings its notes with it (§16).
  check(
    'a deletion made before signing in reaches the account',
    tombstones.length === 1,
    `${tombstones.length} tombstones`,
  );

  // And it must not come back locally either.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content, .editor-pane .empty', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const afterReload = await page.locator('.list .title').allTextContents();
  check(
    'the deleted note does not come back after the backfill',
    !afterReload.some((t) => t.includes(marks[2])),
    afterReload.join(' | '),
  );

  // Work done while signed out has to reach the backend on the next sign-in.
  // The sweep alone cannot do this — its marker is already set — so this is
  // the check that `#queue` really does enqueue with no account.
  await signOutAndUnlock(page);
  await page.click('button.primary');
  await page.waitForTimeout(250);
  await page.keyboard.type('# SignedOutInterludeMark\n');
  await page.waitForTimeout(1000);

  await signIn(page, localAccount, password, false);
  const grew = await until(page, async () => (await listNotes(localUid)).length >= 6);
  check(
    'a note written while signed out syncs on the next sign-in',
    grew,
    `${(await listNotes(localUid)).length} documents`,
  );

  // Signing out cleared every anchor, so each push here learned the stored
  // size by reading it back. The meter must still come out exact.
  let metered = { meter: NaN, stored: 0 };
  await until(page, async () => {
    metered = await meterAgainstStored(localUid);
    return metered.meter === metered.stored;
  });
  check(
    'the meter stays exact across a sign-out and a backfill',
    metered.stored > 0 && metered.meter === metered.stored,
    `meter ${metered.meter}, stored ${metered.stored}`,
  );

  await page.close();
  await context.close();
});

// --- signing in as somebody else on the same device -----------------------
//
// `clearSyncState()` exists to stop one user's notes reaching another's
// account, but it only runs via `signOut()` — which does nothing when the
// engine never started — and the session-expiry path did not call it at all.
// A sweep keyed on "never pushed" would have uploaded the previous account's
// entire library, and a create cannot be taken back: the rules refuse deletes.
await scenario('account switch', async () => {
  const first = `owner-a-${Date.now()}@example.test`;
  const second = `owner-b-${Date.now()}@example.test`;

  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);

  await page.click('button.primary');
  await page.waitForTimeout(250);
  await page.keyboard.type('# PrivateToOwnerAMark\n');
  await page.waitForTimeout(600);

  await signIn(page, first, password, true);
  const uidA = await readUid(page);
  const reachedA = await until(page, async () => (await listNotes(uidA)).length >= 3);
  check("the first account received this device's notes", reachedA, `uid ${uidA}`);

  // Switch accounts on the same device, same vault, same notes.
  await signOutAndUnlock(page);

  await signIn(page, second, password, true);
  const uidB = await readUid(page);
  check('signed in as a second account', Boolean(uidB) && uidB !== uidA, `uid ${uidB}`);

  // Give it longer than a sync cycle to do the wrong thing.
  await page.waitForTimeout(6000);
  const documentsB = await listNotes(uidB);
  check(
    "the first account's notes are not uploaded to the second",
    documentsB.length === 0,
    `${documentsB.length} documents in the second account`,
  );

  // And the user is told why, rather than being left with a device that
  // silently does not sync.
  const banner = await page.locator('.banner.warn').allTextContents();
  check(
    'the refusal is surfaced to the user',
    banner.some((t) => t.includes('different account')),
    banner.join(' | ').slice(0, 90),
  );

  await page.close();
  await context.close();
});

// --- a full account: changes wait, nothing is lost, and they go once there is room
await scenario('storage full', async () => {
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  const fullAccount = `full-${Date.now()}@example.test`;
  await signIn(page, fullAccount, 'test-password-123', true);
  await page.waitForTimeout(1500);
  const fullUid = await readUid(page);

  // Settle whatever the new account starts with, then fill it to the brim the
  // way the backfill would leave an account at its allowance.
  await until(page, async () => {
    const m = await meterAgainstStored(fullUid);
    return m.stored > 0 && m.meter === m.stored;
  });
  const before = (await listNotes(fullUid)).length;
  const setMeter = (bytes) =>
    fetch(
      `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${fullUid}/usage/current?updateMask.fieldPaths=bytes`,
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { bytes: { integerValue: String(bytes) } } }),
      },
    );
  await setMeter(1024 ** 3);

  await page.click('button.primary'); // + Note
  await page.waitForTimeout(300);
  await page.keyboard.type('# WaitingForRoomMarker\n\nThis note arrives once there is room.\n');

  const label = () => page.getAttribute('button.sync', 'aria-label');
  const said = await until(page, async () => /storage full/i.test((await label()) ?? ''));
  check('a full account says so, rather than "sync failed"', said, await label());
  check(
    'and the note waits on the device instead of reaching the backend',
    (await listNotes(fullUid)).length === before,
    `${(await listNotes(fullUid)).length} documents, ${before} before`,
  );
  check('the note stays editable while it waits', (await page.locator('.cm-content').innerText()).includes('WaitingForRoomMarker'));

  // Room appears (a note deleted on another device, say), and the next edit
  // sends what was waiting.
  await setMeter(0);
  await page.keyboard.type('More.');
  const arrived = await until(page, async () => (await listNotes(fullUid)).length > before);
  check('once there is room, the waiting note syncs', arrived, `${(await listNotes(fullUid)).length} documents`);
  check(
    'and the indicator stops saying full',
    await until(page, async () => !/storage full/i.test((await label()) ?? '')),
    await label(),
  );

  await page.close();
  await context.close();
});

await browser.close();
await server.close();

console.log('');
console.table(results);

if (pageErrors.length) {
  console.error(`\nPage/console errors (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 10)) console.error('  ' + e);
}

if (failures.length || pageErrors.length) {
  console.error(`\nFAILED (${failures.length} checks, ${pageErrors.length} unexpected errors):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nAll Phase 4 checks pass.\n');
