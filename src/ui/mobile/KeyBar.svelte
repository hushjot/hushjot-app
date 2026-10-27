<script lang="ts">
  /**
   * The Markdown accessory bar, above the virtual keyboard.
   *
   * On a phone keyboard `#`, `**`, `` ` `` and `[](…)` each cost two or three
   * layout switches, which makes writing Markdown on a phone the slowest part
   * of the app by a wide margin. Every button here runs a command the desktop
   * already binds to a chord — see `src/editor/accessoryKeys.ts`. Nothing new
   * is being invented, only reached differently.
   *
   * The id type is imported with `import type` so it erases: this component
   * carries no CodeMirror code into the phone chunk.
   *
   * Twelve 44px targets are wider than a 412px screen, so the strip scrolls
   * horizontally. The alternative — smaller buttons — is the thing this whole
   * redesign exists to stop.
   */
  import type { AccessoryId } from '../../editor/accessoryKeys.ts';

  interface Props {
    onAction: (id: AccessoryId) => void;
    onDismiss: () => void;
  }

  let { onAction, onDismiss }: Props = $props();

  const KEYS: { id: AccessoryId; label: string; glyph: string }[] = [
    { id: 'heading', label: 'Heading', glyph: 'H' },
    { id: 'bold', label: 'Bold', glyph: 'B' },
    { id: 'italic', label: 'Italic', glyph: 'I' },
    { id: 'bullet', label: 'Bullet list', glyph: '•' },
    { id: 'task', label: 'Task list', glyph: '☑' },
    { id: 'quote', label: 'Quote', glyph: '❝' },
    { id: 'link', label: 'Link', glyph: '🔗' },
    { id: 'fence', label: 'Code block', glyph: '</>' },
    { id: 'outdent', label: 'Outdent', glyph: '⇤' },
    { id: 'indent', label: 'Indent', glyph: '⇥' },
    { id: 'undo', label: 'Undo', glyph: '↶' },
    { id: 'redo', label: 'Redo', glyph: '↷' },
  ];
</script>

<!-- `onpointerdown` with preventDefault, not `onclick`: a click would move
     focus out of the editor first, which closes the keyboard and collapses the
     selection the command is about to act on. -->
<div class="keybar" role="toolbar" aria-label="Markdown formatting">
  <div class="keys">
    {#each KEYS as key (key.id)}
      <button
        type="button"
        class="key"
        class:bold-glyph={key.id === 'bold'}
        class:italic-glyph={key.id === 'italic'}
        class:code-glyph={key.id === 'fence'}
        aria-label={key.label}
        title={key.label}
        onpointerdown={(event) => {
          event.preventDefault();
          onAction(key.id);
        }}
      >
        <span aria-hidden="true">{key.glyph}</span>
      </button>
    {/each}
  </div>

  <button
    type="button"
    class="key dismiss"
    aria-label="Hide keyboard"
    title="Hide keyboard"
    onpointerdown={(event) => {
      event.preventDefault();
      onDismiss();
    }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5 12 15.5 18 9.5" /></svg>
  </button>
</div>

<style>
  .keybar {
    display: flex;
    align-items: stretch;
    flex: 0 0 auto;
    min-height: var(--keybar-h);
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    /* Where the keyboard is not drawn over the page (Android, and any desktop
       browser narrow enough to be here) this is 0 and the bar simply sits at
       the bottom of the flow. See `keyboardInset.ts`. */
    margin-bottom: var(--kb-inset, 0px);
  }

  .keys {
    flex: 1;
    display: flex;
    overflow-x: auto;
    /* Claim horizontal pans so the strip scrolls without the page trying to. */
    touch-action: pan-x;
    scrollbar-width: none;
  }

  .keys::-webkit-scrollbar {
    display: none;
  }

  .key {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 44px;
    min-height: var(--keybar-h);
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
    touch-action: manipulation;
  }

  /* B and I say what they do by how they are set, the way a word processor's
     do — on their own they would just be two letters. */
  .key.bold-glyph {
    font-weight: 700;
  }

  /* Three characters in a 44px cell. */
  .key.code-glyph {
    font-family: var(--mono);
    font-size: 13px;
  }

  .key.italic-glyph {
    font-style: italic;
    font-family: Georgia, 'Times New Roman', serif;
  }

  .key:active {
    background: var(--bg-raised);
  }

  /* Pinned to the end, outside the scroller: dismissing the keyboard must not
     require scrolling the bar to find it. */
  .dismiss {
    border-left: 1px solid var(--border);
    color: var(--text-dim);
  }

  .dismiss svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
