<script lang="ts">
  /**
   * Virtualized note list (§27: "do not render thousands of note DOM elements
   * unnecessarily").
   *
   * Rows are a fixed height, so the visible window is arithmetic rather than
   * measurement: a spacer of `count * ROW_HEIGHT` gives the scrollbar the right
   * size and only the rows on screen exist in the DOM. Spike 3 rendered 18
   * nodes for 10,000 notes this way.
   *
   * Below `VIRTUALIZE_ABOVE` rows everything is rendered directly — the
   * absolute positioning virtualization needs is not free, and a 40-note list
   * gains nothing from it.
   *
   * Keyboard navigation (⌘J L) moves an `aria-activedescendant` highlight
   * rather than focus between row buttons. Focus has to live on something that
   * always exists, and under virtualization the active row may not: it is
   * scrolled into the window by arithmetic, and the DOM catches up.
   */
  import { untrack } from 'svelte';
  import { hint } from './shortcuts.ts';
  import type { NoteMeta } from '../core/notes/model.ts';
  import { relativeTime } from './format.ts';
  import { DRAG_MIME, KIND_MIME, encodeDrag } from './dragDrop.ts';
  import { drag } from './state/drag.svelte.ts';
  import {
    begin as swipeBegin,
    move as swipeMove,
    release as swipeRelease,
    suppressesClick,
    COMMIT_PX,
    type SwipeState,
  } from './rowSwipe.ts';

  interface Props {
    notes: readonly NoteMeta[];
    selectedId: string | null;
    tiledIds?: ReadonlySet<string> | undefined;
    onSelect: (id: string) => void;
    /**
     * Everything a row can do bar pinning, in the `⋯` menu (`RowActions`). The
     * rect travels with the id because the menu anchors to the button, and a
     * virtualized row can be destroyed before anyone could measure it again.
     */
    onMore: (id: string, anchor: DOMRect) => void;
    /** The row whose `⋯` menu is open, so the button stays lit under it. */
    menuOpenId?: string | null;
    /** Kept as props for the keyboard path alone: ⌘Enter tiles, Delete deletes. */
    onTile?: ((id: string) => void) | undefined;
    onTogglePin: (id: string) => void;
    onDelete: (id: string) => void;
    /**
     * How many leading notes are pinned (`orderForList`). The list marks them
     * and draws a divider under the last, without a header row: every row is
     * the same height, and the virtual window depends on it.
     */
    pinnedCount?: number;
    /** Escape, or a note opened with Enter: hand the keyboard back to the editor. */
    onExit?: (() => void) | undefined;
    /** The highlighted note while the list has focus, else null. */
    onActiveChange?: ((id: string | null) => void) | undefined;
    /**
     * Row height in pixels. A prop rather than a constant because the phone
     * shows three lines where the sidebar shows two — but it must stay a
     * single value per render, because the virtual window is arithmetic over
     * it, not measurement. The CSS reads the same number through `--row-h`.
     */
    rowHeight?: number;
    /**
     * `phone` adds the excerpt and meta lines. It is a variant rather than a
     * media query because it changes the DOM, and the desktop sidebar's rows
     * must keep the markup they have — several benches select into them.
     */
    variant?: 'sidebar' | 'phone';
    /** Folder id → name, for the phone meta line. Built once by the caller. */
    folderNames?: ReadonlyMap<string, string>;
    /**
     * Which timestamp a row shows — the one the list is ordered by.
     *
     * A prop rather than a read of `noteSort`, because this component is
     * deliberately order-agnostic: it takes an ordered array and a count of
     * leading pins, and reaching for the sort store here would make it a second
     * place that knows what the order is. Under a title sort the edit date is
     * still the useful one, so only `created` changes it.
     */
    dateField?: 'updatedAt' | 'createdAt';
  }

  /** What the sidebar uses, and the fallback baked into the CSS. */
  const DEFAULT_ROW_HEIGHT = 44;

  let {
    notes,
    selectedId,
    tiledIds,
    onSelect,
    onMore,
    menuOpenId = null,
    onTile,
    onTogglePin,
    onDelete,
    pinnedCount = 0,
    onExit,
    onActiveChange,
    rowHeight = DEFAULT_ROW_HEIGHT,
    variant = 'sidebar',
    folderNames,
    dateField = 'updatedAt',
  }: Props = $props();

  /** A pushpin, drawn rather than an emoji so it takes the text colour and fill. */
  const PIN_PATH = 'M5.5 1.5h5l-.8 4.2 2.3 2.3v1.5H8.6V14L8 15l-.6-1V9.5H4v-1.5l2.3-2.3z';

  const OVERSCAN = 4;
  const VIRTUALIZE_ABOVE = 100;

  let viewport = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  const ROW_HEIGHT = $derived(rowHeight);

  /**
   * Dragging a note onto a folder row in the sidebar.
   *
   * One delegated listener, like the swipe below and for the same reason: a
   * virtualized row is destroyed on every scroll frame, so `draggable` is an
   * attribute on the `<li>` but the handler belongs to the `<ul>` that
   * outlives it. The attribute costs no node, so `bench/scale.mjs`'s count of
   * `.list .row` is untouched.
   *
   * It goes on the `<li>` rather than the `.row` button because Safari and
   * Firefox will not start a drag from a `<button>` however it is marked.
   *
   * Nothing is offered as `text/plain`: `dragDrop.ts` says why, and the
   * absence is what stops a note dragged across the editor from being typed
   * into it.
   *
   * Phone-only surfaces are excluded outright — below 720px there is no folder
   * tree to drop onto (§21), and the row already owns a touch gesture.
   */
  function onRowDragStart(event: DragEvent): void {
    if (variant === 'phone' || !event.dataTransfer) return;
    const el = event.target instanceof Element ? event.target.closest('li[data-note-id]') : null;
    const id = el instanceof HTMLElement ? el.dataset.noteId : undefined;
    if (!id) return;

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_MIME, encodeDrag({ kind: 'note', id }));
    // Empty, and read from `types` alone: a drop target may not call
    // `getData` until the drop itself.
    event.dataTransfer.setData(KIND_MIME.note, '');
    drag.begin({ kind: 'note', id });
  }

  /**
   * The row height handed to CSS. Omitted entirely at the default, so the
   * desktop sidebar renders the same DOM it always has — the CSS falls back to
   * the same 44px through `var(--row-h, 44px)`.
   */
  /**
   * Swipe to pin or delete (phone only).
   *
   * The listeners are delegated to the `<ul>`, not bound per row, and that is
   * the whole reason this works under virtualization: rows are created and
   * destroyed on every scroll frame, so a per-row listener would be re-bound
   * constantly, while the list element outlives all of them. The row in play
   * is identified by note id for the same reason — the node it started on may
   * simply not exist by the time the gesture ends.
   *
   * The offset is written straight onto the element rather than through
   * `$state`: this runs on every pointermove, and a rune write would schedule
   * Svelte's whole graph 60 times a second on a phone.
   */
  let swipe: SwipeState | null = null;
  let swipeEl: HTMLElement | null = null;
  let swipePointer: number | null = null;
  let suppressClick = false;

  /** Forget the gesture and put the row back. Safe to call twice. */
  function endSwipe(el: HTMLElement | null, animate: boolean): void {
    if (swipePointer !== null && listEl?.hasPointerCapture(swipePointer)) {
      listEl.releasePointerCapture(swipePointer);
    }
    swipePointer = null;
    swipe = null;
    swipeEl = null;
    resetRow(el, animate);
  }

  /** The element that slides: the row and its controls, over the plates. */
  function rowElementFor(target: EventTarget | null): HTMLElement | null {
    const el = target instanceof Element ? target.closest('.row-wrap') : null;
    return el instanceof HTMLElement ? el : null;
  }

  function paint(dx: number): void {
    if (!swipeEl) return;
    swipeEl.style.transition = '';
    swipeEl.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
    const li = swipeEl.parentElement;
    li?.classList.toggle('swipe-pin', dx >= COMMIT_PX);
    li?.classList.toggle('swipe-delete', dx <= -COMMIT_PX);
    li?.classList.toggle('swiping', dx !== 0);
  }

  /** Put the row back where it belongs, immediately and with no animation. */
  function resetRow(el: HTMLElement | null, animate: boolean): void {
    if (!el) return;
    el.style.transition = animate ? 'transform 160ms' : '';
    el.style.transform = '';
    el.parentElement?.classList.remove('swiping', 'swipe-pin', 'swipe-delete');
  }

  function onRowPointerDown(event: PointerEvent): void {
    if (variant !== 'phone' || event.pointerType === 'mouse') return;
    // Never start a gesture on the pin or the `⋯`: those are taps.
    if (event.target instanceof Element && event.target.closest('.row-action')) return;
    const el = rowElementFor(event.target);
    const id = el?.parentElement?.dataset.noteId;
    if (!el || !id) return;
    resetRow(el, false);
    swipeEl = el;
    swipePointer = event.pointerId;
    swipe = swipeBegin(id, event.clientX, event.clientY);
  }

  function onRowPointerMove(event: PointerEvent): void {
    if (!swipe) return;
    const next = swipeMove(swipe, event.clientX, event.clientY);
    if (next === swipe) return;
    swipe = next;
    if (swipe.phase === 'scrolling') {
      // Not ours after all. Hand the gesture back untouched.
      endSwipe(swipeEl, false);
      return;
    }
    if (swipe.phase === 'swiping') {
      // Capture on the list — which outlives every row — the moment the
      // gesture is ours. Without it a finger that slides off the list (onto
      // the tab bar, or past the left edge) stops delivering here, and the row
      // is left sitting translated with no pointerup ever arriving. Taken at
      // the claim rather than at pointerdown, so a tap or a scroll is never
      // captured.
      if (swipePointer !== null && listEl && !listEl.hasPointerCapture(swipePointer)) {
        listEl.setPointerCapture(swipePointer);
      }
      paint(swipe.dx);
    }
  }

  function onRowPointerUp(): void {
    const state = swipe;
    const el = swipeEl;
    const action = swipeRelease(state);
    suppressClick = suppressesClick(state);

    // Cleared *before* the action runs. The `{#each}` is keyed, so pinning
    // moves this very node to the top of the list — and it would arrive there
    // still translated sideways if the transform were left on it.
    endSwipe(el, action === null);

    if (!action || !state) return;
    if (action === 'pin') onTogglePin(state.id);
    else onDelete(state.id);
  }

  /** Swallow the click a committed swipe would otherwise end with. */
  function onRowClickCapture(event: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  const rowHeightStyle = $derived(
    rowHeight === DEFAULT_ROW_HEIGHT ? {} : { style: `--row-h: ${rowHeight}px` },
  );

  const virtualized = $derived(notes.length > VIRTUALIZE_ABOVE);

  const range = $derived.by(() => {
    if (!virtualized) return { start: 0, end: notes.length };
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil((viewportHeight || 600) / ROW_HEIGHT) + OVERSCAN * 2;
    return { start: first, end: Math.min(notes.length, first + visible) };
  });

  const windowed = $derived(notes.slice(range.start, range.end));

  let listEl = $state<HTMLUListElement>();
  let listFocused = $state(false);
  let activeIndex = $state(-1);
  const activeNote = $derived(listFocused ? notes[activeIndex] : undefined);

  $effect(() => {
    onActiveChange?.(activeNote?.id ?? null);
  });

  /**
   * The note the highlight is on, so it can follow that note when the list
   * reorders under it. Pinning from the keyboard moves the note to the top;
   * an index-only highlight would silently land on whatever took its place,
   * and the next Delete would take the wrong note.
   */
  let followId: string | null = null;

  $effect.pre(() => {
    const list = notes;
    const at = untrack(() => activeIndex);
    if (followId !== null && list[at]?.id !== followId) {
      const found = list.findIndex((n) => n.id === followId);
      if (found !== -1) {
        activeIndex = found;
        untrack(scrollToActive);
        return;
      }
    }
    // Deleting the last row, or switching folder, can leave the index past the end.
    if (at >= list.length) activeIndex = list.length - 1;
  });

  /** Put the keyboard on the list, starting from the open note. */
  export function focusList(): void {
    const at = notes.findIndex((n) => n.id === selectedId);
    activeIndex = at === -1 ? 0 : at;
    followId = notes[activeIndex]?.id ?? null;
    scrollToActive();
    listEl?.focus();
  }

  function scrollToActive(): void {
    if (!viewport || activeIndex < 0) return;
    const top = activeIndex * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    }
    scrollTop = viewport.scrollTop;
  }

  function onListKeydown(event: KeyboardEvent): void {
    if (event.target !== listEl || notes.length === 0) return;
    const page = Math.max(1, Math.floor((viewportHeight || 600) / ROW_HEIGHT) - 1);
    const moveTo = (index: number) => {
      event.preventDefault();
      activeIndex = Math.min(notes.length - 1, Math.max(0, index));
      followId = notes[activeIndex]?.id ?? null;
      scrollToActive();
    };
    const note = notes[activeIndex];

    switch (event.key) {
      case 'ArrowDown':
        return moveTo(activeIndex + 1);
      case 'ArrowUp':
        return moveTo(activeIndex - 1);
      case 'PageDown':
        return moveTo(activeIndex + page);
      case 'PageUp':
        return moveTo(activeIndex - page);
      case 'Home':
        return moveTo(0);
      case 'End':
        return moveTo(notes.length - 1);
      case 'Enter':
        if (!note) return;
        event.preventDefault();
        if ((event.metaKey || event.ctrlKey) && onTile) {
          onTile(note.id);
        } else {
          onSelect(note.id);
          onExit?.();
        }
        return;
      case ' ':
        // Open without leaving the list, to read through notes one by one.
        if (!note) return;
        event.preventDefault();
        onSelect(note.id);
        return;
      case 'Delete':
      case 'Backspace':
        if (!note) return;
        event.preventDefault();
        onDelete(note.id);
        return;
      case 'Escape':
        event.preventDefault();
        onExit?.();
        return;
    }
  }

  function onScroll(): void {
    if (viewport) scrollTop = viewport.scrollTop;
  }

  // Keep the window valid when the list shrinks under a scrolled viewport.
  $effect(() => {
    const max = Math.max(0, notes.length * ROW_HEIGHT - (viewportHeight || 0));
    if (scrollTop > max && viewport) {
      viewport.scrollTop = max;
      scrollTop = max;
    }
  });
</script>

<div
  class="viewport"
  class:phone={variant === 'phone'}
  bind:this={viewport}
  bind:clientHeight={viewportHeight}
  onscroll={onScroll}
  {...rowHeightStyle}
>
  {#if notes.length === 0}
    <p class="empty">No notes yet</p>
  {:else}
    <ul
      class="list"
      role="listbox"
      aria-label="Notes"
      tabindex="-1"
      bind:this={listEl}
      aria-activedescendant={activeNote ? `note-opt-${activeNote.id}` : undefined}
      onkeydown={onListKeydown}
      onfocus={() => (listFocused = true)}
      onblur={() => (listFocused = false)}
      ondragstart={onRowDragStart}
      onpointerdown={onRowPointerDown}
      onpointermove={onRowPointerMove}
      onpointerup={onRowPointerUp}
      onpointercancel={onRowPointerUp}
      onclickcapture={onRowClickCapture}
      style:height={virtualized ? `${notes.length * ROW_HEIGHT}px` : undefined}
      style:position={virtualized ? 'relative' : undefined}
    >
      {#each windowed as note, i (note.id)}
        {@const isPinned = note.pinnedAt !== null}
        {@const folderName = note.folderId ? folderNames?.get(note.folderId) : undefined}
        <li
          data-note-id={note.id}
          draggable={variant === 'phone' ? undefined : 'true'}
          style:position={virtualized ? 'absolute' : undefined}
          style:top={virtualized ? `${(range.start + i) * ROW_HEIGHT}px` : undefined}
          style:left={virtualized ? '0' : undefined}
          style:right={virtualized ? '0' : undefined}
        >
          {#if variant === 'phone'}
            <!-- Behind the row, revealed as it slides over them. Outside
                 `.row-wrap`, which is the element that moves. Two extra nodes
                 per row and neither is a `.row`, so `bench/scale.mjs`'s DOM
                 node count is unaffected. -->
            <span class="plate pin-plate" aria-hidden="true">
              <svg viewBox="0 0 16 16"><path d={PIN_PATH} /></svg>
            </span>
            <span class="plate delete-plate" aria-hidden="true">
              <svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
            </span>
          {/if}
          <div class="row-wrap">
            <button
              type="button"
              class="row"
              id="note-opt-{note.id}"
              class:selected={note.id === selectedId}
              class:active={note.id === activeNote?.id}
              class:tiled={note.id !== selectedId && tiledIds?.has(note.id)}
              class:last-pinned={range.start + i === pinnedCount - 1 && pinnedCount < notes.length}
              class:no-excerpt={variant === 'phone' && !note.excerpt}
              role="option"
              aria-selected={note.id === selectedId}
              onclick={() => onSelect(note.id)}
            >
              <span class="title">{note.title}</span>
              {#if variant === 'phone'}
                <!-- Three lines either way. A note written before excerpts
                     existed has none, and its title clamps to two lines
                     instead — same height, so the row looks deliberate
                     rather than half-empty, and the virtual window is
                     undisturbed. -->
                {#if note.excerpt}<span class="excerpt">{note.excerpt}</span>{/if}
                <span class="when">
                  {#if isPinned}<svg class="pin-mark" viewBox="0 0 16 16" aria-hidden="true"><path d={PIN_PATH} /></svg><span class="sr-only">Pinned, </span>{/if}{#if folderName}{folderName} · {/if}{relativeTime(note[dateField])}
                </span>
              {:else}
                <span class="when">
                  {#if isPinned}<svg class="pin-mark" viewBox="0 0 16 16" aria-hidden="true"><path d={PIN_PATH} /></svg><span class="sr-only">Pinned, </span>{/if}{relativeTime(note[dateField])}
                </span>
              {/if}
            </button>
            <!-- Revealed on hover or keyboard focus, so the list stays quiet
                 while still making every action reachable — the same two
                 controls, in the same place, as the folder rows above.

                 The pin is the one that stays out: it is the single-click
                 action, and it is the only one that shows state, so hiding it
                 behind the menu would cost a click to read as well as to set.
                 It is the note row's `+`.

                 Everything else — copy, tile, move, export, history, delete —
                 is one press further in, on `⋯`. They belong to the row rather
                 than the topbar because a topbar control could only ever act
                 on the note that happens to be open; from the row they work on
                 any note in the list. Five of them on the row did not fit:
                 22px each, overlaying the last ~86px of every title, and on a
                 phone reserving 234px of a 240px column. -->
            <div class="actions">
              <button
                type="button"
                class="row-action pin"
                class:on={isPinned}
                title="{isPinned ? 'Unpin note' : 'Pin to top'}{hint('pin-note')}"
                aria-label="{isPinned ? 'Unpin' : 'Pin'} {note.title}"
                aria-pressed={isPinned}
                data-note-id={note.id}
                onclick={() => onTogglePin(note.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d={PIN_PATH} /></svg>
              </button>
              <button
                type="button"
                class="row-action more"
                title="Copy, move, export or delete"
                aria-label="More actions for {note.title}"
                aria-haspopup="dialog"
                aria-expanded={note.id === menuOpenId}
                data-note-id={note.id}
                onclick={(event) => onMore(note.id, event.currentTarget.getBoundingClientRect())}
              >
                ⋯
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .viewport {
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    list-style: none;
  }

  .row-wrap {
    position: relative;
    height: var(--row-h, 44px);
  }

  /* One positioned row for every control, so adding another cannot drift out
     of alignment with the rest the way independent offsets would. */
  .actions {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
  }

  /* Two controls in 54px, the same size and spacing the folder rows use, so a
     note row's pin and `⋯` line up with the folder row's `+` and `⋯` directly
     above them. The strip ends nowhere near the middle of the row, where a
     click means "open". */
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

  /* The revealed controls sit over the last ~60px of a long title rather than
     pushing it aside. Reserving the space permanently costs that much title in
     a 240px column; reserving it only on hover re-runs the ellipsis and makes
     the title twitch. If the overlap ever needs softening, a gradient scrim is
     the escape hatch — it has to match three row backgrounds (--bg,
     --bg-raised on hover, --accent-soft when selected), which is why it is not
     here already. */
  .row-wrap:hover .row-action,
  .row-action:focus-visible,
  /* The pointer leaves the row on its way into the menu the `⋯` just opened,
     so without this the button it is anchored to fades out from under it. */
  .row-action[aria-expanded='true'] {
    opacity: 1;
  }

  /* A hover-revealed control is invisible and unreachable on a touch screen,
     which made deletion impossible on a phone. Show them always there, and
     give each a full-size touch target (§19). */
  @media (hover: none) {
    .row-action {
      opacity: 1;
      width: 44px;
      height: 44px;
    }

    .row {
      /* Leave room so the title never runs under the controls: the 6px offset
         plus two 44px buttons and one 2px gap. The folder rows in Sidebar
         reserve the same 96px for the same two controls. */
      padding-right: 96px;
    }
  }

  .row-action:hover {
    background: var(--bg);
    color: var(--text);
  }

  .row-action svg {
    width: 14px;
    height: 14px;
    vertical-align: middle;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linejoin: round;
  }

  /* Filled when pinned. Revealed like the rest: the marker under the title
     already says the note is pinned, and a control left showing would sit on
     the end of every pinned title. */
  .pin.on {
    color: var(--accent);
  }

  .pin.on svg {
    fill: currentColor;
  }

  .row {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 7px 12px;
    cursor: pointer;
    /* Fixed height is what makes the virtual window arithmetic, and it is a
       comfortable touch target (§19). The variable is written by the component
       only when it is not the default, so the sidebar's rows are untouched;
       whatever it holds must match the `rowHeight` prop the window counts in. */
    height: var(--row-h, 44px);
  }

  .row:hover {
    background: var(--bg-raised);
  }

  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .row.selected {
    background: var(--accent-soft);
  }

  .row.active {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .list:focus {
    outline: none;
  }

  /* Open in another tile: marked, but quieter than the focused note. */
  .row.tiled {
    box-shadow: inset 3px 0 0 var(--accent-soft);
  }

  .title {
    display: block;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.selected .title {
    font-weight: 600;
  }

  .when {
    display: block;
    color: var(--text-faint);
    font-size: 12px;
    margin-top: 1px;
  }

  /* The phone row: title, excerpt, meta — three lines in the height the
     component was told to use. Nothing below touches the sidebar, which keeps
     its two-line 44px row exactly as it was. */
  .viewport.phone .row {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    /* The right reserve is not decoration: it is the 6px offset plus two 44px
       controls and the 2px between them, the same 96px the `hover: none` block
       below sets on the sidebar's rows. It is repeated here because this
       shorthand would otherwise overwrite it — and then the title and excerpt
       run underneath the pin and the `⋯`. */
    padding: 8px 96px 8px 12px;
  }

  .viewport.phone .title {
    font-size: 16px;
    line-height: 1.25;
  }

  /* No excerpt — an older note, or one that is only a heading. The title takes
     the excerpt's line instead of leaving a gap. */
  .viewport.phone .row.no-excerpt .title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: normal;
  }

  .viewport.phone .excerpt {
    display: block;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewport.phone .when {
    font-size: 12px;
    margin-top: 2px;
  }

  /* ---- Swipe to pin or delete (phone) ---------------------------------- */

  /* The single most important line here. It tells the browser that vertical
     pans are its business — so scrolling stays on the compositor with full
     momentum and never waits on JavaScript — while horizontal movement is
     left for the gesture in `rowSwipe.ts` to claim. */
  .viewport.phone .row-wrap {
    touch-action: pan-y;
    background: var(--bg);
    will-change: transform;
  }

  .viewport.phone li {
    position: relative;
    overflow: hidden;
  }

  .viewport.phone .row.selected,
  .viewport.phone li:global(.swiping) .row {
    /* Written with `classList`, not a rune: see the gesture handlers above for
     why this stays off the reactive path. Hence `:global` on the class — the
     compiler cannot see it in the markup. The sliding surface must be opaque
     or the plate behind it shows through. */
    background: var(--accent-soft);
  }

  .viewport.phone li:global(.swiping) .row-wrap {
    background: var(--bg);
  }

  .plate {
    position: absolute;
    top: 0;
    bottom: 0;
    display: grid;
    place-items: center;
    width: 50%;
    color: #fff;
    opacity: 0;
  }

  li:global(.swiping) .plate {
    opacity: 1;
  }

  .plate svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .pin-plate {
    left: 0;
    justify-content: start;
    padding-left: 22px;
    background: var(--accent);
    color: var(--on-accent);
  }

  .pin-plate svg {
    fill: currentColor;
    stroke: none;
  }

  .delete-plate {
    right: 0;
    justify-content: end;
    padding-right: 22px;
    background: var(--danger);
  }

  /* Past the commit point the plate goes solid, so the release is predictable
     rather than a guess about how far is far enough. */
  li:global(.swipe-pin) .pin-plate,
  li:global(.swipe-delete) .delete-plate {
    filter: brightness(1.12);
  }

  .pin-mark {
    width: 10px;
    height: 10px;
    margin-right: 4px;
    vertical-align: -1px;
    fill: var(--accent);
  }

  /* Pinned notes end at a hairline, drawn inside the row so the 44px the
     virtual window counts on does not change. */
  .row.last-pinned {
    box-shadow: inset 0 -1px 0 var(--border);
  }

  .row.last-pinned.tiled {
    box-shadow:
      inset 3px 0 0 var(--accent-soft),
      inset 0 -1px 0 var(--border);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .empty {
    padding: 12px;
    margin: 0;
    color: var(--text-faint);
  }
</style>
