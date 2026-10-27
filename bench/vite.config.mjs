import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  server: { port: 5178, strictPort: true },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: resolve(here, 'spikes/editor.html'),
        kdf: resolve(here, 'spikes/kdf.html'),
        coldstart: resolve(here, 'spikes/coldstart.html'),
        persist: resolve(here, 'spikes/persist.html'),
        diag: resolve(here, 'spikes/diag.html'),
      },
    },
  },
});
