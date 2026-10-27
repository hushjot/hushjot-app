/**
 * Folders (spec §12) — a simple optional hierarchy, not a document-management
 * system. Folders are organisational metadata whose names can reveal private
 * information, so they are encrypted alongside note metadata.
 *
 * The user is expected to be able to ignore folders entirely and live on
 * recent-notes plus search.
 *
 * ## Nesting
 *
 * Folders nest to any depth, like a file system, because an imported zip can
 * and a flat list cannot hold it. The data model always carried `parentId`;
 * what nesting adds is here as pure functions, so the rules the sidebar obeys
 * are the ones the tests prove:
 *
 * - A move is refused when the target is the folder itself or inside it
 *   (`canMoveFolder`). That is the only way a *local* action could make a
 *   cycle. Two devices moving folders concurrently can still produce one after
 *   sync — the merge is last-write-wins per folder and sees no tree — which is
 *   why `buildTree`, `subtreeIds` and `ancestorIds` all tolerate cycles rather
 *   than assuming they cannot happen.
 * - Collapsing is presentation, not data (`visibleRows`): per device, never
 *   synced, and a collapsed folder's notes are exactly where they were.
 */

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  /**
   * Last local mutation. Folders have no revision, so this is what decides
   * which side of a two-device disagreement wins on pull.
   */
  updatedAt: number;
}

export interface FolderNode extends Folder {
  depth: number;
  children: FolderNode[];
  /** Set by `buildTree`; lets a row show its expander without walking children. */
  hasChildren: boolean;
}

export function createFolder(name: string, parentId: string | null = null, now = Date.now()): Folder {
  return {
    id: crypto.randomUUID(),
    name: name.trim() || 'New folder',
    parentId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build the display tree. Folders whose parent is missing are surfaced at the
 * root rather than silently dropped — losing a user's folder because of a
 * dangling reference is exactly the kind of quiet data loss §25 forbids.
 */
export function buildTree(folders: readonly Folder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const f of folders) nodes.set(f.id, { ...f, depth: 0, children: [], hasChildren: false });

  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  // A parent cycle (A→B, B→A) leaves every member of the cycle owned by another
  // member, so none of them is a root and the whole group would silently
  // disappear from the tree. Promote one member per cycle to the root and cut
  // its back edge, so every folder still reaches the user (§25).
  const reachable = new Set<string>();
  const markReachable = (node: FolderNode): void => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    for (const child of node.children) markReachable(child);
  };
  for (const root of roots) markReachable(root);

  for (const node of nodes.values()) {
    if (reachable.has(node.id)) continue;
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children = parent.children.filter((c) => c.id !== node.id);
    roots.push(node);
    markReachable(node);
  }

  const byName = (a: FolderNode, b: FolderNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const assignDepth = (list: FolderNode[], depth: number): void => {
    list.sort(byName);
    for (const node of list) {
      node.depth = depth;
      node.hasChildren = node.children.length > 0;
      assignDepth(node.children, depth + 1);
    }
  };
  assignDepth(roots, 0);

  return roots;
}

/** Flatten the tree for rendering as a single virtualizable list. */
export function flattenTree(roots: readonly FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * Every folder in the subtree rooted at `rootId`, that folder included.
 *
 * Deleting a folder deletes what it contains, so this is what both the warning
 * the user reads and the deletion that follows are computed from — one
 * traversal, so the count can never disagree with the outcome. The visited set
 * is not defensive bookkeeping: `buildTree` already tolerates a parent cycle
 * (A→B, B→A), so one can reach this function, and without the guard it would
 * not terminate.
 */
export function subtreeIds(folders: readonly Folder[], rootId: string): string[] {
  if (!folders.some((f) => f.id === rootId)) return [];

  const childrenOf = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentId === null || f.parentId === f.id) continue;
    const siblings = childrenOf.get(f.parentId);
    if (siblings) siblings.push(f.id);
    else childrenOf.set(f.parentId, [f.id]);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/**
 * The flattened tree as the sidebar shows it: children of a collapsed folder
 * are skipped, and so is everything beneath them. The folder itself stays.
 */
export function visibleRows(roots: readonly FolderNode[], collapsed: ReadonlySet<string>): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (!collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * The ids above `id`, nearest first, not including `id`. Stops at a missing
 * parent or on returning to a folder already seen, so a synced cycle ends the
 * chain rather than the loop.
 */
export function ancestorIds(folders: readonly Folder[], id: string): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: string[] = [];
  const seen = new Set([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId) && byId.has(parentId)) {
    out.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)!.parentId;
  }
  return out;
}

/**
 * Whether `id` may be moved under `newParentId` (null is the top level).
 * Refused for an unknown folder or target, and for a target inside the moving
 * folder's own subtree, itself included — the move that would make a cycle.
 */
export function canMoveFolder(folders: readonly Folder[], id: string, newParentId: string | null): boolean {
  if (!folders.some((f) => f.id === id)) return false;
  if (newParentId === null) return true;
  if (!folders.some((f) => f.id === newParentId)) return false;
  return !subtreeIds(folders, id).includes(newParentId);
}

/** `Code / Rust / Async`: the names from the top level down to `id`. */
export function folderPath(folders: readonly Folder[], id: string, separator = ' / '): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const self = byId.get(id);
  if (!self) return '';
  const names = ancestorIds(folders, id)
    .reverse()
    .map((a) => byId.get(a)!.name);
  return [...names, self.name].join(separator);
}

/**
 * The folders a human-typed string names — the resolver behind the search box's
 * `in:` operator and the CLI's `--folder` flag.
 *
 * It lives here rather than in either caller because `hushjot-cli` already had
 * one (`resolveFolder`) and the app was about to grow a second. Two
 * implementations of "which folder did they mean" would both work and disagree
 * silently: `in:work` selecting one folder in the browser and a different one
 * in an agent's MCP call is not an error anyone would see reported.
 *
 * Matching is tried in order of how specific it is, and the first kind that
 * matches anything wins: an exact id, then the full `/`-joined path, then a
 * plain name. Ambiguity is *returned*, not resolved — two folders may legally
 * share a name, and the two callers want opposite things when that happens. A
 * CLI about to act on one folder must stop and ask; a search box must narrow to
 * both and let the results speak.
 *
 * `prefix` is what makes the search box narrow as it is typed — `in:wo` reaching
 * `Work` the way `#wo` already reaches `#work`. It is deliberately not the
 * default: a command resolving `--folder wo` to `Workshop` would be acting on a
 * folder nobody named.
 *
 * Note this returns the matches themselves, never their descendants. Recursion
 * is the caller's choice, through `subtreeIds`, because `canMoveFolder` wants
 * one of these answers and a folder scope wants the other.
 */
export function foldersMatching(
  folders: readonly Folder[],
  wanted: string,
  { prefix = false }: { prefix?: boolean } = {},
): string[] {
  const needle = wanted.trim().toLowerCase();
  if (needle === '') return [];

  const byId = folders.filter((f) => f.id.toLowerCase() === needle);
  if (byId.length > 0) return byId.map((f) => f.id);

  const pathOf = (f: Folder): string => folderPath(folders, f.id, '/').toLowerCase();

  const byPath = folders.filter((f) => pathOf(f) === needle);
  if (byPath.length > 0) return byPath.map((f) => f.id);

  const byName = folders.filter((f) => f.name.toLowerCase() === needle);
  if (byName.length > 0) return byName.map((f) => f.id);

  if (!prefix) return [];

  // Last resort, and only for a caller that asked: anything being typed towards.
  // A path prefix has to stop on a separator or it would offer `Work` for a
  // query of `Wo` *and* `Workshop/Notes` for a query of `Workshop/N`, which is
  // right, while never offering `Workshop` for `Work/`.
  return folders
    .filter((f) => f.name.toLowerCase().startsWith(needle) || pathOf(f).startsWith(needle))
    .map((f) => f.id);
}
