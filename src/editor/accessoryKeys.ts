/**
 * The commands behind the phone's Markdown key bar.
 *
 * A phone keyboard makes `#`, `**`, `` ` `` and `[](…)` genuinely expensive to
 * type — they are two or three layout switches each — which is why the bar
 * exists at all. What it is *not* is new editing logic: every entry below is
 * a command the desktop keymap already binds and `tests/unit/formatKeys.ts`
 * and `fenceKeys.ts` already cover. The bar is wiring.
 *
 * It maps plain string ids rather than exposing CodeMirror types, so
 * `src/ui/mobile/KeyBar.svelte` can import the id union with `import type` and
 * carry no editor code into the phone chunk.
 */
import type { Command } from '@codemirror/view';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { indentLess, indentMore, redo, undo } from '@codemirror/commands';
import {
  insertLink,
  setHeadingSpec,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleQuote,
} from './formatKeys.ts';
import { insertCodeFence } from './fenceKeys.ts';
import { tableInsertRow } from './tableKeys.ts';

export type AccessoryId =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'bullet'
  | 'task'
  | 'quote'
  | 'link'
  | 'fence'
  | 'indent'
  | 'outdent'
  | 'undo'
  | 'redo'
  | 'tableRow';

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

/**
 * One button for every heading level: 1 → 2 → 3 → plain.
 *
 * The desktop binds six chords (⌘⌥1..6) because it has six free chords. A bar
 * does not have room for six 44px buttons that are almost never the one you
 * want, and levels past three are rare in a note, so this cycles the three
 * that are common and then clears. `setHeadingSpec` already removes the level
 * a line is on when it is set again, which is what makes the last step work.
 */
export function nextHeadingLevel(lineText: string): number {
  const current = HEADING.exec(lineText)?.[1]!.length ?? 0;
  // At 3 (or deeper) the next press asks for the level the line already has,
  // which `setHeadingSpec` reads as "remove it".
  return current >= 3 ? current : current + 1;
}

/** The state half, so it is testable without a DOM like the rest of the editor. */
export function cycleHeadingSpec(state: EditorState): TransactionSpec {
  const line = state.doc.lineAt(state.selection.main.head);
  return setHeadingSpec(state, nextHeadingLevel(line.text));
}

const cycleHeading: Command = (view) => {
  if (view.state.readOnly) return false;
  view.dispatch(cycleHeadingSpec(view.state));
  return true;
};

const COMMANDS: Record<AccessoryId, Command> = {
  heading: cycleHeading,
  bold: toggleBold,
  italic: toggleItalic,
  bullet: toggleList('bullet'),
  task: toggleList('task'),
  quote: toggleQuote,
  link: insertLink,
  fence: insertCodeFence,
  indent: indentMore,
  outdent: indentLess,
  undo,
  redo,
  // Mod-Enter on a desktop. Shown only while the cursor is in a table, since
  // a phone's Enter already means "next row" there and nothing else inserts
  // one mid-table.
  tableRow: tableInsertRow,
};

export function accessoryCommand(id: AccessoryId): Command {
  return COMMANDS[id];
}
