<script lang="ts">
  import NoteList from './NoteList.svelte';
  import { hint } from './shortcuts.ts';
  import { filterForList, pinnedCount, type NoteMeta } from '../core/notes/model.ts';
  import { noteSort } from './state/noteSort.svelte.ts';
  import { flattenTree, visibleRows, type FolderNode } from '../core/notes/folders.ts';
  import {
    DRAG_MIME,
    KIND_MIME,
    decodeDrag,
    dropVerdict,
    encodeDrag,
    kindFromTypes,
    type DragSource,
  } from './dragDrop.ts';
  import { drag } from './state/drag.svelte.ts';
  import type { TagCount } from '../core/search/index.ts';
  import { tagTree } from '../core/notes/tags.ts';

  interface Props {
    notes: readonly NoteMeta[];
    /** The nested tree; the sidebar flattens it, skipping collapsed branches. */
    folders: readonly FolderNode[];
    collapsed: ReadonlySet<string>;
    selectedId: string | null;
    /** Notes open in a tile, when more than one is. */
    tiledIds?: ReadonlySet<string> | undefined;
    activeFolderId: string | null;
    /** Every inline `#tag`, once the search index has read the notes. */
    tags: readonly TagCount[];
    /** The tag the list is filtered by, if any. Exclusive with a folder. */
    activeTag: string | null;
    /** The notes carrying `activeTag`, from the index. Null while asking. */
    tagNoteIds: ReadonlySet<string> | null;
    onSelectTag: (key: string) => void;
    countByFolder: Map<string | null, number>;
    onSelect: (id: string) => void;
    /** The note row's `⋯`, with the button's rect for the menu to anchor to. */
    onMore: (id: string, anchor: DOMRect) => void;
    /** The note, and the folder, whose `⋯` menu is open. */
    menuOpenId?: string | null;
    folderMenuOpenId?: string | null;
    /** Absent where tiling is unavailable (a phone). */
    onTile?: ((id: string) => void) | undefined;
    onTogglePin: (id: string) => void;
    onDelete: (id: string) => void;
    onSelectFolder: (id: string | null) => void;
    onAddFolder: () => void;
    onAddSubfolder: (parentId: string) => void;
    onFolderActions: (id: string, anchor: DOMRect) => void;
    /** Opens export and import. */
    onPortability: () => void;
    /** Opens Recently deleted. */
    onRecentlyDeleted: () => void;
    /**
     * Opens the list of published share links.
     *
     * Deliberately not gated on being signed in. The dialog explains both the
     * no-backend and the no-account cases itself (`share.ts`'s
     * `unavailableReason`), and a control that vanishes is worse than one that
     * tells you why it cannot help — which is how this ended up reachable only
     * from the keyboard the first time round.
     */
    onSharedLinks: () => void;
    /** The notes header's sort control, with its button's rect to anchor to. */
    onSortNotes: (anchor: DOMRect) => void;
    onToggleFolder: (id: string, collapsed: boolean) => void;
    onExitList?: () => void;
    onActiveNoteChange?: (id: string | null) => void;
    /**
     * A note or a folder was dropped on a folder row. Both are actions, so
     * they leave as callbacks — the sidebar never writes (see `mobile/index.ts`
     * for the rule this follows).
     */
    onDropNote?: ((id: string, folderId: string | null) => void) | undefined;
    onDropFolder?: ((id: string, parentId: string | null) => void) | undefined;
    /** Whether `id` may be re-parented under `parentId`; `canMoveFolder`. */
    canMoveFolder?: ((id: string, parentId: string | null) => boolean) | undefined;
    /** A note's current folder, for deciding whether a drop would change anything. */
    folderOfNote?: ((id: string) => string | null) | undefined;
    /** A folder's current parent, for the same reason. */
    parentOfFolder?: ((id: string) => string | null) | undefined;
  }

  let {
    notes,
    folders,
    collapsed,
    selectedId,
    tiledIds,
    activeFolderId,
    tags,
    activeTag,
    tagNoteIds,
    onSelectTag,
    countByFolder,
    onSelect,
    onMore,
    menuOpenId = null,
    folderMenuOpenId = null,
    onTile,
    onTogglePin,
    onDelete,
    onSelectFolder,
    onAddFolder,
    onAddSubfolder,
    onFolderActions,
    onPortability,
    onRecentlyDeleted,
    onSharedLinks,
    onSortNotes,
    onToggleFolder,
    onExitList,
    onActiveNoteChange,
    onDropNote,
    onDropFolder,
    canMoveFolder,
    folderOfNote,
    parentOfFolder,
  }: Props = $props();

  let list = $state<{ focusList: () => void }>();

  export function focusList(): void {
    list?.focusList();
  }

  /**
   * Indentation stops growing past this depth. The tree may go deeper, but a
   * 260px column spent on whitespace leaves no room for the name; the tooltip
   * carries the full path instead.
   */
  const MAX_INDENT_DEPTH = 6;

  const rows = $derived(visibleRows(folders, collapsed));

  /** `Code / Rust / Async` for every folder, built in one pass: parents precede children. */
  const paths = $derived.by(() => {
    const out = new Map<string, string>();
    for (const f of flattenTree(folders)) {
      const parent = f.parentId ? out.get(f.parentId) : undefined;
      out.set(f.id, parent ? `${parent} / ${f.name}` : f.name);
    }
    return out;
  });

  let foldersEl = $state<HTMLUListElement>();

  /**
   * Dropping a note or a folder on a folder row.
   *
   * One set of handlers on the `<ul>`, never one per row. The folder list is
   * not virtualized, so this is not the survival trick it is in `NoteList` —
   * it is simply that a tree of any size should cost a fixed number of
   * listeners.
   *
   * Everything that is not our drag is ignored *without* calling
   * `preventDefault`, which is what lets a file drag fall straight through to
   * the capture-phase window handlers in `App.svelte` that own import. The two
   * never negotiate: their formats do not overlap (`dragDrop.ts`).
   *
   * The id cannot be read until the drop — browsers expose only the format
   * *names* during `dragover` — so the kind travels as its own empty entry and
   * the verdict is recomputed once the id finally arrives.
   */
  function targetOf(event: DragEvent): { folderId: string | null } | null {
    const el = event.target instanceof Element ? event.target.closest('[data-drop-target]') : null;
    if (!(el instanceof HTMLElement)) return null;
    // `dropFolderId`, not `folderId`: the row's button already owns
    // `data-folder-id` and `focusFolder` resolves it by querySelector, where
    // this wrap — an ancestor — would otherwise win and swallow the focus.
    return { folderId: el.dataset.dropFolderId ?? null };
  }

  /** The verdict for a drag whose id we may not know yet. */
  function verdictFor(source: DragSource, folderId: string | null): ReturnType<typeof dropVerdict> {
    if (source.kind === 'folder') {
      return dropVerdict(source, folderId, {
        currentFolderId: parentOfFolder?.(source.id) ?? null,
        canMove: canMoveFolder?.(source.id, folderId) ?? false,
      });
    }
    return dropVerdict(source, folderId, {
      currentFolderId: folderOfNote?.(source.id) ?? null,
      canMove: true,
    });
  }

  /**
   * A folder row is itself draggable. `draggable` goes on the `.folder-wrap`
   * rather than the `.folder` button for the reason `NoteList` gives: Safari
   * and Firefox will not begin a drag from a `<button>`.
   *
   * The twisty is excluded — it is a tap that opens a branch, and a drag begun
   * on it would make expanding a deep tree a game of precision.
   */
  function onFoldersDragStart(event: DragEvent): void {
    if (!event.dataTransfer) return;
    if (event.target instanceof Element && event.target.closest('.twisty, .row-action')) {
      event.preventDefault();
      return;
    }
    const el = event.target instanceof Element ? event.target.closest('[data-drop-folder-id]') : null;
    const id = el instanceof HTMLElement ? el.dataset.dropFolderId : undefined;
    if (!id) {
      // The "All notes" row is a destination, never a thing to move.
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_MIME, encodeDrag({ kind: 'folder', id }));
    event.dataTransfer.setData(KIND_MIME.folder, '');
    drag.begin({ kind: 'folder', id });
  }

  function onFoldersDragOver(event: DragEvent): void {
    const kind = kindFromTypes(event.dataTransfer?.types ?? []);
    if (!kind) return;

    const target = targetOf(event);
    if (!target) {
      drag.over(undefined);
      return;
    }

    // Mid-flight the id is unreadable, so the live source is the only way to
    // know what is being dragged. A drag begun in another tab or window has
    // none, and is declined rather than guessed at.
    const source = drag.source;
    const verdict = source ? verdictFor(source, target.folderId) : 'forbidden';

    drag.over(target.folderId, {
      invalid: verdict === 'forbidden',
      // Only a real folder can spring open, and only for a drop it would take.
      springable: verdict !== 'forbidden',
      folders: springFolders,
    });
    if (foldersEl) drag.edgeScroll(foldersEl, event.clientY);

    if (verdict !== 'move') {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    // Only now is the drop allowed to happen at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function onFoldersDragLeave(event: DragEvent): void {
    if (!kindFromTypes(event.dataTransfer?.types ?? [])) return;
    // `relatedTarget` is null when the drag leaves the window entirely — the
    // same escape the file-drop handler uses.
    if (event.relatedTarget === null || !foldersEl?.contains(event.relatedTarget as Node)) {
      drag.over(undefined);
    }
  }

  function onFoldersDrop(event: DragEvent): void {
    if (!kindFromTypes(event.dataTransfer?.types ?? [])) return;
    const target = targetOf(event);
    if (!target) return;

    const source = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? '');
    if (!source) return;
    event.preventDefault();

    // Re-checked against the id we could not see during dragover.
    if (verdictFor(source, target.folderId) !== 'move') return;
    if (source.kind === 'note') onDropNote?.(source.id, target.folderId);
    else onDropFolder?.(source.id, target.folderId);
  }

  /** `folderTree.expand` prunes against this, so it wants the flat list. */
  const springFolders = $derived(flattenTree(folders));

  function focusFolder(id: string): void {
    foldersEl?.querySelector<HTMLButtonElement>(`[data-folder-id="${CSS.escape(id)}"]`)?.focus();
  }

  /**
   * The file-manager convention: → opens a closed branch or steps into an open
   * one; ← closes an open branch or steps out to the parent. ↑/↓ move between
   * visible rows, so none of it needs the pointer.
   */
  function onFolderKeydown(event: KeyboardEvent, folder: FolderNode): void {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const isCollapsed = collapsed.has(folder.id);
    if (event.key === 'ArrowRight' && folder.hasChildren) {
      event.preventDefault();
      if (isCollapsed) onToggleFolder(folder.id, false);
      else if (folder.children[0]) focusFolder(folder.children[0].id);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (folder.hasChildren && !isCollapsed) onToggleFolder(folder.id, true);
      else if (folder.parentId && paths.has(folder.parentId)) focusFolder(folder.parentId);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...(foldersEl?.querySelectorAll<HTMLButtonElement>('button.folder') ?? [])];
      const at = buttons.indexOf(event.currentTarget as HTMLButtonElement);
      buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  }

  // Pins lead whichever list is showing: every pin under All notes, a folder's
  // or a tag's own pins inside it. Filter first, so ordering sees only those.
  const visible = $derived(
    filterForList(notes, { activeTag, tagNoteIds, activeFolderId, sort: noteSort.current }),
  );

  // Frozen `teksto:` prefix, like every other localStorage key (docs/security.md).
  const TAGS_COLLAPSED_KEY = 'teksto:tags-collapsed';
  let tagsCollapsed = $state(readTagsCollapsed());

  function readTagsCollapsed(): boolean {
    try {
      return localStorage.getItem(TAGS_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function toggleTags(): void {
    tagsCollapsed = !tagsCollapsed;
    try {
      localStorage.setItem(TAGS_COLLAPSED_KEY, tagsCollapsed ? '1' : '0');
    } catch {
      // A private window may refuse; the section still toggles for now.
    }
  }

  const tagRows = $derived(tagTree(tags).map((row) => ({ ...row.tag, depth: row.depth, name: row.name })));

  let tagsEl = $state<HTMLUListElement>();

  function onTagKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(tagsEl?.querySelectorAll<HTMLButtonElement>('button.folder') ?? [])];
    const at = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  }

  const activeTagLabel = $derived(tags.find((t) => t.key === activeTag)?.label ?? activeTag);
  const pinned = $derived(pinnedCount(visible));
</script>

<nav id="sidebar-nav" class="sidebar" aria-label="Notes and folders">
  <section class="section">
    <header class="section-head">
      <h2>Folders</h2>
      <span class="head-actions">
        <button type="button" class="icon" onclick={onRecentlyDeleted} title="Recently deleted notes{hint('recently-deleted')}" aria-label="Recently deleted notes">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
          </svg>
        </button>
        <button type="button" class="icon" onclick={onPortability} title="Export (back up) or import notes{hint('export-import')}" aria-label="Export (back up) or import notes">⇅</button>
        <button type="button" class="icon" onclick={onSharedLinks} title="Shared links{hint('shared-links')}" aria-label="Shared links">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" />
            <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
          </svg>
        </button>
        <button type="button" class="icon" onclick={onAddFolder} title="New folder{hint('new-folder')}" aria-label="New folder">+</button>
      </span>
    </header>

    <ul
      class="folders"
      bind:this={foldersEl}
      ondragstart={onFoldersDragStart}
      ondragover={onFoldersDragOver}
      ondragleave={onFoldersDragLeave}
      ondrop={onFoldersDrop}
    >
      <li>
        <div
          class="folder-wrap"
          class:active={activeFolderId === null && activeTag === null}
          class:drop-over={drag.isOver(null) && !drag.invalid}
          class:drop-invalid={drag.isOver(null) && drag.invalid}
          data-drop-target
        >
          <span class="twisty-gap" aria-hidden="true"></span>
          <button
            type="button"
            class="folder"
            class:active={activeFolderId === null && activeTag === null}
            onclick={() => onSelectFolder(null)}
          >
            <span class="folder-name">All notes</span>
            <span class="count">{notes.length}</span>
          </button>
        </div>
      </li>
      {#each rows as folder (folder.id)}
        {@const isCollapsed = collapsed.has(folder.id)}
        <li>
          <div
            class="folder-wrap"
            class:active={activeFolderId === folder.id}
            class:drop-over={drag.isOver(folder.id) && !drag.invalid}
            class:drop-invalid={drag.isOver(folder.id) && drag.invalid}
            draggable="true"
            data-drop-target
            data-drop-folder-id={folder.id}
            style:padding-left="{Math.min(folder.depth, MAX_INDENT_DEPTH) * 14}px"
          >
            {#if folder.hasChildren}
              <!-- Out of the Tab order: the arrow keys on the row do the same
                   thing, and a second stop per folder doubles the walk. -->
              <button
                type="button"
                class="twisty"
                class:open={!isCollapsed}
                tabindex="-1"
                aria-label="{isCollapsed ? 'Expand' : 'Collapse'} {folder.name}"
                onclick={() => onToggleFolder(folder.id, !isCollapsed)}
              >
                <span aria-hidden="true">▸</span>
              </button>
            {:else}
              <span class="twisty-gap" aria-hidden="true"></span>
            {/if}
            <button
              type="button"
              class="folder"
              class:active={activeFolderId === folder.id}
              data-folder-id={folder.id}
              title={paths.get(folder.id)}
              aria-expanded={folder.hasChildren ? !isCollapsed : undefined}
              onclick={() => onSelectFolder(folder.id)}
              onkeydown={(event) => onFolderKeydown(event, folder)}
            >
              <span class="folder-name">{folder.name}</span>
              <span class="count">{countByFolder.get(folder.id) ?? 0}</span>
            </button>
            <!-- Same hover-reveal as the note rows: the count steps aside so
                 the two never overlap, and the controls stay out of sight
                 until the row is reached. -->
            <div class="actions">
              <button
                type="button"
                class="row-action"
                title="New subfolder{hint('new-subfolder')}"
                aria-label="New subfolder in {folder.name}"
                onclick={() => onAddSubfolder(folder.id)}
              >
                +
              </button>
              <button
                type="button"
                class="row-action more"
                title="Rename, move or delete"
                aria-label="More actions for folder {folder.name}"
                aria-haspopup="dialog"
                aria-expanded={folder.id === folderMenuOpenId}
                data-folder-id={folder.id}
                onclick={(event) =>
                  onFolderActions(folder.id, event.currentTarget.getBoundingClientRect())}
              >
                ⋯
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  </section>

  {#if tags.length > 0}
    <!-- Appears once the index has read the notes, and not before: tags live
         in note text, so there is nothing honest to show until then. -->
    <section class="section">
      <header class="section-head">
        <button
          type="button"
          class="section-toggle"
          aria-expanded={!tagsCollapsed}
          aria-controls="sidebar-tags"
          title="{tagsCollapsed ? 'Show' : 'Hide'} tags"
          onclick={toggleTags}
        >
          <span class="twisty-mark" class:open={!tagsCollapsed} aria-hidden="true">▸</span>
          <h2>Tags</h2>
        </button>
      </header>
      {#if !tagsCollapsed}
        <ul class="folders tags" id="sidebar-tags" bind:this={tagsEl}>
          {#each tagRows as tag (tag.key)}
            <li>
              <div
                class="folder-wrap"
                class:active={activeTag === tag.key}
                style:padding-left="{Math.min(tag.depth, MAX_INDENT_DEPTH) * 14}px"
              >
                <span class="twisty-gap" aria-hidden="true"></span>
                <button
                  type="button"
                  class="folder"
                  class:active={activeTag === tag.key}
                  aria-current={activeTag === tag.key ? 'true' : undefined}
                  title="#{tag.label}"
                  onclick={() => onSelectTag(tag.key)}
                  onkeydown={onTagKeydown}
                >
                  <span class="folder-name"><span class="hash" aria-hidden="true">#</span>{tag.name}</span>
                  <span class="count">{tag.count}</span>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <section class="section grow">
    <header class="section-head">
      <!-- The unfiltered heading has always named the order — it said "Recent"
           before there was a choice — so it keeps doing that rather than going
           quiet at "Notes". Inside a folder or a tag the name is the heading;
           the button is the only place the order shows there. -->
      <h2>
        {#if activeTag !== null}#{activeTagLabel}{:else}{activeFolderId === null ? noteSort.heading : 'Notes'}{/if}
      </h2>
      <span class="head-actions">
        <!-- The rect, not the element: `RowActions` anchors to a measurement
             taken at click time. This button does not get virtualized away, but
             passing the element would be a second convention for one menu. -->
        <button
          type="button"
          class="icon"
          onclick={(event) => onSortNotes(event.currentTarget.getBoundingClientRect())}
          title="Sort the note list{hint('sort-notes')}"
          aria-label="Sort the note list"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M3 4h7M3 8h5M3 12h3" />
            <path d="M12 3.5v9M10 10.5l2 2 2-2" />
          </svg>
        </button>
      </span>
    </header>
    <!-- NoteList owns its own scroll viewport: virtualization needs to know
         the scroll offset, so wrapping it in another scroller would break it. -->
    <div class="fill">
      <NoteList
        bind:this={list}
        notes={visible}
        {selectedId}
        {tiledIds}
        {onSelect}
        {onMore}
        {menuOpenId}
        {onTile}
        {onTogglePin}
        {onDelete}
        pinnedCount={pinned}
        dateField={noteSort.dateField}
        onExit={onExitList}
        onActiveChange={onActiveNoteChange}
      />
    </div>
  </section>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }

  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section.grow {
    flex: 1;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 4px;
  }

  h2 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .icon {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 16px;
    line-height: 1;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
  }

  .head-actions {
    display: flex;
    gap: 2px;
  }

  /* Every inline glyph in this row, not just the first one that needed it. */
  .icon svg {
    display: block;
    margin: auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon:hover {
    background: var(--bg-raised);
    color: var(--text);
  }

  /* A deep tree must not push the note list off the bottom: past this the
     folders scroll on their own. */
  .folders {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    max-height: 40vh;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .folder {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    text-align: left;
    padding: 5px 12px 5px 2px;
    min-height: 32px;
    cursor: pointer;
  }

  .folder-wrap:hover {
    background: var(--bg-raised);
  }

  .folder:hover {
    color: var(--text);
  }

  /* The expander, and the same width of nothing on a row without one, so
     names line up by depth whether or not a folder has children. */
  .twisty,
  .twisty-gap {
    flex: 0 0 auto;
    width: 22px;
    align-self: stretch;
  }

  .twisty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0 0 4px;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 13px;
    cursor: pointer;
  }

  .twisty span {
    transition: transform 0.12s ease;
  }

  .twisty.open span {
    transform: rotate(90deg);
  }

  .twisty:hover {
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    .twisty span {
      transition: none;
    }
  }

  .folder:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .folder.active {
    color: var(--text);
    font-weight: 600;
  }

  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-wrap {
    position: relative;
    display: flex;
    align-items: stretch;
  }

  /* The drop affordance. Two rules, existing tokens, no extra element: every
     `.css` asset is charged to `bench/size.mjs`'s eager budget whether or not
     the code that uses it is lazy. The outline is inset so it reads as the row
     lighting up rather than the row growing, which would shift the tree. */
  .folder-wrap.drop-over {
    background: var(--bg-raised);
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 4px;
  }

  /* Refused — a folder dropped into itself. The cursor already says `none`;
     this stops the row looking like it is offering to take the drop. */
  .folder-wrap.drop-invalid {
    outline: 2px dashed var(--text-faint);
    outline-offset: -2px;
    border-radius: 4px;
  }

  /* One positioned row for both controls, so adding a second one cannot drift
     out of alignment with the first the way two independent offsets would. */
  .actions {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
  }

  .row-action {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-faint);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
  }

  .folder-wrap:hover .row-action,
  .row-action:focus-visible,
  /* The pointer leaves the row on its way into the menu the `⋯` just opened,
     so without this the button it is anchored to fades out from under it. */
  .row-action[aria-expanded='true'] {
    opacity: 1;
  }

  /* Only while the controls are actually showing — keyboard-focusing the
     folder itself reveals nothing, so the count should stay put. */
  .folder-wrap:hover .count,
  .folder-wrap:has(.row-action:focus-visible) .count,
  .folder-wrap:has(.row-action[aria-expanded='true']) .count {
    visibility: hidden;
  }

  .row-action:hover {
    background: var(--bg);
    color: var(--text);
  }

  /* A hover-revealed control is invisible and unreachable on a touch screen,
     so show it always there with a full-size touch target (§19). */
  @media (hover: none) {
    .row-action {
      opacity: 1;
      width: 44px;
      height: 44px;
    }

    /* Permanently visible here, so the count moves aside for good rather
       than blinking out on touch. Two 44px controls, so twice the space. */
    .folder {
      padding-right: 96px;
    }

    .folder-wrap:hover .count {
      visibility: visible;
    }
  }

  .count {
    color: var(--text-faint);
    font-size: 12px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .fill {
    flex: 1;
    min-height: 0;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: -2px 0 -2px -4px;
    padding: 2px 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }

  .section-toggle:hover h2 {
    color: var(--text-dim);
  }

  .section-toggle:focus-visible {
    outline: 2px solid var(--accent);
  }

  .twisty-mark {
    color: var(--text-faint);
    font-size: 10px;
    transition: transform 0.12s ease;
  }

  .twisty-mark.open {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .twisty-mark {
      transition: none;
    }
  }

  /* Tags and folders share one column; neither may crowd out the notes. */
  .tags {
    max-height: 25vh;
  }

  .hash {
    color: var(--text-faint);
    margin-right: 1px;
  }

  /* No per-row controls on a tag, so the touch padding folders need for
     theirs would only cut the name short. */
  @media (hover: none) {
    .tags .folder {
      padding-right: 12px;
    }
  }
</style>
