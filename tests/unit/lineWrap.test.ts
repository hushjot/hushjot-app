import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FIXED_LINE_WRAP,
  DEFAULT_LINE_WRAP,
  LINE_WRAP_CHOICES,
  WRAP_COLUMNS,
  lineWrapLabel,
  lineWrapShortLabel,
  normalizeFixedLineWrap,
  normalizeLineWrap,
  toggleLineWrap,
} from '../../src/ui/lineWrap.ts';

describe('normalizeLineWrap', () => {
  it('reads back every mode it can write', () => {
    for (const mode of LINE_WRAP_CHOICES) expect(normalizeLineWrap(String(mode))).toBe(mode);
  });

  it('falls back to the default for anything else', () => {
    for (const raw of [null, '', '  ', 'wrap', '79', '-80', 'NaN', '80px']) {
      expect(normalizeLineWrap(raw)).toBe(DEFAULT_LINE_WRAP);
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeLineWrap(' 120 ')).toBe(120);
  });
});

describe('normalizeFixedLineWrap', () => {
  it('never yields the window', () => {
    expect(normalizeFixedLineWrap('window')).toBe(DEFAULT_FIXED_LINE_WRAP);
    expect(normalizeFixedLineWrap(null)).toBe(DEFAULT_FIXED_LINE_WRAP);
  });

  it('keeps columns and off', () => {
    expect(normalizeFixedLineWrap('off')).toBe('off');
    expect(normalizeFixedLineWrap('40')).toBe(40);
  });
});

describe('toggleLineWrap', () => {
  it('goes from the window to the remembered fixed mode', () => {
    expect(toggleLineWrap('window', 120)).toBe(120);
    expect(toggleLineWrap('window', 'off')).toBe('off');
  });

  it('goes back to the window from any fixed mode', () => {
    for (const columns of WRAP_COLUMNS) expect(toggleLineWrap(columns, 80)).toBe('window');
    expect(toggleLineWrap('off', 80)).toBe('window');
  });
});

describe('labels', () => {
  it('names each mode', () => {
    expect(lineWrapLabel('window')).toBe('Fit window');
    expect(lineWrapLabel('off')).toBe('No wrap');
    expect(lineWrapLabel(80)).toBe('80 characters');
    expect(lineWrapShortLabel('window')).toBe('Fit');
    expect(lineWrapShortLabel('off')).toBe('Off');
    expect(lineWrapShortLabel(100)).toBe('100');
  });
});
