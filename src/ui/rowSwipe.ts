/**
 * The swipe gesture on a phone note row: right to pin, left to delete.
 *
 * Pure and DOM-free so it can be tested the way the rest of `src/core` is —
 * the component feeds it coordinates and acts on what comes back.
 *
 * Three rules shape it, and each one is a bug that happened without it:
 *
 * 1. **The gesture is not claimed until it is clearly horizontal.** Until then
 *    the row must behave exactly as before, because most touches on a note row
 *    are a tap or the start of a scroll. `touch-action: pan-y` in the CSS is
 *    the other half: the browser keeps vertical pans on the compositor, so
 *    scrolling never waits on this code, and horizontal movement is left to us
 *    rather than being swallowed.
 *
 * 2. **Once it is scrolling it stays scrolling.** A finger that moves down and
 *    then sideways is someone scrolling an awkward list, not someone asking to
 *    delete the row their thumb happens to be over.
 *
 * 3. **A committed swipe suppresses the click that follows it.** Letting go
 *    otherwise opens the note — the row is a button, and the pointer went down
 *    and up inside it.
 */

/** Horizontal travel before the gesture is ours at all. */
export const CLAIM_PX = 10;

/** How much more horizontal than vertical the movement has to be. */
export const CLAIM_RATIO = 1.5;

/** Travel at which release fires the action rather than springing back. */
export const COMMIT_PX = 72;

export type SwipeAction = 'pin' | 'delete';

export type SwipePhase =
  /** Pointer is down; which gesture this is has not been decided yet. */
  | 'undecided'
  /** Ours: the row follows the finger. */
  | 'swiping'
  /** Not ours: the list is scrolling and we take no further interest. */
  | 'scrolling';

export interface SwipeState {
  phase: SwipePhase;
  id: string;
  startX: number;
  startY: number;
  /** Horizontal travel; 0 until the gesture is claimed. */
  dx: number;
}

export function begin(id: string, x: number, y: number): SwipeState {
  return { phase: 'undecided', id, startX: x, startY: y, dx: 0 };
}

export function move(state: SwipeState, x: number, y: number): SwipeState {
  if (state.phase === 'scrolling') return state;

  const dx = x - state.startX;
  const dy = y - state.startY;

  if (state.phase === 'undecided') {
    // Nothing is decided until the finger has travelled far enough for the
    // direction to mean something.
    if (Math.abs(dx) < CLAIM_PX && Math.abs(dy) < CLAIM_PX) return state;
    if (Math.abs(dx) < Math.abs(dy) * CLAIM_RATIO) return { ...state, phase: 'scrolling' };
    return { ...state, phase: 'swiping', dx };
  }

  return { ...state, dx };
}

/**
 * What releasing here should do. `null` means spring back and change nothing —
 * which covers a tap, a scroll, and a swipe that did not travel far enough.
 */
export function release(state: SwipeState | null): SwipeAction | null {
  if (!state || state.phase !== 'swiping') return null;
  if (Math.abs(state.dx) < COMMIT_PX) return null;
  return state.dx > 0 ? 'pin' : 'delete';
}

/** Whether the click that follows this gesture should be swallowed. */
export function suppressesClick(state: SwipeState | null): boolean {
  return state?.phase === 'swiping';
}
