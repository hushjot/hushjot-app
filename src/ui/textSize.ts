/**
 * The editor's text-size ladder.
 *
 * Pure, and kept separate from the store, so the stepping and clamping rules
 * are unit-testable without a rune harness or a localStorage stand-in — the
 * same split `journal.ts` makes between `planReplay` and the storage it sits
 * behind.
 *
 * A ladder rather than ±1px: seven rungs cover 12→24, so any size a reader
 * actually wants is one to three presses away. Stepping a pixel at a time would
 * make 14→20 a six-press errand and buy nothing, because nobody can tell 17px
 * from 18px.
 */

export type TextSize = (typeof TEXT_SIZES)[number];

export const TEXT_SIZES = [12, 13, 14, 16, 18, 20, 24] as const;

export const DEFAULT_TEXT_SIZE: TextSize = 14;

export const MIN_TEXT_SIZE: TextSize = TEXT_SIZES[0];
export const MAX_TEXT_SIZE: TextSize = TEXT_SIZES[TEXT_SIZES.length - 1]!;

/** The ladder rung closest to `value`; a tie goes to the smaller rung. */
export function nearestTextSize(value: number): TextSize {
  let best: TextSize = TEXT_SIZES[0];
  for (const size of TEXT_SIZES) {
    if (Math.abs(size - value) < Math.abs(best - value)) best = size;
  }
  return best;
}

/**
 * The next rung up (`1`) or down (`-1`), clamped at both ends.
 *
 * `current` is snapped onto the ladder first, so a size saved before a change
 * to `TEXT_SIZES` still steps somewhere sensible instead of sticking.
 */
export function stepTextSize(current: number, direction: 1 | -1): TextSize {
  const index = TEXT_SIZES.indexOf(nearestTextSize(current));
  const next = index + direction;
  if (next < 0 || next >= TEXT_SIZES.length) return TEXT_SIZES[index]!;
  return TEXT_SIZES[next]!;
}

/**
 * Read a persisted value back. Anything absent, malformed or off the ladder
 * resolves to a usable size rather than throwing — a corrupt preference must
 * never be the reason the editor fails to open.
 */
export function normalizeTextSize(raw: string | null): TextSize {
  if (raw === null || raw.trim() === '') return DEFAULT_TEXT_SIZE;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TEXT_SIZE;
  if (value < MIN_TEXT_SIZE || value > MAX_TEXT_SIZE) return DEFAULT_TEXT_SIZE;
  return nearestTextSize(value);
}
