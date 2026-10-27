/**
 * Markdown formatting shortcuts.
 *
 * The chords are the ones people already have in their fingers, so none of
 * them needs learning: `Mod-b`/`Mod-i`/`Mod-k` are universal, `Mod-Shift-x`
 * is strikethrough in GitHub, Notion and Slack, `Mod-Alt-1…6` are headings in
 * Google Docs and Word, `Mod-Shift-7/8/9` are numbered, bulleted and checklist
 * in Google Docs, `Mod-Shift-.` is quote in GitHub, and `Mod-Enter` ticks a
 * task in Obsidian and Notion.
 *
 * Several obvious chords are deliberately absent:
 *
 * - `Mod-1…6` switch browser tabs, and a page cannot take them back.
 * - `Mod-Alt-0` ("normal text" in Google Docs) would also reset the text size:
 *   the window handler in `App.svelte` matches any Mod+0 and ignores Alt. The
 *   same heading level pressed again removes the heading instead.
 * - `Mod-Shift-l`, `Mod-Shift-k` and `Mod-/` are CodeMirror's select-matches,
 *   delete-line and comment; `Mod-Shift-c` opens DevTools; `Mod-Shift--` would
 *   shrink the text through the same window handler.
 *
 * `Mod-i` displaces CodeMirror's `selectParentSyntax`, which no Markdown
 * editor user reaches for; italic is what the chord means everywhere else.
 *
 * Known limit: CodeMirror ignores Ctrl+Alt chords on Windows when they type a
 * character, because that is AltGr. On a German layout `Ctrl-Alt-2` types `²`
 * rather than making a heading. That is the right way round — breaking a
 * layout's characters to win a shortcut would be worse.
 *
 * Every transform is a pure `*Spec(state)` function, so it is tested against
 * EditorState without a DOM, and every one goes through a single transaction
 * so it is one undo step and respects multiple cursors.
 */
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, type Command } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { LIST_ITEM } from './markdownKeys.ts';

/** Wrap a pure spec builder as a command; `null` means "not mine, fall through". */
function command(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = build(view.state);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

// --- Inline markers ---------------------------------------------------------

/** A marker is one character repeated: `*`, `**`, `_`, `~~`. */
interface Marker {
  char: string;
  size: number;
}

const BOLD: Marker[] = [{ char: '*', size: 2 }, { char: '_', size: 2 }];
// `*` rather than `_` for new italics: an underscore does not emphasise inside
// a word in CommonMark, so wrapping part of a word with it would do nothing.
const ITALIC: Marker[] = [{ char: '*', size: 1 }, { char: '_', size: 1 }];
const STRIKE: Marker[] = [{ char: '~', size: 2 }];

/**
 * Whether a run of `run` marker characters closes `marker`. A run of three is
 * bold *and* italic, so either toggle may take its share of it; a run of two
 * is only bold, which is what stops Mod-i from eating half of a `**`.
 */
function runMatches(run: number, marker: Marker): boolean {
  return run === marker.size || run === 3;
}

function runBefore(state: EditorState, pos: number, char: string): number {
  let n = 0;
  while (pos - n > 0 && state.sliceDoc(pos - n - 1, pos - n) === char) n++;
  return n;
}

function runAfter(state: EditorState, pos: number, char: string): number {
  const end = state.doc.length;
  let n = 0;
  while (pos + n < end && state.sliceDoc(pos + n, pos + n + 1) === char) n++;
  return n;
}

function leadingRun(text: string, char: string): number {
  let n = 0;
  while (n < text.length && text[n] === char) n++;
  return n;
}

function trailingRun(text: string, char: string): number {
  let n = 0;
  while (n < text.length && text[text.length - 1 - n] === char) n++;
  return n;
}

interface Toggled {
  changes: ChangeSpec[];
  from: number;
  to: number;
  /** Where a position inside the original range ends up. */
  map: (pos: number) => number;
}

function toggleRange(state: EditorState, from: number, to: number, markers: Marker[]): Toggled {
  const text = state.sliceDoc(from, to);

  for (const marker of markers) {
    const { char, size } = marker;

    // Markers selected along with the text: `[**bold**]`.
    const lead = leadingRun(text, char);
    const trail = trailingRun(text, char);
    if (lead + trail <= text.length && lead >= size && trail >= size &&
        runMatches(lead, marker) && runMatches(trail, marker)) {
      return {
        changes: [{ from, to: from + size }, { from: to - size, to }],
        from,
        to: to - 2 * size,
        map: (pos) => Math.min(Math.max(pos - size, from), to - 2 * size),
      };
    }

    // Markers just outside the selection: `**[bold]**`.
    const before = runBefore(state, from, char);
    const after = runAfter(state, to, char);
    if (before >= size && after >= size && runMatches(before, marker) && runMatches(after, marker)) {
      return {
        changes: [{ from: from - size, to: from }, { from: to, to: to + size }],
        from: from - size,
        to: to - size,
        map: (pos) => pos - size,
      };
    }
  }

  const mark = markers[0]!.char.repeat(markers[0]!.size);
  return {
    changes: [{ from, insert: mark }, { from: to, insert: mark }],
    from: from + mark.length,
    to: to + mark.length,
    map: (pos) => pos + mark.length,
  };
}

export function toggleInlineSpec(state: EditorState, markers: Marker[]): TransactionSpec {
  const spec = state.changeByRange((range) => {
    if (!range.empty) {
      const t = toggleRange(state, range.from, range.to, markers);
      return { changes: t.changes, range: EditorSelection.range(t.from, t.to) };
    }

    const pos = range.head;

    // An empty pair left by a previous press: take it back out.
    for (const { char, size } of markers) {
      const mark = char.repeat(size);
      if (state.sliceDoc(pos - size, pos) === mark && state.sliceDoc(pos, pos + size) === mark) {
        return {
          changes: { from: pos - size, to: pos + size },
          range: EditorSelection.cursor(pos - size),
        };
      }
    }

    // Strictly inside a word, the word is the obvious target. At its edge the
    // user is more likely starting new formatted text than restyling the word
    // they just typed, so that case opens an empty pair instead.
    const word = state.wordAt(pos);
    if (word && word.from < pos && pos < word.to) {
      const t = toggleRange(state, word.from, word.to, markers);
      return { changes: t.changes, range: EditorSelection.cursor(t.map(pos)) };
    }

    const mark = markers[0]!.char.repeat(markers[0]!.size);
    return {
      changes: { from: pos, insert: mark + mark },
      range: EditorSelection.cursor(pos + mark.length),
    };
  });
  return { ...spec, scrollIntoView: true, userEvent: 'input' };
}

export const toggleBold = command((state) => toggleInlineSpec(state, BOLD));
export const toggleItalic = command((state) => toggleInlineSpec(state, ITALIC));
export const toggleStrikethrough = command((state) => toggleInlineSpec(state, STRIKE));

// --- Links ------------------------------------------------------------------

const URL_ONLY = /^(?:https?:\/\/|mailto:)\S+$/i;

export function isUrl(text: string): boolean {
  return URL_ONLY.test(text.trim());
}

/**
 * `[selection](│)`, or `[│](url)` when what is selected is already a URL, or
 * `[│]()` with nothing selected — the cursor lands in the half that still
 * needs typing, text first.
 */
export function insertLinkSpec(state: EditorState): TransactionSpec {
  const spec = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (text.length > 0 && isUrl(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text.trim()})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.empty ? range.from + 1 : range.from + insert.length - 1),
    };
  });
  return { ...spec, scrollIntoView: true, userEvent: 'input' };
}

export const insertLink = command(insertLinkSpec);

// --- Line prefixes ----------------------------------------------------------

/**
 * Every line any selection range touches, once each. A range that ends at the
 * very start of a line — what a triple-click or a shift-down produces — does
 * not claim that line.
 */
function touchedLines(state: EditorState): Line[] {
  const seen = new Map<number, Line>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) if (!seen.has(n)) seen.set(n, state.doc.line(n));
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/**
 * Apply per-line prefix edits and keep each cursor after an inserted prefix
 * rather than stranded in front of it.
 */
function prefixSpec(state: EditorState, changes: ChangeSpec[]): TransactionSpec {
  const set = state.changes(changes);
  return {
    changes: set,
    selection: state.selection.map(set, 1),
    scrollIntoView: true,
    userEvent: 'input',
  };
}

/** Lines to act on: the non-blank ones, unless every touched line is blank. */
function targetLines(state: EditorState): Line[] {
  const lines = touchedLines(state);
  const filled = lines.filter((line) => line.text.trim().length > 0);
  return filled.length > 0 ? filled : lines;
}

const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/** Set a heading level; pressing the level a line already has removes it. */
export function setHeadingSpec(state: EditorState, level: number): TransactionSpec {
  const lines = targetLines(state);
  const already = lines.every((line) => HEADING.exec(line.text)?.[2]!.length === level);

  const changes = lines.map((line) => {
    const match = HEADING.exec(line.text);
    const indent = match ? match[1]!.length : /^ {0,3}/.exec(line.text)![0].length;
    const end = match ? match[0].length : indent;
    return {
      from: line.from + indent,
      to: line.from + end,
      insert: already ? '' : `${'#'.repeat(level)} `,
    };
  });
  return prefixSpec(state, changes);
}

export const setHeading = (level: number): Command =>
  command((state) => setHeadingSpec(state, level));

export type ListKind = 'bullet' | 'ordered' | 'task';

interface ListInfo {
  kind: ListKind;
  indent: string;
  bullet: string | undefined;
  /** Length of indent, marker and checkbox together. */
  prefix: number;
}

function listInfo(text: string): ListInfo | null {
  const match = LIST_ITEM.exec(text);
  if (!match) return null;
  const [, indent, bullet, num, , , task, content] = match;
  return {
    kind: task ? 'task' : num ? 'ordered' : 'bullet',
    indent: indent!,
    bullet,
    prefix: text.length - content!.length,
  };
}

/**
 * Toggle a list kind over the selected lines. If they are all that kind
 * already the markers come off; otherwise every line becomes that kind,
 * replacing whatever marker it had, so bullets turn into tasks in one press.
 */
export function toggleListSpec(state: EditorState, kind: ListKind): TransactionSpec {
  const lines = targetLines(state);
  const infos = lines.map((line) => listInfo(line.text));
  const already = infos.every((info) => info?.kind === kind);

  let number = 0;
  const changes = lines.map((line, i) => {
    const info = infos[i];
    const indent = info ? info.indent : /^\s*/.exec(line.text)![0];
    let insert = '';
    if (!already) {
      const bullet = info?.bullet ?? '-';
      insert =
        kind === 'bullet' ? `${bullet} ` : kind === 'task' ? `${bullet} [ ] ` : `${++number}. `;
    }
    return {
      from: line.from + indent.length,
      to: line.from + (info ? info.prefix : indent.length),
      insert,
    };
  });
  return prefixSpec(state, changes);
}

export const toggleList = (kind: ListKind): Command =>
  command((state) => toggleListSpec(state, kind));

const QUOTED = /^(\s*)> ?/;

export function toggleQuoteSpec(state: EditorState): TransactionSpec {
  const lines = touchedLines(state);
  const filled = lines.filter((line) => line.text.trim().length > 0);
  const already = (filled.length > 0 ? filled : lines).every((line) => QUOTED.test(line.text));

  const changes = lines.flatMap((line): ChangeSpec[] => {
    const blank = line.text.trim().length === 0;
    if (already) {
      const match = QUOTED.exec(line.text);
      return match
        ? [{ from: line.from + match[1]!.length, to: line.from + match[0].length }]
        : [];
    }
    // A blank line inside the selection gets a bare `>` so the quote stays one
    // block instead of splitting in two.
    if (blank && lines.length > 1) return [{ from: line.from, insert: '>' }];
    const indent = /^\s*/.exec(line.text)![0].length;
    return [{ from: line.from + indent, insert: '> ' }];
  });
  return prefixSpec(state, changes);
}

export const toggleQuote = command(toggleQuoteSpec);

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

/** Tick or untick the task on each selected line; null when there is none. */
export function toggleTaskSpec(state: EditorState): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  for (const line of touchedLines(state)) {
    const match = TASK.exec(line.text);
    if (!match) continue;
    const at = line.from + match[1]!.length + 1;
    changes.push({ from: at, to: at + 1, insert: match[2] === ' ' ? 'x' : ' ' });
  }
  if (changes.length === 0) return null;
  return { changes, userEvent: 'input' };
}

/** Mod-Enter: falls through to CodeMirror's insert-blank-line off a task. */
export const toggleTask = command(toggleTaskSpec);

/**
 * Tick or untick the task whose `[ ]` begins at `at` — the preview's route in,
 * where the click names a position rather than a selection.
 *
 * `at` comes from a rendering of the text that may be up to a second old, so it
 * is checked rather than trusted: the line has to be a task item whose marker
 * starts exactly there. A stale offset ticks nothing and says so, which is why
 * the caller gets a boolean.
 *
 * `isolateHistory` keeps each tick its own undo step. Without it a tick within
 * the history's grouping window of a keystroke would be undone along with the
 * typing, and the preview's user never saw that typing happen.
 */
export function toggleTaskAtSpec(state: EditorState, at: number): TransactionSpec | null {
  if (at < 0 || at > state.doc.length) return null;
  const line = state.doc.lineAt(at);
  const match = TASK.exec(line.text);
  if (!match || line.from + match[1]!.length !== at) return null;
  return {
    changes: { from: at + 1, to: at + 2, insert: match[2] === ' ' ? 'x' : ' ' },
    annotations: isolateHistory.of('full'),
    userEvent: 'input',
  };
}

// --- Without a shortcut -----------------------------------------------------

/**
 * Marks that wrap a selection rather than replacing it. Symmetric, every one
 * of them — the same character opens and closes.
 *
 * `'` is here and nowhere else. `closeBrackets` (`setup.ts`) owns `(`, `[`,
 * `{` and `"` and wraps a selection in them itself, but the prose bracket set
 * in `markdownLean.ts` leaves `'` out so that `don't` survives being typed.
 * This handler only ever fires on a *non-empty* selection, so it can give the
 * apostrophe back its quoting job without giving back the bug.
 */
const WRAPPERS = new Set(['`', '*', '_', '~', "'"]);

/** Wrap each selection in `mark`, keeping the text selected so a second press doubles it. */
export function wrapSelectionSpec(state: EditorState, mark: string): TransactionSpec {
  const spec = state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: mark },
      { from: range.to, insert: mark },
    ],
    range: EditorSelection.range(range.anchor + mark.length, range.head + mark.length),
  }));
  return { ...spec, userEvent: 'input.type' };
}

/**
 * Typing `` ` ``, `*`, `_`, `~` or `'` over a selection wraps it instead of
 * replacing it, as Typora, Obsidian and VS Code do. Only when every range has
 * text selected: a lone cursor types the character as usual.
 *
 * Registered ahead of `closeBrackets()`, which wraps a selection in its own
 * set the same way. Input handlers run in extension order and the first to
 * return true wins, so the two never both fire — and they agree on the result
 * for any character they shared, which today is none.
 */
export const wrapSelectionInput = EditorView.inputHandler.of((view, _from, _to, text) => {
  const { state } = view;
  if (!WRAPPERS.has(text) || state.readOnly) return false;
  if (state.selection.ranges.some((range) => range.empty)) return false;
  view.dispatch(wrapSelectionSpec(state, text));
  return true;
});

/** `[selection](url)`, or null when the paste is not a URL over plain text. */
export function linkPasteSpec(state: EditorState, pasted: string): TransactionSpec | null {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || range.empty) return null;
  const text = state.sliceDoc(range.from, range.to);
  // Replacing one URL with another is an ordinary paste.
  if (text.includes('\n') || isUrl(text) || !isUrl(pasted)) return null;

  const insert = `[${text}](${pasted.trim()})`;
  return {
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    scrollIntoView: true,
    userEvent: 'input.paste',
  };
}

/**
 * Pasting a URL over selected text makes a link (GitHub, Notion, Obsidian).
 * Reads `clipboardData` off the real paste event, as `fenceKeys.ts` does, so
 * there is no clipboard permission prompt and nothing async.
 */
export const linkPasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const pasted = event.clipboardData?.getData('text/plain');
    if (!pasted || view.state.readOnly) return false;
    const spec = linkPasteSpec(view.state, pasted);
    if (!spec) return false;
    event.preventDefault();
    view.dispatch(spec);
    return true;
  },
});
