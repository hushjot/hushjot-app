import { describe, expect, it } from 'vitest';

import { hasPositiveTerm, normalisePhrase, parseQuery } from '../../src/core/search/query.ts';

describe('parseQuery', () => {
  it('reads plain words as prefix terms', () => {
    const q = parseQuery('postgres tuning');
    expect(q.terms).toEqual(['postgres', 'tuning']);
    expect(q.notTerms).toEqual([]);
  });

  it('keeps #tag filtering exactly as it was', () => {
    const q = parseQuery('#work postgres');
    expect(q.tags).toEqual(['work']);
    expect(q.terms).toEqual(['postgres']);
  });

  it('lowercases everything', () => {
    const q = parseQuery('#Work IN:Code/Rust Postgres');
    expect(q.tags).toEqual(['work']);
    expect(q.folders).toEqual(['code/rust']);
    expect(q.terms).toEqual(['postgres']);
  });

  // --- phrases -------------------------------------------------------------

  it('lifts a quoted run as a phrase, not as words', () => {
    const q = parseQuery('"connection pool"');
    expect(q.phrases).toEqual(['connection pool']);
    expect(q.terms).toEqual([]);
  });

  it('collapses whitespace inside a phrase so it can span a line break', () => {
    expect(parseQuery('"connection\n  pool"').phrases).toEqual(['connection pool']);
  });

  it('is the escape hatch for a literal leading #', () => {
    const q = parseQuery('"#include"');
    expect(q.phrases).toEqual(['#include']);
    expect(q.tags).toEqual([]);
  });

  it('is the escape hatch for a literal leading -', () => {
    expect(parseQuery('"-foo"').phrases).toEqual(['-foo']);
    expect(parseQuery('"-foo"').notTerms).toEqual([]);
  });

  it('treats an unterminated quote as plain words', () => {
    // Re-parsed on every keystroke: a half-typed phrase must not blank the list.
    const q = parseQuery('"conn');
    expect(q.phrases).toEqual([]);
    expect(q.terms).toEqual(['conn']);
  });

  it('mixes a phrase with words and operators', () => {
    const q = parseQuery('#work "connection pool" postgres');
    expect(q.phrases).toEqual(['connection pool']);
    expect(q.tags).toEqual(['work']);
    expect(q.terms).toEqual(['postgres']);
  });

  it('ignores an empty phrase', () => {
    expect(parseQuery('"" postgres').phrases).toEqual([]);
    expect(parseQuery('"" postgres').terms).toEqual(['postgres']);
  });

  // --- folders -------------------------------------------------------------

  it('reads in: as a folder, leaving resolution to the caller', () => {
    const q = parseQuery('in:Work/DB postgres');
    expect(q.folders).toEqual(['work/db']);
    expect(q.terms).toEqual(['postgres']);
  });

  it('ignores a bare in: being typed', () => {
    expect(parseQuery('in:').folders).toEqual([]);
  });

  it('takes a quoted folder path, because folder names contain spaces', () => {
    // Without this the quote wins and `in:` is dropped, so this reads as a
    // phrase search for "my work" — plausible to type, silently wrong.
    const q = parseQuery('in:"My Work" postgres');
    expect(q.folders).toEqual(['my work']);
    expect(q.phrases).toEqual([]);
    expect(q.terms).toEqual(['postgres']);
  });

  it('negates a quoted folder path', () => {
    const q = parseQuery('-in:"Old Notes"');
    expect(q.notFolders).toEqual(['old notes']);
    expect(q.notPhrases).toEqual([]);
  });

  it('still reads a quote after ordinary text as a phrase', () => {
    // Only a bare `in:` / `-in:` token claims the quote; `foo-"bar"` does not.
    expect(parseQuery('foo-"bar"').phrases).toEqual(['bar']);
    expect(parseQuery('notin:"bar"').phrases).toEqual(['bar']);
  });

  // --- negation ------------------------------------------------------------

  it('negates a term, a tag, a folder and a phrase', () => {
    const q = parseQuery('-draft -#work -in:Archive -"connection pool"');
    expect(q.notTerms).toEqual(['draft']);
    expect(q.notTags).toEqual(['work']);
    expect(q.notFolders).toEqual(['archive']);
    expect(q.notPhrases).toEqual(['connection pool']);
  });

  it('only negates at the start of a token, so kebab-case survives', () => {
    const q = parseQuery('kebab-case');
    expect(q.terms).toEqual(['kebab', 'case']);
    expect(q.notTerms).toEqual([]);
  });

  it('does not read a mid-token quote as a negated phrase', () => {
    const q = parseQuery('foo-"bar"');
    expect(q.notPhrases).toEqual([]);
    expect(q.phrases).toEqual(['bar']);
  });

  it('leaves a lone hyphen alone', () => {
    expect(parseQuery('-').terms).toEqual([]);
    expect(parseQuery('-').notTerms).toEqual([]);
  });

  // --- the positive-set rule ----------------------------------------------

  it('says a negation-only query selects nothing', () => {
    expect(hasPositiveTerm(parseQuery('-draft'))).toBe(false);
    expect(hasPositiveTerm(parseQuery('-#work -in:Archive'))).toBe(false);
    expect(hasPositiveTerm(parseQuery(''))).toBe(false);
  });

  it('counts a term, a tag, a folder or a phrase as something to select', () => {
    expect(hasPositiveTerm(parseQuery('postgres'))).toBe(true);
    expect(hasPositiveTerm(parseQuery('#work'))).toBe(true);
    expect(hasPositiveTerm(parseQuery('in:Work -draft'))).toBe(true);
    expect(hasPositiveTerm(parseQuery('"connection pool"'))).toBe(true);
  });
});

describe('normalisePhrase', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normalisePhrase('  Connection\n\tPool  ')).toBe('connection pool');
  });
});
