/**
 * The phone key bar's commands, tested the way the rest of the editor is:
 * over `EditorState`, with no DOM.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  accessoryCommand,
  cycleHeadingSpec,
  nextHeadingLevel,
  type AccessoryId,
} from '../../src/editor/accessoryKeys.ts';

const IDS: AccessoryId[] = [
  'heading', 'bold', 'italic', 'bullet', 'task', 'quote',
  'link', 'fence', 'indent', 'outdent', 'undo', 'redo',
];

/** Apply one spec and return the resulting text. */
function apply(doc: string): string {
  const state = EditorState.create({ doc, selection: { anchor: doc.length } });
  return state.update(cycleHeadingSpec(state)).state.doc.toString();
}

describe('the phone key bar', () => {
  it('has a command for every id it offers', () => {
    for (const id of IDS) expect(typeof accessoryCommand(id), id).toBe('function');
  });

  it('cycles a heading 1 → 2 → 3 → plain', () => {
    expect(nextHeadingLevel('hello')).toBe(1);
    expect(nextHeadingLevel('# hello')).toBe(2);
    expect(nextHeadingLevel('## hello')).toBe(3);
    // The fourth press asks for the level the line has, which removes it.
    expect(nextHeadingLevel('### hello')).toBe(3);
  });

  it('treats a deeper heading as "clear it"', () => {
    expect(nextHeadingLevel('##### deep')).toBe(5);
    expect(apply('##### deep')).toBe('deep');
  });

  it('applies that cycle to the real document', () => {
    expect(apply('hello')).toBe('# hello');
    expect(apply('# hello')).toBe('## hello');
    expect(apply('### hello')).toBe('hello');
  });

  it('ignores a line that only looks like a heading', () => {
    // No space and no end-of-line after the hashes: not a heading.
    expect(nextHeadingLevel('#hashtag')).toBe(1);
  });
});
