/**
 * The editor extension set.
 *
 * Kept separate from the Svelte component so the configuration is testable and
 * so the component stays a thin mount/unmount wrapper. Nothing here performs
 * I/O — `onChange` fires synchronously and the caller decides what to do.
 */
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
  highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import {
  autocompletion,
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  moveCompletionSelection,
} from '@codemirror/autocomplete';
import { markdownLean } from './markdownLean.ts';
import { codeLanguages, findInCatalogue } from './languages.ts';
import { fenceLanguageCompletion } from './languageCompletion.ts';
import { hashtagCompletion, hashtagHighlight } from './hashtags.ts';
import { noteLinkClick, wikiLinkCompletion } from './wikiLink.ts';
import { linkChip } from './linkChip.ts';
import { notesMatching } from '../core/notes/model.ts';
import type { Tag } from '../core/notes/tags.ts';
import type { NoteMeta } from '../core/notes/model.ts';
import { themeExtensions } from './theme.ts';
import { continueMarkupOnEnter } from './markdownKeys.ts';
import {
  fencePasteHandlers,
  fenceSlot,
  insertCodeFence,
  leaveLanguageSlot,
} from './fenceKeys.ts';
import {
  insertLink,
  linkPasteHandler,
  setHeading,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleQuote,
  toggleStrikethrough,
  toggleTask,
  wrapSelectionInput,
} from './formatKeys.ts';
import { openTablePicker, tableEnter, tableNextCell, tablePrevCell } from './tableKeys.ts';

/** Line numbers are useful on a desktop and waste scarce width on a phone. */
export const gutterCompartment = new Compartment();

export function gutterExtension(enabled: boolean): Extension {
  return enabled
    ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()]
    : [];
}

export interface EditorSetupOptions {
  onChange: (content: string) => void;
  showGutter?: boolean;
  /** Tags already in use, offered after `#`. Read when the list opens. */
  tagSource?: (() => readonly Tag[]) | undefined;
  /**
   * Note titles, offered after `[[`. A getter for the same reason `tagSource` is
   * one, and it hands over the whole meta list rather than titles alone because
   * the completion ranks by the order it is given — `Workspace.metas` is in
   * recency order, and that is the tie-break.
   */
  titleSource?: (() => readonly NoteMeta[]) | undefined;
  /**
   * ⌘/Ctrl-click on a `[[note link]]`. Resolving a title to a note needs the
   * workspace, which `src/editor/` may not reach, so the editor reports only the
   * title that was clicked. Omit it and a ⌘-click is an ordinary one.
   */
  onOpenLink?: ((target: string) => void) | undefined;
  /**
   * The link chip's Create, offered when a tapped `[[link]]` names no note.
   * Omit it and the chip routes an unresolved link through `onOpenLink`.
   */
  onCreateNote?: ((title: string) => void) | undefined;
  /**
   * Whether the browser may spellcheck the note. A getter, not a boolean,
   * because `src/editor/` sits below the stores and must not import one —
   * `tagSource` is a getter for the same reason. Omit it and CodeMirror's own
   * `spellcheck="false"` stands.
   */
  spellcheck?: (() => boolean) | undefined;
}

export function editorExtensions(options: EditorSetupOptions): Extension[] {
  const { onChange, showGutter = true, tagSource, titleSource, spellcheck, onOpenLink, onCreateNote } = options;

  return [
    gutterCompartment.of(gutterExtension(showGutter)),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    EditorState.allowMultipleSelections.of(true),
    // Prose needs wrapping; a notepad that scrolls horizontally is unusable.
    EditorView.lineWrapping,
    placeholder('Start typing…'),

    // CodeMirror hard-codes `spellcheck="false"` on `.cm-content`; attribute
    // sources are merged over that default, so one of these re-enables it.
    //
    // A function source, not `{ spellcheck: 'true' }`, and not a Compartment.
    // `Editor.svelte` keeps one EditorState per note, so a reconfigure would
    // reach the mounted one and leave the other twenty-three showing the old
    // answer until they were rebuilt — the trap `textSize.svelte.ts` explains.
    // CodeMirror re-evaluates a function source on every view update and again
    // on `setState`, so this one extension is live in every cached state at
    // once, for one call per update and no dispatch.
    ...(spellcheck
      ? [EditorView.contentAttributes.of(() => ({ spellcheck: spellcheck() ? 'true' : 'false' }))]
      : []),

    markdownLean({ codeLanguages, resolveUnknown: findInCatalogue }),
    // After the language, which is where its bracket set is declared
    // (`markdownLean.ts`) and where a fence's own language overrides it.
    //
    // On for everyone, with no switch, which is what makes it cheap: a
    // preference would need a Compartment, and a Compartment reaches only the
    // mounted state out of the twenty-four `Editor.svelte` caches. The cost is
    // one StateField on the typing path — a `RangeSet` of the positions this
    // extension closed itself, mapped through each transaction and narrowed to
    // the cursor's line, so O(log n) per keystroke and no document scan.
    // `bench:app` is the gate on that claim.
    closeBrackets(),
    ...themeExtensions(),

    // Scoped to fence info slots: the source returns null for prose after one
    // regex, so this costs nothing on the typing path (§7).
    fenceSlot,
    hashtagHighlight,
    // `override` REPLACES the language-data sources rather than adding to them,
    // so every source the editor has must be in this one list; an `autocomplete`
    // key on `markdownLean`'s facet would be dead configuration.
    autocompletion({
      defaultKeymap: false,
      override: [
        fenceLanguageCompletion,
        ...(tagSource ? [hashtagCompletion(tagSource)] : []),
        ...(titleSource ? [wikiLinkCompletion(titleSource)] : []),
      ],
    }),
    // Narrow by design: it takes a ⌘-click only when one lands inside a note
    // link, because ⌘-click is already `clickAddsSelectionRange`. `wikiLink.ts`
    // has the reasoning and why Alt was no escape.
    ...(onOpenLink ? [noteLinkClick(onOpenLink)] : []),
    // The touch route to the same place, and the only way to open a URL from
    // the editor: a click or tap that lands the caret in a link offers to
    // follow it. Pointer-only, so it costs a keystroke nothing (`linkChip.ts`).
    ...(onOpenLink
      ? [
          linkChip({
            onOpenLink,
            onCreateNote,
            exists: titleSource
              ? (target) => notesMatching(titleSource(), target).length > 0
              : undefined,
          }),
        ]
      : []),
    fencePasteHandlers,
    // After the fence handler, which claims Mod-Shift-v pastes first.
    linkPasteHandler,
    wrapSelectionInput,

    // Backspace between a pair deletes both. Ahead of the block below, not
    // inside it: bindings for one key accumulate in extension order and the
    // first to return true wins, and `...defaultKeymap` down there already
    // binds Backspace to `deleteCharBackward`. Behind it this would be dead
    // code. `deleteBracketPair` returns false anywhere else, so the default
    // still runs for every ordinary Backspace.
    keymap.of(closeBracketsKeymap),

    keymap.of([
      { key: 'Mod-e', run: insertCodeFence },

      // Formatting (formatKeys.ts has the reasons for each chord). They
      // preventDefault so Firefox's Ctrl-B sidebar and Chrome's Ctrl-K search
      // never fire from inside a note.
      { key: 'Mod-b', run: toggleBold, preventDefault: true },
      { key: 'Mod-i', run: toggleItalic, preventDefault: true },
      { key: 'Mod-Shift-x', run: toggleStrikethrough, preventDefault: true },
      { key: 'Mod-k', run: insertLink, preventDefault: true },
      ...[1, 2, 3, 4, 5, 6].map((level) => ({
        key: `Mod-Alt-${level}`,
        run: setHeading(level),
        preventDefault: true,
      })),
      { key: 'Mod-Shift-7', run: toggleList('ordered'), preventDefault: true },
      { key: 'Mod-Shift-8', run: toggleList('bullet'), preventDefault: true },
      { key: 'Mod-Shift-9', run: toggleList('task'), preventDefault: true },
      { key: 'Mod-Shift-.', run: toggleQuote, preventDefault: true },
      { key: 'Mod-Alt-t', run: openTablePicker, preventDefault: true },
      // Falls through to defaultKeymap's insertBlankLine off a task line.
      { key: 'Mod-Enter', run: toggleTask },

      // Every Enter handler returns false when it does not apply, so ordering
      // here is a priority list, not an override. leaveLanguageSlot only fires
      // inside a fence slot it created itself.
      { key: 'Enter', run: leaveLanguageSlot },
      // Inside a table Enter moves down a row; Shift-Enter is still a newline.
      { key: 'Enter', run: tableEnter },
      // Ahead of defaultKeymap so Enter continues lists and quotes; it falls
      // through when the cursor is not in one.
      { key: 'Enter', run: continueMarkupOnEnter },

      // Completion keys, hand-picked rather than completionKeymap: Enter is
      // deliberately absent so it always means "leave the slot". Tab must come
      // before indentWithTab below, which would otherwise swallow it.
      { key: 'Tab', run: acceptCompletion },
      // Table cells, ahead of indentWithTab for the same reason.
      { key: 'Tab', run: tableNextCell, shift: tablePrevCell },
      { key: 'ArrowDown', run: moveCompletionSelection(true) },
      { key: 'ArrowUp', run: moveCompletionSelection(false) },
      { key: 'Escape', run: closeCompletion },

      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),

    // The typing path (§7): hand the new text to the caller and return. No
    // awaits, no I/O, no indexing here.
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}

/**
 * Make CodeMirror re-measure the *font*, not only the layout.
 *
 * `requestMeasure()` is enough for a text-size change, because that moves the
 * content's height and CodeMirror's own `contentDOMHeight` check trips. A
 * family change does not: `.cm-scroller` sets a unitless `line-height`, so the
 * line box is identical in mono, sans and serif and nothing in the ordinary
 * measure path calls `docView.measureTextSize()`. `charWidth` and `lineLength`
 * would stay measured for the old family, and with `lineWrapping` on those
 * feed the off-screen wrap estimate in the height map — scroll-height drift
 * and a twitching scrollbar, not corruption, but wrong and visible.
 *
 * `mustMeasureContent = "refresh"` is the flag CodeMirror sets on itself for
 * exactly this case, after `document.fonts.ready`. It is not on `EditorView`'s
 * public type, hence the cast; this is the one place in the app that reaches
 * past the published API, and it is here rather than in `Editor.svelte` so
 * that stays one place to fix if upstream ever exposes it.
 */
export function refreshTextMetrics(view: EditorView): void {
  (view as unknown as { viewState: { mustMeasureContent: boolean | string } }).viewState
    .mustMeasureContent = 'refresh';
  view.requestMeasure();
}

export function createEditorState(doc: string, options: EditorSetupOptions): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions(options) });
}
