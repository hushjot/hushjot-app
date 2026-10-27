import { describe, it, expect } from 'vitest';
import type { Folder } from '../../src/core/notes/folders.ts';
import { planExport, safeName, noteFileName, type ExportNote } from '../../src/core/portability/exportTree.ts';
import { planImport, expandArchives, isImportable } from '../../src/core/portability/importTree.ts';
import { writeZip, type ZipEntry } from '../../src/core/portability/zip.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  createdAt: 0,
  updatedAt: 0,
});

const note = (id: string, title: string, folderId: string | null = null, content = `# ${title}`): ExportNote => ({
  id,
  title,
  folderId,
  updatedAt: 1_700_000_000_000,
  content,
});

const file = (path: string, text: string): ZipEntry => ({ path, data: enc.encode(text), modified: 5 });

describe('safeName', () => {
  it('makes a portable path segment', () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i')).toBe('a b c d e f g h i');
    expect(safeName('  ..hidden. ')).toBe('hidden');
    expect(safeName('')).toBe('Untitled');
    expect(safeName('CON')).toBe('CON note');
    expect(safeName('x'.repeat(300))).toHaveLength(100);
    expect(noteFileName('Rust notes')).toBe('Rust notes.md');
  });
});

describe('planExport', () => {
  const folders = [folder('code', 'Code'), folder('rust', 'Rust', 'code'), folder('empty', 'Empty')];

  it('lays notes out in the folder tree (§24)', () => {
    const entries = planExport(folders, [
      note('1', 'async', 'rust'),
      note('2', 'shopping'),
      note('3', 'postgres', 'code'),
    ]);
    expect(entries.map((e) => e.path).sort()).toEqual(['Code/Rust/async.md', 'Code/postgres.md', 'Empty/', 'shopping.md']);
    expect(dec.decode(entries.find((e) => e.path === 'shopping.md')!.data)).toBe('# shopping');
  });

  it('never lets two notes or folders share a name, ignoring case', () => {
    const entries = planExport(
      [folder('a', 'Ideas'), folder('b', 'ideas')],
      [note('1', 'Todo'), note('2', 'todo'), note('3', 'Todo'), note('4', 'x', 'a'), note('5', 'x', 'b')],
    );
    const paths = entries.map((e) => e.path);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
    expect(paths).toContain('Todo (2).md');
    expect(paths).toContain('Todo (3).md');
  });

  it('exports a subtree with its root as the top directory', () => {
    const entries = planExport(folders, [note('1', 'async', 'rust'), note('2', 'outside'), note('3', 'pg', 'code')], 'rust');
    expect(entries.map((e) => e.path)).toEqual(['Rust/async.md']);
  });

  it('survives a folder cycle and a dangling folder reference', () => {
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    const entries = planExport(cyclic, [note('1', 'n', 'a'), note('2', 'lost', 'missing')]);
    expect(entries.map((e) => e.path)).toContain('lost.md');
    expect(entries.some((e) => e.path.endsWith('n.md'))).toBe(true);
  });
});

describe('planImport', () => {
  it('builds folders parent-first and places notes in them', () => {
    const plan = planImport([file('Code/Rust/async.md', '# Async'), file('hi.md', 'hi'), file('Empty/', '')]);
    expect(plan.folders).toEqual([
      { key: 'Code/', name: 'Code', parentKey: null },
      { key: 'Code/Rust/', name: 'Rust', parentKey: 'Code/' },
      { key: 'Empty/', name: 'Empty', parentKey: null },
    ]);
    expect(plan.notes).toEqual([
      { content: '# Async', folderKey: 'Code/Rust/', modified: 5 },
      { content: 'hi', folderKey: null, modified: 5 },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('ignores hidden files and Finder resource forks, and skips non-text', () => {
    const plan = planImport([
      file('__MACOSX/._a.md', 'junk'),
      file('.DS_Store', 'junk'),
      file('vault/.obsidian/app.json', '{}'),
      file('photo.png', 'png'),
      { path: 'binary.md', data: new Uint8Array([0x23, 0, 0x41]), modified: 0 },
      { path: 'latin1.txt', data: new Uint8Array([0xe9, 0x74, 0xe9]), modified: 0 },
    ]);
    expect(plan.notes).toEqual([]);
    expect(plan.folders.map((f) => f.key)).toEqual([]);
    expect(plan.skipped).toEqual(['photo.png', 'binary.md', 'latin1.txt']);
  });

  it('strips a BOM, normalises line endings and names an empty file', () => {
    const plan = planImport([file('One.txt', '﻿one\r\ntwo\rthree'), file('Blank page.md', '  \n')]);
    expect(plan.notes.map((n) => n.content)).toEqual(['one\ntwo\nthree', '# Blank page\n']);
    expect(plan.titledFromName).toBe(1);
  });

  /**
   * In a folder of Markdown files the file name is the title, and links say
   * so. A note whose first line says something else would lose the name, and
   * every `[[Architecture]]` pointing at it would resolve to nothing.
   */
  it('keeps a file name that the first line does not already say', () => {
    const plan = planImport([
      file('vault/Architecture.md', 'This design uses a queue.'),
      file('vault/Project.md', '[[Architecture]]'),
    ]);
    expect(plan.notes.map((n) => n.content)).toEqual([
      '# Architecture\n\nThis design uses a queue.',
      '# Project\n\n[[Architecture]]',
    ]);
    expect(plan.titledFromName).toBe(2);
  });

  it('leaves a first-line-is-the-title export byte for byte', () => {
    const plan = planImport([
      // Simplenote: the file is named after the first line.
      file('Shopping list.txt', 'Shopping list\nmilk'),
      // Case, accents and punctuation differ after an exporter sanitises.
      file('Cafe notes.md', '# Café notes!\nbody'),
      // A name truncated by the exporter.
      file('A very long title that.md', 'A very long title that went on and on\n'),
    ]);
    expect(plan.notes.map((n) => n.content)).toEqual([
      'Shopping list\nmilk',
      '# Café notes!\nbody',
      'A very long title that went on and on\n',
    ]);
    expect(plan.titledFromName).toBe(0);
  });

  it('accepts only text, zip and JSON files', () => {
    expect(isImportable('a.MD')).toBe(true);
    expect(isImportable('a.zip')).toBe(true);
    // For the exports `sources.ts` recognises; any other JSON is skipped.
    expect(isImportable('Keep/a.json')).toBe(true);
    expect(isImportable('a.pdf')).toBe(false);
  });
});

describe('export → import round trip', () => {
  it('restores the same tree and text', async () => {
    const folders = [folder('code', 'Code'), folder('rust', 'Rust', 'code'), folder('empty', 'Empty')];
    const notes = [note('1', 'async', 'rust', '# async\n\nbody'), note('2', 'top', null, 'top text')];
    const zip = writeZip(planExport(folders, notes));

    const { entries, skipped } = await expandArchives([{ path: 'HushJot 2026-09-17.zip', data: zip, modified: 0 }]);
    const plan = planImport(entries);
    expect(skipped).toEqual([]);
    expect(plan.folders.map((f) => f.key).sort()).toEqual(['Code/', 'Code/Rust/', 'Empty/']);
    expect(plan.notes.map((n) => [n.folderKey, n.content])).toEqual(
      expect.arrayContaining([
        ['Code/Rust/', '# async\n\nbody'],
        [null, 'top text'],
      ]),
    );
    expect(plan.notes).toHaveLength(2);
  });
});
