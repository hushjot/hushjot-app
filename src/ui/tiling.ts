/**
 * Tiling rules: which notes are open side by side, and which one has focus.
 *
 * Pure, and kept apart from the workspace for the same reason `textSize.ts` is
 * kept apart from its store: the rules are unit-testable without a rune harness,
 * IndexedDB or localStorage.
 *
 * The shape of the rules, and why:
 *
 * - **Selecting replaces the focused tile, tiling adds one.** Clicking a note in
 *   the list, ⌘P — every flow that existed before tiling — keeps meaning "show
 *   me this note here", and a single tile behaves exactly as the app always
 *   did. Tiling is the additive gesture.
 * - **"+ Note" adds a tile only once the user is already tiling.** With one
 *   tile nobody asked for a split, and at the cap there is no room, so both
 *   replace the focused tile; with two or three, replacing one would throw a
 *   note the user chose to keep on screen out of view. See `createOpensTile`.
 * - **A note is open in at most one tile.** Two editors on one note would hold
 *   two undo histories and two pending saves for the same record, and whichever
 *   drained last would win. Tiling a note already on screen focuses it instead.
 * - **At the cap, tiling replaces the focused tile** rather than refusing, so the
 *   button is never a dead end.
 * - **The last tile never closes.** The editor pane is never empty while notes
 *   exist; removing the final note is the workspace's fallback, not this.
 */

export type TileLayout = 'vertical' | 'horizontal' | 'grid';

export const TILE_LAYOUTS: readonly TileLayout[] = ['vertical', 'horizontal', 'grid'];

/** Side-by-side columns — the split people reach for first on a wide screen. */
export const DEFAULT_TILE_LAYOUT: TileLayout = 'vertical';

/** Four is a 2×2; past that each tile is too small to write in. */
export const MAX_TILES = 4;

export interface TileSet {
  ids: string[];
  focused: number;
}

export function normalizeLayout(raw: unknown): TileLayout {
  return TILE_LAYOUTS.includes(raw as TileLayout) ? (raw as TileLayout) : DEFAULT_TILE_LAYOUT;
}

export function nextLayout(layout: TileLayout): TileLayout {
  return TILE_LAYOUTS[(TILE_LAYOUTS.indexOf(layout) + 1) % TILE_LAYOUTS.length]!;
}

/** Open `id` beside the focused tile. */
export function planTile(ids: readonly string[], focused: number, id: string): TileSet {
  const existing = ids.indexOf(id);
  if (existing !== -1) return { ids: [...ids], focused: existing };

  if (ids.length === 0) return { ids: [id], focused: 0 };

  const at = clamp(focused, ids.length);
  if (ids.length >= MAX_TILES) {
    const next = [...ids];
    next[at] = id;
    return { ids: next, focused: at };
  }

  const next = [...ids];
  next.splice(at + 1, 0, id);
  return { ids: next, focused: at + 1 };
}

/** Whether a new note gets its own tile, given how many tiles are showing. */
export function createOpensTile(count: number): boolean {
  return count > 1 && count < MAX_TILES;
}

/** Close the tile at `index`. Focus moves left, or to the tile that slid in. */
export function planClose(ids: readonly string[], focused: number, index: number): TileSet {
  if (ids.length <= 1 || index < 0 || index >= ids.length) {
    return { ids: [...ids], focused: clamp(focused, ids.length) };
  }
  const next = ids.filter((_, i) => i !== index);
  let nextFocused = focused;
  if (index < focused) nextFocused = focused - 1;
  else if (index === focused) nextFocused = Math.max(0, index - 1);
  return { ids: next, focused: clamp(nextFocused, next.length) };
}

/** Tiles remembered from the last session, minus anything that no longer exists. */
export function restoreTiles(stored: readonly unknown[], exists: (id: string) => boolean): string[] {
  const kept: string[] = [];
  for (const id of stored) {
    if (typeof id !== 'string' || kept.includes(id) || !exists(id)) continue;
    kept.push(id);
    if (kept.length === MAX_TILES) break;
  }
  return kept;
}

function clamp(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}
