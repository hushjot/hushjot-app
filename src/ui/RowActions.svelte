<script lang="ts">
  /**
   * The `⋯` on a sidebar row: everything that can be done *to* the thing the
   * row names. One component serves both folder rows and note rows.
   *
   * Nesting brought two more folder actions (new subfolder, move) to the two
   * a row already had, and four hover controls do not fit a 240px sidebar or
   * a phone's row. So a folder row keeps `+` — the frequent one — and this
   * holds the rest. A note row had it worse: five controls squeezed to 22px
   * each, overlaying the last ~86px of every title, and on a phone reserving
   * 234px of a 240px column. It keeps the pin, for the same reason `+` stayed:
   * it is the one-click action, and it is the one that shows state.
   *
   * On a pointer screen it opens *at* the `⋯` that summoned it. This was a
   * centred dialog first, on the argument `FolderPicker.svelte` still makes,
   * and centring put the menu ~570px from the row it acted on. Each of that
   * argument's reasons has a cheap answer at this size, and none of the
   * answers is a positioning engine:
   *
   *   - Clipping. There are three clippers, not one — `NoteList`'s `.viewport`
   *     and the sidebar's `.folders` are both `overflow-y: auto`, and
   *     `.sidebar` is `overflow: hidden`. None of them reaches this component,
   *     which App mounts at its own top level in a `position: fixed` layer.
   *     Only the coordinates changed.
   *   - The anchor vanishing. `NoteList` virtualizes above 100 notes and
   *     destroys the row that scrolls out of the window; a detached element
   *     answers `getBoundingClientRect` with zeroes rather than throwing, so a
   *     retained element reference would silently park the menu in the corner.
   *     So the caller measures at click time and passes the *rect*. There is
   *     no element here to go stale.
   *   - Scroll and resize listeners. They close the menu rather than tracking
   *     it, which is what a desktop menu does anyway, and which also covers
   *     the two scrolls no gesture causes: `scrollToActive()` and the clamp
   *     when the list shrinks under the viewport.
   *   - The phone. Still true, so below 720px `anchored` is false and every
   *     line below behaves as it did: centred, dimmed, a sheet.
   *
   * Placement prefers below-right of the button and flips above when the
   * bottom will not take it, then clamps into the viewport — so a `⋯` at the
   * very top or the very bottom of the screen still gets a menu that is
   * entirely on it. The panel is hidden until measured, which costs one frame
   * and buys no jump; the placement effect explains why unhiding it has to
   * happen there and not through a `style:` directive.
   *
   * Arrow keys move between the actions and the first is focused on open, so
   * `⋯`, then ↓↓, then Enter works without a pointer. Tab cycles inside the
   * menu rather than walking out of it: anchored, the backdrop is invisible,
   * so the page behind is plainly visible while being unclickable and, per
   * `aria-modal`, not there at all.
   */

  export interface RowAction {
    label: string;
    /** The ⌘J hint, already formatted by `hint()`. Omitted when there is none. */
    hint?: string | undefined;
    /** Drawn in `--danger`, and conventionally last. */
    danger?: boolean | undefined;
    /**
     * Set on a row that shows a state rather than only firing an action — the
     * sort menu, where three rows are one choice between them and a fourth is
     * an independent switch. `radio` for one-of-a-set, `checkbox` for a switch;
     * the value picks the ARIA role, so a screen reader is told which it is.
     *
     * A row that carries it gets a tick, reserved even when unticked so every
     * label in the menu starts at the same x. Absent is a plain action row,
     * exactly as before — the note and folder menus are unchanged.
     */
    checkable?: 'radio' | 'checkbox' | undefined;
    /** Whether a `checkable` row is the current one. Ignored without it. */
    selected?: boolean | undefined;
    run: () => void;
  }

  interface Props {
    heading: string;
    ariaLabel: string;
    items: readonly RowAction[];
    /**
     * Where the `⋯` was when it was clicked, measured by the caller. A rect
     * rather than the element: see the note above about virtualized rows.
     */
    anchor?: DOMRect | null | undefined;
    /** False on a phone, where the menu stays the centred sheet it began as. */
    anchored?: boolean | undefined;
    onClose: () => void;
    /**
     * Run after the dialog has gone, whichever way it went — the place to put
     * the keyboard back on the `⋯` that opened it. Not called when an action
     * ran: that action decides where focus belongs.
     */
    onClosed?: (() => void) | undefined;
  }

  let {
    heading,
    ariaLabel,
    items,
    anchor = null,
    anchored = false,
    onClose,
    onClosed,
  }: Props = $props();

  /** Between the `⋯` and the menu, and between the menu and any viewport edge. */
  const GAP = 4;
  const MARGIN = 8;

  const placing = $derived(anchored && anchor !== null);

  let listEl = $state<HTMLDivElement>();
  let panelEl = $state<HTMLDivElement>();
  const clamp = (value: number, low: number, high: number) =>
    Math.max(low, Math.min(value, Math.max(low, high)));

  /**
   * Measure, place, then focus — in that order and *synchronously*.
   *
   * The panel starts `visibility: hidden` so it is never painted at the wrong
   * coordinates, and a `visibility: hidden` element cannot take focus. Writing
   * the position through `$state` and a `style:` directive would not reach the
   * DOM before this function returns, so the panel would still be hidden at
   * the `.focus()` below: focus would stay on the `⋯`, arrow keys would go
   * nowhere, and Enter would re-open the menu. Hence the direct style writes —
   * nothing else touches these three properties, so there is nobody to fight.
   *
   * It runs once. The rect is a snapshot, and everything that could invalidate
   * it closes the menu instead.
   */
  $effect(() => {
    if (placing && panelEl && anchor) {
      const { width, height } = panelEl.getBoundingClientRect();
      // Not innerWidth/innerHeight: those count a scrollbar and, in an
      // installed PWA, the strip behind the home indicator.
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;

      // Rightward from the button, so the menu never covers the list it came
      // from; right-aligned instead when that would run off the screen.
      let left = anchor.left;
      if (left + width > vw - MARGIN) left = anchor.right - width;

      // Below the button, flipped above when the bottom will not take it. The
      // clamp is the third case: a window too short for either side.
      let top = anchor.bottom + GAP;
      if (top + height > vh - MARGIN) top = anchor.top - GAP - height;

      panelEl.style.left = `${clamp(left, MARGIN, vw - width - MARGIN)}px`;
      panelEl.style.top = `${clamp(top, MARGIN, vh - height - MARGIN)}px`;
      panelEl.style.visibility = 'visible';
    }
    listEl?.querySelector('button')?.focus();
  });

  /**
   * Anything that moves the anchor closes the menu. Capture, because a scroll
   * event does not bubble: the sidebar's `.folders` and the note list's
   * `.viewport` are both scroll containers, and this is what hears them. A
   * scroll inside the panel is not one of them — it can scroll itself in a
   * window too short to show it whole.
   *
   * In practice the backdrop swallows the wheel, so the scrolls this hears are
   * the ones no gesture caused: `scrollToActive()` when the list reorders under
   * the menu, and the clamp when the list shrinks.
   */
  $effect(() => {
    if (!placing) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelEl?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  });

  function dismiss(): void {
    onClose();
    onClosed?.();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const down = event.key === 'ArrowDown';
    const up = event.key === 'ArrowUp';
    const tab = event.key === 'Tab';
    if (!down && !up && !tab) return;
    event.preventDefault();
    const buttons = [...(listEl?.querySelectorAll('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = down || (tab && !event.shiftKey) ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  }

  /**
   * Close first, so the action's own dialog or prompt is the only one up. The
   * callback is read before closing: closing unmounts this component, and a
   * prop read after that is not something to rely on. It stays synchronous
   * with the click — `copyNote` writes to the clipboard, and Safari drops the
   * click's user activation across an `await`.
   */
  function act(item: RowAction): () => void {
    return () => {
      const run = item.run;
      onClose();
      run();
    };
  }
</script>

<!-- Unconditional: a resize that crosses the 720px breakpoint turns anchoring
     on, and the rect was measured before it. -->
<svelte:window onkeydown={onWindowKeydown} onresize={dismiss} />

<div
  class="backdrop"
  class:anchored={placing}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) dismiss();
  }}
>
  <div
    class="panel"
    class:anchored={placing}
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel}
    tabindex="-1"
    bind:this={panelEl}
  >
    <h2 class="head" title={heading}>{heading}</h2>
    <!-- `role="menu"` only when every row carries a state, which is the sort
         menu and nothing else. A menu whose children are plain buttons must not
         claim it: `menuitemradio` is only meaningful inside one, and half a
         menu is worse for a screen reader than none. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="actions"
      role={items.length > 0 && items.every((i) => i.checkable) ? 'menu' : undefined}
      bind:this={listEl}
      onkeydown={onKeydown}
    >
      {#each items as item (item.label)}
        <button
          type="button"
          class:delete={item.danger}
          role={item.checkable ? `menuitem${item.checkable}` : undefined}
          aria-checked={item.checkable ? item.selected === true : undefined}
          onclick={act(item)}
        >
          <span class="label">
            {#if item.checkable}
              <!-- `aria-hidden`: the tick is what `aria-checked` already says.
                   The box is always rendered, so every label in the menu starts
                   at the same x whether or not its row is the chosen one. -->
              <svg class="tick" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                {#if item.selected}<path d="M3.5 8.5l3 3 6-7" />{/if}
              </svg>
            {/if}
            {item.label}
          </span>{#if item.hint}<kbd>{item.hint.trim()}</kbd>{/if}
        </button>
      {/each}
    </div>
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
    /* Same layer as the folder picker; only one is ever open. */
    z-index: 55;
  }

  /* Anchored, the backdrop is only a click-catcher: it still covers the
     screen so a click anywhere dismisses, but it paints nothing and centres
     nothing. Dimming the whole app behind a seven-item menu says "modal", and
     a menu hanging off a row is not one. */
  .backdrop.anchored {
    background: none;
    display: block;
    padding: 0;
  }

  .panel {
    width: min(320px, 100%);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    /* The cap used to live only on `.panel.anchored`, because the unanchored
       sheet had seven items and always fit. The phone's More sheet has
       fourteen, and `overflow: hidden` above meant the last of them — Lock,
       and Delete — were simply cut off with no way to scroll to them. */
    max-height: 100%;
    overflow-y: auto;
  }

  /* Hidden until the placement effect writes `top`, `left` and `visibility`
     onto the node — see the effect for why all three are set there and not
     here. Fixed rather than absolute: the rect it is placed from is in viewport
     coordinates. The cap is what a window too short for the whole menu needs:
     `.panel` is `overflow: hidden`, so without it the clamp would pin the top
     edge on screen and leave Delete off the bottom of it. */
  .panel.anchored {
    position: fixed;
    visibility: hidden;
    max-height: calc(100dvh - 2 * 8px);
    overflow-y: auto;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
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

  .actions {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    padding: 8px 11px;
    border-radius: 6px;
    min-height: 44px;
    cursor: pointer;
  }

  button:hover,
  button:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }

  .delete {
    color: var(--danger);
  }

  .label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .tick {
    flex: none;
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  kbd {
    font: inherit;
    font-size: 12px;
    color: var(--text-faint);
  }

  /* No keyboard to hint at on a touch screen. */
  /* The phone sheet sits on the bottom edge, where the thumb already is. The
     bench asserts it is horizontally centred and keeps its scrim; neither
     changes here. */
  @media (max-width: 720px) {
    .backdrop:not(.anchored) {
      align-items: flex-end;
      padding: 10vh 10px calc(10px + env(safe-area-inset-bottom));
    }

    .panel:not(.anchored) {
      width: 100%;
      border-radius: 14px;
    }
  }

  @media (hover: none) {
    kbd {
      display: none;
    }
  }
</style>
