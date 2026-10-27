/**
 * A code block's copy button and what it does, kept out of `render.ts` because
 * the share viewer's first load has no budget to spare for it. `render.ts`
 * calls `addCopyButton` once this has loaded, so the button never exists before
 * its listener does and a click writes the clipboard synchronously, inside the
 * click's user activation (Safari drops it across an `await`).
 *
 * Its styles travel with it, as one `<style>` added on first use, rather than in
 * `markdown.css`: that file blocks the share page's first paint and is charged
 * to its budget in full, for a button most notes never show.
 *
 * The button has no text content, only an icon and a label, so selecting the
 * code by hand never picks it up — and the icon is built node by node, like
 * everything else the renderer makes. It copies `textContent`, not
 * `innerText`: the highlighter's spans fall away and the source comes back
 * exactly, whatever the layout. When the clipboard refuses — blocked, or absent
 * off a secure origin — the code is selected instead, so the keyboard shortcut
 * finishes the job.
 */

/** Two overlapping rounded squares, as on claude.ai. */
const COPY_ICON =
  'M5.5 7a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12zM10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2';
const CHECK_ICON = 'M3 8.5l3 3 7-7';
const COPIED_MS = 1500;
const SVG = 'http://www.w3.org/2000/svg';

// Always shown, as on claude.ai: a phone has no hover to reveal it. The right
// padding keeps a first line from running under it.
const STYLES = `
.markdown pre:has(> .copy-code) { position: relative; padding-right: 40px; }
.markdown .copy-code {
  position: absolute; top: 5px; right: 5px; padding: 6px;
  border: 0; border-radius: 4px; background: none;
  color: var(--text-dim); cursor: pointer;
}
.markdown .copy-code:is(:hover, :focus-visible) { background: var(--bg); color: var(--text); }
.markdown .copy-code.copied { color: var(--syn-string); }
.markdown .copy-code svg {
  display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
  stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round;
}`;

let styled = false;

export function addCopyButton(pre: Element): void {
  if (!styled) {
    styled = true;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.append(style);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  show(button, false);
  button.addEventListener('click', () => copy(button, pre));
  pre.append(button);
}

function show(button: HTMLButtonElement, copied: boolean): void {
  button.classList.toggle('copied', copied);
  button.title = copied ? 'Copied' : 'Copy';
  button.setAttribute('aria-label', copied ? 'Copied' : 'Copy code');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', copied ? CHECK_ICON : COPY_ICON);
  svg.append(path);
  button.replaceChildren(svg);
}

const resets = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

function copy(button: HTMLButtonElement, pre: Element): void {
  const code = pre.querySelector('code');
  if (!code) return;
  const select = (): void => {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const done = (): void => {
    // A second click while the tick shows only keeps it up longer.
    clearTimeout(resets.get(button));
    show(button, true);
    resets.set(
      button,
      setTimeout(() => show(button, false), COPIED_MS),
    );
  };
  if (!navigator.clipboard) return select();
  navigator.clipboard.writeText(code.textContent ?? '').then(done, select);
}
