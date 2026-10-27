/**
 * Phase 5 verification: multi-device and multi-tab reliability.
 *
 * §16 lists what the sync layer must handle and §25 lists the scenarios that
 * must not lose data. Each gets a named test here rather than an assurance.
 *
 * The hardest one to get right is the concurrent edit: two devices change the
 * same note while neither can see the other, and both versions have to survive.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionAccount } from './emulatorAccounts.mjs';
import { meterBrowser, formatOps, billedReads } from './firestoreOps.mjs';
import { writeFileSync } from 'node:fs';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-phase5');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const FIRESTORE_HOST = '127.0.0.1:8085';
const PASSPHRASE = 'a sufficiently long passphrase';

console.log('Building app…');
await build({
  root: repoRoot,
  logLevel: 'error',
  // Development mode, because this build talks to the emulators: the CSP only
  // allows localhost origins outside production, so a production build here is
  // correctly blocked from reaching them.
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
  preview: { port: 5192, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
// Every scenario also reports what it cost in billed Firestore operations.
const ops = meterBrowser(browser);
const results = [];
const failures = [];
const pageErrors = [];

const EXPECTED_WHILE_OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource|net::ERR/i;

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

let step = '';
const at = (label) => {
  step = label;
};

async function scenario(name, fn) {
  step = 'start';
  ops.takeTotal();
  try {
    await fn();
  } catch (err) {
    check(name, false, `[${step}] ${String(err).split('\n')[0].slice(0, 110)}`);
  }
  results.push({ check: `${name}: Firestore ops`, verdict: 'info', detail: formatOps(ops.takeTotal()) });
}

async function newPage(context) {
  const page = await context.newPage();
  const record = (text) => {
    if (!EXPECTED_WHILE_OFFLINE.test(text)) pageErrors.push(text);
  };
  page.on('pageerror', (e) => record(`pageerror: ${e}`));
  page.on('console', (m) => m.type() === 'error' && record(`console: ${m.text()}`));
  return page;
}

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

/** Sign in from inside the app (toolbar) or from the vault screen. */
async function signIn(page, email, password, register) {
  // There is no signup form any more: syncing is invite-only, so a first-time
  // account is created and invited out of band exactly as the operator would.
  if (register) await provisionAccount(email, password);

  const inApp = await page.locator('button[aria-label^="Account"]').count();
  // On the vault screen the form is a step of the wizard, behind the opening
  // question — still `.account`, but it does not exist until it is picked.
  if (inApp) await page.click('button[aria-label^="Account"]');
  else await chooseStart(page, 'account');
  const scope = inApp ? '.panel' : '.account';

  await page.waitForSelector(`${scope} #account-email`, { timeout: 10_000 });
  await page.fill('#account-email', email);
  await page.fill('#account-password', password);
  await page.click(`${scope} button[type="submit"]`);
  if (inApp) await page.waitForSelector('.panel', { state: 'detached', timeout: 25_000 });
  // There is no separate "Syncing" card any more: a successful sign-in walks
  // the wizard straight on to the passphrase step, which is the whole point of
  // the redesign. `.signed-in` is that step's "Signed in as …" line and renders
  // only when there really is a session, so it asserts the same thing.
  else await page.waitForSelector('.signed-in', { timeout: 25_000 });
}

/** A device that already has an account: sign in, then unlock. */
async function joinExistingAccount(context, email, password) {
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  // `signIn` does the screen-has-rendered wait, via `chooseStart`.
  await signIn(page, email, password, false);
  await page.waitForSelector('#pass', { timeout: 20_000 });
  await page.fill('#pass', PASSPHRASE);
  await page.click('.local button[type="submit"]');
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  return page;
}

const titles = (page) => page.locator('.list .title').allTextContents();

const hasTitle = (page, needle, timeout = 45_000) =>
  page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.list .title')].some((el) => el.textContent?.includes(text)),
    needle,
    { timeout },
  );

async function typeNewNote(page, title) {
  await page.click('button.primary');
  await page.waitForTimeout(300);
  await page.keyboard.type(`# ${title}\n`);
  await page.waitForTimeout(1500);
}

async function firestoreNoteCount(uid) {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}/notes`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!res.ok) return -1;
  const json = await res.json();
  return (json.documents ?? []).length;
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

// --- 1. multi-tab: a follower's edit still reaches the backend ------------
await scenario('multi-tab coordination', async () => {
  const account = `tabs-${Date.now()}@example.test`;
  const context = await browser.newContext();

  const tabA = await newPage(context);
  await tabA.goto(base, { waitUntil: 'load' });
  await enterVault(tabA);
  await signIn(tabA, account, 'test-password-123', true);
  await tabA.waitForTimeout(2000);

  // A second tab in the same profile. Exactly one of the two should own the
  // backend connection; the other must still be able to write.
  const tabB = await newPage(context);
  await tabB.goto(base, { waitUntil: 'load' });
  await tabB.waitForSelector('.cm-content', { timeout: 30_000 });
  await tabB.waitForTimeout(1500);

  const marker = `TabFollowerGlyph${Date.now()}`;
  await typeNewNote(tabB, marker);

  const uid = await uidOf(tabA);
  let count = 0;
  for (let i = 0; i < 40; i++) {
    await tabB.waitForTimeout(500);
    count = await firestoreNoteCount(uid);
    if (count >= 3) break; // two seeded notes plus this one
  }

  check(
    "a second tab's edit still reaches the backend",
    count >= 3,
    `${count} documents`,
  );

  // And the first tab should learn about it without a reload.
  //
  // Budget deliberately tight. This is now a deliberate broadcast on a one
  // second rate limit, not a hope that the backend echo happens to provoke a
  // reload, so a regression to "only via the backend" has to fail loudly rather
  // than pass slowly.
  await hasTitle(tabA, marker, 8_000);
  check('the other tab sees the change without reloading', true);

  // The other direction, which nothing asserted before and which users hit more
  // often: they keep working in the tab they already had open — the leader,
  // since it took the lock first — and it is the second tab that goes stale.
  const fromLeader = `TabLeaderGlyph${Date.now()}`;
  await typeNewNote(tabA, fromLeader);
  await hasTitle(tabB, fromLeader, 8_000);
  check("the follower sees the leader's change without reloading", true);

  // And the negative, which matters more than either (§25: never lose text).
  // The same note open in two tabs must not become a tug-of-war — a refresh
  // that reopened the document would take the caret and the unsaved line with
  // it. Both tabs are on `fromLeader`; type in B, and A must keep what its own
  // user wrote.
  await tabA.click('.cm-content');
  await tabA.keyboard.type('\nedited in the first tab');
  await tabB.click('.list .title');
  await tabB.waitForTimeout(300);
  await tabB.click('.cm-content');
  await tabB.keyboard.type('\nedited in the second tab');
  await tabB.waitForTimeout(3000);
  const keptA = await tabA.locator('.cm-content').textContent();
  check(
    'a note open in two tabs is not overwritten under the user',
    keptA?.includes('edited in the first tab') ?? false,
    keptA?.slice(0, 80) ?? '',
  );

  await tabA.close();
  await tabB.close();
  await context.close();
});

// --- 2. deletion propagates and does not resurrect ------------------------
await scenario('deletion sync', async () => {
  const account = `del-${Date.now()}@example.test`;
  const password = 'test-password-123';

  const contextA = await browser.newContext();
  const pageA = await newPage(contextA);
  await pageA.goto(base, { waitUntil: 'load' });
  await enterVault(pageA);
  await signIn(pageA, account, password, true);
  await pageA.waitForTimeout(2000);

  const marker = `DoomedNoteSigil${Date.now()}`;
  await typeNewNote(pageA, marker);
  await pageA.waitForTimeout(2500);

  const contextB = await browser.newContext();
  const pageB = await joinExistingAccount(contextB, account, password);
  await hasTitle(pageB, marker);
  check('the note reached the second device', true);

  // Delete it on A, through the real UI.
  pageA.once('dialog', (dialog) => void dialog.accept());
  // Delete moved into the row's `⋯` menu; only the pin is left on the row.
  await pageA.click(`button[aria-label="More actions for ${marker}"]`);
  await pageA.locator('[role="dialog"] button', { hasText: 'Delete' }).click();
  await pageA.waitForTimeout(1500);

  const goneOnA = !(await titles(pageA)).some((t) => t.includes(marker));
  check('the note disappears on the device that deleted it', goneOnA);

  // And the tombstone has to reach B.
  let goneOnB = false;
  for (let i = 0; i < 50; i++) {
    await pageB.waitForTimeout(500);
    goneOnB = !(await titles(pageB)).some((t) => t.includes(marker));
    if (goneOnB) break;
  }
  check('the deletion propagates to the other device', goneOnB);

  // The hard case: a reload must not resurrect it from a stale local record.
  //
  // B now has no notes at all — it never had first-run content of its own, and
  // the one note it pulled has been deleted. So wait for the app shell, not for
  // an editor: requiring `.cm-content` here only passed because an empty-
  // looking database used to be re-seeded on startup, which is the very bug
  // this scenario is about. An empty editor pane is the correct answer.
  await pageB.reload({ waitUntil: 'load' });
  await pageB.waitForSelector('.cm-content, .editor-pane .empty', { timeout: 30_000 });
  await pageB.waitForTimeout(2500);
  const titlesB = await titles(pageB);
  const stillGone = !titlesB.some((t) => t.includes(marker));
  check('the deleted note does not resurrect after a reload', stillGone);

  // And nothing is conjured alongside what it legitimately pulled. B holds the
  // account's first-run notes because they were synced to it; what it must
  // never do is write a second "Welcome to HushJot" and "Scratch" of its own on
  // startup, which is what a local database that merely *looks* empty used to
  // earn. Duplicate titles are the symptom.
  const countsB = new Map();
  for (const title of titlesB) countsB.set(title, (countsB.get(title) ?? 0) + 1);
  const dupedB = [...countsB.entries()].filter(([, n]) => n > 1);
  check(
    'the emptied device conjures no first-run notes of its own',
    dupedB.length === 0,
    dupedB.map(([title, n]) => `${title} ×${n}`).join(' | ') || titlesB.join(' | '),
  );

  await pageA.close();
  await pageB.close();
  await contextA.close();
  await contextB.close();
});

// --- 3. concurrent edits keep both versions -------------------------------
await scenario('concurrent edit conflict', async () => {
  const account = `conflict-${Date.now()}@example.test`;
  const password = 'test-password-123';

  const contextA = await browser.newContext();
  const pageA = await newPage(contextA);
  await pageA.goto(base, { waitUntil: 'load' });
  await enterVault(pageA);
  await signIn(pageA, account, password, true);
  await pageA.waitForTimeout(2000);

  const shared = `SharedBattlegroundNote${Date.now()}`;
  await typeNewNote(pageA, shared);
  await pageA.waitForTimeout(2500);

  const contextB = await browser.newContext();
  const pageB = await joinExistingAccount(contextB, account, password);
  await hasTitle(pageB, shared);

  // Both go offline so neither can see the other's edit.
  await contextA.setOffline(true);
  await contextB.setOffline(true);

  const editA = `EditFromAlpha${Date.now()}`;
  const editB = `EditFromBravo${Date.now()}`;

  const openShared = async (page) => {
    await page.evaluate((text) => {
      const row = [...document.querySelectorAll('.list .row')].find((el) =>
        el.textContent?.includes(text),
      );
      row?.click();
    }, shared);
    await page.waitForTimeout(500);
    await page.click('.cm-content');
  };

  await openShared(pageA);
  await pageA.keyboard.type(` ${editA} `);
  await pageA.waitForTimeout(1000);

  await openShared(pageB);
  await pageB.keyboard.type(` ${editB} `);
  await pageB.waitForTimeout(1000);

  // B reconnects first and wins the race.
  await contextB.setOffline(false);
  await pageB.evaluate(() => window.dispatchEvent(new Event('online')));
  await pageB.waitForTimeout(4000);

  // A reconnects with a now-stale revision: the compare-and-swap must reject
  // its push, and §16 requires that its text survive anyway.
  await contextA.setOffline(false);
  await pageA.evaluate(() => window.dispatchEvent(new Event('online')));

  let sawConflictCopy = false;
  for (let i = 0; i < 40; i++) {
    await pageA.waitForTimeout(500);
    const list = await titles(pageA);
    if (list.some((t) => t.includes('conflict copy'))) {
      sawConflictCopy = true;
      break;
    }
  }

  check('the losing device keeps its text as a conflict copy', sawConflictCopy);

  // The real requirement (§16): *both* texts survive, readable. Search proves
  // that end to end — it decrypts and indexes, so a hit means the text is
  // present and recoverable, not merely that some ciphertext exists.
  const findable = async (page, needle) => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.palette', { timeout: 10_000 });
    await page.keyboard.type(needle);
    await page.waitForTimeout(700);
    const hits = await page.locator('.result').count();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });
    return hits > 0;
  };

  // Give the search worker time to index the newly arrived and copied notes.
  await pageA.waitForTimeout(2000);
  check("the losing device keeps its own edit", await findable(pageA, editA));
  check("the losing device also has the winner's edit", await findable(pageA, editB));

  const conflictBanner = await pageA.locator('.banner.warn').count();
  check('the conflict is surfaced to the user', conflictBanner > 0);

  await pageA.close();
  await pageB.close();
  await contextA.close();
  await contextB.close();
});

// --- 4. signing out stops sync but never editing --------------------------
//
// Sign-out locks the vault as well, so the journey passes back through the
// passphrase. What it must not do is take anything away: the notes are still
// there, still editable, and still persisting locally with no account at all.
await scenario('session ends mid-edit', async () => {
  const account = `expiry-${Date.now()}@example.test`;
  const context = await browser.newContext();
  const page = await newPage(context);
  at('load');
  await page.goto(base, { waitUntil: 'load' });
  at('enter vault');
  await enterVault(page);
  at('sign in');
  await signIn(page, account, 'test-password-123', true);
  await page.waitForTimeout(2000);

  at('open account panel');
  await page.click('button[aria-label^="Account"]');
  await page.waitForSelector('.panel', { timeout: 10_000 });
  at('click sign out');
  const panelText = (await page.locator('.panel').innerText()).slice(0, 90).replace(/\n+/g, ' | ');
  check('the account panel shows a signed-in session', /Signed in as/.test(panelText), panelText);
  const btn = page.locator('.panel button.secondary');
  let how = 'normal';
  try {
    await btn.click({ timeout: 6000 });
  } catch {
    // The panel re-renders as sync status ticks, which can keep Playwright's
    // actionability check from ever settling. The button itself is fine.
    how = 'forced';
    await btn.click({ force: true, timeout: 6000 });
  }
  check('sign out is clickable', true, how);

  at('unlock again');
  // Signing out locks. It used to sever only the account and leave the notes
  // on screen, which is the thing `bench:vault` gates; here it only has to
  // hold long enough to prove the panel really closed and the shell really
  // went with it, before this scenario's actual subject — that a device with
  // no session is still a fully working notepad.
  await page.waitForSelector('#pass', { timeout: 20_000 });
  check('signing out closes the vault too', (await page.locator('.cm-content').count()) === 0);
  check('signing out closes the account panel', (await page.locator('.panel').count()) === 0);
  await enterVault(page);

  at('check editor');
  const editable = await page.locator('.cm-content').count();
  check('the editor comes back with no session', editable > 0);

  at('type after sign out');
  const marker = `PostSignOutMark${Date.now()}`;
  await page.click('.cm-content');
  await page.keyboard.type(` ${marker} `);
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await page.waitForTimeout(1200);

  at('search after reload');
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.palette', { timeout: 10_000 });
  await page.keyboard.type(marker);
  await page.waitForTimeout(800);
  const hits = await page.locator('.result').count();
  check('edits made without a session still persist locally', hits > 0, `${hits} hits`);

  await page.close();
  await context.close();
});

// --- 5. how long a change actually takes to cross ------------------------
//
// §7 and §27 both ask for synchronisation to be an instrumented number, and it
// never was one. That is how a ten-second propagation delay survived: the idle
// debounce is restarted by every queued change, and nothing measured what the
// user actually experiences, so the ceiling silently became the cadence.
//
// Measured through the real UI on two browser contexts, so it includes the
// write debounce, the push, the listener and the pull — the whole path, not a
// timer in isolation. Budgets are deliberately loose: this runs against a real
// emulator over a real socket, and the point is to catch a regression to the
// old order of magnitude, not to police a few hundred milliseconds.
const LATENCY_BUDGET_MS = { typing: 6000, create: 3000 };

await scenario('cross-device latency', async () => {
  const account = `lat-${Date.now()}@example.test`;
  const password = 'test-password-123';

  at('sign in on A');
  const contextA = await browser.newContext();
  const pageA = await newPage(contextA);
  await pageA.goto(base, { waitUntil: 'load' });
  await enterVault(pageA);
  await signIn(pageA, account, password, true);
  await pageA.waitForTimeout(2000);

  at('join on B');
  const seed = `LatencySeedGlyph${Date.now()}`;
  await typeNewNote(pageA, seed);
  await pageA.waitForTimeout(2500);
  const contextB = await browser.newContext();
  const pageB = await joinExistingAccount(contextB, account, password);
  await hasTitle(pageB, seed);

  /**
   * Poll B until `seen` reports true, and report the elapsed time from `start`.
   *
   * The clock starts on A, before the action, rather than when polling begins:
   * the debounces on A are exactly what is being measured, so excluding them
   * would measure the network and call it the answer.
   */
  const elapsedUntil = async (start, seen, limitMs) => {
    while (Date.now() - start < limitMs) {
      if (await seen()) return Date.now() - start;
      await pageB.waitForTimeout(100);
    }
    return Infinity;
  };

  // (a) An edit made in the middle of a writing session, which is the case the
  // user actually reported and the one both debounces conspire to delay.
  //
  // The shape of the typing matters more than the speed of it. A word, then a
  // pause of a few hundred milliseconds, then the next word: long enough for
  // the 150 ms write debounce to drain and queue a change, short enough that
  // the sync engine's idle timer is restarted before it can expire. Machine-gun
  // typing with no pauses does *not* reproduce this — the write debounce then
  // only drains on its own 2 s ceiling, which is slower than the idle timer and
  // lets it fire. Measuring that instead is how this delay stayed invisible.
  at('typing latency');
  const burst = async (text) => {
    await pageA.keyboard.type(text, { delay: 30 });
    await pageA.waitForTimeout(300);
  };

  const typed = `Glyph${Date.now() % 100000}`;
  await pageA.click('.cm-content');
  await burst('warming ');
  await burst('up ');

  const typedAt = Date.now();
  await burst(typed);

  // Keep typing while B is watched, or the measurement quietly becomes the
  // "user stopped typing" case again.
  let typing = true;
  const keepTyping = (async () => {
    while (typing) await burst('and ');
  })();

  const typingMs = await elapsedUntil(
    typedAt,
    () => pageB.evaluate((t) => document.body.innerText.includes(t), typed),
    20_000,
  );
  typing = false;
  await keepTyping;

  check(
    'an edit made while typing crosses within budget',
    typingMs <= LATENCY_BUDGET_MS.typing,
    `${typingMs} ms (budget ${LATENCY_BUDGET_MS.typing} ms)`,
  );

  // (b) A new note, which is a discrete action and should not wait behind a
  // debounce meant for keystrokes.
  //
  // Timed on the note appearing at all rather than on its title: creating is
  // the discrete action under test, and waiting for a typed title would fold
  // the keystroke path back into the measurement.
  at('create latency');
  const before = (await titles(pageB)).length;
  const createdAt = Date.now();
  await pageA.click('button.primary');
  const createMs = await elapsedUntil(
    createdAt,
    async () => (await titles(pageB)).length > before,
    20_000,
  );

  check(
    'a new note reaches the other device within budget',
    createMs <= LATENCY_BUDGET_MS.create,
    `${createMs} ms (budget ${LATENCY_BUDGET_MS.create} ms)`,
  );

  console.log(`\n  latency: typing ${typingMs} ms, create ${createMs} ms\n`);

  await pageA.close();
  await pageB.close();
  await contextA.close();
  await contextB.close();
});

// --- 6. operations per session ---------------------------------------------
//
// What a session costs in billed Firestore operations, measured rather than
// modelled: an earlier estimate priced the backend from a guess about
// which calls the cadence makes, and this replaces the guess.
//
// One device, so nothing another device does is folded into its bill. Each
// phase starts after the previous one has settled, because a cycle still
// running when the meter is read belongs to the phase before.
//
// Visible and hidden idle are the pair that matters. An idle cycle is two
// empty queries plus the rules' allowlist lookup for each — four billed reads —
// and a tab left open all day runs one a minute unless it is hidden
// (`HIDDEN_BACKSTOP_MS` in `src/core/sync/engine.ts`).
const IDLE_WINDOW_MS = 125_000;
const IDLE_CYCLE_READS = 4;
/**
 * Writes for a minute of continuous typing. The 3 s ceiling allows at most
 * twenty checkpoints a minute; 17 were measured, and this is that plus half again,
 * so a cadence regression fails rather than quietly raising the bill.
 *
 * Each checkpoint is two document writes since the storage meter rides in the
 * same commit as the note (`src/adapters/firebase/usage.ts`): 34 measured, 52
 * allowed. The cadence is unchanged, and the cadence is what this guards.
 */
const TYPING_MINUTE_WRITE_BUDGET = 52;

const opsReport = {};

await scenario('operations per session', async () => {
  const account = `ops-${Date.now()}@example.test`;
  const password = 'test-password-123';

  at('sign in');
  const context = await browser.newContext();
  const page = await newPage(context);
  await page.goto(base, { waitUntil: 'load' });
  await enterVault(page);
  await signIn(page, account, password, true);
  await page.waitForTimeout(5000);
  opsReport.signIn = ops.take(context);

  const settle = () => page.waitForTimeout(5000);
  const burst = async (text) => {
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForTimeout(300);
  };

  at('typing minute');
  await typeNewNote(page, `OpsNote${Date.now()}`);
  await settle();
  ops.take(context);
  const typingStart = Date.now();
  while (Date.now() - typingStart < 60_000) await burst('words ');
  await settle();
  opsReport.typingMinute = ops.take(context);
  check(
    'a minute of typing stays within its write budget',
    opsReport.typingMinute.writes <= TYPING_MINUTE_WRITE_BUDGET,
    `${formatOps(opsReport.typingMinute)} (budget ${TYPING_MINUTE_WRITE_BUDGET} writes)`,
  );

  at('create notes');
  for (let i = 0; i < 3; i++) await typeNewNote(page, `OpsCreated${i}-${Date.now()}`);
  await settle();
  opsReport.createThreeNotes = ops.take(context);

  at('idle visible');
  await page.waitForTimeout(IDLE_WINDOW_MS);
  opsReport.idleVisible = ops.take(context);
  const visibleCycles = billedReads(opsReport.idleVisible) / IDLE_CYCLE_READS;
  check(
    'a visible idle tab checks about once a minute',
    visibleCycles >= 1 && visibleCycles <= 3,
    `${formatOps(opsReport.idleVisible)} in ${IDLE_WINDOW_MS / 1000} s`,
  );

  at('idle hidden');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Hiding flushes the open note (`App.svelte`), and a pane that was edited
  // since its last commit writes once and syncs — its own cost, measured
  // apart so it cannot pass for a backstop firing.
  await settle();
  opsReport.hide = ops.take(context);
  await page.waitForTimeout(IDLE_WINDOW_MS);
  opsReport.idleHidden = ops.take(context);
  // A minute armed before hiding, with no flush cycle to replace it, still
  // fires once; nothing after it should.
  check(
    'a hidden idle tab stretches its backstop',
    billedReads(opsReport.idleHidden) <= IDLE_CYCLE_READS,
    `${formatOps(opsReport.idleHidden)} in ${IDLE_WINDOW_MS / 1000} s`,
  );

  at('visible again');
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle();
  opsReport.becameVisible = ops.take(context);
  check(
    'coming back to the tab syncs at once',
    billedReads(opsReport.becameVisible) >= 2,
    formatOps(opsReport.becameVisible),
  );

  await page.close();
  await context.close();
});

if (Object.keys(opsReport).length) {
  writeFileSync(
    resolve(here, 'results-ops.json'),
    JSON.stringify(
      { measuredAt: new Date().toISOString(), idleWindowMs: IDLE_WINDOW_MS, ...opsReport },
      null,
      2,
    ) + '\n',
  );
}

await browser.close();
await server.close();

console.log('');
console.table(results);

if (pageErrors.length) {
  console.error(`\nUnexpected page errors (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 10)) console.error('  ' + e);
}

if (failures.length || pageErrors.length) {
  console.error(`\nFAILED (${failures.length} checks, ${pageErrors.length} unexpected errors):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nAll Phase 5 checks pass.\n');
