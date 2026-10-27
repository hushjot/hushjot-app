<script lang="ts">
  /**
   * The sync button, doubling as the sync indicator.
   *
   * One control: the icon says what a click does — stop waiting for the
   * timers and push and pull now — and shows what the last cycle did, so the
   * top bar spends no width on saying it twice, and it is already tight on a
   * phone. It was the account button until the glyph and the action were
   * lined up; the account now sits on the ⏻ beside it, and a click here falls
   * back to it only when no cycle is possible at all. The state rules live in
   * `syncIndicator.ts`; this file only draws them and holds the spinner.
   *
   * Cost while typing is the point of the shape. Everything read here changes
   * on engine transitions, not keystrokes. The spinner is a CSS rotation of an
   * HTML element — transform only, so the compositor runs it with no layout,
   * paint or script per frame — and it is only in the DOM during a cycle, so
   * nothing animates at rest.
   *
   * No `aria-live`: the status bar already announces save and sync state, and
   * two announcers would read every change twice.
   */
  import { hint } from './shortcuts.ts';
  import { syncStore } from './state/sync.svelte.ts';
  import { syncIndicatorState } from './syncIndicator.ts';

  interface Props {
    onclick: () => void;
  }

  let { onclick }: Props = $props();

  /**
   * A cycle often takes tens of milliseconds; shown raw, the spinner would be
   * a one-frame flicker that reads as a glitch. Once it starts it stays up at
   * least this long.
   */
  const MIN_SPIN_MS = 600;

  let holdingSpin = $state(false);
  let wasSyncing = false;
  let spinStartedAt = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const syncing = syncStore.signedIn && syncStore.status === 'syncing';
    if (syncing && !wasSyncing) {
      clearTimeout(holdTimer);
      holdingSpin = false;
      spinStartedAt = performance.now();
    } else if (!syncing && wasSyncing) {
      const remaining = MIN_SPIN_MS - (performance.now() - spinStartedAt);
      // Only hold into a calm state; offline or failure should show at once.
      if (remaining > 0 && syncStore.status === 'idle') {
        holdingSpin = true;
        holdTimer = setTimeout(() => (holdingSpin = false), remaining);
      }
    }
    wasSyncing = syncing;
  });

  $effect(() => () => clearTimeout(holdTimer));

  const view = $derived(
    syncIndicatorState({
      available: syncStore.available,
      signedIn: syncStore.signedIn,
      status: syncStore.status,
      pending: syncStore.pending,
      sessionExpired: syncStore.sessionExpired,
      notApproved: syncStore.notApproved,
      paused: syncStore.paused,
      storageFull: syncStore.storageFull,
      pushLimited: syncStore.pushLimited,
      holdingSpin,
    }),
  );

  // What a click does first, then what the last one did, then whose account.
  const title = $derived(
    [`Sync now${hint('sync')}`, view.label, syncStore.signedIn ? syncStore.user?.email : undefined]
      .filter(Boolean)
      .join('\n'),
  );
</script>

<button
  type="button"
  class="sync"
  data-kind={view.kind}
  {onclick}
  {title}
  aria-label="Sync now. {view.label}"
>
  <span class="icon" aria-hidden="true">
    {#if view.kind === 'syncing'}<span class="spin"></span>{/if}
    <svg viewBox="0 0 24 24" width="20" height="20">
      <path
        class="cloud"
        d="M7 18.5h10.5a3.75 3.75 0 0 0 .4-7.48A5.5 5.5 0 0 0 7.3 9.6 4.45 4.45 0 0 0 7 18.5z"
      />
      {#if view.kind === 'synced'}
        <path class="mark" d="M9.6 14l1.8 1.8 3.4-3.6" />
      {:else if view.kind === 'pending'}
        <circle class="dot" cx="12" cy="14" r="1.8" />
      {:else if view.kind === 'offline'}
        <path class="mark" d="M4 4l16 16" />
      {:else if view.kind === 'paused'}
        <path class="mark" d="M10.6 12v4M13.4 12v4" />
      {:else if view.kind === 'error' || view.kind === 'attention'}
        <path class="mark" d="M12 11.2v2.6" />
        <circle class="dot" cx="12" cy="16.1" r="0.9" />
      {/if}
    </svg>
    {#if view.count && view.kind !== 'signed-out'}
      <span class="count"><span>{view.count}</span></span>
    {/if}
  </span>
</button>

<style>
  .sync {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-faint);
    font: inherit;
    border-radius: 6px;
    padding: 4px 8px;
    min-height: 30px;
    cursor: pointer;
  }

  .sync:hover {
    background: var(--bg-sunken);
    color: var(--text);
  }

  .icon {
    position: relative;
    display: block;
    width: 20px;
    height: 20px;
  }

  svg {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot {
    fill: currentColor;
    stroke: none;
  }

  .sync[data-kind='synced'] {
    color: var(--text-dim);
  }

  .sync[data-kind='pending'],
  .sync[data-kind='paused'] {
    color: var(--text-dim);
  }

  .sync[data-kind='pending'] .dot,
  .sync[data-kind='pending'] .count,
  .sync[data-kind='syncing'] {
    color: var(--accent);
  }

  .sync[data-kind='offline'],
  .sync[data-kind='error'],
  .sync[data-kind='attention'] {
    color: var(--danger);
  }

  /* A thin arc around the cloud. Transform-only, so it never leaves the
     compositor; see the comment at the top of the file. */
  .spin {
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    border-top-color: currentColor;
    border-right-color: currentColor;
    will-change: transform;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  .count {
    position: absolute;
    top: -6px;
    right: -9px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: currentColor;
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* The pill is filled with the state colour; the figure is cut out of it. */
  .count span {
    color: var(--bg);
  }
</style>
