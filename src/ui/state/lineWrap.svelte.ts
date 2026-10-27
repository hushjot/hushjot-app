/**
 * Editor line wrapping: fit the window, wrap at a fixed column, or not at all.
 *
 * Published as a root attribute and a custom property, never as a CodeMirror
 * Compartment, for the reason `textSize.svelte.ts` gives: a reconfigure only
 * reaches the mounted state, and every cached note would keep the old wrapping
 * until it was rebuilt. CodeMirror reads the computed `white-space` of its
 * content on every measure, so a CSS override is picked up without the
 * `lineWrapping` extension ever changing — the editor only has to be asked to
 * measure (`Editor.svelte`).
 *
 * A per-device preference, so localStorage: the right measure on a phone is
 * not the right one on a desktop.
 */
import {
  DEFAULT_LINE_WRAP,
  lineWrapLabel,
  lineWrapShortLabel,
  normalizeFixedLineWrap,
  normalizeLineWrap,
  toggleLineWrap,
  type FixedLineWrap,
  type LineWrap,
} from '../lineWrap.ts';

// The pre-rename prefix, so every key this app persists shares one: see
// docs/security.md § "Frozen identifiers".
const STORAGE_KEY = 'teksto:line-wrap';
const FIXED_STORAGE_KEY = 'teksto:line-wrap-fixed';
const COLUMNS_VARIABLE = '--editor-wrap-cols';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: the default applies and simply does not persist.
    return null;
  }
}

function write(key: string, value: LineWrap): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // As above — the mode still applies for this session.
  }
}

/** The CSS in `index.html` keys off `data-wrap`; the window needs nothing. */
function apply(mode: LineWrap): void {
  const root = document.documentElement;
  if (typeof mode === 'number') {
    root.dataset.wrap = 'cols';
    root.style.setProperty(COLUMNS_VARIABLE, String(mode));
  } else {
    root.dataset.wrap = mode;
    root.style.removeProperty(COLUMNS_VARIABLE);
  }
}

class LineWrapStore {
  #mode = $state<LineWrap>(normalizeLineWrap(read(STORAGE_KEY)));
  #lastFixed = $state<FixedLineWrap>(normalizeFixedLineWrap(read(FIXED_STORAGE_KEY)));

  constructor() {
    // At module init, so a saved measure is in place before the first paint.
    apply(this.#mode);
  }

  get mode(): LineWrap {
    return this.#mode;
  }

  get isDefault(): boolean {
    return this.#mode === DEFAULT_LINE_WRAP;
  }

  get label(): string {
    return lineWrapLabel(this.#mode);
  }

  get shortLabel(): string {
    return lineWrapShortLabel(this.#mode);
  }

  /** Window ↔ the last fixed mode chosen. */
  toggle(): void {
    this.set(toggleLineWrap(this.#mode, this.#lastFixed));
  }

  set(mode: LineWrap): void {
    if (mode !== 'window' && mode !== this.#lastFixed) {
      this.#lastFixed = mode;
      write(FIXED_STORAGE_KEY, mode);
    }
    if (mode === this.#mode) return;
    this.#mode = mode;
    apply(mode);
    write(STORAGE_KEY, mode);
  }
}

export const lineWrap = new LineWrapStore();
