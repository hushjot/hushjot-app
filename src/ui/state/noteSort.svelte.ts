/**
 * The note list's order, the ⌘J z menu.
 *
 * The list shipped with one order: pinned, then most recently edited
 * (`orderForList` in `core/notes/model.ts`). That is the right default and it
 * is still the default, but it is not a defensible *only* option — Simplenote
 * and Bear both let a reader choose, and the absence is among the things a person notices in the first hour.
 *
 * A per-device preference, not data: `localStorage`, not the encrypted
 * repository, for the same reason the theme and the text size live there. Two
 * consequences, both deliberate. It does not sync, so a phone and a laptop can
 * be sorted differently — usually what someone wants, since one is for reading
 * and the other for writing. And it is nobody's data, so it can never be the
 * thing a sync conflict is about.
 *
 * Only a non-default choice is written, as with spellcheck: a device that has
 * never chosen holds no key at all, so the default can be changed later without
 * silently overriding people who had accepted the old one.
 *
 * Everything pure — parsing, labels, the storage spelling — is in
 * `ui/noteSort.ts`, where the tests can reach it.
 */
import type { NoteSort, NoteSortKey } from '../../core/notes/model.ts';
import {
  NOTE_SORT_KEY,
  dateFieldFor,
  isDefaultNoteSort,
  parseNoteSort,
  serializeNoteSort,
  SORT_HEADINGS,
} from '../noteSort.ts';

function read(): NoteSort {
  try {
    return parseNoteSort(localStorage.getItem(NOTE_SORT_KEY));
  } catch {
    // Private mode with storage blocked. Sorting still works this session; the
    // only loss is that the choice does not persist.
    return parseNoteSort(null);
  }
}

function write(sort: NoteSort): void {
  try {
    if (isDefaultNoteSort(sort)) localStorage.removeItem(NOTE_SORT_KEY);
    else localStorage.setItem(NOTE_SORT_KEY, serializeNoteSort(sort));
  } catch {
    // As above.
  }
}

class NoteSortStore {
  #sort = $state<NoteSort>(read());

  get current(): NoteSort {
    return this.#sort;
  }

  get key(): NoteSortKey {
    return this.#sort.key;
  }

  get reversed(): boolean {
    return this.#sort.reversed;
  }

  /** Which date a note row should show: the one being sorted on. */
  get dateField(): 'updatedAt' | 'createdAt' {
    return dateFieldFor(this.#sort);
  }

  /** The sidebar's heading for the unfiltered list. */
  get heading(): string {
    return SORT_HEADINGS[this.#sort.key];
  }

  setKey(key: NoteSortKey): void {
    if (key === this.#sort.key) return;
    // The direction survives a change of key: "oldest first" is a habit about
    // the list, not about one column.
    this.#sort = { key, reversed: this.#sort.reversed };
    write(this.#sort);
  }

  toggleReversed(): void {
    this.#sort = { key: this.#sort.key, reversed: !this.#sort.reversed };
    write(this.#sort);
  }
}

export const noteSort = new NoteSortStore();
