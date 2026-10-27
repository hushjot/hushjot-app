/**
 * Editor font family, the Appearance menu's choice.
 *
 * Published as CSS custom properties rather than reconfigured into CodeMirror,
 * for the reason `textSize.svelte.ts` sets out at length: `Editor.svelte`
 * keeps one cached `EditorState` per note and a `Compartment.reconfigure`
 * reaches only the mounted one, so the font would change under the reader
 * every time they switched notes. Two variables on the root element apply to
 * every editor and every preview at once, mounted or cached, for no dispatch
 * and no re-render.
 *
 * A per-device preference, not data: localStorage, not the encrypted
 * repository, for the same reason the theme and the text size live there.
 */
import {
  DEFAULT_FONT,
  fontTokens,
  normalizeFontChoice,
  type FontChoice,
} from '../editorFont.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const STORAGE_KEY = 'teksto:editor-font';

function read(): FontChoice {
  try {
    return normalizeFontChoice(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode with storage blocked. The default is a perfectly good font;
    // the only loss is that the choice does not persist.
    return DEFAULT_FONT;
  }
}

/** Only a non-default choice is written, so the default can move later. */
function write(choice: FontChoice): void {
  try {
    if (choice === DEFAULT_FONT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // As above — the font still applies for this session.
  }
}

/**
 * Both shells declare the defaults so the first paint is right before any
 * JavaScript parses; this only ever overrides them.
 */
function apply(choice: FontChoice): void {
  const { editor, preview } = fontTokens(choice);
  const root = document.documentElement.style;
  root.setProperty('--editor-font', editor);
  root.setProperty('--preview-font', preview);
}

class EditorFontStore {
  #choice = $state<FontChoice>(read());

  constructor() {
    // At module init, not on mount: a saved font must be in place before the
    // first paint, or the editor flashes in mono and reflows under the reader.
    apply(this.#choice);
  }

  get choice(): FontChoice {
    return this.#choice;
  }

  set(choice: FontChoice): void {
    if (choice === this.#choice) return;
    this.#choice = choice;
    apply(choice);
    write(choice);
  }
}

export const editorFont = new EditorFontStore();
