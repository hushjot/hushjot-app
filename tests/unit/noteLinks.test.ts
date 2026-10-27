import { describe, it, expect } from 'vitest';
import { parser as baseParser, GFM } from '@lezer/markdown';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { noteLinks, NOTE_LINK } from '../../src/editor/noteLinkSyntax.ts';

/** Node names in the tree, in document order. */
function names(parse: (text: string) => { iterate: (spec: { enter: (n: { name: string }) => void }) => void }, text: string): string[] {
  const out: string[] = [];
  parse(text).iterate({ enter: (n) => void out.push(n.name) });
  return out;
}

/**
 * The preview's parser, configured exactly as `preview/model.ts` configures it.
 * Reproduced here rather than exported, because the point of this file is to
 * check that the two call sites agree — importing one of them would defeat it.
 */
const previewParser = baseParser.configure([GFM, noteLinks]);

/** The editor's parser, reached through the language it is wrapped in. */
const editorParser = markdownLean().language.parser;

const parsePreview = (text: string) => previewParser.parse(text);
const parseEditor = (text: string) => editorParser.parse(text);

/** Positions of every `NoteLink` node, so a claim can be exact. */
function linkRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  previewParser.parse(text).iterate({
    enter: (n) => {
      if (n.name === NOTE_LINK) out.push([n.from, n.to]);
    },
  });
  return out;
}

describe('note link syntax: two parsers, one extension', () => {
  // The only guard against `markdownLean.ts` and `preview/model.ts` drifting.
  // Adding `noteLinks` to one and not the other is otherwise silent: the editor
  // would colour a link the preview rendered as brackets, or the reverse.
  const cases = [
    'See [[Some Note]] here.',
    '[[Design Review|the review]]',
    '- a task with [[A Link]]',
    '> quoted [[A Link]]',
    '# [[A Link]] in a heading',
  ];

  for (const text of cases) {
    it(`agrees on ${JSON.stringify(text)}`, () => {
      expect(names(parseEditor, text)).toContain(NOTE_LINK);
      expect(names(parsePreview, text)).toContain(NOTE_LINK);
    });
  }
});

describe('note link syntax: what is claimed', () => {
  it('claims the whole [[...]] and outranks the standard link parser', () => {
    expect(linkRanges('See [[Some Note]] here.')).toEqual([[4, 17]]);
    // Without `before: 'Link'` the inner `[Some Note]` would win; assert the
    // ordinary link parser got nothing.
    expect(names(parsePreview, 'See [[Some Note]] here.')).not.toContain('Link');
  });

  it('marks the brackets and the bar so they can recede', () => {
    expect(names(parsePreview, '[[a|b]]').filter((n) => n === 'NoteLinkMark')).toHaveLength(3);
    expect(names(parsePreview, '[[a]]').filter((n) => n === 'NoteLinkMark')).toHaveLength(2);
  });

  it('leaves an ordinary Markdown link alone', () => {
    const got = names(parsePreview, '[label](https://example.test)');
    expect(got).toContain('Link');
    expect(got).not.toContain(NOTE_LINK);
  });
});

describe('note link syntax: what falls through to brackets', () => {
  const notALink = (text: string) => {
    expect(linkRanges(text)).toEqual([]);
    // And the editor must agree, or the two highlight differently.
    expect(names(parseEditor, text)).not.toContain(NOTE_LINK);
  };

  it('needs both brackets and a closer', () => {
    notALink('[[unterminated');
    notALink('[single]');
    notALink('[[one closer]');
  });

  it('refuses a bracket inside the body', () => {
    notALink('[[a[b]]');
  });

  it('refuses an empty target', () => {
    notALink('[[]]');
    notALink('[[   ]]');
    notALink('[[|label]]');
  });

  it('refuses to cross a line, even inside one paragraph', () => {
    notALink('[[a\nb]]');
  });

  it('refuses a target past the cap', () => {
    notALink(`[[${'a'.repeat(201)}]]`);
  });

  it('leaves code alone', () => {
    // The code-span parser consumes its whole span before any other inline
    // parser is offered the position, and a fence is a block — so neither needs
    // a guard in `noteLinkSyntax.ts`, only this test.
    notALink('`[[not a link]]`');
    notALink('```\n[[not a link]]\n```');
    notALink('    [[indented code]]');
  });
});
