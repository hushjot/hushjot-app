/**
 * The quick-capture fragment: how text reaches the app on iOS.
 *
 * ```
 * https://hushjot.com/#c1.Some%20text%20to%20keep
 *                     │  └────────────────────── the text, percent-encoded
 *                     └───────────────────────── the fragment
 * ```
 *
 * ## Why a fragment
 *
 * The same reason the share link uses one (`core/share/link.ts`): a fragment
 * is never transmitted. It is not in the request line, not in `Referer`, and
 * no proxy in front of Hosting receives it. A query string would put the
 * user's note in the web host's access log, which for a product whose whole
 * claim is that the host cannot read the notes would be absurd.
 *
 * It is still in the address bar and in session history, which is why the app
 * clears it with `history.replaceState` the moment the text is in hand.
 *
 * ## Why `c1.`, and why it cannot collide with `s1.`
 *
 * `core/share/link.ts` reserved this: the version prefix is a discriminator
 * precisely so a second fragment scheme could arrive later. `parseFragment`
 * requires exactly three dot-separated parts beginning `s1`, so a capture
 * fragment reads as `null` there; `parseCaptureFragment` requires the prefix
 * `c1` and reads a share fragment as `null` here. Neither can be mistaken for
 * the other, and `tests/unit/capture.test.ts` asserts both directions.
 *
 * ## Why percent-encoding rather than base64url
 *
 * Because a person has to build this by hand in iOS Shortcuts, and Shortcuts
 * has a single "URL Encode" action. Base64url would need a Base64 Encode plus
 * two Replace Text actions to turn `+/=` into `-_`, and a three-action
 * encoding step is three places for a stranger following instructions on their
 * phone to go wrong. `encodeURIComponent` escapes `#` and `%`, which are the
 * only characters that could break the fragment; the rest it leaves alone,
 * which has the side benefit that the URL is legible.
 *
 * Pure string handling, no DOM, no crypto.
 */

export const CAPTURE_PREFIX = 'c1';

/**
 * The longest capture that is accepted, in characters of decoded text.
 *
 * A guard, not a product limit: it bounds the work done on a fragment a
 * stranger controls. Browsers give out long before this — the practical
 * ceiling is whatever the URL length limit of the browser Shortcuts opens
 * happens to be — so a real capture never comes near it.
 */
export const MAX_CAPTURE_CHARS = 128 * 1024;

/**
 * The raw fragment ceiling, checked before decoding.
 *
 * Percent-encoding can triple a string's length (`%E2%80%99` for one
 * character), so the encoded form is allowed to be larger than the decoded
 * one. Checking this first means an absurd fragment is rejected without
 * decoding it.
 */
const MAX_FRAGMENT_CHARS = MAX_CAPTURE_CHARS * 3;

export function buildCaptureFragment(text: string): string {
  return `${CAPTURE_PREFIX}.${encodeURIComponent(text)}`;
}

/**
 * Read captured text out of a `location.hash`.
 *
 * Returns `null` for anything that is not exactly this scheme — another
 * scheme's fragment, no fragment, a malformed escape, something absurdly
 * long. The caller's response to `null` is to do nothing at all and leave the
 * fragment alone: a half-read capture must not become half a note.
 */
export function parseCaptureFragment(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length > MAX_FRAGMENT_CHARS) return null;

  // `indexOf` rather than `split`, because the text itself will contain dots
  // and only the first one is the separator.
  const dot = raw.indexOf('.');
  if (dot === -1 || raw.slice(0, dot) !== CAPTURE_PREFIX) return null;

  let text: string;
  try {
    text = decodeURIComponent(raw.slice(dot + 1));
  } catch {
    // A lone `%` or a truncated escape. Nothing to recover.
    return null;
  }

  if (text.length > MAX_CAPTURE_CHARS) return null;
  return text.trim() === '' ? null : text;
}
