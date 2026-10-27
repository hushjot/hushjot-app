<script lang="ts">
  /**
   * A shared note that arrived by link, shown before it is saved.
   *
   * The offer has to be accepted inside the app — the `/#s1.` fragment can be
   * linked to directly, so nothing in the URL can prove the reader already
   * chose "Save to my notes" in the viewer (`App.svelte`'s `readIncomingShare`
   * says why). What this fixes is what the user is looking at while being
   * asked: it was a toast bearing the title, over whatever note happened to be
   * open, so the note on screen was not the one being offered. Here the
   * offered note *is* the screen until it is saved or dismissed.
   *
   * A lazy chunk, loaded only when a link actually decrypted. The preview gets
   * `content` and nothing else, so its checkboxes and note links stay inert —
   * the share viewer's and the history panel's arrangement — because this text
   * is not a note yet and has nowhere for a tick to be written.
   */
  import { onMount } from 'svelte';

  interface Props {
    title: string;
    body: string;
    busy: boolean;
    onSave: () => void;
    onDismiss: () => void;
  }

  let { title, body, busy, onSave, onDismiss }: Props = $props();

  let PreviewComponent = $state<typeof import('./Preview.svelte').default | null>(null);
  let saveButton = $state<HTMLButtonElement>();

  onMount(() => {
    saveButton?.focus();
    void import('./Preview.svelte').then((module) => {
      PreviewComponent = module.default;
    });
  });

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="backdrop" role="presentation">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="incoming-title" aria-describedby="incoming-note">
    <header class="head">
      <h2 id="incoming-title"><span class="dim">Shared note ·</span> {title || 'Untitled'}</h2>
      <button type="button" class="close" onclick={onDismiss} disabled={busy} aria-label="Dismiss">×</button>
    </header>

    <div class="view">
      {#if PreviewComponent}
        <PreviewComponent content={body} />
      {:else}
        <p class="state" aria-busy="true">Loading preview…</p>
      {/if}
    </div>

    <footer class="actions">
      <span class="stamp" id="incoming-note">Shared with you — not in your notes yet.</span>
      <button type="button" class="secondary" onclick={onDismiss} disabled={busy}>Dismiss</button>
      <button type="button" class="primary" bind:this={saveButton} onclick={onSave} disabled={busy}>
        {busy ? 'Saving…' : 'Save to my notes'}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 4vh 16px;
    z-index: 60;
  }

  .panel {
    display: flex;
    flex-direction: column;
    width: min(860px, 100%);
    height: min(760px, 100%);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dim {
    color: var(--text-faint);
    font-weight: 500;
  }

  .close {
    flex-shrink: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 20px;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    cursor: pointer;
  }

  .close:hover:not(:disabled) {
    background: var(--bg-sunken);
    color: var(--text);
  }

  .view {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .state {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }

  .stamp {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-faint);
  }

  .primary,
  .secondary {
    font: inherit;
    font-size: 13px;
    border-radius: 6px;
    padding: 6px 14px;
    min-height: 34px;
    cursor: pointer;
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--bg);
    font-weight: 500;
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
  }

  .secondary:hover:not(:disabled) {
    border-color: var(--text-faint);
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* A phone: the dialog is the screen. */
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
    }

    .panel {
      width: 100%;
      height: 100%;
      border-radius: 0;
      border: 0;
    }

    .stamp {
      flex-basis: 100%;
    }

    .primary,
    .secondary {
      min-height: 44px;
    }
  }
</style>
