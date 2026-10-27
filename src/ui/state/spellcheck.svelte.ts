/**
 * The browser's spellchecker in the editor, the ⌘J V toggle.
 *
 * Not a matter of leaving the element alone: CodeMirror writes
 * `spellcheck="false"` onto `.cm-content` itself, so something has to override
 * it. The override is an `EditorView.contentAttributes` source in
 * `editor/setup.ts`, and it is a *function* rather than a value because
 * `Editor.svelte` caches one `EditorState` per note — the same trap
 * `textSize.svelte.ts` documents, where a `Compartment.reconfigure` reaches
 * only the state currently mounted and the others revert when you switch
 * notes. CodeMirror re-evaluates a function source on every view update and on
 * `setState`, so one static extension serves every cached state at once.
 *
 * On unless turned off, which is why only "off" is ever written: this is a
 * notepad for prose before it is one for code, and the reader who wants a
 * clean margin under a fence turns it off once, per device. Every competitor
 * spellchecks by default (`private/viability-assessment.md` § 5).
 *
 * Only `spellcheck`. CodeMirror also disables `autocorrect`, `autocapitalize`
 * and `writingsuggestions`, and those stay off: they rewrite the text as it is
 * typed, which fights Markdown punctuation and fence contents, and the iOS
 * keyboard that does the most of it is the one surface no bench here covers.
 *
 * A per-device preference, not data: localStorage, not the encrypted
 * repository, for the same reason the theme and the text size live there.
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const STORAGE_KEY = 'teksto:spellcheck';

/** Absent means on, so a device that has never chosen gets the default. */
function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    // Private mode with storage blocked. Spellcheck still works this session;
    // the only loss is that the choice does not persist.
    return true;
  }
}

function write(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, '0');
  } catch {
    // As above.
  }
}

class SpellcheckStore {
  #enabled = $state(read());

  get enabled(): boolean {
    return this.#enabled;
  }

  toggle(): void {
    this.#enabled = !this.#enabled;
    write(this.#enabled);
  }
}

export const spellcheck = new SpellcheckStore();
