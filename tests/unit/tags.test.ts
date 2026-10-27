import { describe, it, expect } from 'vitest';
import { extractTags, normaliseTag, tagMatches, tagTree } from '../../src/core/notes/tags.ts';
import { WELCOME_NOTE } from '../../src/ui/state/seed.ts';

const keys = (text: string) => extractTags(text).map((t) => t.key);

describe('extractTags', () => {
  it('finds tags at line start and after whitespace', () => {
    expect(keys('#work and #home\n  #indented-a-little')).toEqual(['work', 'home', 'indented-a-little']);
  });

  it('costs nothing for a note with no hash', () => {
    expect(extractTags('plain text only')).toEqual([]);
  });

  it('is not a heading, an anchor, a fragment or C#', () => {
    expect(keys('# Heading\n## Another')).toEqual([]);
    expect(keys('[install](#install)')).toEqual([]);
    expect(keys('see https://example.com/#frag')).toEqual([]);
    expect(keys('I write C# and F#')).toEqual([]);
    expect(keys('\\#escaped')).toEqual([]);
  });

  it('tags inside a heading still count', () => {
    expect(keys('## Plans #q3')).toEqual(['q3']);
  });

  it('needs a letter, and skips colours', () => {
    expect(keys('issue #123 and #2024')).toEqual([]);
    expect(keys('red is #ff0000, blue #1e90ff, short #fff0')).toEqual([]);
    expect(keys('#fade #cafe #abc')).toEqual(['fade', 'cafe', 'abc']);
    expect(keys('#v2 #2fa')).toEqual(['v2']);
  });

  it('ignores fenced code, both fence styles', () => {
    expect(keys('```c\n#include <stdio.h>\n```\n#real')).toEqual(['real']);
    expect(keys('~~~\n#nope\n~~~\n#yes')).toEqual(['yes']);
    // A shorter run does not close a longer fence.
    expect(keys('````\n```\n#nope\n````\n#yes')).toEqual(['yes']);
  });

  it('ignores an unclosed fence to the end', () => {
    expect(keys('#before\n```\n#after')).toEqual(['before']);
  });

  it('ignores indented code blocks but not continuation lines', () => {
    expect(keys('para\n\n    #!/bin/sh #nope\n\n#yes')).toEqual(['yes']);
    expect(keys('- item\n    #nested')).toEqual(['nested']);
  });

  it('ignores inline code spans', () => {
    expect(keys('run `#define X` then #real')).toEqual(['real']);
    expect(keys('``code with ` #tick`` #after')).toEqual(['after']);
  });

  it('handles Unicode', () => {
    expect(keys('#café #日本語 #Übung')).toEqual(['café', '日本語', 'übung']);
  });

  it('nests with slashes and trims trailing punctuation', () => {
    expect(keys('#work/clients #done/ #next- #a//b')).toEqual(['work/clients', 'done', 'next', 'a/b']);
  });

  it('is case-insensitive, keeping the first spelling', () => {
    expect(extractTags('#Work then #work then #WORK')).toEqual([{ key: 'work', label: 'Work' }]);
  });

  it('stops at punctuation', () => {
    expect(keys('(#paren) #end. #comma, #q?')).toEqual(['end', 'comma', 'q']);
  });

  it('caps the length', () => {
    expect(keys(`#${'a'.repeat(64)}`)).toHaveLength(1);
    expect(keys(`#${'a'.repeat(65)}`)).toEqual([]);
  });
});

describe('normaliseTag', () => {
  it('refuses what is only punctuation', () => {
    expect(normaliseTag('--')).toBeNull();
    expect(normaliseTag('_x')).toBe('_x');
  });
});

describe('tagMatches', () => {
  it('matches itself and its children, not its prefixes', () => {
    expect(tagMatches('work', 'work')).toBe(true);
    expect(tagMatches('work/clients', 'work')).toBe(true);
    expect(tagMatches('workshop', 'work')).toBe(false);
    expect(tagMatches('work', 'work/clients')).toBe(false);
  });
});

describe('the welcome note', () => {
  it('tags itself, and nothing else in it is a tag', () => {
    // The note is full of `#`: headings, `#ff0000`, `#12`, `[links](#anchor)`
    // and fenced code. Exactly one of them is meant to reach the sidebar.
    expect(extractTags(WELCOME_NOTE).map((t) => t.key)).toEqual(['getting-started']);
  });
});

describe('tagTree', () => {
  const tag = (key: string, label = key) => ({ key, label });

  it('indents a tag under a parent that is there, showing the last segment', () => {
    expect(tagTree([tag('work'), tag('work/clients'), tag('work/clients/acme')])).toEqual([
      { tag: tag('work'), depth: 0, name: 'work' },
      { tag: tag('work/clients'), depth: 1, name: 'clients' },
      { tag: tag('work/clients/acme'), depth: 2, name: 'acme' },
    ]);
  });

  it('shows a tag in full when no ancestor of it is a tag here', () => {
    expect(tagTree([tag('home/garden')])).toEqual([{ tag: tag('home/garden'), depth: 0, name: 'home/garden' }]);
  });

  it('counts only the ancestors that exist', () => {
    // `a` is a tag, `a/b` is not, so `a/b/c` sits one level in and keeps the
    // part below the parent that is actually shown.
    expect(tagTree([tag('a'), tag('a/b/c')])).toEqual([
      { tag: tag('a'), depth: 0, name: 'a' },
      { tag: tag('a/b/c'), depth: 1, name: 'b/c' },
    ]);
  });

  it('keeps the writer’s spelling', () => {
    expect(tagTree([tag('work', 'Work'), tag('work/clients', 'Work/Clients')])[1]).toEqual({
      tag: tag('work/clients', 'Work/Clients'),
      depth: 1,
      name: 'Clients',
    });
  });
});
