/**
 * Fence insertion is a text transformation over EditorState, so it is tested
 * without a DOM. `fenceSpec` is the whole of the interesting logic; the
 * Command wrappers around it only dispatch.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { fenceSpec, fenceSlot } from '../../src/editor/fenceKeys.ts';

/** Apply a fence at the cursor marked by `|` and render the result the same way. */
function fence(source: string): string {
  const at = source.indexOf('|');
  const sel = source.indexOf(']');
  let doc: string;
  let from: number;
  let to: number;

  if (at >= 0) {
    doc = source.replace('|', '');
    from = to = at;
  } else {
    // `[selected]` marks a range.
    doc = source.replace('[', '').replace(']', '');
    from = source.indexOf('[');
    to = sel - 1;
  }

  const state = EditorState.create({ doc, extensions: [fenceSlot] });
  const body = from === to ? '' : doc.slice(from, to);
  const { slot, ...spec } = fenceSpec(state, from, to, body);
  void slot;
  const next = state.update(spec);
  const text = next.state.doc.toString();
  const cursor = next.state.selection.main.head;
  return `${text.slice(0, cursor)}|${text.slice(cursor)}`;
}

describe('fenceSpec', () => {
  it('opens an empty fence with the cursor in the language slot', () => {
    expect(fence('|')).toBe('```|\n\n```');
  });

  it('wraps a selection without reindenting it', () => {
    expect(fence('[def f():\n    return 1]')).toBe(
      '```|\ndef f():\n    return 1\n```',
    );
  });

  it('starts on a fresh line when there is text to the left', () => {
    expect(fence('notes: |')).toBe('notes: \n```|\n\n```');
  });

  it('pushes trailing text below the closing fence', () => {
    expect(fence('|tail')).toBe('```|\n\n```\ntail');
  });

  it('keeps the fence at the enclosing indentation', () => {
    expect(fence('  |')).toBe('  ```|\n  \n  ```');
  });

  it('places the recorded slot on the body line', () => {
    const state = EditorState.create({ doc: '', extensions: [fenceSlot] });
    const { slot, ...spec } = fenceSpec(state, 0, 0, '');
    const next = state.update(spec).state;
    // slot points into the line between the fences.
    expect(next.doc.lineAt(slot).number).toBe(2);
  });
});

describe('fenceSlot', () => {
  it('retires the slot once the cursor leaves the opener line', () => {
    const state = EditorState.create({ doc: '```\n\n```', extensions: [fenceSlot] });
    expect(state.field(fenceSlot)).toBeNull();

    // Moving the cursor into the body must not resurrect a slot.
    const moved = state.update({ selection: { anchor: 5 } }).state;
    expect(moved.field(fenceSlot)).toBeNull();
  });
});
