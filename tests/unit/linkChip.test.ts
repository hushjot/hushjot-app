import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { chipAt, chipOffer, chipShown, linkChip } from '../../src/editor/linkChip.ts';
import { safeHref } from '../../src/editor/preview/model.ts';

/** A real state, because `chipAt` reads the syntax tree. */
const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdownLean()] });

/** `^` marks the caret (not `|`, which an aliased link uses); it is removed. */
function at(marked: string, exists?: (target: string) => boolean) {
  const pos = marked.indexOf('^');
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  return chipAt(stateOf(doc), pos, safeHref, exists);
}

describe('chipAt', () => {
  it('offers to open a note link that resolves', () => {
    expect(at('see [[Des^ign]] now')).toEqual({ kind: 'note', target: 'Design', exists: true, from: 4 });
  });

  it('offers to create one that does not', () => {
    const chip = at('see [[Nowh^ere]]', (t) => t === 'Design');
    expect(chip).toMatchObject({ kind: 'note', target: 'Nowhere', exists: false });
  });

  it('follows the target of an aliased link, not its label', () => {
    expect(at('[[Design|the la^bel]]')).toMatchObject({ kind: 'note', target: 'Design' });
  });

  it('opens a Markdown link, from its text or its address', () => {
    expect(at('a [te^xt](https://ok.test/x) b')).toEqual({ kind: 'url', href: 'https://ok.test/x', from: 2 });
    expect(at('a [text](https://ok.te^st/x) b')).toMatchObject({ kind: 'url', href: 'https://ok.test/x' });
  });

  it('opens an autolink and a bare URL', () => {
    expect(at('<https://ok.te^st>')).toMatchObject({ kind: 'url', href: 'https://ok.test' });
    expect(at('go to https://ok.te^st/a now')).toMatchObject({ kind: 'url', href: 'https://ok.test/a' });
  });

  it('refuses what the preview refuses, and in-note fragments', () => {
    expect(at('[x](javascript:al^ert(1))')).toBeNull();
    expect(at('[t^ext](javascript:alert(1))')).toBeNull();
    expect(at('[t^o heading](#heading)')).toBeNull();
    expect(at('[t^ext](relative/path)')).toBeNull();
  });

  it('offers no URL until the allowlist has loaded', () => {
    expect(chipAt(stateOf('[text](https://ok.test)'), 2, null)).toBeNull();
  });

  it('is nothing in prose or code', () => {
    expect(at('plain wo^rds')).toBeNull();
    expect(at('`[[No^te]]`')).toBeNull();
    expect(at('```c\nint a = b[[i^]];\n```')).toBeNull();
  });
});

describe('the chip field', () => {
  const doc = 'see [[Design]] and more';
  const stateAt = (anchor: number) =>
    EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownLean(), linkChip({ onOpenLink: () => {} })],
    });
  const offered = (state: EditorState) => {
    const offer = chipOffer(state, safeHref);
    return offer ? state.update(offer).state : state;
  };

  it('opens on a link and closes on an edit', () => {
    const state = offered(stateAt(8));
    expect(chipShown(state)).toMatchObject({ kind: 'note', target: 'Design' });
    expect(chipShown(state.update({ changes: { from: 0, insert: 'x' } }).state)).toBeNull();
  });

  it('closes when the caret moves or a range is selected', () => {
    const state = offered(stateAt(8));
    expect(chipShown(state.update({ selection: { anchor: 9 } }).state)).toBeNull();
    expect(chipShown(state.update({ selection: { anchor: 6, head: 10 } }).state)).toBeNull();
  });

  it('survives a transaction that leaves the caret where it was', () => {
    const state = offered(stateAt(8));
    expect(chipShown(state.update({ selection: { anchor: 8 } }).state)).not.toBeNull();
    expect(chipOffer(state, safeHref)).toBeNull();
  });

  it('stays shut away from a link', () => {
    expect(chipOffer(stateAt(18), safeHref)).toBeNull();
  });
});
