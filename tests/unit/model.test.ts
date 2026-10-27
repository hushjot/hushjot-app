import { describe, it, expect } from 'vitest';
import {
  deriveTitle,
  createNote,
  withContent,
  withFolder,
  withPinned,
  orderForList,
  comparatorFor,
  filterForList,
  isDefaultSort,
  DEFAULT_NOTE_SORT,
  pinnedCount,
  toMeta,
  byRecency,
  UNTITLED,
  excerptOf,
} from '../../src/core/notes/model.ts';

describe('deriveTitle', () => {
  it('takes the first non-empty line', () => {
    expect(deriveTitle('Hello world\nsecond line')).toBe('Hello world');
  });

  it('strips ATX heading marks at every level', () => {
    expect(deriveTitle('# Postgres commands')).toBe('Postgres commands');
    expect(deriveTitle('###### Deep heading')).toBe('Deep heading');
  });

  it('strips list, task and quote prefixes', () => {
    expect(deriveTitle('- shopping')).toBe('shopping');
    expect(deriveTitle('* starred')).toBe('starred');
    expect(deriveTitle('1. first')).toBe('first');
    expect(deriveTitle('2) second')).toBe('second');
    expect(deriveTitle('- [ ] unchecked')).toBe('unchecked');
    expect(deriveTitle('- [x] done')).toBe('done');
    expect(deriveTitle('> quoted')).toBe('quoted');
  });

  it('skips leading blank lines and pure-markup lines', () => {
    expect(deriveTitle('\n\n\n# Real title')).toBe('Real title');
    // A horizontal rule or bare hashes carry no title text.
    expect(deriveTitle('---\n# Actual')).toBe('Actual');
    expect(deriveTitle('###\nActual')).toBe('Actual');
  });

  it('falls back to Untitled for empty or whitespace-only content', () => {
    expect(deriveTitle('')).toBe(UNTITLED);
    expect(deriveTitle('   \n\t\n  ')).toBe(UNTITLED);
    expect(deriveTitle('#')).toBe(UNTITLED);
  });

  it('accepts a title made only of symbols', () => {
    // Structural-character lines are skipped, but a genuine emoji title is not
    // markup and must survive.
    expect(deriveTitle('# 🎉')).toBe('🎉');
    expect(deriveTitle('→ next steps')).toBe('→ next steps');
  });

  it('skips table delimiter and setext underline rows', () => {
    expect(deriveTitle('| --- | --- |\nReal')).toBe('Real');
    expect(deriveTitle('===\nReal')).toBe('Real');
    expect(deriveTitle('***\nReal')).toBe('Real');
  });

  it('truncates very long titles', () => {
    const title = deriveTitle('x'.repeat(500));
    expect(title.length).toBe(120);
  });

  it('does not scan the whole document for a title', () => {
    // A megabyte of blank lines followed by text: the title search is capped,
    // so this must not become an O(document) walk on every keystroke.
    const content = '\n'.repeat(200_000) + 'Buried title';
    expect(deriveTitle(content)).toBe(UNTITLED);
  });
});

describe('createNote', () => {
  it('derives the title from the content', () => {
    const note = createNote({ content: '# From content' });
    expect(note.title).toBe('From content');
    expect(note.revision).toBe(1);
    expect(note.folderId).toBeNull();
  });

  it('gives distinct ids', () => {
    expect(createNote().id).not.toBe(createNote().id);
  });
});

describe('withContent', () => {
  it('bumps revision and re-derives the title', () => {
    const note = createNote({ content: '# One', now: 1000 });
    const next = withContent(note, '# Two', 2000);

    expect(next.revision).toBe(2);
    expect(next.title).toBe('Two');
    expect(next.updatedAt).toBe(2000);
    expect(next.createdAt).toBe(1000);
  });

  it('returns the identical object when content is unchanged', () => {
    // Callers rely on this to skip no-op writes and avoid phantom revisions.
    const note = createNote({ content: 'same' });
    expect(withContent(note, 'same')).toBe(note);
  });

  it('never mutates the input', () => {
    const note = createNote({ content: '# One' });
    withContent(note, '# Two');
    expect(note.content).toBe('# One');
    expect(note.revision).toBe(1);
  });
});

describe('withFolder', () => {
  it('moves the note and bumps revision', () => {
    const note = createNote();
    const moved = withFolder(note, 'folder-1');
    expect(moved.folderId).toBe('folder-1');
    expect(moved.revision).toBe(2);
  });

  it('is a no-op when already in that folder', () => {
    const note = createNote({ folderId: 'f' });
    expect(withFolder(note, 'f')).toBe(note);
  });
});

describe('toMeta and byRecency', () => {
  it('projects only the fields the list needs', () => {
    const note = createNote({ content: '# Title' });
    expect(Object.keys(toMeta(note)).sort()).toEqual(
      ['createdAt', 'excerpt', 'folderId', 'id', 'pinnedAt', 'title', 'updatedAt'].sort(),
    );
  });

  it('sorts most recently updated first', () => {
    const items = [{ updatedAt: 1 }, { updatedAt: 3 }, { updatedAt: 2 }];
    expect([...items].sort(byRecency).map((i) => i.updatedAt)).toEqual([3, 2, 1]);
  });
});

describe('pinning', () => {
  it('pins and unpins, stamping the note like any other change', () => {
    const note = createNote({ content: 'a', now: 1 });
    const pinned = withPinned(note, true, 50);
    expect(pinned.pinnedAt).toBe(50);
    expect(pinned.updatedAt).toBe(50);
    expect(pinned.revision).toBe(note.revision + 1);

    const unpinned = withPinned(pinned, false, 60);
    expect(unpinned.pinnedAt).toBeNull();
    expect(unpinned.revision).toBe(pinned.revision + 1);
  });

  it('returns the same note when nothing changes', () => {
    const note = createNote({ content: 'a' });
    expect(withPinned(note, false)).toBe(note);
    const pinned = withPinned(note, true, 5);
    expect(withPinned(pinned, true, 9)).toBe(pinned);
  });
});

describe('orderForList', () => {
  const meta = (id: string, updatedAt: number, pinnedAt: number | null = null) => ({
    id,
    updatedAt,
    pinnedAt,
    // Every sort key needs a field, so the helper carries all of them. Title
    // and created default to something derived from the id and the update time,
    // which keeps the recency cases below reading exactly as they did.
    title: id,
    createdAt: updatedAt,
  });

  it('hands back the very same array when nothing is pinned', () => {
    const metas = [meta('a', 3), meta('b', 2)];
    expect(orderForList(metas)).toBe(metas);
    expect(pinnedCount(metas)).toBe(0);
  });

  it('puts pins first, newest pin on top, and keeps the rest in order', () => {
    const metas = [meta('a', 9), meta('b', 8, 100), meta('c', 7), meta('d', 6, 200), meta('e', 5)];
    const ordered = orderForList(metas);
    expect(ordered.map((m) => m.id)).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(pinnedCount(ordered)).toBe(2);
  });

  it('holds pins still while one of them is edited', () => {
    // The edited note moves to the front of the recency order; pins do not care.
    const before = orderForList([meta('a', 5, 10), meta('b', 4, 20)]);
    const after = orderForList([meta('a', 99, 10), meta('b', 4, 20)]);
    expect(before.map((m) => m.id)).toEqual(['b', 'a']);
    expect(after.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('handles a list that is all pins', () => {
    expect(orderForList([meta('a', 1, 1), meta('b', 2, 2)]).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('note sorts', () => {
  const note = (id: string, title: string, createdAt: number, updatedAt: number, pinnedAt: number | null = null) => ({
    id,
    title,
    createdAt,
    updatedAt,
    pinnedAt,
  });

  it('recognises the order the product shipped with', () => {
    expect(isDefaultSort(DEFAULT_NOTE_SORT)).toBe(true);
    expect(isDefaultSort({ key: 'edited', reversed: true })).toBe(false);
    expect(isDefaultSort({ key: 'title', reversed: false })).toBe(false);
  });

  it('keeps the identity fast path under the default sort', () => {
    // The reason it exists: a derived list costs one scan and no new array.
    const metas = [note('a', 'A', 1, 3), note('b', 'B', 2, 2)];
    expect(orderForList(metas, DEFAULT_NOTE_SORT)).toBe(metas);
    expect(orderForList(metas)).toBe(metas);
  });

  it('sorts by title, collated rather than by code unit', () => {
    const metas = [note('1', 'banana', 1, 1), note('2', 'Apple', 2, 2), note('3', 'cherry', 3, 3)];
    const ordered = orderForList(metas, { key: 'title', reversed: false });
    expect(ordered.map((m) => m.title)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('sorts titles numerically, so note 2 precedes note 10', () => {
    const metas = [note('1', 'note 10', 1, 1), note('2', 'note 2', 2, 2)];
    const ordered = orderForList(metas, { key: 'title', reversed: false });
    expect(ordered.map((m) => m.title)).toEqual(['note 2', 'note 10']);
  });

  it('sorts by created date, newest first, independently of edits', () => {
    // b was created last but edited least recently: the two orders disagree,
    // which is the whole point of offering the choice.
    const metas = [note('a', 'A', 10, 99), note('b', 'B', 20, 1)];
    expect(orderForList(metas, { key: 'created', reversed: false }).map((m) => m.id)).toEqual(['b', 'a']);
    expect(orderForList(metas, { key: 'edited', reversed: false }).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('reverses every key', () => {
    // Recency-descending, the order `Workspace` guarantees: the default sort
    // trusts it rather than re-deriving it, so a test that fed any other order
    // would be comparing a sorted list against an unsorted one.
    const metas = [note('c', 'C', 3, 3), note('b', 'B', 2, 2), note('a', 'A', 1, 1)];
    for (const key of ['edited', 'created', 'title'] as const) {
      const forward = orderForList(metas, { key, reversed: false }).map((m) => m.id);
      const back = orderForList(metas, { key, reversed: true }).map((m) => m.id);
      expect(back).toEqual([...forward].reverse());
    }
  });

  it('keeps pins leading, ordered by the active key', () => {
    const metas = [
      note('1', 'zebra', 1, 1, 100), // pinned first, last alphabetically
      note('2', 'alpha', 2, 2, 200), // pinned second, first alphabetically
      note('3', 'middle', 3, 3),
      note('4', 'beta', 4, 4),
    ];
    const ordered = orderForList(metas, { key: 'title', reversed: false });
    expect(ordered.map((m) => m.title)).toEqual(['alpha', 'zebra', 'beta', 'middle']);
    expect(pinnedCount(ordered)).toBe(2);
  });

  it('keeps pins in pin order under the default sort, and only there', () => {
    const metas = [note('1', 'zebra', 1, 9, 100), note('2', 'alpha', 2, 1, 200)];
    // Default: newest pin on top, whatever the notes say.
    expect(orderForList(metas, DEFAULT_NOTE_SORT).map((m) => m.title)).toEqual(['alpha', 'zebra']);
    // Reversed edited is not the default, so the key reaches the pins too.
    expect(orderForList(metas, { key: 'edited', reversed: true }).map((m) => m.title)).toEqual(['alpha', 'zebra']);
  });

  it('is a total order, so ties do not shuffle between renders', () => {
    const tie = [note('b', 'same', 5, 5), note('a', 'same', 5, 5)];
    const compare = comparatorFor({ key: 'title', reversed: false });
    expect(compare(tie[0]!, tie[1]!)).toBeGreaterThan(0);
    expect(orderForList(tie, { key: 'title', reversed: false }).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('filterForList applies the sort inside a folder', () => {
    const metas = [
      { ...note('1', 'zebra', 1, 3), folderId: 'f' },
      { ...note('2', 'alpha', 2, 2), folderId: 'f' },
      { ...note('3', 'beta', 3, 1), folderId: 'other' },
    ];
    const ordered = filterForList(metas, {
      activeTag: null,
      tagNoteIds: null,
      activeFolderId: 'f',
      sort: { key: 'title', reversed: false },
    });
    expect(ordered.map((m) => m.title)).toEqual(['alpha', 'zebra']);
  });

  it('filterForList with no sort leaves an unpinned list exactly as it came', () => {
    // The default sort's contract: the caller's order is already recency, so
    // it is handed straight back — array identity included.
    const metas = [
      { ...note('1', 'zebra', 1, 9), folderId: null },
      { ...note('2', 'alpha', 2, 1), folderId: null },
    ];
    const ordered = filterForList(metas, { activeTag: null, tagNoteIds: null, activeFolderId: null });
    expect(ordered).toBe(metas);
  });
});

describe('excerptOf', () => {
  it('takes the text after the title line', () => {
    expect(excerptOf('# Vitals Min-Max\n\nWhat the numbers mean')).toBe('What the numbers mean');
  });

  it('is empty for a note that is only a title', () => {
    expect(excerptOf('# Just a heading')).toBe('');
    expect(excerptOf('')).toBe('');
  });

  it('flattens several lines into one and caps the length', () => {
    const long = excerptOf(`# T\n\n${'word '.repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.startsWith('word word')).toBe(true);
  });

  it('strips list and quote marks, and skips fences and rules', () => {
    expect(excerptOf('# T\n\n- [ ] chase invoice')).toBe('chase invoice');
    expect(excerptOf('# T\n\n---\n\n> quoted')).toBe('quoted');
    expect(excerptOf('# T\n\n```sql\nSELECT 1;\n```')).toBe('SELECT 1;');
  });

  it('starts after the title even when the title is not a heading', () => {
    expect(excerptOf('Plain first line\nsecond line')).toBe('second line');
  });
});
