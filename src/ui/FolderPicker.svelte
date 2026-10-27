<script lang="ts">
  /**
   * "Move this note to…" — the folder picker behind the `→` on every note row.
   *
   * Filing used to be a `<select>` in the topbar, which could only ever act on
   * the note that happened to be open and spent width on a bar that is already
   * tight on a phone. The action now lives on the row, where the folder rows
   * already keep rename and delete, so any note in the list can be refiled
   * without opening it first.
   *
   * A centred dialog rather than a popover anchored to the row, for three
   * reasons that are structural rather than stylistic:
   *   - `.sidebar` is `overflow: hidden`, so an absolutely positioned popover
   *     is clipped to a ~260px column.
   *   - `NoteList` virtualizes above 100 notes: rows are absolutely positioned
   *     from `scrollTop` and rows outside the window are destroyed. Anchoring
   *     to one means a scroll listener, a resize listener, flip-up logic near
   *     the viewport edge, and a rule for the anchor vanishing mid-scroll —
   *     a positioning engine, which §12 ("a simple hierarchy, not a document
   *     management system") and §28 both argue against.
   *   - On mobile the list is the whole screen, so an anchored popover
   *     degenerates into a sheet anyway.
   * What that costs is the spatial link to the row, which is bought back by
   * naming the note in the heading — something the `<select>` never did.
   *
   * `RowActions.svelte` — the `⋯` menu this picker is reached from — no longer
   * follows that argument, and its header says why each reason above stops
   * biting at the size of a fixed seven-item menu. This picker stays put: it is
   * 420px of `60vh` scrolling list, so anchoring it means a scroll container
   * inside a popover that may itself have been flipped, which is the
   * positioning engine, not the ten lines that place a menu.
   *
   * No filter input. §12's hierarchy is simple and optional, and a 60vh list
   * scrolls through ~20 folders comfortably; an autofocused input would summon
   * the virtual keyboard over the list on every phone for what is usually a
   * four-item choice (§19). If someone turns up with enough folders to need
   * one, gate it behind a `FILTER_ABOVE` constant the way `NoteList` gates
   * virtualization behind `VIRTUALIZE_ABOVE` — pay for the complexity only
   * past the threshold that makes it matter.
   */
  import type { FolderNode } from '../core/notes/folders.ts';

  interface Props {
    noteTitle?: string;
    /**
     * The same picker doubles as "Go to folder" (⌘J O), where the heading is
     * not about a note and the null row means every note rather than none.
     */
    heading?: string;
    noneLabel?: string;
    noneCount?: number;
    /**
     * Rows shown but not pickable. Moving a folder disables its own subtree,
     * so the user sees where it cannot go rather than wondering where it went.
     */
    disabledIds?: ReadonlySet<string>;
    folders: readonly FolderNode[];
    currentFolderId: string | null;
    countByFolder: Map<string | null, number>;
    onPick: (folderId: string | null) => void;
    onClose: () => void;
  }

  let {
    noteTitle = '',
    heading = `Move “${noteTitle}” to`,
    noneLabel = 'No folder',
    noneCount,
    disabledIds,
    folders,
    currentFolderId,
    countByFolder,
    onPick,
    onClose,
  }: Props = $props();

  interface Row {
    id: string | null;
    name: string;
    depth: number;
    disabled: boolean;
  }

  /**
   * "No folder" is a row, not an afterthought: the old `<option value="">` was
   * the only way to *unfile* a note, and without it filing becomes a one-way
   * door.
   */
  const rows = $derived<Row[]>([
    { id: null, name: noneLabel, depth: 0, disabled: false },
    ...folders.map((f) => ({
      id: f.id as string | null,
      name: f.name,
      depth: f.depth,
      disabled: disabledIds?.has(f.id) ?? false,
    })),
  ]);

  // Start on the note's current folder, so Enter is a no-op rather than a
  // surprise move, and a long list opens scrolled to somewhere meaningful.
  let active = $state(Math.max(0, indexOfCurrent()));
  let listEl = $state<HTMLUListElement>();

  function indexOfCurrent(): number {
    const index = folders.findIndex((f) => f.id === currentFolderId);
    return currentFolderId === null ? 0 : index === -1 ? 0 : index + 1;
  }

  const activeId = $derived(rows[active]?.id);

  $effect(() => {
    listEl?.focus();
  });

  // Keep the highlighted row in view during keyboard navigation.
  $effect(() => {
    const index = active;
    if (!listEl) return;
    listEl.children[index]?.scrollIntoView({ block: 'nearest' });
  });

  function optionId(id: string | null): string {
    return `folder-opt-${id ?? 'none'}`;
  }

  /** Escape works even if focus has drifted off the list. */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  /** The next pickable row in `step`'s direction; the null row always is one. */
  function stepFrom(from: number, step: 1 | -1): number {
    let i = from;
    do i = (i + step + rows.length) % rows.length;
    while (rows[i]?.disabled && i !== from);
    return i;
  }

  function pick(row: Row | undefined): void {
    if (row && !row.disabled) onPick(row.id);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      active = stepFrom(active, 1);
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      active = stepFrom(active, -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(rows[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- Clicking the backdrop itself closes; clicks inside the dialog bubble
     through here but are ignored because the target is not the backdrop. -->
<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="panel" role="dialog" aria-modal="true" aria-label={heading} tabindex="-1">
    <h2 class="head">{heading}</h2>

    <!-- The list itself takes focus: there is no input here to own
         `aria-controls`, so the listbox is the focused element and the
         keyboard-active row is announced through `aria-activedescendant`.

         Note the deliberate divergence from QuickFinder, which puts
         `aria-selected` on the active row: in a picker "selected" means "this
         is where the note lives today", which is a different fact from "this
         is the row the arrow keys are on". Do not collapse the two. -->
    <ul
      class="options"
      role="listbox"
      aria-label="Folders"
      tabindex="0"
      aria-activedescendant={optionId(activeId ?? null)}
      bind:this={listEl}
      onkeydown={onKeydown}
    >
      {#each rows as row, i (row.id ?? '')}
        <li
          id={optionId(row.id)}
          role="option"
          aria-selected={row.id === currentFolderId}
          class="option"
          class:active={i === active}
          aria-disabled={row.disabled || undefined}
        >
          <button
            type="button"
            disabled={row.disabled}
            onclick={() => pick(row)}
            onmousemove={() => {
              if (!row.disabled) active = i;
            }}
          >
            <!-- Fixed-width gutter so names stay aligned whatever the depth. -->
            <span class="tick" aria-hidden="true">{row.id === currentFolderId ? '✓' : ''}</span>
            <span class="name" style:padding-left={`${row.depth * 14}px`}>{row.name}</span>
            <span class="count">{row.id === null && noneCount !== undefined ? noneCount : (countByFolder.get(row.id) ?? 0)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 10vh 16px 16px;
    /* Above the quick finder (50), below the account panel (60). Only one is
       ever open, but the ordering should not be accidental. */
    z-index: 55;
  }

  .panel {
    width: min(420px, 100%);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .head {
    margin: 0;
    padding: 13px 15px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .options {
    list-style: none;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    outline: none;
  }

  .option button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 8px 11px;
    border-radius: 6px;
    cursor: pointer;
    /* Reached by finger straight from the note list, so §19's target size
       applies here rather than the palette's 40. */
    min-height: 44px;
  }

  .option button:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .option.active button {
    background: var(--accent-soft);
  }

  .tick {
    flex: 0 0 auto;
    width: 12px;
    color: var(--text-dim);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .option[aria-selected='true'] .name {
    font-weight: 600;
  }

  .count {
    flex: 0 0 auto;
    color: var(--text-faint);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  /* Reached by thumb from the note list, so it takes the whole screen rather
     than floating 10vh down it. */
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
    }

    .panel {
      width: 100%;
      max-width: none;
      max-height: 100%;
      height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: env(safe-area-inset-top);
    }
  }
</style>
