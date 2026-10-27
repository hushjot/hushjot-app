/**
 * The share link: what goes in the URL, and what never does.
 *
 * ```
 * https://hushjot.com/s/#s1.<id 22 chars>.<key 43 chars>
 *                      │  └──────────────────────────── the fragment
 *                      └───────────────────────────── the only path a server sees
 * ```
 *
 * ## Why everything is in the fragment
 *
 * A fragment is never transmitted. It is not in the request line, it is not in
 * `Referer` (and `Referrer-Policy: no-referrer` is set besides), and no proxy
 * or CDN in front of Hosting ever receives it. Putting the **id** there as well
 * as the key means the web host's own access log cannot say which share was
 * opened — only that the viewer page was. Firestore learns the id, because it
 * has to serve the document; nothing else does.
 *
 * It also means `/s/` is a plain directory index, so Hosting needs no rewrite
 * and a link-unfurling bot (Slack, WhatsApp, iMessage) fetches a page with no
 * content in it at all.
 *
 * ## Why there is a version prefix
 *
 * `s1.` costs three characters and buys a second format later without
 * guessing. It is also a discriminator: quick capture may
 * come in through a URL fragment too, and two fragment schemes on
 * one origin must be able to tell each other apart.
 *
 * Pure string handling. The key is carried as text and only becomes a
 * `CryptoKey` in `payload.ts`, so nothing here can touch `crypto.subtle`.
 */
import { randomBytes, toBase64Url } from '../crypto/bytes.ts';

export const SHARE_PREFIX = 's1';

/** 16 random bytes, base64url: 128 unguessable bits in 22 characters. */
export const SHARE_ID_BYTES = 16;
export const SHARE_ID_CHARS = 22;
/** A 256-bit key, base64url. */
export const SHARE_KEY_CHARS = 43;

const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SHARE_ID_CHARS}}$`);
const KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SHARE_KEY_CHARS}}$`);

/** The viewer's path. A directory, so Hosting serves its index with no rewrite. */
export const VIEWER_PATH = '/s/';

export interface ShareRef {
  id: string;
  /** The raw key, base64url. Never logged, never put in a query string. */
  key: string;
}

export function newShareId(): string {
  return toBase64Url(randomBytes(SHARE_ID_BYTES));
}

export function isShareId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function buildFragment(ref: ShareRef): string {
  return `${SHARE_PREFIX}.${ref.id}.${ref.key}`;
}

/** The whole link, given the origin the app is served from. */
export function buildShareUrl(origin: string, ref: ShareRef): string {
  return `${origin.replace(/\/+$/, '')}${VIEWER_PATH}#${buildFragment(ref)}`;
}

/**
 * Read a share out of a `location.hash`.
 *
 * Returns null for anything that is not exactly this format — a missing
 * fragment, another scheme's fragment, a truncated key. The caller reports
 * "this link is incomplete" and stops; it must not fall through to a fetch,
 * because a half-parsed link would ask the backend for a document the user
 * has no key for.
 */
export function parseFragment(hash: string): ShareRef | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [prefix, id, key] = parts as [string, string, string];
  if (prefix !== SHARE_PREFIX) return null;
  if (!ID_PATTERN.test(id) || !KEY_PATTERN.test(key)) return null;
  return { id, key };
}
