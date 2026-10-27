/**
 * How the note list is ordered: the parsing, the labels, and nothing reactive.
 *
 * Split from `state/noteSort.svelte.ts` the way `theme.ts` and `textSize.ts`
 * are split from their stores — everything here is a pure function of a string,
 * so it is unit-testable without a component runtime, and the store above it is
 * left as the four lines of `$state` it should be.
 *
 * The ordering *rule* is not here: it is `comparatorFor` in
 * `core/notes/model.ts`, with the rest of the list logic, where the sidebar and
 * the phone both read it and neither can drift from the other. This file only
 * decides what the choice is called and how it is spelled in storage.
 */
import { DEFAULT_NOTE_SORT, type NoteSort, type NoteSortKey } from '../core/notes/model.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
export const NOTE_SORT_KEY = 'teksto:note-sort';

/** Menu order, which is also frequency order: most people want the default. */
export const NOTE_SORT_KEYS: readonly NoteSortKey[] = ['edited', 'created', 'title'];

export const SORT_LABELS: Readonly<Record<NoteSortKey, string>> = {
  edited: 'Date edited',
  created: 'Date created',
  title: 'Title',
};

/**
 * The sidebar's heading for the unfiltered list.
 *
 * It said "Recent" before there was a choice, which was already naming the
 * sort. Going quiet — heading it "Notes" whatever the order — would lose that,
 * so it keeps doing the job and names whichever order is on.
 */
export const SORT_HEADINGS: Readonly<Record<NoteSortKey, string>> = {
  edited: 'Recent',
  created: 'By date created',
  title: 'By title',
};

/**
 * The direction, spelled out. A date reads "newest first" and a title "A to Z",
 * so the menu says which, rather than leaving the reader to work out what
 * "reversed" did to the thing they picked.
 */
export function directionLabel(sort: NoteSort): string {
  if (sort.key === 'title') return sort.reversed ? 'Z to A' : 'A to Z';
  return sort.reversed ? 'oldest first' : 'newest first';
}

/** Which date a note row should show: the one being sorted on. */
export function dateFieldFor(sort: NoteSort): 'updatedAt' | 'createdAt' {
  return sort.key === 'created' ? 'createdAt' : 'updatedAt';
}

export function isDefaultNoteSort(sort: NoteSort): boolean {
  return sort.key === DEFAULT_NOTE_SORT.key && sort.reversed === DEFAULT_NOTE_SORT.reversed;
}

/**
 * `"title"`, or `"-title"` reversed.
 *
 * A short string rather than JSON: there is nothing here a reader of their own
 * `localStorage` should have to parse, and a corrupted one is then obviously
 * corrupt rather than half-valid.
 */
export function serializeNoteSort(sort: NoteSort): string {
  return sort.reversed ? `-${sort.key}` : sort.key;
}

/**
 * Read a stored value, falling back rather than throwing.
 *
 * This runs during startup, before the list renders, so an unrecognised value —
 * a key removed in a later build, a half-written string, someone editing their
 * own storage — must produce a list in the wrong order rather than no list.
 */
export function parseNoteSort(raw: string | null | undefined): NoteSort {
  if (!raw) return DEFAULT_NOTE_SORT;
  const reversed = raw.startsWith('-');
  const key = reversed ? raw.slice(1) : raw;
  if (!NOTE_SORT_KEYS.includes(key as NoteSortKey)) return DEFAULT_NOTE_SORT;
  return { key: key as NoteSortKey, reversed };
}
