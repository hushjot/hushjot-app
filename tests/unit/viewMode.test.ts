import { describe, it, expect } from 'vitest';
import {
  effectiveViewMode,
  modesToStore,
  nextViewMode,
  normalizeViewMode,
  storedModeFor,
} from '../../src/ui/viewMode.ts';

describe('view mode', () => {
  it('defaults to edit and rejects anything unknown', () => {
    expect(normalizeViewMode(null)).toBe('edit');
    expect(normalizeViewMode('wysiwyg')).toBe('edit');
    expect(normalizeViewMode('split')).toBe('split');
  });

  it('cycles edit → split → preview → edit', () => {
    expect(nextViewMode('edit')).toBe('split');
    expect(nextViewMode('split')).toBe('preview');
    expect(nextViewMode('preview')).toBe('edit');
  });

  it('has no split on a phone, but keeps the stored mode', () => {
    expect(effectiveViewMode('split', { mobile: true })).toBe('preview');
    expect(effectiveViewMode('split', { mobile: false })).toBe('split');
    expect(nextViewMode('edit', { mobile: true })).toBe('preview');
    expect(nextViewMode('split', { mobile: true })).toBe('edit');
  });

  it('stores only non-default modes, keyed by note id', () => {
    expect(
      modesToStore([
        { id: 'a', mode: 'preview' },
        { id: 'b', mode: 'edit' },
        { id: null, mode: 'split' },
        { id: 'c', mode: 'split' },
      ]),
    ).toEqual({ a: 'preview', c: 'split' });
  });

  it('reads a stored mode defensively', () => {
    expect(storedModeFor({ a: 'preview' }, 'a')).toBe('preview');
    expect(storedModeFor({ a: 'preview' }, 'b')).toBe('edit');
    expect(storedModeFor({ a: 'bogus' }, 'a')).toBe('edit');
    expect(storedModeFor(['preview'], '0')).toBe('edit');
    expect(storedModeFor(null, 'a')).toBe('edit');
    expect(storedModeFor({}, 'toString')).toBe('edit');
  });
});
