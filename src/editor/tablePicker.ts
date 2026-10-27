/**
 * The table size picker, opened by Mod-Alt-t. A lazy chunk: reached only
 * through the dynamic import in `tableKeys.ts`.
 *
 * It is a grid like the one in Google Docs and Word — arrows or the mouse set
 * the size — and it also takes a typed size such as `3x4`, which is faster than
 * either for anyone who already knows what they want. The size is columns ×
 * body rows; the header row is always there and is drawn separately.
 *
 * **Focus never leaves the editor.** The picker's keys are a highest-precedence
 * keymap that acts only while the picker is open, and the grid cancels
 * `mousedown`. Moving focus into a popup would mean handing it back to the
 * right tile afterwards, and with four tiles on screen that is a bug waiting
 * to happen; keeping it where it is makes the popup belong to its own editor.
 *
 * Anything else closes it: an edit, or the cursor moving away. Typing a letter
 * that is not part of a size simply types it, which is also a way out.
 *
 * The DOM is built with `createElement` and `textContent` only, the same rule
 * the preview follows.
 */
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  showTooltip,
  type Command,
  type KeyBinding,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { insertTableSpec } from './tableKeys.ts';

/** The grid stops growing here; a typed size may go further. */
const GRID_COLS = 10;
const GRID_ROWS = 20;
const MAX_COLS = 20;
const MAX_ROWS = 100;

interface Picker {
  /** Kept identical while the picker is open, so the tooltip is not rebuilt. */
  tooltip: Tooltip;
  cols: number;
  rows: number;
  /** A size being typed, e.g. `3x`. Empty when the grid set the size. */
  typed: string;
}

export const openPicker = StateEffect.define<number>();
const resize = StateEffect.define<{ cols: number; rows: number; typed: string }>();
const closePicker = StateEffect.define<null>();

export const pickerField = StateField.define<Picker | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openPicker)) {
        return {
          tooltip: { pos: effect.value, above: false, strictSide: false, create: pickerView },
          cols: 3,
          rows: 2,
          typed: '',
        };
      }
      if (effect.is(closePicker)) return null;
      if (effect.is(resize) && value) return { ...value, ...effect.value };
    }
    if (!value) return null;
    if (tr.docChanged) return null;
    if (tr.selection && tr.state.selection.main.head !== value.tooltip.pos) return null;
    return value;
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function setSize(view: EditorView, cols: number, rows: number, typed = ''): void {
  view.dispatch({
    effects: resize.of({ cols: clamp(cols, 1, MAX_COLS), rows: clamp(rows, 1, MAX_ROWS), typed }),
  });
}

function insert(view: EditorView, picker: Picker): void {
  view.dispatch(insertTableSpec(view.state, picker.tooltip.pos, picker.cols, picker.rows));
}

/** Bind a key that only means something while the picker is open. */
function whenOpen(run: (view: EditorView, picker: Picker) => void): Command {
  return (view) => {
    const picker = view.state.field(pickerField, false);
    if (!picker) return false;
    run(view, picker);
    return true;
  };
}

const TYPED = /^(\d{1,2})?(?:x(\d{1,3})?)?$/;

/** Extend the typed size by one character, ignoring anything that would not parse. */
function type(char: string): Command {
  return whenOpen((view, picker) => {
    const typed = char === 'x' && picker.typed === '' ? `${picker.cols}x` : picker.typed + char;
    if (typed.split('x').length > 2) return;
    applyTyped(view, picker, typed);
  });
}

function applyTyped(view: EditorView, picker: Picker, typed: string): void {
  const match = TYPED.exec(typed);
  if (!match) return;
  const cols = match[1] ? Number(match[1]) : picker.cols;
  const rows = match[2] ? Number(match[2]) : picker.rows;
  if (cols < 1 || rows < 1) {
    // `0` on its own is a prefix of nothing useful; keep it visible anyway so
    // Backspace behaves predictably.
    view.dispatch({ effects: resize.of({ cols: picker.cols, rows: picker.rows, typed }) });
    return;
  }
  setSize(view, cols, rows, typed);
}

const bindings: KeyBinding[] = [
  { key: 'ArrowRight', run: whenOpen((v, p) => setSize(v, Math.min(p.cols + 1, GRID_COLS), p.rows)) },
  { key: 'ArrowLeft', run: whenOpen((v, p) => setSize(v, p.cols - 1, p.rows)) },
  { key: 'ArrowDown', run: whenOpen((v, p) => setSize(v, p.cols, Math.min(p.rows + 1, GRID_ROWS))) },
  { key: 'ArrowUp', run: whenOpen((v, p) => setSize(v, p.cols, p.rows - 1)) },
  { key: 'Enter', run: whenOpen(insert) },
  { key: 'Escape', run: whenOpen((v) => v.dispatch({ effects: closePicker.of(null) })) },
  { key: 'Tab', run: whenOpen((v) => v.dispatch({ effects: closePicker.of(null) })) },
  {
    key: 'Backspace',
    run: whenOpen((v, p) => {
      if (p.typed === '') return;
      applyTyped(v, p, p.typed.slice(0, -1));
    }),
  },
  { key: 'x', run: type('x') },
  { key: 'X', run: type('x') },
  { key: '*', run: type('x') },
  ...Array.from({ length: 10 }, (_, d) => ({ key: String(d), run: type(String(d)) })),
];

export const pickerExtension: Extension = [pickerField, Prec.highest(keymap.of(bindings))];

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function pickerView(view: EditorView): TooltipView {
  const dom = element('div', 'cm-table-picker');
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', 'Insert table');

  const label = element('div', 'cm-table-picker-label');
  const grid = element('div', 'cm-table-picker-grid');
  const hint = element('div', 'cm-table-picker-hint');
  hint.textContent = 'Arrows or type 3x4 · Enter inserts · Esc';
  dom.append(label, grid, hint);

  let shownCols = 0;
  let shownRows = 0;
  let cells: HTMLElement[] = [];

  const render = (): void => {
    const picker = view.state.field(pickerField, false);
    if (!picker) return;

    // Always one spare column and row, so the grid visibly has room to grow.
    const cols = clamp(picker.cols + 1, 6, GRID_COLS);
    const rows = clamp(picker.rows + 1, 5, GRID_ROWS);
    if (cols !== shownCols || rows !== shownRows) {
      shownCols = cols;
      shownRows = rows;
      grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
      cells = [];
      // Row 0 is the header.
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = element('div', r === 0 ? 'cm-table-picker-cell cm-table-picker-head' : 'cm-table-picker-cell');
          cell.dataset.col = String(c + 1);
          cell.dataset.row = String(r);
          cells.push(cell);
        }
      }
      grid.replaceChildren(...cells);
    }

    for (const cell of cells) {
      const on = Number(cell.dataset.col) <= picker.cols && Number(cell.dataset.row) <= picker.rows;
      cell.classList.toggle('cm-table-picker-on', on);
    }

    const size = `${picker.cols} ${picker.cols === 1 ? 'column' : 'columns'} × ${picker.rows} ${picker.rows === 1 ? 'row' : 'rows'}`;
    label.textContent = picker.typed ? `${size}  (typed ${picker.typed})` : size;
  };

  const sizeFrom = (target: EventTarget | null): { cols: number; rows: number } | null => {
    if (!(target instanceof HTMLElement) || !target.dataset.col) return null;
    return { cols: Number(target.dataset.col), rows: Math.max(1, Number(target.dataset.row)) };
  };

  // Keep focus in the editor: a mousedown here would otherwise blur it.
  dom.addEventListener('mousedown', (event) => event.preventDefault());
  grid.addEventListener('pointermove', (event) => {
    const size = sizeFrom(event.target);
    const picker = view.state.field(pickerField, false);
    if (!size || !picker || (size.cols === picker.cols && size.rows === picker.rows)) return;
    setSize(view, size.cols, size.rows);
  });
  grid.addEventListener('click', (event) => {
    const size = sizeFrom(event.target);
    const picker = view.state.field(pickerField, false);
    if (!size || !picker) return;
    insert(view, { ...picker, ...size });
  });

  render();
  return { dom, update: render };
}
