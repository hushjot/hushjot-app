/**
 * Inline `#tags`, read from a note's text.
 *
 * ## Why derived rather than stored
 *
 * The same reasoning as the title (`model.ts`, `deriveTitle`): a tag field
 * beside the text is a second thing to sync, to conflict, and to lose on
 * export. Written into the Markdown, a tag survives a zip export, an import
 * into another app, and a copy to the clipboard, and it is on every device the
 * moment the text is. Nothing here is persisted or sent anywhere — the search
 * worker derives tags as it indexes (`core/search/index.ts`), and the page
 * only ever holds the names.
 *
 * ## What counts
 *
 * Bear and Obsidian's convention, so notes moving between them keep working:
 * `#` then a letter, digit or underscore, at the start of a line or after
 * whitespace. The whitespace rule is what keeps the rest of Markdown out —
 * `[link](#anchor)`, `example.com/#frag`, `C#`, `\#escaped` — and `# Heading`
 * has a space, so it was never a tag. Also refused:
 *
 * - anything without a letter (`#1`, `#2024`): issue and list numbers;
 * - CSS colours with a digit (`#ff0000`, `#1e90ff`) — `#fade` is a word;
 * - code: fenced blocks, indented blocks, and inline backtick spans, where
 *   `#include` and `#!/bin/sh` are not the user organising anything.
 *
 * `a/b` nests: it is one tag, and filtering by `a` also finds it.
 *
 * ## Cost
 *
 * Most notes have no `#` at all, and they pay one `indexOf`. The rest pay one
 * pass over their lines. Runs in the worker, never on the typing path.
 */

export interface Tag {
  /** Identity: lowercased, so `#Work` and `#work` are one tag. */
  key: string;
  /** How the user first wrote it. */
  label: string;
}

export const MAX_TAG_LENGTH = 64;

/**
 * A candidate tag and what precedes it. Shared with the editor's highlighter
 * and the preview, so all three agree on what a tag is; `normaliseTag` makes
 * the final call.
 */
export const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

const HAS_LETTER = /\p{L}/u;
const HEX_COLOUR = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HAS_DIGIT = /\d/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[^`]*?(?:`(?!\1)[^`]*?)*\1/g;

/**
 * The tag a matched body names, or null when it is not one. Trailing
 * punctuation that `TAG_PATTERN` admits (`#done/`, `#next-`) is dropped, and
 * empty nesting segments collapse (`#a//b` is `a/b`).
 */
export function normaliseTag(body: string): string | null {
  const label = body
    .split('/')
    .map((segment) => segment.replace(/-+$/, ''))
    .filter(Boolean)
    .join('/');
  if (!label || label.length > MAX_TAG_LENGTH) return null;
  if (!HAS_LETTER.test(label)) return null;
  if (HEX_COLOUR.test(label) && HAS_DIGIT.test(label)) return null;
  return label;
}

/** Tags in `content`, each once, in the order first written. */
export function extractTags(content: string): Tag[] {
  if (content.indexOf('#') === -1) return [];

  const out: Tag[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  let previousBlank = true;
  let inIndentedCode = false;

  for (const line of content.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      // A fence closes on a run of the same character at least as long.
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      previousBlank = false;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      previousBlank = false;
      continue;
    }

    const blank = line.trim() === '';
    const indented = /^(?: {4}|\t)/.test(line);
    // An indented block only starts after a blank line — otherwise it is a
    // paragraph's continuation, or a nested list item.
    inIndentedCode = !blank && indented && (previousBlank || inIndentedCode);
    previousBlank = blank;
    if (blank || inIndentedCode || line.indexOf('#') === -1) continue;

    const text = line.indexOf('`') === -1 ? line : line.replace(INLINE_CODE, (m) => ' '.repeat(m.length));
    for (const match of text.matchAll(TAG_PATTERN)) {
      const label = normaliseTag(match[2]!);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label });
    }
  }
  return out;
}

/** A tag as a list shows it: nested under a parent that exists, or in full. */
export interface TagRow<T> {
  tag: T;
  /** How many ancestors of this tag are themselves tags here. */
  depth: number;
  /** The last segment when it nests under a parent, else the whole label. */
  name: string;
}

/**
 * Lay tags out for a list. `#work/clients` shows as `clients`, indented, when
 * `#work` is there too, and in full when it is not — a tag is not a folder, so
 * there is no empty parent to invent for it.
 *
 * Shared by the sidebar and the Go to tag picker so the two cannot drift.
 */
export function tagTree<T extends { key: string; label: string }>(tags: readonly T[]): TagRow<T>[] {
  const keys = new Set(tags.map((t) => t.key));
  return tags.map((tag) => {
    let depth = 0;
    let name = tag.label;
    let parent = tag.key;
    for (let cut = parent.lastIndexOf('/'); cut > 0; cut = parent.lastIndexOf('/')) {
      parent = parent.slice(0, cut);
      if (!keys.has(parent)) continue;
      if (depth === 0) name = tag.label.slice(cut + 1);
      depth++;
    }
    return { tag, depth, name };
  });
}

/** True when a note tagged `key` belongs under the filter `filter`. */
export function tagMatches(key: string, filter: string): boolean {
  return key === filter || (key.length > filter.length && key.startsWith(filter) && key[filter.length] === '/');
}
