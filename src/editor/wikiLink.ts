/**
 * `[[Note links]]` in the editor: completion after `[[`, and following one.
 *
 * The syntax itself is `noteLinkSyntax.ts` — a separate module because the share
 * viewer downloads that half and must not download this one, which reaches
 * `@codemirror/language` and `@codemirror/view`. What counts as a link is
 * decided further down still, in `core/notes/links.ts`.
 *
 * ## Cost (§7)
 *
 * The completion source is gated the way `hashtags.ts` and
 * `languageCompletion.ts` are: one `matchBefore` against the text left of the
 * cursor, and null for everything that is not `[[`. Nothing here runs on an
 * ordinary keystroke. The click handler costs one `resolveInner`, and only on a
 * ⌘-click.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { parseLinkBody, type NoteLink } from '../core/notes/links.ts';
import type { NoteMeta } from '../core/notes/model.ts';
import { NOTE_LINK } from './noteLinkSyntax.ts';
import { inCode } from './prose.ts';

/** The link whose `[[…]]` covers `pos`, or null. */
export function linkAt(state: EditorState, pos: number): NoteLink | null {
  for (let node = syntaxTree(state).resolveInner(pos, 0); ; node = node.parent!) {
    // The brackets are the node's own, not note text, so slicing them off is
    // safe — and it hands `parseLinkBody` exactly what the parser gave it.
    if (node.name === NOTE_LINK) return parseLinkBody(state.sliceDoc(node.from + 2, node.to - 2));
    if (!node.parent) return null;
  }
}

/**
 * ⌘/Ctrl-click a link to open it.
 *
 * **This modifier is not free, and the trade is deliberate.**
 * `EditorView.clickAddsSelectionRange` defaults to `metaKey` on a Mac and
 * `ctrlKey` elsewhere, so ⌘-click already means "add a cursor here" — and Alt is
 * no way out, because `rectangularSelection` and `crosshairCursor` own it and
 * the crosshair would promise a rectangular select that never happens.
 *
 * So the handler is as narrow as it can be: it takes the event **only** when the
 * click lands inside a `NoteLink`, which is VS Code's own split — ⌘-click a
 * symbol goes to it, ⌘-click prose adds a cursor. Every ordinary multi-cursor
 * click is untouched, because `linkAt` returns null and the handler returns
 * false before it has touched the event.
 *
 * There is a keyboard route too, and it is not here: `follow-link` in
 * `ui/shortcuts.ts` reaches `linkAt` through `Editor.svelte`, so the command
 * lands in the palette, the ⌘J hint sheet and the phone's More sheet — where a
 * ⌘-click does not exist at all. The touch route is `linkChip.ts`: a tap that
 * lands the caret in a link offers to follow it, and it skips modified clicks
 * so this handler and the chip never both fire.
 */
export function noteLinkClick(onOpenLink: (target: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const link = linkAt(view.state, pos);
      if (!link) return false;
      event.preventDefault();
      onOpenLink(link.target);
      return true;
    },
  });
}

/** Everything the target half of a link may hold; also the completion's gate. */
const TARGET_SLOT = /\[\[[^[\]|\n]*/u;

/** How many titles the popup will show. */
const MAX_OPTIONS = 50;

/**
 * Titles offered after `[[`.
 *
 * A factory over a getter, like `hashtagCompletion` and for the same reason:
 * `Editor.svelte` caches one `EditorState` per note, so the live list has to be
 * read when the popup opens rather than baked into a configuration only the
 * mounted state would ever see.
 *
 * Two departures from the tag source. The match stops at `|`, so typing an alias
 * label does not reopen a list of titles that cannot go there. And the options
 * are **capped and pre-filtered here** (`filter: false`), because handing
 * CodeMirror a 50-title slice of a 10,000-note vault and letting it narrow that
 * would rank inside the slice instead of re-ranking the vault.
 */
export function wikiLinkCompletion(titleSource: () => readonly NoteMeta[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(TARGET_SLOT);
    if (!match) return null;
    if (inCode(context.state, match.from)) return null;

    const typed = context.state.sliceDoc(match.from + 2, match.to).trim().toLowerCase();
    const prefix: NoteMeta[] = [];
    const rest: NoteMeta[] = [];
    for (const meta of titleSource()) {
      const lower = meta.title.toLowerCase();
      // The cheap test first: this runs per keystroke over every note in the
      // vault while the popup is open, and `bench:scale` holds the whole of it
      // to the keystroke budget at 10,000 notes.
      if (!typed) rest.push(meta);
      else if (lower.startsWith(typed)) prefix.push(meta);
      else if (lower.includes(typed)) rest.push(meta);
      if (prefix.length >= MAX_OPTIONS) break;
    }
    // Prefix matches lead; within each group the caller's order stands, and
    // `metas` is in recency order, so the most recently edited title wins a tie.
    const picked = [...prefix, ...rest].slice(0, MAX_OPTIONS);
    if (picked.length === 0) return null;

    const options: Completion[] = picked.map((meta) => ({
      label: meta.title,
      type: 'text',
      apply: applyTitle(meta.title),
    }));
    return { from: match.from + 2, to: match.to, options, filter: false };
  };
}

/**
 * What to insert for `title`, and where the caret goes, given whether the two
 * characters after the replaced range are already `]]`.
 *
 * `closeBrackets` has usually supplied them — `[` is in `markdownLean.ts`'s
 * bracket set, so typing `[[` leaves `[[|]]` — but a pasted or hand-repaired
 * `[[` has no closer, and a completion that produced `[[Title` would be a link
 * the parser refuses. Either way the caret lands **after** the `]]`, because the
 * next thing anyone types is prose, not more of the title.
 *
 * Pure and exported so it can be tested without a DOM, the way `formatKeys.ts`
 * splits every transform into a spec and a thin command over it. `caret` is an
 * offset from the start of the replaced range.
 */
export function linkInsertion(title: string, closed: boolean): { insert: string; caret: number } {
  const insert = closed ? title : `${title}]]`;
  return { insert, caret: insert.length + (closed ? 2 : 0) };
}

function applyTitle(title: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const { insert, caret } = linkInsertion(title, view.state.sliceDoc(to, to + 2) === ']]');
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + caret },
      userEvent: 'input.complete',
    });
  };
}
