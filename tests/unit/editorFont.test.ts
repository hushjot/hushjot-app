import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FONT,
  FONT_CHOICES,
  FONT_LABELS,
  fontTokens,
  normalizeFontChoice,
} from '../../src/ui/editorFont.ts';

describe('normalizeFontChoice', () => {
  it('keeps a real choice', () => {
    for (const choice of FONT_CHOICES) expect(normalizeFontChoice(choice)).toBe(choice);
  });

  it('falls back to the default rather than throwing', () => {
    // A corrupt preference must never be the reason the editor fails to open.
    expect(normalizeFontChoice(null)).toBe(DEFAULT_FONT);
    expect(normalizeFontChoice('')).toBe(DEFAULT_FONT);
    expect(normalizeFontChoice('Serif')).toBe(DEFAULT_FONT);
    expect(normalizeFontChoice('comic')).toBe(DEFAULT_FONT);
  });
});

describe('fontTokens', () => {
  it('leaves the default behaving exactly as the app did before the choice', () => {
    // Mono editor, sans preview. If this pair ever became symmetric, choosing
    // the default would silently change every existing reader's preview.
    expect(fontTokens('mono')).toEqual({ editor: 'var(--mono)', preview: 'var(--sans)' });
    expect(DEFAULT_FONT).toBe('mono');
  });

  it('moves the preview with the editor for the two prose choices', () => {
    expect(fontTokens('sans')).toEqual({ editor: 'var(--sans)', preview: 'var(--sans)' });
    expect(fontTokens('serif')).toEqual({ editor: 'var(--serif)', preview: 'var(--serif)' });
  });

  it('names only tokens the shells declare', () => {
    // Both shells carry the same token block (`shellTokens.test.ts`), so a
    // token invented here would resolve to nothing and, inside the preview's
    // `font:` shorthand, take the size and line-height down with it.
    const declared = new Set(['var(--mono)', 'var(--sans)', 'var(--serif)']);
    for (const choice of FONT_CHOICES) {
      const { editor, preview } = fontTokens(choice);
      expect(declared.has(editor), `${choice} editor`).toBe(true);
      expect(declared.has(preview), `${choice} preview`).toBe(true);
    }
  });
});

describe('the menu', () => {
  it('has a distinct label for every choice', () => {
    const labels = FONT_CHOICES.map((c) => FONT_LABELS[c]);
    // `RowActions` keys its rows by label, so a duplicate would drop a row.
    expect(new Set(labels).size).toBe(labels.length);
  });
});
