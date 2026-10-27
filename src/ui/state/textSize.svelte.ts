/**
 * Editor text size, the ⌘+/⌘−/⌘0 control.
 *
 * The size is published as a CSS custom property rather than reconfigured into
 * CodeMirror. `Editor.svelte` keeps one cached `EditorState` per note, and a
 * `Compartment.reconfigure` only ever reaches the state currently mounted — the
 * rest would keep the old size until they were rebuilt, so the text would
 * change size when you switched notes. A variable on the root element applies
 * to every editor at once, mounted or cached, for no dispatch and no re-render.
 *
 * It is a per-device preference, not data: localStorage, not the encrypted
 * repository, for the same reason the local-only notice lives there.
 */
import {
  DEFAULT_TEXT_SIZE,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  normalizeTextSize,
  stepTextSize,
  type TextSize,
} from '../textSize.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const STORAGE_KEY = 'teksto:editor-font-size';
const CSS_VARIABLE = '--editor-font-size';

function read(): TextSize {
  try {
    return normalizeTextSize(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode with storage blocked. The default is a perfectly good size;
    // the only loss is that it does not persist.
    return DEFAULT_TEXT_SIZE;
  }
}

function write(px: TextSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    // As above — the size still applies for this session.
  }
}

/**
 * `index.html` declares the default so the editor is the right size before any
 * JavaScript parses; this only ever overrides it, and only when the user has
 * chosen something else.
 */
function apply(px: TextSize): void {
  document.documentElement.style.setProperty(CSS_VARIABLE, `${px}px`);
}

class TextSizeStore {
  #px = $state<TextSize>(read());

  constructor() {
    // At module init, not on mount: a saved size must be in place before the
    // first paint, or the editor flashes at 14px and resizes under the reader.
    apply(this.#px);
  }

  get px(): TextSize {
    return this.#px;
  }

  get canIncrease(): boolean {
    return this.#px < MAX_TEXT_SIZE;
  }

  get canDecrease(): boolean {
    return this.#px > MIN_TEXT_SIZE;
  }

  get isDefault(): boolean {
    return this.#px === DEFAULT_TEXT_SIZE;
  }

  increase(): void {
    this.#set(stepTextSize(this.#px, 1));
  }

  decrease(): void {
    this.#set(stepTextSize(this.#px, -1));
  }

  reset(): void {
    this.#set(DEFAULT_TEXT_SIZE);
  }

  /**
   * Land on a rung directly, for the Appearance menu.
   *
   * The phone has no pill and no keyboard, so stepping there meant a menu row
   * that closed the sheet on every press and never said where you had landed.
   * Picking is one gesture and carries the number with it.
   */
  set(px: TextSize): void {
    this.#set(px);
  }

  #set(px: TextSize): void {
    if (px === this.#px) return;
    this.#px = px;
    apply(px);
    write(px);
  }
}

export const textSize = new TextSizeStore();
