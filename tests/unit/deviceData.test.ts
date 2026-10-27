import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearDevicePreferences, DEVICE_KEY_PREFIX } from '../../src/core/repo/deviceData.ts';

/**
 * A localStorage good enough for a prefix scan: the real contract that matters
 * here is that `key(i)` walks a live index, which is exactly what makes
 * removing during the scan skip entries.
 */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    keys: () => [...map.keys()],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('clearDevicePreferences', () => {
  it('removes every prefixed key, including ones it has never heard of', () => {
    const store = fakeStorage({
      'teksto:theme': 'dark',
      'teksto:tile-layout': 'vertical',
      'teksto:journal:v2': '{}',
      // The point of scanning rather than listing: a key added later, by a
      // module that does not know this function exists, still goes.
      'teksto:something-nobody-has-written-yet': '1',
    });
    vi.stubGlobal('localStorage', store);

    clearDevicePreferences();

    expect(store.keys()).toEqual([]);
  });

  it('leaves anything that is not ours alone', () => {
    const store = fakeStorage({
      'teksto:theme': 'dark',
      'firebase:authUser:abc': '{}',
      teksto: 'not prefixed — the colon is part of the prefix',
      'other:teksto:theme': 'not ours either',
    });
    vi.stubGlobal('localStorage', store);

    clearDevicePreferences();

    expect(store.keys()).toEqual([
      'firebase:authUser:abc',
      'teksto',
      'other:teksto:theme',
    ]);
  });

  it('removes adjacent keys rather than every second one', () => {
    // Regression guard for the obvious implementation: deleting inside the
    // `key(i)` loop renumbers the indices and skips the next match.
    const store = fakeStorage(
      Object.fromEntries([...Array(6)].map((_, i) => [`${DEVICE_KEY_PREFIX}k${i}`, '1'])),
    );
    vi.stubGlobal('localStorage', store);

    clearDevicePreferences();

    expect(store.keys()).toEqual([]);
  });

  it('survives a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new DOMException('denied', 'SecurityError');
      },
    });

    // A reset whose destructive half has already happened must not be aborted
    // by the tidying-up half.
    expect(() => clearDevicePreferences()).not.toThrow();
  });
});
