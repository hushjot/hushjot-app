/**
 * Markdown's "extended syntax" beyond GFM, as `@lezer/markdown` extensions
 * shared by the editor's grammar and the preview's.
 *
 * - `==highlight==`                  → `Highlight` (rendered as `<mark>`)
 * - `H~2~O`, `x^2^`                  → lezer's own `Subscript` / `Superscript`
 * - `:rocket:`                       → `Emoji` (names resolved later, `emojiMap.ts`)
 * - `## Heading {#custom-id}`        → `HeadingId`, the heading's anchor
 * - `text[^1]` + `[^1]: the note`    → `FootnoteReference` / `FootnoteDefinition`
 * - `Term` + `: definition`          → `DefinitionList`
 *
 * ## Two parsers, one list
 *
 * Exactly the `noteLinks` arrangement (`noteLinkSyntax.ts` explains it): the
 * editor (`markdownLean.ts`) and the preview (`preview/model.ts`) each build a
 * parser, and both spread this ONE array into their `configure` call, so the
 * editor can never colour something the preview renders as plain text.
 * `tests/unit/extendedSyntax.test.ts` parses the same strings with both.
 *
 * ## Why this is its own file
 *
 * The share viewer downloads it, so it imports `@lezer/*` and plain data and
 * nothing else — the same rule as `noteLinkSyntax.ts`.
 *
 * ## Where the block constructs apply
 *
 * Footnote definitions and definition lists are recognised at the top level of
 * a note only, not inside quotes or list items. Both read their content straight
 * from the source lines, which is only contiguous text at the top level; inside
 * a container each line carries a `> ` or an indent the parser would have to
 * stitch around. That is where people write them anyway, and a construct the
 * parser declines simply stays the paragraph it always was.
 *
 * ## Cost (§7)
 *
 * Every inline parser returns -1 on its first comparison for any character that
 * is not its own (`=`, `:`, `[`, `{`), and every scan is bounded by a short
 * constant or the end of the line. The block parsers look at one line, plus one
 * `peekLine` for a definition list, before declining.
 */
import {
  Subscript,
  Superscript,
  type BlockContext,
  type Element,
  type Line,
  type MarkdownConfig,
} from '@lezer/markdown';
import { Tag, tags as t } from '@lezer/highlight';

/** The editor's style for `==highlighted==` text; `theme.ts` gives it a background. */
export const highlightTag = Tag.define();

const EQUALS = 61; // =
const COLON = 58; // :
const BRACKET_OPEN = 91; // [
const CARET = 94; // ^
const BRACE_OPEN = 123; // {

const PUNCTUATION = /[\p{P}\p{S}]/u;

// --- Highlight -------------------------------------------------------------

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

/**
 * `==text==`, with the same flanking rules lezer's GFM strikethrough uses for
 * `~~`: so `a == b` and `x === y` are comparisons, not an opening mark.
 */
const highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightTag } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        if (pos > cx.offset && cx.char(pos - 1) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCTUATION.test(before);
        const pAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: 'Emphasis',
    },
  ],
};

// --- Emoji -----------------------------------------------------------------

/**
 * `:name:` by shape: lowercase letters, digits, `_`, `+`, `-`, with at least one
 * letter — so `12:30:45` is a time — or one of the few all-symbol names.
 *
 * Which names are real is `emojiMap.ts`'s business, and that table is not
 * imported here: it is 3 KB gzipped, and this file is in the share viewer's
 * first load, which has no 3 KB to spare (`bench:size`). The preview renders the
 * shortcode as typed and `render.ts` swaps in the emoji once the table has
 * loaded, the way it colours code. An unknown name simply stays as typed — and
 * the node has no editor style, so the editor never shows a difference.
 * (lezer ships an `Emoji` extension, but it claims any `:word:`, times
 * included.)
 */
const emoji: MarkdownConfig = {
  defineNodes: [{ name: 'Emoji' }],
  parseInline: [
    {
      name: 'Emoji',
      parse(cx, next, pos) {
        if (next !== COLON) return -1;
        const match = /^:([a-z0-9_+-]{1,40}):/.exec(cx.slice(pos, Math.min(cx.end, pos + 43)));
        if (!match || !/[a-z]|^(?:\+1|-1|100)$/.test(match[1]!)) return -1;
        return cx.addElement(cx.elt('Emoji', pos, pos + match[0].length));
      },
    },
  ],
};

// --- Heading IDs -----------------------------------------------------------

const HEADING_ID = /^\{#([\w-]{1,64})\}[ \t]*$/;

/**
 * A trailing `{#custom-id}`. The inline parser cannot see that it is inside a
 * heading, so it claims the form at the very end of any inline run; the preview
 * uses it as the anchor in a heading and prints it as typed anywhere else.
 */
const headingIds: MarkdownConfig = {
  defineNodes: [{ name: 'HeadingId', style: t.processingInstruction }],
  parseInline: [
    {
      name: 'HeadingId',
      parse(cx, next, pos) {
        if (next !== BRACE_OPEN || cx.char(pos + 1) !== 35 /* # */ || cx.end - pos > 72) return -1;
        const match = HEADING_ID.exec(cx.slice(pos, cx.end));
        if (!match) return -1;
        const close = pos + match[0].indexOf('}') + 1;
        return cx.addElement(cx.elt('HeadingId', pos, close));
      },
    },
  ],
};

/** The id in a `HeadingId` node's source text, `{#id}`. */
export function headingIdOf(source: string): string {
  return source.slice(2, -1);
}

// --- Shared block helpers --------------------------------------------------

/**
 * Lines that end a paragraph-like construct without a blank line between:
 * a heading, quote, fence, list item, rule or HTML. A cheap stand-in for the
 * parser's own `endLeafBlock` list, which wants a leaf block we do not have.
 */
const INTERRUPTS = /^(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|[-*+][ \t]|\d{1,9}[.)][ \t]|<[a-zA-Z/!?]|(?:[-*_][ \t]*){3,}$)/;

function interrupts(line: Line): boolean {
  return line.indent < 4 && INTERRUPTS.test(line.text.slice(line.pos));
}

function blank(line: Line): boolean {
  return line.pos === line.text.length;
}

function atTop(cx: BlockContext): boolean {
  return cx.parentType().name === 'Document';
}

// --- Footnotes -------------------------------------------------------------

const FOOTNOTE_DEF = /^\[\^([^\]\s]{1,64})\]:/;
const FOOTNOTE_REF = /^\[\^([^\]\s]{1,64})\]/;

function isFootnoteDef(cx: BlockContext, line: Line): boolean {
  return line.next === BRACKET_OPEN && line.indent < 4 && atTop(cx) && FOOTNOTE_DEF.test(line.text.slice(line.pos));
}

/**
 * `[^label]` in text, and `[^label]: note` as a block that runs until a blank
 * line, the next definition or anything that would end a paragraph.
 *
 * The definition parser runs before `LinkReference`, which would otherwise read
 * `[^1]: https://…` as a link reference labelled `^1`.
 */
const footnotes: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: t.labelName },
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteLabel', style: t.labelName },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN || cx.char(pos + 1) !== CARET) return -1;
        const match = FOOTNOTE_REF.exec(cx.slice(pos, Math.min(cx.end, pos + 68)));
        if (!match) return -1;
        return cx.addElement(cx.elt('FootnoteReference', pos, pos + match[0].length));
      },
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      before: 'LinkReference',
      parse(cx, line) {
        if (!isFootnoteDef(cx, line)) return false;
        const from = cx.lineStart + line.pos;
        const head = FOOTNOTE_DEF.exec(line.text.slice(line.pos))![0];
        const contentFrom = from + head.length;
        let text = line.text.slice(line.pos + head.length);
        while (cx.nextLine() && !blank(line) && !isFootnoteDef(cx, line) && !interrupts(line)) {
          text += '\n' + line.text;
        }
        cx.addElement(
          cx.elt('FootnoteDefinition', from, contentFrom + text.length, [
            cx.elt('FootnoteLabel', from, contentFrom),
            ...cx.parser.parseInline(text, contentFrom),
          ]),
        );
        return true;
      },
      endLeaf: isFootnoteDef,
    },
  ],
};

/** The label of a `FootnoteReference` (`[^x]`) or `FootnoteLabel` (`[^x]:`) source, normalised. */
export function footnoteLabel(source: string): string {
  return source.replace(/^\[\^/, '').replace(/\]:?$/, '').toLowerCase();
}

// --- Definition lists ------------------------------------------------------

const DEF_LINE = /^ {0,3}:[ \t]+\S/;

/**
 * A term line followed directly by one or more `: definition` lines, as in
 * PHP Markdown Extra and Pandoc. A definition continues onto following lines
 * until a blank line, another `:` line, or a line that is itself the next term
 * (because a `:` line follows it).
 *
 * Installed after every other eager block parser, so a heading, a list item or
 * a fence followed by `: …` stays what it was. And the term must start a block:
 * a paragraph's last line followed by `: …` is not quietly re-read as a term.
 */
const definitionLists: MarkdownConfig = {
  defineNodes: [
    { name: 'DefinitionList', block: true },
    { name: 'DefinitionTerm', style: t.strong },
    { name: 'Definition' },
    { name: 'DefinitionMark', style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'DefinitionList',
      after: 'HTMLBlock',
      parse(cx, line) {
        if (line.indent >= 4 || !atTop(cx) || DEF_LINE.test(line.text) || !DEF_LINE.test(cx.peekLine())) return false;
        const from = cx.lineStart + line.pos;
        const children: Element[] = [];
        let more = true;
        while (more) {
          const termFrom = cx.lineStart + line.pos;
          const term = line.text.slice(line.pos).replace(/\s+$/, '');
          children.push(cx.elt('DefinitionTerm', termFrom, termFrom + term.length, cx.parser.parseInline(term, termFrom)));
          more = cx.nextLine();
          while (more && DEF_LINE.test(line.text)) {
            const colonAt = line.text.indexOf(':');
            const colon = cx.lineStart + colonAt;
            const contentFrom = cx.lineStart + line.skipSpace(colonAt + 1);
            let text = line.text.slice(contentFrom - cx.lineStart);
            more = cx.nextLine();
            while (
              more && !blank(line) && !DEF_LINE.test(line.text) && !interrupts(line) && !DEF_LINE.test(cx.peekLine())
            ) {
              text += '\n' + line.text;
              more = cx.nextLine();
            }
            children.push(
              cx.elt('Definition', colon, contentFrom + text.length, [
                cx.elt('DefinitionMark', colon, colon + 1),
                ...cx.parser.parseInline(text, contentFrom),
              ]),
            );
          }
          // Another term straight after the last definition starts the next entry.
          more = more && !blank(line) && !interrupts(line) && DEF_LINE.test(cx.peekLine());
        }
        cx.addElement(cx.elt('DefinitionList', from, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};

/**
 * Everything above, in one array for both `configure` calls. Order matters only
 * within a hook point, and each entry pins its own with `before`/`after`.
 */
export const extendedSyntax: MarkdownConfig[] = [
  highlight,
  Subscript,
  Superscript,
  emoji,
  headingIds,
  footnotes,
  definitionLists,
];
