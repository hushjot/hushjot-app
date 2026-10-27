/**
 * Quick capture (`private/viability-assessment.md` item 16).
 *
 * Two things are worth testing here and nothing else is: the de-duplication
 * rules in `composeCapture`, because every one of them exists because some
 * Android app fills the three share fields differently; and the fragment
 * scheme's mutual exclusion with the share scheme, because both live on one
 * origin and the only thing keeping them apart is a two-character prefix.
 */
import { describe, expect, it } from 'vitest';
import { composeCapture } from '../../src/core/capture/compose.ts';
import {
  CAPTURE_PREFIX,
  MAX_CAPTURE_CHARS,
  buildCaptureFragment,
  parseCaptureFragment,
} from '../../src/core/capture/link.ts';
import { buildFragment, parseFragment } from '../../src/core/share/link.ts';

describe('composeCapture', () => {
  it('puts the title above the text as a heading', () => {
    expect(composeCapture({ title: 'A headline', text: 'The body.' })).toBe('# A headline\n\nThe body.');
  });

  it('appends the url on its own line', () => {
    expect(composeCapture({ title: 'A page', text: 'A quote.', url: 'https://example.com/a' })).toBe(
      '# A page\n\nA quote.\n\nhttps://example.com/a',
    );
  });

  // Chrome sharing a page sends the same string as title and text.
  it('does not repeat a title the text already opens with', () => {
    expect(composeCapture({ title: 'A headline', text: 'A headline\n\nThe body.' })).toBe(
      'A headline\n\nThe body.',
    );
    expect(composeCapture({ title: 'A headline', text: '# A headline\n\nThe body.' })).toBe(
      '# A headline\n\nThe body.',
    );
  });

  // Several readers put the link in `text` and fill `url` with it as well.
  it('does not repeat a url the text already contains', () => {
    expect(composeCapture({ text: 'Look: https://example.com/a', url: 'https://example.com/a' })).toBe(
      'Look: https://example.com/a',
    );
  });

  it('accepts any single field on its own', () => {
    expect(composeCapture({ text: 'Just text' })).toBe('Just text');
    expect(composeCapture({ title: 'Just a title' })).toBe('# Just a title');
    expect(composeCapture({ url: 'https://example.com/a' })).toBe('https://example.com/a');
  });

  it('is null when there is nothing in the share', () => {
    expect(composeCapture({})).toBeNull();
    expect(composeCapture({ title: '   ', text: '\n\t ', url: '' })).toBeNull();
  });

  it('trims each field rather than trusting the sender', () => {
    expect(composeCapture({ title: '  Spaced  ', text: '\n  Body  \n' })).toBe('# Spaced\n\nBody');
  });
});

describe('the capture fragment', () => {
  it('round-trips text through a fragment', () => {
    const text = 'Notes with a # hash, a % percent and an emoji 🫥';
    expect(parseCaptureFragment(`#${buildCaptureFragment(text)}`)).toBe(text);
  });

  it('reads a fragment with or without its leading hash', () => {
    const fragment = buildCaptureFragment('hello');
    expect(parseCaptureFragment(fragment)).toBe('hello');
    expect(parseCaptureFragment(`#${fragment}`)).toBe('hello');
  });

  it('keeps every dot after the first', () => {
    const text = 'One. Two. Three.';
    expect(parseCaptureFragment(`#${buildCaptureFragment(text)}`)).toBe(text);
  });

  it('is null for another scheme, no fragment, or a malformed escape', () => {
    expect(parseCaptureFragment('')).toBeNull();
    expect(parseCaptureFragment('#')).toBeNull();
    expect(parseCaptureFragment('#c2.text')).toBeNull();
    expect(parseCaptureFragment('#nodot')).toBeNull();
    expect(parseCaptureFragment('#c1.%E0%A4%A')).toBeNull();
  });

  it('is null for an empty capture', () => {
    expect(parseCaptureFragment(`#${CAPTURE_PREFIX}.`)).toBeNull();
    expect(parseCaptureFragment(`#${buildCaptureFragment('   ')}`)).toBeNull();
  });

  it('refuses a capture past the ceiling rather than truncating it', () => {
    expect(parseCaptureFragment(`#${buildCaptureFragment('a'.repeat(MAX_CAPTURE_CHARS))}`)).not.toBeNull();
    expect(parseCaptureFragment(`#${buildCaptureFragment('a'.repeat(MAX_CAPTURE_CHARS + 1))}`)).toBeNull();
  });
});

/**
 * Two schemes, one origin. `core/share/link.ts` reserved the version prefix
 * for exactly this, and the guarantee is worth an assertion in both
 * directions: a capture must never be fetched as a share, and a share must
 * never be written into a note as text.
 */
describe('the capture and share fragments cannot be mistaken for each other', () => {
  const share = buildFragment({ id: 'A'.repeat(22), key: 'B'.repeat(43) });

  it('the share parser rejects a capture fragment', () => {
    expect(parseFragment(`#${buildCaptureFragment('a.b')}`)).toBeNull();
    expect(parseFragment(`#${buildCaptureFragment('some shared text')}`)).toBeNull();
  });

  it('the capture parser rejects a share fragment', () => {
    expect(parseCaptureFragment(`#${share}`)).toBeNull();
  });
});
