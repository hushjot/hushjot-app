import { describe, it, expect } from 'vitest';
import {
  COMMIT_PX,
  begin,
  move,
  release,
  suppressesClick,
  type SwipeState,
} from '../../src/ui/rowSwipe.ts';

/** Walk a gesture through a list of [x, y] points from (0, 0). */
function gesture(points: [number, number][]): SwipeState {
  let state = begin('n1', 0, 0);
  for (const [x, y] of points) state = move(state, x, y);
  return state;
}

describe('the note row swipe', () => {
  it('claims nothing until the finger has travelled', () => {
    const state = gesture([[3, 1], [6, 2]]);
    expect(state.phase).toBe('undecided');
    expect(state.dx).toBe(0);
    expect(release(state)).toBeNull();
    expect(suppressesClick(state)).toBe(false);
  });

  it('a tap changes nothing', () => {
    expect(release(begin('n1', 0, 0))).toBeNull();
    expect(suppressesClick(begin('n1', 0, 0))).toBe(false);
  });

  it('leaves a vertical drag to the scroller', () => {
    const state = gesture([[2, 14], [40, 60]]);
    expect(state.phase).toBe('scrolling');
    expect(release(state)).toBeNull();
  });

  it('stays with the scroller once it has started scrolling', () => {
    // Down first, then sharply sideways: still a scroll, not a swipe.
    const state = gesture([[0, 30], [90, 32]]);
    expect(state.phase).toBe('scrolling');
    expect(release(state)).toBeNull();
  });

  it('claims a clearly horizontal drag', () => {
    const state = gesture([[20, 3]]);
    expect(state.phase).toBe('swiping');
    expect(state.dx).toBe(20);
    expect(suppressesClick(state)).toBe(true);
  });

  it('springs back when the swipe is too short', () => {
    expect(release(gesture([[COMMIT_PX - 1, 0]]))).toBeNull();
  });

  it('pins on a long swipe right and deletes on a long swipe left', () => {
    expect(release(gesture([[COMMIT_PX, 0]]))).toBe('pin');
    expect(release(gesture([[-COMMIT_PX, 0]]))).toBe('delete');
  });

  it('tracks the finger back across the threshold', () => {
    // Out past the commit point and back again: releasing here does nothing.
    const state = gesture([[90, 2], [10, 2]]);
    expect(state.phase).toBe('swiping');
    expect(release(state)).toBeNull();
    // ...but the click is still swallowed, or the note would open.
    expect(suppressesClick(state)).toBe(true);
  });

  it('remembers which row it started on', () => {
    expect(gesture([[80, 0]]).id).toBe('n1');
  });
});
