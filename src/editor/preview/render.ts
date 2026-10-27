/**
 * Render model → DOM for the Markdown preview.
 *
 * **No markup parsing.** Every node is made with `createElement`, and every
 * piece of note text arrives through `textContent` or `setAttribute`. Tag and
 * attribute names come from `model.ts`'s fixed unions, never from the note.
 * `innerHTML` does not appear here and must not; docs/security.md, "XSS on our
 * own origin", depends on it.
 *
 * **Blocks are reused.** Split view renders while the user types, so the cost
 * of a render has to track the size of the edit, not of the note. Each top-level
 * block's element is remembered under its source-text key. On the next render,
 * the model skips building any block we still hold, and the element is moved
 * into place rather than rebuilt. A keystroke in a 2,000-line note rebuilds one
 * paragraph. The rest is one lezer parse and a pass of string comparisons.
 *
 * **Code grammars load late, and so does the highlighter.** A fence renders as
 * plain text first and is upgraded when its grammar arrives, through the same
 * lazy registry the editor uses. The machinery that does it is in
 * `highlight.ts` behind a dynamic import, because it reaches
 * `@codemirror/language` and therefore the whole editor runtime — which the
 * share viewer, the renderer's other caller, must not download to show one
 * note.
 *
 * **Mermaid diagrams arrive the same way**, from `mermaid.ts`: a
 * ```` ```mermaid ```` fence renders as its source and is redrawn as a diagram.
 * Mermaid's SVG is the one piece of markup the preview accepts that it did not
 * build node by node; `mermaid.ts` says how it is parsed inertly and stripped
 * before it is adopted.
 *
 * **Emoji arrive the same way.** A `:shortcode:` renders as typed and becomes
 * its emoji when `emojiMap.ts` has loaded, which keeps the table out of the
 * share viewer's first load.
 *
 * **Every code block gets a copy button the same way**, from `copyCode.ts`.
 * It is chrome, not note content, so the model never sees it, and it is the
 * one control that needs no hook: copying changes nothing, so the share viewer
 * and the history panel get it too.
 */
import { buildModel, type Block, type PElement, type PNode } from './model.ts';

/**
 * What the page can do with a click, and therefore what this renderer may offer.
 *
 * Every one is optional, and **absence is the inert mode** rather than a missing
 * feature: the share viewer and the history panel pass none of them, so their
 * checkboxes and note links render disabled without either of them having to
 * know those features exist. An object rather than positional parameters because
 * three trailing optional callbacks is one too many to read at a call site.
 */
export interface PreviewHooks {
  /** A `#tag` button was clicked; the key is lowercased. */
  onTag?: ((key: string) => void) | undefined;
  /**
   * A task checkbox was clicked; `at` is the source offset of its `[ ]`. Returns
   * whether the source actually changed. Omitting it leaves every checkbox
   * `disabled`.
   */
  onToggleTask?: ((at: number) => boolean) | undefined;
  /**
   * A `[[note link]]` was clicked; `target` is the title it references, and
   * resolving that to a note is the caller's job — this file cannot do it. See
   * `core/notes/links.ts`. Omitting it leaves every link `disabled`.
   */
  onNoteLink?: ((target: string) => void) | undefined;
}

export class PreviewRenderer {
  readonly #root: HTMLElement;
  #held = new Map<string, Element[]>();
  #epoch = '';
  #blocks: Block[] = [];
  #text: string | null = null;
  readonly #hooks: PreviewHooks;

  constructor(root: HTMLElement, hooks: PreviewHooks = {}) {
    this.#root = root;
    this.#hooks = hooks;
    root.addEventListener('click', this.#onClick);
  }

  destroy(): void {
    this.#root.removeEventListener('click', this.#onClick);
    this.#held.clear();
  }

  render(text: string): void {
    if (text === this.#text) return;
    this.#text = text;

    // Counts rather than a set: two identical paragraphs share a key, and each
    // needs its own element.
    const available = new Map<string, number>();
    for (const [key, els] of this.#held) available.set(key, els.length);
    const model = buildModel(text, {
      epoch: this.#epoch,
      has(key) {
        const n = available.get(key) ?? 0;
        if (n === 0) return false;
        available.set(key, n - 1);
        return true;
      },
    });
    if (model.epoch !== this.#epoch) this.#held.clear();

    const held = new Map<string, Element[]>();
    const wanted: Element[] = [];
    for (const block of model.blocks) {
      let element: Element;
      if (block.node) {
        element = build(block.node);
        // Only a freshly built block needs this: a reused one was enabled when
        // it was built, and a rebuilt one carries the model's `disabled` again.
        // Two kinds of control, one rule — the model renders both inert and this
        // is the single place that knows whether the page can act on them.
        if (this.#hooks.onToggleTask) {
          for (const box of element.querySelectorAll('input[data-task]')) box.removeAttribute('disabled');
        }
        if (this.#hooks.onNoteLink) {
          for (const link of element.querySelectorAll('button.notelink')) link.removeAttribute('disabled');
        }
      } else {
        element = this.#held.get(block.key)!.shift()!;
      }
      wanted.push(element);
      const list = held.get(block.key);
      if (list) list.push(element);
      else held.set(block.key, [element]);
    }

    const root = this.#root;
    for (let i = 0; i < wanted.length; i++) {
      const current = root.childNodes[i];
      if (current !== wanted[i]) root.insertBefore(wanted[i]!, current ?? null);
    }
    while (root.childNodes.length > wanted.length) root.lastChild!.remove();

    this.#held = held;
    this.#epoch = model.epoch;
    this.#blocks = model.blocks;
  }

  /**
   * Put the block holding source offset `pos` at the top of `scroller`.
   * Interpolates inside the block, so a long code fence scrolls smoothly
   * instead of jumping block to block.
   */
  scrollToSource(scroller: HTMLElement, pos: number): void {
    const blocks = this.#blocks;
    if (blocks.length === 0) return;
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid]!.from <= pos) lo = mid;
      else hi = mid - 1;
    }
    const block = blocks[lo]!;
    const element = this.#root.children[lo] as HTMLElement | undefined;
    if (!element) return;
    const span = Math.max(1, block.to - block.from);
    const fraction = Math.min(1, Math.max(0, (pos - block.from) / span));
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = pos <= 0 ? 0 : top + fraction * element.offsetHeight;
  }

  /**
   * Clicks on rendered content: task checkboxes, `#tag` buttons, `[[note
   * links]]`, and in-note `#fragment` links, which scroll to their heading —
   * anchors are `data-anchor`, never ids.
   *
   * A `disabled` button fires no click, so the inert cases need no check here.
   */
  #onClick = (event: MouseEvent): void => {
    const box = (event.target as Element | null)?.closest?.('input[data-task]');
    if (box) {
      // Always: the tick has to come from the source, so the box never shows a
      // state the note does not hold. Space on a focused checkbox arrives here
      // as a click too, so the keyboard takes the same path.
      event.preventDefault();
      this.#toggleTask(box as HTMLInputElement);
      return;
    }
    const tag = (event.target as Element | null)?.closest?.('button.tag');
    if (tag) {
      const key = tag.getAttribute('data-tag');
      if (key && this.#hooks.onTag) this.#hooks.onTag(key);
      return;
    }
    const note = (event.target as Element | null)?.closest?.('button.notelink');
    if (note) {
      const target = note.getAttribute('data-note');
      if (target && this.#hooks.onNoteLink) this.#hooks.onNoteLink(target);
      return;
    }
    const link = (event.target as Element | null)?.closest?.('a');
    const href = link?.getAttribute('href');
    if (!href?.startsWith('#')) return;
    event.preventDefault();
    let name = href.slice(1);
    try {
      name = decodeURIComponent(name);
    } catch {
      // A malformed escape is just a name that matches nothing.
    }
    for (const heading of this.#root.querySelectorAll('[data-anchor]')) {
      if (heading.getAttribute('data-anchor') === name.toLowerCase()) {
        heading.scrollIntoView({ block: 'start' });
        return;
      }
    }
  };

  /**
   * `data-task` is relative to its block, and `#blocks[i]` describes
   * `#root.children[i]` — both are rebuilt by every render, so the sum is the
   * offset in the text this preview is currently showing.
   */
  #toggleTask(box: HTMLInputElement): void {
    if (!this.#hooks.onToggleTask) return;
    const rel = Number(box.getAttribute('data-task'));
    if (!Number.isInteger(rel)) return;

    let node: Element | null = box;
    while (node && node.parentElement !== this.#root) node = node.parentElement;
    if (!node) return;
    const index = Array.prototype.indexOf.call(this.#root.children, node);
    const block = this.#blocks[index];
    if (!block) return;

    // The preview trails the editor by up to a second in split view, so the
    // offset can have moved; the writer checks it and says so. Ticking only on
    // a real change keeps the box honest without waiting for the re-render.
    if (this.#hooks.onToggleTask(block.from + rel)) box.checked = !box.checked;
  }
}

function build(node: PElement): Element {
  const element = document.createElement(node.tag);
  if (node.attrs) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value !== undefined) element.setAttribute(name, value);
    }
  }

  if (node.tag === 'a' && node.attrs?.href && !node.attrs.href.startsWith('#')) {
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  }

  if (node.tag === 'pre' && node.attrs?.['data-lang']) {
    const code = node.children[0] as PElement;
    const text = (code.children[0] as { text: string } | undefined)?.text ?? '';
    const codeEl = document.createElement('code');
    codeEl.textContent = text;
    element.append(codeEl);
    addCopyButton(element);
    const lang = node.attrs['data-lang'];
    if (lang.toLowerCase() === 'mermaid') diagramInto(element as HTMLElement, text);
    else highlightInto(codeEl, lang, text);
    return element;
  }

  appendChildren(element, node.children);
  // A raw-HTML block is shown as its source, but it is not a snippet anyone
  // wrote to be copied out.
  if (node.tag === 'pre' && node.attrs?.class !== 'raw') addCopyButton(element);
  if (node.tag === 'span' && node.attrs?.['data-emoji']) emojiInto(element, node.attrs['data-emoji']);
  return element;
}

function appendChildren(parent: Element, children: PNode[]): void {
  for (const child of children) {
    parent.append('text' in child ? document.createTextNode(child.text) : build(child));
  }
}

// --- Copy button ---------------------------------------------------------

/**
 * Give a code block its copy button, later — the same upgrade the highlighter
 * does. The button and what it does live in `copyCode.ts` because the share
 * viewer's first load has no room for them; the module is local and arrives in
 * a frame, and the button is attached with its own listener once it does, so a
 * click is synchronous and keeps its user activation (Safari drops it across
 * an `await`).
 */
let copier: Promise<typeof import('./copyCode.ts')> | null = null;

function addCopyButton(pre: Element): void {
  copier ??= import('./copyCode.ts');
  void copier.then((module) => module.addCopyButton(pre)).catch(() => {});
}

// --- Code highlighting ---------------------------------------------------

/**
 * Colour a fence, later.
 *
 * The implementation lives behind a dynamic import because it pulls in
 * `@codemirror/language` and therefore the editor runtime — which the share
 * viewer, the other user of this renderer, has no other reason to download.
 * See `highlight.ts`. Nothing is awaited here: a fence is already in the DOM as
 * plain text by the time this is called, and painting it is an upgrade.
 */
let highlighter: Promise<typeof import('./highlight.ts')> | null = null;

function highlightInto(code: HTMLElement, lang: string, text: string): void {
  highlighter ??= import('./highlight.ts');
  void highlighter
    .then((module) => module.highlightInto(code, lang, text))
    // A grammar — or the highlighter itself — that will not load leaves the
    // block as plain text, which is what it already is.
    .catch(() => {});
}

// --- Diagrams ------------------------------------------------------------

/**
 * Draw a ```` ```mermaid ```` fence as a diagram, later. The fence is already in
 * the DOM as its source, which is what stays if mermaid will not load or will
 * not parse it. Mermaid is by far the largest thing the preview can load, so it
 * is reached only from a note that has a diagram — see `mermaid.ts`, which is
 * also where the one exception to this file's no-markup rule is fenced in.
 */
let diagrams: Promise<typeof import('./mermaid.ts')> | null = null;

function diagramInto(pre: HTMLElement, text: string): void {
  diagrams ??= import('./mermaid.ts');
  void diagrams.then((module) => module.diagramInto(pre, text)).catch(() => {});
}

// --- Emoji ---------------------------------------------------------------

let emojiTable: Promise<typeof import('../emojiMap.ts')> | null = null;

/**
 * Replace a `:shortcode:` span's text with its emoji, later. The span already
 * shows the shortcode, so an unknown name — or a table that will not load —
 * leaves exactly what was typed. `textContent`, like every other piece of note
 * text this file writes.
 */
function emojiInto(span: Element, name: string): void {
  emojiTable ??= import('../emojiMap.ts');
  void emojiTable
    .then(({ EMOJI }) => {
      const emoji = EMOJI.get(name);
      if (emoji) span.textContent = emoji;
    })
    .catch(() => {});
}
