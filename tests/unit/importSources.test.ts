import { describe, it, expect } from 'vitest';
import { planImport } from '../../src/core/portability/importTree.ts';
import { asTag, withTags } from '../../src/core/portability/sources.ts';
import { extractTags } from '../../src/core/notes/tags.ts';
import type { ZipEntry } from '../../src/core/portability/zip.ts';

/*
 * The shapes below follow each app's export as documented and as their
 * exporters write it (Simplenote's `source/notes.json`, Takeout's per-note
 * Keep JSON). They are hand-built, not captured: swap in a real, scrubbed
 * export under `tests/fixtures/` when one is to hand.
 */

const enc = new TextEncoder();
const file = (path: string, text: string): ZipEntry => ({ path, data: enc.encode(text), modified: 5 });
const json = (path: string, value: unknown): ZipEntry => file(path, JSON.stringify(value));

describe('asTag', () => {
  it('reshapes names #tag syntax cannot hold rather than dropping them', () => {
    expect(asTag('work')).toBe('work');
    expect(asTag('to do')).toBe('to-do');
    expect(asTag('C++ & Rust')).toBe('C-Rust');
    expect(asTag('2024')).toBe('tag-2024');
    expect(asTag('c0ffee')).toBe('tag-c0ffee');
    expect(asTag('a/b')).toBe('a/b');
    expect(asTag('  !!  ')).toBeNull();
  });
});

describe('withTags', () => {
  it('adds a last line of tags the note does not already say', () => {
    expect(withTags('Groceries\nmilk\n', ['shopping', 'Home'])).toBe('Groceries\nmilk\n\n#shopping #Home\n');
    expect(withTags('Note #home\n', ['home', 'work'])).toBe('Note #home\n\n#work\n');
    expect(withTags('Note', [])).toBe('Note');
  });

  it('writes tags the tag reader then finds', () => {
    const content = withTags('A\n```\ncode\n```', ['one', 'two words']);
    expect(extractTags(content).map((t) => t.label)).toEqual(['one', 'two-words']);
  });
});

describe('Simplenote export', () => {
  const notesJson = {
    activeNotes: [
      {
        id: 'a1',
        content: 'Shopping list\r\nmilk',
        creationDate: '2024-01-02T03:04:05.000Z',
        lastModified: '2024-06-07T08:09:10.000Z',
        tags: ['home', 'to do'],
        pinned: true,
      },
      { id: 'a2', content: 'Plain', creationDate: '2024-01-01T00:00:00.000Z', lastModified: '2024-01-01T00:00:00.000Z' },
    ],
    trashedNotes: [{ id: 't1', content: 'Old', creationDate: '2020-01-01T00:00:00.000Z', lastModified: '2020-01-01T00:00:00.000Z' }],
  };

  it('takes tags, pins and dates from notes.json and drops the duplicate text files', () => {
    const plan = planImport([
      json('notes/source/notes.json', notesJson),
      file('notes/notes/Shopping list.txt', 'Shopping list\nmilk'),
      file('notes/notes/Plain.txt', 'Plain'),
      file('notes/notes/trash/Old.txt', 'Old'),
      file('notes/kept.md', 'kept'),
    ]);
    expect(plan.sources).toEqual(['simplenote']);
    expect(plan.trashed).toBe(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.notes).toEqual([
      { content: 'kept', folderKey: 'notes/', modified: 5 },
      {
        content: 'Shopping list\nmilk\n\n#home #to-do\n',
        folderKey: null,
        modified: Date.parse('2024-06-07T08:09:10.000Z'),
        created: Date.parse('2024-01-02T03:04:05.000Z'),
        pinned: true,
      },
      { content: 'Plain', folderKey: null, modified: Date.parse('2024-01-01T00:00:00.000Z'), created: Date.parse('2024-01-01T00:00:00.000Z') },
    ]);
  });

  it('reads the older numeric dates and systemTags pin', () => {
    const plan = planImport([
      json('source/notes.json', { activeNotes: [{ content: 'x', creationDate: 1_700_000_000, lastModified: 1_700_000_100, systemTags: ['pinned'] }] }),
    ]);
    expect(plan.notes).toEqual([{ content: 'x', folderKey: null, modified: 1_700_000_100_000, created: 1_700_000_000_000, pinned: true }]);
  });
});

describe('Google Keep export (Takeout)', () => {
  const keep = (name: string, value: Record<string, unknown>) =>
    json(`Takeout/Keep/${name}.json`, {
      color: 'DEFAULT',
      isTrashed: false,
      isPinned: false,
      isArchived: false,
      title: '',
      textContent: '',
      userEditedTimestampUsec: 1_700_000_000_000_000,
      createdTimestampUsec: 1_690_000_000_000_000,
      ...value,
    });

  it('turns titles, text, checklists and labels into Markdown', () => {
    const plan = planImport([
      keep('Ideas', { title: 'Ideas', textContent: 'one\ntwo', labels: [{ name: 'Side projects' }], isPinned: true }),
      file('Takeout/Keep/Ideas.html', '<html>dup</html>'),
      keep('Link', { title: 'Link', annotations: [{ source: 'WEBLINK', title: 'Docs [v2]', url: 'https://example.com/docs' }] }),
      keep('Packing', {
        title: 'Packing',
        textContent: undefined,
        listContent: [
          { text: 'socks', isChecked: true },
          { text: 'passport', isChecked: false },
        ],
      }),
      keep('2023-01-01T10_00_00.000Z', { textContent: 'untitled thought' }),
      file('Takeout/Keep/Labels.txt', 'Side projects\n'),
    ]);
    expect(plan.sources).toEqual(['google-keep']);
    expect(plan.skipped).toEqual([]);
    expect(plan.folders).toEqual([]);
    expect(plan.notes.map((n) => n.content)).toEqual([
      '# Ideas\n\none\ntwo\n\n#Side-projects\n',
      '# Link\n\n- [Docs v2](https://example.com/docs)\n',
      '# Packing\n\n- [x] socks\n- [ ] passport\n',
      'untitled thought\n',
    ]);
    expect(plan.notes[0]).toMatchObject({ pinned: true, modified: 1_700_000_000_000, created: 1_690_000_000_000, folderKey: null });
  });

  it('files archived notes under Archive, leaves trash out, and reports attachments', () => {
    const plan = planImport([
      keep('Old', { title: 'Old', isArchived: true }),
      keep('Gone', { title: 'Gone', isTrashed: true, attachments: [{ filePath: 'gone.png', mimetype: 'image/png' }] }),
      file('Takeout/Keep/gone.png', 'png'),
      keep('Photo', { attachments: [{ filePath: 'photo.jpg', mimetype: 'image/jpeg' }] }),
      file('Takeout/Keep/photo.jpg', 'jpg'),
      keep('Captioned', { title: 'Captioned', attachments: [{ filePath: 'cap.png', mimetype: 'image/png' }] }),
      file('Takeout/Keep/cap.png', 'png'),
    ]);
    expect(plan.trashed).toBe(1);
    expect(plan.folders).toEqual([{ key: 'Archive/', name: 'Archive', parentKey: null }]);
    expect(plan.notes.map((n) => [n.folderKey, n.content])).toEqual([
      ['Archive/', '# Old\n'],
      [null, '# Captioned\n'],
    ]);
    expect(plan.skipped).toEqual(['Takeout/Keep/Photo.json', 'Takeout/Keep/photo.jpg', 'Takeout/Keep/cap.png']);
  });
});

describe('Standard Notes backup', () => {
  it('holds back the JSON backup file and imports the plain-text notes', () => {
    const plan = planImport([
      file('backup/Standard Notes Backup and Import File.txt', '{"version":"004","items":[]}'),
      file('backup/Items/Note/Groceries.txt', 'milk'),
    ]);
    expect(plan.skipped).toEqual(['backup/Standard Notes Backup and Import File.txt']);
    expect(plan.notes.map((n) => n.content)).toEqual(['# Groceries\n\nmilk']);
  });
});

describe('unrecognised JSON', () => {
  it('is skipped as before, and malformed JSON does not throw', () => {
    const plan = planImport([json('data.json', { hello: 1 }), file('broken.json', '{nope'), file('a.md', 'a')]);
    expect(plan.sources).toEqual([]);
    expect(plan.skipped).toEqual(['data.json', 'broken.json']);
    expect(plan.notes).toHaveLength(1);
  });
});
