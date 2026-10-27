/**
 * The light/dark rule, kept pure so it is testable without a rune harness —
 * the same split `textSize.ts` makes from its store.
 *
 * Two states on the button, not three. The palette follows the system until
 * the reader flips it; an override is stored only while it *disagrees* with the
 * system, so flipping back to what the OS already shows clears it and the app
 * follows the OS again. That keeps "follow system" reachable without a third
 * button state nobody can read at a glance, and it means a reader who tried the
 * toggle once and put it back does not end up pinned to a theme when their OS
 * switches at sunset.
 *
 * What that design does not do is *say* which of the two you are in, and a
 * rule you cannot see is a rule you cannot trust — the reader whose OS turns
 * light at dawn has no way to tell whether the app stayed dark because it was
 * told to or because it was not. So `themeStatus` names the state in the
 * tooltip and to a screen reader, the button carries a dot while it is
 * overridden, and `theme-system` is offered as an explicit way back that only
 * appears while there is something to go back from. The click itself is
 * unchanged.
 */

export type Theme = 'light' | 'dark';

/** A persisted override, or `null` for "follow the system". */
export function normalizeTheme(raw: string | null): Theme | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** The override a click should leave behind, given what is showing now. */
export function nextOverride(effective: Theme, system: Theme): Theme | null {
  const next: Theme = effective === 'dark' ? 'light' : 'dark';
  return next === system ? null : next;
}

export interface ThemeStatus {
  /** A choice is stored for this device, rather than the OS being followed. */
  pinned: boolean;
  /** What a click gives you — the tooltip's first line, as the icon does. */
  action: string;
  /** What is showing and where it came from. The tooltip's second line. */
  state: string;
  /** Both of the above, for a reader who gets no tooltip and no dot. */
  ariaLabel: string;
}

/**
 * The words on the toggle.
 *
 * Pure, and returning finished strings rather than flags, so the wording is
 * pinned by `theme.test.ts` rather than living in markup where nothing checks
 * it. `App.svelte` adds only the keyboard hint.
 */
export function themeStatus(override: Theme | null, system: Theme): ThemeStatus {
  const effective: Theme = override ?? system;
  const next: Theme = effective === 'dark' ? 'light' : 'dark';
  const pinned = override !== null;
  const showing = effective === 'dark' ? 'Dark' : 'Light';
  const source = pinned ? 'set on this device' : 'following your system';
  return {
    pinned,
    action: `${next === 'dark' ? 'Dark' : 'Light'} mode`,
    state: `${showing}, ${source}`,
    ariaLabel: `Switch to ${next} mode. Currently ${showing.toLowerCase()}, ${source}.`,
  };
}
