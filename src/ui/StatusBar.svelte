<script lang="ts">
  import type { SaveState } from './state/workspace.svelte.ts';

  interface Props {
    state: SaveState;
    words: number;
    chars: number;
  }

  let { state, words, chars }: Props = $props();

  // §4's vocabulary, plus one word it does not have. 'Not synced' is the only
  // addition, and it exists because the alternative was a lie: a sync cycle
  // that keeps throwing used to render as 'Saved ✓'. Phrased as a state rather
  // than an instruction — there is nothing for the user to do, the engine is
  // already backing off and retrying — and kept to two words so the bar stays
  // a status line rather than becoming an error surface.
  const LABEL: Record<SaveState, string> = {
    saved: 'Saved ✓',
    saving: 'Saving…',
    offline: 'Offline',
    syncing: 'Syncing…',
    'sync-failed': 'Not synced',
  };
</script>

<footer class="status">
  <span class="counts">{words} words · {chars} chars</span>
  <!--
    aria-live="polite" so a screen reader hears the save state change without
    it interrupting typing — which is the same rule the visual design follows.
  -->
  <span class="state" data-state={state} aria-live="polite">{LABEL[state]}</span>
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: var(--status-h);
    padding: 0 14px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-faint);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .counts {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state[data-state='saved'] {
    color: var(--text-faint);
  }

  .state[data-state='saving'],
  .state[data-state='syncing'] {
    color: var(--text-dim);
  }

  /* Both mean "your text is on this device and nowhere else", which is the
     distinction the colour is carrying — not how alarmed to be. */
  .state[data-state='offline'],
  .state[data-state='sync-failed'] {
    color: var(--danger);
  }
</style>
