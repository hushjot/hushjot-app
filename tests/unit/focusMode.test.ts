/**
 * Focus mode's pure half: the storage spelling and the one rule that keeps the
 * mode honest — the status bar survives the two save states nothing else says.
 *
 * The store itself (`state/focusMode.svelte.ts`) is three lines of `$state`
 * over these functions, and there is no rune harness here, so this is where the
 * behaviour is pinned. `deviceData.test.ts` is where the fake storage comes
 * from.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SaveState } from '../../src/ui/state/workspace.svelte.ts';
import {
  FOCUS_MODE_KEY,
  LOUD_SAVE_STATES,
  readFocusMode,
  showStatusBar,
  writeFocusMode,
} from '../../src/ui/focusMode.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('showStatusBar', () => {
  const ALL: readonly SaveState[] = ['saved', 'saving', 'offline', 'syncing', 'sync-failed'];

  it('shows the bar in every state while focus mode is off', () => {
    for (const state of ALL) expect(showStatusBar(false, state)).toBe(true);
  });

  /**
   * The load-bearing case. On desktop the status bar is the only place either
   * of these is said: there is no banner for a failing sync, and focus mode has
   * already taken the topbar's cloud with it. Hiding them would quietly stop
   * honouring "local storage is a cache, sync is the durability guarantee".
   */
  it('keeps the bar for Offline and Not synced even in focus mode', () => {
    expect(showStatusBar(true, 'offline')).toBe(true);
    expect(showStatusBar(true, 'sync-failed')).toBe(true);
    expect(LOUD_SAVE_STATES).toEqual(['offline', 'sync-failed']);
  });

  /**
   * And the reason the rule is not simply "anything but saved": these two are
   * what typing looks like, so a bar that honoured them would appear and
   * disappear on every keystroke, which is worse than no bar at all.
   */
  it('hides the bar for the transient states, which are just typing', () => {
    expect(showStatusBar(true, 'saved')).toBe(false);
    expect(showStatusBar(true, 'saving')).toBe(false);
    expect(showStatusBar(true, 'syncing')).toBe(false);
  });
});

describe('storage', () => {
  it('reads absent as off, so a device that never chose gets the default', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(readFocusMode()).toBe(false);
  });

  it('writes only "on", so a device that never chose holds no key', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);

    writeFocusMode(true);
    expect(store.keys()).toEqual([FOCUS_MODE_KEY]);
    expect(readFocusMode()).toBe(true);

    writeFocusMode(false);
    expect(store.keys()).toEqual([]);
    expect(readFocusMode()).toBe(false);
  });

  it('ignores a value it did not write', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [FOCUS_MODE_KEY]: 'yes please' }));
    expect(readFocusMode()).toBe(false);
  });

  /**
   * Private mode with storage blocked: every access throws. The mode still
   * works for the session; the only loss is that it does not persist.
   */
  it('degrades to off rather than throwing when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readFocusMode()).toBe(false);
    expect(() => writeFocusMode(true)).not.toThrow();
    expect(() => writeFocusMode(false)).not.toThrow();
  });

  it('uses the frozen prefix', () => {
    expect(FOCUS_MODE_KEY.startsWith('teksto:')).toBe(true);
  });
});
