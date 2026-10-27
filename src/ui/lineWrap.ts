/**
 * The editor's line-wrap modes.
 *
 * Pure, and kept apart from the store for the same reason `textSize.ts` is:
 * the parsing and toggling rules are unit-testable without a rune harness or a
 * localStorage stand-in.
 *
 * Wrapping at the window edge is right for prose and wrong for anything laid
 * out in columns — a Markdown table on a phone folds every row into a ragged
 * paragraph. So besides the window there is a fixed measure, in characters,
 * that holds whatever the screen size (the editor scrolls sideways instead),
 * and no wrapping at all.
 */

export const WRAP_COLUMNS = [40, 60, 80, 100, 120, 160] as const;

export type WrapColumns = (typeof WRAP_COLUMNS)[number];

/** `'window'` wraps at the edge of the editor; a number wraps at that column. */
export type LineWrap = 'window' | 'off' | WrapColumns;

/** Anything but the window: what the one-press toggle switches to. */
export type FixedLineWrap = Exclude<LineWrap, 'window'>;

export const DEFAULT_LINE_WRAP: LineWrap = 'window';

/** Where the toggle lands before the reader has picked a measure. */
export const DEFAULT_FIXED_LINE_WRAP: FixedLineWrap = 80;

/** Every mode in menu order, for the pickers. */
export const LINE_WRAP_CHOICES: readonly LineWrap[] = ['window', ...WRAP_COLUMNS, 'off'];

function parse(raw: string | null): LineWrap | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === 'window' || value === 'off') return value;
  const columns = Number(value);
  return (WRAP_COLUMNS as readonly number[]).includes(columns) ? (columns as WrapColumns) : null;
}

/**
 * Read a persisted mode back. Absent, malformed or retired values resolve to
 * the default rather than throwing — a corrupt preference must never be the
 * reason the editor fails to open.
 */
export function normalizeLineWrap(raw: string | null): LineWrap {
  return parse(raw) ?? DEFAULT_LINE_WRAP;
}

/** As `normalizeLineWrap`, for the remembered toggle target. */
export function normalizeFixedLineWrap(raw: string | null): FixedLineWrap {
  const mode = parse(raw);
  return mode === null || mode === 'window' ? DEFAULT_FIXED_LINE_WRAP : mode;
}

/**
 * The one-press toggle: from the window to the last fixed mode the reader
 * chose, and from any fixed mode back to the window. Remembering the target is
 * what makes it one press — a table note wants the same measure every time.
 */
export function toggleLineWrap(current: LineWrap, lastFixed: FixedLineWrap): LineWrap {
  return current === 'window' ? lastFixed : 'window';
}

/** The menu row label. */
export function lineWrapLabel(mode: LineWrap): string {
  if (mode === 'window') return 'Fit window';
  if (mode === 'off') return 'No wrap';
  return `${mode} characters`;
}

/** The terse form for the toolbar pill. */
export function lineWrapShortLabel(mode: LineWrap): string {
  if (mode === 'window') return 'Fit';
  if (mode === 'off') return 'Off';
  return String(mode);
}
