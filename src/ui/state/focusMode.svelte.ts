/**
 * Focus mode, the ⌘J Y toggle.
 *
 * A thin store over `ui/focusMode.ts`, which holds the storage spelling and the
 * one rule with an argument behind it (why the status bar survives `Offline`
 * and `Not synced`). Read that file first.
 *
 * Deliberately **one** flag, and deliberately not a snapshot of the three
 * preferences it overrides. Focus mode never writes `sidebarHidden`, the tile
 * layout or a view mode: `App.svelte`'s `showListPane` reads this flag *beside*
 * `tiling.sidebarHidden`, so leaving focus mode restores whatever the sidebar
 * was before it without anything having to remember. Writing the other flags
 * and putting them back is the version of this that goes wrong — two sources
 * for one piece of screen, disagreeing the first time someone hides the sidebar
 * while the mode is on.
 *
 * A per-device preference, not data, as with the theme and the text size.
 */
import { readFocusMode, writeFocusMode } from '../focusMode.ts';

class FocusModeStore {
  #on = $state(readFocusMode());

  get on(): boolean {
    return this.#on;
  }

  set(on: boolean): void {
    if (on === this.#on) return;
    this.#on = on;
    writeFocusMode(on);
  }

  toggle(): void {
    this.set(!this.#on);
  }
}

export const focusMode = new FocusModeStore();
