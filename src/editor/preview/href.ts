/**
 * The one answer to "may this note text become a link a browser follows?"
 *
 * Split out of `model.ts` so the editor can ask it synchronously: `model.ts` is
 * a lazy chunk, and the link chip (`../linkChip.ts`) vets a URL as it offers to
 * open it. Imports-free and a few hundred bytes. `bench:size` measured the share
 * viewer, which also reaches it through `model.ts`, unchanged by the split; a
 * dynamic import of `model.ts` from the editor instead cost the viewer 0.4 KB.
 */

/**
 * The link allowlist. A URL parser strips ASCII tabs, newlines and leading
 * control characters, so `java\tscript:` is `javascript:` to a browser. The
 * scheme is checked with those removed, never on the raw string.
 */
export function safeHref(url: string): string | null {
  const unescaped = url.trim().replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const probe = unescaped.replace(/[\u0000-\u0020]/g, '');
  if (probe.startsWith('#')) return unescaped;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return unescaped;
  return null;
}
