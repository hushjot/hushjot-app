/**
 * Tiling preferences: the layout, and which notes were tiled last session.
 *
 * Per-device preferences, not data — localStorage rather than the encrypted
 * repository, as with the text size. The open tiles are stored as note ids
 * only; the crash journal already keeps ids in the clear, and a UUID says
 * nothing a database file would not.
 *
 * The per-tile view mode (edit, split, preview) is stored the same way: a map
 * from note id to mode, trimmed to the notes on screen. See `ui/viewMode.ts`.
 *
 * Switching layout is a class change on one grid element. No editor is
 * rebuilt: CodeMirror observes its own size and re-measures.
 *
 * Whether the sidebar is hidden lives here too: it is the other half of how
 * the editor area is arranged, and the same kind of per-device preference.
 */
import { DEFAULT_TILE_LAYOUT, nextLayout, normalizeLayout, type TileLayout } from '../tiling.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const LAYOUT_KEY = 'teksto:tile-layout';
const OPEN_TILES_KEY = 'teksto:open-tiles';
const TILE_MODES_KEY = 'teksto:tile-modes';
const SIDEBAR_HIDDEN_KEY = 'teksto:sidebar-hidden';

function readSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function readLayout(): TileLayout {
  try {
    return normalizeLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    // Storage blocked: the default applies and simply does not persist.
    return DEFAULT_TILE_LAYOUT;
  }
}

export function readOpenTiles(): unknown[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_TILES_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeOpenTiles(ids: readonly string[]): void {
  try {
    localStorage.setItem(OPEN_TILES_KEY, JSON.stringify(ids));
  } catch {
    // Best effort: losing it costs one reload's worth of tile arrangement.
  }
}

export function readTileModes(): unknown {
  try {
    return JSON.parse(localStorage.getItem(TILE_MODES_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function writeTileModes(modes: Record<string, string>): void {
  try {
    if (Object.keys(modes).length === 0) localStorage.removeItem(TILE_MODES_KEY);
    else localStorage.setItem(TILE_MODES_KEY, JSON.stringify(modes));
  } catch {
    // As above: a lost preference, not lost data.
  }
}

class TilingStore {
  #layout = $state<TileLayout>(readLayout());

  get layout(): TileLayout {
    return this.#layout;
  }

  #sidebarHidden = $state(readSidebarHidden());

  get sidebarHidden(): boolean {
    return this.#sidebarHidden;
  }

  setSidebarHidden(hidden: boolean): void {
    this.#sidebarHidden = hidden;
    try {
      if (hidden) localStorage.setItem(SIDEBAR_HIDDEN_KEY, '1');
      else localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
    } catch {
      // As above.
    }
  }

  cycle(): void {
    this.#layout = nextLayout(this.#layout);
    try {
      localStorage.setItem(LAYOUT_KEY, this.#layout);
    } catch {
      // As above.
    }
  }
}

export const tiling = new TilingStore();
