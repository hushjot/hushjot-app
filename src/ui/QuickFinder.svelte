<script lang="ts">
  /**
   * Cmd/Ctrl+P quick finder (§11) — a VS Code-style palette over every note.
   *
   * Results update while typing without a debounce: the index answers in well
   * under a millisecond (Spike 3), so debouncing would add latency to hide a
   * cost that is not there. Stale replies are dropped by sequence number in
   * SearchClient, so out-of-order answers cannot flicker the list.
   *
   * It is also the command palette. A query starting with `>` lists commands
   * instead of notes, VS Code-style, so ⌘P is one door to both — and the
   * palette doubles as the list of every shortcut, which matters because the
   * welcome note is seeded once and never learns about new ones. Commands are
   * a ~35-item array, so a substring filter is all the search they need.
   */
  import { orderForList, type NoteMeta } from '../core/notes/model.ts';
  import { noteSort } from './state/noteSort.svelte.ts';
  import type { SearchHit } from '../core/search/index.ts';
  import { untrack } from 'svelte';
  import { relativeTime } from './format.ts';

  export interface PaletteCommand {
    id: string;
    label: string;
    group: string;
    keys: readonly string[];
  }

  interface Props {
    open: boolean;
    /** What the finder opens as: notes, notes to open beside, or commands. */
    mode?: 'notes' | 'beside' | 'commands';
    metas: readonly NoteMeta[];
    commands?: readonly PaletteCommand[];
    search: (query: string) => Promise<SearchHit[]>;
    onPick: (id: string) => void;
    /** ⌘Enter on a note. Absent where tiling is (a phone). */
    onPickBeside?: ((id: string) => void) | undefined;
    onRunCommand?: (id: string) => void;
    onClose: () => void;
  }

  let {
    open,
    mode = 'notes',
    metas,
    commands = [],
    search,
    onPick,
    onPickBeside,
    onRunCommand,
    onClose,
  }: Props = $props();

  let query = $state('');
  let active = $state(0);
  let results = $state<NoteMeta[]>([]);
  let input = $state<HTMLInputElement>();
  let listEl = $state<HTMLUListElement>();

  const byId = $derived(new Map(metas.map((m) => [m.id, m])));
  const commandMode = $derived(query.startsWith('>'));
  const commandResults = $derived.by(() => {
    const needle = query.slice(1).trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(needle));
  });
  const count = $derived(commandMode ? commandResults.length : results.length);
  const activeOptionId = $derived.by(() => {
    if (commandMode) {
      const command = commandResults[active];
      return command ? `finder-cmd-${command.id}` : undefined;
    }
    const note = results[active];
    return note ? `finder-opt-${note.id}` : undefined;
  });

  $effect(() => {
    void commandResults;
    active = 0;
  });

  // With no query, offer pinned notes and then the rest in the order the list
  // beside this dialog is using — the palette is useful as a switcher before it
  // is useful as a search box, and a pin is a note the user has said they come
  // back to. A *searched* list stays in relevance order: a score is a better
  // answer to "which note did I mean" than any date or title, and the sidebar's
  // preference is about browsing.
  const RECENT_LIMIT = 20;

  $effect(() => {
    if (!open) return;
    const text = query;
    if (text.startsWith('>')) return;

    let cancelled = false;
    if (!text.trim()) {
      results = orderForList(metas, noteSort.current).slice(0, RECENT_LIMIT);
      active = 0;
      return;
    }

    void search(text).then((hits) => {
      if (cancelled) return;
      results = hits.map((h) => byId.get(h.id)).filter((m): m is NoteMeta => m !== undefined);
      active = 0;
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (open) {
      query = untrack(() => mode) === 'commands' ? '>' : '';
      input?.focus();
    } else {
      query = '';
    }
  });

  // Keep the highlighted row in view during keyboard navigation.
  $effect(() => {
    const index = active;
    if (!listEl) return;
    listEl.children[index]?.scrollIntoView({ block: 'nearest' });
  });

  /** Escape works even if focus has drifted out of the input. */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      if (count) active = (active + 1) % count;
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      if (count) active = (active - 1 + count) % count;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (commandMode) {
        const command = commandResults[active];
        if (command) onRunCommand?.(command.id);
        return;
      }
      const picked = results[active];
      if (!picked) return;
      // ⌘Enter opens beside, the way VS Code's quick open opens to the side.
      const beside = mode === 'beside' || event.metaKey || event.ctrlKey;
      if (beside && onPickBeside) onPickBeside(picked.id);
      else onPick(picked.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<!-- Escape closes the palette from anywhere, so the backdrop's click has a
     keyboard equivalent without needing a handler that traps focus.
     `svelte:window` must be top-level, so it guards on `open` itself. -->
<svelte:window onkeydown={onWindowKeydown} />

{#if open}
  <!-- Clicking the backdrop itself closes; clicks inside the dialog bubble
       through here but are ignored because the target is not the backdrop. -->
  <div
    class="backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label={commandMode ? 'Run a command' : 'Find a note'}
      tabindex="-1"
    >
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKeydown}
        type="text"
        class="input"
        placeholder={mode === 'beside' ? 'Open beside…' : 'Search notes… (type > for commands)'}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        aria-controls="finder-results"
        aria-activedescendant={activeOptionId}
      />

      <ul class="results" id="finder-results" role="listbox" bind:this={listEl}>
        {#if commandMode}
          {#each commandResults as command, i (command.id)}
            <li
              id="finder-cmd-{command.id}"
              role="option"
              aria-selected={i === active}
              class="result"
              class:active={i === active}
            >
              <button
                type="button"
                onclick={() => onRunCommand?.(command.id)}
                onmousemove={() => (active = i)}
              >
                <span class="title">{command.label}</span>
                <span class="keys">
                  {#each command.keys as key (key)}<kbd>{key}</kbd>{/each}
                </span>
              </button>
            </li>
          {:else}
            <li class="empty">No matching commands</li>
          {/each}
        {:else}
        {#each results as note, i (note.id)}
          <li
            id="finder-opt-{note.id}"
            role="option"
            aria-selected={i === active}
            class="result"
            class:active={i === active}
          >
            <button type="button" onclick={() => onPick(note.id)} onmousemove={() => (active = i)}>
              <span class="title">{note.title}</span>
              {#if note.pinnedAt !== null}<span class="pinned">Pinned</span>{/if}
              <span class="when">{relativeTime(note.updatedAt)}</span>
            </button>
          </li>
        {:else}
          <li class="empty">
            {query.trim() ? 'No matching notes' : 'No notes yet'}
            <!-- The one place the grammar is taught. The placeholder already
                 teaches `>`, but it has room for one operator and there are
                 four; a query that found nothing is the moment someone wants
                 to know how to narrow, or why their `#include` matched
                 nothing. Not a permanent row: it would be furniture above
                 every successful search. -->
            <span class="syntax">
              <code>#tag</code>
              <code>in:folder</code>
              <code>"phrase"</code>
              <code>-exclude</code>
            </span>
          </li>
        {/each}
        {/if}
      </ul>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    justify-content: center;
    /* Without this the palette stretches to the full backdrop height and a
       single result sits at the top of a tall empty box. */
    align-items: flex-start;
    /* Sits high on screen so the results grow downward into empty space. */
    padding: 10vh 16px 16px;
    z-index: 50;
  }

  .palette {
    width: min(620px, 100%);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .input {
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    padding: 13px 15px;
    outline: none;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .result button {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 8px 11px;
    border-radius: 6px;
    cursor: pointer;
    min-height: 40px;
  }

  .result.active button {
    background: var(--accent-soft);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result.active .title {
    font-weight: 600;
  }

  .when {
    color: var(--text-faint);
    font-size: 12px;
    flex: 0 0 auto;
  }

  .pinned {
    color: var(--accent);
    font-size: 11px;
    flex: 0 0 auto;
  }

  .keys {
    display: flex;
    gap: 4px;
    flex: 0 0 auto;
  }

  kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    background: var(--bg);
    white-space: nowrap;
  }

  .empty {
    padding: 14px;
    color: var(--text-faint);
    text-align: center;
  }
  .syntax {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    justify-content: center;
    margin-top: 10px;
    font-size: 12px;
  }
  /* Wraps rather than scrolls: on a phone the finder is full-bleed and this
     sits above the keyboard, where a horizontal scroller would be missed. */
  .syntax code {
    font-family: var(--mono);
    white-space: nowrap;
  }
  /* A phone has no room for a centred card: 10vh of inset plus a virtual
     keyboard leaves a couple of results visible. Full-bleed puts the field
     under the status bar and gives every remaining pixel to the results. */
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
    }

    .palette {
      width: 100%;
      max-width: none;
      max-height: 100%;
      height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: env(safe-area-inset-top);
    }
  }
</style>
