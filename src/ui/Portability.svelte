<script lang="ts">
  /**
   * Export and import (spec §24): one dialog for
   * getting notes out and putting them in.
   *
   * Its own chunk, loaded when first opened, like the preview (§28).
   *
   * ## Import is staged, never immediate
   *
   * A drop anywhere in the app opens this dialog with the files *ready*, and
   * one Enter imports them. Importing straight off the drop was one keystroke
   * shorter, but a mis-aimed drag would then write hundreds of notes that sync
   * to every device and can only be removed one folder at a time — and the
   * destination, which defaults to the folder in view, would never be seen.
   *
   * ## The plaintext warning is said once, here
   *
   * An export is the only thing in the app that turns notes back into files
   * anyone can read. The line under the export buttons says so plainly, rather
   * than a confirmation on every click.
   */
  import { tick, untrack } from 'svelte';
  import { workspace } from './state/workspace.svelte.ts';
  import { folderPath } from '../core/notes/folders.ts';
  import { TEXT_EXTENSIONS, type SourceApp } from '../core/portability/importTree.ts';
  import {
    describeSource,
    exportNote,
    exportZip,
    importSource,
    type ImportResult,
    type ImportSource,
  } from './portability.ts';

  interface Props {
    activeFolderId: string | null;
    noteId: string | null;
    /**
     * Files staged by a drop or paste anywhere in the app, this dialog included
     * — the app's capture-phase handler owns every file drop. A new object per
     * drop, so dropping again restages.
     */
    source: ImportSource | null;
    /** Files are being dragged over the window. */
    dragging: boolean;
    onOpenNote: (id: string) => void;
    onShowFolder: (id: string | null) => void;
    onClose: () => void;
  }

  let { activeFolderId, noteId, source, dragging, onOpenNote, onShowFolder, onClose }: Props = $props();

  /** What the summary says each recognised export kept (`core/portability/sources.ts`). */
  const SOURCE_NAMES: Record<SourceApp, { name: string; kept: string }> = {
    simplenote: { name: 'Simplenote', kept: 'tags, pins and dates' },
    'google-keep': { name: 'Google Keep', kept: 'labels, checklists, links, pins, archive and dates' },
  };

  let staged = $state<ImportSource | null>(null);
  // Chosen once on open: the folder in view is the obvious place, and a later
  // click in the sidebar behind the dialog should not move it silently.
  let destination = $state(untrack(() => activeFolderId) ?? '');
  let working = $state<{ label: string; done: number; total: number } | null>(null);
  let result = $state<(ImportResult & { into: string | null }) | null>(null);
  let error = $state<string | null>(null);

  let panelEl = $state<HTMLDivElement>();
  let importButton = $state<HTMLButtonElement>();
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();

  const noteTitle = $derived(noteId ? (workspace.metaById(noteId)?.title ?? null) : null);
  const folderName = $derived(
    activeFolderId ? workspace.folders.find((f) => f.id === activeFolderId)?.name ?? null : null,
  );
  const folderNotes = $derived(activeFolderId ? workspace.folderContents(activeFolderId).notes : 0);
  const destinationLabel = (id: string | null) =>
    id ? folderPath(workspace.folders, id) || 'Top level' : 'Top level';

  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  // Tracks `source` only: `stage` reads `working`, and an import finishing
  // must not restage the files it just imported.
  $effect(() => {
    const next = source;
    if (next) untrack(() => void stage(next));
  });

  $effect(() => {
    if (panelEl && !untrack(() => source)) panelEl.querySelector<HTMLButtonElement>('.row')?.focus();
  });

  async function stage(next: ImportSource): Promise<void> {
    if (working) return;
    staged = next;
    result = null;
    error = null;
    await tick();
    importButton?.focus();
  }

  function onPick(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length > 0) void stage({ entries: [], files });
  }

  function progress(label: string) {
    return (done: number, total: number) => (working = { label, done, total });
  }

  async function runExport(kind: 'all' | 'folder' | 'note'): Promise<void> {
    if (working) return;
    error = null;
    try {
      if (kind === 'note' && noteId) {
        await exportNote(noteId);
      } else {
        working = { label: 'Preparing export', done: 0, total: 0 };
        await exportZip(kind === 'folder' ? activeFolderId : null, progress('Preparing export'));
      }
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'The export failed.';
    } finally {
      working = null;
    }
  }

  async function runImport(): Promise<void> {
    if (!staged || working) return;
    const into = destination || null;
    error = null;
    working = { label: 'Reading files', done: 0, total: 0 };
    try {
      const outcome = await importSource(staged, into, progress('Importing'));
      staged = null;
      if (outcome.notes === 0 && outcome.folders === 0) {
        error =
          outcome.skipped.length > 0
            ? `Nothing to import — only ${TEXT_EXTENSIONS.join(', ')} and .zip files can be imported.`
            : 'Nothing to import.';
      } else {
        result = { ...outcome, into };
        await tick();
        panelEl?.querySelector<HTMLButtonElement>('.show')?.focus();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'The import failed.';
    } finally {
      working = null;
    }
  }

  function show(): void {
    if (!result) return;
    if (result.notes === 1 && result.firstNoteId) onOpenNote(result.firstNoteId);
    else onShowFolder(result.into);
    onClose();
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
    aria-labelledby="portability-title"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={onKeydown}
  >
    <header class="head">
      <h2 id="portability-title">Export and import</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close" disabled={!!working}>×</button>
    </header>

    <section>
      <h3>Export</h3>
      <button type="button" class="row" onclick={() => void runExport('all')} disabled={!!working}>
        <span class="label">Download all notes</span>
        <span class="meta">{plural(workspace.metas.length, 'note')} · .zip</span>
      </button>
      {#if activeFolderId && folderName !== null}
        <button type="button" class="row" onclick={() => void runExport('folder')} disabled={!!working}>
          <span class="label">Download folder “{folderName}”</span>
          <span class="meta">{plural(folderNotes, 'note')} · .zip</span>
        </button>
      {/if}
      {#if noteId && noteTitle !== null}
        <button type="button" class="row" onclick={() => void runExport('note')} disabled={!!working}>
          <span class="label">Download “{noteTitle}”</span>
          <span class="meta">.md</span>
        </button>
      {/if}
      <p class="fine">
        Folders become directories and notes become Markdown files, readable in any editor.
        Exports are <strong>not encrypted</strong> — anyone with the file can read it.
      </p>
    </section>

    <section>
      <h3>Import</h3>
      <div class="zone" class:over={dragging} class:ready={staged !== null}>
        {#if working}
          <p class="status">
            {working.label}{working.total ? ` ${working.done.toLocaleString()} of ${working.total.toLocaleString()}` : '…'}
          </p>
          <div
            class="bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax={working.total || undefined}
            aria-valuenow={working.total ? working.done : undefined}
          >
            <span class:indeterminate={!working.total} style:width={working.total ? `${(100 * working.done) / working.total}%` : undefined}></span>
          </div>
        {:else if result}
          <p class="status done">
            ✓ Imported {plural(result.notes, 'note')}{result.folders ? ` and ${plural(result.folders, 'folder')}` : ''}
            into {destinationLabel(result.into)}.
          </p>
          {#each result.sources as app (app)}
            <p class="status">
              Recognised a {SOURCE_NAMES[app].name} export: {SOURCE_NAMES[app].kept} kept as they were.
            </p>
          {/each}
          {#if result.trashed > 0}
            <p class="status">
              {plural(result.trashed, 'note')} in its trash {result.trashed === 1 ? 'was' : 'were'} left out.
            </p>
          {/if}
          {#if result.titledFromName > 0}
            <p class="status">
              {plural(result.titledFromName, 'note')} gained a heading with {result.titledFromName === 1 ? 'its' : 'their'}
              file name, because a note’s title is its first line — so links to {result.titledFromName === 1 ? 'it' : 'them'} by name still work.
            </p>
          {/if}
          {#if result.skipped.length > 0}
            <details class="skipped">
              <summary>{plural(result.skipped.length, 'file')} skipped — not Markdown or text</summary>
              <ul>
                {#each result.skipped.slice(0, 50) as path (path)}<li>{path}</li>{/each}
                {#if result.skipped.length > 50}<li>…and {result.skipped.length - 50} more</li>{/if}
              </ul>
            </details>
          {/if}
          <div class="actions">
            <button type="button" class="primary show" onclick={show}>
              {result.notes === 1 ? 'Open note' : 'Show'}
            </button>
            <button type="button" class="secondary" onclick={() => (result = null)}>Import more</button>
          </div>
        {:else if staged}
          <p class="status">Ready to import {describeSource(staged)}</p>
          <label class="into">
            <span>Into</span>
            <select bind:value={destination}>
              <option value="">Top level</option>
              {#each workspace.folderTree as folder (folder.id)}
                <option value={folder.id}>{'   '.repeat(folder.depth)}{folder.name}</option>
              {/each}
            </select>
          </label>
          <div class="actions">
            <button type="button" class="primary" bind:this={importButton} onclick={() => void runImport()}>Import</button>
            <button type="button" class="secondary" onclick={() => (staged = null)}>Cancel</button>
          </div>
        {:else}
          <p class="status">Drop Markdown, text or .zip files here</p>
          <p class="fine">Or drop them anywhere in the app. Folders inside a zip are kept.</p>
          <div class="actions">
            <button type="button" class="secondary" onclick={() => fileInput?.click()}>Choose files…</button>
            <button type="button" class="secondary" onclick={() => folderInput?.click()}>Choose a folder…</button>
          </div>
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept={[...TEXT_EXTENSIONS, '.zip', '.json'].join(',')}
        hidden
        onchange={onPick}
      />
      <input bind:this={folderInput} type="file" webkitdirectory hidden onchange={onPick} />
    </section>
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

  section {
    padding: 10px 8px 12px;
  }

  section + section {
    border-top: 1px solid var(--border);
  }

  h3 {
    margin: 2px 8px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .row {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    padding: 8px;
    border-radius: 6px;
    min-height: 44px;
    cursor: pointer;
  }

  .row:hover:not(:disabled),
  .row:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }

  .row:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .fine {
    margin: 6px 8px 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  .zone {
    margin: 0 8px;
    padding: 18px 14px;
    border: 1.5px dashed var(--border);
    border-radius: 8px;
    background: var(--bg-sunken);
    text-align: center;
    transition: border-color 120ms, background-color 120ms;
  }

  .zone.over,
  .zone.ready {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .zone .fine {
    margin: 4px 0 0;
  }

  .status {
    margin: 0;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .status.done {
    font-weight: 500;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
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

  .primary:hover {
    filter: brightness(1.08);
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
  }

  .secondary:hover {
    border-color: var(--text-faint);
  }

  .into {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-dim);
  }

  select {
    font: inherit;
    color: var(--text);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    max-width: 240px;
  }

  .bar {
    position: relative;
    height: 4px;
    margin: 12px 0 2px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }

  .bar span {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent);
    transition: width 120ms;
  }

  .bar span.indeterminate {
    width: 30%;
    animation: slide 1s ease-in-out infinite;
  }

  @keyframes slide {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar span.indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }

  .skipped {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-dim);
    text-align: left;
  }

  .skipped summary {
    cursor: pointer;
    text-align: center;
  }

  .skipped ul {
    margin: 6px 0 0;
    padding-left: 18px;
    max-height: 120px;
    overflow-y: auto;
    overflow-wrap: anywhere;
  }

  .error {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--danger);
  }
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
    }

    .panel {
      width: 100%;
      max-width: none;
      min-height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
</style>
