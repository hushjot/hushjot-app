/**
 * The note model (spec §9). Deliberately minimal — no schema is added here
 * until something in the product actually needs it.
 *
 * Framework-free and DOM-free by design: everything in `src/core/` must be
 * unit-testable without a browser or a component runtime.
 */

export interface Note {
  id: string;
  /**
   * Derived from the first meaningful line of `content`, not a separate field
   * the user edits. See `deriveTitle`.
   *
   * It is stored rather than recomputed because the encrypted *meta* record
   * carries it (Phase 0, layout C): the note list must render from titles alone
   * without reading or decrypting a single note body.
   */
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic per note. The authority for sync ordering — never the clock. */
  revision: number;
  folderId: string | null;
  /** When the note was pinned, or null. See `orderForList`. */
  pinnedAt: number | null;
}

/** What the note list and quick finder need. Mirrors the encrypted meta record. */
export interface NoteMeta {
  id: string;
  title: string;
  folderId: string | null;
  pinnedAt: number | null;
  updatedAt: number;
  /**
   * When the note was created, for the "Date created" sort.
   *
   * Required here although it is *optional* in the sealed record
   * (`NoteMetaPayload`): every note written before the field existed has none,
   * and `loadAllMeta` is the single place that resolves that, falling back to
   * the row's own `updatedAt`. Making it required above that line is what
   * makes the compiler name every literal that has to carry it — the excerpt
   * below was optional, and a write path that quietly dropped it is exactly
   * the bug its own comment now warns about.
   */
  createdAt: number;
  /**
   * The opening of the body, for the second line of a phone note row.
   *
   * It lives in the sealed *meta* record rather than being read from the body,
   * and that is the whole point: bodies are a separate store that
   * `loadAllMeta` deliberately never touches (41 ms against 10,000 body
   * decrypts, Spike 3), so a snippet fetched per row would put a decrypt — and
   * a write-scheduler flush, via `bodyOf` — on the list-render path.
   *
   * Absent on every record written before excerpts existed, exactly as
   * `pinnedAt` is. A row without one clamps its title to two lines instead,
   * which is the same height, so an old note looks deliberate rather than
   * broken.
   */
  excerpt?: string;
}

export const UNTITLED = 'Untitled';

/** Longer titles are truncated: the list truncates visually anyway. */
const MAX_TITLE = 120;

/** Lines built purely from Markdown structural characters. */
const STRUCTURAL_ONLY = /^[-*_=|#>~\s]+$/;

/** How much of the body an excerpt keeps. Two lines of a phone row, roughly. */
const MAX_EXCERPT = 100;

/**
 * Strip the Markdown marks from one line, or return '' if it carries no text.
 *
 * Shared by `deriveTitle` and `excerptOf` so the two can never disagree about
 * where the title ends and the body begins — the excerpt is defined as "the
 * text after the line the title came from", which only holds if both read a
 * line the same way.
 */
function cleanLine(raw: string): string {
  const line = raw.trim();
  if (!line) return '';

  const cleaned = line
    // Heading marks, with the space optional so a bare "###" reduces to "".
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, '') // bullet / task item
    .replace(/^\d+[.)]\s+/, '') // ordered item
    .replace(/^>\s?/, '') // blockquote
    .trim();

  // A line made only of structural characters carries no text: thematic
  // breaks (---, ***, ___), setext underlines (===) and table delimiter
  // rows (| --- | --- |) all land here. Anything else — including a line
  // that is just an emoji — is accepted.
  if (!cleaned || STRUCTURAL_ONLY.test(cleaned)) return '';
  return cleaned;
}

/**
 * Take the title from the first line with content, stripping Markdown heading
 * marks and common list/quote prefixes.
 *
 * The alternative — a separate title input — means two fields that can
 * disagree, two things to sync, and two things to conflict-resolve. Deriving it
 * keeps the note exactly what §10 says it is: plain Markdown text.
 */
export function deriveTitle(content: string): string {
  // Only scan the head of the document; a title is never 2000 lines down.
  const head = content.length > 4096 ? content.slice(0, 4096) : content;

  for (const raw of head.split('\n')) {
    const cleaned = cleanLine(raw);
    if (cleaned) return cleaned.slice(0, MAX_TITLE);
  }

  return UNTITLED;
}

/**
 * The text after the title line, flattened to a single line and capped at
 * `MAX_EXCERPT`.
 *
 * Derived rather than stored as a second user-editable field, for the same
 * reason the title is (see `deriveTitle`): two fields that can disagree are
 * two things to sync and two things to conflict-resolve. Fence markers are
 * skipped because "```sql" is punctuation, not prose.
 */
export function excerptOf(content: string): string {
  const head = content.length > 4096 ? content.slice(0, 4096) : content;

  let seenTitle = false;
  let out = '';

  for (const raw of head.split('\n')) {
    if (raw.trimStart().startsWith('```')) continue;
    const cleaned = cleanLine(raw);
    if (!cleaned) continue;
    // The first line with text is the title; the excerpt starts after it.
    if (!seenTitle) {
      seenTitle = true;
      continue;
    }
    out = out ? `${out} ${cleaned}` : cleaned;
    if (out.length >= MAX_EXCERPT) break;
  }

  return out.slice(0, MAX_EXCERPT).trim();
}

export interface CreateNoteOptions {
  content?: string;
  folderId?: string | null;
  now?: number;
  id?: string;
}

export function createNote(options: CreateNoteOptions = {}): Note {
  const {
    content = '',
    folderId = null,
    now = Date.now(),
    id = crypto.randomUUID(),
  } = options;

  return {
    id,
    title: deriveTitle(content),
    content,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    folderId,
    pinnedAt: null,
  };
}

/**
 * Apply an edit, returning a new note. Bumps `revision` and re-derives the
 * title. Returns the *same object* when the content has not changed, so callers
 * can cheaply skip no-op writes.
 */
export function withContent(note: Note, content: string, now = Date.now()): Note {
  if (note.content === content) return note;
  return {
    ...note,
    content,
    title: deriveTitle(content),
    updatedAt: now,
    revision: note.revision + 1,
  };
}

export function withFolder(note: Note, folderId: string | null, now = Date.now()): Note {
  if (note.folderId === folderId) return note;
  return { ...note, folderId, updatedAt: now, revision: note.revision + 1 };
}

/**
 * Pin or unpin. Bumps `updatedAt` as well as the revision, like a move does,
 * and that is load-bearing rather than cosmetic: the sync engine recognises
 * its own acknowledged write by revision *and* `updatedAt`, so two devices that
 * toggled the same note without touching a timestamp would each take the
 * other's write for their own.
 */
export function withPinned(note: Note, pinned: boolean, now = Date.now()): Note {
  if ((note.pinnedAt !== null) === pinned) return note;
  return { ...note, pinnedAt: pinned ? now : null, updatedAt: now, revision: note.revision + 1 };
}

export function toMeta(note: Note): NoteMeta {
  return {
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    pinnedAt: note.pinnedAt,
    updatedAt: note.updatedAt,
    createdAt: note.createdAt,
    excerpt: excerptOf(note.content),
  };
}

/** Which key a note list is ordered by. */
export type NoteSortKey = 'edited' | 'created' | 'title';

/**
 * How a note list is ordered. A display preference, not data: it lives in
 * `localStorage` per device (`ui/state/noteSort.svelte.ts`), never in the
 * vault, for the same reason the theme and the text size do.
 */
export interface NoteSort {
  key: NoteSortKey;
  reversed: boolean;
}

/** What the list did before there was a choice, and what a new device gets. */
export const DEFAULT_NOTE_SORT: NoteSort = { key: 'edited', reversed: false };

/**
 * Whether `sort` is the order the product shipped with.
 *
 * `orderForList` takes a separate, older path for it — see the comment there.
 */
export function isDefaultSort(sort: NoteSort): boolean {
  return sort.key === 'edited' && !sort.reversed;
}

/**
 * Titles collate rather than compare by code unit, so "apple" and "Apple" sit
 * together and "note 2" comes before "note 10". The same options
 * `core/search/index.ts` gives its tag order — two orders a user sees side by
 * side in the sidebar should not disagree about what alphabetical means.
 *
 * `Intl` rather than a dependency: §28, and `ui/format.ts` makes the same call.
 */
const TITLE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The fields any sort key needs. `NoteMeta` satisfies it; so does a `Note`. */
export interface SortableNote {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The comparator for one sort.
 *
 * Every key falls through to a total order — recency, then id — so two notes
 * that tie on the visible key hold the same relative position on every render
 * and on every device. `Array.prototype.sort` is stable, but the arrays reaching
 * it here are not: `filterForList` rebuilds them from a store that is itself
 * re-sorted on every save, so "stable" would only mean "stable for a moment".
 */
export function comparatorFor(sort: NoteSort): (a: SortableNote, b: SortableNote) => number {
  const base =
    sort.key === 'title'
      ? (a: SortableNote, b: SortableNote) =>
          TITLE_ORDER.compare(a.title, b.title) || b.updatedAt - a.updatedAt || byId(a, b)
      : sort.key === 'created'
        ? (a: SortableNote, b: SortableNote) =>
            b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || byId(a, b)
        : (a: SortableNote, b: SortableNote) => b.updatedAt - a.updatedAt || byId(a, b);

  return sort.reversed ? (a, b) => -base(a, b) : base;
}

/** Most recently updated first — the ordering the sidebar and finder use. */
export function byRecency(a: { updatedAt: number }, b: { updatedAt: number }): number {
  return b.updatedAt - a.updatedAt;
}

/**
 * Note ids whose derived title is `wanted` — what a `[[Note link]]` resolves to
 * (`core/notes/links.ts` says why a link is a resolution and not a pointer).
 *
 * Three decisions, and each is a reuse rather than an invention:
 *
 * - **Ambiguity is returned, not resolved**, exactly as `foldersMatching` does
 *   it in `folders.ts`, and for the same reason: titles are not unique, and a
 *   CLI would want to stop and ask where a click wants to open something. The
 *   caller decides; `App.svelte` takes the first.
 * - **`TITLE_ORDER` is the equality test**, not `===` or `toLowerCase()`. It is
 *   already the collator the title sort uses (`sensitivity: 'base'`), so
 *   `[[cafe]]` finds "Café" and the link cannot disagree with the sidebar about
 *   what the same title is.
 * - **Input order is the answer's order.** `Workspace.metas` is kept in recency
 *   order, so `[0]` is the most recently edited match with nothing sorted here
 *   and no tie-break to invent.
 *
 * There is deliberately no prefix or substring mode. `foldersMatching` explains
 * why prefix is not a default, and it is stronger here: a link is an exact
 * reference to a title or it is a miss the user should be told about.
 */
export function notesMatching(metas: readonly NoteMeta[], wanted: string): string[] {
  const out: string[] = [];
  for (const meta of metas) {
    if (TITLE_ORDER.compare(meta.title, wanted) === 0) out.push(meta.id);
  }
  return out;
}

/**
 * The order a note list shows: pinned notes first, then everything else.
 *
 * Pins lead under every sort, because the point of pinning is knowing where a
 * note is without looking, and a pin that sank into an alphabetical list would
 * not do that job. Within the pins the active key applies — under a title sort
 * the pins are alphabetical too — with one exception, which is the default.
 *
 * **The default order is the original code, unchanged.** Under `edited`,
 * unreversed, pins sort by *when they were pinned* rather than by recency, so
 * the top of the list holds still while a pinned note is being edited; and the
 * rest keep the caller's order, which `Workspace` already guarantees is
 * recency. That lets the common case return `metas` itself when nothing is
 * pinned, so a derived list costs one scan and no new array for anything to
 * react to. Every other sort has to build a list regardless, so it does the
 * ordering here rather than relying on what the caller happened to hand over.
 *
 * Hence two signatures, because the two paths genuinely need different things:
 * the default reads `pinnedAt` and nothing else, so a caller that wants it
 * should not have to supply a title and a created date it will never look at.
 * `@hushjot/cli` is that caller.
 */
export function orderForList<T extends { pinnedAt: number | null }>(metas: readonly T[]): readonly T[];
export function orderForList<T extends SortableNote & { pinnedAt: number | null }>(
  metas: readonly T[],
  sort: NoteSort,
): readonly T[];
export function orderForList<T extends SortableNote & { pinnedAt: number | null }>(
  metas: readonly T[],
  sort: NoteSort = DEFAULT_NOTE_SORT,
): readonly T[] {
  if (isDefaultSort(sort)) {
    let pinned: T[] | undefined;
    for (const meta of metas) {
      if (meta.pinnedAt !== null) (pinned ??= []).push(meta);
    }
    if (!pinned) return metas;
    if (pinned.length === metas.length) return pinned.sort(byPinnedAt);

    pinned.sort(byPinnedAt);
    for (const meta of metas) if (meta.pinnedAt === null) pinned.push(meta);
    return pinned;
  }

  const compare = comparatorFor(sort);
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const meta of metas) (meta.pinnedAt !== null ? pinned : rest).push(meta);
  if (pinned.length === 0) return rest.sort(compare);
  pinned.sort(compare);
  rest.sort(compare);
  return pinned.concat(rest);
}

/** What the list is narrowed to: a tag wins over a folder, as in the sidebar. */
export interface ListFilter {
  activeTag: string | null;
  /** Notes carrying `activeTag`, as the search index last reported. */
  tagNoteIds: ReadonlySet<string> | null;
  activeFolderId: string | null;
  /**
   * The user's chosen order, defaulting to what the list did before there was
   * a choice.
   *
   * It rides in the filter object rather than as a second argument on purpose:
   * there are exactly two callers, the sidebar and the phone, and this is the
   * shape in which forgetting one is a type error at the call site rather than
   * two surfaces quietly showing the same notes in different orders.
   */
  sort?: NoteSort;
}

/**
 * The notes a list shows, in the order it shows them.
 *
 * Shared by the desktop sidebar and the phone list. It lives here rather than
 * in either of them because two copies of this rule would drift, and the
 * drift would be silent: both surfaces would simply show different notes for
 * the same filter.
 */
export function filterForList(
  notes: readonly NoteMeta[],
  { activeTag, tagNoteIds, activeFolderId, sort = DEFAULT_NOTE_SORT }: ListFilter,
): readonly NoteMeta[] {
  return orderForList(
    activeTag !== null
      ? notes.filter((n) => tagNoteIds?.has(n.id))
      : activeFolderId === null
        ? notes
        : notes.filter((n) => n.folderId === activeFolderId),
    sort,
  );
}

/** How many leading entries of an `orderForList` result are pinned. */
export function pinnedCount(ordered: readonly { pinnedAt: number | null }[]): number {
  let n = 0;
  while (n < ordered.length && ordered[n]!.pinnedAt !== null) n++;
  return n;
}

function byPinnedAt(a: { pinnedAt: number | null }, b: { pinnedAt: number | null }): number {
  return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
}

/** The last tiebreak, so an order is total and not merely nearly so. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
