/**
 * The stored spelling of the sort choice, and its labels.
 *
 * Tested through `ui/noteSort.ts` rather than the store, as `theme.test.ts` and
 * `textSize.test.ts` are: the store is four lines of `$state` over these
 * functions, and these are where a bad stored value either falls back or takes
 * the list down with it.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_NOTE_SORT, type NoteSort } from '../../src/core/notes/model.ts';
import {
  NOTE_SORT_KEY,
  NOTE_SORT_KEYS,
  SORT_HEADINGS,
  SORT_LABELS,
  dateFieldFor,
  directionLabel,
  isDefaultNoteSort,
  parseNoteSort,
  serializeNoteSort,
} from '../../src/ui/noteSort.ts';

describe('the stored sort choice', () => {
  it('keeps the frozen storage key', () => {
    // Renaming it would silently reset everyone's choice. Harmless here, unlike
    // the other frozen names, but the rule is the rule (docs/security.md).
    expect(NOTE_SORT_KEY).toBe('teksto:note-sort');
  });

  it('round-trips every key in both directions', () => {
    for (const key of NOTE_SORT_KEYS) {
      for (const reversed of [false, true]) {
        const sort: NoteSort = { key, reversed };
        expect(parseNoteSort(serializeNoteSort(sort))).toEqual(sort);
      }
    }
  });

  it('spells a choice so a reader of their own storage can see it', () => {
    expect(serializeNoteSort({ key: 'title', reversed: false })).toBe('title');
    expect(serializeNoteSort({ key: 'title', reversed: true })).toBe('-title');
  });

  it('reads an absent value as the order the product shipped with', () => {
    // A device that has never chosen holds no key at all, which is what lets
    // the default change later without overriding people who accepted it.
    expect(parseNoteSort(null)).toEqual(DEFAULT_NOTE_SORT);
    expect(parseNoteSort(undefined)).toEqual(DEFAULT_NOTE_SORT);
    expect(parseNoteSort('')).toEqual(DEFAULT_NOTE_SORT);
  });

  it('falls back rather than throwing on a value it does not recognise', () => {
    // This runs before the list renders: a list in the wrong order beats no
    // list at all.
    for (const raw of ['manual', '-manual', '-', 'TITLE', '{"key":"title"}', '--title']) {
      expect(parseNoteSort(raw)).toEqual(DEFAULT_NOTE_SORT);
    }
  });

  it('recognises the default, which is the only value never written', () => {
    expect(isDefaultNoteSort(DEFAULT_NOTE_SORT)).toBe(true);
    expect(isDefaultNoteSort({ key: 'edited', reversed: true })).toBe(false);
    expect(isDefaultNoteSort({ key: 'title', reversed: false })).toBe(false);
  });
});

describe('sort labels', () => {
  it('names every key in the menu and in the sidebar heading', () => {
    for (const key of NOTE_SORT_KEYS) {
      expect(SORT_LABELS[key]).toBeTruthy();
      expect(SORT_HEADINGS[key]).toBeTruthy();
    }
  });

  it('keeps the heading the list already had for the default order', () => {
    expect(SORT_HEADINGS[DEFAULT_NOTE_SORT.key]).toBe('Recent');
  });

  it('says which way a date runs and which way a title runs', () => {
    expect(directionLabel({ key: 'edited', reversed: false })).toBe('newest first');
    expect(directionLabel({ key: 'created', reversed: true })).toBe('oldest first');
    expect(directionLabel({ key: 'title', reversed: false })).toBe('A to Z');
    expect(directionLabel({ key: 'title', reversed: true })).toBe('Z to A');
  });

  it('shows the date the list is sorted on, not always the edit date', () => {
    expect(dateFieldFor({ key: 'created', reversed: false })).toBe('createdAt');
    expect(dateFieldFor({ key: 'edited', reversed: false })).toBe('updatedAt');
    // A title sort has no date of its own; the edit date is the useful one.
    expect(dateFieldFor({ key: 'title', reversed: false })).toBe('updatedAt');
  });
});
