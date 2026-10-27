<script lang="ts">
  /**
   * The phone's top bar, in place of the desktop `.topbar`.
   *
   * Two modes, because a phone shows one thing at a time and the header should
   * name it:
   *
   * - **list** — the filter button *is* the title. Tapping "All notes" opens
   *   the picker. That replaces the desktop sidebar's permanently-visible
   *   folder tree and Tags section, which on a 412px screen were two scrollers
   *   competing with the list for the same column (§21: do not permanently
   *   reserve large amounts of screen space for navigation).
   * - **editor** — back, the line-wrap toggle (while editing), then the
   *   Edit/Preview control, then the note menu.
   *
   * The view control lives here rather than floating over the text. On desktop
   * it is a 26x22px strip at 55% opacity in the corner of the tile, which is
   * an IntelliJ affordance that works with a mouse and is the smallest target
   * in the app with a thumb. Here each half is a full 44px button.
   *
   * It is `.view-seg`, not `.view-switch`: `bench/preview.mjs` selects
   * `.view-switch button[aria-label=...]` on desktop, and two components
   * answering the same selector is a trap. The `aria-label`s are deliberately
   * the same, because they mean the same thing.
   *
   * `class="back"` is a contract — `bench/phase6.mjs` asserts `button.back` is
   * visible once a note is open.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    mode: 'list' | 'editor';
    /** What the list is filtered to: "All notes", a folder name, or "#tag". */
    filterLabel: string;
    onFilter: () => void;
    onBack: () => void;
    /** Never 'split' — a phone has no split (`viewMode.ts`). */
    viewMode: 'edit' | 'preview';
    onViewMode: (mode: 'edit' | 'preview') => void;
    onNoteMenu: () => void;
    /** The sync indicator, passed in so this file needs no store. */
    sync?: Snippet;
    /**
     * The line-wrap toggle, as values rather than the store for the same
     * reason as `sync`. `wrap` is `'window'`, `'cols'` or `'off'`; the label is
     * the mode in words, for the button's name.
     */
    wrap?: 'window' | 'cols' | 'off';
    wrapLabel?: string;
    onWrap?: () => void;
  }

  let {
    mode,
    filterLabel,
    onFilter,
    onBack,
    viewMode,
    onViewMode,
    onNoteMenu,
    sync,
    wrap = 'window',
    wrapLabel = '',
    onWrap,
  }: Props = $props();
</script>

<header class="phone-head">
  {#if mode === 'editor'}
    <button type="button" class="back" onclick={onBack}>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
      <span>Notes</span>
    </button>

    <div class="spacer"></div>

    <!-- A table on a phone is the case this exists for, so it is one tap from
         the text rather than in a sheet. The measure itself is picked in
         Appearance → Line wrap; this flips between it and the screen edge.
         Hidden in Preview, which renders tables as tables and wraps prose. -->
    {#if onWrap && viewMode === 'edit'}
      <button
        type="button"
        class="icon wrap"
        class:active={wrap !== 'window'}
        aria-pressed={wrap !== 'window'}
        aria-label="Line wrap: {wrapLabel}. Toggle"
        onclick={onWrap}
      >
        {#if wrap === 'off'}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7h17M3.5 12h17M16.5 15l3.5 3-3.5 3M3.5 18h16.5" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6h17M3.5 12h14a3 3 0 0 1 0 6H13M15 16l-2 2 2 2M3.5 18h5" /></svg>
        {/if}
      </button>
    {/if}

    <div class="view-seg" role="group" aria-label="View">
      <button
        type="button"
        class:active={viewMode === 'edit'}
        aria-pressed={viewMode === 'edit'}
        aria-label="Editor only"
        onclick={() => onViewMode('edit')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h3.5L19 7.5 15.5 4 4 15.5z M14 5.5l3.5 3.5" /></svg>
      </button>
      <button
        type="button"
        class:active={viewMode === 'preview'}
        aria-pressed={viewMode === 'preview'}
        aria-label="Preview only"
        onclick={() => onViewMode('preview')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
    </div>

    <button type="button" class="icon" onclick={onNoteMenu} aria-haspopup="dialog" aria-label="Note actions">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="dots">
        <circle cx="5.5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18.5" cy="12" r="1.5" />
      </svg>
    </button>
  {:else}
    <button type="button" class="filter" onclick={onFilter} aria-haspopup="dialog">
      <span class="filter-label">{filterLabel}</span>
      <svg class="chev down" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5 12 15.5 18 9.5" /></svg>
    </button>

    <div class="spacer"></div>

    {@render sync?.()}
  {/if}
</header>

<style>
  .phone-head {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    min-height: 52px;
    padding: 0 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  .spacer {
    flex: 1;
  }

  /* The filter button is the screen's title and its only navigation control,
     so it is sized as a heading rather than as a button. */
  .filter {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 44px;
    max-width: 78%;
    padding: 0 6px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    touch-action: manipulation;
  }

  .filter-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .back {
    display: flex;
    align-items: center;
    gap: 1px;
    min-height: 44px;
    padding: 0 8px 0 2px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 16px;
    cursor: pointer;
    touch-action: manipulation;
  }

  .chev {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .chev.down {
    width: 19px;
    height: 19px;
    color: var(--text-faint);
  }

  .view-seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 9px;
    overflow: hidden;
    background: var(--bg-sunken);
  }

  .view-seg button {
    display: grid;
    place-items: center;
    width: 46px;
    min-height: 40px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    touch-action: manipulation;
  }

  .view-seg button + button {
    border-left: 1px solid var(--border);
  }

  /* `--bg-raised` is the same white as `--bg` in the light palette, so the
     active cell was told apart from the inactive one only by the group's
     sunken background behind it — which reads as the grey cell being the
     pressed one. The accent is what actually says "this is the mode you are
     in". */
  .view-seg button.active {
    background: var(--bg);
    color: var(--accent);
  }

  .view-seg svg,
  .icon svg {
    width: 21px;
    height: 21px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    touch-action: manipulation;
  }

  .icon.wrap.active {
    color: var(--accent);
  }

  .dots circle {
    fill: currentColor;
    stroke: none;
  }
</style>
