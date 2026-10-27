/**
 * The local search index (§11).
 *
 * Search must be local because the contents are end-to-end encrypted, and §11
 * asks for the simplest extremely fast implementation rather than a heavyweight
 * engine. This is an inverted token index with prefix buckets — a few hundred
 * lines short of a search library, and Spike 3 measured queries at 0.6 ms
 * across 40,016 tokens.
 *
 * ## Why buckets
 *
 * A prefix query has to find every token starting with the term. Scanning the
 * whole token map costs 0.6 ms at 40k tokens and would reach ~7 ms at 500k.
 * Bucketing tokens by their first two characters means a query of two or more
 * characters touches one bucket instead of all of them, which keeps the cost
 * flat as a collection grows. A one-character query still scans everything, and
 * at that point the result set is meaningless anyway.
 *
 * ## What never leaves this module
 *
 * The index holds tokens, not text. Nothing here can reconstruct a note, and
 * queries return note ids and scores — never content. The caller already has
 * the titles it needs to render results.
 *
 * ## Tags
 *
 * Inline `#tags` (`core/notes/tags.ts`) are derived here, as each note is
 * indexed, because this is the one place that already reads every body. They
 * cost no storage, no schema and no sync: a tag is text in the note, so it
 * arrives wherever the text does. Tag *names* are the one thing that leaves
 * this module — the sidebar lists them — and only as far as the page.
 *
 * In a query, `#term` is a filter rather than a word: it keeps notes carrying
 * a tag that starts with `term`, so `#wo` narrows as it is typed and `#work`
 * also finds `#work/clients`. Tokenizing strips the `#`, so a plain `work`
 * still finds a note tagged `#work` by its text.
 */
import { extractTags, tagMatches } from '../notes/tags.ts';
import { hasPositiveTerm, parseQuery, type ParsedQuery } from './query.ts';

export interface SearchHit {
  id: string;
  score: number;
  /** True when the match was in the title, which the UI can indicate. */
  inTitle: boolean;
}

export interface IndexDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
  /**
   * Optional here and required in `protocol.ts`'s `UpsertRequest`, on purpose.
   * This is the published type, and `@hushjot/cli` builds documents from notes
   * it opened itself — making it required would break a second client that has
   * not caught up, for a field it can supply later. Inside the app the compiler
   * should be naming every write path instead, which is what the stricter
   * protocol type is for. Absent means unfiled, exactly as `null` does.
   */
  folderId?: string | null;
}

/** Folder scoping, resolved to ids by the caller. See `searchParsed`. */
export interface SearchOptions {
  limit?: number;
  /**
   * Notes outside these folders are dropped; undefined means no scope. `null`
   * is a member in its own right and means unfiled, which is what `in:/`
   * resolves to — a note at the top level has no folder id to name.
   */
  folderIds?: ReadonlySet<string | null> | null | undefined;
  /** Notes inside these folders are dropped. `null` means unfiled, as above. */
  notFolderIds?: ReadonlySet<string | null> | null | undefined;
}

export interface TagCount {
  key: string;
  label: string;
  count: number;
}

const TAG_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const MIN_TOKEN = 2;
const MAX_TOKEN = 40;
const BUCKET_LEN = 2;

/** Split on anything that is not a letter, digit or underscore. */
const SPLIT = /[^\p{L}\p{N}_]+/u;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(SPLIT)) {
    if (raw.length < MIN_TOKEN) continue;
    out.push(raw.length > MAX_TOKEN ? raw.slice(0, MAX_TOKEN) : raw);
  }
  return out;
}

interface DocEntry {
  updatedAt: number;
  folderId: string | null;
  tokens: Set<string>;
  titleTokens: Set<string>;
  /** Tag keys, in the order written. Usually empty. */
  tags: readonly string[];
}

export class SearchIndex {
  /** token -> note ids containing it anywhere. */
  #postings = new Map<string, Set<string>>();
  /** token -> note ids whose *title* contains it. */
  #titlePostings = new Map<string, Set<string>>();
  /** first two characters -> tokens starting with them. */
  #buckets = new Map<string, Set<string>>();
  #docs = new Map<string, DocEntry>();
  /** tag key -> note ids carrying it. */
  #tagPostings = new Map<string, Set<string>>();
  /** tag key -> how it is displayed: the spelling of whichever note added it first. */
  #tagLabels = new Map<string, string>();
  #tagVersion = 0;

  get size(): number {
    return this.#docs.size;
  }

  get tokenCount(): number {
    return this.#postings.size;
  }

  /**
   * Bumped whenever the set of tags or any count changes, so the worker can
   * tell the page only when there is something new to show. An edit that
   * leaves a note's tags alone — nearly every edit — does not move it.
   */
  get tagVersion(): number {
    return this.#tagVersion;
  }

  #addToken(token: string, id: string, map: Map<string, Set<string>>): void {
    let posting = map.get(token);
    if (!posting) map.set(token, (posting = new Set()));
    posting.add(id);

    if (map === this.#postings) {
      const key = token.slice(0, BUCKET_LEN);
      let bucket = this.#buckets.get(key);
      if (!bucket) this.#buckets.set(key, (bucket = new Set()));
      bucket.add(token);
    }
  }

  #removeToken(token: string, id: string, map: Map<string, Set<string>>): void {
    const posting = map.get(token);
    if (!posting) return;
    posting.delete(id);
    if (posting.size > 0) return;

    map.delete(token);
    if (map === this.#postings) {
      const key = token.slice(0, BUCKET_LEN);
      const bucket = this.#buckets.get(key);
      bucket?.delete(token);
      if (bucket && bucket.size === 0) this.#buckets.delete(key);
    }
  }

  add(doc: IndexDocument): void {
    const tagged = extractTags(doc.content);
    const tags = tagged.map((t) => t.key);
    const before = this.#docs.get(doc.id)?.tags;
    const sameTags = before !== undefined && before.length === tags.length && before.every((t, i) => t === tags[i]);

    // Replacing is remove-then-add, so an edited note never keeps postings for
    // words the user deleted.
    this.remove(doc.id, sameTags);

    const titleTokens = new Set(tokenize(doc.title));
    const tokens = new Set(tokenize(doc.content));
    for (const t of titleTokens) tokens.add(t);

    for (const token of tokens) this.#addToken(token, doc.id, this.#postings);
    for (const token of titleTokens) this.#addToken(token, doc.id, this.#titlePostings);

    for (const { key, label } of tagged) {
      let posting = this.#tagPostings.get(key);
      if (!posting) {
        this.#tagPostings.set(key, (posting = new Set()));
        this.#tagLabels.set(key, label);
      }
      posting.add(doc.id);
    }
    if (!sameTags && (tags.length > 0 || (before?.length ?? 0) > 0)) this.#tagVersion++;

    this.#docs.set(doc.id, {
      updatedAt: doc.updatedAt,
      folderId: doc.folderId ?? null,
      tokens,
      titleTokens,
      tags,
    });
  }

  /** @param quiet the caller is re-adding the same tags; do not report a change. */
  remove(id: string, quiet = false): void {
    const entry = this.#docs.get(id);
    if (!entry) return;
    for (const token of entry.tokens) this.#removeToken(token, id, this.#postings);
    for (const token of entry.titleTokens) this.#removeToken(token, id, this.#titlePostings);
    for (const key of entry.tags) {
      const posting = this.#tagPostings.get(key);
      posting?.delete(id);
      if (posting && posting.size === 0) {
        this.#tagPostings.delete(key);
        this.#tagLabels.delete(key);
      }
    }
    if (entry.tags.length > 0 && !quiet) this.#tagVersion++;
    this.#docs.delete(id);
  }

  /**
   * Re-scope a note without touching its tokens.
   *
   * This exists because `Workspace.#writeMeta` — the pin-and-move write — has no
   * body in hand. Routing a move through `add()` would mean passing
   * `content: ''`, and `add()` is remove-then-add, so it would silently delete
   * every word the note owns from the index. The sealed `excerpt` field was
   * blanked by that exact shape once; this is the same trap with a different
   * field, so it gets its own verb rather than a comment asking people to
   * remember.
   *
   * A note the index has never seen is ignored: a move can only reach a note
   * that exists, and inventing an entry with no tokens would make it findable
   * by nothing while claiming a folder.
   */
  setFolder(id: string, folderId: string | null): void {
    const entry = this.#docs.get(id);
    if (entry) entry.folderId = folderId;
  }

  clear(): void {
    this.#postings.clear();
    this.#titlePostings.clear();
    this.#buckets.clear();
    this.#docs.clear();
    this.#tagPostings.clear();
    this.#tagLabels.clear();
    this.#tagVersion++;
  }

  /** Every tag with how many notes carry it, by name. */
  tagSummary(): TagCount[] {
    const out: TagCount[] = [];
    for (const [key, ids] of this.#tagPostings) {
      out.push({ key, label: this.#tagLabels.get(key) ?? key, count: ids.size });
    }
    // Natural order, so `#t2` comes before `#t10`, and a parent before its children.
    return out.sort((a, b) => TAG_ORDER.compare(a.key, b.key));
  }

  /** Notes tagged `filter` or anything nested under it, newest first. */
  idsForTag(filter: string): string[] {
    const ids = this.#idsMatchingTag(filter.toLowerCase(), false);
    return this.#byRecency(ids);
  }

  /** Ids carrying a tag equal to, nested under, or (for `prefix`) starting with `filter`. */
  #idsMatchingTag(filter: string, prefix: boolean): Set<string> {
    const out = new Set<string>();
    for (const [key, ids] of this.#tagPostings) {
      if (prefix ? key.startsWith(filter) : tagMatches(key, filter)) for (const id of ids) out.add(id);
    }
    return out;
  }

  #byRecency(ids: Iterable<string>): string[] {
    return [...ids].sort((a, b) => (this.#docs.get(b)?.updatedAt ?? 0) - (this.#docs.get(a)?.updatedAt ?? 0));
  }

  /** Every indexed token starting with `prefix`. */
  #tokensWithPrefix(prefix: string): Iterable<string> {
    if (prefix.length >= BUCKET_LEN) {
      const bucket = this.#buckets.get(prefix.slice(0, BUCKET_LEN));
      if (!bucket) return [];
      if (prefix.length === BUCKET_LEN) return bucket;
      const out: string[] = [];
      for (const token of bucket) if (token.startsWith(prefix)) out.push(token);
      return out;
    }

    // Single-character term: no bucket narrows it, so scan.
    const out: string[] = [];
    for (const token of this.#postings.keys()) {
      if (token.startsWith(prefix)) out.push(token);
    }
    return out;
  }

  /**
   * Search for `query`. Terms are ANDed: a note must match every term, which
   * is what makes typing more characters narrow the list as §11 expects.
   *
   * The string form is the published one — `@hushjot/cli` calls it — and it
   * cannot resolve `in:`, because folder names are sealed and this class only
   * ever sees ids. A caller that wants folder scoping parses with `parseQuery`,
   * resolves the paths itself and calls `searchParsed`.
   */
  search(query: string, limit = 50): SearchHit[] {
    return this.searchParsed(parseQuery(query), { limit });
  }

  /**
   * The real search, over an already-parsed query.
   *
   * Phrases are handled only as far as this class honestly can: their words are
   * ANDed in as ordinary terms, which narrows to notes that contain all of them
   * in some order. Confirming the words are *adjacent* needs the text, and the
   * index deliberately holds none — so the caller verifies, against bodies it
   * re-reads. `worker.ts` does that; the CLI has the bodies already. Both treat
   * what comes back here as candidates whenever `parsed.phrases` is non-empty.
   */
  searchParsed(parsed: ParsedQuery, options: SearchOptions = {}): SearchHit[] {
    const { limit = 50, folderIds, notFolderIds } = options;

    // Nothing to select by. `-draft` alone has no answer but "everything you
    // own", which nobody means, and the empty query already returns nothing.
    if (!hasPositiveTerm(parsed)) return [];

    // --- the filters that select whole notes, cheapest first ---------------

    let allowed: Set<string> | undefined;

    const narrow = (ids: Set<string>): boolean => {
      if (allowed) {
        for (const id of allowed) if (!ids.has(id)) allowed.delete(id);
      } else {
        allowed = ids;
      }
      return allowed.size > 0;
    };

    for (const filter of parsed.tags) {
      if (!narrow(this.#idsMatchingTag(filter, true))) return [];
    }

    if (folderIds) {
      if (!narrow(this.#idsInFolders(folderIds))) return [];
    }

    // --- exclusions --------------------------------------------------------

    const denied = new Set<string>();
    for (const filter of parsed.notTags) {
      for (const id of this.#idsMatchingTag(filter, true)) denied.add(id);
    }
    if (notFolderIds) {
      for (const id of this.#idsInFolders(notFolderIds)) denied.add(id);
    }
    for (const term of parsed.notTerms) {
      for (const token of this.#tokensWithPrefix(term)) {
        for (const id of this.#postings.get(token) ?? []) denied.add(id);
      }
    }

    const keep = (id: string): boolean =>
      !denied.has(id) && (allowed === undefined || allowed.has(id));

    // --- the words ---------------------------------------------------------

    // A phrase's words have to match before adjacency is worth checking, so
    // they score exactly like typed words. `notPhrases` contribute nothing
    // here: excluding "connection pool" must not exclude either word.
    const terms = [...parsed.terms];
    for (const phrase of parsed.phrases) {
      for (const word of phrase.split(SPLIT)) if (word) terms.push(word);
    }

    if (terms.length === 0) {
      // Tag- or folder-only. Recency, as the tag-only path has always done.
      const ids = this.#byRecency([...(allowed ?? [])].filter(keep));
      return (ids.length > limit ? ids.slice(0, limit) : ids).map((id) => ({
        id,
        score: 1,
        inTitle: false,
      }));
    }

    // id -> per-term scoring accumulators
    let candidates: Map<string, { score: number; inTitle: boolean }> | null = null;

    for (const term of terms) {
      const matched = new Map<string, { score: number; inTitle: boolean }>();

      for (const token of this.#tokensWithPrefix(term)) {
        // An exact token match is worth more than a longer token that merely
        // starts with the term, and short tokens rank above long ones.
        const closeness = term.length / token.length;
        const inTitleIds = this.#titlePostings.get(token);

        for (const id of this.#postings.get(token) ?? []) {
          if (!keep(id)) continue;
          const inTitle = inTitleIds?.has(id) ?? false;
          // Title matches dominate: a note called "postgres" should beat one
          // that merely mentions postgres in passing.
          const score = closeness * (inTitle ? 10 : 1);
          const existing = matched.get(id);
          if (!existing || score > existing.score) {
            matched.set(id, { score, inTitle: inTitle || (existing?.inTitle ?? false) });
          } else if (inTitle && !existing.inTitle) {
            existing.inTitle = true;
          }
        }
      }

      if (candidates === null) {
        candidates = matched;
      } else {
        // Intersect: drop anything that failed to match this term.
        for (const id of candidates.keys()) {
          const hit = matched.get(id);
          if (!hit) candidates.delete(id);
          else {
            const acc = candidates.get(id)!;
            acc.score += hit.score;
            acc.inTitle = acc.inTitle || hit.inTitle;
          }
        }
      }

      if (candidates.size === 0) return [];
    }

    const hits: SearchHit[] = [];
    for (const [id, acc] of candidates!) {
      hits.push({ id, score: acc.score, inTitle: acc.inTitle });
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Recency breaks ties: the note you touched last is usually the one you
      // are looking for.
      const au = this.#docs.get(a.id)?.updatedAt ?? 0;
      const bu = this.#docs.get(b.id)?.updatedAt ?? 0;
      return bu - au;
    });

    return hits.length > limit ? hits.slice(0, limit) : hits;
  }

  /** Ids of notes filed in any of `folderIds`; `null` there means unfiled. */
  #idsInFolders(folderIds: ReadonlySet<string | null>): Set<string> {
    const out = new Set<string>();
    for (const [id, entry] of this.#docs) {
      if (folderIds.has(entry.folderId)) out.add(id);
    }
    return out;
  }
}
