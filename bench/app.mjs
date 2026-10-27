/**
 * Runtime regression gate for the real application.
 *
 * Phase 0 measured the pieces in isolation. This measures the assembled app:
 * cold and warm startup, time to an interactive editor, and typing latency in
 * the actual UI rather than a bare CodeMirror instance.
 *
 * Budgets derive from Phase 0 (bench/RESULTS.md) plus the spec's §7 targets.
 */
import { chromium } from 'playwright';
import { enterApp } from './lib/app.mjs';
import { build, preview } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const BUDGETS = {
  coldFirstPaintMs: 1000,
  // A cold run now includes creating a vault, which is one deliberate
  // Argon2id derivation (~95 ms measured, and intentionally not cheaper).
  coldEditorInteractiveMs: 3000,
  warmEditorInteractiveMs: 1500,
  keystrokeP95Ms: 16,
  noteSwitchP95Ms: 100,
};

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir: resolve(here, 'dist-app-run') } });

const server = await preview({
  root: repoRoot,
  build: { outDir: resolve(here, 'dist-app-run') },
  preview: { port: 5180, strictPort: true },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = {};
/** Focus-mode assertions, collected inside the warm run and judged below. */
const focusFailures = [];

/** Load the app and report startup timings. */
async function startup(context, label) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Since Phase 3 the app opens on a vault screen; `enterApp` creates or
  // unlocks as needed, then waits for the editor to be live.
  await enterApp(page, base);

  const timings = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      firstPaintMs: fp ? Math.round(fp.startTime) : null,
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadMs: Math.round(nav.loadEventEnd),
      transferredKB: Math.round(
        performance
          .getEntriesByType('resource')
          .reduce((a, r) => a + (r.transferSize || 0), 0) / 1024,
      ),
      requests: performance.getEntriesByType('resource').length,
    };
  });

  const editorInteractiveMs = await page.evaluate(() => {
    const entries = performance.getEntriesByType('paint');
    void entries;
    return Math.round(performance.now());
  });

  return { page, errors, timings: { ...timings, editorInteractiveMs }, label };
}

// --- cold start (empty cache) ---------------------------------------------
{
  const context = await browser.newContext();
  const { page, errors, timings } = await startup(context, 'cold');
  results.cold = timings;
  results.coldErrors = errors;
  await page.close();
  await context.close();
}

// --- warm start (service-worker-less warm HTTP cache) ----------------------
const context = await browser.newContext();
{
  const first = await startup(context, 'prime');
  await first.page.close();
  const { page, errors, timings } = await startup(context, 'warm');
  results.warm = timings;
  results.warmErrors = errors;

  // --- typing latency in the real app -------------------------------------
  const typing = await page.evaluate(async () => {
    const content = document.querySelector('.cm-content');
    if (!content) return { error: 'no editor' };
    content.focus();

    const lengthBefore = content.textContent.length;
    const samples = [];
    // Drive the editor the way a user does, through the DOM, so the
    // measurement includes Svelte's reaction to the store update.
    for (let i = 0; i < 120; i++) {
      const ch = 'the quick brown fox '[i % 20];
      const t = performance.now();
      document.execCommand('insertText', false, ch);
      content.offsetHeight; // force layout so deferred work is included
      samples.push(performance.now() - t);
      await new Promise(requestAnimationFrame);
    }
    const inserted = content.textContent.length - lengthBefore;

    samples.sort((a, b) => a - b);
    const at = (p) => +samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)].toFixed(3);
    return {
      n: samples.length,
      // Guards against the benchmark silently measuring a no-op if the way we
      // synthesise input ever stops reaching CodeMirror.
      inserted,
      p50: at(50),
      p95: at(95),
      p99: at(99),
      max: at(100),
    };
  });
  results.keystroke = typing;

  // --- switching between notes --------------------------------------------
  const switching = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('.list button.row')];
    if (rows.length < 2) return { skipped: 'need at least two notes' };

    const samples = [];
    for (let i = 0; i < 20; i++) {
      const row = rows[i % rows.length];
      const t = performance.now();
      row.click();
      await new Promise(requestAnimationFrame);
      document.querySelector('.cm-content')?.offsetHeight;
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const at = (p) => +samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)].toFixed(3);
    return { n: samples.length, p50: at(50), p95: at(95), max: at(100) };
  });
  results.noteSwitch = switching;

  // --- focus mode ----------------------------------------------------------
  // Not a latency measurement: a correctness gate for a mode whose whole job is
  // to remove things from the screen, where every failure looks like "nothing
  // happened". It asserts the chrome is there *first*, so it cannot pass by
  // looking at an app that never rendered — the same guard `bench/phase3.mjs`
  // puts on the ciphertext audit.
  const leader = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'Meta' : 'Control',
  );
  const chrome = () =>
    page.evaluate(() => ({
      topbar: !!document.querySelector('header.topbar'),
      status: !!document.querySelector('footer.status'),
      sidebar: !!document.querySelector('.list-pane'),
      exit: !!document.querySelector('.tile-tools .focus-exit'),
      editorH: Math.round(document.querySelector('.cm-editor')?.getBoundingClientRect().height ?? 0),
    }));

  const before = await chrome();
  await page.keyboard.press(`${leader}+j`);
  await page.keyboard.press('y');
  await page.waitForTimeout(50);
  const during = await chrome();
  // Leave by the floating control rather than the chord, so the one route a
  // mouse has out of a chrome-free screen is the one that is gated.
  if (during.exit) await page.click('.tile-tools .focus-exit');
  await page.waitForTimeout(50);
  const after = await chrome();
  results.focusMode = { before, during, after };

  if (!before.topbar || !before.status || !before.sidebar) {
    focusFailures.push(
      `focus mode: the app did not render its chrome before the test began (${JSON.stringify(before)}), ` +
        `so hiding it proves nothing`,
    );
  } else {
    if (during.topbar) focusFailures.push('focus mode: the topbar is still rendered');
    if (during.status) focusFailures.push('focus mode: the status bar is still rendered while saved');
    if (during.sidebar) focusFailures.push('focus mode: the sidebar is still rendered');
    if (!during.exit) focusFailures.push('focus mode: no way out — the floating exit control is absent');
    if (during.editorH <= before.editorH) {
      focusFailures.push(
        `focus mode: the editor did not grow (${before.editorH}px to ${during.editorH}px), ` +
          `so the space the chrome gave up went nowhere`,
      );
    }
    if (!after.topbar || !after.status || !after.sidebar) {
      focusFailures.push(
        `focus mode: leaving it did not restore the chrome (${JSON.stringify(after)})`,
      );
    }
  }

  await page.close();
}
await context.close();
await browser.close();
await server.close();

// --- verdict ---------------------------------------------------------------
const checks = [
  ['cold first paint', results.cold.firstPaintMs, BUDGETS.coldFirstPaintMs],
  ['cold editor interactive', results.cold.editorInteractiveMs, BUDGETS.coldEditorInteractiveMs],
  ['warm editor interactive', results.warm.editorInteractiveMs, BUDGETS.warmEditorInteractiveMs],
  ['keystroke p95', results.keystroke.p95, BUDGETS.keystrokeP95Ms],
  ['note switch p95', results.noteSwitch.p95, BUDGETS.noteSwitchP95Ms],
];

const failures = checks.filter(([, actual, budget]) => actual != null && actual > budget);
const allErrors = [...(results.coldErrors ?? []), ...(results.warmErrors ?? []), ...focusFailures];

// A latency benchmark that types nothing would happily report 0 ms forever.
if ((results.keystroke.inserted ?? 0) < 100) {
  allErrors.push(
    `typing benchmark inserted only ${results.keystroke.inserted} chars of an expected 120 — ` +
      `synthetic input is not reaching the editor, so the latency figure is meaningless`,
  );
}

writeFileSync(
  resolve(here, 'results-app.json'),
  JSON.stringify({ budgets: BUDGETS, results, failures: failures.map((f) => f[0]) }, null, 2),
);

console.log('');
console.table(
  checks.map(([name, actual, budget]) => ({
    check: name,
    actual: actual ?? 'n/a',
    budget,
    verdict: actual == null ? 'n/a' : actual > budget ? 'FAIL' : 'pass',
  })),
);
console.log(`\nTransferred on cold load: ${results.cold.transferredKB} KB over ${results.cold.requests} requests`);

if (allErrors.length) {
  console.error(`\nConsole/page errors (${allErrors.length}):`);
  for (const e of allErrors.slice(0, 10)) console.error('  ' + e);
}

if (failures.length || allErrors.length) {
  console.error(`\nFAILED: ${failures.map((f) => f[0]).join(', ') || 'page errors'}\n`);
  process.exit(1);
}
console.log('\nAll runtime budgets pass.\n');
