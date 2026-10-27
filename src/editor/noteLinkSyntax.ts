/**
 * `[[Note links]]` as Markdown syntax: one `@lezer/markdown` inline parser,
 * shared by the editor's grammar and the preview's.
 *
 * What counts as a link is decided once, in `core/notes/links.ts`; this module
 * only finds the brackets and asks `parseLinkBody`, so the editor can never
 * highlight something the preview will not render as a link.
 *
 * ## Why a grammar node and not a MatchDecorator
 *
 * `#tags` are a `MatchDecorator` over the visible lines (`hashtags.ts`), and the
 * same shape was the obvious first answer here. It does not work, because the
 * *preview* needs the same syntax and the preview has no decorations — it walks
 * a tree. And a regex cannot be the answer on that side: `@lezer/markdown`
 * already claims the inner brackets of `[[Some Note]]` as an unresolved `Link`
 * (verified: `See [[Some Note]] here.` parses to `Link@5-16`, with the outer
 * brackets left as prose), so the preview's plain-text pass never sees the text
 * a regex would need. An inline parser installed `before: 'Link'` claims the
 * whole `[[…]]` first, and both sides read the same node.
 *
 * ## Two parsers, one extension
 *
 * `noteLinks` is added to **two** `baseParser.configure` calls — `markdownLean.ts`
 * and `preview/model.ts` — because each builds its own parser for its own
 * reasons (the editor needs fold and language-data props the preview has no use
 * for). Adding it to one and not the other is silent: the editor would colour a
 * link the preview rendered as brackets, or worse the other way round.
 * `tests/unit/noteLinks.test.ts` parses the same string with both parsers and
 * asserts both find the node, which is the only guard against that drift.
 *
 * ## Why this is its own file
 *
 * It is the half of the feature the **share viewer** downloads, so it may import
 * `@lezer/*` and nothing else. The completion and the ⌘-click live in
 * `wikiLink.ts`, which reaches `@codemirror/language` and `@codemirror/view` —
 * and a static import of those from anything the preview touches is the 87 KB
 * regression `preview/render.ts` has a comment about. `bench:size` would catch
 * it, and there is no reason to make it do so.
 *
 * ## Cost (§7)
 *
 * The parser is offered a position per candidate character and returns -1 on its
 * first line for anything that is not `[[`. The scan for `]]` is bounded by
 * `MAX_LINK_TARGET` and by the end of the line, so a note full of `[` costs a
 * constant per bracket and a document scan is not reachable. Highlighting is the
 * node's own style tag, so it costs nothing beyond the parse already happening.
 */
import type { MarkdownConfig } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';
import { MAX_LINK_TARGET, parseLinkBody } from '../core/notes/links.ts';

const BRACKET_OPEN = 91; // [
const BRACKET_CLOSE = 93; // ]
const NEWLINE = 10;

/** The node name both parsers and the preview agree on. */
export const NOTE_LINK = 'NoteLink';

/**
 * `[[target]]` / `[[target|label]]` as one inline node.
 *
 * `t.link` and `t.processingInstruction` already have rules in
 * `markdownHighlight` (`theme.ts`), so the editor highlight comes for free:
 * accent-coloured text with the brackets and the bar receding, exactly like
 * every other Markdown construct's marks.
 */
export const noteLinks: MarkdownConfig = {
  defineNodes: [
    { name: NOTE_LINK, style: t.link },
    { name: 'NoteLinkMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: NOTE_LINK,
      // Ahead of the standard link parser, which would otherwise claim the
      // inner `[…]` and leave nothing here to match.
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN || cx.char(pos + 1) !== BRACKET_OPEN) return -1;

        const bodyFrom = pos + 2;
        // +1 so a body of exactly MAX_LINK_TARGET can still find its closer.
        const limit = Math.min(cx.end, bodyFrom + MAX_LINK_TARGET + 1);
        let close = -1;
        for (let at = bodyFrom; at < limit; at++) {
          const ch = cx.char(at);
          // A link is a label, not a paragraph.
          if (ch === NEWLINE) return -1;
          if (ch === BRACKET_CLOSE && cx.char(at + 1) === BRACKET_CLOSE) {
            close = at;
            break;
          }
        }
        if (close < 0) return -1;

        const body = cx.slice(bodyFrom, close);
        // The single decision point. A rejection returns -1 rather than an
        // element, so `[[a[b]]` and `[[]]` fall through to the ordinary link
        // parser and render as the brackets they always did.
        if (!parseLinkBody(body)) return -1;

        const to = close + 2;
        const marks = [cx.elt('NoteLinkMark', pos, bodyFrom)];
        const bar = body.indexOf('|');
        if (bar >= 0) marks.push(cx.elt('NoteLinkMark', bodyFrom + bar, bodyFrom + bar + 1));
        marks.push(cx.elt('NoteLinkMark', close, to));
        return cx.addElement(cx.elt(NOTE_LINK, pos, to, marks));
      },
    },
  ],
};
