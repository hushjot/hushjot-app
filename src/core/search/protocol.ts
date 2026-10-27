/**
 * Message protocol between the app and the search worker.
 *
 * Note content crosses this boundary in exactly one direction: never back.
 * Results are note ids and scores, which the caller resolves against metadata
 * it already holds. Keeping snippets out of the protocol means the index — and
 * this channel — cannot be used to reconstruct a note.
 *
 * A phrase query does not change that. Confirming `"connection pool"` needs the
 * text, so the worker re-reads and decrypts a bounded number of candidate
 * bodies from its own IndexedDB connection and discards each one — the same
 * thing a build already does. What comes back is still only ids and scores.
 *
 * One stated exception: tag names (`TagsMessage`). A tag is a word the user
 * wrote into a note, and the sidebar has to show it, so the names come back —
 * as a set with counts, never tied to which note holds them or where. That
 * list reconstructs no text, lives only in page memory, and is never stored or
 * sent; it is the same exposure as the titles the page already holds.
 */
import type { IndexDocument, SearchHit, TagCount } from './index.ts';
import type { ParsedQuery } from './query.ts';

export interface BuildRequest {
  type: 'build';
  /** Phase 3 passes the non-extractable CryptoKey here; CryptoKey clones. */
  key?: CryptoKey;
}

export interface UpsertRequest {
  type: 'upsert';
  /**
   * `folderId` is **required** here though `IndexDocument` makes it optional.
   * That asymmetry is the point: the published type has to tolerate a second
   * client that predates the field, while inside the app the compiler should
   * name every write path that has to carry one. It is the same split
   * `createdAt` uses, for the same reason — a field silently omitted by one
   * writer is a note that quietly leaves its folder.
   */
  doc: IndexDocument & { folderId: string | null };
}

/**
 * A note moved folder, and nothing else about it changed.
 *
 * Not an `upsert`, deliberately. The move write (`Workspace.#writeMeta`) holds
 * no body, so an upsert from there would carry `content: ''` and — since
 * `SearchIndex.add` is remove-then-add — delete every word the note owns from
 * the index. `SearchIndex.setFolder` says why this is its own verb.
 */
export interface SetFolderRequest {
  type: 'setFolder';
  id: string;
  folderId: string | null;
}

export interface RemoveRequest {
  type: 'remove';
  id: string;
}

export interface QueryRequest {
  type: 'query';
  /** Correlates the answer, so a stale reply can be discarded. */
  seq: number;
  /**
   * Parsed on the page, not here. `in:` names a folder by its *name*, and names
   * are sealed — only the page holds the decrypted folder list — so the page
   * has to parse in order to resolve. Sending the result rather than the string
   * means there is one parse per query instead of two that could disagree.
   */
  parsed: ParsedQuery;
  /**
   * `in:` resolved to folder ids; `null` is a member meaning unfiled.
   * `undefined` is "no scope asked for"; an empty array is "asked for and
   * matched nothing", and the two must not collapse — a mistyped folder name
   * has to find nothing rather than quietly search everywhere.
   */
  folderIds?: (string | null)[] | undefined;
  notFolderIds?: (string | null)[] | undefined;
  limit?: number;
}

/** Ids of the notes carrying a tag or a tag nested under it. */
export interface TagIdsRequest {
  type: 'tagIds';
  seq: number;
  tag: string;
}

export type SearchRequest =
  | BuildRequest
  | UpsertRequest
  | RemoveRequest
  | SetFolderRequest
  | QueryRequest
  | TagIdsRequest;

export interface ReadyMessage {
  type: 'ready';
  documents: number;
  tokens: number;
  buildMs: number;
}

export interface ResultsMessage {
  type: 'results';
  seq: number;
  hits: SearchHit[];
}

/**
 * Every tag and its count. Sent once a build completes — never partway, or
 * the sidebar would count up in front of the user — and after an edit only
 * when the tags actually changed, coalesced.
 */
export interface TagsMessage {
  type: 'tags';
  /** Increases with every change, so a stale filter knows to ask again. */
  version: number;
  tags: TagCount[];
}

export interface TagIdsMessage {
  type: 'tagIds';
  seq: number;
  ids: string[];
}

export interface ErrorMessage {
  type: 'error';
  /** Deliberately generic: never echo note content into an error (§29). */
  message: string;
}

export type SearchResponse = ReadyMessage | ResultsMessage | TagsMessage | TagIdsMessage | ErrorMessage;
