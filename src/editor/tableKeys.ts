/**
 * Markdown tables: moving between cells, keeping columns aligned, and inserting
 * a new table.
 *
 * Tab and Shift-Tab step through cells and Enter steps down a row, adding rows
 * at the end, as Obsidian's Advanced Tables and Typora do. Every one of those
 * moves re-aligns the table first. Alignment happens *only* on those keys, never
 * as a side effect of typing, so the keystroke path stays untouched (§7) — the
 * cost is one table's worth of string padding when the user asks to move.
 *
 * "Am I in a table?" is answered by the syntax tree, not a regex over the line.
 * A line full of pipes inside a code fence is not a table, and a line with no
 * leading pipe can be one; the parser already knows both.
 *
 * Cell splitting follows `@lezer/markdown`'s own `parseRow` exactly: a pipe is
 * a boundary unless backslash-escaped, *including inside a code span*. That is
 * what GFM specifies and what the preview renders, so splitting any other way
 * would re-align a table into a shape the preview disagrees with.
 *
 * Every command returns false outside a table, which is what lets Tab still
 * indent and Enter still continue lists everywhere else.
 *
 * The size picker is a separate lazy chunk (`tablePicker.ts`): it is DOM and
 * styling that nobody needs until they ask for a table.
 */
import {
  EditorSelection,
  StateEffect,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { Command, EditorView } from '@codemirror/view';

export type Align = 'left' | 'center' | 'right' | null;

export interface TableModel {
  /** Text before the table on each line: indentation or a `> ` quote marker. */
  prefix: string;
  header: string[];
  aligns: Align[];
  rows: string[][];
}

/** Split one row into trimmed cells, dropping the optional edge pipes. */
export function splitRow(text: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 124 /* | */ && !escaped) {
      cells.push(text.slice(start, i));
      start = i + 1;
    }
    escaped = !escaped && ch === 92; /* \ */
  }
  cells.push(text.slice(start));

  if (cells.length > 1 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** The column the offset `at` in a row falls in, counting unescaped pipes. */
export function cellIndexAt(text: string, at: number): number {
  let pipes = 0;
  let escaped = false;
  for (let i = 0; i < at && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 124 && !escaped) pipes++;
    escaped = !escaped && ch === 92;
  }
  return text.trimStart().startsWith('|') ? Math.max(0, pipes - 1) : pipes;
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':') && cell.length > 1;
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/**
 * Display width in code points. Wide CJK characters take two columns in a
 * monospace font, so a table of them will look slightly ragged — it is still
 * correct Markdown, and a width table is not worth its bytes here.
 */
function width(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function columnCount(model: TableModel): number {
  return Math.max(1, model.header.length, model.aligns.length, ...model.rows.map((r) => r.length));
}

export interface FormattedTable {
  lines: string[];
  /** Per line, the code-unit offset where each cell's text starts. */
  starts: number[][];
  /** Per line, each cell's text, so a caller can select it. */
  cells: string[][];
}

/** Pad every column to its widest cell and rebuild the delimiter row. */
export function formatTable(model: TableModel): FormattedTable {
  const cols = columnCount(model);
  const at = (row: string[], i: number): string => row[i] ?? '';
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(3, width(at(model.header, i)), ...model.rows.map((row) => width(at(row, i)))),
  );

  const lines: string[] = [];
  const starts: number[][] = [];
  const cells: string[][] = [];

  const row = (source: string[]): void => {
    let line = `${model.prefix}|`;
    const offsets: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i < cols; i++) {
      const text = at(source, i);
      const gap = widths[i]! - width(text);
      const align = model.aligns[i] ?? null;
      const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0;
      line += ' ' + ' '.repeat(before);
      offsets.push(line.length);
      texts.push(text);
      line += text + ' '.repeat(gap - before) + ' |';
    }
    lines.push(line);
    starts.push(offsets);
    cells.push(texts);
  };

  row(model.header);

  const delimiter = widths.map((w, i) => {
    switch (model.aligns[i] ?? null) {
      case 'center': return `:${'-'.repeat(w - 2)}:`;
      case 'right': return `${'-'.repeat(w - 1)}:`;
      case 'left': return `:${'-'.repeat(w - 1)}`;
      default: return '-'.repeat(w);
    }
  });
  const delimiterLine = `${model.prefix}| ${delimiter.join(' | ')} |`;
  lines.push(delimiterLine);
  starts.push(delimiter.map(() => model.prefix.length + 2));
  cells.push(delimiter.map(() => ''));

  for (const source of model.rows) row(source);
  return { lines, starts, cells };
}

interface Located {
  /** First and last document line numbers of the table. */
  first: number;
  last: number;
  /** Length of the prefix stripped from every line. */
  column: number;
  model: TableModel;
}

/** The table containing `pos`, or null. */
export function findTable(state: EditorState, pos: number): Located | null {
  const line = state.doc.lineAt(pos);
  // The cursor is almost always in view, so this is already parsed; the
  // timeout only matters for a table far outside the parsed region.
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  const indent = /^[\s>]*/.exec(line.text)![0].length;

  const probes: Array<[number, -1 | 1]> = [[pos, -1], [pos, 1], [line.from + indent, 1]];
  for (const [at, side] of probes) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, side); node; node = node.parent) {
      if (node.name !== 'Table') continue;

      const firstLine = state.doc.lineAt(node.from);
      const lastLine = state.doc.lineAt(node.to);
      if (lastLine.number - firstLine.number < 1) return null;

      const column = node.from - firstLine.from;
      const prefix = firstLine.text.slice(0, column);
      const texts: string[] = [];
      for (let n = firstLine.number; n <= lastLine.number; n++) {
        const text = state.doc.line(n).text;
        // A table in a list or a quote is fine; anything stranger in the
        // margin is left alone rather than rewritten.
        if (!/^[\s>]*$/.test(text.slice(0, column))) return null;
        texts.push(text.slice(column));
      }

      return {
        first: firstLine.number,
        last: lastLine.number,
        column,
        model: {
          prefix,
          header: splitRow(texts[0]!),
          aligns: splitRow(texts[1]!).map(parseAlign),
          rows: texts.slice(2).map(splitRow),
        },
      };
    }
  }
  return null;
}

/** Row index into header-then-rows (the delimiter counts as the header). */
function cellAt(state: EditorState, table: Located, pos: number): { row: number; col: number } {
  const line = state.doc.lineAt(pos);
  const offset = line.number - table.first;
  const row = offset <= 1 ? 0 : offset - 1;
  const text = line.text.slice(table.column);
  const col = cellIndexAt(text, pos - line.from - table.column);
  return { row, col: Math.min(col, columnCount(table.model) - 1) };
}

function lineIndexOf(row: number): number {
  return row === 0 ? 0 : row + 1;
}

/** Replace the table with its formatted form and select one cell's text. */
function rewrite(
  state: EditorState,
  table: Located,
  target: { row: number; col: number },
): TransactionSpec {
  const from = state.doc.line(table.first).from;
  const to = state.doc.line(table.last).to;
  const formatted = formatTable(table.model);

  const index = lineIndexOf(target.row);
  let base = from;
  for (let i = 0; i < index; i++) base += formatted.lines[i]!.length + 1;
  const start = base + formatted.starts[index]![target.col]!;
  const end = start + formatted.cells[index]![target.col]!.length;

  return {
    changes: { from, to, insert: formatted.lines.join('\n') },
    selection: EditorSelection.range(start, end),
    scrollIntoView: true,
    userEvent: 'input',
  };
}

function single(state: EditorState): number | null {
  return state.selection.ranges.length === 1 ? state.selection.main.head : null;
}

/** Tab / Shift-Tab. Tab from the last cell adds a row. */
export function moveCellSpec(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const pos = single(state);
  if (pos === null) return null;
  const table = findTable(state, pos);
  if (!table) return null;

  const cols = columnCount(table.model);
  const { row, col } = cellAt(state, table, pos);
  let target = { row, col: col + dir };

  if (target.col >= cols) {
    target = { row: row + 1, col: 0 };
    if (target.row > table.model.rows.length) table.model.rows.push([]);
  } else if (target.col < 0) {
    target = row === 0 ? { row: 0, col: 0 } : { row: row - 1, col: cols - 1 };
  }
  return rewrite(state, table, target);
}

/**
 * Enter: the same column one row down, adding a row at the bottom. On an empty
 * last row it removes that row and leaves the cursor on a blank line below the
 * table — the same "press Enter twice to get out" rule lists follow.
 */
export function tableEnterSpec(state: EditorState): TransactionSpec | null {
  const pos = single(state);
  if (pos === null) return null;
  const table = findTable(state, pos);
  if (!table) return null;

  const { row, col } = cellAt(state, table, pos);
  const { rows } = table.model;

  if (row >= 1 && row === rows.length && rows[row - 1]!.every((cell) => cell === '')) {
    rows.pop();
    const from = state.doc.line(table.first).from;
    const to = state.doc.line(table.last).to;
    const insert = `${formatTable(table.model).lines.join('\n')}\n`;
    return {
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    };
  }

  const next = row + 1;
  if (next > rows.length) rows.push([]);
  return rewrite(state, table, { row: next, col });
}

function command(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = build(view.state);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

export const tableNextCell = command((state) => moveCellSpec(state, 1));
export const tablePrevCell = command((state) => moveCellSpec(state, -1));
export const tableEnter = command(tableEnterSpec);

/**
 * A new `cols` × `rows` table at `pos` (rows not counting the header), with
 * `Column 1` selected so typing replaces it. Blank lines are added where
 * needed: without one above, the paragraph before would become the header, and
 * without one below, the next line would become a row.
 */
export function insertTableSpec(
  state: EditorState,
  pos: number,
  cols: number,
  rows: number,
): TransactionSpec {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const after = state.sliceDoc(pos, line.to);

  const inline = before.trim().length > 0;
  const from = inline ? pos : line.from;
  const prefix = inline ? '' : before;

  let lead = '';
  if (inline) lead = '\n\n';
  else if (line.number > 1 && state.doc.line(line.number - 1).text.trim().length > 0) lead = '\n';

  let trail = '';
  if (after.trim().length > 0) trail = `\n\n${after.trimStart()}`;
  else if (line.number < state.doc.lines && state.doc.line(line.number + 1).text.trim().length > 0) {
    trail = '\n';
  }

  const model: TableModel = {
    prefix,
    header: Array.from({ length: cols }, (_, i) => `Column ${i + 1}`),
    aligns: Array.from({ length: cols }, () => null),
    rows: Array.from({ length: rows }, () => []),
  };
  const formatted = formatTable(model);
  const table = formatted.lines.join('\n');
  const start = from + lead.length + formatted.starts[0]![0]!;

  return {
    changes: { from, to: line.to, insert: lead + table + trail },
    selection: EditorSelection.range(start, start + formatted.cells[0]![0]!.length),
    scrollIntoView: true,
    userEvent: 'input',
  };
}

/**
 * Mod-Alt-t. The picker's code arrives on first use and is installed into this
 * note's state with `appendConfig` — each note has its own EditorState, so the
 * check is per state. Installing and opening are two transactions because a
 * field added by reconfiguration is created fresh and never sees effects in
 * the transaction that added it.
 */
export const openTablePicker: Command = (view: EditorView) => {
  if (view.state.readOnly) return false;
  void import('./tablePicker.ts').then(({ pickerExtension, pickerField, openPicker }) => {
    // The tile may have closed while the chunk loaded.
    if (!view.dom.isConnected) return;
    if (view.state.field(pickerField, false) === undefined) {
      view.dispatch({ effects: StateEffect.appendConfig.of(pickerExtension) });
    }
    view.dispatch({ effects: openPicker.of(view.state.selection.main.head) });
  });
  return true;
};
