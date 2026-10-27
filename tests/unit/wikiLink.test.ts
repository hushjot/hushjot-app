import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { linkAt, linkInsertion, wikiLinkCompletion } from '../../src/editor/wikiLink.ts';
import type { NoteMeta } from '../../src/core/notes/model.ts';

const meta = (id: string, title: string): NoteMeta => ({
  id,
  title,
  folderId: null,
  pinnedAt: null,
  updatedAt: 0,
  createdAt: 0,
});

const TITLES = [
  meta('a', 'Design Review'),
  meta('b', 'Design notes'),
  meta('c', 'Deploy runbook'),
  meta('d', 'Kitchen redesign'),
];

/** A real state, because `inCode` and `linkAt` both read the syntax tree. */
const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdownLean()] });

function complete(doc: string, titles: readonly NoteMeta[] = TITLES, at = doc.length) {
  const state = stateOf(doc);
  return wikiLinkCompletion(() => titles)(new CompletionContext(state, at, true));
}

describe('[[ completion', () => {
  it('stays out of the way where there is no [[', () => {
    expect(complete('ordinary writing')).toBeNull();
    expect(complete('a [single bracket')).toBeNull();
    expect(complete('[label](https://example.test')).toBeNull();
  });

  it('offers every title on a bare [[', () => {
    const result = complete('[[');
    expect(result!.options.map((o) => o.label)).toEqual([
      'Design Review',
      'Design notes',
      'Deploy runbook',
      'Kitchen redesign',
    ]);
  });

  it('anchors after the brackets, so the title replaces only the target', () => {
    const result = complete('see [[Desi');
    expect(result!.from).toBe(6);
    expect(result!.to).toBe(10);
  });

  it('puts prefix matches ahead of substring matches', () => {
    // "Kitchen redesign" contains "desi" but does not start with it.
    expect(complete('[[desi')!.options.map((o) => o.label)).toEqual([
      'Design Review',
      'Design notes',
      'Kitchen redesign',
    ]);
  });

  it('filters nothing itself, so ranking is over the whole vault', () => {
    // `filter: false` is the point: handing CodeMirror a capped slice and
    // letting it narrow that would rank inside the slice.
    expect(complete('[[desi')!.filter).toBe(false);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 400 }, (_, i) => meta(`n${i}`, `Note ${i}`));
    expect(complete('[[', many)!.options).toHaveLength(50);
  });

  it('closes when nothing matches', () => {
    expect(complete('[[zzzz')).toBeNull();
  });

  it('stops at the bar, so an alias label is not a list of titles', () => {
    expect(complete('[[Design Review|the ')).toBeNull();
  });

  it('stays out of code', () => {
    // Inside a closed span, with the caret before the closing backtick.
    expect(complete('`[[Desi`', TITLES, 7)).toBeNull();
    // A fence needs no closer to be a fence, so it is blocked while being typed.
    expect(complete('```\n[[Desi')).toBeNull();
    expect(complete('    [[Desi')).toBeNull();
  });

  it('does fire inside an unterminated backtick, and that is lezer, not us', () => {
    // `` `[[Desi `` parses as Paragraph, not InlineCode — a lone backtick with
    // no closer is literal text in CommonMark, so there is no code node for
    // `inCode` to find. `hashtagCompletion` has the same hole for the same
    // reason, and closing the span settles it in both.
    expect(complete('`[[Desi')).not.toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(complete('[[DESIGN R')!.options.map((o) => o.label)).toEqual(['Design Review']);
  });
});

describe('linkInsertion', () => {
  it('reuses the closer closeBrackets already wrote, and lands after it', () => {
    // `[[|]]` — the ordinary case.
    expect(linkInsertion('My Note', true)).toEqual({ insert: 'My Note', caret: 9 });
  });

  it('writes its own closer when there is none', () => {
    expect(linkInsertion('My Note', false)).toEqual({ insert: 'My Note]]', caret: 9 });
  });
});

describe('linkAt', () => {
  const at = (doc: string, pos: number) => linkAt(stateOf(doc), pos);

  it('finds the link the caret is inside', () => {
    expect(at('see [[Design Review]] now', 10)).toEqual({
      target: 'Design Review',
      label: 'Design Review',
    });
  });

  it('finds it from either bracket pair', () => {
    expect(at('[[A Note]]', 1)?.target).toBe('A Note');
    expect(at('[[A Note]]', 9)?.target).toBe('A Note');
  });

  it('keeps the alias split', () => {
    expect(at('[[Design Review|the review]]', 5)).toEqual({
      target: 'Design Review',
      label: 'the review',
    });
  });

  it('returns null off a link, which is what leaves ⌘-click adding a cursor', () => {
    expect(at('see [[Design Review]] now', 2)).toBeNull();
    expect(at('see [[Design Review]] now', 24)).toBeNull();
    expect(at('ordinary writing', 5)).toBeNull();
    expect(at('[label](https://example.test)', 3)).toBeNull();
  });
});
