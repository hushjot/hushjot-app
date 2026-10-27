/**
 * Syntax colours for a fenced code block, reached only by dynamic import.
 *
 * ## Why this is not in `render.ts`
 *
 * `LanguageDescription` comes from `@codemirror/language`, which imports
 * `@codemirror/view` and `@codemirror/state` — the whole editor runtime, about
 * 110 KB gzipped. Inside the app that costs nothing, because the editor is
 * loaded anyway. On the **share viewer** (`src/viewer/`) it was the entire
 * page: a recipient reading one note downloaded a text editor they cannot see,
 * and `bench/size.mjs` failed the viewer's budget by 47 KB the day that budget
 * existed.
 *
 * Splitting it costs nothing in behaviour because this path was always
 * asynchronous: a fence renders as plain text and is upgraded when its grammar
 * arrives. One more promise in front of that changes the order of nothing.
 *
 * Offline, the upgrade simply does not happen and the fence stays plain — which
 * is already what happens today, since the grammars themselves are a level
 * deeper than the service worker precaches (`tools/vite-plugin-sw.mjs`).
 *
 * ## Catalogue misses are memoised as an explicit `null`
 *
 * `ParseContext.getSkippingParser` re-parses when its promise settles, so an
 * unmemoised lookup would mint a fresh promise on every re-parse, forever. Same
 * trap as `markdownLean.ts`, same answer.
 */
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { LanguageDescription } from '@codemirror/language';
import { codeLanguages, findInCatalogue } from '../languages.ts';

const languages = new Map<string, LanguageDescription | null>();
const lookups = new Map<string, Promise<LanguageDescription | null>>();

function resolveLanguage(name: string): LanguageDescription | null | Promise<LanguageDescription | null> {
  const key = name.toLowerCase();
  if (languages.has(key)) return languages.get(key)!;
  const curated = LanguageDescription.matchLanguageName(codeLanguages, key, true);
  if (curated) {
    languages.set(key, curated);
    return curated;
  }
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = findInCatalogue(key)
      .catch(() => null)
      .then((desc) => {
        languages.set(key, desc);
        lookups.delete(key);
        return desc;
      });
    lookups.set(key, lookup);
  }
  return lookup;
}

export function highlightInto(code: HTMLElement, lang: string, text: string): void {
  const found = resolveLanguage(lang);
  if (found === null) return;
  if (found instanceof LanguageDescription && found.support) {
    paint(code, found, text);
    return;
  }
  void Promise.resolve(found)
    .then((desc) => (desc ? desc.load().then(() => desc) : null))
    .then((desc) => {
      if (desc) paint(code, desc, text);
    })
    .catch(() => {
      // A grammar that fails to load leaves the block as plain text.
    });
}

function paint(code: HTMLElement, desc: LanguageDescription, text: string): void {
  const support = desc.support;
  if (!support) return;
  let tree;
  try {
    tree = support.language.parser.parse(text);
  } catch {
    return;
  }
  const fragment = document.createDocumentFragment();
  let at = 0;
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > at) fragment.append(text.slice(at, from));
    const span = document.createElement('span');
    span.className = classes;
    span.textContent = text.slice(from, to);
    fragment.append(span);
    at = to;
  });
  if (at < text.length) fragment.append(text.slice(at));
  code.replaceChildren(fragment);
}
