/**
 * Build config for the real-device KDF page.
 *
 * Separate from `vite.config.mjs` (the Phase 0 spikes) and from the app's own
 * config, with its own output directory, for one reason: this page must never
 * become a Rollup input of the app build. If it did, it would ship to
 * production hosting and count against the 160 KB critical-path budget that
 * `bench/size.mjs` gates — a measurement harness earning a place in the
 * product by accident.
 *
 * **`root` is the page directory, not `bench/`.** Vite mirrors an entry's path
 * relative to `root` into the output, so rooting at `bench/` put the page at
 * `dist-kdf-device/device/index.html` while `device.mjs` printed the bare
 * origin — and the URL handed to the phone 404'd. Rooted here, the page is
 * `index.html` at the top of the output and the short origin is the right
 * link. That matters more than it sounds: the address is typed by hand, on a
 * phone keyboard, and a trailing path segment is exactly what gets dropped.
 *
 * `main.ts` reaches the production worker and the stats helpers through `../`
 * and `../../`, which resolve from the importing file rather than from `root`,
 * so they are unaffected by this.
 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, 'device'),
  build: {
    target: 'es2022',
    // Outside `root`, so `emptyOutDir` has to be explicit or Vite refuses.
    outDir: resolve(here, 'dist-kdf-device'),
    emptyOutDir: true,
  },
});
