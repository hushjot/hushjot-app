/**
 * Markdown → render model for the read-only preview (§10, §23).
 *
 * The output is plain data rather than HTML or DOM, and that is the security
 * design, not a convenience. A note is attacker-controllable text (it can arrive
 * by sync, or be pasted), and any script that runs on our origin can use the
 * vault key (docs/security.md, "XSS on our own origin"). So the preview never
 * produces markup that a browser parses:
 *
 * - `render.ts` turns this model into nodes with `createElement` and
 *   `textContent`. Tags and attributes come from the fixed sets below, and are
 *   never taken from the note.
 * - Raw HTML in a note (`HTMLBlock`, `HTMLTag`) stays literal text.
 * - Link targets go through `safeHref`. Only http(s), mailto and in-note
 *   fragments survive; `javascript:` and relative URLs become plain text.
 * - Images are never fetched. The CSP would block remote ones anyway, and
 *   fetching would tell an image host who opened the note and when. A remote
 *   image becomes a link to itself. Only raster `data:` URIs render inline:
 *   they are already in the note.
 * - Heading anchors are `data-anchor`, not `id`. An `id` taken from note text
 *   could clobber a global, and it would collide across four tiles.
 * - A `[[note link]]` is a `button` with `data-note`, never an `a` with an
 *   `href`: there is no URL involved, so there is no scheme for `safeHref` to
 *   judge. It renders `disabled` and `render.ts` enables it only where the page
 *   gave it somewhere to navigate.
 * - Footnotes link with `#fn-N` / `#fnref-N` fragments to `data-anchor`s, the
 *   heading mechanism exactly; a `{#custom-id}` on a heading only changes which
 *   name goes into that attribute, never an `id`.
 *
 * The parser is `@lezer/markdown` with GFM, which the editor already ships, so
 * the preview adds no dependency. It is a plain parser with no nested
 * `parseCode`: `markdownLean.ts` explains the re-parse loop that injection
 * invites. Code highlighting happens later, in `render.ts`.
 *
 * One `Block` per top-level node, keyed by its source text. That key lets the
 * renderer keep the DOM of every block the last keystroke did not touch. A
 * block the caller already holds is reported with `node: null`, so the model
 * isn't rebuilt either: on a long note in split view, one render costs one
 * parse plus the edited block.
 */
import { parser as baseParser, GFM } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { normaliseTag, TAG_PATTERN } from '../../core/notes/tags.ts';
import { parseLinkBody } from '../../core/notes/links.ts';
import { noteLinks, NOTE_LINK } from '../noteLinkSyntax.ts';
import { extendedSyntax, footnoteLabel, headingIdOf } from '../extendedSyntax.ts';
import { safeHref } from './href.ts';

// Its own module so the editor's link chip (`linkChip.ts`) can apply the same
// allowlist without pulling this file onto the critical path. Re-exported
// because this is where callers have always found it.
export { safeHref };

// The SAME `noteLinks` the editor's parser takes (`markdownLean.ts`). Two
// parsers exist because the editor needs fold and language-data props this one
// has no use for; one extension exists because a `[[link]]` the editor colours
// and the preview renders as brackets is the kind of disagreement nothing would
// notice. `tests/unit/noteLinks.test.ts` parses one string with both.
// `extendedSyntax` is shared the same way, and tested the same way
// (`tests/unit/extendedSyntax.test.ts`).
const parser = baseParser.configure([GFM, noteLinks, ...extendedSyntax]);

export type Tag =
  | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'ul' | 'ol' | 'li' | 'blockquote' | 'pre' | 'code'
  | 'em' | 'strong' | 'del' | 'a' | 'img' | 'hr' | 'br'
  | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td' | 'input' | 'span' | 'div' | 'button'
  | 'mark' | 'sub' | 'sup' | 'dl' | 'dt' | 'dd';

export type AttrName =
  | 'href' | 'title' | 'src' | 'alt' | 'class' | 'start'
  | 'data-anchor' | 'data-lang' | 'data-tag' | 'data-task' | 'data-note' | 'data-emoji'
  | 'type' | 'checked' | 'disabled' | 'aria-label';

export interface PText {
  text: string;
}

export interface PElement {
  tag: Tag;
  attrs?: Partial<Record<AttrName, string>>;
  children: PNode[];
}

export type PNode = PText | PElement;

export interface Block {
  /** Source text, plus the heading anchor where one applies. Equal key, equal output. */
  key: string;
  from: number;
  to: number;
  /** `null` when the caller said it already holds this key. */
  node: PElement | null;
}

export interface Model {
  blocks: Block[];
  /**
   * Fingerprint of the link reference definitions. A block's output depends on
   * them as well as its own text, so a change here invalidates every key.
   */
  epoch: string;
}

export interface Reuse {
  epoch: string;
  /** Called exactly once per block, in order. True means "I hold this key, skip it". */
  has(key: string): boolean;
}

export function buildModel(text: string, reuse?: Reuse): Model {
  const tree = parser.parse(text);
  const refs = new Map<string, { href: string; title: string | undefined }>();
  let epoch = '';
  collectRefs(tree.topNode, text, refs, (slice) => (epoch += slice + '\n'));

  // Footnotes are numbered in the order they are defined, not first cited:
  // a number that depended on which block cited first would make every block's
  // output depend on the blocks before it, and block reuse could not survive.
  // Their text joins the epoch for the same reason a link reference's does.
  const footnotes = new Map<string, { n: number; node: SyntaxNode }>();
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'FootnoteDefinition') continue;
    const label = node.getChild('FootnoteLabel');
    const name = label ? footnoteLabel(text.slice(label.from, label.to)) : '';
    epoch += '\u0001' + text.slice(node.from, node.to) + '\n';
    // First definition wins, as for link references.
    if (name && !footnotes.has(name)) footnotes.set(name, { n: footnotes.size + 1, node });
  }

  const b = new Builder(text, refs, footnotes);
  const reusable = reuse && reuse.epoch === epoch ? reuse : undefined;
  const blocks: Block[] = [];
  const anchors = new Map<string, number>();

  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'LinkReference' || node.name === 'CommentBlock' || node.name === 'FootnoteDefinition') continue;
    let key = text.slice(node.from, node.to);

    let anchor: string | undefined;
    if (headingLevel(node) !== undefined) {
      const custom = node.getChild('HeadingId');
      const base =
        (custom ? slug(headingIdOf(text.slice(custom.from, custom.to))) : slug(plainText(b.inline(node, node.from, node.to)))) ||
        'section';
      const seen = anchors.get(base) ?? 0;
      anchors.set(base, seen + 1);
      anchor = seen === 0 ? base : `${base}-${seen}`;
      key += '\u0000' + anchor;
    }

    const held = reusable?.has(key) ?? false;
    // Task markers are addressed relative to their block, so the builder needs
    // its origin: a block's element outlives the offsets of the text before it.
    b.blockFrom = node.from;
    blocks.push({ key, from: node.from, to: node.to, node: held ? null : b.block(node, false, anchor) });
  }

  // The notes themselves, as one last block wherever they were written. It sits
  // at the end of the text so `blocks` stays ordered by `from`, which
  // `render.ts` binary-searches; the epoch already covers its content.
  if (footnotes.size > 0) {
    const key = '\u0000footnotes';
    const held = reusable?.has(key) ?? false;
    blocks.push({ key, from: text.length, to: text.length, node: held ? null : b.footnotes() });
  }

  return { blocks, epoch };
}

// --- URLs ----------------------------------------------------------------

/** Inline raster only. SVG is excluded: it is a document, not a picture. */
export function safeImageSrc(url: string): string | null {
  const probe = url.trim();
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i.test(probe) ? probe : null;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

// --- Tree walking --------------------------------------------------------

const MARKS = new Set([
  'HeaderMark', 'QuoteMark', 'ListMark', 'LinkMark', 'EmphasisMark', 'CodeMark',
  'StrikethroughMark', 'TaskMarker', 'TableDelimiter', 'CodeInfo',
  'HighlightMark', 'SubscriptMark', 'SuperscriptMark', 'FootnoteLabel', 'DefinitionMark',
]);

function headingLevel(node: SyntaxNode): number | undefined {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
  return match ? +match[1]! : undefined;
}

function collectRefs(
  parent: SyntaxNode,
  text: string,
  refs: Map<string, { href: string; title: string | undefined }>,
  record: (slice: string) => void,
): void {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.name === 'LinkReference') {
      record(text.slice(node.from, node.to));
      const label = node.getChild('LinkLabel');
      const url = node.getChild('URL');
      if (!label || !url) continue;
      const name = normalizeLabel(text.slice(label.from + 1, label.to - 1));
      // First definition wins (CommonMark).
      if (refs.has(name)) continue;
      const title = node.getChild('LinkTitle');
      refs.set(name, {
        href: stripAngles(text.slice(url.from, url.to)),
        title: title ? text.slice(title.from + 1, title.to - 1) : undefined,
      });
    } else if (
      node.name === 'Blockquote' || node.name === 'BulletList' ||
      node.name === 'OrderedList' || node.name === 'ListItem'
    ) {
      collectRefs(node, text, refs, record);
    }
  }
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripAngles(url: string): string {
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
}

function el(tag: Tag, children: PNode[] = [], attrs?: PElement['attrs']): PElement {
  return attrs ? { tag, attrs, children } : { tag, children };
}

export function plainText(nodes: PNode[]): string {
  let out = '';
  for (const node of nodes) {
    if ('text' in node) out += node.text;
    else if (node.tag === 'img') out += node.attrs?.alt ?? '';
    else out += plainText(node.children);
  }
  return out;
}

class Builder {
  /** Above zero inside a link's label, where a tag would be a button inside a link. */
  #noTags = 0;

  /**
   * Source offset of the top-level block being built, set by `buildModel`.
   * `data-task` is measured from here rather than from the document, because a
   * reused block keeps its element while the text ahead of it changes length.
   */
  blockFrom = 0;

  constructor(
    private readonly text: string,
    private readonly refs: Map<string, { href: string; title: string | undefined }>,
    private readonly notes: Map<string, { n: number; node: SyntaxNode }> = new Map(),
  ) {}

  slice(from: number, to: number): string {
    return this.text.slice(from, to);
  }

  /** Every block-level child of a container, marks skipped. */
  blocks(parent: SyntaxNode, tight: boolean): PNode[] {
    const out: PNode[] = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (MARKS.has(node.name) || node.name === 'LinkReference' || node.name === 'CommentBlock') continue;
      const built = this.block(node, tight);
      if (tight && built.tag === 'p') out.push(...built.children);
      else out.push(built);
    }
    return out;
  }

  block(node: SyntaxNode, tight: boolean, anchor?: string): PElement {
    const level = headingLevel(node);
    if (level !== undefined) {
      const tag = `h${level}` as Tag;
      return el(tag, trimEdges(this.inline(node, node.from, node.to)), anchor ? { 'data-anchor': anchor } : undefined);
    }

    switch (node.name) {
      case 'Paragraph':
        return el('p', trimEdges(this.inline(node, node.from, node.to)));
      case 'Blockquote':
        return el('blockquote', this.blocks(node, false));
      case 'HorizontalRule':
        return el('hr');
      case 'BulletList':
      case 'OrderedList':
        return this.list(node);
      case 'FencedCode':
        return this.code(node, true);
      case 'CodeBlock':
        return this.code(node, false);
      case 'Table':
        return this.table(node);
      case 'ListItem':
        return el('li', this.blocks(node, tight));
      case 'Task':
        return el('span', this.inline(node, node.from, node.to));
      case 'DefinitionList':
        return this.definitionList(node);
      default:
        // HTMLBlock, ProcessingInstructionBlock and anything unforeseen: the
        // source, verbatim, as text. Never markup.
        return el('pre', [el('code', [{ text: this.slice(node.from, node.to) }])], { class: 'raw' });
    }
  }

  definitionList(node: SyntaxNode): PElement {
    const children: PElement[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'DefinitionTerm') children.push(el('dt', trimEdges(this.inline(child, child.from, child.to))));
      else if (child.name === 'Definition') children.push(el('dd', trimEdges(this.inline(child, child.from, child.to))));
    }
    return el('dl', children);
  }

  /**
   * The notes, numbered as `buildModel` numbered them, each with a link back to
   * where it was cited. `fn-N` and `fnref-N` are `data-anchor`s, so the click
   * handler in `render.ts` that scrolls to headings scrolls to these too.
   */
  footnotes(): PElement {
    const items: PElement[] = [];
    for (const { n, node } of this.notes.values()) {
      const label = node.getChild('FootnoteLabel');
      const body = trimEdges(this.inline(node, label ? label.to : node.from, node.to));
      const back = el('a', [{ text: '↩' }], { href: `#fnref-${n}`, class: 'footnote-back', 'aria-label': 'Back to text' });
      items.push(el('li', [...body, { text: ' ' }, back], { 'data-anchor': `fn-${n}` }));
    }
    return el('div', [el('hr'), el('ol', items)], { class: 'footnotes' });
  }

  list(node: SyntaxNode): PElement {
    const items: SyntaxNode[] = [];
    for (let item = node.firstChild; item; item = item.nextSibling) {
      if (item.name === 'ListItem') items.push(item);
    }
    const tight = !items.some((item, i) => {
      const next = items[i + 1];
      if (next && hasBlankLine(this.slice(item.to, next.from))) return true;
      let child = item.firstChild;
      while (child && child.nextSibling) {
        if (!MARKS.has(child.name) && hasBlankLine(this.slice(child.to, child.nextSibling.from))) return true;
        child = child.nextSibling;
      }
      return false;
    });

    const children = items.map((item) => {
      const task = item.getChild('Task');
      if (!task) return el('li', this.blocks(item, tight));
      const marker = task.getChild('TaskMarker');
      const checked = marker ? /x/i.test(this.slice(marker.from, marker.to)) : false;
      const body = trimEdges(this.inline(task, task.from, task.to));
      // `disabled` is the default and the renderer removes it, so a caller that
      // cannot write — the share viewer, the history preview — is inert by
      // omission. `data-task` locates the `[ ]` in the source for the one that
      // can; without a marker there is nothing to tick.
      const box = el('input', [], {
        type: 'checkbox',
        disabled: '',
        ...(checked ? { checked: '' } : {}),
        ...(marker ? { 'data-task': String(marker.from - this.blockFrom) } : {}),
        'aria-label': plainText(body),
      });
      // In a loose list the box goes inside the paragraph, as GitHub puts it:
      // before a block `<p>` it would sit on a line of its own above the text.
      const lead: PNode[] = [box, { text: ' ' }, ...body];
      const content = tight ? lead : [el('p', lead)];
      // Anything after the task paragraph: a nested list, a quote.
      const rest: PNode[] = [];
      for (let child = task.nextSibling; child; child = child.nextSibling) {
        if (!MARKS.has(child.name)) rest.push(this.block(child, tight));
      }
      return el('li', [...content, ...rest], { class: 'task' });
    });

    if (node.name === 'BulletList') return el('ul', children);
    const mark = items[0]?.getChild('ListMark');
    const start = mark ? parseInt(this.slice(mark.from, mark.to), 10) : 1;
    return el('ol', children, Number.isFinite(start) && start !== 1 ? { start: String(start) } : undefined);
  }

  /**
   * Code text is cut from the source rather than read from `CodeText`: inside a
   * quote or a list each line carries the container's prefix (`> `, indentation),
   * and the tree reports those as marks scattered through the block.
   */
  code(node: SyntaxNode, fenced: boolean): PElement {
    const lineStart = this.text.lastIndexOf('\n', node.from - 1) + 1;
    const prefix = node.from - lineStart;
    let body: string;
    let lang = '';

    if (fenced) {
      const info = node.getChild('CodeInfo');
      if (info) lang = /\S*/.exec(this.slice(info.from, info.to))![0]!;
      const openEnd = this.text.indexOf('\n', node.from);
      const last = node.lastChild;
      const closed = last && last.name === 'CodeMark' && last.from !== node.from;
      const end = closed ? this.text.lastIndexOf('\n', last.from - 1) : node.to;
      body = openEnd === -1 || openEnd >= end ? '' : this.slice(openEnd + 1, end);
    } else {
      body = this.slice(lineStart, node.to);
    }

    const lines = body.split('\n').map((line) => stripPrefix(line, prefix));
    const attrs: PElement['attrs'] = lang ? { 'data-lang': lang } : undefined;
    return el('pre', [el('code', [{ text: lines.join('\n') }])], attrs);
  }

  table(node: SyntaxNode): PElement {
    let align: string[] = [];
    const rows: SyntaxNode[] = [];
    let header: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableHeader') header = child;
      else if (child.name === 'TableRow') rows.push(child);
      else if (child.name === 'TableDelimiter') align = parseAlignment(this.slice(child.from, child.to));
    }

    const row = (source: SyntaxNode, tag: 'th' | 'td', width: number) => {
      const cells = splitCells(source);
      const out: PElement[] = [];
      for (let i = 0; i < Math.max(width, 1); i++) {
        const cell = cells[i];
        const content = cell ? trimEdges(this.inline(cell, cell.from, cell.to)) : [];
        const a = align[i];
        out.push(el(tag, content, a ? { class: `align-${a}` } : undefined));
      }
      return el('tr', out);
    };

    const width = header ? splitCells(header).length : align.length;
    const children: PElement[] = [];
    if (header) children.push(el('thead', [row(header, 'th', width)]));
    if (rows.length) children.push(el('tbody', rows.map((r) => row(r, 'td', width))));
    return el('table', children);
  }

  // --- Inline -------------------------------------------------------------

  /** Inline content of `parent` between `from` and `to`: gaps are text, children are spans. */
  inline(parent: SyntaxNode, from: number, to: number): PNode[] {
    const out: PNode[] = [];
    let at = from;
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.to <= from) continue;
      if (child.from >= to) break;
      if (child.from > at) this.prose(out, at, child.from);
      this.span(child, out);
      at = child.to;
    }
    if (at < to) this.prose(out, at, to);
    return out;
  }

  /**
   * Plain text between inline nodes, with `#tags` made into buttons that
   * filter the note list. Only here: code, URLs and raw HTML are separate
   * nodes and never reach this, and link labels switch it off. Whether a `#`
   * starts a tag depends on the character before it, which may sit just
   * outside this run — so that character is read from the source.
   */
  prose(out: PNode[], from: number, to: number): void {
    const text = this.slice(from, to);
    if (this.#noTags > 0 || text.indexOf('#') === -1) {
      pushText(out, text);
      return;
    }
    const before = from > 0 ? this.slice(from - 1, from) : '\n';
    const scan = before + text;
    let at = 0;
    for (const match of scan.matchAll(TAG_PATTERN)) {
      const body = match[2]!;
      const label = normaliseTag(body);
      // Only a tag whose characters are a prefix of the match can be cut out
      // of it cleanly; `#a//b` stays text rather than render as something else.
      if (!label || !body.startsWith(label)) continue;
      const start = match.index! + match[1]!.length - 1;
      if (start < 0) continue;
      if (start > at) pushText(out, text.slice(at, start));
      out.push(el('button', [{ text: `#${label}` }], { class: 'tag', type: 'button', 'data-tag': label.toLowerCase() }));
      at = start + 1 + label.length;
    }
    if (at < text.length) pushText(out, text.slice(at));
  }

  span(node: SyntaxNode, out: PNode[]): void {
    const inner = () => this.inline(node, node.from, node.to);
    switch (node.name) {
      case 'Emphasis':
        out.push(el('em', inner()));
        return;
      case 'StrongEmphasis':
        out.push(el('strong', inner()));
        return;
      case 'Strikethrough':
        out.push(el('del', inner()));
        return;
      case 'Highlight':
        out.push(el('mark', inner()));
        return;
      case 'Subscript':
        out.push(el('sub', inner()));
        return;
      case 'Superscript':
        out.push(el('sup', inner()));
        return;
      case 'Emoji': {
        // The shortcode as typed; `render.ts` swaps in the emoji once the
        // table has loaded (`extendedSyntax.ts` says why it is late).
        const source = this.slice(node.from, node.to);
        out.push(el('span', [{ text: source }], { class: 'emoji', 'data-emoji': source.slice(1, -1) }));
        return;
      }
      case 'HeadingId':
        // A heading's anchor, which `buildModel` has already read. Anywhere
        // else it is just what was typed.
        if (node.parent && headingLevel(node.parent) !== undefined) return;
        pushText(out, this.slice(node.from, node.to));
        return;
      case 'FootnoteReference': {
        const note = this.notes.get(footnoteLabel(this.slice(node.from, node.to)));
        // A citation with no note is the brackets as typed.
        if (!note) {
          pushText(out, this.slice(node.from, node.to));
          return;
        }
        const n = String(note.n);
        out.push(el('sup', [el('a', [{ text: n }], { href: `#fn-${n}`, class: 'footnote-ref', 'data-anchor': `fnref-${n}` })]));
        return;
      }
      case 'InlineCode': {
        const first = node.firstChild;
        const last = node.lastChild;
        let code = this.slice(first ? first.to : node.from, last && last !== first ? last.from : node.to);
        code = code.replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push(el('code', [{ text: code }]));
        return;
      }
      case 'HardBreak':
        out.push(el('br'));
        return;
      case 'Escape':
        pushText(out, this.slice(node.from + 1, node.to));
        return;
      case 'Entity':
        pushText(out, decodeEntity(this.slice(node.from, node.to)));
        return;
      case NOTE_LINK:
        this.noteLink(node, out);
        return;
      case 'Link':
        this.link(node, out, false);
        return;
      case 'Image':
        this.link(node, out, true);
        return;
      case 'Autolink': {
        const url = node.getChild('URL');
        this.autolink(url ? this.slice(url.from, url.to) : this.slice(node.from + 1, node.to - 1), out);
        return;
      }
      case 'URL':
        this.autolink(this.slice(node.from, node.to), out);
        return;
      case 'Comment':
      case 'ProcessingInstruction':
        return;
      default:
        if (MARKS.has(node.name)) return;
        // HTMLTag and anything unrecognised: literal source text.
        pushText(out, this.slice(node.from, node.to));
    }
  }

  /**
   * `[[Note link]]` — a button carrying the title it references, never an `a`.
   *
   * There is no `href` to give it: the target is a *title*, and which note that
   * is cannot be known here (`core/notes/links.ts` says why, and `render.ts`
   * says why resolution may not live in this file). A relative href would be
   * refused by `safeHref` anyway, and a `#…` one would collide with the heading
   * anchors `render.ts` resolves. So this is the `#tag` shape, one field along:
   * a fixed tag and class, the label through `text` and the target through an
   * attribute.
   *
   * **`disabled` unless the page says otherwise**, which is the task-checkbox
   * contract exactly (`taskMarker` below). `render.ts` removes it only where a
   * caller handed over a resolver, so the share viewer and the history panel show
   * inert text without either of them knowing this feature exists.
   *
   * The label is plain text and does not go through `prose()`, so a `#tag` inside
   * one cannot become a nested button — the same thing `#noTags` buys for an
   * ordinary link's label, here for free.
   */
  noteLink(node: SyntaxNode, out: PNode[]): void {
    const link = parseLinkBody(this.slice(node.from + 2, node.to - 2));
    // The parser refuses to build the node otherwise, so this is unreachable;
    // it is here because the two modules could drift and brackets are the safe
    // answer if they ever do.
    if (!link) {
      pushText(out, this.slice(node.from, node.to));
      return;
    }
    out.push(
      el('button', [{ text: link.label }], {
        class: 'notelink',
        type: 'button',
        'data-note': link.target,
        disabled: '',
      }),
    );
  }

  autolink(url: string, out: PNode[]): void {
    let target = url;
    if (/^www\./i.test(url)) target = `http://${url}`;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && url.includes('@')) target = `mailto:${url}`;
    const href = safeHref(target);
    out.push(href ? el('a', [{ text: url }], { href }) : { text: url });
  }

  link(node: SyntaxNode, out: PNode[], image: boolean): void {
    // [label](url "title") | [label][ref] | [label][] | [label]
    let open: SyntaxNode | null = null;
    let close: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'LinkMark') continue;
      if (!open) open = child;
      else if (this.slice(child.from, child.to) === ']') {
        close = child;
        break;
      }
    }
    this.#noTags++;
    const labelNodes = open && close ? this.inline(node, open.to, close.from) : [];
    this.#noTags--;

    let href: string | undefined;
    let title: string | undefined;
    const url = node.getChild('URL');
    if (url) {
      href = stripAngles(this.slice(url.from, url.to));
      const t = node.getChild('LinkTitle');
      if (t) title = this.slice(t.from + 1, t.to - 1);
    } else {
      const ref = node.getChild('LinkLabel');
      const name = ref && ref.to - ref.from > 2
        ? this.slice(ref.from + 1, ref.to - 1)
        : plainText(labelNodes);
      const found = this.refs.get(normalizeLabel(name));
      if (found) ({ href, title } = found);
    }

    if (href === undefined) {
      // An unresolved `[text]` or `[text][ref]` is just brackets.
      if (!this.hasParen(node)) {
        pushText(out, image ? '![' : '[');
        out.push(...labelNodes);
        pushText(out, this.slice(close ? close.from : node.to, node.to));
        return;
      }
      href = '';
    }

    if (image) {
      const alt = plainText(labelNodes);
      const src = safeImageSrc(href);
      if (src) {
        out.push(el('img', [], title ? { src, alt, title } : { src, alt }));
        return;
      }
      // Never fetched: a link to the image, labelled with its alt text.
      const safe = safeHref(href);
      const label: PNode[] = [{ text: `🖼 ${alt || href}` }];
      out.push(safe ? el('a', label, { href: safe, class: 'image-link', title: title ?? href }) : el('span', label, { class: 'image-link' }));
      return;
    }

    const safe = safeHref(href);
    if (!safe) {
      out.push(el('span', labelNodes, { class: 'unsafe-link', title: href }));
      return;
    }
    out.push(el('a', labelNodes, title ? { href: safe, title } : { href: safe }));
  }

  hasParen(node: SyntaxNode): boolean {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'LinkMark' && this.slice(child.from, child.to) === '(') return true;
    }
    return false;
  }
}

function hasBlankLine(gap: string): boolean {
  return /\n[ \t>]*\n/.test(gap);
}

/** Remove up to `width` characters of container prefix: whitespace and quote markers. */
function stripPrefix(line: string, width: number): string {
  let i = 0;
  while (i < width && i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '>')) i++;
  return line.slice(i);
}

function splitCells(row: SyntaxNode): (SyntaxNode | null)[] {
  const cells: (SyntaxNode | null)[] = [];
  let current: SyntaxNode | null = null;
  let seen = false;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') {
      if (seen) cells.push(current);
      current = null;
      seen = true;
    } else if (child.name === 'TableCell') {
      current = child;
      seen = true;
    }
  }
  if (current) cells.push(current);
  return cells;
}

function parseAlignment(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => {
      const c = cell.trim();
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
}

function pushText(out: PNode[], text: string): void {
  const last = out[out.length - 1];
  if (last && 'text' in last) last.text += text;
  else out.push({ text });
}

/** Leading and trailing whitespace of a paragraph or heading is not content. */
function trimEdges(nodes: PNode[]): PNode[] {
  const first = nodes[0];
  if (first && 'text' in first) first.text = first.text.replace(/^\s+/, '');
  const last = nodes[nodes.length - 1];
  if (last && 'text' in last) last.text = last.text.replace(/\s+$/, '');
  return nodes.filter((n) => !('text' in n) || n.text !== '');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', times: '×', divide: '÷', deg: '°', plusmn: '±', middot: '·', bull: '•',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', laquo: '«', raquo: '»', check: '✓', hearts: '♥',
};

/**
 * Entities decode to text, which is then set as `textContent`, so an `&lt;`
 * can never become a tag. Named entities are a short common list; an unknown
 * one stays as typed.
 */
export function decodeEntity(entity: string): string {
  const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(entity);
  if (numeric) {
    const raw = numeric[1]!;
    const code = raw[0] === 'x' || raw[0] === 'X' ? parseInt(raw.slice(1), 16) : parseInt(raw, 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '�';
  }
  const named = ENTITIES[entity.slice(1, -1)];
  return named ?? entity;
}
