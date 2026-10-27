/**
 * How far the virtual keyboard covers the bottom of the window, published as
 * the CSS variable `--kb-inset`.
 *
 * **Why this exists at all.** `index.html` asks for
 * `interactive-widget=resizes-content`, and on Android Chrome that is a
 * complete answer: the layout viewport shrinks, `100dvh` shrinks with it, and
 * a bar at the bottom of the flow sits on the keyboard with no JavaScript.
 * iOS Safari implements neither — the layout viewport keeps its full height,
 * the keyboard is drawn over the page, and `position: fixed; bottom: 0` lands
 * behind it. There is no CSS-only fix; `env(keyboard-inset-bottom)` is
 * Chromium-only, which is to say it exists exactly where it is not needed.
 *
 * **Why there is no platform check.** The measurement below is
 * `innerHeight - (visualViewport.height + offsetTop)`. On Android the viewport
 * has already been resized, so the two agree and it evaluates to ~0 — the
 * `dvh` behaviour, untouched. On iOS the difference *is* the keyboard. One
 * expression, both platforms; do not add a `IS_APPLE` branch.
 *
 * **Why it is careful.** `visualViewport` fires `scroll` as well as `resize`,
 * and on iOS that fires while the caret is being kept in view — which is to
 * say on keystrokes. This therefore sits on the typing path, where the budget
 * is a p95 under 16 ms at 6x CPU throttle (`bench/mobile.mjs`). So: no
 * layout-forcing reads, one `requestAnimationFrame` per frame at most, a
 * direct style write rather than a `$state` write (the same argument
 * `RowActions` makes for writing placement straight onto the node — a rune
 * write would schedule Svelte's whole graph), and a 1px threshold because
 * iOS emits sub-pixel offsets all through a rubber-band scroll.
 */

const VARIABLE = '--kb-inset';

/** Start tracking. Returns the teardown; safe to call where there is no API. */
export function trackKeyboardInset(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
  if (!vv) return () => {};

  const root = document.documentElement;
  let frame = 0;
  let last = -1;

  const write = () => {
    frame = 0;
    // All three are cheap reads; none forces layout.
    const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    const next = Math.round(inset);
    if (Math.abs(next - last) < 1) return;
    last = next;
    root.style.setProperty(VARIABLE, `${next}px`);
  };

  const onChange = () => {
    if (frame) return;
    frame = requestAnimationFrame(write);
  };

  vv.addEventListener('resize', onChange, { passive: true });
  vv.addEventListener('scroll', onChange, { passive: true });
  onChange();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    // Leave nothing behind: the bar is gone, so the inset must not linger and
    // pad the editor against a keyboard that is no longer open.
    root.style.removeProperty(VARIABLE);
  };
}
