import { describe, it, expect } from 'vitest';
import {
  createFolder,
  buildTree,
  flattenTree,
  subtreeIds,
  visibleRows,
  ancestorIds,
  canMoveFolder,
  folderPath,
  foldersMatching,
  type Folder,
} from '../../src/core/notes/folders.ts';

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  createdAt: 0,
  updatedAt: 0,
});

describe('createFolder', () => {
  it('trims the name and falls back when blank', () => {
    expect(createFolder('  Ideas  ').name).toBe('Ideas');
    expect(createFolder('   ').name).toBe('New folder');
  });
});

describe('buildTree', () => {
  it('nests children under parents and assigns depth', () => {
    const tree = buildTree([
      folder('code', 'Code'),
      folder('rust', 'Rust', 'code'),
      folder('sql', 'SQL', 'code'),
      folder('ideas', 'Ideas'),
    ]);

    const flat = flattenTree(tree);
    expect(flat.map((f) => [f.name, f.depth])).toEqual([
      ['Code', 0],
      ['Rust', 1],
      ['SQL', 1],
      ['Ideas', 0],
    ]);
  });

  it('sorts siblings by name, case-insensitively', () => {
    const flat = flattenTree(buildTree([folder('b', 'beta'), folder('a', 'Alpha')]));
    expect(flat.map((f) => f.name)).toEqual(['Alpha', 'beta']);
  });

  it('surfaces orphans at the root rather than dropping them', () => {
    // A dangling parentId must never make a folder disappear (§25).
    const flat = flattenTree(buildTree([folder('orphan', 'Orphan', 'missing-parent')]));
    expect(flat.map((f) => f.name)).toEqual(['Orphan']);
    expect(flat[0]!.depth).toBe(0);
  });

  it('keeps every folder in a parent cycle reachable', () => {
    // A cycle leaves no member parentless, so a naive build drops the whole
    // group. Every folder must still appear (§25) and the walk must terminate.
    const flat = flattenTree(buildTree([folder('a', 'A', 'b'), folder('b', 'B', 'a')]));
    expect(flat.map((f) => f.name).sort()).toEqual(['A', 'B']);
  });

  it('keeps a longer cycle reachable too', () => {
    const flat = flattenTree(
      buildTree([folder('a', 'A', 'c'), folder('b', 'B', 'a'), folder('c', 'C', 'b')]),
    );
    expect(flat.map((f) => f.name).sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps a cycle hanging off a real root reachable', () => {
    const flat = flattenTree(
      buildTree([
        folder('root', 'Root'),
        folder('x', 'X', 'y'),
        folder('y', 'Y', 'x'),
      ]),
    );
    expect(flat.map((f) => f.name).sort()).toEqual(['Root', 'X', 'Y']);
  });

  it('ignores a folder that claims itself as parent', () => {
    const flat = flattenTree(buildTree([folder('self', 'Self', 'self')]));
    expect(flat.map((f) => f.name)).toEqual(['Self']);
  });

  it('returns an empty tree for no folders', () => {
    expect(flattenTree(buildTree([]))).toEqual([]);
  });
});

describe('subtreeIds', () => {
  const tree = [
    folder('code', 'Code'),
    folder('rust', 'Rust', 'code'),
    folder('cargo', 'Cargo', 'rust'),
    folder('sql', 'SQL', 'code'),
    folder('ideas', 'Ideas'),
  ];

  it('collects the folder and every descendant', () => {
    expect(new Set(subtreeIds(tree, 'code'))).toEqual(new Set(['code', 'rust', 'cargo', 'sql']));
  });

  it('returns just the folder itself for a leaf', () => {
    expect(subtreeIds(tree, 'ideas')).toEqual(['ideas']);
    expect(subtreeIds(tree, 'cargo')).toEqual(['cargo']);
  });

  it('leaves siblings and ancestors alone', () => {
    expect(subtreeIds(tree, 'rust')).not.toContain('code');
    expect(subtreeIds(tree, 'rust')).not.toContain('sql');
  });

  it('returns nothing for an unknown id', () => {
    expect(subtreeIds(tree, 'nope')).toEqual([]);
  });

  it('terminates on a parent cycle', () => {
    // buildTree tolerates cycles, so one can reach here.
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('c', 'C', 'b')];
    expect(new Set(subtreeIds(cyclic, 'a'))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores a folder parented to itself', () => {
    expect(subtreeIds([folder('self', 'Self', 'self')], 'self')).toEqual(['self']);
  });
});

const nested = [
  folder('code', 'Code'),
  folder('rust', 'Rust', 'code'),
  folder('async', 'Async', 'rust'),
  folder('sql', 'SQL', 'code'),
  folder('ideas', 'Ideas'),
];

describe('buildTree hasChildren', () => {
  it('marks folders with subfolders, and only those', () => {
    const flat = flattenTree(buildTree(nested));
    expect(Object.fromEntries(flat.map((f) => [f.id, f.hasChildren]))).toEqual({
      code: true,
      rust: true,
      async: false,
      sql: false,
      ideas: false,
    });
  });
});

describe('visibleRows', () => {
  it('shows everything when nothing is collapsed', () => {
    expect(visibleRows(buildTree(nested), new Set()).map((f) => f.id)).toEqual(
      flattenTree(buildTree(nested)).map((f) => f.id),
    );
  });

  it('hides every descendant of a collapsed folder but keeps the folder', () => {
    const ids = visibleRows(buildTree(nested), new Set(['code'])).map((f) => f.id);
    expect(ids).toEqual(['code', 'ideas']);
  });

  it('keeps a nested collapse hidden under a collapsed ancestor', () => {
    const ids = visibleRows(buildTree(nested), new Set(['rust'])).map((f) => f.id);
    expect(ids).toEqual(['code', 'rust', 'sql', 'ideas']);
  });

  it('ignores ids that name no folder', () => {
    expect(visibleRows(buildTree(nested), new Set(['gone'])).length).toBe(nested.length);
  });
});

describe('ancestorIds', () => {
  it('lists parents nearest first', () => {
    expect(ancestorIds(nested, 'async')).toEqual(['rust', 'code']);
    expect(ancestorIds(nested, 'code')).toEqual([]);
  });

  it('stops at a missing parent', () => {
    expect(ancestorIds([folder('x', 'X', 'missing')], 'x')).toEqual([]);
  });

  it('terminates on a cycle', () => {
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(ancestorIds(cyclic, 'a')).toEqual(['b']);
  });
});

describe('canMoveFolder', () => {
  it('allows moving to the top level or into an unrelated folder', () => {
    expect(canMoveFolder(nested, 'rust', null)).toBe(true);
    expect(canMoveFolder(nested, 'rust', 'ideas')).toBe(true);
    expect(canMoveFolder(nested, 'sql', 'rust')).toBe(true);
  });

  it('refuses a move into itself or its own subtree', () => {
    expect(canMoveFolder(nested, 'code', 'code')).toBe(false);
    expect(canMoveFolder(nested, 'code', 'rust')).toBe(false);
    expect(canMoveFolder(nested, 'code', 'async')).toBe(false);
  });

  it('refuses unknown folders and targets', () => {
    expect(canMoveFolder(nested, 'nope', null)).toBe(false);
    expect(canMoveFolder(nested, 'rust', 'nope')).toBe(false);
  });
});

describe('folderPath', () => {
  it('joins names from the top level down', () => {
    expect(folderPath(nested, 'async')).toBe('Code / Rust / Async');
    expect(folderPath(nested, 'ideas', '/')).toBe('Ideas');
  });

  it('is empty for an unknown folder', () => {
    expect(folderPath(nested, 'nope')).toBe('');
  });
});

describe('foldersMatching', () => {
  it('matches an exact id first', () => {
    expect(foldersMatching(nested, 'rust')).toEqual(['rust']);
  });

  it('matches a full path, case-insensitively', () => {
    expect(foldersMatching(nested, 'Code/Rust/Async')).toEqual(['async']);
    expect(foldersMatching(nested, 'code/sql')).toEqual(['sql']);
  });

  it('matches a plain name at any depth', () => {
    expect(foldersMatching(nested, 'Async')).toEqual(['async']);
  });

  it('returns every folder sharing a name rather than picking one', () => {
    // Names are not unique by design; the caller decides what to do about it.
    const dupes = [folder('f1', 'Rust'), folder('f2', 'Rust'), folder('f3', 'Go')];
    expect(foldersMatching(dupes, 'Rust').sort()).toEqual(['f1', 'f2']);
  });

  it('prefers the more specific kind of match', () => {
    // A folder literally named after another's id must not beat that id.
    const tricky = [folder('code', 'Code'), folder('x', 'code', 'code')];
    expect(foldersMatching(tricky, 'code')).toEqual(['code']);
  });

  it('finds nothing for an unknown folder or an empty string', () => {
    expect(foldersMatching(nested, 'nope')).toEqual([]);
    expect(foldersMatching(nested, '   ')).toEqual([]);
  });

  it('only prefix-matches when asked', () => {
    expect(foldersMatching(nested, 'Ru')).toEqual([]);
    expect(foldersMatching(nested, 'Ru', { prefix: true })).toEqual(['rust']);
  });

  it('prefix-matches a partial path as it is typed, descendants included', () => {
    // `code/rust/async` starts with `code/ru` too, and that is wanted: a scope
    // is taken over subtrees anyway, so offering the branch costs nothing.
    expect(foldersMatching(nested, 'code/ru', { prefix: true }).sort()).toEqual(['async', 'rust']);
    expect(foldersMatching(nested, 'code/', { prefix: true }).sort()).toEqual(['async', 'rust', 'sql']);
  });

  it('still prefers an exact match over a prefix one', () => {
    const both = [folder('a', 'Work'), folder('b', 'Workshop')];
    expect(foldersMatching(both, 'Work', { prefix: true })).toEqual(['a']);
    expect(foldersMatching(both, 'Wor', { prefix: true }).sort()).toEqual(['a', 'b']);
  });

  it('terminates on a parent cycle', () => {
    // `buildTree` tolerates cycles, so this function has to as well.
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(foldersMatching(cyclic, 'A')).toEqual(['a']);
  });
});
