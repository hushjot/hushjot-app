/**
 * The curated registry and the catalogue fallback behind it.
 *
 * The memoisation test is the important one: an unmemoised fallback makes
 * `getSkippingParser` schedule a re-parse that mints a fresh promise that
 * schedules another re-parse, forever. A fence naming something that is not a
 * language must cost exactly one lookup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { LanguageDescription, ensureSyntaxTree } from '@codemirror/language';
import { codeLanguages, findInCatalogue } from '../../src/editor/languages.ts';
import { markdownLean, resetLanguageCache } from '../../src/editor/markdownLean.ts';
import {
  fenceLanguageCompletion,
  resetLanguageCompletions,
} from '../../src/editor/languageCompletion.ts';

const match = (name: string) =>
  LanguageDescription.matchLanguageName([...codeLanguages], name, true)?.name ?? null;

describe('curated aliases', () => {
  it('resolves the short forms people actually type', () => {
    expect(match('rs')).toBe('rust');
    expect(match('kt')).toBe('kotlin');
    expect(match('kts')).toBe('kotlin');
    expect(match('c#')).toBe('csharp');
    expect(match('psql')).toBe('sql');
    expect(match('py')).toBe('python');
    expect(match('yml')).toBe('yaml');
    expect(match('zsh')).toBe('shell');
  });

  it('matches the canonical names case-insensitively', () => {
    expect(match('Rust')).toBe('rust');
    expect(match('PYTHON')).toBe('python');
  });

  it('covers every language the welcome note advertises', () => {
    for (const name of ['rust', 'python', 'typescript', 'go', 'java', 'kotlin', 'swift', 'yaml']) {
      expect(match(name)).not.toBeNull();
    }
  });
});

describe('catalogue fallback', () => {
  it('finds languages the curated list does not carry', async () => {
    expect(match('ruby')).toBeNull();
    expect(match('dockerfile')).toBeNull();

    expect((await findInCatalogue('ruby'))?.name).toBe('Ruby');
    expect((await findInCatalogue('haskell'))?.name).toBe('Haskell');
    expect((await findInCatalogue('php'))?.name).toBe('PHP');
  });

  it('returns null for something that is not a language', async () => {
    expect(await findInCatalogue('notalanguage')).toBeNull();
  });
});

describe('unknown-language memoisation', () => {
  beforeEach(() => resetLanguageCache());

  const parse = (doc: string, resolveUnknown: (n: string) => Promise<LanguageDescription | null>) => {
    const state = EditorState.create({
      doc,
      extensions: [markdownLean({ codeLanguages, resolveUnknown })],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
  };

  it('asks once for an unknown name and caches the miss across re-parses', async () => {
    const asked: string[] = [];
    const resolveUnknown = async (name: string) => {
      asked.push(name);
      return null;
    };

    parse('```notalanguage\nx = 1\n```\n', resolveUnknown);
    expect(asked).toEqual(['notalanguage']);

    // Let the lookup settle, then re-parse exactly as CodeMirror would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    parse('```notalanguage\nx = 1\n```\n', resolveUnknown);
    parse('```notalanguage\nx = 1\n```\n', resolveUnknown);

    // Still one: the negative is what breaks the re-parse cycle.
    expect(asked).toEqual(['notalanguage']);
  });

  it('never consults the fallback for a curated language', async () => {
    let calls = 0;
    parse('```rust\nfn main() {}\n```\n', async () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
  });
});

describe('fence language completion', () => {
  beforeEach(() => resetLanguageCompletions());

  const complete = (doc: string) => {
    const state = EditorState.create({ doc });
    const context = { state, pos: doc.length, explicit: true } as never;
    return fenceLanguageCompletion(context);
  };

  it('stays out of the way in prose', () => {
    expect(complete('just some ordinary writing')).toBeNull();
    expect(complete('- a list item')).toBeNull();
    expect(complete('# A heading')).toBeNull();
    expect(complete('text with `inline code`')).toBeNull();
  });

  it('offers the whole registry in an empty info slot', async () => {
    const result = await complete('```');
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain('rust');
    expect(labels).toContain('kotlin');
    expect(labels).toContain('ruby');
    expect(labels).toContain('dockerfile');
  });

  it('anchors the completion at the start of the partial name', async () => {
    const result = await complete('```ru');
    expect(result!.from).toBe(3);
  });

  it('offers no label containing whitespace', async () => {
    const result = await complete('```');
    expect(result!.options.every((o) => !/\s/.test(o.label))).toBe(true);
  });

  it('indents-aware: works on a fence inside a list', async () => {
    expect(await complete('  ```')).not.toBeNull();
  });
});
