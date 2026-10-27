import { defineConfig, loadEnv } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
// @ts-expect-error - plain JS build plugin, no types needed
import { serviceWorkerPlugin } from './tools/vite-plugin-sw.mjs';
// @ts-expect-error - plain JS build plugin, no types needed
import { cspPlugin } from './tools/vite-plugin-csp.mjs';
// @ts-expect-error - plain JS build plugin, no types needed
import { sriPlugin } from './tools/vite-plugin-sri.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [
    svelte(),
    // Emulator origins are allowed only outside a production build, so a
    // localhost exception never ships.
    // The billing API's origin comes from the same variable the adapter reads.
    cspPlugin({
      allowEmulators: mode !== 'production',
      apiUrl: loadEnv(mode, here, 'VITE_').VITE_HUSHJOT_API_URL || undefined,
    }),
    // Both of these throw at build time rather than no-op, because either one
    // failing quietly looks exactly like it working: a service worker whose
    // version stops tracking the shell, or an integrity attribute that is
    // simply absent. See each plugin's header for what it is and is not worth.
    sriPlugin(),
    serviceWorkerPlugin({
      extraAssets: [
        '/manifest.webmanifest',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/apple-touch-icon.png',
      ],
    }),
  ],
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // Phase 0 established a 160 KB gzipped critical-path budget; warn well
    // before we get near it in raw bytes.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      /**
       * Two documents, on purpose.
       *
       * `index.html` is the app. `s/index.html` is the share viewer, which a
       * recipient loads *instead of* the app: no vault, no IndexedDB, no
       * unlock form, no Firebase SDK (`src/viewer/main.ts` says why that
       * matters beyond bytes). Hosting serves `/s/` as a directory index, so
       * this needs no rewrite.
       *
       * Two build-time things have to know about the second entry, and each
       * fails quietly if it does not: `bench/size.mjs` budgets them
       * **separately**, because summing two documents different people
       * download would make the critical-path number mean nothing; and
       * `tools/vite-plugin-sw.mjs` precaches and versions both shells, because
       * the worker otherwise answers a navigation to `/s/` with the app.
       */
      input: {
        index: resolve(here, 'index.html'),
        share: resolve(here, 's/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
}));
