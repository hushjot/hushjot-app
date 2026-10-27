/**
 * `[[Note links]]` — a reference from one note to another, read from the text.
 *
 * ## Why a resolution and not a pointer
 *
 * A note has no title field: `deriveTitle` takes the first line with content
 * (`model.ts`), and `portability/exportTree.ts` says outright that titles are
 * not unique. So `[[Design Review]]` cannot name a note the way a path names a
 * file. It names a *title*, and which note that is gets decided when the link
 * is followed — `notesMatching` in `model.ts` does it, against the in-memory
 * meta list the sidebar already holds.
 *
 * That is not a compromise, it is what keeps the feature free. A resolved note
 * id stored beside the text would be a new sealed field, and a new sealed field
 * means a `contract/format-vectors.json` case and a coordinated `@hushjot/cli`
 * release (`core/public.ts` states the rule) — for something the reader can
 * already see in the text. Kept as text, a link survives a zip export into
 * Obsidian, an import back, and a copy to the clipboard: the same argument
 * `tags.ts` makes about `#tags`.
 *
 * The cost of that choice, stated rather than hidden: **a link rots when the
 * first line of its target changes**, because that is what renames a note here.
 * Obsidian rewrites links on rename; there is nothing to rewrite when the
 * rename *is* the edit, and rewriting other notes' bodies from a keystroke is
 * what §7 forbids. So the app makes the miss useful instead — an unresolved
 * link offers to create the note it names (`App.svelte`, `followLink`).
 *
 * ## What counts
 *
 * Obsidian's convention, so notes moving between them keep working:
 * `[[target]]` or `[[target|label]]`, split on the first `|`. Refused, each
 * falling back to the literal brackets the preview has always rendered:
 *
 * - a body holding `[` or `]`, so `[[a[b]]` stays text and a stray bracket
 *   cannot swallow the rest of a line;
 * - a body spanning a newline, because a link is a label, not a paragraph;
 * - an empty target (`[[]]`, `[[|x]]`);
 * - anything over `MAX_LINK_TARGET`, because this runs on the typing path.
 *
 * Whitespace inside the target collapses, so `[[ My   Note ]]` and `[[My Note]]`
 * are one reference. Case and accents are settled later, by the collator
 * `notesMatching` shares with the title sort — so the link and the sidebar
 * cannot disagree about what "the same title" means.
 *
 * ## Cost
 *
 * One `parseLinkBody` per `[[` the grammar meets, over a string the grammar has
 * already bounded to one line and `MAX_LINK_TARGET` characters. A note with no
 * `[[` in it pays nothing: the inline parser is offered only `[` characters.
 */

/**
 * The syntax cap, and deliberately larger than `MAX_TITLE` (120): a link to a
 * title longer than that is a miss, not a parse error, and it should read as a
 * link that found nothing rather than as brackets.
 */
export const MAX_LINK_TARGET = 200;

export interface NoteLink {
  /** The title being referenced, whitespace-collapsed. */
  target: string;
  /** What the preview shows. The target itself unless `|` gave a label. */
  label: string;
}

/**
 * The link a `[[…]]` body names, or null when it is not one.
 *
 * `body` excludes the brackets: finding them is the grammar's job
 * (`editor/wikiLink.ts`), and it is the only caller that has them.
 */
export function parseLinkBody(body: string): NoteLink | null {
  if (body.length > MAX_LINK_TARGET) return null;
  // A newline would let a link cross a paragraph, and a bracket would let one
  // swallow whatever follows. Checked before the split, so neither can hide in
  // the label half either.
  if (/[[\]\n]/.test(body)) return null;

  // The first `|` only. A title cannot contain one, a label may, and taking the
  // remainder whole is what makes `[[a|b|c]]` mean the label `b|c`.
  const bar = body.indexOf('|');
  const target = collapse(bar === -1 ? body : body.slice(0, bar));
  if (!target) return null;

  // An empty label is a typo, not a request for an invisible link.
  const label = bar === -1 ? target : collapse(body.slice(bar + 1)) || target;
  return { target, label };
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
