<script lang="ts">
  /**
   * Browse and restore a note's earlier versions.
   *
   * A lazy chunk, with the diff and the history service behind it (§28): nobody
   * who never opens it downloads it.
   *
   * ## Shape
   *
   * The list is on the left and the selected version on the right, like every
   * version browser people already know. The newest version is selected on
   * open, not "Current": what the user came for is the text before now.
   *
   * The right pane opens on **Changes** — what is different in the note now —
   * because "which of these is the one I want" is usually answered by what a
   * version lacks or has, not by rereading it whole. Preview and Text are one
   * click away.
   *
   * ## Restoring is never destructive
   *
   * The text being replaced is kept as a version first, the change goes through
   * the editor as one undoable edit, and the flash after it offers Undo. Enter
   * restores directly because of all three.
   *
   * ## Local first, then the account
   *
   * The list renders from this device's history at once. When this device can
   * read the account's history, the newest page is fetched from there in the
   * background and merged in, with a line saying so while it happens — and
   * saying plainly when the device is offline or not syncing, because "no
   * versions" and "no versions *here*" are different answers.
   *
   * ## Decrypting
   *
   * Only the selected version is decrypted up front. Word counts for the list
   * are filled in afterwards, one version per idle callback, so a note with two
   * hundred versions opens as quickly as one with two.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { workspace } from './state/workspace.svelte.ts';
  import { syncStore } from './state/sync.svelte.ts';
  import type { SyncCursor } from '../core/sync/adapter.ts';
  import { diffTexts } from '../core/history/diff.ts';
  import { countWords } from '../core/notes/text.ts';
  import type { VersionRecord } from '../core/history/record.ts';
  import type { HistoryService } from '../core/history/service.ts';

  interface Props {
    noteId: string;
    onRestore: (text: string, version: VersionRecord, replaced: string) => void;
    onRestoreAsNew: (text: string, folderId: string | null) => void;
    onClose: () => void;
  }

  let { noteId, onRestore, onRestoreAsNew, onClose }: Props = $props();

  const CURRENT = 'current';

  let history: HistoryService | null = null;
  let loading = $state(true);
  let unavailable = $state(false);
  let versions = $state.raw<VersionRecord[]>([]);
  let current = $state('');
  let selectedKey = $state(CURRENT);
  let tab = $state<'changes' | 'preview' | 'text'>('changes');
  /** Decrypted text per version id; null for one that will not decrypt. */
  let texts = $state.raw(new Map<string, string | null>());
  let copied = $state(false);
  /** Where the account's copy of this history stands. */
  let remote = $state<'idle' | 'checking' | 'done' | 'offline' | 'failed' | 'unavailable'>('idle');
  let olderCursor: SyncCursor = null;
  let hasOlder = $state(false);
  let loadingOlder = $state(false);

  let listEl = $state<HTMLElement>();
  let PreviewComponent = $state<typeof import('./Preview.svelte').default | null>(null);

  const title = $derived(workspace.metaById(noteId)?.title ?? 'Note');
  const selected = $derived(versions.find((v) => v.id === selectedKey) ?? null);
  const selectedText = $derived(selected ? texts.get(selected.id) : current);
  const diff = $derived(
    selected && typeof selectedText === 'string' && tab === 'changes' ? diffTexts(selectedText, current) : null,
  );

  const groups = $derived.by(() => {
    const out: { label: string; rows: VersionRecord[] }[] = [];
    for (const version of versions) {
      const label = dayLabel(version.at);
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(version);
      else out.push({ label, rows: [version] });
    }
    return out;
  });

  let cancelled = false;
  let idleHandle: number | undefined;

  onMount(async () => {
    try {
      const [body, service] = await Promise.all([workspace.bodyOf(noteId), workspace.history()]);
      if (cancelled) return;
      current = body;
      history = service;
      if (!service) {
        unavailable = true;
        return;
      }
      versions = (await service.list(noteId)).sort((a, b) => b.at - a.at);
      if (cancelled) return;
      const first = versions[0];
      if (first) {
        selectedKey = first.id;
        await decrypt(first);
      }
    } catch {
      unavailable = true;
    } finally {
      loading = false;
    }
    await tick();
    listEl?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    fillInIdle(0);
    if (history) void fetchRemote();
  });

  async function fetchRemote(): Promise<void> {
    if (!workspace.remoteHistoryAvailable) {
      remote = 'unavailable';
      return;
    }
    remote = 'checking';
    const result = await workspace.fetchRemoteVersions(noteId);
    if (cancelled) return;
    if (result.status === 'fetched') {
      olderCursor = result.cursor;
      hasOlder = result.hasMore;
    }
    remote = result.status === 'fetched' || result.status === 'cached' ? 'done' : result.status;
    await reload();
  }

  async function loadOlder(): Promise<void> {
    if (loadingOlder) return;
    loadingOlder = true;
    try {
      const result = await workspace.fetchRemoteVersions(noteId, { cursor: olderCursor });
      if (cancelled) return;
      if (result.status === 'fetched') {
        olderCursor = result.cursor;
        hasOlder = result.hasMore;
        await reload();
      } else {
        remote = result.status === 'cached' ? 'done' : result.status;
      }
    } finally {
      loadingOlder = false;
    }
  }

  /** Re-read local history after remote versions were merged in, keeping the selection. */
  async function reload(): Promise<void> {
    if (!history) return;
    const next = (await history.list(noteId)).sort((a, b) => b.at - a.at);
    if (cancelled) return;
    const hadNone = versions.length === 0;
    versions = next;
    const first = versions[0];
    if (hadNone && first && selectedKey === CURRENT) await select(first.id);
    fillInIdle(0);
  }

  onDestroy(() => {
    cancelled = true;
    if (idleHandle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle);
  });

  async function decrypt(version: VersionRecord): Promise<string | null> {
    if (texts.has(version.id)) return texts.get(version.id) ?? null;
    let text: string | null;
    try {
      text = (await history?.decodeBody(version)) ?? null;
    } catch {
      text = null;
    }
    if (!cancelled) texts = new Map(texts).set(version.id, text);
    return text;
  }

  function fillInIdle(index: number): void {
    const version = versions[index];
    if (!version || cancelled) return;
    const next = () => void decrypt(version).then(() => fillInIdle(index + 1));
    if (texts.has(version.id)) return fillInIdle(index + 1);
    if (typeof requestIdleCallback === 'function') idleHandle = requestIdleCallback(next, { timeout: 1000 });
    else setTimeout(next, 16);
  }

  async function select(key: string): Promise<void> {
    selectedKey = key;
    copied = false;
    const version = versions.find((v) => v.id === key);
    if (version) await decrypt(version);
    if (tab === 'changes' && !version) tab = 'text';
  }

  async function showTab(next: typeof tab): Promise<void> {
    tab = next;
    if (next === 'preview' && !PreviewComponent) {
      PreviewComponent = (await import('./Preview.svelte')).default;
    }
  }

  function restore(): void {
    if (!selected || typeof selectedText !== 'string') return;
    onRestore(selectedText, selected, current);
  }

  async function restoreAsNew(): Promise<void> {
    if (!selected || typeof selectedText !== 'string') return;
    let folderId: string | null = null;
    try {
      folderId = (await history?.decodeMeta(selected))?.folderId ?? null;
    } catch {
      // Top level, then.
    }
    onRestoreAsNew(selectedText, folderId);
  }

  async function copy(): Promise<void> {
    if (typeof selectedText !== 'string') return;
    try {
      await navigator.clipboard.writeText(selectedText);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // --- labels ---------------------------------------------------------------

  function dayLabel(at: number): string {
    const date = new Date(at);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    });
  }

  function timeLabel(at: number): string {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function reasonLabel(version: VersionRecord): string | null {
    if (version.reason === 'delete') return 'Before delete';
    if (version.reason === 'restore') return 'Before restore';
    return null;
  }

  function wordsOf(text: string | null | undefined): number | undefined {
    return typeof text === 'string' ? countWords(text) : undefined;
  }

  /** Words gained or lost against the next older version. */
  function delta(index: number): string {
    const version = versions[index];
    if (!version) return '';
    const text = texts.get(version.id);
    if (text === null) return 'Unreadable';
    const words = wordsOf(text);
    if (words === undefined) return '';
    const older = versions[index + 1];
    const olderWords = older ? wordsOf(texts.get(older.id)) : undefined;
    if (olderWords === undefined) return `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    const change = words - olderWords;
    if (change === 0) return 'Same length';
    return `${change > 0 ? '+' : '−'}${Math.abs(change).toLocaleString()} ${Math.abs(change) === 1 ? 'word' : 'words'}`;
  }

  function fullStamp(at: number): string {
    return new Date(at).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // --- keyboard -------------------------------------------------------------

  const order = $derived([CURRENT, ...versions.map((v) => v.id)]);

  function onListKeydown(event: KeyboardEvent): void {
    const at = order.indexOf(selectedKey);
    let next = -1;
    if (event.key === 'ArrowDown') next = Math.min(order.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      restore();
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    const key = order[next]!;
    void select(key).then(() => tick()).then(() => {
      listEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
    });
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
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
    <header class="head">
      <h2 id="history-title"><span class="dim">History ·</span> {title}</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close">×</button>
    </header>

    {#if loading}
      <p class="state" aria-busy="true">Loading history…</p>
    {:else if unavailable}
      <p class="state">History is not available in this browser session — local storage for it could not be opened.</p>
    {:else}
      <div class="body">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="list" role="listbox" aria-label="Versions" tabindex="-1" bind:this={listEl} onkeydown={onListKeydown}>
          <button
            type="button"
            class="row current"
            role="option"
            data-key={CURRENT}
            aria-selected={selectedKey === CURRENT}
            tabindex={selectedKey === CURRENT ? 0 : -1}
            onclick={() => void select(CURRENT)}
          >
            <span class="when">Current version</span>
            <span class="sub">{wordsOf(current)?.toLocaleString()} words</span>
          </button>

          {#if versions.length === 0 && remote !== 'checking'}
            <p class="empty">
              No earlier versions yet. HushJot keeps one when you come back to a note after a
              break, every 10 minutes while you write, and before a note is deleted or restored.
            </p>
          {/if}

          {#each groups as group (group.label)}
            <h3 class="day">{group.label}</h3>
            {#each group.rows as version (version.id)}
              {@const index = versions.indexOf(version)}
              {@const reason = reasonLabel(version)}
              <button
                type="button"
                class="row"
                role="option"
                data-key={version.id}
                aria-selected={selectedKey === version.id}
                tabindex={selectedKey === version.id ? 0 : -1}
                title={fullStamp(version.at)}
                onclick={() => void select(version.id)}
              >
                <span class="when">{timeLabel(version.at)}</span>
                <span class="sub">
                  {#if reason}<span class="badge">{reason}</span>{/if}
                  {#if version.state === 'local' && workspace.remoteHistoryAvailable}
                    <span class="badge" title="Not synced: kept on this device only">This device</span>
                  {/if}
                  <span class:unreadable={texts.get(version.id) === null}>{delta(index)}</span>
                </span>
              </button>
            {/each}
          {/each}

          <div class="remote" aria-live="polite">
            {#if remote === 'checking'}
              <p>Checking your other devices…</p>
            {:else if remote === 'offline'}
              <p>You're offline, so only versions saved on this device are shown.</p>
            {:else if remote === 'failed'}
              <p>
                Versions from your other devices could not be loaded.
                <button type="button" class="link" onclick={() => void fetchRemote()}>Try again</button>
              </p>
            {:else if remote === 'unavailable' && syncStore.available && !syncStore.signedIn}
              <p>History is kept on this device. Sign in to keep it across your devices too.</p>
            {:else if hasOlder}
              <button type="button" class="more" onclick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older versions'}
              </button>
            {/if}
          </div>
        </div>

        <section class="detail" aria-label="Selected version">
          <div class="tabs" role="tablist">
            {#if selected}
              <button type="button" role="tab" aria-selected={tab === 'changes'} onclick={() => void showTab('changes')}>
                Changes
              </button>
            {/if}
            <button type="button" role="tab" aria-selected={tab === 'preview'} onclick={() => void showTab('preview')}>
              Preview
            </button>
            <button type="button" role="tab" aria-selected={tab === 'text' || (!selected && tab === 'changes')} onclick={() => void showTab('text')}>
              Text
            </button>
          </div>

          <div class="view">
            {#if selected && selectedText === undefined}
              <p class="state" aria-busy="true">Decrypting…</p>
            {:else if selected && selectedText === null}
              <p class="state">This version cannot be decrypted with this vault's key.</p>
            {:else if tab === 'changes' && selected}
              {#if !diff || diff.kind === 'identical'}
                <p class="state">This version is the same as the current note.</p>
              {:else if diff.kind === 'too-large'}
                <p class="state">
                  Too many changes to compare line by line.
                  <button type="button" class="link" onclick={() => void showTab('text')}>Show the text</button>
                </p>
              {:else}
                <p class="summary">
                  Since this version:
                  {#if diff.added > 0}
                    <span class="added">+{diff.added.toLocaleString()} {diff.added === 1 ? 'line' : 'lines'}</span>
                  {/if}
                  {#if diff.removed > 0}
                    <span class="removed">−{diff.removed.toLocaleString()} {diff.removed === 1 ? 'line' : 'lines'}</span>
                  {/if}
                </p>
                <div class="diff">
                  {#each diff.hunks as hunk, h (h)}
                    {#if h > 0}<div class="gap" aria-hidden="true">⋯</div>{/if}
                    {#each hunk.lines as line, l (l)}
                      <div class="line {line.kind}">
                        <span class="mark" aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                        <span class="sr-only">{line.kind === 'added' ? 'Added:' : line.kind === 'removed' ? 'Removed:' : ''}</span>
                        <span class="text">{line.text || ' '}</span>
                      </div>
                    {/each}
                  {/each}
                </div>
              {/if}
            {:else if tab === 'preview'}
              {#if PreviewComponent}
                <div class="preview"><PreviewComponent content={selectedText ?? ''} /></div>
              {:else}
                <p class="state" aria-busy="true">Loading preview…</p>
              {/if}
            {:else}
              <pre class="plain">{selectedText}</pre>
            {/if}
          </div>

          <footer class="actions">
            {#if selected}
              <span class="stamp">{fullStamp(selected.at)}</span>
              <button type="button" class="secondary" onclick={() => void copy()} disabled={typeof selectedText !== 'string'}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" class="secondary" onclick={() => void restoreAsNew()} disabled={typeof selectedText !== 'string'}>
                Restore as new note
              </button>
              <button type="button" class="primary" onclick={restore} disabled={typeof selectedText !== 'string'}>
                Restore this version
              </button>
            {:else}
              <span class="stamp">This is the note as it is now. Pick an earlier version to compare or restore it.</span>
            {/if}
          </footer>
        </section>
      </div>
    {/if}
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
    width: min(1040px, 100%);
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
    min-height: 0;
    display: grid;
    grid-template-columns: 250px 1fr;
  }

  .list {
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
    padding: 6px;
    outline: none;
  }

  .day {
    margin: 12px 8px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
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

  .row.current {
    margin-bottom: 2px;
  }

  .when {
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .sub {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 16px;
    font-size: 12px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .badge {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .unreadable {
    color: var(--danger);
  }

  .remote p {
    margin: 12px 8px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-faint);
  }

  .more {
    display: block;
    width: calc(100% - 16px);
    margin: 10px 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .more:hover:not(:disabled) {
    color: var(--text);
  }

  .empty {
    margin: 12px 8px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 8px 12px 0;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .tabs button[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .view {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .summary {
    margin: 0;
    padding: 10px 16px 6px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .added {
    color: var(--syn-string);
    margin-left: 6px;
  }

  .removed {
    color: var(--danger);
    margin-left: 6px;
  }

  .diff,
  .plain {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .diff {
    padding: 0 0 16px;
  }

  .line {
    display: flex;
    padding: 0 16px 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .line.added {
    margin: 0;
    color: var(--text);
    background: color-mix(in srgb, var(--syn-string) 14%, transparent);
  }

  .line.removed {
    margin: 0;
    color: var(--text);
    background: color-mix(in srgb, var(--danger) 13%, transparent);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }

  .line.same {
    color: var(--text-dim);
  }

  .mark {
    flex: 0 0 18px;
    color: var(--text-faint);
    user-select: none;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .gap {
    padding: 2px 26px;
    color: var(--text-faint);
    user-select: none;
  }

  .plain {
    margin: 0;
    padding: 12px 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }

  .preview {
    height: 100%;
  }

  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
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

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* A phone: the dialog is the screen, and the list sits above the version. */
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

    .body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(120px, 34%) 1fr;
    }

    .list {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .stamp {
      flex-basis: 100%;
    }
  }
</style>
