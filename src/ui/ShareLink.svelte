<script lang="ts">
  /**
   * Share a note by link, and manage the links already out there.
   *
   * Its own chunk, loaded when first opened, like export and import (§28).
   *
   * ## One dialog, two entry points
   *
   * Opened from a note it offers to publish that note and shows the link it
   * already has, if any. Opened from "Shared links" it is the list. They are
   * the same screen because they answer the same question — *what have I sent
   * out, and is it still live* — and splitting them would put "revoke" two
   * steps from "share".
   *
   * ## What it says before it does anything
   *
   * A link is a bearer token: whoever holds it can read that note until it
   * expires. That sentence is on the screen before the button, not in a
   * confirmation after it, for the same reason the plaintext warning sits
   * under the export buttons rather than behind a click.
   *
   * ## The link is shown once and can be shown again
   *
   * The key is in the URL and nowhere else a server can read it — but the
   * owner's own record of the share carries it sealed under the vault, so
   * "Copy link" works on the list too, and from another device. See
   * `share.ts`.
   */
  import { onMount } from 'svelte';
  import { workspace } from './state/workspace.svelte.ts';
  import { EXPIRY_TIERS, DEFAULT_TIER, describeRemaining, type ExpiryTier } from '../core/share/expiry.ts';
  import { ShareTooLargeError, MAX_SHARE_BYTES } from '../core/share/payload.ts';
  import {
    publish,
    revoke,
    list,
    linkFor,
    unavailableReason,
    type PublishedShare,
    type ShareIndexEntry,
  } from './share.ts';

  interface Props {
    /** The note to offer to share, or null for the list on its own. */
    noteId: string | null;
    onOpenNote: (id: string) => void;
    /** Sharing needs an account; this is the way to one. */
    onAccount: () => void;
    onClose: () => void;
    onClosed?: (() => void) | undefined;
  }

  let { noteId, onOpenNote, onAccount, onClose, onClosed }: Props = $props();

  let tier = $state<ExpiryTier['id']>(DEFAULT_TIER);
  let shares = $state<readonly ShareIndexEntry[]>([]);
  let loading = $state(true);
  let working = $state<string | null>(null);
  let error = $state<string | null>(null);
  let flash = $state<string | null>(null);
  /**
   * Which control just copied: 'create', 'main', or a list entry's id. The
   * confirmation goes on the button that was pressed, because a line at the
   * foot of the panel is easy to miss when your eyes are on the button.
   */
  let copiedKey = $state<string | null>(null);
  /** Screen-reader echo of `copiedKey`, since a label change is not announced. */
  let announce = $state('');
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The link just published or just copied, shown in full so it can be selected. */
  let shown = $state<PublishedShare | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  const blocked = unavailableReason();
  const noteTitle = $derived(noteId ? (workspace.metaById(noteId)?.title ?? 'Untitled') : null);
  const existing = $derived(noteId ? shares.find((s) => s.noteId === noteId) : undefined);
  /** The list below, minus the one this screen is already about. */
  const listed = $derived(noteId ? shares.filter((s) => s.noteId !== noteId) : shares);
  const titleOf = (id: string) => workspace.metaById(id)?.title ?? 'a deleted note';

  onMount(() => {
    void refresh();
    return () => {
      clearTimeout(copiedTimer);
      onClosed?.();
    };
  });

  async function refresh(): Promise<void> {
    if (blocked) {
      loading = false;
      return;
    }
    try {
      shares = await list();
    } catch {
      error = 'Could not reach the sync service.';
    } finally {
      loading = false;
    }
  }

  function say(message: string): void {
    flash = message;
    setTimeout(() => (flash = null), 2200);
  }

  async function copy(url: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      clearTimeout(copiedTimer);
      copiedKey = key;
      announce = 'Link copied';
      copiedTimer = setTimeout(() => {
        copiedKey = null;
        announce = '';
      }, 2000);
    } catch {
      say('Your browser would not let the page copy — select the link instead');
    }
  }

  /** Publish, or re-publish in place when the note already has a link. */
  async function createOrUpdate(): Promise<void> {
    if (!noteId) return;
    error = null;
    working = existing ? 'Updating…' : 'Publishing…';
    try {
      // Re-publishing has to reuse the id *and* the key, or the link already
      // sent stops working. `linkFor` is what recovers the key.
      const ref = existing ? (await linkFor(existing)).ref : undefined;
      shown = await publish(noteId, tier, ref);
      await refresh();
      await copy(shown.url, 'create');
    } catch (e) {
      shown = null;
      error =
        e instanceof ShareTooLargeError
          ? `This note is too large to share as one link (over ${Math.round(MAX_SHARE_BYTES / 1024)} KB once encrypted).`
          : e instanceof Error && e.message
            ? e.message
            : 'The link could not be published.';
    } finally {
      working = null;
    }
  }

  async function copyExisting(entry: ShareIndexEntry, key: string): Promise<void> {
    error = null;
    working = 'Opening…';
    try {
      shown = await linkFor(entry);
      await copy(shown.url, key);
    } catch {
      error = 'That link’s key could not be read on this device.';
    } finally {
      working = null;
    }
  }

  async function withdraw(entry: ShareIndexEntry): Promise<void> {
    error = null;
    working = 'Revoking…';
    try {
      await revoke(entry.id);
      if (shown?.ref.id === entry.id) shown = null;
      await refresh();
      say('Link revoked');
    } catch {
      error = 'That link could not be revoked.';
    } finally {
      working = null;
    }
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !working) {
      event.preventDefault();
      onClose();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(panelEl?.querySelectorAll<HTMLButtonElement>('button.row') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget && !working) onClose();
  }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="share-title"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={onKeydown}
  >
    <header class="head">
      <h2 id="share-title">{noteId ? 'Share by link' : 'Shared links'}</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close" disabled={!!working}>×</button>
    </header>

    {#if blocked}
      <section>
        <p class="fine">{blocked}</p>
        <div class="buttons">
          <button type="button" onclick={onAccount}>Account and sync…</button>
        </div>
      </section>
    {:else}
      {#if noteId}
        <section>
          <h3>{existing ? 'Update the link for' : 'Publish'} “{noteTitle}”</h3>
          <label class="field">
            <span>Expires</span>
            <select bind:value={tier} disabled={!!working}>
              {#each EXPIRY_TIERS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
          <button type="button" class="row primary" onclick={() => void createOrUpdate()} disabled={!!working}>
            <span class="label">{working ?? (existing ? 'Update link' : 'Create link')}</span>
            {#if copiedKey === 'create'}
              <span class="meta done">✓ Link copied</span>
            {:else}
              <span class="meta">copies to clipboard</span>
            {/if}
          </button>
          <p class="fine">
            The note is encrypted with a new key that travels in the part of the link after the
            <code>#</code>, which browsers never send to a server. <strong>Anyone who has the
            link can read this note</strong> until it expires. It is a snapshot: later edits do not
            change it until you update the link.
          </p>
        </section>
      {/if}

      {#if shown || existing}
        <section>
          <h3>The link</h3>
          {#if shown}
            <input class="link" readonly value={shown.url} onfocus={(e) => e.currentTarget.select()} />
          {:else}
            <p class="fine">Published, and still live.</p>
          {/if}
          <div class="buttons">
            {#if shown}
              <button type="button" class="copy" class:copied={copiedKey === 'main'} onclick={() => void copy(shown!.url, 'main')} disabled={!!working}>
                {copiedKey === 'main' ? '✓ Copied' : 'Copy'}
              </button>
            {:else if existing}
              <button type="button" class="copy" class:copied={copiedKey === 'main'} onclick={() => void copyExisting(existing!, 'main')} disabled={!!working}>
                {copiedKey === 'main' ? '✓ Copied' : 'Copy'}
              </button>
            {/if}
            <!-- Revoke belongs here as well as in the list: the screen you
                 share from is the screen you realise you should not have. -->
            {#if existing}
              <button type="button" class="danger" onclick={() => void withdraw(existing!)} disabled={!!working}>
                Revoke
              </button>
            {/if}
            <span class="meta">expires {describeRemaining((shown ?? existing!).expireAt)}</span>
          </div>
        </section>
      {/if}

      <!-- In note mode with nothing else shared there is no list to show and
           no heading worth showing: the note's own link has its own section. -->
      {#if !noteId || listed.length > 0}
        <section>
          <h3>{noteId ? 'Your other links' : 'Your links'}</h3>
          {#if loading}
            <p class="fine">Loading…</p>
          {:else if listed.length === 0}
            <p class="fine">Nothing is shared right now.</p>
          {:else}
            <ul>
              {#each listed as entry (entry.id)}
                <li>
                  <button
                    type="button"
                    class="row"
                    onclick={() => onOpenNote(entry.noteId)}
                    disabled={!!working || !workspace.metaById(entry.noteId)}
                  >
                    <span class="label">{titleOf(entry.noteId)}</span>
                    <span class="meta">expires {describeRemaining(entry.expireAt)}</span>
                  </button>
                  <span class="acts">
                    <button type="button" class="copy" class:copied={copiedKey === entry.id} onclick={() => void copyExisting(entry, entry.id)} disabled={!!working}>
                      {copiedKey === entry.id ? '✓ Copied' : 'Copy'}
                    </button>
                    <button type="button" class="danger" onclick={() => void withdraw(entry)} disabled={!!working}>
                      Revoke
                    </button>
                  </span>
                </li>
              {/each}
            </ul>
            <p class="fine">
              Revoking takes effect at once. The encrypted copy stays on the server until it expires,
              unreadable — the same as note history.
            </p>
          {/if}
        </section>
      {/if}
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {#if flash}
      <p class="flash" role="status">{flash}</p>
    {/if}
    <span class="sr-only" role="status">{announce}</span>
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
    padding: 8vh 16px 16px;
    z-index: 60;
    overflow-y: auto;
  }

  .panel {
    width: min(460px, 100%);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 10px 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 { margin: 0; font-size: 15px; font-weight: 600; }

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
  .close:hover { background: var(--bg-sunken); color: var(--text); }

  section { padding: 10px 8px 12px; }
  section + section { border-top: 1px solid var(--border); }

  h3 {
    margin: 2px 8px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 8px 8px;
    color: var(--text-dim);
  }

  select, input.link, .acts button, .buttons button {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
  }
  select { cursor: pointer; }

  input.link {
    width: calc(100% - 16px);
    margin: 0 8px;
    font-family: var(--mono);
    font-size: 12px;
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 0;
  }
  .buttons button { cursor: pointer; }
  .buttons .danger, .acts .danger { color: var(--danger); border-color: var(--danger-soft); }

  button.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button.row:hover:not(:disabled) { background: var(--bg-sunken); }
  button.row:disabled { cursor: default; opacity: 0.6; }
  button.row.primary { color: var(--accent); font-weight: 600; }

  /* Wide enough for "✓ Copied" so the buttons beside it hold still. */
  .copy { min-width: 84px; transition: color 0.15s, border-color 0.15s, background 0.15s; }
  .copy.copied {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--bg-sunken);
    animation: copied-pop 0.25s ease-out;
  }
  @keyframes copied-pop {
    0% { transform: scale(0.94); }
    60% { transform: scale(1.04); }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .copy.copied { animation: none; }
  }
  .meta.done { color: var(--accent); font-weight: 600; }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--text-faint); font-size: 12px; white-space: nowrap; }

  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding-right: 8px; }
  li button.row { flex: 1; min-width: 0; }

  .acts { display: flex; gap: 6px; }
  .acts button { cursor: pointer; min-height: 32px; }

  .fine {
    margin: 6px 8px 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  code {
    font-family: var(--mono);
    background: var(--bg-sunken);
    border-radius: 3px;
    padding: 0 3px;
  }

  .error, .flash {
    margin: 0;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }
  .error { color: var(--danger); background: var(--danger-soft); }
  .flash { color: var(--text-dim); }

  @media (max-width: 720px) {
    .backdrop { padding: 6vh 8px 8px; }
    /* A thumb needs the full target; the phone chrome uses the same 44px. */
    .acts button, .buttons button, select { min-height: 44px; }
    li { flex-wrap: wrap; }
  }
</style>
