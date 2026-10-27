import { describe, it, expect } from 'vitest';
import {
  SHARE_PREFIX,
  SHARE_ID_CHARS,
  SHARE_KEY_CHARS,
  VIEWER_PATH,
  newShareId,
  isShareId,
  buildFragment,
  buildShareUrl,
  parseFragment,
} from '../../src/core/share/link.ts';
import { toBase64Url, fromBase64Url, randomBytes } from '../../src/core/crypto/bytes.ts';

const key = toBase64Url(randomBytes(32));

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [0, 1, 2, 3, 16, 31, 32, 255]) {
      const bytes = randomBytes(length);
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    }
  });

  it('never emits a character that needs escaping in a URL', () => {
    for (let i = 0; i < 200; i++) {
      expect(toBase64Url(randomBytes(32))).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('refuses input outside the alphabet rather than improvising', () => {
    expect(() => fromBase64Url('abc+def')).toThrow();
    expect(() => fromBase64Url('abc/def')).toThrow();
    expect(() => fromBase64Url('abc=')).toThrow();
  });
});

describe('share ids', () => {
  it('are 22 base64url characters', () => {
    const id = newShareId();
    expect(id).toHaveLength(SHARE_ID_CHARS);
    expect(isShareId(id)).toBe(true);
  });

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, newShareId));
    expect(seen.size).toBe(500);
  });

  it('reject anything of the wrong shape', () => {
    expect(isShareId('')).toBe(false);
    expect(isShareId('short')).toBe(false);
    expect(isShareId(`${newShareId()}x`)).toBe(false);
    expect(isShareId('../../../etc/passwd')).toBe(false);
  });
});

describe('the fragment', () => {
  it('round-trips', () => {
    const ref = { id: newShareId(), key };
    expect(parseFragment(`#${buildFragment(ref)}`)).toEqual(ref);
  });

  it('parses with or without the leading hash', () => {
    const ref = { id: newShareId(), key };
    expect(parseFragment(buildFragment(ref))).toEqual(ref);
  });

  it('keeps the id and key out of the path', () => {
    const ref = { id: newShareId(), key };
    const url = new URL(buildShareUrl('https://hushjot.com', ref));
    expect(url.pathname).toBe(VIEWER_PATH);
    expect(url.search).toBe('');
    expect(url.hash.slice(1)).toBe(buildFragment(ref));
    // The whole point: nothing identifying survives dropping the fragment.
    expect(`${url.origin}${url.pathname}`).not.toContain(ref.id);
    expect(`${url.origin}${url.pathname}`).not.toContain(ref.key);
  });

  it('tolerates a trailing slash on the origin', () => {
    const ref = { id: newShareId(), key };
    expect(buildShareUrl('https://hushjot.com/', ref)).toBe(buildShareUrl('https://hushjot.com', ref));
  });

  it('returns null rather than guessing', () => {
    const id = newShareId();
    expect(parseFragment('')).toBeNull();
    expect(parseFragment('#')).toBeNull();
    expect(parseFragment(`#${id}.${key}`)).toBeNull(); // no prefix
    expect(parseFragment(`#${SHARE_PREFIX}.${id}`)).toBeNull(); // no key
    expect(parseFragment(`#${SHARE_PREFIX}.${id}.${key}.extra`)).toBeNull();
    expect(parseFragment(`#${SHARE_PREFIX}.${id}.${key.slice(0, -1)}`)).toBeNull();
    expect(parseFragment(`#${SHARE_PREFIX}.${id.slice(0, -1)}.${key}`)).toBeNull();
    expect(parseFragment(`#${SHARE_PREFIX}.${id}.${key.slice(0, -1)}+`)).toBeNull();
  });

  it('ignores a fragment belonging to another scheme', () => {
    // Item 16 (quick capture) will put its own fragment on this origin.
    expect(parseFragment('#capture.some%20text')).toBeNull();
    expect(parseFragment(`#s2.${newShareId()}.${key}`)).toBeNull();
  });

  it('agrees with the rules about what a key looks like', () => {
    expect(key).toHaveLength(SHARE_KEY_CHARS);
  });
});
