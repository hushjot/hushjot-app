/**
 * Reactive media queries. Used to drive layout decisions that CSS alone cannot
 * make — swapping which pane is mounted, not merely how it looks.
 */

export function mediaQuery(query: string): { readonly matches: boolean } {
  const mql = window.matchMedia(query);
  let matches = $state(mql.matches);

  const onChange = (event: MediaQueryListEvent) => {
    matches = event.matches;
  };

  $effect(() => {
    mql.addEventListener('change', onChange);
    // Re-sync in case the viewport changed between construction and mount.
    matches = mql.matches;
    return () => mql.removeEventListener('change', onChange);
  });

  return {
    get matches() {
      return matches;
    },
  };
}

/** The single breakpoint the layout switches on (§20 desktop vs §21 mobile). */
export const MOBILE_QUERY = '(max-width: 720px)';
