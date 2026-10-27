<script lang="ts">
  /**
   * The whole share viewer: read a link, decrypt it, render it.
   *
   * ## The key never leaves this page
   *
   * It arrives in `location.hash`, which no browser transmits — not in the
   * request line, not in `Referer`, and `Referrer-Policy: no-referrer` is set
   * besides. It is read once into a local, imported as a non-extractable
   * `CryptoKey`, and never written to storage, a query string, a header or an
   * error message. The fragment is deliberately *not* stripped from the URL
   * afterwards: reloading has to keep working, and the link is the credential.
   *
   * ## Why the failures are worded the way they are
   *
   * Four different things go wrong and a reader can act on the difference:
   *
   * - **No usable fragment.** Something between the sender and here ate the
   *   part after `#`. Nothing is fetched at all — a half-parsed link must not
   *   ask the backend for a document there is no key for.
   * - **Nothing to fetch.** Revoked, expired, or never published. The backend
   *   answers those identically on purpose (`shareRest.ts`), so this does too.
   * - **Paused.** A cost lockdown refuses every read; `shareRest.ts` tells that
 *   apart from expiry with one more request, and the link is not called gone.
 * - **The key does not fit.** The document was found and the GCM tag failed,
   *   which is a truncated or edited link rather than a missing one.
   *
   * ## Rendering
   *
   * `PreviewRenderer` builds every node with `createElement` and `textContent`
   * — no `innerHTML`, no `{@html}` — which is what makes rendering somebody
   * else's Markdown on our own origin safe at all. `docs/security.md`, "The
   * Markdown preview", is the contract, and it matters more here than in the
   * app: in the app the text is the reader's own, and here it is not.
   *
   * ## Reading preferences
   *
   * Theme, text size and typeface are the app's own stores, imported as they
   * are: each acts only on `<html>` (an attribute or a custom property the
   * shared token block already reads) and applies at module init, so a saved
   * choice is in place before first paint. They keep the app's `teksto:` keys
   * on purpose — same origin, same reader — so somebody who uses HushJot reads
   * a shared note the way they read their own, and a change here carries back.
   * Those three keys are the only thing this page ever stores, and only after
   * the reader changes one; `bench:share` asserts both halves.
   */
  import { onMount } from 'svelte';
  import { theme } from '../ui/state/theme.svelte.ts';
  import { textSize } from '../ui/state/textSize.svelte.ts';
  import { editorFont } from '../ui/state/editorFont.svelte.ts';
  import { FONT_LABELS, type FontChoice } from '../ui/editorFont.ts';
  import { PreviewRenderer } from '../editor/preview/render.ts';
  import '../editor/preview/markdown.css';
  import { parseFragment, buildFragment, type ShareRef } from '../core/share/link.ts';
  import { importShareKey, openShare, ShareFormatError, type SharePayload } from '../core/share/payload.ts';
  import { DecryptError } from '../core/crypto/envelope.ts';
  import { describeRemaining } from '../core/share/expiry.ts';
  import { fetchShare, SharePausedError, ShareUnreachableError } from '../adapters/firebase/shareRest.ts';
  import { firebaseConfigured } from '../adapters/firebase/config.ts';

  type State =
    | { kind: 'loading' }
    | { kind: 'ready'; note: SharePayload; expireAt: number }
    | { kind: 'incomplete' }
    | { kind: 'gone' }
    | { kind: 'badKey' }
    | { kind: 'stale' }
    | { kind: 'offline' }
    | { kind: 'paused' }
    | { kind: 'noBackend' };

  let view = $state<State>({ kind: 'loading' });
  let source = $state(false);
  let flash = $state<string | null>(null);
  /** Which phone popover is open. Wider screens never show a trigger, so it stays null there. */
  let menu = $state<'reading' | 'more' | null>(null);
  let ref: ShareRef | null = null;

  let article = $state<HTMLElement | null>(null);
  let renderer: PreviewRenderer | null = null;
  /**
   * The element the renderer was built against.
   *
   * Toggling to Source unmounts the `<article>` and toggling back mounts a new
   * one, so a renderer kept across that is holding a node that is no longer in
   * the document — and `render()` would early-return on unchanged text and
   * paint nothing at all. Rebuilding when the root changes is the whole fix.
   */
  let renderedInto: HTMLElement | null = null;

  onMount(() => {
    void load();
    return () => renderer?.destroy();
  });

  async function load(): Promise<void> {
    ref = parseFragment(window.location.hash);
    if (!ref) {
      view = { kind: 'incomplete' };
      return;
    }
    if (!firebaseConfigured) {
      view = { kind: 'noBackend' };
      return;
    }

    try {
      const key = await importShareKey(ref.key);
      const fetched = await fetchShare(ref.id);
      if (!fetched) {
        view = { kind: 'gone' };
        return;
      }
      const note = await openShare(key, fetched.payload);
      view = { kind: 'ready', note, expireAt: fetched.expireAt };
      // The title is already less sensitive than the key sitting in the same
      // URL, and a tab called "Shared note" among ten others is useless.
      if (note.title) document.title = `${note.title} — HushJot`;
    } catch (error) {
      if (error instanceof DecryptError) view = { kind: 'badKey' };
      // `parseFragment` has already checked the key's alphabet and length, so
      // `importShareKey` cannot be what threw this: a format error here means
      // the key worked and the plaintext inside is from a newer publisher.
      else if (error instanceof ShareFormatError) view = { kind: 'stale' };
      else if (error instanceof SharePausedError) view = { kind: 'paused' };
      else if (error instanceof ShareUnreachableError) view = { kind: 'offline' };
      else view = { kind: 'offline' };
    }
  }

  // Render into the article as soon as both it and the text exist, and again
  // when the reader toggles back from source. One render; nothing here types.
  $effect(() => {
    if (view.kind !== 'ready' || source || !article) return;
    if (renderedInto !== article || !renderer) {
      renderer?.destroy();
      renderer = new PreviewRenderer(article);
      renderedInto = article;
    }
    renderer.render(view.note.body);
  });

  function toggleMenu(which: 'reading' | 'more'): void {
    menu = menu === which ? null : which;
  }

  function say(message: string): void {
    flash = message;
    setTimeout(() => (flash = null), 2200);
  }

  async function copy(): Promise<void> {
    if (view.kind !== 'ready') return;
    try {
      await navigator.clipboard.writeText(view.note.body);
      say('Copied');
    } catch {
      say('Your browser would not let the page copy');
    }
  }

  /** Same shape as the app's export: a blob URL on a download link, revoked late. */
  function download(): void {
    if (view.kind !== 'ready') return;
    const name = (view.note.title || 'Shared note').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
    const url = URL.createObjectURL(new Blob([view.note.body], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /**
   * Hand the app the *link*, never the text.
   *
   * Passing the decrypted note through `sessionStorage` would be simpler and
   * would put plaintext into storage, which nothing in this product does. The
   * app can fetch and decrypt it perfectly well itself — it has the same two
   * modules — so all that crosses is the fragment the reader already holds.
   */
  function saveToNotes(): void {
    if (!ref) return;
    window.location.href = `/#${buildFragment(ref)}`;
  }
</script>

<svelte:window
  onhashchange={() => void load()}
  onpointerdown={(event) => {
    if (menu && !(event.target as Element).closest?.('.panel, .menu-btn')) menu = null;
  }}
  onkeydown={(event) => {
    if (menu && event.key === 'Escape') menu = null;
  }}
/>

<div class="viewer">
  <header>
    <div class="who">
      <!-- Often the first HushJot a reader has ever seen, so the mark is the
           real logo and goes to the product site rather than into the app.
           An <img> of the favicon the shell already loaded, not inline SVG:
           it is cached, and it costs this page's JS budget nothing. -->
      <a class="brand" href="https://hushjot.com" target="_blank" rel="noopener">
        <img src="/icons/icon.svg?v=2" alt="" width="22" height="22" />
        <span class="mark">HushJot</span>
      </a>
      {#if view.kind === 'ready'}
        <span class="meta">
          Shared note{view.expireAt ? ` · expires ${describeRemaining(view.expireAt)}` : ''}
        </span>
      {/if}
    </div>

    {#if view.kind === 'ready'}
      <!-- Below 720px the two groups fold behind "Aa" and "⋯" so the header is
           one row. The panels are the same markup at every width: on a wider
           screen the triggers are not displayed and each panel is
           `display: contents`, so the bar is exactly what it was. -->
      <div class="actions">
        <button
          type="button"
          class="icon menu-btn"
          aria-label="Reading preferences"
          aria-expanded={menu === 'reading'}
          onclick={() => toggleMenu('reading')}
        >
          <span class="aa" aria-hidden="true">Aa</span>
        </button>
        <div class="reading panel" class:open={menu === 'reading'} role="group" aria-label="Reading preferences">
          <!-- The same toggle as the app's top bar: the icon shows what a click
               gives you, and the dot marks a choice stored on this device. -->
          <button
            type="button"
            class="icon theme-btn"
            class:pinned={theme.status.pinned}
            onclick={() => theme.toggle()}
            title={`${theme.status.action}\n${theme.status.state}`}
            aria-label={theme.status.ariaLabel}
          >
            {#if theme.effective === 'dark'}
              <svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <path
                  d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M6.9 6.9 4.8 4.8M17.1 17.1l2.1 2.1M17.1 6.9l2.1-2.1M6.9 17.1l-2.1 2.1"
                />
              </svg>
            {:else}
              <svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            {/if}
          </button>

          <div class="textsize" role="group" aria-label="Text size">
            <button
              type="button"
              class="ts-step"
              onclick={() => textSize.decrease()}
              disabled={!textSize.canDecrease}
              title="Smaller text"
              aria-label="Smaller text"
            >
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              class="ts-value"
              onclick={() => textSize.reset()}
              disabled={textSize.isDefault}
              title="Reset text size"
              aria-label="Text size {textSize.px} pixels — reset"
            >
              {textSize.px}
            </button>
            <button
              type="button"
              class="ts-step"
              onclick={() => textSize.increase()}
              disabled={!textSize.canIncrease}
              title="Larger text"
              aria-label="Larger text"
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>

          <!-- A native select rather than the app's Appearance menu: no popover
               to position or dismiss, the phone's own picker for free, and
               about a quarter of the bytes on a page with its own budget. -->
          <span class="font-wrap">
            <select
              class="font"
              title="Font"
              aria-label="Font"
              value={editorFont.choice}
              onchange={(event) => editorFont.set(event.currentTarget.value as FontChoice)}
            >
              <option value="mono">{FONT_LABELS.mono}</option>
              <option value="sans">{FONT_LABELS.sans}</option>
              <option value="serif">{FONT_LABELS.serif}</option>
            </select>
          </span>
        </div>

        <button
          type="button"
          class="icon menu-btn"
          aria-label="More actions"
          aria-expanded={menu === 'more'}
          onclick={() => toggleMenu('more')}
        >
          <svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3" />
          </svg>
        </button>
        <div class="more panel" class:open={menu === 'more'}>
          <div class="seg" role="group" aria-label="View">
            <button class:on={!source} onclick={() => ((source = false), (menu = null))}>Rendered</button>
            <button class:on={source} onclick={() => ((source = true), (menu = null))}>Source</button>
          </div>
          <button onclick={() => ((menu = null), void copy())}>Copy</button>
          <button onclick={() => ((menu = null), download())}>Download</button>
        </div>
        <button class="primary" onclick={saveToNotes}>Save<span class="long">{' to my notes'}</span></button>
      </div>
    {/if}
  </header>

  <main>
    {#if view.kind === 'loading'}
      <p class="quiet">Decrypting…</p>
    {:else if view.kind === 'ready'}
      {#if source}
        <pre class="source">{view.note.body}</pre>
      {:else}
        <article class="markdown" bind:this={article}></article>
      {/if}
    {:else}
      <div class="message" role="status">
        {#if view.kind === 'incomplete'}
          <h1>This link is incomplete</h1>
          <p>
            The part after the <code>#</code> carries the key that decrypts the note, and it is
            missing. Some apps shorten or strip it. Ask whoever sent it for the whole link.
          </p>
        {:else if view.kind === 'gone'}
          <h1>This link is no longer available</h1>
          <p>It has expired, or whoever shared it has withdrawn it.</p>
        {:else if view.kind === 'badKey'}
          <h1>This link’s key does not fit</h1>
          <p>The note is there, but the key in the link will not open it. It was probably truncated in transit.</p>
        {:else if view.kind === 'stale'}
          <h1>This link needs a newer HushJot</h1>
          <p>
            It was published in a format this page does not understand. The key worked, so the
            link is intact — ask whoever sent it which version of HushJot they are running.
          </p>
        {:else if view.kind === 'paused'}
          <h1>Shared notes are temporarily unavailable</h1>
          <p>HushJot is paused for maintenance. The link itself is fine; try it again later.</p>
        {:else if view.kind === 'noBackend'}
          <h1>This build cannot open shared links</h1>
          <p>It was built without a sync backend configured.</p>
        {:else}
          <h1>Could not reach the sync service</h1>
          <p>You appear to be offline, or the service is unavailable. The link itself may be fine.</p>
        {/if}
      </div>
    {/if}

    <!-- Inside <main>, so it scrolls with the note: pinned under it, three
         lines of small print took a phone's screen from the bottom while the
         header took it from the top. It is the one-line pitch behind the bar below:
         what HushJot is, not how the crypto works — a reader looking at plain text
         read "nobody can read this" as a contradiction. -->
    {#if view.kind !== 'loading'}
      <footer>
        <p>Instant, private notes on every device. Free, no account needed.</p>
      </footer>
    {/if}
  </main>

  <!-- The one line every reader sees: the link to the product used to sit at
       the end of the note, where a long one hides it from almost everyone.
       It is beside the note rather than over it, so it never covers a line,
       and it has no dismiss, which would be storage this page does not write.
       An expired or broken link still shows it — that reader is a lead too. -->
  {#if view.kind !== 'loading'}
    <a class="bar" href="https://hushjot.com" target="_blank" rel="noopener">
      <svg class="ico" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span>Shared with <b>HushJot</b><span class="ext">{' — the private, instant notepad for your browser'}</span></span>
      <span class="try">Try it free →</span>
    </a>
  {/if}

  {#if flash}
    <div class="flash" role="status">{flash}</div>
  {/if}
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
    color: var(--text);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sunken);
  }

  .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
  .brand img { display: block; border-radius: 5px; }
  .mark { font-weight: 700; letter-spacing: -0.01em; }
  .meta { color: var(--text-dim); font-size: 12px; }

  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  button {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: var(--text-faint); }
  button.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

  /* Reading preferences: the app's top-bar controls, restyled only as far as
     this page's plainer buttons need. A gap separates them from the actions. */
  .reading { display: flex; align-items: center; gap: 8px; margin-right: 8px; }

  /* The phone popovers' triggers, and the second panel, which is nothing but
     a wrapper on a wider screen. */
  .actions .menu-btn { display: none; }
  .more { display: contents; }
  .aa { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }

  .icon { display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }
  .ico { display: block; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .theme-btn { position: relative; color: var(--text-dim); }
  .theme-btn.pinned::after {
    content: '';
    position: absolute;
    top: 4px;
    right: 4px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .textsize {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    overflow: hidden;
  }
  .textsize button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
    line-height: 1;
    padding: 0 9px;
  }
  .textsize button + button { border-left: 1px solid var(--border); }
  .textsize button:hover:not(:disabled) { color: var(--text); background: var(--bg-sunken); }
  .textsize button:disabled { color: var(--text-faint); cursor: default; }
  .ts-step span { font-size: 15px; }
  .ts-value { min-width: 30px; font-size: 12px; font-variant-numeric: tabular-nums; }

  /* The platform's own select ignores height in Safari and draws its own
     arrows, so it never lined up with the buttons beside it. Without its
     appearance it is a box like they are; the chevron is drawn by the wrapper,
     in currentColor, so it follows the theme. */
  .font-wrap { position: relative; display: inline-flex; }
  .font-wrap::after {
    content: '';
    position: absolute;
    right: 10px;
    top: 50%;
    width: 5px;
    height: 5px;
    border-right: 1.5px solid var(--text-dim);
    border-bottom: 1.5px solid var(--text-dim);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  .font {
    -webkit-appearance: none;
    appearance: none;
    box-sizing: border-box;
    height: 32px;
    padding: 0 28px 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .font:hover { border-color: var(--text-faint); }

  .seg { display: flex; }
  .seg button { border-radius: 0; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; border-left: none; }
  .seg button.on { background: var(--accent-soft); color: var(--accent); }

  /* A column so the footer can sit at the bottom under a short note and
     after a long one. The renderer's 40vh tail is the app's, where it lets the
     last line be typed at mid-screen; here the footer ends the page. */
  main { flex: 1; display: flex; flex-direction: column; overflow: auto; -webkit-overflow-scrolling: touch; }
  main :global(.markdown) { padding-bottom: 48px; }
  /* Tables as the app's No-wrap preview shows them (index.html, data-wrap="off"):
     one line per cell, and the table — a block that scrolls sideways in
     markdown.css — does the rest. The viewer has no wrap setting, and the
     inherited overflow-wrap: anywhere otherwise folds each cell letter by
     letter to fit a phone. */
  main :global(.markdown :is(th, td)) {
    white-space: nowrap;
    overflow-wrap: normal;
  }

  .source {
    max-width: 64em;
    margin: 0;
    padding: 24px 20px 48px;
    /* The app's editor variables, so Source reads at the size and in the face
       the reader chose — what the same note looks like in their own editor. */
    font-size: var(--editor-font-size, 14px);
    line-height: 1.6;
    font-family: var(--editor-font, var(--mono));
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .quiet { padding: 32px 20px; color: var(--text-dim); }

  .message { max-width: 34em; margin: 12vh auto; padding: 0 20px; }
  .message h1 { font-size: 1.3em; margin: 0 0 0.5em; }
  .message p { color: var(--text-dim); line-height: 1.6; margin: 0; }

  footer {
    margin-top: auto;
    border-top: 1px solid var(--border);
    padding: 20px 20px calc(28px + env(safe-area-inset-bottom));
    background: var(--bg-sunken);
  }
  footer p {
    max-width: 60em;
    margin: 0;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.5;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 13px;
    text-decoration: none;
  }
  .bar b { color: var(--text); }
  .try {
    margin-left: auto;
    padding: 4px 12px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
  }
  .bar:hover .try { text-decoration: underline; }

  code {
    font-family: var(--mono);
    font-size: 0.95em;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 3px;
  }

  .flash {
    position: fixed;
    left: 50%;
    /* Above the bar, not on it. */
    bottom: calc(60px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--text);
    color: var(--bg);
    font-size: 13px;
    pointer-events: none;
  }

  /* One header row on a phone: the brand on the left; "Aa", "⋯" and Save on
     the right. Wrapping nine 44px controls took three or four rows, about a
     third of the screen, before the note began. */
  @media (max-width: 720px) {
    header {
      position: relative;
      flex-wrap: nowrap;
      gap: 8px;
      padding: max(6px, env(safe-area-inset-top)) 12px 6px;
    }
    .who { flex-direction: column; align-items: flex-start; gap: 1px; }
    .meta {
      max-width: 100%;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .actions { flex-wrap: nowrap; gap: 6px; flex-shrink: 0; }
    /* A thumb needs the full target even though this page never shows a
       keyboard; the app's phone chrome uses the same 44px. */
    button { min-height: 44px; }
    .actions .menu-btn { display: inline-flex; min-width: 44px; color: var(--text-dim); }
    .menu-btn[aria-expanded='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    .long { display: none; }

    .panel {
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      right: 12px;
      z-index: 10;
      width: min(280px, calc(100vw - 24px));
      box-sizing: border-box;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-raised);
      box-shadow: 0 10px 30px rgb(0 0 0 / 0.18);
    }
    .panel.open { display: flex; }
    .panel > * { flex: 1 1 100%; }
    .panel > .theme-btn { flex: 0 0 44px; }
    .panel > .textsize { flex: 1 1 0; }
    .textsize button { flex: 1; padding: 0 13px; }
    .font-wrap, .font { width: 100%; }
    .font { height: 44px; }
    .seg button { flex: 1; }

    .bar {
      min-height: 44px;
      padding: 0 12px env(safe-area-inset-bottom);
      font-size: 14px;
    }
    .ext { display: none; }
  }
</style>
