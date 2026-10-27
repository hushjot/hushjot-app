import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Runes only — no legacy reactive statements anywhere in this codebase.
    runes: true,
  },
};
