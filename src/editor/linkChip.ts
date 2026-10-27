/**
 * The link chip: tap into a link, and a one-button popover offers to follow it.
 *
 * Obsidian's mobile editor does exactly this ("Follow link" above the link the
 * caret landed in), and for the same reason: a phone has no ⌘-click and no
 * hover, so without it the only way to follow a `[[link]]` here was More →
 * "Open the note link at the cursor" — three taps nobody finds. It covers what
 * the editor could not open at all before, too: a Markdown link or a bare URL
 * was followable only from Preview.
 *
 * Three answers, one per kind of thing under the caret:
 *
 * - `[[Title]]` that resolves → **Open note**, through `onOpenLink`, the same
 *   route ⌘-click takes, so the two cannot disagree about which note is meant.
 * - `[[Title]]` that resolves to nothing → **Create "Title"**. `followLink`
 *   would answer with a flash offering Create; the chip already knows, so it
 *   offers that directly and the repair stays one tap.
 * - `[text](url)`, `<url>` or a bare URL → **Open link**, through `safeHref`,
 *   the allowlist the preview uses — a `javascript:` link gets no chip at all.
 *   It is the preview's own function (`preview/href.ts`), not a copy: a
 *   second allowlist would drift.
 *
 * ## Only after a pointer, never while typing
 *
 * The chip appears when a click or tap *places* the caret, and goes on the next
 * edit or caret move. Showing it whenever the caret is in a link would pop it
 * up mid-word while someone types a link, and would put a syntax-tree walk on
 * every arrow key. So the work happens on `click`, after the browser has placed
 * the caret: one `requestAnimationFrame`, one `resolveInner`. On a touch screen
 * the caret may arrive later still — CodeMirror reads the native selection from
 * `selectionchange` — so a selection update within `ARM_MS` of the click looks
 * again. The cost on a keystroke is the field's null check and the plugin's
 * one comparison; `bench:app` holds that.
 *
 * ⌘-click keeps opening a note directly (`noteLinkClick`); the chip is skipped
 * for a modified click so the two never both fire.
 *
 * Like the table picker, focus never leaves the editor: the button cancels
 * `mousedown`, so the phone keyboard does not drop and come back. The DOM is
 * built with `createElement` and `textContent` only — a note title is note
 * text — the rule the preview follows.
 */
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  tooltips,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { linkAt } from './wikiLink.ts';
import { safeHref } from './preview/href.ts';

/** A URL allowlist; `safeHref` in the app, swappable in tests. */
type Vet = (url: string) => string | null;

export type ChipSpec =
  | { kind: 'note'; target: string; exists: boolean; from: number }
  | { kind: 'url'; href: string; from: number };

/** Code is never a link, whatever it looks like: `[[i]]` in C is an index. */
const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'HTMLTag', 'Comment']);

/** Nodes that carry their address in a `URL` child. */
const URL_PARENTS = new Set(['Link', 'Image', 'Autolink']);

/**
 * What the chip would offer for a caret at `pos`, or null.
 *
 * Pure, so it can be tested without a DOM. `vet` is the URL allowlist; with
 * none, a URL offers nothing. `exists` answers whether a note link resolves;
 * omit it and every note link reads as resolving.
 */
export function chipAt(
  state: EditorState,
  pos: number,
  vet: Vet | null,
  exists: (target: string) => boolean = () => true,
): ChipSpec | null {
  for (let node = syntaxTree(state).resolveInner(pos, 0); ; node = node.parent!) {
    if (CODE.has(node.name)) return null;
    const note = node.name === 'NoteLink' ? linkAt(state, pos) : null;
    if (note) return { kind: 'note', target: note.target, exists: exists(note.target), from: node.from };
    const url = node.name === 'URL' ? node : URL_PARENTS.has(node.name) ? node.getChild('URL') : null;
    if (url) {
      // `[x](<a b>)` is a legal destination; the brackets are not part of it.
      const raw = state.sliceDoc(url.from, url.to).replace(/^<(.*)>$/s, '$1');
      const href = vet?.(raw);
      // A `#heading` fragment means something in Preview and nothing here.
      if (!href || href.startsWith('#')) return null;
      return { kind: 'url', href, from: node.from };
    }
    if (URL_PARENTS.has(node.name) || !node.parent) return null;
  }
}

interface Chip {
  /** Kept identical while the chip is open, so the tooltip is not rebuilt. */
  tooltip: Tooltip;
  spec: ChipSpec;
  /** The caret that opened it; any other caret closes it. */
  head: number;
}

const showChip = StateEffect.define<{ spec: ChipSpec; head: number }>();
const closeChip = StateEffect.define<null>();

export interface LinkChipOptions {
  onOpenLink: (target: string) => void;
  /** An unresolved link's Create. Omit it and the chip falls back to `onOpenLink`. */
  onCreateNote?: ((title: string) => void) | undefined;
  /** Whether a link target names a note. Read when the chip opens. */
  exists?: ((target: string) => boolean) | undefined;
}

/** What the chip is showing, for tests. */
export function chipShown(state: EditorState): ChipSpec | null {
  return state.field(chipField, false)?.spec ?? null;
}

/**
 * The transaction that opens the chip for the caret, or null when the caret is
 * not in something it can follow (or the chip is already open there). Takes a
 * state, not a view, so it can be tested without a DOM.
 */
export function chipOffer(
  state: EditorState,
  vet: Vet | null,
  exists?: (target: string) => boolean,
): TransactionSpec | null {
  const sel = state.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return null;
  const head = sel.main.head;
  if (state.field(chipField, false)?.head === head) return null;
  const spec = chipAt(state, head, vet, exists);
  return spec ? { effects: showChip.of({ spec, head }) } : null;
}

/**
 * The callbacks, as a facet rather than closed over, so the tooltip factory —
 * which belongs to the one module-level field — reads its own editor's.
 */
const chipOptions = Facet.define<LinkChipOptions, LinkChipOptions | null>({
  combine: (values) => values[0] ?? null,
});

const chipField = StateField.define<Chip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(showChip)) {
        const { spec, head } = effect.value;
        return {
          spec,
          head,
          tooltip: { pos: spec.from, above: true, strictSide: false, create: chipView },
        };
      }
      if (effect.is(closeChip)) return null;
    }
    if (!value) return null;
    if (tr.docChanged) return null;
    if (tr.selection) {
      const main = tr.state.selection.main;
      if (!main.empty || main.head !== value.head || tr.state.selection.ranges.length > 1) return null;
    }
    return value;
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
});

/** How long after a click a late-arriving caret (touch) still counts as placed by it. */
const ARM_MS = 400;

function labelFor(spec: ChipSpec): string {
  if (spec.kind === 'url') return 'Open link ↗';
  return spec.exists ? 'Open note' : `Create “${spec.target}”`;
}

function follow(options: LinkChipOptions, spec: ChipSpec): void {
  if (spec.kind === 'url') {
    // An anchor rather than `window.open`, so `rel` is honoured as written
    // and a `mailto:` goes to the mail handler like any other mail link.
    const a = document.createElement('a');
    a.href = spec.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  } else if (!spec.exists && options.onCreateNote) {
    options.onCreateNote(spec.target);
  } else {
    options.onOpenLink(spec.target);
  }
}

function chipView(view: EditorView): TooltipView {
  const chip = view.state.field(chipField, false);
  const dom = document.createElement('div');
  dom.className = 'cm-link-chip';
  if (!chip) return { dom };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-link-chip-button';
  button.textContent = labelFor(chip.spec);
  if (chip.spec.kind === 'url') button.title = chip.spec.href;
  // Keep focus, and with it the phone keyboard, in the editor.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const spec = chip.spec;
    view.dispatch({ effects: closeChip.of(null) });
    const options = view.state.facet(chipOptions);
    if (options) follow(options, spec);
  });
  dom.append(button);
  return { dom };
}

export function linkChip(options: LinkChipOptions): Extension {
  const { exists } = options;

  const trigger = ViewPlugin.fromClass(
    class {
      armedAt = 0;
      frame = 0;
      constructor(readonly view: EditorView) {}
      schedule(): void {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
          // A tile switch or a closed note can land between the click and here.
          if (!this.view.hasFocus) return;
          const offer = chipOffer(this.view.state, safeHref, exists);
          if (offer) this.view.dispatch(offer);
        });
      }
      update(update: ViewUpdate): void {
        if (this.armedAt !== 0 && update.selectionSet) {
          if (performance.now() - this.armedAt > ARM_MS) this.armedAt = 0;
          else if (!update.docChanged) this.schedule();
        }
      }
      destroy(): void {
        cancelAnimationFrame(this.frame);
      }
    },
    {
      // Observers, not handlers: they run even when something earlier — the
      // keymap, for an arrow key — has claimed the event, and none of these
      // means to claim it.
      eventObservers: {
        click(event) {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          // The chip lives inside the editor's DOM; tapping it is not a caret.
          if (event.target instanceof Element && event.target.closest('.cm-tooltip')) return;
          this.armedAt = performance.now();
          this.schedule();
        },
        // A key moves the caret on purpose; only a late *touch* caret may reopen.
        keydown() {
          this.armedAt = 0;
        },
        blur() {
          if (this.view.state.field(chipField, false)) {
            // Not inside the blur dispatch: CodeMirror may be mid-update.
            queueMicrotask(() => this.view.dispatch({ effects: closeChip.of(null) }));
          }
        },
      },
    },
  );

  const escape = Prec.high(
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(chipField, false)) return false;
          view.dispatch({ effects: closeChip.of(null) });
          return true;
        },
      },
    ]),
  );

  // Above the link (Obsidian's side), but only within the editor's own scroll
  // area: measured against the window, a link on the first line put the chip
  // over the phone header instead of flipping it below. This is the editor's
  // one tooltip setting, so the completion popups and the table picker gain
  // the same rule.
  const space = tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() });

  return [chipOptions.of(options), chipField, trigger, escape, space];
}
