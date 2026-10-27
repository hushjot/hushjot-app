/**
 * Which folders are collapsed in the sidebar.
 *
 * A per-device view preference, like the tile layout, so localStorage rather
 * than the encrypted repository — and never synced: folding a branch on a
 * phone should not fold it on a laptop. Stored as folder ids only, which are
 * random UUIDs and say nothing about the names.
 *
 * Stale ids (a folder deleted here or elsewhere) are harmless — `visibleRows`
 * ignores an id that names nothing — and are pruned on the next write, so the
 * list stays bounded by the folders that exist.
 *
 * Nothing collapsed is the default: a folder the user has never touched shows
 * what is inside it.
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const COLLAPSED_KEY = 'teksto:folders-collapsed';

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

class FolderTreeStore {
  #collapsed = $state<ReadonlySet<string>>(readCollapsed());

  get collapsed(): ReadonlySet<string> {
    return this.#collapsed;
  }

  isCollapsed(id: string): boolean {
    return this.#collapsed.has(id);
  }

  toggle(id: string, existing: readonly { id: string }[]): void {
    this.#set(id, !this.#collapsed.has(id), existing);
  }

  collapse(id: string, existing: readonly { id: string }[]): void {
    this.#set(id, true, existing);
  }

  expand(id: string, existing: readonly { id: string }[]): void {
    this.#set(id, false, existing);
  }

  /** Open every given folder, so a folder beneath them can be seen. */
  expandAll(ids: readonly string[], existing: readonly { id: string }[]): void {
    if (!ids.some((id) => this.#collapsed.has(id))) return;
    const next = new Set(this.#collapsed);
    for (const id of ids) next.delete(id);
    this.#write(next, existing);
  }

  #set(id: string, collapsed: boolean, existing: readonly { id: string }[]): void {
    if (this.#collapsed.has(id) === collapsed) return;
    const next = new Set(this.#collapsed);
    if (collapsed) next.add(id);
    else next.delete(id);
    this.#write(next, existing);
  }

  #write(next: Set<string>, existing: readonly { id: string }[]): void {
    const live = new Set(existing.map((f) => f.id));
    for (const id of next) if (!live.has(id)) next.delete(id);
    this.#collapsed = next;
    try {
      if (next.size === 0) localStorage.removeItem(COLLAPSED_KEY);
      else localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Best effort: a lost preference, not lost data.
    }
  }
}

export const folderTree = new FolderTreeStore();
