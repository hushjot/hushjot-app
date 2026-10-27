/**
 * The phone chunk.
 *
 * One barrel, reached by a single dynamic `import()` from `App.svelte`, for
 * three reasons:
 *
 * 1. **Rollup emits one chunk.** Desktop never downloads or parses any of it.
 * 2. **The service worker precaches it.** `tools/vite-plugin-sw.mjs` walks one
 *    level of `dynamicImports` from the entry, so a lazy phone shell is still
 *    offline-safe with no extra round trip after install.
 * 3. **It is the seam.** Nothing outside this directory may static-import from
 *    it, and nothing inside it may be imported by a component desktop mounts.
 *
 * What it does *not* buy is CSS. `bench/size.mjs` marks every `.css` asset
 * eager unconditionally, lazy component or not — so the styles below are
 * charged to the 160 KB critical-path budget wherever they live. The split is
 * about JavaScript. Do not write a comment here claiming otherwise.
 *
 * The house rule for everything in this directory: read from `src/ui/state/*`
 * and `src/core/*` freely, but take every *action* as a callback prop.
 * `App.svelte` stays the only place that knows how a command runs, which is
 * what keeps the keyboard dispatcher, `available()` and `run()` in one piece.
 */
export { default as TabBar } from './TabBar.svelte';
export { default as PhoneHeader } from './PhoneHeader.svelte';
export { default as KeyBar } from './KeyBar.svelte';
export { trackKeyboardInset } from './keyboardInset.ts';
export { PHONE_MORE_LIST, PHONE_MORE_NOTE, moreItems } from './moreItems.ts';
