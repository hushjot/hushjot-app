/**
 * "Is this position prose?" — the one question the editor's text-derived
 * features all have to ask before they act.
 *
 * `#tags` (`hashtags.ts`) and `[[note links]]` (`wikiLink.ts`) both mean
 * nothing inside code: `#include` and `#!/bin/sh` are not the user organising
 * anything, and `[[i]][[j]]` in a C fence is an array index. Both need the same
 * answer, so it lives here rather than being written twice and drifting — the
 * same reason `core/notes/tags.ts` owns what a tag is.
 *
 * It reads the syntax tree rather than re-scanning for fences, because the tree
 * is already built and already knows that a line is inside a fence opened
 * eighty lines above it.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

/** Syntax nodes whose text is never prose. */
const NOT_PROSE = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'URL', 'Autolink', 'HTMLTag', 'Comment']);

export function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (NOT_PROSE.has(node.name)) return true;
  }
  return false;
}
