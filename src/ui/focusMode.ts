/**
 * Focus mode: the chrome goes away and the note fills the window.
 *
 * §20 ends with "Keep visual chrome minimal. The text is the product", and this
 * is that sentence with a switch on it. Nothing here is new machinery — the
 * sidebar already hides (`state/tiling.svelte.ts`), a tile already shows the
 * editor alone (`viewMode.ts`), the Tags section already collapses. What focus
 * mode adds is doing all of it at once, from one key, and undoing it.
 *
 * Pure, and kept apart from the store for the reason `tiling.ts` and
 * `viewMode.ts` are: the one rule worth arguing about is testable without a
 * rune harness or localStorage.
 *
 * ## The rule: the status bar is not chrome when it is bad news
 *
 * Hiding the status bar is most of the point, and on desktop it is also the
 * *only* place the app says `Offline` or `Not synced`. There is no banner for a
 * failing sync — `StorageWarning.kind` covers eviction, a blocked database, a
 * full quota and a failed write, none of which is "your text is not reaching
 * the backend" — and the topbar's `SyncIndicator` is hidden by this mode too.
 * So a mode that hid the bar unconditionally would take the app's stated
 * position ("local storage is a cache, sync is the durability guarantee") and
 * quietly stop honouring it.
 *
 * `saving` and `syncing` are hidden, because they are what typing looks like
 * and a bar that appeared on every keystroke would be worse than no bar.
 *
 * A per-device preference, not data: localStorage, for the same reason the
 * theme and the text size live there. It is nobody's data, so it can never be
 * the thing a sync conflict is about.
 */
import type { SaveState } from './state/workspace.svelte.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
export const FOCUS_MODE_KEY = 'teksto:focus-mode';

/**
 * The save states focus mode refuses to hide, because nothing else on a
 * chrome-free screen says them. Both mean the text is only on this device.
 */
export const LOUD_SAVE_STATES: readonly SaveState[] = ['offline', 'sync-failed'];

/** Whether the status bar shows, given the mode and what it would say. */
export function showStatusBar(focus: boolean, state: SaveState): boolean {
  return !focus || LOUD_SAVE_STATES.includes(state);
}

/** Absent means off, so a device that has never chosen gets the default. */
export function readFocusMode(): boolean {
  try {
    return localStorage.getItem(FOCUS_MODE_KEY) === '1';
  } catch {
    // Private mode with storage blocked. The mode still works this session;
    // the only loss is that it does not persist.
    return false;
  }
}

/** Only "on" is written, so a device that has never chosen holds no key. */
export function writeFocusMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(FOCUS_MODE_KEY, '1');
    else localStorage.removeItem(FOCUS_MODE_KEY);
  } catch {
    // As above.
  }
}
