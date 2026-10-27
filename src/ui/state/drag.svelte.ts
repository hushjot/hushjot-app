/**
 * The drag in flight: what is being dragged, and which folder row it is over.
 *
 * A singleton rather than component state, for the reason `rowSwipe`'s
 * listeners live on the `<ul>` and track the row by note id: **the source row
 * does not survive the drag.** Above `VIRTUALIZE_ABOVE` the note list
 * absolutely positions its rows and destroys every one that leaves the window,
 * so a note dragged past the edge of its own list has its `<li>` torn out from
 * under the pointer. `dragend` never fires on a detached node, so a handler
 * bound to the row would leak the highlight and the app would be left thinking
 * a drag was still running. The teardown is bound to the window instead, and
 * `end()` is idempotent so it does not matter which of `drop` or `dragend`
 * arrives first — or whether only one of them does.
 *
 * Two things here run on a timer or a frame, and neither may go through a
 * rune:
 *
 * - **Spring-loading.** The sidebar renders `visibleRows`, so a folder inside a
 *   collapsed branch is not merely hard to reach, it is not on screen at all.
 *   Hovering one for `SPRING_MS` opens it, which is the only thing that makes
 *   a nested folder a possible destination.
 *
 * - **Edge auto-scroll.** `.folders` is `max-height: 40vh`, so a tree taller
 *   than that cannot be traversed while the pointer is held down. One
 *   `requestAnimationFrame` loop writes `scrollTop` straight to the element,
 *   for the reason the swipe transform is written straight to `element.style`:
 *   a `$state` write would schedule Svelte's whole graph on every frame.
 */
import { folderTree } from './folderTree.svelte.ts';
import type { DragSource } from '../dragDrop.ts';

/** How long a collapsed folder must be hovered before it opens. */
export const SPRING_MS = 500;

/** How close to an edge of the scroller the pointer must be to scroll it. */
export const EDGE_PX = 24;

/** Pixels per frame at the edge. */
const SCROLL_STEP = 8;

class DragStore {
  #source = $state<DragSource | null>(null);

  /**
   * The folder row under the pointer: an id, `null` for the top-level row, and
   * `undefined` for "not over any row". `null` is a real target, so it cannot
   * double as the empty case.
   */
  #overFolderId = $state<string | null | undefined>(undefined);

  /** Set when the row under the pointer would refuse the drop. */
  #invalid = $state(false);

  #springTimer: ReturnType<typeof setTimeout> | undefined;
  #frame: number | undefined;
  #scroller: HTMLElement | null = null;
  #scrollBy = 0;

  get source(): DragSource | null {
    return this.#source;
  }

  get overFolderId(): string | null | undefined {
    return this.#overFolderId;
  }

  get invalid(): boolean {
    return this.#invalid;
  }

  /** Whether `id` is the row that would receive the drop. */
  isOver(id: string | null): boolean {
    return this.#source !== null && this.#overFolderId !== undefined && this.#overFolderId === id;
  }

  begin(source: DragSource): void {
    this.#source = source;
    this.#overFolderId = undefined;
    this.#invalid = false;
  }

  /**
   * The row under the pointer changed — or did not, in which case this returns
   * at once. `dragover` fires continuously while the pointer is still, so
   * every caller relies on that early return to keep the reactive graph quiet.
   */
  over(
    folderId: string | null | undefined,
    options: { invalid?: boolean; springable?: boolean; folders?: readonly { id: string }[] } = {},
  ): void {
    const invalid = options.invalid ?? false;
    if (this.#overFolderId === folderId && this.#invalid === invalid) return;

    this.#overFolderId = folderId;
    this.#invalid = invalid;

    clearTimeout(this.#springTimer);
    this.#springTimer = undefined;
    if (folderId === undefined || folderId === null || !options.springable) return;

    const folders = options.folders;
    if (!folders) return;
    this.#springTimer = setTimeout(() => {
      // Re-check: the pointer may have moved on, and the folder may have gone.
      if (this.#overFolderId !== folderId) return;
      folderTree.expand(folderId, folders);
    }, SPRING_MS);
  }

  /**
   * Scroll `scroller` while the pointer sits near its top or bottom edge.
   * Called from `dragover` with the event's client Y; starts and stops the
   * frame loop by itself so callers never have to pair the two.
   */
  edgeScroll(scroller: HTMLElement, clientY: number): void {
    const box = scroller.getBoundingClientRect();
    const up = clientY - box.top < EDGE_PX;
    const down = box.bottom - clientY < EDGE_PX;
    this.#scrollBy = up ? -SCROLL_STEP : down ? SCROLL_STEP : 0;
    this.#scroller = scroller;

    if (this.#scrollBy === 0) {
      this.#stopScroll();
      return;
    }
    if (this.#frame !== undefined) return;

    const step = (): void => {
      if (this.#scrollBy === 0 || !this.#scroller || this.#source === null) {
        this.#frame = undefined;
        return;
      }
      this.#scroller.scrollTop += this.#scrollBy;
      this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }

  /**
   * Every drag ends here, however it ended. Idempotent on purpose: `drop` and
   * `dragend` both fire for a completed drag, only `dragend` for an abandoned
   * one, and neither is guaranteed to reach a node that has been destroyed —
   * which is why the listener that calls this is on the window.
   */
  end(): void {
    this.#source = null;
    this.#overFolderId = undefined;
    this.#invalid = false;
    clearTimeout(this.#springTimer);
    this.#springTimer = undefined;
    this.#stopScroll();
  }

  #stopScroll(): void {
    this.#scrollBy = 0;
    this.#scroller = null;
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }
}

export const drag = new DragStore();
