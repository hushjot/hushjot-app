/**
 * Lean Markdown language support for HushJot.
 *
 * Why not `@codemirror/lang-markdown`? It statically imports
 * `@codemirror/lang-html`, which statically imports `@codemirror/lang-css` and
 * `@codemirror/lang-javascript`. Using it forces three full grammars into the
 * startup bundle no matter how carefully we lazy-load everything else, which
 * defeats §28 and blows the critical-path budget. Measured in bench/RESULTS.md.
 *
 * This module builds the same thing directly on `@lezer/markdown` (which
 * depends only on `@lezer/common` and `@lezer/highlight`) and keeps every code
 * grammar behind a dynamic import.
 *
 * Covers the §10 requirement list: headings, bold, italic, strikethrough,
 * links, lists, numbered lists, blockquotes, inline code, fenced code blocks,
 * horizontal rules, tables and task lists. Highlight tags ship with
 * `@lezer/markdown` itself, so `syntaxHighlighting(...)` styles all of them.
 */
import {
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
  defineLanguageFacet,
  languageDataProp,
  foldNodeProp,
  foldService,
  indentNodeProp,
  syntaxTree,
} from '@codemirror/language';
import { NodeProp, type Parser } from '@lezer/common';
import { parser as baseParser, GFM, parseCode } from '@lezer/markdown';
import { noteLinks } from './noteLinkSyntax.ts';
import { extendedSyntax } from './extendedSyntax.ts';
import type { Extension } from '@codemirror/state';

const data = defineLanguageFacet({
  commentTokens: { block: { open: '<!--', close: '-->' } },
  // Bracket auto-close, configured here because `closeBrackets` takes no
  // options: it reads `closeBrackets` out of the language data at the cursor
  // on every keystroke, so the language is the only place to set it.
  //
  // `'` is deliberately absent from a set the default includes. In prose an
  // apostrophe is far commoner than a quote, and the default would write
  // `''tis`, `''em` and `''90s`. Typing `'` over a *selection* still quotes it
  // -- that is `wrapSelectionInput` in `formatKeys.ts`, which only ever fires
  // on a non-empty selection and so cannot touch `don't`.
  //
  // This is the prose set. A fence's own language supplies its own, because
  // `languageDataAt` resolves at the cursor's innermost node, so code in a
  // fence keeps code rules -- including the `'` this drops.
  closeBrackets: { brackets: ['(', '[', '{', '"'] },
});

const headingProp = new NodeProp<number>();

function isHeading(type: { name: string }): number | undefined {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(type.name);
  return match ? +match[1]! : undefined;
}

function isList(type: { name: string }): boolean {
  return type.name === 'OrderedList' || type.name === 'BulletList';
}

/** Folding a heading folds through to the next heading of equal or higher rank. */
function findSectionEnd(headerNode: NonNullable<ReturnType<typeof syntaxTree>['topNode']>, level: number): number {
  let last = headerNode;
  for (;;) {
    const next: typeof last | null = last.nextSibling;
    if (!next) break;
    const heading = isHeading(next.type);
    if (heading != null && heading <= level) break;
    last = next;
  }
  return last.to;
}

const headerIndent = foldService.of((state, start, end) => {
  for (let node = syntaxTree(state).resolveInner(end, -1); node; node = node.parent!) {
    if (node.from < start) break;
    const heading = node.type.prop(headingProp);
    if (heading == null) continue;
    const upto = findSectionEnd(node, heading);
    if (upto > end) return { from: end, to: upto };
    if (!node.parent) break;
  }
  return null;
});

const withProps = baseParser.configure([
  GFM, // tables, task lists, strikethrough, autolinks
  // `[[Note links]]`. The SAME extension goes into `preview/model.ts`'s own
  // `configure` call, and `noteLinkSyntax.ts` says why adding it to one and not
  // the other fails silently — the editor would colour a link the preview
  // rendered as brackets.
  noteLinks,
  // Highlight, sub/superscript, emoji, heading ids, footnotes, definition
  // lists: the same array `preview/model.ts` spreads, for the same reason.
  ...extendedSyntax,
  {
    props: [
      foldNodeProp.add((type) =>
        !type.is('Block') || type.is('Document') || isHeading(type) != null || isList(type)
          ? undefined
          : (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
      ),
      headingProp.add(isHeading),
      indentNodeProp.add({ Document: () => null }),
      languageDataProp.add({ Document: data }),
      foldNodeProp.add({
        Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
      }),
    ],
  },
]);

/**
 * Resolve a fence info string to a parser, loading the grammar on first
 * sighting. Until the dynamic import resolves the region is skipped, and
 * CodeMirror re-parses automatically once it lands — so a paste of unfamiliar
 * code highlights a frame or two later instead of blocking startup.
 *
 * Names that miss the curated registry fall through to `resolveUnknown`, which
 * reaches the ~130-language catalogue. That fallback MUST be memoised, and the
 * misses memoised too. `ParseContext.getSkippingParser(until)` schedules a
 * re-parse when `until` settles; if every re-parse minted a fresh promise, that
 * re-parse would mint another, forever. `resolved` holding an explicit `null`
 * for a name the catalogue does not know is what terminates the loop — a fence
 * reading ```notalanguage must cost exactly one lookup, not a spin.
 */
const resolved = new Map<string, LanguageDescription | null>();
const pending = new Map<string, Promise<unknown>>();

function lazyCodeParser(
  registry: readonly LanguageDescription[],
  resolveUnknown?: (name: string) => Promise<LanguageDescription | null>,
): (info: string) => Parser | null {
  const parserFor = (desc: LanguageDescription): Parser =>
    desc.support
      ? desc.support.language.parser
      : ParseContext.getSkippingParser(desc.load());

  return (info: string) => {
    if (!info) return null;
    const name = /\S*/.exec(info)![0]!;
    if (!name) return null;

    const found = LanguageDescription.matchLanguageName(registry as LanguageDescription[], name, true);
    if (found) return parserFor(found);
    if (!resolveUnknown) return null;

    // Settled outcome, including the negative that stops the re-parse cycle.
    if (resolved.has(name)) {
      const cached = resolved.get(name)!;
      return cached ? parserFor(cached) : null;
    }

    // One in-flight lookup per name, shared by every fence naming it.
    let lookup = pending.get(name);
    if (!lookup) {
      lookup = resolveUnknown(name)
        .then(async (desc) => {
          // Load before publishing, so the re-parse finds a ready grammar
          // rather than scheduling a second skip.
          if (desc) await desc.load();
          resolved.set(name, desc);
        })
        .catch(() => {
          // A failed chunk fetch is a miss, not a retry loop.
          resolved.set(name, null);
        })
        .finally(() => {
          pending.delete(name);
        });
      pending.set(name, lookup);
    }
    return ParseContext.getSkippingParser(lookup);
  };
}

export interface MarkdownLeanConfig {
  /** Code grammars, each behind a dynamic import. */
  codeLanguages?: readonly LanguageDescription[];
  /**
   * Fallback for a fence naming a language the registry above does not carry.
   * Injected rather than imported so this module stays testable without
   * pulling the grammar catalogue into a unit test.
   */
  resolveUnknown?: (name: string) => Promise<LanguageDescription | null>;
  extensions?: Extension[];
}

/** Test seam: drop the memo tables so each case starts from a cold cache. */
export function resetLanguageCache(): void {
  resolved.clear();
  pending.clear();
}

export function markdownLean(config: MarkdownLeanConfig = {}): LanguageSupport {
  const { codeLanguages = [], resolveUnknown, extensions = [] } = config;
  const parser = withProps.configure([
    parseCode({ codeParser: lazyCodeParser(codeLanguages, resolveUnknown) }),
  ]);
  const language = new Language(data, parser, [headerIndent], 'markdown');
  return new LanguageSupport(language, extensions);
}
