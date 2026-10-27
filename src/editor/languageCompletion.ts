/**
 * The language pick-list for a fence's info slot.
 *
 * Nothing in the product otherwise tells a user that `kotlin`, `dockerfile` or
 * `haskell` highlight — the welcome note can only name a handful. This turns
 * the registry into something you can browse at the moment you need it.
 *
 * §7 governs the shape. This source runs on every keystroke the autocompleter
 * sees, and the overwhelming majority of them are prose, so the gate is one
 * regex against the text left of the cursor on a single line, then an immediate
 * null. Nothing is allocated and no syntax tree is consulted on that path.
 *
 * The option list is built once and cached. The first build awaits the
 * ~130-language catalogue chunk — that is the only await, it happens at most
 * once per session, and it happens while the user is sitting in a fence info
 * slot rather than while they are typing prose.
 *
 * Labels come from `LanguageDescription.alias`, not from `name`: alias already
 * holds the lowercased name plus every alias, and those are precisely the
 * strings `matchLanguageName` matches exactly. Aliases containing whitespace
 * (the catalogue has a few, e.g. "common lisp") are dropped — a fence info
 * string is a single token, so they could never resolve.
 */
import type { LanguageDescription } from '@codemirror/language';
import type {
  Completion,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { codeLanguages } from './languages.ts';

/** A fence opener plus the partial language name, anchored at the cursor. */
const INFO_SLOT = /^[ \t]*(?:`{3,}|~{3,})([\w+#.-]*)$/;

/** What may follow without re-running the source. */
const VALID_FOR = /^[\w+#.-]*$/;

let cached: Completion[] | null = null;
let building: Promise<Completion[]> | null = null;

function collect(
  descs: readonly LanguageDescription[],
  into: Map<string, Completion>,
  boost: number,
): void {
  for (const desc of descs) {
    for (const alias of desc.alias) {
      if (/\s/.test(alias) || into.has(alias)) continue;
      into.set(alias, {
        label: alias,
        type: 'keyword',
        // Aliases are opaque on their own; say what they resolve to.
        ...(alias === desc.name.toLowerCase() ? {} : { detail: desc.name }),
        boost,
      });
    }
  }
}

async function buildOptions(): Promise<Completion[]> {
  const byLabel = new Map<string, Completion>();

  // Curated first, and boosted: these are the languages with hand-checked
  // aliases, and inserting them ahead of the catalogue means `sql` wins over
  // the catalogue's several SQL dialects.
  collect(codeLanguages, byLabel, 1);

  try {
    const { languages } = await import('@codemirror/language-data');
    collect(languages, byLabel, 0);
  } catch {
    // The catalogue is an enhancement; the curated list still stands.
  }

  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const fenceLanguageCompletion: CompletionSource = (context) => {
  const line = context.state.doc.lineAt(context.pos);
  const match = INFO_SLOT.exec(line.text.slice(0, context.pos - line.from));
  if (!match) return null;

  const from = context.pos - match[1]!.length;

  if (cached) {
    return { from, options: cached, validFor: VALID_FOR } satisfies CompletionResult;
  }

  building ??= buildOptions().then((options) => (cached = options));
  return building.then((options) => ({ from, options, validFor: VALID_FOR }));
};

/** Test seam: forget the built list so a case can start cold. */
export function resetLanguageCompletions(): void {
  cached = null;
  building = null;
}
