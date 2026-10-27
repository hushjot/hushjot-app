import { describe, it, expect } from 'vitest';
import { SearchIndex, tokenize } from '../../src/core/search/index.ts';
import { parseQuery } from '../../src/core/search/query.ts';

const doc = (
  id: string,
  title: string,
  content = '',
  updatedAt = 0,
  folderId: string | null = null,
) => ({
  id,
  title,
  content,
  updatedAt,
  folderId,
});

/** `in:` is resolved by the caller, so these tests pass ids the way the app does. */
const scoped = (index: SearchIndex, query: string, folderIds: (string | null)[]) =>
  index.searchParsed(parseQuery(query), { folderIds: new Set(folderIds) });

describe('tokenize', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('keeps underscores and digits inside tokens', () => {
    expect(tokenize('auth_pool_42')).toEqual(['auth_pool_42']);
  });

  it('drops single characters', () => {
    expect(tokenize('a bb c ddd')).toEqual(['bb', 'ddd']);
  });

  it('handles non-latin scripts', () => {
    expect(tokenize('привет мир')).toEqual(['привет', 'мир']);
  });

  it('returns nothing for empty or symbol-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('--- *** ///')).toEqual([]);
  });
});

describe('SearchIndex', () => {
  it('finds notes by content', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres', 'SELECT from customers'));
    ix.add(doc('2', 'Docker', 'docker compose up'));

    expect(ix.search('customers').map((h) => h.id)).toEqual(['1']);
    expect(ix.search('compose').map((h) => h.id)).toEqual(['2']);
  });

  it('matches prefixes as you type', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres commands'));

    for (const q of ['po', 'pos', 'postg', 'postgres']) {
      expect(ix.search(q).map((h) => h.id)).toEqual(['1']);
    }
  });

  it('matches a single-character prefix', () => {
    // Shorter than the bucket key, so it takes the full-scan path.
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres'));
    expect(ix.search('p').map((h) => h.id)).toEqual(['1']);
  });

  it('ranks title matches above content matches', () => {
    const ix = new SearchIndex();
    ix.add(doc('mentions', 'Random note', 'I once used postgres here'));
    ix.add(doc('titled', 'Postgres commands', 'unrelated body'));

    expect(ix.search('postgres')[0]!.id).toBe('titled');
    expect(ix.search('postgres')[0]!.inTitle).toBe(true);
  });

  it('ANDs multiple terms', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres docker setup'));
    ix.add(doc('2', 'Postgres only'));
    ix.add(doc('3', 'Docker only'));

    expect(ix.search('postgres docker').map((h) => h.id)).toEqual(['1']);
  });

  it('returns nothing when one term matches nothing', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres'));
    expect(ix.search('postgres nonexistentterm')).toEqual([]);
  });

  it('breaks score ties by recency', () => {
    const ix = new SearchIndex();
    ix.add(doc('old', 'Notes', '', 1000));
    ix.add(doc('new', 'Notes', '', 2000));
    expect(ix.search('notes').map((h) => h.id)).toEqual(['new', 'old']);
  });

  it('prefers an exact token over a longer one that merely starts with it', () => {
    const ix = new SearchIndex();
    ix.add(doc('exact', 'test'));
    ix.add(doc('longer', 'testosterone'));
    expect(ix.search('test')[0]!.id).toBe('exact');
  });

  it('re-indexing a note drops words the user deleted', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Note', 'alpha bravo'));
    expect(ix.search('bravo').map((h) => h.id)).toEqual(['1']);

    ix.add(doc('1', 'Note', 'alpha charlie'));
    expect(ix.search('bravo')).toEqual([]);
    expect(ix.search('charlie').map((h) => h.id)).toEqual(['1']);
  });

  it('removing a note removes it from results', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres'));
    ix.remove('1');
    expect(ix.search('postgres')).toEqual([]);
    expect(ix.size).toBe(0);
  });

  it('reclaims tokens no note uses any more', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Unique zzzsentinel'));
    const withToken = ix.tokenCount;
    ix.remove('1');
    // Postings must not leak: an emptied token is deleted, not left behind.
    expect(ix.tokenCount).toBeLessThan(withToken);
    expect(ix.tokenCount).toBe(0);
  });

  it('returns nothing for an empty or symbol-only query', () => {
    const ix = new SearchIndex();
    ix.add(doc('1', 'Postgres'));
    expect(ix.search('')).toEqual([]);
    expect(ix.search('   ')).toEqual([]);
    expect(ix.search('!!!')).toEqual([]);
  });

  it('respects the result limit', () => {
    const ix = new SearchIndex();
    for (let i = 0; i < 100; i++) ix.add(doc(`n${i}`, `Note about postgres ${i}`));
    expect(ix.search('postgres', 10)).toHaveLength(10);
  });

  it('stays fast on a realistically large collection', () => {
    const ix = new SearchIndex();
    for (let i = 0; i < 2000; i++) {
      ix.add(
        doc(
          `n${i}`,
          `Note ${i} about shard${i % 97}`,
          `authpool_${i} hostname-${i}.internal.example.com deadbeef${i.toString(16)}`,
          i,
        ),
      );
    }

    const start = performance.now();
    for (let i = 0; i < 200; i++) ix.search('host');
    const perQuery = (performance.now() - start) / 200;

    // Generous versus the 0.6 ms Spike 3 measured; this is a regression guard,
    // not a benchmark.
    expect(perQuery).toBeLessThan(5);
  });
});

describe('SearchIndex tags', () => {
  it('counts tags across notes and forgets them when the last one goes', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', '#Work #home'));
    index.add(doc('b', 'B', '#work'));
    expect(index.tagSummary()).toEqual([
      { key: 'home', label: 'home', count: 1 },
      { key: 'work', label: 'Work', count: 2 },
    ]);

    index.add(doc('a', 'A', 'no tags now'));
    // The label is kept from whichever note wrote it first, while any note still does.
    expect(index.tagSummary()).toEqual([{ key: 'work', label: 'Work', count: 1 }]);
    index.remove('b');
    expect(index.tagSummary()).toEqual([]);
  });

  it('moves the version only when tags change', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', 'plain'));
    const v0 = index.tagVersion;
    index.add(doc('a', 'A', 'still plain'));
    expect(index.tagVersion).toBe(v0);

    index.add(doc('a', 'A', '#one'));
    const v1 = index.tagVersion;
    expect(v1).toBeGreaterThan(v0);
    index.add(doc('a', 'A', '#one with more words'));
    expect(index.tagVersion).toBe(v1);
    index.add(doc('a', 'A', '#two'));
    expect(index.tagVersion).toBeGreaterThan(v1);
  });

  it('lists a tag and its children, newest first', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', '#work', 1));
    index.add(doc('b', 'B', '#work/clients', 3));
    index.add(doc('c', 'C', '#workshop', 2));
    expect(index.idsForTag('work')).toEqual(['b', 'a']);
    expect(index.idsForTag('Work/Clients')).toEqual(['b']);
  });

  it('filters a query by #tag prefix, alone or with words', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'Postgres', 'tuning notes #work', 1));
    index.add(doc('b', 'Postgres at home', 'backups #home', 2));
    index.add(doc('c', 'Standup', '#work', 3));

    expect(index.search('#work').map((h) => h.id)).toEqual(['c', 'a']);
    expect(index.search('#wo').map((h) => h.id)).toEqual(['c', 'a']);
    expect(index.search('postgres #work').map((h) => h.id)).toEqual(['a']);
    expect(index.search('#work #home')).toEqual([]);
    expect(index.search('#nothing postgres')).toEqual([]);
    // Without the hash it is just a word, found in the text.
    expect(index.search('home').map((h) => h.id)).toEqual(['b']);
  });
});

describe('SearchIndex tag order', () => {
  it('sorts tags naturally, parents before children', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', '#t10 #t2 #work/clients #work #alpha'));
    expect(index.tagSummary().map((t) => t.key)).toEqual(['alpha', 't2', 't10', 'work', 'work/clients']);
  });
});

describe('SearchIndex folder scope', () => {
  const build = () => {
    const index = new SearchIndex();
    index.add(doc('a', 'Pool notes', 'connection pool', 3, 'work'));
    index.add(doc('b', 'Pool party', 'connection pool', 2, 'personal'));
    index.add(doc('c', 'Pool draft', 'connection pool', 1, null));
    return index;
  };

  it('keeps only notes in the scoped folders', () => {
    expect(scoped(build(), 'pool', ['work']).map((h) => h.id)).toEqual(['a']);
  });

  it('takes the union of several folders', () => {
    const ids = scoped(build(), 'pool', ['work', 'personal']).map((h) => h.id);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('treats null as unfiled, which is what in:/ means', () => {
    expect(scoped(build(), 'pool', [null]).map((h) => h.id)).toEqual(['c']);
  });

  it('excludes a folder with -in:', () => {
    const index = build();
    const hits = index.searchParsed(parseQuery('pool'), { notFolderIds: new Set(['work']) });
    expect(hits.map((h) => h.id).sort()).toEqual(['b', 'c']);
  });

  it('applies the limit after the folder filter, not before', () => {
    // The whole reason scoping lives in the index: a page-side post-filter
    // would see only the first `limit` hits and could return nothing.
    const index = new SearchIndex();
    for (let i = 0; i < 60; i++) {
      index.add(doc(`n${i}`, `Note ${i}`, 'shared word', i, i === 59 ? 'target' : 'other'));
    }
    const hits = index.searchParsed(parseQuery('shared'), {
      folderIds: new Set(['target']),
      limit: 5,
    });
    expect(hits.map((h) => h.id)).toEqual(['n59']);
  });

  it('combines a folder scope with a #tag and a word', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'Alpha', 'postgres #work', 1, 'code'));
    index.add(doc('b', 'Beta', 'postgres #work', 2, 'other'));
    index.add(doc('c', 'Gamma', 'postgres #home', 3, 'code'));
    expect(scoped(index, 'postgres #work', ['code']).map((h) => h.id)).toEqual(['a']);
  });

  it('scopes a query that has no words at all', () => {
    const index = build();
    expect(scoped(index, '', ['work'])).toEqual([]);
    // But a tag plus a scope does select, newest first.
    const tagged = new SearchIndex();
    tagged.add(doc('a', 'A', '#work', 1, 'f1'));
    tagged.add(doc('b', 'B', '#work', 2, 'f2'));
    expect(scoped(tagged, '#work', ['f2']).map((h) => h.id)).toEqual(['b']);
  });
});

describe('SearchIndex setFolder', () => {
  it('re-scopes a note without losing its words', () => {
    // The trap this method exists for: routing a move through `add()` would
    // need `content: ''`, and `add()` is remove-then-add.
    const index = new SearchIndex();
    index.add(doc('a', 'Postgres tuning', 'vacuum and autovacuum #db', 1, 'old'));

    index.setFolder('a', 'new');

    expect(scoped(index, 'autovacuum', ['new']).map((h) => h.id)).toEqual(['a']);
    expect(scoped(index, 'autovacuum', ['old'])).toEqual([]);
    // Still findable by every word, and still tagged.
    expect(index.search('autovacuum').map((h) => h.id)).toEqual(['a']);
    expect(index.search('postgres').map((h) => h.id)).toEqual(['a']);
    expect(index.search('#db').map((h) => h.id)).toEqual(['a']);
  });

  it('can move a note to unfiled', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', 'word', 1, 'f1'));
    index.setFolder('a', null);
    expect(scoped(index, 'word', [null]).map((h) => h.id)).toEqual(['a']);
  });

  it('ignores a note it has never seen', () => {
    const index = new SearchIndex();
    expect(() => index.setFolder('nope', 'f1')).not.toThrow();
    expect(index.size).toBe(0);
  });
});

describe('SearchIndex exclusion', () => {
  const build = () => {
    const index = new SearchIndex();
    index.add(doc('a', 'Postgres', 'tuning notes #work', 1));
    index.add(doc('b', 'Postgres draft', 'tuning notes #home', 2));
    index.add(doc('c', 'Postgres final', 'tuning notes #work', 3));
    return index;
  };

  it('drops notes matching an excluded word', () => {
    expect(build().search('postgres -draft').map((h) => h.id)).toEqual(['c', 'a']);
  });

  it('drops notes carrying an excluded tag', () => {
    expect(build().search('postgres -#home').map((h) => h.id)).toEqual(['c', 'a']);
  });

  it('excludes by tag prefix, as #tag includes by it', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', 'note #work/clients', 1));
    index.add(doc('b', 'B', 'note #home', 2));
    expect(index.search('note -#work').map((h) => h.id)).toEqual(['b']);
  });

  it('excludes by word prefix', () => {
    // `-draf` must drop `draft`, mirroring the positive side.
    expect(build().search('postgres -draf').map((h) => h.id)).toEqual(['c', 'a']);
  });

  it('finds nothing for a query that only excludes', () => {
    expect(build().search('-draft')).toEqual([]);
  });

  it('can exclude everything', () => {
    expect(build().search('postgres -tuning')).toEqual([]);
  });
});

describe('SearchIndex phrases', () => {
  it('narrows to notes holding every word of the phrase', () => {
    // Adjacency is the caller's to verify; the index gets the candidates.
    const index = new SearchIndex();
    index.add(doc('a', 'A', 'the connection pool is full', 1));
    index.add(doc('b', 'B', 'a pool of connection strings', 2));
    index.add(doc('c', 'C', 'connection only', 3));

    const ids = index.search('"connection pool"').map((h) => h.id);
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(ids).not.toContain('c');
  });

  it('is the escape hatch for a literal leading hash', () => {
    const index = new SearchIndex();
    // In a code span, so `extractTags` does not read it as a tag — which is
    // exactly the note an unquoted `#include` could never reach.
    index.add(doc('a', 'C header', 'use the `#include` directive', 1));
    index.add(doc('b', 'Tagged', 'notes #include', 2));

    // Unquoted this is a tag filter: only the note actually tagged.
    expect(index.search('#include').map((h) => h.id)).toEqual(['b']);
    // Quoted it is text, so it reaches the one that merely writes it.
    expect(index.search('"#include"').map((h) => h.id).sort()).toEqual(['a', 'b']);
  });

  it('does not exclude a phrase\'s words when the phrase is negated', () => {
    const index = new SearchIndex();
    index.add(doc('a', 'A', 'connection pool', 1));
    // `-"connection pool"` must not behave like `-connection -pool`.
    expect(index.search('connection -"connection pool"').map((h) => h.id)).toEqual(['a']);
  });
});
