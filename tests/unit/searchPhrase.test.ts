import { describe, expect, it, vi } from 'vitest';

import { SearchIndex } from '../../src/core/search/index.ts';
import { parseQuery } from '../../src/core/search/query.ts';
import { VERIFY_MAX, verifyPhrases } from '../../src/core/search/phrase.ts';

/** The index's candidates for `query`, as the worker asks for them. */
const candidatesFor = (bodies: Record<string, string>, query: string) => {
  const index = new SearchIndex();
  let stamp = 0;
  for (const [id, content] of Object.entries(bodies)) {
    index.add({ id, title: id, content, updatedAt: stamp++, folderId: null });
  }
  return index.searchParsed(parseQuery(query), { limit: VERIFY_MAX });
};

const reader = (bodies: Record<string, string>) => async (id: string) => bodies[id] ?? null;

describe('verifyPhrases', () => {
  it('keeps only notes where the words are adjacent', async () => {
    const bodies = {
      a: 'the connection pool is full',
      b: 'a pool of connection strings', // both words, wrong order
      c: 'connection pool again',
    };
    const parsed = parseQuery('"connection pool"');

    // The index cannot tell these apart — that is why verification exists.
    expect(candidatesFor(bodies, '"connection pool"').map((h) => h.id).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);

    const hits = await verifyPhrases(candidatesFor(bodies, '"connection pool"'), parsed, 50, reader(bodies));
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'c']);
  });

  it('matches across a line break, because a phrase is whitespace-collapsed', async () => {
    const bodies = { a: 'the connection\n   pool is full' };
    const hits = await verifyPhrases(
      candidatesFor(bodies, '"connection pool"'),
      parseQuery('"connection pool"'),
      50,
      reader(bodies),
    );
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('is case-insensitive', async () => {
    const bodies = { a: 'The Connection Pool' };
    const hits = await verifyPhrases(
      candidatesFor(bodies, '"connection pool"'),
      parseQuery('"connection pool"'),
      50,
      reader(bodies),
    );
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('drops a note containing an excluded phrase', async () => {
    const bodies = {
      a: 'connection pool notes',
      b: 'connection pool notes, but this one is a draft copy',
    };
    const parsed = parseQuery('"connection pool" -"draft copy"');
    const hits = await verifyPhrases(candidatesFor(bodies, '"connection pool"'), parsed, 50, reader(bodies));
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('preserves the order the index chose', async () => {
    const bodies = { a: 'connection pool', b: 'connection pool' };
    const candidates = candidatesFor(bodies, '"connection pool"');
    const hits = await verifyPhrases(candidates, parseQuery('"connection pool"'), 50, reader(bodies));
    expect(hits.map((h) => h.id)).toEqual(candidates.map((h) => h.id));
  });

  it('stops reading bodies once it has enough hits', async () => {
    // The early exit is what keeps a phrase query bounded: without it, every
    // candidate is decrypted whether or not the caller will ever show it.
    const bodies: Record<string, string> = {};
    for (let i = 0; i < 100; i++) bodies[`n${i}`] = 'connection pool';

    const load = vi.fn(reader(bodies));
    const hits = await verifyPhrases(
      candidatesFor(bodies, '"connection pool"'),
      parseQuery('"connection pool"'),
      5,
      load,
    );

    expect(hits).toHaveLength(5);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('never opens more than VERIFY_MAX bodies', async () => {
    // Many notes hold both words, none adjacently: the pathological case the
    // cap exists for. The answer is bounded rather than complete, by design.
    const bodies: Record<string, string> = {};
    for (let i = 0; i < 400; i++) bodies[`n${i}`] = 'pool of connection strings';

    const load = vi.fn(reader(bodies));
    const hits = await verifyPhrases(
      candidatesFor(bodies, '"connection pool"'),
      parseQuery('"connection pool"'),
      50,
      load,
    );

    expect(hits).toEqual([]);
    expect(load).toHaveBeenCalledTimes(VERIFY_MAX);
  });

  it('skips a body it cannot read without failing the query', async () => {
    const bodies: Record<string, string> = { a: 'connection pool', b: 'connection pool' };
    const load = async (id: string) => {
      if (id === 'a') throw new Error('unreadable');
      return bodies[id] ?? null;
    };
    const hits = await verifyPhrases(
      candidatesFor(bodies, '"connection pool"'),
      parseQuery('"connection pool"'),
      50,
      load,
    );
    expect(hits.map((h) => h.id)).toEqual(['b']);
  });

  it('treats a missing body as no match', async () => {
    const hits = await verifyPhrases(
      candidatesFor({ a: 'connection pool' }, '"connection pool"'),
      parseQuery('"connection pool"'),
      50,
      async () => null,
    );
    expect(hits).toEqual([]);
  });
});
