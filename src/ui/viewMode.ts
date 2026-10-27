/**
 * View-mode rules: whether a tile shows the editor, the rendered preview, or
 * both side by side.
 *
 * Pure, and kept apart from the stores for the same reason `tiling.ts` is: the
 * rules are unit-testable without a rune harness or localStorage.
 *
 * - **Per tile, not global.** Reading one note while writing another is the
 *   point of having tiles.
 * - **Edit is the default and the fallback.** §10 makes the editor the primary
 *   experience; the preview is a view onto it, never a replacement.
 * - **A phone has no split.** At 720px or less two columns of prose are both
 *   unreadable, so split shows the preview there. The stored mode is left
 *   alone, so the tile comes back split on a wide screen.
 */

export type ViewMode = 'edit' | 'split' | 'preview';

export const VIEW_MODES: readonly ViewMode[] = ['edit', 'split', 'preview'];

export function normalizeViewMode(raw: unknown): ViewMode {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : 'edit';
}

/** Edit → Split → Preview → Edit; on a phone Split is skipped. */
export function nextViewMode(mode: ViewMode, { mobile = false } = {}): ViewMode {
  const modes = mobile ? VIEW_MODES.filter((m) => m !== 'split') : VIEW_MODES;
  const at = modes.indexOf(effectiveViewMode(mode, { mobile }));
  return modes[(at + 1) % modes.length]!;
}

export function effectiveViewMode(mode: ViewMode, { mobile = false } = {}): ViewMode {
  return mobile && mode === 'split' ? 'preview' : mode;
}

/**
 * Stored modes are keyed by note id and trimmed to the notes on screen. Keying
 * by position would hand a mode to the wrong note whenever `restoreTiles`
 * drops one that has since been deleted. Edit is the default, so it is not stored.
 */
export function modesToStore(tiles: readonly { id: string | null; mode: ViewMode }[]): Record<string, ViewMode> {
  const out: Record<string, ViewMode> = {};
  for (const tile of tiles) {
    if (tile.id && tile.mode !== 'edit') out[tile.id] = tile.mode;
  }
  return out;
}

export function storedModeFor(stored: unknown, id: string): ViewMode {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return 'edit';
  return Object.hasOwn(stored, id) ? normalizeViewMode((stored as Record<string, unknown>)[id]) : 'edit';
}
