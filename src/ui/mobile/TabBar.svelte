<script lang="ts">
  /**
   * The phone's primary chrome: four fixed destinations along the bottom edge.
   *
   * It is a bar rather than more controls in the header because the header is
   * the one part of a phone screen a thumb cannot reach. The desktop topbar
   * carries eight controls at 30px; this carries four at 56, which is the
   * whole point — everything else moved into the More sheet, where a list of
   * 44px rows is a better shape for a finger than a row of icons ever was.
   *
   * Presentation only: every action arrives as a callback, so `App.svelte`
   * stays the only place that knows how a command runs.
   *
   * The New button is `.tab-new`, deliberately NOT `.primary`. Three bench
   * harnesses click `button.primary` on a phone to confirm a recovery code,
   * and a second `.primary` in the app shell is a trap for the next one.
   */
  interface Props {
    /** Which screen is showing, so `Notes` can read as the current place. */
    screen: 'list' | 'editor';
    onNotes: () => void;
    onSearch: () => void;
    onNew: () => void;
    onMore: () => void;
  }

  let { screen, onNotes, onSearch, onNew, onMore }: Props = $props();
</script>

<nav class="tab-bar" aria-label="Main">
  <button
    type="button"
    class="tab"
    class:current={screen === 'list'}
    aria-current={screen === 'list' ? 'page' : undefined}
    onclick={onNotes}
  >
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5" />
    </svg>
    <span>Notes</span>
  </button>

  <button type="button" class="tab" onclick={onSearch}>
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.4 15.4 4.3 4.3" />
    </svg>
    <span>Search</span>
  </button>

  <button type="button" class="tab tab-new" onclick={onNew}>
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
    <span>New</span>
  </button>

  <button type="button" class="tab" onclick={onMore} aria-haspopup="dialog" aria-label="More">
    <svg class="ico dots" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18.5" cy="12" r="1.4" />
    </svg>
    <span>More</span>
  </button>
</nav>

<style>
  .tab-bar {
    display: flex;
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    background: var(--bg);
    /* The bar owns the home-indicator strip: `.app.mobile` drops its own
       bottom inset so the bar's background runs under it rather than leaving
       a band of page showing below the buttons. */
    padding-bottom: env(safe-area-inset-bottom);
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: var(--tabbar-h);
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    /* Kill the 300ms tap delay and the double-tap-to-zoom gesture: this bar is
       tapped more than anything else in the app. */
    touch-action: manipulation;
  }

  .tab.current {
    color: var(--accent);
  }

  .tab:active {
    background: var(--bg-sunken);
  }

  .ico {
    display: block;
    width: 23px;
    height: 23px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The dots read as filled, not outlined, at this size. Scoped to the More
     icon: the search magnifier is a circle too, and filling it draws a blob. */
  .dots circle {
    fill: currentColor;
    stroke: none;
  }
</style>
