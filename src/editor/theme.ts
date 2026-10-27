/**
 * Editor theme and Markdown highlight style.
 *
 * Colours and the base text size come from the app's CSS custom properties
 * rather than being hardcoded here, so light/dark follows the page with no
 * JavaScript and no flash, and the ⌘+/⌘− control resizes every editor — mounted
 * or cached — by setting one variable.
 *
 * The visual goal (§30) is a code editor, not a word processor: the Markdown
 * source stays visible and readable. Headings get weight and colour but not
 * wildly different sizes, because a heading that doubles in size makes the
 * plain-text structure harder to scan, not easier.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { highlightTag } from './extendedSyntax.ts';
import type { Extension } from '@codemirror/state';

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    // Set by `state/textSize.svelte.ts`; the fallback matches index.html.
    fontSize: 'var(--editor-font-size, 14px)',
    color: 'var(--text)',
    backgroundColor: 'var(--bg)',
  },
  '.cm-scroller': {
    // Set by `state/editorFont.svelte.ts`; the fallback matches index.html.
    fontFamily: 'var(--editor-font, var(--mono))',
    lineHeight: '1.65',
    // Comfortable reading measure on wide screens without a hard column rule.
    padding: '8px 0 40vh 0',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '0',
    // A measure in em, not px: the comfortable line length is a number of
    // characters, so it must hold when the reader changes the text size rather
    // than quietly shortening every line. 64em is the 900px this used to be.
    maxWidth: '64em',
  },
  '.cm-line': { padding: '0 20px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-faint)',
    border: 'none',
    paddingRight: '4px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    color: 'var(--text-dim)',
    borderRadius: '3px',
    padding: '0 6px',
  },
  '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
  // The table size picker (tablePicker.ts).
  '.cm-tooltip.cm-table-picker': {
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '8px 10px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
    fontFamily: 'var(--sans)',
    fontSize: '12px',
  },
  '.cm-table-picker-label': { fontWeight: '600', whiteSpace: 'pre' },
  '.cm-table-picker-grid': { display: 'grid', justifyContent: 'start', gap: '2px', margin: '6px 0' },
  '.cm-table-picker-cell': {
    width: '14px',
    height: '14px',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    backgroundColor: 'var(--bg)',
    cursor: 'pointer',
  },
  '.cm-table-picker-head': { backgroundColor: 'var(--bg-sunken)' },
  '.cm-table-picker-cell.cm-table-picker-on': {
    backgroundColor: 'var(--accent-soft)',
    borderColor: 'var(--accent)',
  },
  '.cm-table-picker-hint': { color: 'var(--text-dim)' },
  // The link chip (linkChip.ts): the small dark pill Obsidian puts over a
  // tapped link. Inverted colours so it reads as chrome, not note text.
  '.cm-tooltip.cm-link-chip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
  '.cm-link-chip-button': {
    display: 'block',
    maxWidth: 'min(18em, 80vw)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minHeight: '32px',
    padding: '4px 12px',
    border: 'none',
    borderRadius: '8px',
    backgroundColor: 'var(--text)',
    color: 'var(--bg)',
    fontFamily: 'var(--sans)',
    fontSize: '13px',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
  },
  '.cm-link-chip-button:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '2px' },
  // A finger, not a pointer: the 44px target `bench:phase6` holds every phone control to.
  '@media (pointer: coarse)': {
    '.cm-link-chip-button': { minHeight: '44px', fontSize: '15px', padding: '8px 16px' },
  },
  // Inline #tags (hashtags.ts): marked, not shouted — they sit in prose.
  '.cm-hashtag': {
    color: 'var(--accent)',
    backgroundColor: 'var(--accent-soft)',
    borderRadius: '3px',
    // No padding: it would widen the text and walk the caret off its glyphs.
  },
  // Mobile: the virtual keyboard must not force a horizontal scroll (§19).
  '.cm-content, .cm-gutters': { minHeight: '100%' },
});

export const markdownHighlight = HighlightStyle.define([
  // --- Markdown structure --------------------------------------------------
  { tag: t.heading1, color: 'var(--text)', fontWeight: '700', fontSize: '1.25em' },
  { tag: t.heading2, color: 'var(--text)', fontWeight: '700', fontSize: '1.12em' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: 'var(--text)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-dim)' },
  // `==highlight==`: the preview's <mark>, in the editor's own accent wash.
  { tag: highlightTag, color: 'var(--accent)', backgroundColor: 'var(--accent-soft)', borderRadius: '2px' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--accent)' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  // Syntax marks (#, *, >, ```) stay visible but recede.
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.labelName, color: 'var(--text-dim)' },

  // --- Embedded code grammars ---------------------------------------------
  { tag: [t.keyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--text-dim)' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export function themeExtensions(): Extension[] {
  return [editorTheme, syntaxHighlighting(markdownHighlight, { fallback: true })];
}
