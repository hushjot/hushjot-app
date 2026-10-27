/**
 * Formatting shortcuts are text transformations over EditorState, tested
 * without a DOM. Documents are written with `|` for a cursor and `«…»` for a
 * selection — not brackets, which are Markdown here — and results are rendered
 * the same way.
 */
import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import {
  insertLinkSpec,
  isUrl,
  linkPasteSpec,
  setHeadingSpec,
  toggleInlineSpec,
  toggleListSpec,
  toggleQuoteSpec,
  toggleTaskAtSpec,
  toggleTaskSpec,
  wrapSelectionSpec,
} from '../../src/editor/formatKeys.ts';

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
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

function render(state: EditorState): string {
  let text = state.doc.toString();
  const ranges = [...state.selection.ranges].sort((a, b) => b.from - a.from);
  for (const r of ranges) {
    text = r.empty
      ? `${text.slice(0, r.from)}|${text.slice(r.from)}`
      : `${text.slice(0, r.from)}«${text.slice(r.from, r.to)}»${text.slice(r.to)}`;
  }
  return text;
}

function run(source: string, build: (state: EditorState) => TransactionSpec | null): string {
  const state = parse(source);
  const spec = build(state);
  if (!spec) return 'null';
  return render(state.update(spec).state);
}

const BOLD = [{ char: '*', size: 2 }, { char: '_', size: 2 }];
const ITALIC = [{ char: '*', size: 1 }, { char: '_', size: 1 }];
const bold = (s: string): string => run(s, (st) => toggleInlineSpec(st, BOLD));
const italic = (s: string): string => run(s, (st) => toggleInlineSpec(st, ITALIC));

describe('toggleInlineSpec', () => {
  it('wraps a selection and keeps the text selected', () => {
    expect(bold('a «word» b')).toBe('a **«word»** b');
  });

  it('unwraps when the markers are just outside the selection', () => {
    expect(bold('a **«word»** b')).toBe('a «word» b');
  });

  it('unwraps when the markers are selected too', () => {
    expect(bold('a «**word**» b')).toBe('a «word» b');
  });

  it('formats the word the cursor is inside', () => {
    expect(bold('a wo|rd b')).toBe('a **wo|rd** b');
    expect(bold('a **wo|rd** b')).toBe('a wo|rd b');
  });

  it('opens an empty pair at the edge of a word, and a second press removes it', () => {
    expect(bold('word|')).toBe('word**|**');
    expect(bold('word**|**')).toBe('word|');
  });

  it('does not treat bold as italic markers', () => {
    expect(italic('**«word»**')).toBe('***«word»***');
    expect(italic('***«word»***')).toBe('**«word»**');
    expect(bold('***«word»***')).toBe('*«word»*');
  });

  it('recognises underscore emphasis when removing it', () => {
    expect(italic('_«word»_')).toBe('«word»');
  });

  it('handles every cursor', () => {
    expect(bold('«a» «b»')).toBe('**«a»** **«b»**');
  });
});

describe('insertLinkSpec', () => {
  it('puts the selection in the text and the cursor in the url', () => {
    expect(run('see «docs» here', insertLinkSpec)).toBe('see [docs](|) here');
  });

  it('puts a selected url in the url and the cursor in the text', () => {
    expect(run('«https://a.b/c»', insertLinkSpec)).toBe('[|](https://a.b/c)');
  });

  it('inserts an empty link at a cursor', () => {
    expect(run('x |', insertLinkSpec)).toBe('x [|]()');
  });
});

describe('isUrl', () => {
  it('accepts a single web or mail address only', () => {
    expect(isUrl('https://example.com/a?b=1')).toBe(true);
    expect(isUrl(' mailto:a@b.c\n')).toBe(true);
    expect(isUrl('example.com')).toBe(false);
    expect(isUrl('https://a.b and more')).toBe(false);
  });
});

describe('setHeadingSpec', () => {
  const h = (level: number) => (s: EditorState) => setHeadingSpec(s, level);

  it('adds a heading and keeps the cursor after the marker', () => {
    expect(run('|Title', h(2))).toBe('## |Title');
  });

  it('changes the level', () => {
    expect(run('# Ti|tle', h(3))).toBe('### Ti|tle');
  });

  it('removes the heading when the level already matches', () => {
    expect(run('## Ti|tle', h(2))).toBe('Ti|tle');
  });

  it('works on an empty line', () => {
    expect(run('|', h(1))).toBe('# |');
  });
});

describe('toggleListSpec', () => {
  it('bullets every selected line, skipping blank ones', () => {
    expect(run('«one\n\ntwo»', (s) => toggleListSpec(s, 'bullet'))).toBe('- «one\n\n- two»');
  });

  it('numbers lines in order', () => {
    expect(run('«a\nb\nc»', (s) => toggleListSpec(s, 'ordered'))).toBe('1. «a\n2. b\n3. c»');
  });

  it('removes markers when every line already has them', () => {
    expect(run('«- a\n- b»', (s) => toggleListSpec(s, 'bullet'))).toBe('«a\nb»');
  });

  it('converts between kinds and keeps indentation and the bullet', () => {
    expect(run('  * it|em', (s) => toggleListSpec(s, 'task'))).toBe('  * [ ] it|em');
    expect(run('- [x] do|ne', (s) => toggleListSpec(s, 'ordered'))).toBe('1. do|ne');
  });

  it('does not claim the line a selection ends at the start of', () => {
    expect(run('«a\n»b', (s) => toggleListSpec(s, 'bullet'))).toBe('- «a\n»b');
  });
});

describe('toggleQuoteSpec', () => {
  it('quotes lines and joins blank ones into the same quote', () => {
    expect(run('«a\n\nb»', toggleQuoteSpec)).toBe('> «a\n>\n> b»');
  });

  it('unquotes', () => {
    expect(run('> a|', toggleQuoteSpec)).toBe('a|');
  });
});

describe('toggleTaskSpec', () => {
  it('ticks and unticks', () => {
    expect(run('- [ ] a|', toggleTaskSpec)).toBe('- [x] a|');
    expect(run('1. [X] a|', toggleTaskSpec)).toBe('1. [ ] a|');
  });

  it('returns null off a task so Mod-Enter falls through', () => {
    expect(run('- plain|', toggleTaskSpec)).toBe('null');
  });
});

describe('toggleTaskAtSpec', () => {
  it('ticks and unticks the marker at the given offset', () => {
    expect(run('- [ ] a\n- [ ] b|', (s) => toggleTaskAtSpec(s, 10))).toBe('- [ ] a\n- [x] b|');
    expect(run('1. [X] a|', (s) => toggleTaskAtSpec(s, 3))).toBe('1. [ ] a|');
  });

  it('refuses an offset that is not a marker, so a stale preview ticks nothing', () => {
    // One short of the marker, one past it, and a line that lost its task.
    expect(run('- [ ] a|', (s) => toggleTaskAtSpec(s, 1))).toBe('null');
    expect(run('- [ ] a|', (s) => toggleTaskAtSpec(s, 3))).toBe('null');
    expect(run('- a|', (s) => toggleTaskAtSpec(s, 2))).toBe('null');
  });

  it('refuses brackets in prose that merely look like a marker', () => {
    expect(run('see [ ] there|', (s) => toggleTaskAtSpec(s, 4))).toBe('null');
  });

  it('refuses an offset outside the document', () => {
    expect(run('- [ ] a|', (s) => toggleTaskAtSpec(s, -1))).toBe('null');
    expect(run('- [ ] a|', (s) => toggleTaskAtSpec(s, 99))).toBe('null');
  });
});

describe('wrapSelectionSpec', () => {
  it('wraps and keeps the selection, so a second press doubles the marker', () => {
    const once = parse('a «b» c');
    const twice = once.update(wrapSelectionSpec(once, '*')).state;
    expect(render(twice)).toBe('a *«b»* c');
    expect(render(twice.update(wrapSelectionSpec(twice, '*')).state)).toBe('a **«b»** c');
  });
});

describe('linkPasteSpec', () => {
  it('links selected text to a pasted url', () => {
    expect(run('see «docs»', (s) => linkPasteSpec(s, 'https://x.y'))).toBe('see [docs](https://x.y)|');
  });

  it('leaves ordinary pastes alone', () => {
    expect(run('«docs»', (s) => linkPasteSpec(s, 'not a url'))).toBe('null');
    expect(run('|', (s) => linkPasteSpec(s, 'https://x.y'))).toBe('null');
    expect(run('«https://a.b»', (s) => linkPasteSpec(s, 'https://x.y'))).toBe('null');
  });
});
