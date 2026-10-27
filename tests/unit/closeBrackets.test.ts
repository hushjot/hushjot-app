/**
 * Bracket auto-close, over the real extension and the real language.
 *
 * `closeBrackets` takes no options: it reads its bracket set out of the
 * language data at the cursor, which is why the set lives in `markdownLean.ts`
 * and why this test builds a state from the actual language rather than
 * asserting against a constant. An assertion on the constant would pass
 * happily on the day the language stopped being consulted.
 *
 * `insertBracket` is the whole of what the extension's input handler does, so
 * the behaviour is reachable with no DOM and no view — the same trade
 * `formatKeys.test.ts` makes. Documents use `|` for the cursor and `«…»` for a
 * selection, as that file does, because brackets are the subject here.
 */
import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { closeBrackets, insertBracket } from '@codemirror/autocomplete';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { codeLanguages, findInCatalogue } from '../../src/editor/languages.ts';

function parse(source: string): EditorState {
  const ranges = [];
  let doc = '';
  let anchor = -1;
  for (const ch of source) {
    if (ch === '|') ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === '«') anchor = doc.length;
    else if (ch === '»') {
      ranges.push(EditorSelection.range(anchor, doc.length));
      anchor = -1;
    } else doc += ch;
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    // Both, and in the editor's order: the language declares the bracket set
    // and `closeBrackets()` installs the StateField that the skip-over reads.
    extensions: [markdownLean({ codeLanguages, resolveUnknown: findInCatalogue }), closeBrackets()],
  });
}

function render(state: EditorState): string {
  const doc = state.doc.toString();
  const range = state.selection.main;
  if (range.empty) return `${doc.slice(0, range.head)}|${doc.slice(range.head)}`;
  return `${doc.slice(0, range.from)}«${doc.slice(range.from, range.to)}»${doc.slice(range.to)}`;
}

/** What typing `bracket` produces, or `'null'` when it is an ordinary insert. */
function type(source: string, bracket: string): string {
  const state = parse(source);
  const tr = insertBracket(state, bracket);
  return tr === null ? 'null' : render(tr.state);
}

describe('bracket auto-close in prose', () => {
  it('closes a bracket at the end of a line', () => {
    expect(type('say |', '(')).toBe('say (|)');
    expect(type('say |', '[')).toBe('say [|]');
    expect(type('say |', '{')).toBe('say {|}');
  });

  it('closes a double quote at the end of a line', () => {
    expect(type('he said |', '"')).toBe('he said "|"');
  });

  it('skips over a closing bracket it wrote itself', () => {
    // The skip lives in `bracketState`, which only knows about a bracket this
    // extension closed — so it has to be reached through the real insert.
    const opened = insertBracket(parse('say |'), '(');
    expect(opened).not.toBeNull();
    const closed = insertBracket(opened!.state, ')');
    expect(closed).not.toBeNull();
    expect(render(closed!.state)).toBe('say ()|');
  });

  it('wraps a selection rather than replacing it', () => {
    expect(type('a «bcd» e', '(')).toBe('a («bcd») e');
    expect(type('a «bcd» e', '"')).toBe('a "«bcd»" e');
  });
});

describe('the apostrophe, which is why the set is hand-written', () => {
  it('never auto-closes, so an apostrophe stays one character', () => {
    // The cases the default set breaks: a contraction is safe either way
    // because a word character precedes it, but these are not.
    expect(type('it |', "'")).toBe('null');
    expect(type('the |', "'")).toBe('null');
    expect(type('|', "'")).toBe('null');
  });

  it('leaves a contraction alone', () => {
    expect(type('don|', "'")).toBe('null');
  });

  it('is left to `wrapSelectionInput` over a selection', () => {
    // `formatKeys.ts` owns this one, and only when text is selected.
    expect(type('a «bcd» e', "'")).toBe('null');
  });
});

describe('a bracket that is not opening anything', () => {
  it('types normally before a word', () => {
    // `closeBefore` is ")]}:;>" plus whitespace and end of line, so a bracket
    // typed against a word is a plain insert.
    expect(type('|word', '(')).toBe('null');
  });

  it('types normally after a word, for a quote', () => {
    expect(type('dont|', '"')).toBe('null');
  });
});
