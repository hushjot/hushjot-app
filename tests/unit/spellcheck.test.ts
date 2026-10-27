/**
 * The spellcheck attribute source, tested through the real extension set
 * rather than by reading the store — CodeMirror hard-codes
 * `spellcheck="false"` on `.cm-content`, so what matters is whether our source
 * survives its merge, and whether it is still *live* after a state is cached.
 *
 * `shortcuts.test.ts` reads the keymap facet the same way: build a state from
 * `editorExtensions` and ask it, instead of keeping a second list by hand.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions, type EditorSetupOptions } from '../../src/editor/setup.ts';

function stateWith(options: Partial<EditorSetupOptions> = {}): EditorState {
  return EditorState.create({
    doc: 'recieve',
    extensions: editorExtensions({ onChange: () => {}, ...options }),
  });
}

/**
 * What the view's own attribute pass computes. `attrsFromFacet` walks the
 * sources last to first and calls any that is a function, so this mirrors it.
 *
 * The stub is there because `crosshairCursor()` contributes a source too, and
 * it asks the view for its plugin. Stubbing rather than swallowing the call,
 * so a source that genuinely breaks still fails here.
 */
function contentAttrs(state: EditorState): Record<string, string> {
  const view = { plugin: () => null } as unknown as EditorView;
  const out: Record<string, string> = {};
  const sources = state.facet(EditorView.contentAttributes);
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]!;
    const value = typeof source === 'function' ? source(view) : source;
    if (value) Object.assign(out, value);
  }
  return out;
}

describe('spellcheck', () => {
  it('re-enables the browser spellchecker when the preference is on', () => {
    expect(contentAttrs(stateWith({ spellcheck: () => true })).spellcheck).toBe('true');
  });

  it('says so explicitly when the preference is off', () => {
    // Explicit rather than absent, so it still overrides CodeMirror's default
    // if another source is ever added above it.
    expect(contentAttrs(stateWith({ spellcheck: () => false })).spellcheck).toBe('false');
  });

  it('contributes nothing when no preference is passed', () => {
    expect(contentAttrs(stateWith()).spellcheck).toBeUndefined();
  });

  it('is read live, so one cached state per note cannot go stale', () => {
    // The whole reason this is a function source and not a value or a
    // Compartment: `Editor.svelte` keeps up to 24 states and a reconfigure
    // would only ever reach the mounted one.
    let enabled = true;
    const state = stateWith({ spellcheck: () => enabled });
    expect(contentAttrs(state).spellcheck).toBe('true');
    enabled = false;
    expect(contentAttrs(state).spellcheck).toBe('false');
  });
});
