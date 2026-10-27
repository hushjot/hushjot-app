/**
 * Phase 0 benchmark runner.
 *
 * Builds the spike pages for production, serves them, drives them with a real
 * Chromium via Playwright, and writes bench/results.json.
 *
 * Usage:
 *   node bench/run.mjs                # all spikes
 *   node bench/run.mjs editor kdf     # a subset
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(here, 'vite.config.mjs');

/** Each spike: which page, and whether to also run it CPU-throttled. */
const SPIKES = {
  editor: { page: 'spikes/editor.html', throttleRates: [1, 4], timeout: 180_000 },
  kdf: { page: 'spikes/kdf.html', throttleRates: [1, 4], timeout: 180_000 },
  coldstart: { page: 'spikes/coldstart.html', throttleRates: [1], timeout: 600_000 },
  persist: { page: 'spikes/persist.html', throttleRates: [1], timeout: 300_000 },
  diag: { page: 'spikes/diag.html', throttleRates: [1], timeout: 120_000 },
};

const requested = process.argv.slice(2);
const selected = requested.length
  ? requested.filter((n) => n in SPIKES)
  : Object.keys(SPIKES);

if (requested.length && selected.length !== requested.length) {
  const unknown = requested.filter((n) => !(n in SPIKES));
  console.error(`Unknown spike(s): ${unknown.join(', ')}`);
  console.error(`Available: ${Object.keys(SPIKES).join(', ')}`);
  process.exit(1);
}

console.log(`Building spike pages…`);
await build({ configFile, logLevel: 'warn' });

const server = await preview({ configFile, preview: { port: 5179, strictPort: true } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
console.log(`Serving at ${base}`);

const browser = await chromium.launch();
const results = {};
let failed = false;

for (const name of selected) {
  const spec = SPIKES[name];
  results[name] = {};

  for (const rate of spec.throttleRates) {
    const label = rate === 1 ? 'native' : `cpu_${rate}x`;
    process.stdout.write(`  ${name} (${label})… `);

    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    try {
      if (rate !== 1) {
        const client = await context.newCDPSession(page);
        await client.send('Emulation.setCPUThrottlingRate', { rate });
      }

      await page.goto(`${base}/${spec.page}`, { waitUntil: 'load' });
      await page.waitForFunction('typeof window.__spike === "function"', null, {
        timeout: 30_000,
      });

      const started = Date.now();
      const result = await page.evaluate(() => window.__spike(), null, {
        timeout: spec.timeout,
      });
      results[name][label] = result;
      console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed = true;
      results[name][label] = { error: String(err) };
      console.log(`FAILED`);
      console.error(`    ${err}`);
    }

    if (consoleErrors.length) {
      results[name][label] = { ...results[name][label], consoleErrors };
      console.error(`    console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    await context.close();
  }
}

await browser.close();
await server.close();

mkdirSync(here, { recursive: true });
const outPath = resolve(here, 'results.json');
writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), platform: process.platform, node: process.version, results },
    null,
    2,
  ),
);

console.log(`\nWrote ${outPath}`);
console.log(JSON.stringify(results, null, 2));

process.exit(failed ? 1 : 0);
