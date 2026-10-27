/**
 * Main-thread client for the search worker.
 *
 * Queries are correlated by sequence number so an older, slower reply can never
 * overwrite a newer one — the classic search-as-you-type flicker where results
 * briefly show matches for a prefix the user has already moved past.
 *
 * If the worker cannot start (an old browser, a blocked worker URL), search
 * degrades to a synchronous in-memory title scan rather than disappearing.
 */
import type { IndexDocument, SearchHit, TagCount } from '../../core/search/index.ts';
import type { SearchRequest, SearchResponse } from '../../core/search/protocol.ts';
import { hasPositiveTerm, parseQuery, type ParsedQuery } from '../../core/search/query.ts';
import type { NoteMeta } from '../../core/notes/model.ts';
import { foldersMatching, subtreeIds, type Folder } from '../../core/notes/folders.ts';
import { vaultStore } from './vault.svelte.ts';

/** What `in:/` means: the top level, where a note has no folder id to name. */
const UNFILED_PATH = '/';

export interface SearchStats {
  documents: number;
  tokens: number;
  buildMs: number;
}

export class SearchClient {
  #worker: Worker | undefined;
  #seq = 0;
  #pending = new Map<number, (hits: SearchHit[]) => void>();

  ready = $state(false);
  stats = $state<SearchStats | null>(null);
  /** Set when the worker could not be used; search falls back to titles. */
  degraded = $state(false);
  /**
   * Every inline `#tag` and its count, once the index is built. Empty until
   * then, and for good when degraded: tags are read from note bodies, which
   * only the worker reads.
   */
  tags = $state.raw<readonly TagCount[]>([]);
  /** Moves whenever `tags` does, so a tag filter knows to fetch its ids again. */
  tagVersion = $state(0);
  #tagSeq = 0;
  #pendingTagIds = new Map<number, (ids: string[]) => void>();

  start(): void {
    if (this.#worker) return;

    try {
      this.#worker = new Worker(new URL('../../core/search/worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      this.degraded = true;
      return;
    }

    this.#worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      const message = event.data;
      if (message.type === 'ready') {
        this.ready = true;
        this.stats = {
          documents: message.documents,
          tokens: message.tokens,
          buildMs: message.buildMs,
        };
      } else if (message.type === 'tags') {
        this.tags = message.tags;
        this.tagVersion = message.version;
      } else if (message.type === 'tagIds') {
        this.#pendingTagIds.get(message.seq)?.(message.ids);
        this.#pendingTagIds.delete(message.seq);
      } else if (message.type === 'results') {
        this.#pending.get(message.seq)?.(message.hits);
        this.#pending.delete(message.seq);
      } else if (message.type === 'error') {
        this.degraded = true;
      }
    };

    this.#worker.onerror = () => {
      this.degraded = true;
      this.ready = false;
    };

    this.#post({ type: 'build', key: vaultStore.key() });
  }

  #post(message: SearchRequest): void {
    this.#worker?.postMessage(message);
  }

  /** Reindex a single note. Cheap: the worker re-tokenizes just this one. */
  upsert(doc: IndexDocument & { folderId: string | null }): void {
    this.#post({ type: 'upsert', doc });
  }

  /**
   * A note changed folder and nothing else.
   *
   * Deliberately not an `upsert`: the caller (`Workspace.#writeMeta`) has no
   * body to hand, and an upsert with an empty one would erase the note's words
   * from the index. `SearchIndex.setFolder` has the full reasoning.
   */
  setFolder(id: string, folderId: string | null): void {
    this.#post({ type: 'setFolder', id, folderId });
  }

  remove(id: string): void {
    this.#post({ type: 'remove', id });
  }

  /** Rebuild from IndexedDB — used after a bulk import or a sync landing. */
  rebuild(): void {
    this.#post({ type: 'build', key: vaultStore.key() });
  }

  /**
   * Run a query. `fallback` is the current metadata list, used for the
   * degraded title-only path so the finder still works without a worker.
   *
   * Parsing happens here rather than in the worker because `in:` names a folder
   * by name, and folder names are sealed — this side holds the only decrypted
   * copy. Having parsed in order to resolve, it sends the parse too, so the two
   * sides cannot end up disagreeing about what was typed.
   */
  query(
    text: string,
    fallback: readonly NoteMeta[],
    folders: readonly Folder[] = [],
    limit = 50,
  ): Promise<SearchHit[]> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve([]);

    const parsed = parseQuery(trimmed);
    if (!hasPositiveTerm(parsed)) return Promise.resolve([]);

    const folderIds = resolveScope(folders, parsed.folders);
    const notFolderIds = resolveScope(folders, parsed.notFolders);

    if (!this.#worker || this.degraded || !this.ready) {
      return Promise.resolve(titleOnlySearch(parsed, fallback, folderIds, notFolderIds, limit));
    }

    const seq = ++this.#seq;
    return new Promise((resolve) => {
      this.#pending.set(seq, resolve);
      this.#post({ type: 'query', seq, parsed, folderIds, notFolderIds, limit });

      // Never leave the finder hanging on a worker that stopped answering.
      setTimeout(() => {
        if (this.#pending.delete(seq)) {
          resolve(titleOnlySearch(parsed, fallback, folderIds, notFolderIds, limit));
        }
      }, 1000);
    });
  }

  /**
   * Notes tagged `tag` or anything nested under it, newest first. Empty when
   * there is no index to ask.
   */
  tagIds(tag: string): Promise<string[]> {
    if (!this.#worker || this.degraded) return Promise.resolve([]);
    const seq = ++this.#tagSeq;
    return new Promise((resolve) => {
      this.#pendingTagIds.set(seq, resolve);
      this.#post({ type: 'tagIds', seq, tag });
      setTimeout(() => {
        if (this.#pendingTagIds.delete(seq)) resolve([]);
      }, 1000);
    });
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#pending.clear();
    this.#pendingTagIds.clear();
    this.ready = false;
    this.tags = [];
  }
}

/**
 * Turn the `in:` values of a query into folder ids, recursively.
 *
 * `undefined` means "no scope asked for" and an *empty set* means "a scope was
 * asked for and matched nothing" — those must stay distinct, or a typo in a
 * folder name would silently search everywhere instead of finding nothing.
 *
 * Matching is by prefix, so `in:wo` narrows towards `Work` while it is being
 * typed, the way `#wo` already narrows towards `#work`. `foldersMatching` is
 * shared with the CLI so the two clients cannot disagree about which folder a
 * name meant.
 */
function resolveScope(
  folders: readonly Folder[],
  paths: readonly string[],
): (string | null)[] | undefined {
  if (paths.length === 0) return undefined;

  const out = new Set<string | null>();
  for (const path of paths) {
    if (path === UNFILED_PATH) {
      out.add(null);
      continue;
    }
    for (const id of foldersMatching(folders, path, { prefix: true })) {
      // A scope is the folder and everything under it (§12 nests to any depth).
      for (const descendant of subtreeIds(folders, id)) out.add(descendant);
    }
  }
  return [...out];
}

/**
 * Degraded search: substring match over titles the app already holds in memory.
 * Not as good as the index, but it keeps Cmd+P useful rather than broken.
 *
 * It honours what metadata can answer — words and phrases against the *title*,
 * and `in:` against `folderId` — and **cannot honour `#tag`**, because tags are
 * read out of note bodies and only the worker reads those. That gap predates
 * the other operators (a `#tag` query was previously matched as literal title
 * text here); it is written down now rather than left to be discovered. A tag
 * filter therefore constrains nothing on this path.
 */
export function titleOnlySearch(
  parsed: ParsedQuery,
  metas: readonly NoteMeta[],
  folderIds?: (string | null)[],
  notFolderIds?: (string | null)[],
  limit = 50,
): SearchHit[] {
  // Phrases are matched against the title whole; their words also have to be
  // there, which for a title substring test is the same thing.
  const terms = [...parsed.terms, ...parsed.phrases];
  if (terms.length === 0 && !folderIds) return [];

  const allowed = folderIds ? new Set(folderIds) : undefined;
  const denied = notFolderIds ? new Set(notFolderIds) : undefined;

  const hits: SearchHit[] = [];
  for (const meta of metas) {
    if (allowed && !allowed.has(meta.folderId)) continue;
    if (denied?.has(meta.folderId)) continue;

    const title = meta.title.toLowerCase();
    if (!terms.every((term) => title.includes(term))) continue;
    if (parsed.notTerms.some((term) => title.includes(term))) continue;
    if (parsed.notPhrases.some((phrase) => title.includes(phrase))) continue;

    // Earlier matches rank higher, mirroring the index's preference for
    // tokens that start with the term.
    const position = terms.length > 0 ? title.indexOf(terms[0]!) : 0;
    hits.push({ id: meta.id, score: 10 - Math.min(9, position), inTitle: true });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
