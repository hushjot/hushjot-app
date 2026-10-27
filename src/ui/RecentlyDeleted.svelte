<script lang="ts">
  /**
   * Notes deleted in the last 30 days, with the text they had when they went.
   *
   * Built from two things that already exist rather than a trash of its own:
   * the note database keeps every tombstone (with its sealed title), and history
   * keeps a `delete` version of the final text. A tombstone with no version here
   * is listed only when this device can ask the account, whose other devices may
   * have kept one; selecting it fetches that. If none exists — deleted before
   * history did — the row says so rather than offering a restore that cannot
   * happen.
   *
   * No "delete forever" yet: versions expire on their own, and a button that
   * destroys the last copy of something deserves more design than a v1 row.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { workspace } from './state/workspace.svelte.ts';
  import { folderPath } from '../core/notes/folders.ts';

  interface Props {
    onRestore: (id: string) => void;
    onRestoreAsNew: (text: string, folderId: string | null) => void;
    onClose: () => void;
  }

  let { onRestore, onRestoreAsNew, onClose }: Props = $props();

  const KEEP_DAYS = 30;
  const DAY_MS = 24 * 60 * 60_000;

  type Entry = Awaited<ReturnType<typeof workspace.recentlyDeleted>>[number];

  let loading = $state(true);
  let entries = $state.raw<Entry[]>([]);
  let selectedId = $state<string | null>(null);
  let text = $state<string | null | undefined>(undefined);
  /** Why there is no text: it would not decrypt, nothing was kept, or the account could not be asked. */
  let missing = $state<'unreadable' | 'none' | 'offline' | 'failed'>('unreadable');
  let checking = $state(false);
  let listEl = $state<HTMLElement>();
  let cancelled = false;

  const selected = $derived(entries.find((e) => e.id === selectedId) ?? null);

  onMount(async () => {
    try {
      entries = await workspace.recentlyDeleted();
    } finally {
      loading = false;
    }
    const first = entries[0];
    if (first) {
      await select(first.id);
      await tick();
      listEl?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  });

  onDestroy(() => {
    cancelled = true;
  });

  async function select(id: string): Promise<void> {
    selectedId = id;
    text = undefined;
    missing = 'unreadable';
    const current = () => !cancelled && selectedId === id;
    try {
      const history = await workspace.history();
      let version = await history?.latest(id);
      if (!version && entries.find((e) => e.id === id)?.local === false) {
        checking = true;
        const result = await workspace.fetchRemoteVersions(id, { limit: 1, force: true });
        checking = false;
        if (!current()) return;
        if (result.status === 'offline' || result.status === 'failed') {
          missing = result.status;
          text = null;
          return;
        }
        version = await history?.latest(id);
      }
      if (!version) {
        if (current()) {
          missing = 'none';
          text = null;
        }
        return;
      }
      const body = await history!.decodeBody(version);
      if (current()) text = body;
    } catch {
      checking = false;
      if (current()) text = null;
    }
  }

  function folderLabel(folderId: string | null): string {
    if (!folderId) return 'Top level';
    if (!workspace.folders.some((f) => f.id === folderId)) return 'A deleted folder';
    return folderPath(workspace.folders, folderId);
  }

  function ago(at: number): string {
    const days = Math.floor((Date.now() - at) / DAY_MS);
    if (days <= 0) return 'Deleted today';
    if (days === 1) return 'Deleted yesterday';
    return `Deleted ${days} days ago`;
  }

  function remaining(at: number): string {
    const days = Math.max(0, KEEP_DAYS - Math.floor((Date.now() - at) / DAY_MS));
    return days <= 1 ? 'kept for 1 more day' : `kept for ${days} more days`;
  }

  function onListKeydown(event: KeyboardEvent): void {
    const at = entries.findIndex((e) => e.id === selectedId);
    let next = -1;
    if (event.key === 'ArrowDown') next = Math.min(entries.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Enter' && selectedId && typeof text === 'string') {
      event.preventDefault();
      onRestore(selectedId);
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    const id = entries[next]!.id;
    void select(id).then(() => tick());
    void tick().then(() => listEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="deleted-title">
    <header class="head">
      <h2 id="deleted-title">Recently deleted</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close">×</button>
    </header>

    {#if loading}
      <p class="state" aria-busy="true">Loading…</p>
    {:else if entries.length === 0}
      <p class="state">
        Nothing here. Notes you delete are kept, encrypted, for {KEEP_DAYS} days, and can be
        restored from this list.
      </p>
    {:else}
      <div class="body">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="list" role="listbox" aria-label="Deleted notes" tabindex="-1" bind:this={listEl} onkeydown={onListKeydown}>
          {#each entries as entry (entry.id)}
            <button
              type="button"
              class="row"
              role="option"
              data-id={entry.id}
              aria-selected={selectedId === entry.id}
              tabindex={selectedId === entry.id ? 0 : -1}
              onclick={() => void select(entry.id)}
            >
              <span class="title">{entry.title || 'Untitled'}</span>
              <span class="sub">{ago(entry.deletedAt)} · {folderLabel(entry.folderId)}</span>
            </button>
          {/each}
        </div>

        <section class="detail" aria-label="Deleted note">
          <div class="view">
            {#if text === undefined}
              <p class="state" aria-busy="true">{checking ? 'Checking your other devices…' : 'Decrypting…'}</p>
            {:else if text === null && missing === 'none'}
              <p class="state">
                No copy of this note's text was kept. It was deleted before note history existed,
                or on a device that did not keep one.
              </p>
            {:else if text === null && missing === 'offline'}
              <p class="state">You're offline, so your other devices can't be checked for this note's text. Try again when you're back online.</p>
            {:else if text === null && missing === 'failed'}
              <p class="state">This note's text could not be loaded from your other devices.</p>
            {:else if text === null}
              <p class="state">This note's text cannot be decrypted with this vault's key.</p>
            {:else}
              <pre class="plain">{text}</pre>
            {/if}
          </div>
          {#if selected}
            <footer class="actions">
              <span class="stamp">{ago(selected.deletedAt)}, {remaining(selected.deletedAt)}</span>
              <button
                type="button"
                class="secondary"
                disabled={typeof text !== 'string'}
                onclick={() => typeof text === 'string' && onRestoreAsNew(text, selected.folderId)}
              >
                Restore as new note
              </button>
              <button
                type="button"
                class="primary"
                disabled={typeof text !== 'string'}
                onclick={() => onRestore(selected.id)}
              >
                Restore
              </button>
            </footer>
          {/if}
        </section>
      </div>
    {/if}

    <p class="fine">Deleted notes are kept encrypted for {KEEP_DAYS} days, then removed automatically.</p>
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
    width: min(880px, 100%);
    max-height: min(680px, 100%);
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
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .close {
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

  .close:hover {
    background: var(--bg-sunken);
    color: var(--text);
  }

  .state {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }

  .body {
    flex: 1;
    min-height: 360px;
    display: grid;
    grid-template-columns: 280px 1fr;
  }

  .list {
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
    padding: 6px;
    outline: none;
  }

  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    border: 0;
    border-radius: 6px;
    padding: 7px 10px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--bg-raised);
  }

  .row[aria-selected='true'] {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .title {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
  }

  .sub {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-faint);
  }

  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .view {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .plain {
    margin: 0;
    padding: 12px 16px;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
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

  .fine {
    margin: 0;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
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

  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
    }

    .panel {
      width: 100%;
      height: 100%;
      max-height: none;
      border-radius: 0;
      border: 0;
    }

    .body {
      min-height: 0;
      grid-template-columns: 1fr;
      grid-template-rows: minmax(120px, 38%) 1fr;
    }

    .list {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
