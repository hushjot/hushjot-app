/**
 * Allowlist verification, against the real emulators.
 *
 * Three things the unit and rules tests cannot prove on their own, because
 * each needs the rules, the adapter, the engine and the UI in one process:
 *
 * - An approved account syncs.
 * - An account that is *not* approved is refused by the backend, is told so,
 *   and — the regression that matters — **does not mint conflict copies**.
 *   Firestore reports a stale revision and a forbidden write with the same
 *   `permission-denied` code; reading the second as the first duplicates the
 *   note on every retry for as long as the tab is open.
 * - Revocation ends the session without touching the notes, and is
 *   recoverable: re-approving and signing in again sends the work done while
 *   access was gone, rather than losing it.
 * - A session *restored* from storage goes through the same gate. It used to
 *   go through none: the check lived behind the sign-in form only.
 * - An account emptied by the retention purge gets its key record and its
 *   notes back from a device that still holds them. Without the key record
 *   the next new device would find no vault and create a second one.
 * - An account its owner *reset* from another device (lost both secrets,
 *   started over) does **not**: the device still holding the old vault sees
 *   the tombstone, or the new vault, retires its own and stops syncing —
 *   across a reload too — instead of putting the old vault back.
 *
 * Run via `npm run bench:allowlist`, which starts the emulators.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount, setInviteActive } from './emulatorAccounts.mjs';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-allowlist');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const FIRESTORE_HOST = '127.0.0.1:8085';
const PASSPHRASE = 'a sufficiently long passphrase';
const PASSWORD = 'test-password-123';

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

const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5193, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
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
  }
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
}

async function signIn(page, email) {
  await page.click('button[aria-label^="Account"]');
  await page.waitForSelector('#account-email', { timeout: 10_000 });
  await page.fill('#account-email', email);
  await page.fill('#account-password', PASSWORD);
  await page.click('.panel button[type="submit"]');
}

async function typeNewNote(page, title) {
  await page.click('button.primary');
  await page.waitForTimeout(300);
  await page.keyboard.type(`# ${title}\n`);
  await page.waitForTimeout(1500);
}

const uidOf = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('firebase:authUser:')) {
        return JSON.parse(localStorage.getItem(key)).uid;
      }
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

/** How many notes the sidebar shows whose title marks them a conflict copy. */
const conflictCopies = (page) =>
  page.evaluate(() => document.body.innerText.split('conflict copy').length - 1);

// --- 1. an uninvited account is refused, and does not duplicate anything ---
{
  const email = `uninvited-${Date.now()}@example.test`;
  // An account with no allowlist entry: exactly the state the console produces
  // if you add a user and forget the second step.
  await provisionAccount(email, PASSWORD, { invite: false });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await typeNewNote(page, 'UninvitedMarker');

  await signIn(page, email);

  // The client checks the allowlist after signing in, so the panel should stay
  // open and say why rather than closing on a session that cannot sync.
  const refused = await page
    .locator('.panel .error', { hasText: 'needs a plan' })
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check('an uninvited account is told it needs a plan', refused);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(6000);

  const copies = await conflictCopies(page);
  check(
    'no conflict copies were minted for an uninvited account',
    copies === 0,
    `${copies} found`,
  );

  const stillHasNote = (await page.locator('.cm-content').innerText()).includes(
    'UninvitedMarker',
  );
  check('the note is still readable locally', stillHasNote);

  await context.close();
}

// --- 2. an invited account syncs; revoking stops it, restoring resumes it -
{
  const email = `invited-${Date.now()}@example.test`;
  await provisionAccount(email, PASSWORD);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);

  await signIn(page, email);
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
  // The engine is built a moment after the panel closes, and a note created
  // in that gap is never queued. That is a pre-existing wrinkle in how sync
  // starts, unrelated to the allowlist, so this test simply waits it out the
  // way the phase 4 benchmark does.
  await page.waitForTimeout(1500);

  // Edit rather than create. Only an edit made while the engine is already
  // running is reliably queued, and a push is what proves the backend accepts
  // this account — which is the whole point of the check.
  await page.click('.cm-content');
  await page.keyboard.type('\n\nApprovedMarker\n');

  const uid = await uidOf(page);
  let synced = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    synced = await noteCount(uid);
    if (synced >= 1) break;
  }
  check('an invited account syncs', synced >= 1, `${synced} documents`);

  // Revoke mid-session, exactly as the operator would, then edit so there is
  // something to push. The push is what discovers the revocation.
  await setInviteActive(email, false);
  await page.click('.cm-content');
  await page.keyboard.type('\n\nEditedAfterRevocation\n');

  const denied = await page
    .locator('.banner', { hasText: 'you have been signed out' })
    .waitFor({ timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  check('revocation is surfaced to the user', denied);

  check('a revoked session is signed out', (await uidOf(page)) === '');

  const copies = await conflictCopies(page);
  check('revocation minted no conflict copies', copies === 0, `${copies} found`);

  const stillReadable = (await page.locator('body').innerText()).includes(
    'EditedAfterRevocation',
  );
  check('a revoked device keeps editing locally', stillReadable);

  const afterRevoke = await noteCount(uid);
  check(
    'revocation changed nothing already stored',
    afterRevoke === synced,
    `${afterRevoke} vs ${synced}`,
  );

  // Restoring access must bring sync back rather than leave the device stuck.
  // The session was ended, so that now takes a sign-in.
  await setInviteActive(email, true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await signIn(page, email);
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
  await page.waitForTimeout(6000);

  const clear = await page.locator('.banner', { hasText: 'you have been signed out' }).count();
  check('restoring access clears the warning', clear === 0);

  let resynced = false;
  for (let i = 0; i < 60 && !resynced; i++) {
    const res = await fetch(
      `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes`,
      { headers: { Authorization: 'Bearer owner' } },
    );
    const docs = res.ok ? ((await res.json()).documents ?? []) : [];
    // The edit made while revoked is a second accepted write to a note the
    // account already held at revision 1.
    resynced = docs.some((d) => Number(d.fields?.revision?.integerValue ?? 0) >= 2);
    if (!resynced) await page.waitForTimeout(500);
  }
  check('the edit made while revoked reached the account', resynced);

  const keptEdit = (await page.locator('body').innerText()).includes('EditedAfterRevocation');
  check('the edit made while revoked survived', keptEdit);

  const copiesAfter = await conflictCopies(page);
  check('restoring access minted no conflict copies', copiesAfter === 0, `${copiesAfter} found`);

  await context.close();
}

// --- 3. a restored session with no plan is signed out on the way in -------
{
  const email = `restored-${Date.now()}@example.test`;
  await provisionAccount(email, PASSWORD);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await typeNewNote(page, 'RestoredMarker');

  await signIn(page, email);
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
  await page.waitForTimeout(1500);
  check('the session is open before the plan goes', (await uidOf(page)) !== '');

  // The plan goes while the tab is shut; nothing is running to be refused.
  await setInviteActive(email, false);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });

  const told = await page
    .locator('.banner', { hasText: 'you have been signed out' })
    .waitFor({ timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  check('a restored session with no plan is told why it ended', told);
  check('a restored session with no plan is signed out', (await uidOf(page)) === '');

  const stillHasNote = (await page.locator('body').innerText()).includes('RestoredMarker');
  check('its notes are still readable locally', stillHasNote);

  await page.click('.cm-content');
  await page.keyboard.type('\n\nEditedAfterSignOut\n');
  await page.waitForTimeout(1500);
  const editable = (await page.locator('body').innerText()).includes('EditedAfterSignOut');
  check('and still editable', editable);

  await context.close();
}

// --- 4. an account emptied by the retention purge is furnished again ------
{
  const email = `purged-${Date.now()}@example.test`;
  await provisionAccount(email, PASSWORD);

  const context = await browser.newContext();
  let page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await signIn(page, email);
  await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
  await page.waitForTimeout(1500);
  await page.click('.cm-content');
  await page.keyboard.type('\n\nBeforeThePurge\n');

  const uid = await uidOf(page);
  let before = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    before = await noteCount(uid);
    if (before >= 1) break;
  }
  const keyUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/keys/primary`;
  const hasKey = async () => (await fetch(keyUrl, { headers: { Authorization: 'Bearer owner' } })).ok;
  check('the account is furnished before the purge', before >= 1 && (await hasKey()), `${before} notes`);

  // What the billing API's purge leaves behind: the login, and nothing
  // under it. Done with the tab shut, as it would be after ninety days.
  await page.close();
  const wiped = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  check('the emulator was emptied', wiped.ok && (await noteCount(uid)) === 0 && !(await hasKey()));
  // The plan is back: that is the only reason this device is syncing again.
  await setInviteActive(email, true);

  page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });

  let after = 0;
  let keyBack = false;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(500);
    after = await noteCount(uid);
    keyBack = await hasKey();
    if (keyBack && after >= before) break;
  }
  check('the key record is published again', keyBack);
  check('every note is uploaded again', after >= before, `${after} of ${before}`);

  const copies = await conflictCopies(page);
  check('furnishing the account again minted no conflict copies', copies === 0, `${copies} found`);
  const kept = (await page.locator('body').innerText()).includes('BeforeThePurge');
  check('the notes on the device were never touched', kept);

  await context.close();
}

// --- 5. an account reset from another device is not furnished again -------
//
// The opposite repair to section 4, from the same starting point: a bound,
// remembered device that still opens the old vault. Two shapes of "reset",
// one account each — the tombstone the billing API leaves, and the new vault
// some other device then creates in its place.
{
  const docsUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
  const owner = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const readDoc = async (path) => {
    const res = await fetch(`${docsUrl}/${path}`, { headers: owner });
    return res.ok ? res.json() : null;
  };
  const writeDoc = (path, fields) =>
    fetch(`${docsUrl}/${path}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields }) });
  const deleteNotes = async (uid) => {
    const res = await fetch(`${docsUrl}/users/${uid}/notes`, { headers: owner });
    for (const d of (await res.json()).documents ?? []) {
      await fetch(`http://${FIRESTORE_HOST}/v1/${d.name}`, { method: 'DELETE', headers: owner });
    }
  };

  async function furnished(label) {
    const email = `reset-${label}-${Date.now()}@example.test`;
    await provisionAccount(email, PASSWORD);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await enterVault(page);
    await signIn(page, email);
    await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
    await page.waitForTimeout(1500);
    await page.click('.cm-content');
    await page.keyboard.type(`\n\nBeforeTheReset${label}\n`);
    const uid = await uidOf(page);
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(500);
      if ((await noteCount(uid)) >= 1) break;
    }
    const key = await readDoc(`users/${uid}/keys/primary`);
    check(`[${label}] the account is furnished before the reset`, Boolean(key?.fields?.record));
    await page.close();
    return { context, uid, key };
  }

  async function reopenAndWatch(context, uid, label, expectRecord) {
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.cm-content', { timeout: 30_000 });
    let banner = false;
    for (let i = 0; i < 30 && !banner; i++) {
      await page.waitForTimeout(500);
      banner = (await page.locator('body').innerText()).includes('This account was reset on another device');
    }
    // Long enough for a sweep and a cycle to have run, had they been allowed.
    await page.waitForTimeout(4000);
    const key = await readDoc(`users/${uid}/keys/primary`);
    return { page, banner, key, notes: await noteCount(uid), expectRecord };
  }

  // 5a. Only the tombstone: nobody has created the new vault yet.
  {
    const { context, uid } = await furnished('tombstone');
    const now = String(Date.now());
    await writeDoc(`users/${uid}/keys/primary`, {
      v: { integerValue: '1' },
      resetAt: { integerValue: now },
      updatedAt: { integerValue: now },
    });
    await deleteNotes(uid);

    for (const pass of ['first open', 'after a reload']) {
      const { page, banner, key, notes } = await reopenAndWatch(context, uid, 'tombstone');
      check(`[tombstone, ${pass}] the reset banner is shown`, banner);
      check(`[tombstone, ${pass}] the old record was not put back`, !key?.fields?.record && Boolean(key?.fields?.resetAt));
      check(`[tombstone, ${pass}] no note was uploaded`, notes === 0, `${notes} notes`);
      const kept = (await page.locator('body').innerText()).includes('BeforeTheResettombstone');
      check(`[tombstone, ${pass}] the notes on the device were never touched`, kept);
      await page.close();
    }
    await context.close();
  }

  // 5b. A new vault already in place: a different `createdAt`, as a second
  // `createKeyRecord` would leave. The old device must not adopt, overwrite or
  // push into it.
  {
    const { context, uid, key } = await furnished('newvault');
    const fields = structuredClone(key.fields);
    const created = fields.record.mapValue.fields.createdAt;
    const bumped = String(Number(created.integerValue ?? created.doubleValue) + 1);
    fields.record.mapValue.fields.createdAt = { integerValue: bumped };
    await writeDoc(`users/${uid}/keys/primary`, fields);
    await deleteNotes(uid);

    const { page, banner, key: after, notes } = await reopenAndWatch(context, uid, 'newvault');
    check('[new vault] the reset banner is shown', banner);
    const kept = after?.fields?.record?.mapValue?.fields?.createdAt?.integerValue === bumped;
    check('[new vault] the new vault was not overwritten', kept);
    check('[new vault] no note was pushed into it', notes === 0, `${notes} notes`);
    await page.close();
    await context.close();
  }
}

console.table(results);

await browser.close();
await server.close();

if (failures.length) {
  console.log(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nAll allowlist checks pass.');
