import { describe, it, expect } from 'vitest';
import { nextOverride, normalizeTheme, themeStatus } from '../../src/ui/theme.ts';

describe('normalizeTheme', () => {
  it('keeps a valid override', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
  });

  it('follows the system for anything else', () => {
    expect(normalizeTheme(null)).toBeNull();
    expect(normalizeTheme('')).toBeNull();
    expect(normalizeTheme('Dark')).toBeNull();
    expect(normalizeTheme('system')).toBeNull();
  });
});

describe('nextOverride', () => {
  it('stores a choice that disagrees with the system', () => {
    expect(nextOverride('light', 'light')).toBe('dark');
    expect(nextOverride('dark', 'dark')).toBe('light');
  });

  it('clears the override when flipping back to the system theme', () => {
    expect(nextOverride('dark', 'light')).toBeNull();
    expect(nextOverride('light', 'dark')).toBeNull();
  });
});

describe('themeStatus', () => {
  it('names the action by what a click gives, as the icon does', () => {
    expect(themeStatus(null, 'light').action).toBe('Dark mode');
    expect(themeStatus(null, 'dark').action).toBe('Light mode');
    expect(themeStatus('dark', 'light').action).toBe('Light mode');
  });

  it('says what is showing and who chose it', () => {
    expect(themeStatus(null, 'dark').state).toBe('Dark, following your system');
    expect(themeStatus('dark', 'light').state).toBe('Dark, set on this device');
    // The two states are distinguishable even when they agree on the palette,
    // which is the whole case a two-state toggle could not express.
    expect(themeStatus(null, 'dark').state).not.toBe(themeStatus('dark', 'dark').state);
  });

  it('marks an override, and only an override', () => {
    expect(themeStatus(null, 'light').pinned).toBe(false);
    expect(themeStatus(null, 'dark').pinned).toBe(false);
    expect(themeStatus('light', 'light').pinned).toBe(true);
    expect(themeStatus('dark', 'light').pinned).toBe(true);
  });

  it('gives a screen reader the action and the state in one label', () => {
    expect(themeStatus('dark', 'light').ariaLabel).toBe(
      'Switch to light mode. Currently dark, set on this device.',
    );
    expect(themeStatus(null, 'light').ariaLabel).toBe(
      'Switch to dark mode. Currently light, following your system.',
    );
  });

  it('agrees with `nextOverride` about what a click does', () => {
    for (const system of ['light', 'dark'] as const) {
      for (const override of [null, 'light', 'dark'] as const) {
        const status = themeStatus(override, system);
        const after = themeStatus(nextOverride(override ?? system, system), system);
        // The action promised before the click is what is showing after it.
        expect(after.state.startsWith(status.action.split(' ')[0]!)).toBe(true);
      }
    }
  });
});
