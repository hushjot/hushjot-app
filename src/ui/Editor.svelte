<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { accessoryCommand, type AccessoryId } from '../editor/accessoryKeys.ts';
  import { toggleTaskAtSpec } from '../editor/formatKeys.ts';
  import type { EditorState } from '@codemirror/state';
  import {
    createEditorState,
    gutterCompartment,
    gutterExtension,
    refreshTextMetrics,
  } from '../editor/setup.ts';
  import { spellcheck } from './state/spellcheck.svelte.ts';
  import { textSize } from './state/textSize.svelte.ts';
  import { lineWrap } from './state/lineWrap.svelte.ts';
  import { editorFont } from './state/editorFont.svelte.ts';
  import { linkAt } from '../editor/wikiLink.ts';
  import type { Tag } from '../core/notes/tags.ts';
  import type { NoteMeta } from '../core/notes/model.ts';
  import type { NoteLink } from '../core/notes/links.ts';

  interface Props {
    noteId: string | null;
    content: string;
    showGutter: boolean;
    /**
     * Take focus on mount. Only the focused tile should: restoring four tiles
     * would otherwise leave the caret in whichever editor mounted last, and
     * focusing a tile is what makes it the focused one.
     */
    autofocus?: boolean;
    /**
     * Carries the note id the edit belongs to — the one mounted when the
     * transaction ran — rather than leaving the caller to assume it. With
     * several editors on screen, "the selected note" is not necessarily the
     * one that was typed into.
     */
    onChange: (noteId: string, content: string) => void;
    /**
     * Split view's scroll sync: the document offset of the top visible line.
     * Read once per frame from the scroll event, never from a transaction, so
     * it costs nothing on the typing path and nothing when absent.
     */
    onScrollTop?: ((pos: number) => void) | undefined;
    /** Tags already in use, for completion after `#`. */
    tagSource?: (() => readonly Tag[]) | undefined;
    /** Note titles, for completion after `[[`. */
    titleSource?: (() => readonly NoteMeta[]) | undefined;
    /** ⌘-click landed on a `[[note link]]`; the caller resolves the title. */
    onOpenLink?: ((target: string) => void) | undefined;
    /** The link chip's Create, for a tapped `[[link]]` that names no note. */
    onCreateNote?: ((title: string) => void) | undefined;
  }

  let {
    noteId,
    content,
    showGutter,
    autofocus = true,
    onChange,
    onScrollTop,
    tagSource,
    titleSource,
    onOpenLink,
    onCreateNote,
  }: Props = $props();

  let host = $state<HTMLDivElement>();
  let view: EditorView | undefined;

  /**
   * One EditorState per note, so switching notes keeps each note's undo
   * history and scroll position instead of resetting them. Swapping state is
   * also far cheaper than tearing down and rebuilding the whole view.
   */
  const states = new Map<string, EditorState>();
  const MAX_CACHED = 24;
  let mountedNoteId: string | null = null;
  /** The last text this editor handed to the store, used to ignore echoes. */
  let lastEmitted: string | null = null;

  function emit(text: string): void {
    lastEmitted = text;
    if (mountedNoteId !== null) onChange(mountedNoteId, text);
  }

  /**
   * CodeMirror reads this from its own attribute pass, which runs inside *any*
   * dispatch — including the content-sync effect below. `untrack` is what
   * stops that effect taking a dependency on the preference and re-running
   * every time it is flipped.
   */
  const spellcheckEnabled = () => untrack(() => spellcheck.enabled);

  /**
   * `untrack` for the same reason: a completion source runs inside the dispatch
   * that opened the popup, and the content-sync effect below is what is running
   * when it does. Without this, typing `[[` would make that effect depend on the
   * whole note list and re-run on every save anywhere in the vault.
   */
  const titles = () => untrack(() => titleSource?.() ?? []);

  /**
   * Stable, so the twenty-four cached states all reach the current prop. Bound
   * at build time like `tagSource`, the first state built would hold whatever
   * `onOpenLink` was then — which on mount is often nothing.
   */
  const openLink = (target: string): void => {
    untrack(() => onOpenLink)?.(target);
  };

  /** Stable for the same reason as `openLink`. */
  const createNote = (title: string): void => {
    const create = untrack(() => onCreateNote);
    if (create) create(title);
    else openLink(title);
  };

  function remember(id: string, state: EditorState): void {
    // Re-inserting moves the key to the end, giving a cheap LRU ordering.
    states.delete(id);
    states.set(id, state);
    while (states.size > MAX_CACHED) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }

  function stateFor(id: string, text: string): EditorState {
    const cached = states.get(id);
    // The store is the source of truth: if it has diverged from the cached
    // state (an external edit, a sync landing later) rebuild rather than
    // silently showing stale text.
    if (cached && cached.doc.toString() === text) return cached;
    return createEditorState(text, {
      onChange: emit,
      showGutter,
      tagSource,
      titleSource: titles,
      spellcheck: spellcheckEnabled,
      onOpenLink: openLink,
      onCreateNote: createNote,
    });
  }

  function swapTo(id: string | null, text: string): void {
    if (!view) return;

    if (mountedNoteId !== null && mountedNoteId !== id) {
      remember(mountedNoteId, view.state);
    }

    if (id === null) {
      view.setState(
        createEditorState('', {
          onChange: emit,
          showGutter,
          tagSource,
          titleSource: titles,
          spellcheck: spellcheckEnabled,
          onOpenLink: openLink,
          onCreateNote: createNote,
        }),
      );
      mountedNoteId = null;
      return;
    }

    view.setState(stateFor(id, text));
    mountedNoteId = id;
  }

  onMount(() => {
    const initialId = untrack(() => noteId);
    const initialText = untrack(() => content);

    view = new EditorView({
      state: createEditorState(initialText, {
        onChange: emit,
        showGutter: untrack(() => showGutter),
        tagSource: untrack(() => tagSource),
        titleSource: titles,
        spellcheck: spellcheckEnabled,
        onOpenLink: openLink,
        onCreateNote: createNote,
      }),
      parent: host!,
    });
    mountedNoteId = initialId;

    // Desktop opens ready to type. On a phone this would summon the virtual
    // keyboard before the user has asked for it.
    if (untrack(() => autofocus) && window.matchMedia('(min-width: 721px)').matches) view.focus();

    let frame = 0;
    const onScroll = () => {
      if (frame || !onScrollTop) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!view || !onScrollTop) return;
        const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
        onScrollTop(view.lineBlockAtHeight(Math.max(0, height)).from);
      });
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      view?.scrollDOM.removeEventListener('scroll', onScroll);
      view?.destroy();
      view = undefined;
      states.clear();
    };
  });

  // Swap documents when the selected note changes.
  $effect(() => {
    const id = noteId;
    if (!view || id === mountedNoteId) return;
    swapTo(id, untrack(() => content));
  });

  // Accept content that changed *outside* the editor for the note already
  // mounted — a body finishing its async load, or in Phase 4 a remote edit
  // landing. Without this the editor keeps showing whatever it mounted with,
  // and the next keystroke persists that stale document over the real text.
  //
  // `lastEmitted` distinguishes the store echoing our own keystroke back
  // (ignore) from a genuinely external change (adopt).
  $effect(() => {
    const incoming = content;
    if (!view || noteId !== mountedNoteId) return;
    if (incoming === lastEmitted) return;
    if (incoming === view.state.doc.toString()) return;

    const selection = view.state.selection.main;
    const anchor = Math.min(selection.anchor, incoming.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: incoming },
      selection: { anchor },
    });
  });

  // Line numbers come and go with viewport width without rebuilding the view.
  $effect(() => {
    const enabled = showGutter;
    if (!view) return;
    view.dispatch({
      effects: gutterCompartment.reconfigure(gutterExtension(enabled)),
    });
  });

  // Spellcheck is read by CodeMirror's attribute pass, which only runs on an
  // update: an empty transaction is what makes the change visible now rather
  // than at the next keystroke. The cached states need no poke — `setState`
  // runs the same pass when one of them is swapped in.
  $effect(() => {
    spellcheck.enabled;
    if (!view) return;
    view.dispatch({});
  });

  // Text size arrives as a CSS variable, which is invisible to CodeMirror: no
  // transaction fires, so nothing invalidates its cached line heights and the
  // gutter, scroll height and cursor geometry stay measured for the old size.
  $effect(() => {
    textSize.px;
    view?.requestMeasure();
  });

  // Line wrap is CSS too (`state/lineWrap.svelte.ts`). A measure is where
  // CodeMirror notices the content's white-space has changed and re-derives
  // its height estimates for wrapped or unwrapped lines.
  $effect(() => {
    lineWrap.mode;
    view?.requestMeasure();
  });

  // The font arrives the same way and is worse: a family change moves the
  // character width but not the line box, so even the measure above would
  // leave `charWidth` wrong. `refreshTextMetrics` says why that needs its own
  // call and why it lives in `setup.ts`.
  $effect(() => {
    editorFont.choice;
    if (view) refreshTextMetrics(view);
  });

  export function focus(): void {
    view?.focus();
  }

  /**
   * Run one of the phone key bar's commands.
   *
   * The id is a plain string so the bar carries no CodeMirror code; the map it
   * resolves against lives in `src/editor/accessoryKeys.ts` and is built from
   * the same commands the desktop keymap binds.
   *
   * Focus is restored first because the bar's button took it on press, and a
   * command that runs against an unfocused view leaves the keyboard closed and
   * the selection where the user cannot see it.
   */
  export function runAccessory(id: AccessoryId): void {
    if (!view) return;
    view.focus();
    accessoryCommand(id)(view);
  }

  /**
   * Tick the task whose `[ ]` starts at `at` — the preview's checkboxes, which
   * edit the source rather than a rendering of it. One transaction, so it is
   * the store's ordinary write path and one undo step.
   *
   * It deliberately does not focus: the preview must keep focus (nothing may
   * focus the editor in preview mode), and on a phone taking it would raise the
   * keyboard over the list the user is ticking.
   *
   * Returns whether anything changed, so the preview can tick the box now
   * instead of waiting for the render that follows.
   */
  export function toggleTaskAt(at: number): boolean {
    if (!view || view.state.readOnly) return false;
    const spec = toggleTaskAtSpec(view.state, at);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  }

  /**
   * The `[[note link]]` the caret is in, for the `follow-link` command.
   *
   * The keyboard's route to a link, because ⌘-click is a mouse and the phone has
   * neither. It reads the syntax tree rather than the text, so it agrees with
   * what is highlighted, and it returns null rather than guessing when the caret
   * is merely near one.
   */
  export function linkAtCursor(): NoteLink | null {
    if (!view) return null;
    return linkAt(view.state, view.state.selection.main.head);
  }

  /** Dismiss the virtual keyboard. `blur()` is what actually closes it on iOS. */
  export function blurEditor(): void {
    view?.contentDOM.blur();
  }

  /** Document offset of the top visible line, for aligning a newly opened split. */
  export function topPosition(): number {
    if (!view) return 0;
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    return view.lineBlockAtHeight(Math.max(0, height)).from;
  }
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  /* CodeMirror renders its own scroller; let it own the scrolling region. */
  .editor :global(.cm-editor) {
    height: 100%;
  }

  .editor :global(.cm-scroller) {
    overflow: auto;
    -webkit-overflow-scrolling: touch;
  }
</style>
