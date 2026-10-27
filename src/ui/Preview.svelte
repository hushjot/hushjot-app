<script lang="ts">
  /**
   * Read-only rendered Markdown for one tile (§10: "a rendered preview can be
   * added later if it does not compromise simplicity or performance").
   *
   * It stays off the typing path. The editor writes `content` into the store and
   * returns. This component only notices that the value changed and arms a timer:
   * a 150 ms idle debounce, a 1 s ceiling so a long burst of typing still
   * shows up, then an idle callback so rendering yields to input. Opening the
   * preview renders at once, because there is nothing to yield to.
   *
   * Loaded by dynamic import the first time any tile leaves edit mode, so
   * someone who never opens a preview never downloads it (§28).
   */
  import { onMount, untrack } from 'svelte';
  import { PreviewRenderer } from '../editor/preview/render.ts';
  // The rendered-Markdown rules, shared with the standalone share viewer
  // (`src/viewer/`) because both mount the same DOM from the same renderer.
  import '../editor/preview/markdown.css';

  interface Props {
    content: string;
    /** A `#tag` in the text was clicked: show the notes carrying it. */
    onTag?: ((key: string) => void) | undefined;
    /**
     * A task checkbox was clicked; `at` is the source offset of its `[ ]`.
     * Answer whether the source changed. Omit it — as the history panel does,
     * showing a version nobody may edit — and the checkboxes stay inert.
     */
    onToggleTask?: ((at: number) => boolean) | undefined;
    /**
     * A `[[note link]]` was clicked; `target` is the title it names, and the
     * caller resolves it. Omit it and the links stay inert, for the same reason
     * the checkboxes do.
     */
    onNoteLink?: ((target: string) => void) | undefined;
  }

  let { content, onTag, onToggleTask, onNoteLink }: Props = $props();

  const IDLE_MS = 150;
  const CEILING_MS = 1000;

  let scroller = $state<HTMLDivElement>();
  let article = $state<HTMLElement>();
  let renderer: PreviewRenderer | undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let pendingSince = 0;

  function flush(): void {
    timer = undefined;
    idle = undefined;
    pendingSince = 0;
    renderer?.render(untrack(() => content));
  }

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    timer = undefined;
    idle = undefined;
  }

  function schedule(): void {
    const now = performance.now();
    if (pendingSince === 0) pendingSince = now;
    cancel();
    const wait = Math.max(0, Math.min(IDLE_MS, pendingSince + CEILING_MS - now));
    timer = setTimeout(() => {
      timer = undefined;
      if (typeof requestIdleCallback === 'function') {
        idle = requestIdleCallback(flush, { timeout: 200 });
      } else {
        flush();
      }
    }, wait);
  }

  onMount(() => {
    renderer = new PreviewRenderer(article!, {
      onTag: (key) => onTag?.(key),
      // Whether the controls are interactive is settled once, at mount: a caller
      // either has a note to act on for the life of this component or has none
      // at all.
      onToggleTask: onToggleTask ? (at) => onToggleTask(at) : undefined,
      onNoteLink: onNoteLink ? (target) => onNoteLink(target) : undefined,
    });
    renderer.render(untrack(() => content));
    return () => {
      cancel();
      renderer?.destroy();
      renderer = undefined;
    };
  });

  $effect(() => {
    content;
    if (renderer) schedule();
  });

  /** Split view: keep the preview level with the editor's top visible line. */
  export function scrollToSource(pos: number): void {
    if (renderer && scroller) renderer.scrollToSource(scroller, pos);
  }

  export function focus(): void {
    scroller?.focus({ preventScroll: true });
  }

</script>

<!-- tabindex: the preview is read-only but must still scroll by keyboard. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="preview" bind:this={scroller} tabindex="0" role="document" aria-label="Rendered Markdown">
  <article class="markdown" bind:this={article}></article>
</div>

<style>
  .preview {
    height: 100%;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
</style>
