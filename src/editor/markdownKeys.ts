/**
 * Markdown editing conveniences.
 *
 * `@codemirror/lang-markdown` ships these, but importing them would drag in the
 * `lang-html` → `lang-css`/`lang-javascript` chain that Phase 0 measured at
 * +67 KB on the critical path. They are short enough to own.
 *
 * Behaviour matches what every Markdown editor does: Enter inside a list item
 * continues the list; Enter on an *empty* item ends it instead of stranding a
 * dangling marker.
 */
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';

/** `- `, `* `, `+ `, `- [ ] `, `- [x] `, `1. `, `1) `. Shared with `formatKeys.ts`. */
export const LIST_ITEM =
  /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;
const BLOCKQUOTE = /^(\s*)(>\s?)(.*)$/;

interface Continuation {
  /** Text to insert on the new line, e.g. `- ` or `3. `. */
  prefix: string;
  /** True when the current item has no content, so Enter should clear it. */
  empty: boolean;
  /** Range of the existing marker, used when clearing an empty item. */
  markerFrom: number;
  markerTo: number;
}

function analyse(state: EditorState, pos: number): Continuation | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;

  const list = LIST_ITEM.exec(text);
  if (list) {
    const [, indent, bullet, num, delim, space, task, content] = list;
    const marker = bullet
      ? `${bullet}${space}`
      : `${Number(num) + 1}${delim}${space}`;
    // A task item continues as an unchecked task, never pre-ticked.
    const prefix = `${indent}${marker}${task ? '[ ] ' : ''}`;
    return {
      prefix,
      empty: content!.trim().length === 0,
      markerFrom: line.from,
      markerTo: line.to,
    };
  }

  const quote = BLOCKQUOTE.exec(text);
  if (quote) {
    const [, indent, mark, content] = quote;
    return {
      prefix: `${indent}${mark}`,
      empty: content!.trim().length === 0,
      markerFrom: line.from,
      markerTo: line.to,
    };
  }

  return null;
}

/**
 * Enter: continue the current list item or blockquote. Falls through to the
 * default newline behaviour when the cursor is not in one, so this is safe to
 * bind ahead of `defaultKeymap`.
 */
export const continueMarkupOnEnter: Command = (view) => {
  const { state } = view;
  let handled = false;

  const spec = state.changeByRange((range) => {
    if (!range.empty) return { range };

    const cont = analyse(state, range.head);
    if (!cont) return { range };

    handled = true;

    if (cont.empty) {
      // Empty item: strip the marker and leave the cursor on a blank line,
      // which is how a user signals "I'm done with this list".
      return {
        changes: { from: cont.markerFrom, to: cont.markerTo, insert: '' },
        range: EditorSelection.cursor(cont.markerFrom),
      };
    }

    const insert = `\n${cont.prefix}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });

  if (!handled) return insertNewlineAndIndent(view);

  view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
  return true;
};
