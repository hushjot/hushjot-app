/**
 * Table navigation and alignment, tested against a real Markdown syntax tree
 * because "is the cursor in a table" is the parser's answer, not a regex's.
 * `|` inside a document is a table pipe, so cursors here are written as `‸`.
 * The rendered markers take up characters, so expected rows look one or two
 * columns wider where a cursor or selection sits.
 */
import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import {
  findTable,
  formatTable,
  insertTableSpec,
  moveCellSpec,
  splitRow,
  tableEnterSpec,
} from '../../src/editor/tableKeys.ts';

const CARET = '‸';

function state(source: string): EditorState {
  const at = source.indexOf(CARET);
  return EditorState.create({
    doc: source.replace(CARET, ''),
    selection: EditorSelection.cursor(Math.max(0, at)),
    extensions: [markdownLean()],
  });
}

/** Render with `‸` for a cursor and `«…»` for a selection. */
function render(s: EditorState): string {
  const { from, to } = s.selection.main;
  const text = s.doc.toString();
  return from === to
    ? `${text.slice(0, from)}${CARET}${text.slice(from)}`
    : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`;
}

function run(source: string, build: (s: EditorState) => TransactionSpec | null): string {
  const s = state(source);
  const spec = build(s);
  return spec ? render(s.update(spec).state) : 'null';
}

describe('splitRow', () => {
  it('drops edge pipes and trims', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitRow('a|b')).toEqual(['a', 'b']);
  });

  it('keeps empty cells between pipes', () => {
    expect(splitRow('| a | |')).toEqual(['a', '']);
  });

  it('does not split on an escaped pipe, but does inside code, as GFM does', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
    expect(splitRow('| `x|y` |')).toEqual(['`x', 'y`']);
  });
});

describe('formatTable', () => {
  it('pads columns, keeps alignment and fills ragged rows', () => {
    const { lines } = formatTable({
      prefix: '',
      header: ['Name', 'N'],
      aligns: [null, 'right'],
      rows: [['a'], ['longer', '12']],
    });
    expect(lines).toEqual([
      '| Name   |   N |',
      '| ------ | --: |',
      '| a      |     |',
      '| longer |  12 |',
    ]);
  });

  it('centres', () => {
    const { lines } = formatTable({ prefix: '', header: ['abcde'], aligns: ['center'], rows: [['a']] });
    expect(lines).toEqual(['| abcde |', '| :---: |', '|   a   |']);
  });
});

describe('findTable', () => {
  it('ignores pipes in a code fence', () => {
    const s = state('```\n| a | b |\n| - | - |\n| 1‸ | 2 |\n```');
    expect(findTable(s, s.selection.main.head)).toBeNull();
  });

  it('finds a table without edge pipes', () => {
    const s = state('a | b\n--|--\n1 | 2‸');
    expect(findTable(s, s.selection.main.head)?.model.header).toEqual(['a', 'b']);
  });
});

describe('moveCellSpec', () => {
  const next = (s: EditorState) => moveCellSpec(s, 1);
  const prev = (s: EditorState) => moveCellSpec(s, -1);

  it('aligns and selects the next cell', () => {
    expect(run('| a‸ | bb |\n|-|-|\n| 1 | 2 |', next)).toBe(
      '| a   | «bb»  |\n| --- | --- |\n| 1   | 2   |',
    );
  });

  it('wraps to the next row, and adds one at the end', () => {
    expect(run('| a | b‸ |\n|-|-|\n| 1 | 2 |', next)).toBe(
      '| a   | b   |\n| --- | --- |\n| «1»   | 2   |',
    );
    expect(run('| a | b |\n|-|-|\n| 1 | 2‸ |', next)).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |',
    );
  });

  it('goes back a cell and up a row', () => {
    expect(run('| a | b |\n|-|-|\n| 1‸ | 2 |', prev)).toBe(
      '| a   | «b»   |\n| --- | --- |\n| 1   | 2   |',
    );
  });

  it('returns null outside a table so Tab still indents', () => {
    expect(run('just text‸', next)).toBe('null');
  });
});

describe('tableEnterSpec', () => {
  it('moves down the same column, adding a row at the end', () => {
    expect(run('| a | b‸ |\n|-|-|', tableEnterSpec)).toBe('| a   | b   |\n| --- | --- |\n|     | ‸    |');
  });

  it('leaves the table from an empty last row', () => {
    expect(run('| a | b |\n|-|-|\n| 1 | 2 |\n|  ‸ |  |', tableEnterSpec)).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n‸',
    );
  });
});

describe('insertTableSpec', () => {
  it('inserts with a blank line above a paragraph and selects the first header', () => {
    const s = state('Intro\n‸');
    const next = s.update(insertTableSpec(s, s.selection.main.head, 2, 1)).state;
    expect(render(next)).toBe(
      'Intro\n\n| «Column 1» | Column 2 |\n| -------- | -------- |\n|          |          |',
    );
  });

  it('moves text after the cursor below the table', () => {
    const s = state('before ‸after');
    const next = s.update(insertTableSpec(s, s.selection.main.head, 1, 1)).state;
    expect(next.doc.toString()).toBe('before \n\n| Column 1 |\n| -------- |\n|          |\n\nafter');
  });
});
