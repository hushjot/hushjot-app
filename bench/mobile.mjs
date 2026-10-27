/**
 * Mobile-profile measurements, closing (or honestly bounding) the two
 * caveats Phase 0 left open.
 *
 * ## What this can and cannot tell you
 *
 * Chromium's CDP throttling scales **CPU scheduling**. It does not model
 * memory bandwidth, cache hierarchy, or thermal behaviour. That matters
 * enormously here:
 *
 * - **Argon2id is memory-hard by design.** Its cost is dominated by random
 *   access across 64 MiB, which throttling barely touches — Spike 2 measured
 *   94.7 ms at both 1x and 4x. So this run reports the number but does **not**
 *   claim to be a phone. Only a real device closes that question.
 * - **Editor latency is CPU-bound**, so throttling is a reasonable proxy, and
 *   the end-of-document tail Spike 1 found is meaningful here.
 *
 * Reporting a throttled Argon2id figure as a phone measurement would be
 * exactly the kind of assumption §33.3 warns against, so this prints the
 * caveat alongside the number.
 */
import { chromium, devices } from 'playwright';
import { build, preview } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseStart } from './lib/app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-mobile');

const PASSPHRASE = 'a sufficiently long passphrase';
/** Mid-range Android is roughly 4-6x slower than a modern laptop on CPU. */
const CPU_THROTTLE = 6;

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({
  root: repoRoot,
  build: { outDir },
  preview: { port: 5194, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const phone = devices['Pixel 7'] ?? devices['Pixel 5'];

/** Tap into the editor, which on a phone is a separate screen from the list. */
async function openEditor(page) {
  if (await page.locator('.cm-content').count()) return;
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.cm-content', { timeout: 60_000 });
}

const context = await browser.newContext({ ...phone });
const page = await context.newPage();
const client = await context.newCDPSession(page);
await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// --- vault creation, which is one Argon2id derivation --------------------
await page.goto(base, { waitUntil: 'load' });
// Both of these are before the clock, and both have to be.
//
//  - the choice, because it is a human decision this harness is not measuring;
//  - the *enabled* submit, because the create form is held shut until auth has
//    settled (creating before that answer forks the account's vault) and
//    Playwright's `click()` auto-waits for enabled. Start the clock first and
//    this number quietly becomes "Argon2id plus however long Firebase took".
await chooseStart(page, 'device');
await page.waitForSelector('#new-pass', { timeout: 40_000 });
await page.waitForSelector('.local button[type="submit"]:not([disabled])', {
  timeout: 40_000,
});

const startedUnlock = Date.now();
await page.fill('#new-pass', PASSPHRASE);
await page.fill('#confirm-pass', PASSPHRASE);
await page.click('.local button[type="submit"]');
await page.waitForSelector('.code', { timeout: 60_000 });
const vaultCreateMs = Date.now() - startedUnlock;

await page.check('.check input');
await page.click('button.primary');

// On a phone the app lands on the note list, not the editor (§21) — the
// editor only appears once a note is tapped.
await page.waitForSelector('.list .row', { timeout: 60_000 });
await openEditor(page);
await page.waitForTimeout(800);

// Creation derives twice (passphrase and recovery code) and wraps the key, so
// a plain unlock is meaningfully cheaper. Measure that separately.
//
// Lock used to be a 30px icon in the phone's copy of the desktop topbar. It is
// now a row in the More sheet, so this opens the sheet first — and asserts the
// thing the old click never did, that the control is finger-sized. A phone has
// no ⌘J Q, so this row is the only way to lock the device.
await page.click('button[aria-label="More"]');
const lockRow = page.locator('[role="dialog"] button', { hasText: 'Lock' }).first();
await lockRow.waitFor({ timeout: 20_000 });
const lockBox = await lockRow.boundingBox();
check(
  'Lock is reachable and finger-sized on a phone',
  Boolean(lockBox && lockBox.width >= 44 && lockBox.height >= 44),
  lockBox ? `${Math.round(lockBox.width)}x${Math.round(lockBox.height)}` : 'no box',
);
await lockRow.click();
await page.waitForSelector('#pass', { timeout: 20_000 });

const startedReunlock = Date.now();
await page.fill('#pass', PASSPHRASE);
await page.click('.local button[type="submit"]');
await page.waitForSelector('.list .row', { timeout: 60_000 });
const unlockMs = Date.now() - startedReunlock;

await openEditor(page);

check('vault unlock stays under 1.5 s at 6x CPU throttle', unlockMs < 1500, `${unlockMs} ms`);
results.push({
  check: 'vault creation (two derivations)',
  verdict: 'info',
  detail: `${vaultCreateMs} ms`,
});

// --- typing latency on a large note --------------------------------------
// The tail Spike 1 found only appears in a long document, so grow it first.
// `insertText` through the input pipeline rather than execCommand with a huge
// string, which silently did nothing and left the measurement running against
// a two-line note.
await page.waitForTimeout(500);
await page.click('.cm-content');
// Sized to reproduce Spike 1's condition — roughly 6,700 lines and 200 KB —
// because the 23 ms tail it found only appeared at that scale. A shorter
// document would let the run "pass" without testing the thing in question.
const filler = '# Heading\n\nsome text here\n\n```sql\nSELECT 1;\n```\n\n'.repeat(840);
await page.keyboard.insertText(filler);
await page.waitForTimeout(2000);

// `.cm-content.textContent` only holds the rendered viewport, so document size
// is measured from the scroller's height instead.
const docHeight = await page.evaluate(
  () => document.querySelector('.cm-scroller')?.scrollHeight ?? 0,
);
check(
  "the latency test reproduces Spike 1's document size",
  docHeight > 100_000,
  `${docHeight}px tall, ~${Math.round(docHeight / 21)} lines`,
);

const typing = await page.evaluate(async () => {
  const content = document.querySelector('.cm-content');
  if (!content) return null;
  content.focus();

  const measure = async (samples) => {
    const out = [];
    for (let i = 0; i < samples; i++) {
      const t = performance.now();
      document.execCommand('insertText', false, 'x');
      content.offsetHeight;
      out.push(performance.now() - t);
      await new Promise(requestAnimationFrame);
    }
    out.sort((a, b) => a - b);
    const at = (p) => +out[Math.min(out.length - 1, Math.ceil((p / 100) * out.length) - 1)].toFixed(2);
    return { p50: at(50), p95: at(95), max: at(100) };
  };

  // The cursor is already at the end of the inserted filler, which is where
  // the tail showed up in Spike 1.
  return { end: await measure(80) };
});

if (typing) {
  check(
    'typing stays within a frame at 6x CPU throttle',
    typing.end.p95 < 16,
    `p50 ${typing.end.p50} ms, p95 ${typing.end.p95} ms, max ${typing.end.max} ms`,
  );
}

// --- layout holds at phone width -----------------------------------------
// The Markdown key bar. Typing `#`, `**` and `[](…)` on a phone keyboard costs
// two or three layout switches each, which is why the bar exists — so what is
// worth gating is that a press actually reaches the editor, not that it draws.
await page.locator('.cm-content').click();
await page.waitForSelector('.keybar', { timeout: 20_000 });
const keyBarBox = await page.locator('.keybar button').first().boundingBox();
check(
  'the key bar offers finger-sized targets',
  Boolean(keyBarBox && keyBarBox.width >= 44 && keyBarBox.height >= 44),
  keyBarBox ? `${Math.round(keyBarBox.width)}x${Math.round(keyBarBox.height)}` : 'no box',
);

// The tab bar gives way to it rather than stacking: two bars plus a keyboard
// leaves almost no note on screen.
check(
  'the tab bar steps aside while the keyboard is up',
  (await page.locator('.tab-bar').count()) === 0,
);

const beforeHeading = await page.evaluate(() => document.querySelector('.cm-line')?.textContent);
await page.locator('.keybar button[aria-label="Quote"]').click();
await page.waitForTimeout(150);
const afterHeading = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).some((l) => l.textContent?.startsWith('>')),
);
check('a key bar press reaches the document', afterHeading, `was "${beforeHeading}"`);

const layout = await page.evaluate(() => ({
  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
}));
check(
  'no horizontal overflow at phone width',
  !layout.horizontalOverflow,
  `${layout.scrollWidth} vs ${layout.innerWidth}`,
);

check('no page errors on a phone profile', errors.length === 0, errors.slice(0, 2).join(' | '));

await context.close();
await browser.close();
await server.close();

const report = {
  device: phone?.userAgent ?? 'unknown',
  cpuThrottle: CPU_THROTTLE,
  vaultCreateMs,
  unlockMs,
  typing,
  docHeight,
  caveat:
    'CDP throttling scales CPU scheduling only. Argon2id is memory-hard, so ' +
    'these unlock figures are NOT a substitute for a real device measurement.',
};
writeFileSync(resolve(here, 'results-mobile.json'), JSON.stringify(report, null, 2));

console.log('');
console.table(results);
console.log(`\nProfile: ${phone ? 'Pixel' : 'default'}, CPU throttled ${CPU_THROTTLE}x`);
console.log(
  '\nCaveat: CDP throttling models CPU scheduling, not memory bandwidth.\n' +
    'Argon2id is memory-hard, so the unlock figure above understates a real\n' +
    'phone. It bounds the CPU-bound part only; a real device still owes us a\n' +
    'measurement before the KDF parameters are considered settled.\n',
);

if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('All mobile-profile checks pass.\n');
