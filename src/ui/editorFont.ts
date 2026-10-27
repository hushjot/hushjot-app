/**
 * The editor's font family.
 *
 * Pure, and kept separate from the store, so the choices and their fallbacks
 * are unit-testable without a rune harness or a localStorage stand-in — the
 * same split `textSize.ts` makes.
 *
 * ## Three system stacks, and no webfont
 *
 * Nothing here is downloaded. §28 asks every dependency to justify its bytes
 * and its startup cost, and a webfont is the worst version of that trade on
 * this particular page: it is render-blocking or it is a reflow, it needs a
 * `font-src` in two CSP policies, and it would be the first thing the app
 * fetches that is not the app. Every platform already ships a good monospace,
 * a good UI sans and a good reading serif, and the reason to want a choice
 * here — prose in a serif, source in a mono — is satisfied entirely by them.
 *
 * ## Why two tokens and not one
 *
 * The editor shows Markdown *source* and the preview shows *prose*, and the
 * default has always been mono for the first and sans for the second. One
 * token would have to break that on the day it shipped. So a choice resolves
 * to a pair, and `mono` — the default — is exactly today's behaviour written
 * down. Code inside the preview is not covered by either: fences and inline
 * code stay `--mono` in `markdown.css` whatever the prose font is, which is
 * the whole reason the prose font can move.
 */

export const FONT_CHOICES = ['mono', 'sans', 'serif'] as const;

export type FontChoice = (typeof FONT_CHOICES)[number];

export const DEFAULT_FONT: FontChoice = 'mono';

/** What the Appearance menu calls each one. */
export const FONT_LABELS: Record<FontChoice, string> = {
  mono: 'Monospace',
  sans: 'Sans serif',
  serif: 'Serif',
};

/** The custom properties a choice sets, naming tokens declared in both shells. */
export interface FontTokens {
  /** `--editor-font`: the CodeMirror scroller. */
  editor: string;
  /** `--preview-font`: the rendered Markdown's prose, never its code. */
  preview: string;
}

const TOKENS: Record<FontChoice, FontTokens> = {
  // The default, and deliberately asymmetric: this is what the app did before
  // there was a choice, so choosing it must change nothing.
  mono: { editor: 'var(--mono)', preview: 'var(--sans)' },
  sans: { editor: 'var(--sans)', preview: 'var(--sans)' },
  serif: { editor: 'var(--serif)', preview: 'var(--serif)' },
};

export function fontTokens(choice: FontChoice): FontTokens {
  return TOKENS[choice];
}

/**
 * Read a persisted value back. Anything absent, malformed or no longer a
 * choice resolves to the default rather than throwing — a corrupt preference
 * must never be the reason the editor fails to open.
 */
export function normalizeFontChoice(raw: string | null): FontChoice {
  return (FONT_CHOICES as readonly string[]).includes(raw ?? '')
    ? (raw as FontChoice)
    : DEFAULT_FONT;
}
