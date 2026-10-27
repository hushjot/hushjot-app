/**
 * Inline `#tags` in the editor: a highlight, and completion from tags already
 * in use.
 *
 * What counts as a tag is decided once, in `core/notes/tags.ts`; this module
 * only finds candidates with the same pattern and asks `normaliseTag`, so the
 * editor never colours something the sidebar will not list.
 *
 * ## Cost (§7)
 *
 * The highlight is a `MatchDecorator`, which scans only the visible lines and,
 * on an edit, only the lines the edit touched. The syntax tree is consulted
 * per *match*, to leave code alone, and most lines have no `#` to match. The
 * one full re-scan is for an edit that inserts or removes a backtick or tilde,
 * because opening a fence changes the meaning of every line below it without
 * touching them.
 *
 * Completion is gated the way `languageCompletion.ts` is: one `matchBefore`
 * against the text left of the cursor, and null for everything that is not a
 * `#` followed by at least one character. A bare `#` does not open it — that
 * is how a heading starts, and a list popping up under every `## ` would be
 * noise. Tag names come from the caller (`tagSource`); the editor does no I/O.
 */
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { normaliseTag, type Tag } from '../core/notes/tags.ts';
// Shared with `wikiLink.ts`, which asks the same question for the same reason.
import { inCode } from './prose.ts';

const tagMark = Decoration.mark({ class: 'cm-hashtag' });

const decorator = new MatchDecorator({
  // `TAG_PATTERN`'s shape, with the `#` inside the captured group.
  regexp: /(^|\s)(#[\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu,
  decorate(add, from, _to, match, view) {
    const body = match[2]!.slice(1);
    const label = normaliseTag(body);
    if (!label) return;
    const start = from + match[1]!.length;
    if (inCode(view.state, start)) return;
    // The label may be shorter than the match (`#done/` is `done`), but the
    // characters it keeps are always a prefix of it unless `//` collapsed.
    const length = body.startsWith(label) ? label.length : body.length;
    add(start, start + 1 + length, tagMark);
  },
});

function touchesFence(update: ViewUpdate): boolean {
  let found = false;
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (found) return;
    const removed = update.startState.sliceDoc(fromA, toA);
    const added = inserted.toString();
    found = /[`~]/.test(removed) || /[`~]/.test(added);
  });
  return found;
}

export const hashtagHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorator.createDeco(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged && touchesFence(update)) {
        this.decorations = decorator.createDeco(update.view);
      } else {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** What may follow without re-running the source. */
const VALID_FOR = /^[\p{L}\p{N}_/-]*$/u;

export function hashtagCompletion(tagSource: () => readonly Tag[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (!match || (match.to - match.from < 2 && !context.explicit)) return null;
    // Only at a line start or after whitespace, as a tag has to be.
    if (match.from > 0 && !/\s/.test(context.state.sliceDoc(match.from - 1, match.from))) return null;
    if (inCode(context.state, match.from)) return null;

    const tags = tagSource();
    if (tags.length === 0) return null;
    const options: Completion[] = tags.map((tag) => ({ label: tag.label, type: 'text' }));
    return { from: match.from + 1, options, validFor: VALID_FOR };
  };
}
