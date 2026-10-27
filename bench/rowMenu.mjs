/**
 * Where the row `⋯` menu lands.
 *
 * The menu is placed from a rect measured at click time: below the button,
 * flipped above when the bottom of the window will not take it, then clamped
 * inside the viewport when neither side fits. That is arithmetic against the
 * window, so it has no unit test that would mean anything — it needs a real
 * viewport, a real panel height and a real scroll position.
 *
 * It is a gate rather than a report because the failure is invisible in
 * development: a menu opened from a row near the top of a tall window looks
 * right whatever the flip logic does, and only a `⋯` at the bottom edge, or a
 * short window, shows the bug. The list is seeded past `VIRTUALIZE_ABOVE` so
 * the rows the menu anchors to are the absolutely-positioned, destroyed-on-
 * scroll kind — the case the placement is written to survive.
 */
import { chromium } from 'playwright';
import { enterApp, seedEncryptedNotes, chooseStart, BENCH_PASSPHRASE } from './lib/app.mjs';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-rowmenu');

// Must match RowActions.svelte.
const GAP = 4;
const MARGIN = 8;
const NOTES = 150; // past VIRTUALIZE_ABOVE (100)

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5191, strictPort: true } });
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

const box = (locator) => locator.boundingBox();
const round = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');

/** Open the menu on one row and hand back the button's rect and the panel's. */
async function openMenuOn(page, rowIndex) {
  const row = page.locator('.list .row-wrap').nth(rowIndex);
  await row.hover();
  const more = row.locator('.row-action.more');
  const button = await box(more);
  await more.click();
  await page.waitForSelector('[role="dialog"]');
  const panel = await box(page.locator('[role="dialog"]'));
  const viewport = page.viewportSize();
  if (!button || !panel) throw new Error(`no row at index ${rowIndex}`);
  return { button, panel, viewport, more };
}

/**
 * The Tags section is `max-height: 25vh` and grows with the window, which would
 * make "is there room below this row" depend on the screen. Collapsing it puts
 * the first note row at a fixed offset from the top.
 */
async function collapseTags(page) {
  const toggle = page.locator('button[aria-controls="sidebar-tags"]');
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'true') {
    await toggle.click();
    await page.waitForTimeout(200);
  }
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });
}

/** The panel is fully on screen, with the margin the placement promises. */
function insideViewport({ panel, viewport }) {
  return (
    panel.x >= MARGIN - 1 &&
    panel.y >= MARGIN - 1 &&
    panel.x + panel.width <= viewport.width - MARGIN + 1 &&
    panel.y + panel.height <= viewport.height - MARGIN + 1
  );
}

// --- desktop -------------------------------------------------------------
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));

await enterApp(page, base);
await page.waitForTimeout(300);
await seedEncryptedNotes(page, NOTES);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.list .row', { timeout: 30_000 });
await page.waitForTimeout(400);

check(
  'the list is virtualized, so the anchor rows are the destroyable kind',
  (await page.locator('.list .row').count()) < NOTES,
  `${await page.locator('.list .row').count()} of ${NOTES} rows in the DOM`,
);

await collapseTags(page);

await scenario('room below: the menu drops under the button', async () => {
  const at = await openMenuOn(page, 0);
  // If this ever fails the scenario is testing nothing: the row has no room
  // below it, so landing above would be correct rather than a regression.
  check(
    'the first row really does have room below it',
    at.button.y + at.button.height + GAP + at.panel.height <= at.viewport.height - MARGIN,
    `button bottom ${Math.round(at.button.y + at.button.height)}, panel ${Math.round(at.panel.height)}px, window ${at.viewport.height}`,
  );
  check(
    'the menu sits directly under the ⋯',
    Math.abs(at.panel.y - (at.button.y + at.button.height + GAP)) <= 1,
    `button bottom ${Math.round(at.button.y + at.button.height)}, panel top ${Math.round(at.panel.y)}`,
  );
  check(
    'the menu opens rightward from the ⋯',
    Math.abs(at.panel.x - at.button.x) <= 1,
    `button left ${Math.round(at.button.x)}, panel left ${Math.round(at.panel.x)}`,
  );
  check('the menu is on screen', insideViewport(at), round(at.panel));

  // The panel is hidden until the placement effect unhides it, and a hidden
  // element cannot take focus. If placement ever stops being synchronous this
  // is what notices: focus stays on the ⋯, and arrow keys go nowhere.
  const focused = await page.evaluate(() => {
    const first = document.querySelector('[role="dialog"] button');
    return document.activeElement === first ? (first?.textContent?.trim() ?? '') : 'NOT THE MENU';
  });
  check('the first item has the keyboard', focused !== 'NOT THE MENU', focused);

  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  check('ArrowDown moves down the menu', second !== focused, `${focused} → ${second}`);

  const backdrop = await page.evaluate(
    () => getComputedStyle(document.querySelector('[role="dialog"]').parentElement).backgroundColor,
  );
  check('the anchored backdrop paints nothing', backdrop === 'rgba(0, 0, 0, 0)', backdrop);

  const lit = await page.evaluate(
    () => getComputedStyle(document.querySelector('.list .row-action.more[aria-expanded="true"]')).opacity,
  );
  check('the ⋯ stays visible under its own menu', lit === '1', lit);
  // The whole point of anchoring: it is near the row, not in the middle.
  const centred = (at.viewport.width - at.panel.width) / 2;
  check(
    'the menu is not centred on the window',
    Math.abs(at.panel.x - centred) > 100,
    `panel left ${Math.round(at.panel.x)}, centred would be ${Math.round(centred)}`,
  );
  await closeMenu(page);
});

await scenario('no room below: the menu flips above the button', async () => {
  // The last row whose ⋯ is still on screen — the bottom edge of the window.
  const rows = await page.locator('.list .row-wrap').count();
  let index = rows - 1;
  for (; index > 0; index--) {
    const r = await box(page.locator('.list .row-wrap').nth(index));
    if (r && r.y + r.height <= 800) break;
  }
  const at = await openMenuOn(page, index);
  check(
    'the menu is above the ⋯, not below it',
    at.panel.y + at.panel.height <= at.button.y + 1,
    `panel bottom ${Math.round(at.panel.y + at.panel.height)}, button top ${Math.round(at.button.y)}`,
  );
  check(
    'the flipped menu clears the button by the same gap',
    Math.abs(at.button.y - (at.panel.y + at.panel.height) - GAP) <= 1,
    `${Math.round(at.button.y - (at.panel.y + at.panel.height))}px`,
  );
  check('the flipped menu is on screen', insideViewport(at), round(at.panel));
  await closeMenu(page);
});

await scenario('scrolling the list closes the menu', async () => {
  await openMenuOn(page, 0);
  await page.evaluate(() => {
    document.querySelector('.viewport')?.scrollBy(0, 300);
  });
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 3_000 });
  check('a scroll under an open menu dismisses it', true);
});

await scenario('a folder ⋯ places the same way', async () => {
  // First run has no folders, and the folder row is the case the report that
  // prompted this change was about — so make one.
  page.once('dialog', (d) => void d.accept('Placement'));
  await page.click('button[aria-label="New folder"]');
  await page.waitForTimeout(700);
  const folder = page.locator('.folder-wrap').filter({ has: page.locator('.row-action.more') }).first();
  check('there is a folder row to open a menu on', (await folder.count()) > 0);
  await folder.hover();
  const button = await box(folder.locator('.row-action.more'));
  await folder.locator('.row-action.more').click();
  await page.waitForSelector('[role="dialog"]');
  const panel = await box(page.locator('[role="dialog"]'));
  check(
    'the folder menu is anchored to its own ⋯',
    Math.abs(panel.x - button.x) <= 1 && panel.y >= button.y,
    `button ${round(button)}, panel ${round(panel)}`,
  );
  // The count sits where the controls are, so an open menu has to keep it
  // hidden the way hovering does.
  const count = await page.evaluate(
    () =>
      getComputedStyle(
        document
          .querySelector('.folder-wrap:has(.row-action[aria-expanded="true"])')
          .querySelector('.count'),
      ).visibility,
  );
  check('the folder count stays hidden under the open menu', count === 'hidden', count);

  // Every item's `run` fires after the menu has closed, so each has to have
  // captured its folder id rather than reaching back through a reactive target.
  await page.locator('[role="dialog"] button', { hasText: 'Rename' }).click();
  await page.waitForTimeout(500);
  check('a menu item still knows its folder after the menu closes', pageErrors.length === 0, pageErrors[0] ?? '');
});

await scenario('a window too short for either side clamps the menu', async () => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.waitForTimeout(300);
  const at = await openMenuOn(page, 0);
  check(
    'the short-window menu stays inside the viewport',
    insideViewport(at),
    `panel ${round(at.panel)} in ${at.viewport.width}x${at.viewport.height}`,
  );
  await closeMenu(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

// --- phone: the menu stays the centred sheet it began as -----------------
await scenario('on a phone the menu is centred, not anchored', async () => {
  const phone = await browser.newContext({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
  });
  const small = await phone.newPage();
  small.on('pageerror', (e) => pageErrors.push(String(e)));
  // Not `enterApp`: a phone shows the list *instead of* the editor, so waiting
  // on `.cm-content` waits forever.
  await small.goto(base, { waitUntil: 'load' });
  await chooseStart(small, 'device');
  if (await small.locator('#new-pass').count()) {
    await small.fill('#new-pass', BENCH_PASSPHRASE);
    await small.fill('#confirm-pass', BENCH_PASSPHRASE);
    await small.click('.local button[type="submit"]');
    await small.waitForSelector('.code', { timeout: 40_000 });
    await small.check('.check input');
    await small.click('button.primary');
  }
  await small.waitForSelector('.list .row', { timeout: 40_000 });
  await small.waitForTimeout(300);

  const more = small.locator('.list .row-wrap').first().locator('.row-action.more');
  await more.click();
  await small.waitForSelector('[role="dialog"]');
  const panel = await box(small.locator('[role="dialog"]'));
  const centred = (412 - panel.width) / 2;
  check(
    'the phone menu is horizontally centred',
    Math.abs(panel.x - centred) <= 2,
    `panel left ${Math.round(panel.x)}, centred is ${Math.round(centred)}`,
  );
  const scrim = await small.evaluate(
    () => getComputedStyle(document.querySelector('[role="dialog"]').parentElement).backgroundColor,
  );
  check('the phone sheet keeps its scrim', scrim !== 'rgba(0, 0, 0, 0)', scrim);
  check(
    'the phone menu omits "Open beside"',
    (await small.locator('[role="dialog"] button', { hasText: 'Open beside' }).count()) === 0,
  );
  await phone.close();
});

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
await server.close();

console.table(results);
if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nRow menu placement: all checks passed.');
