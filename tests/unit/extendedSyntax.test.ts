import { describe, it, expect } from 'vitest';
import { parser as baseParser, GFM } from '@lezer/markdown';
import { TreeFragment } from '@lezer/common';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { noteLinks } from '../../src/editor/noteLinkSyntax.ts';
import { extendedSyntax } from '../../src/editor/extendedSyntax.ts';
import { buildModel, type PNode } from '../../src/editor/preview/model.ts';
import { EMOJI } from '../../src/editor/emojiMap.ts';

/**
 * The preview's parser, configured exactly as `preview/model.ts` configures it,
 * and the editor's, reached through its language — the `noteLinks.test.ts`
 * arrangement, for the same reason: this file exists to catch the two drifting.
 */
const previewParser = baseParser.configure([GFM, noteLinks, ...extendedSyntax]);
const editorParser = markdownLean().language.parser;

function names(parser: { parse(text: string): { iterate(spec: { enter(n: { name: string }): void }): void } }, text: string): string[] {
  const out: string[] = [];
  parser.parse(text).iterate({ enter: (n) => void out.push(n.name) });
  return out;
}

/** Serialise the model for readable assertions. Test-only: the app never builds HTML strings. */
function html(nodes: PNode[]): string {
  return nodes
    .map((n) => {
      if ('text' in n) return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const attrs = Object.entries(n.attrs ?? {})
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`))
        .join('');
      return `<${n.tag}${attrs}>${html(n.children)}</${n.tag}>`;
    })
    .join('');
}

function render(text: string): string {
  return buildModel(text)
    .blocks.map((b) => html([b.node!]))
    .join('\n');
}

describe('extended syntax: two parsers, one list', () => {
  const cases: [string, string][] = [
    ['==marked==', 'Highlight'],
    ['H~2~O', 'Subscript'],
    ['x^2^', 'Superscript'],
    ['ship it :rocket:', 'Emoji'],
    ['## Title {#custom}', 'HeadingId'],
    ['Cited[^1]', 'FootnoteReference'],
    ['[^1]: The note.', 'FootnoteDefinition'],
    ['Term\n: Definition', 'DefinitionList'],
  ];
  for (const [text, node] of cases) {
    it(`agrees on ${node}`, () => {
      expect(names(editorParser, text)).toContain(node);
      expect(names(previewParser, text)).toContain(node);
    });
  }
});

describe('extended syntax: inline', () => {
  it('highlights ==text==, nested either way, but not comparisons', () => {
    expect(render('==mark== and **==bold==** and ==*em*==')).toBe(
      '<p><mark>mark</mark> and <strong><mark>bold</mark></strong> and <mark><em>em</em></mark></p>',
    );
    expect(render('a == b and x === y')).toBe('<p>a == b and x === y</p>');
  });

  it('renders sub/superscript without disturbing strikethrough', () => {
    expect(render('H~2~O, x^2^, ~~gone~~ and ~one~')).toBe(
      '<p>H<sub>2</sub>O, x<sup>2</sup>, <del>gone</del> and <sub>one</sub></p>',
    );
    // A space ends the run, so prose tildes and carets stay prose.
    expect(render('about ~5 minutes, 2^10 bytes')).toBe('<p>about ~5 minutes, 2^10 bytes</p>');
  });

  it('marks shortcodes for the renderer, which resolves them late', () => {
    expect(render(':rocket: and :+1:')).toBe(
      '<p><span class="emoji" data-emoji="rocket">:rocket:</span> and <span class="emoji" data-emoji="+1">:+1:</span></p>',
    );
    // A time is not a shortcode: a name needs a letter.
    expect(render('at 12:30:45')).toBe('<p>at 12:30:45</p>');
    expect(names(editorParser, 'at 12:30:45')).not.toContain('Emoji');
  });

  it('knows the common names, and nothing off the prototype', () => {
    expect(EMOJI.get('rocket')).toBe('🚀');
    expect(EMOJI.get('+1')).toBe('👍');
    expect(EMOJI.get('white_check_mark')).toBe('✅');
    expect(EMOJI.get('constructor')).toBeUndefined();
    expect(EMOJI.get('__proto__')).toBeUndefined();
  });

  it('leaves code alone', () => {
    expect(render('`==x==` `:rocket:` `[^1]`\n\n[^1]: n')).toContain('<code>==x==</code> <code>:rocket:</code> <code>[^1]</code>');
  });
});

describe('extended syntax: heading ids', () => {
  it('uses {#id} as the anchor and drops it from the text', () => {
    expect(render('## Setup steps {#setup}\n\n# Again {#setup}')).toBe(
      '<h2 data-anchor="setup">Setup steps</h2>\n<h1 data-anchor="setup-1">Again</h1>',
    );
  });

  it('prints {#id} as typed outside a heading', () => {
    expect(render('A paragraph {#not-an-anchor}')).toBe('<p>A paragraph {#not-an-anchor}</p>');
  });
});

describe('extended syntax: footnotes', () => {
  it('numbers notes in definition order and links both ways', () => {
    expect(render('One[^b] two[^a].\n\n[^a]: First.\n[^b]: Second\ncontinued.')).toBe(
      [
        '<p>One<sup><a href="#fn-2" class="footnote-ref" data-anchor="fnref-2">2</a></sup>' +
          ' two<sup><a href="#fn-1" class="footnote-ref" data-anchor="fnref-1">1</a></sup>.</p>',
        '<div class="footnotes"><hr></hr><ol>' +
          '<li data-anchor="fn-1">First. <a href="#fnref-1" class="footnote-back" aria-label="Back to text">↩</a></li>' +
          '<li data-anchor="fn-2">Second\ncontinued. <a href="#fnref-2" class="footnote-back" aria-label="Back to text">↩</a></li>' +
          '</ol></div>',
      ].join('\n'),
    );
  });

  it('leaves a citation with no note as brackets', () => {
    expect(render('Missing[^x].')).toBe('<p>Missing[^x].</p>');
  });

  it('is not mistaken for a link reference', () => {
    expect(render('x[^1]\n\n[^1]: https://example.com')).toContain(
      '<li data-anchor="fn-1"><a href="https://example.com">https://example.com</a>',
    );
  });

  it('ends a definition at a blank line and an interrupting block', () => {
    expect(render('x[^1]\n\n[^1]: Note.\n# Heading')).toBe(
      [
        '<p>x<sup><a href="#fn-1" class="footnote-ref" data-anchor="fnref-1">1</a></sup></p>',
        '<h1 data-anchor="heading">Heading</h1>',
        '<div class="footnotes"><hr></hr><ol><li data-anchor="fn-1">Note. <a href="#fnref-1" class="footnote-back" aria-label="Back to text">↩</a></li></ol></div>',
      ].join('\n'),
    );
  });

  it('rebuilds every block when a note changes, since numbers may move', () => {
    const first = buildModel('x[^1]\n\n[^1]: one');
    const second = buildModel('x[^1]\n\n[^1]: two', { epoch: first.epoch, has: () => true });
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.blocks.every((b) => b.node !== null)).toBe(true);
  });
});

describe('extended syntax: definition lists', () => {
  it('renders terms and definitions, with continuation lines', () => {
    expect(render('Term\n: One\n: Two\ncontinued\nTerm 2\n: Three\n\nAfter')).toBe(
      '<dl><dt>Term</dt><dd>One</dd><dd>Two\ncontinued</dd><dt>Term 2</dt><dd>Three</dd></dl>\n<p>After</p>',
    );
  });

  it('only starts at the beginning of a block', () => {
    expect(render('para line\nTerm\n: not a def')).toBe('<p>para line\nTerm\n: not a def</p>');
    expect(render('# Heading\n: not a def')).toBe('<h1 data-anchor="heading">Heading</h1>\n<p>: not a def</p>');
  });
});

describe('extended syntax: incremental parsing in the editor', () => {
  // The editor re-parses from fragments of the previous tree. A construct that
  // looks ahead (a definition list's `peekLine`) must not be missed when the
  // line it depends on is typed after the line it starts on.
  const edits: [string, number, string][] = [
    ['Term\n\nafter', 5, ': def'],
    ['Text[^1]\n\n', 10, '[^1]: note'],
    ['Term\n: def\n\nafter', 10, ' more'],
  ];
  for (const [before, at, insert] of edits) {
    it(`matches a fresh parse after inserting ${JSON.stringify(insert)}`, () => {
      const after = before.slice(0, at) + insert + before.slice(at);
      const old = editorParser.parse(before);
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(old), [
        { fromA: at, toA: at, fromB: at, toB: at + insert.length },
      ]);
      expect(editorParser.parse(after, fragments).toString()).toBe(editorParser.parse(after).toString());
    });
  }
});
