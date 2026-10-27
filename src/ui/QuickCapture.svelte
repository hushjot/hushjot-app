<script lang="ts">
  /**
   * How to send text to HushJot from somewhere else.
   *
   * Its own lazy chunk, like the share and export dialogs (§28): it is opened
   * once, when someone sets this up, and never again.
   *
   * ## Why there is a screen at all, and why it is mostly words
   *
   * Android needs no setup — installing the app puts HushJot in the share
   * sheet — so that half is one paragraph confirming what to expect. iOS
   * cannot do the same at any price: Safari does not offer its share sheet to
   * a web app, so the only route in is a Shortcut the user builds by hand.
   * Eight steps of instructions is not a nice thing to ship, but the
   * alternative is no quick capture on iOS at all, and the steps are a
   * once-ever cost.
   *
   * The URL prefix is shown for *this* origin rather than hard-coded, so the
   * instructions are correct on a dev build and on a self-hosted one, and so
   * "Copy" hands over something that actually works.
   *
   * ## Why the platform only changes the order
   *
   * `isIosLike` decides which half goes first, not which half exists. A user
   * setting up their phone from their laptop is a normal thing to do, and a
   * screen that hid the instructions they came for because of the device they
   * are holding would be worse than a screen that is slightly too long.
   */
  import { isIosLike } from './install.ts';
  import { CAPTURE_PREFIX } from '../core/capture/link.ts';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let said = $state<string | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  const prefix = `${window.location.origin}/#${CAPTURE_PREFIX}.`;
  const iosFirst = isIosLike(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  $effect(() => {
    panelEl?.focus();
  });

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  }

  async function copyPrefix(): Promise<void> {
    try {
      await navigator.clipboard.writeText(prefix);
      said = 'Copied';
    } catch {
      said = 'Your browser would not let the page copy — select it instead';
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && onClose()}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="capture-title" tabindex="-1" bind:this={panelEl}>
    <header class="head">
      <h2 id="capture-title">Quick capture</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close">×</button>
    </header>

    <section>
      <p class="lede">
        Send text to HushJot from another app and it becomes a new note, encrypted like every
        other one. Nothing you share leaves your device in the clear.
      </p>
    </section>

    {#snippet android()}
      <section>
        <h3>Android</h3>
        <p>
          Nothing to set up. Once HushJot is installed to your home screen, it appears in the
          share sheet of every app — tap <strong>Share</strong>, pick HushJot, and the note opens
          ready to edit.
        </p>
        <p class="fine">
          If you installed HushJot before this version, accept the update prompt first. Your
          browser re-reads the app's details on its own schedule, so it can take a launch or two
          to appear; reinstalling is the quick way.
        </p>
      </section>
    {/snippet}

    {#snippet ios()}
      <section>
        <h3>iPhone and iPad</h3>
        <p>
          Safari will not offer its share sheet to a web app, so iOS needs a Shortcut. You only
          build it once.
        </p>
        <ol>
          <li>Open <strong>Shortcuts</strong> and tap <strong>+</strong>.</li>
          <li>
            Tap the <strong>ⓘ</strong> button, turn on <strong>Show in Share Sheet</strong>, and
            set the accepted input to <strong>Text</strong> only.
          </li>
          <li>Add the <strong>URL Encode</strong> action and set it to encode <strong>Shortcut Input</strong>.</li>
          <li>
            Add a <strong>Text</strong> action containing this, followed by the encoded result:
            <span class="prefix">
              <code>{prefix}</code>
              <button type="button" class="inline-link" onclick={() => void copyPrefix()}>Copy</button>
            </span>
          </li>
          <li>Add the <strong>Open URLs</strong> action and give it that text.</li>
          <li>Name it something like <strong>Add to HushJot</strong> and save.</li>
        </ol>
        <p>
          Now select text anywhere, tap <strong>Share</strong>, and choose your shortcut.
        </p>
        <p class="fine">
          The text travels in the part of the address after the <code>#</code>, which browsers
          never send to a server. <strong>The shortcut opens your default browser, not the home
          screen app</strong> — on iOS those keep separate storage, so you may be asked for your
          passphrase there. With an account the note syncs on to your other devices from either.
        </p>
      </section>
    {/snippet}

    {#if iosFirst}
      {@render ios()}
      {@render android()}
    {:else}
      {@render android()}
      {@render ios()}
    {/if}

    {#if said}
      <p class="said" role="status" aria-live="polite">{said}</p>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: flex-start;
    justify-content: center;
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
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  section:last-of-type {
    border-bottom: 0;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
  }

  p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.5;
  }

  p:last-child {
    margin-bottom: 0;
  }

  .lede {
    color: var(--text-dim);
    margin: 0;
  }

  .fine {
    color: var(--text-dim);
    font-size: 12px;
  }

  ol {
    margin: 0 0 8px;
    padding-left: 20px;
    font-size: 13px;
    line-height: 1.6;
  }

  li {
    margin-bottom: 4px;
  }

  .prefix {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  code {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 5px;
    overflow-wrap: anywhere;
  }

  .inline-link {
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }

  .said {
    padding: 0 16px 14px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
