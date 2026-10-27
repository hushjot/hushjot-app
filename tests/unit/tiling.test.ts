import { describe, it, expect } from 'vitest';
import {
  createOpensTile,
  DEFAULT_TILE_LAYOUT,
  MAX_TILES,
  nextLayout,
  normalizeLayout,
  planClose,
  planTile,
  restoreTiles,
} from '../../src/ui/tiling.ts';

describe('layout', () => {
  it('defaults to vertical and rejects anything unknown', () => {
    expect(DEFAULT_TILE_LAYOUT).toBe('vertical');
    expect(normalizeLayout(null)).toBe('vertical');
    expect(normalizeLayout('diagonal')).toBe('vertical');
    expect(normalizeLayout('grid')).toBe('grid');
  });

  it('cycles through every layout and back', () => {
    expect(nextLayout('vertical')).toBe('horizontal');
    expect(nextLayout('horizontal')).toBe('grid');
    expect(nextLayout('grid')).toBe('vertical');
  });
});

describe('createOpensTile', () => {
  it('adds a tile only while tiling and below the cap', () => {
    expect(createOpensTile(0)).toBe(false);
    expect(createOpensTile(1)).toBe(false);
    expect(createOpensTile(2)).toBe(true);
    expect(createOpensTile(3)).toBe(true);
    expect(createOpensTile(MAX_TILES)).toBe(false);
  });
});

describe('planTile', () => {
  it('inserts beside the focused tile and focuses it', () => {
    expect(planTile(['a', 'b'], 0, 'c')).toEqual({ ids: ['a', 'c', 'b'], focused: 1 });
  });

  it('focuses a note that is already tiled instead of opening it twice', () => {
    expect(planTile(['a', 'b', 'c'], 0, 'c')).toEqual({ ids: ['a', 'b', 'c'], focused: 2 });
  });

  it('replaces the focused tile at the cap', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(full).toHaveLength(MAX_TILES);
    expect(planTile(full, 2, 'e')).toEqual({ ids: ['a', 'b', 'e', 'd'], focused: 2 });
  });

  it('opens the first tile into an empty set', () => {
    expect(planTile([], 0, 'a')).toEqual({ ids: ['a'], focused: 0 });
  });
});

describe('planClose', () => {
  it('never closes the last tile', () => {
    expect(planClose(['a'], 0, 0)).toEqual({ ids: ['a'], focused: 0 });
  });

  it('moves focus left when the focused tile closes', () => {
    expect(planClose(['a', 'b', 'c'], 1, 1)).toEqual({ ids: ['a', 'c'], focused: 0 });
    expect(planClose(['a', 'b', 'c'], 0, 0)).toEqual({ ids: ['b', 'c'], focused: 0 });
  });

  it('keeps focus on the same note when another tile closes', () => {
    expect(planClose(['a', 'b', 'c'], 2, 0)).toEqual({ ids: ['b', 'c'], focused: 1 });
    expect(planClose(['a', 'b', 'c'], 0, 2)).toEqual({ ids: ['a', 'b'], focused: 0 });
  });
});

describe('restoreTiles', () => {
  it('drops unknown, duplicate and malformed ids and caps the count', () => {
    const live = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(restoreTiles(['a', 'x', 'a', 3, 'b', 'c', 'd', 'e'], (id) => live.has(id))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
