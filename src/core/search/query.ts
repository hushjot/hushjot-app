/**
 * The search query grammar (§11).
 *
 * Until this module existed the grammar was nine lines inside
 * `SearchIndex.search()`: split on whitespace, lift any word starting with `#`
 * as a tag filter, re-join the rest and split again. That was the whole of it,
 * and it had no way to say "only this folder", "these words in this order" or
 * "not this".
 *
 * ## Why the parsing order is what it is
 *
 * **Quoted runs come out first, before any whitespace split.** That ordering is
 * the reason quotes work as an escape: by the time `#` and `-` are looked at,
 * anything inside quotes is already a phrase and cannot be mistaken for an
 * operator. `"#include"` is the motivating case — a C programmer searching for
 * it got a tag filter for `include` and no way to say otherwise, because `#` has
 * been the one operator since the index was written.
 *
 * **An unterminated quote is a plain term, not an error.** This grammar is
 * re-parsed on every keystroke, so `"conn` is a query somebody is halfway
 * through typing. Treating it as a phrase would blank the finder until they
 * reached the closing quote.
 *
 * **`-` is only a negation at the start of a whitespace-delimited token.**
 * Splitting on whitespace before looking at `-` is what leaves `kebab-case`,
 * `--flag` in a quoted phrase and a hyphenated name alone; the index's own
 * `SPLIT` would break those into words anyway, and it does so after this.
 *
 * ## What this module deliberately does not do
 *
 * It does not resolve `in:`. Folder *names* are sealed, so only a caller that
 * holds the decrypted folder list can say which ids `in:Work/DB` means — the
 * index is given ids and never learns a name. `foldersMatching`
 * (`core/notes/folders.ts`) is the shared resolver, and `search.svelte.ts` and
 * the CLI each apply their own policy on top of it.
 *
 * It also does not tokenize. `tokenize` is a frozen contract
 * (`contract/format-vectors.json`) shared with `@hushjot/cli`; terms here are
 * split on the index's `SPLIT` at the point of use, exactly as before.
 */

/** Anything that is not a letter, digit or underscore. Mirrors the index. */
const SPLIT = /[^\p{L}\p{N}_]+/u;

const IN_PREFIX = 'in:';

export interface ParsedQuery {
  /** Prefix-matched words that must all be present. */
  terms: string[];
  notTerms: string[];
  /** Lowercased, whitespace-collapsed literal runs. Verified against bodies. */
  phrases: string[];
  notPhrases: string[];
  /** Tag prefixes, lowercased, without the leading `#`. */
  tags: string[];
  notTags: string[];
  /** Raw `in:` values. Resolving these to folder ids is the caller's job. */
  folders: string[];
  notFolders: string[];
}

function empty(): ParsedQuery {
  return {
    terms: [], notTerms: [],
    phrases: [], notPhrases: [],
    tags: [], notTags: [],
    folders: [], notFolders: [],
  };
}

/** Lowercased with runs of whitespace collapsed, so a phrase can span a line break. */
export function normalisePhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface Lifted {
  /** The query with every closed quoted run removed. */
  rest: string;
  phrases: string[];
  notPhrases: string[];
  folders: string[];
  notFolders: string[];
}

/** The whitespace-delimited token ending at `end`, lowercased. */
function tokenBefore(query: string, end: number): { text: string; start: number } {
  let start = end;
  while (start > 0 && !/\s/.test(query[start - 1]!)) start--;
  return { text: query.slice(start, end).toLowerCase(), start };
}

/**
 * Pull out `"..."` runs before anything else is looked at.
 *
 * Doing this first is what makes a quote an escape: by the time `#` and `-` are
 * read, whatever was quoted is already spoken for and cannot be mistaken for an
 * operator.
 *
 * Two things are read from the characters *before* the opening quote, because
 * the quote binds to them. A `-` negates, but only where the `-` itself starts
 * a token, so `foo-"bar"` is not a negation. And `in:` claims the quoted text as
 * a folder path rather than a phrase — without that, `in:"My Work"` would parse
 * as a bare `in:` (ignored) plus a phrase search for "my work", which is a
 * plausible thing to type and a silently wrong answer. Folder names contain
 * spaces often enough that quoting one is the obvious way to write it.
 *
 * An unclosed quote is left in `rest` to be read as ordinary words: this runs on
 * every keystroke, and a half-typed phrase must behave like the prefix it is.
 */
function liftPhrases(query: string): Lifted {
  const out: Lifted = { rest: '', phrases: [], notPhrases: [], folders: [], notFolders: [] };
  let i = 0;

  while (i < query.length) {
    const open = query.indexOf('"', i);
    if (open === -1) break;

    const close = query.indexOf('"', open + 1);
    if (close === -1) break; // Unterminated: everything from here is plain text.

    const before = tokenBefore(query, open);
    const negated = before.text === '-' || before.text === `-${IN_PREFIX}`;
    const isFolder = before.text === IN_PREFIX || before.text === `-${IN_PREFIX}`;
    // Anything else before the quote (`foo-`, `bar`) stays as ordinary text.
    const cut = negated || isFolder ? before.start : open;

    out.rest += query.slice(i, cut) + ' ';

    const body = normalisePhrase(query.slice(open + 1, close));
    // `""` carries no constraint; dropping it keeps the positive-set rule honest.
    if (body) {
      if (isFolder) (negated ? out.notFolders : out.folders).push(body);
      else (negated ? out.notPhrases : out.phrases).push(body);
    }

    i = close + 1;
  }

  out.rest += query.slice(i);
  return out;
}

/**
 * Read a query into its operators. Everything is lowercased: the index is
 * case-insensitive throughout, and so are tags and folder paths.
 */
export function parseQuery(query: string): ParsedQuery {
  const out = empty();

  const { rest, phrases, notPhrases, folders, notFolders } = liftPhrases(query);
  out.phrases = phrases;
  out.notPhrases = notPhrases;
  out.folders = folders;
  out.notFolders = notFolders;

  for (const raw of rest.toLowerCase().split(/\s+/)) {
    if (!raw) continue;

    const negated = raw.length > 1 && raw.startsWith('-');
    const word = negated ? raw.slice(1) : raw;

    if (word.length > 1 && word.startsWith('#')) {
      (negated ? out.notTags : out.tags).push(word.slice(1));
      continue;
    }

    if (word.startsWith(IN_PREFIX)) {
      const path = word.slice(IN_PREFIX.length);
      // A bare `in:` is someone mid-type; it constrains nothing.
      if (path) (negated ? out.notFolders : out.folders).push(path);
      continue;
    }

    for (const term of word.split(SPLIT)) {
      if (term) (negated ? out.notTerms : out.terms).push(term);
    }
  }

  return out;
}

/**
 * True when the query names nothing to match, only things to reject.
 *
 * `-draft` on its own has no answer that is not "every note you own", which is
 * not what anyone means by it, and the empty query already returns nothing
 * (`SearchIndex.search`). `in:Work -draft` is fine, because `in:` is a positive
 * set: a folder scope, a tag and a word are all things that select.
 */
export function hasPositiveTerm(parsed: ParsedQuery): boolean {
  return (
    parsed.terms.length > 0 ||
    parsed.tags.length > 0 ||
    parsed.folders.length > 0 ||
    parsed.phrases.length > 0
  );
}
