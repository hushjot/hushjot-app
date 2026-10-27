/**
 * Dragging a note into a folder, and a folder into a folder.
 *
 * Pure and DOM-free so it can be tested the way `rowSwipe.ts` is — the
 * components feed it a source, a target and the facts, and act on the verdict
 * that comes back. The rule table is where the bugs live, and the unit suite
 * runs in Node with no DOM, so it cannot reach this logic through a component.
 *
 * Re-parenting only. There is deliberately no reordering here: a manual rank
 * would have to live in the sealed meta, and `sealNote` in `@hushjot/cli`
 * builds that payload field by field over a full-replace write, so a rank the
 * CLI did not carry would be deleted from the note on every device the next
 * time `hushjot append` touched it. `src/core/public.ts` states the rule.
 * Folders are worse again: they have no `revision` and no compare-and-swap, so
 * two devices reordering at once resolve last-write-wins and the ranks collide
 * with no conflict copy. That trade was made on purpose.
 *
 * Three things about the wire format are load-bearing:
 *
 * 1. **The types are private and there is no `text/plain`.** CodeMirror
 *    installs its own drop handler and reads `text/plain`, so a drag that
 *    offered one would be inserted into the note as text the moment it crossed
 *    the editor.
 *
 * 2. **`Files` is somebody else's drag.** The capture-phase window handlers in
 *    `App.svelte` own file import and gate on `types.includes('Files')`. Our
 *    types never overlap, so the two drags pass through each other untouched
 *    and neither handler needed changing. `kindFromTypes` returning `null` for
 *    `['Files']` is what keeps that true.
 *
 * 3. **The kind travels as a type, not as data.** `dataTransfer.getData()`
 *    returns "" during `dragover` — browsers only expose the *names* of the
 *    formats until the drop, so that a page cannot read what is passing over
 *    it. A drop target has to decide whether to accept the drag long before it
 *    is allowed to see the id, so the kind is encoded in a second, empty
 *    entry whose presence in `types` is the whole message.
 */

/** Carries the payload. Read on drop, never during dragover. */
export const DRAG_MIME = 'application/x-hushjot-move';

export type DragKind = 'note' | 'folder';

export interface DragSource {
  kind: DragKind;
  id: string;
}

/**
 * One empty entry per kind. Readable from `types` during dragover, which is
 * the only thing a drop target is allowed to see while the drag is in flight.
 */
export const KIND_MIME: Record<DragKind, string> = {
  note: 'application/x-hushjot-note',
  folder: 'application/x-hushjot-folder',
};

export function encodeDrag(source: DragSource): string {
  return `${source.kind}:${source.id}`;
}

/**
 * `null` for anything that is not ours. A drop handler reads whatever the
 * platform hands it — another tab, another app, a malformed replay — so this
 * refuses rather than throws.
 */
export function decodeDrag(raw: string): DragSource | null {
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!id) return null;
  if (kind !== 'note' && kind !== 'folder') return null;
  return { kind, id };
}

/** Which of our drags this is, from `dataTransfer.types` alone. */
export function kindFromTypes(types: readonly string[]): DragKind | null {
  if (types.includes(KIND_MIME.note)) return 'note';
  if (types.includes(KIND_MIME.folder)) return 'folder';
  return null;
}

export type DropVerdict =
  /** Do it. */
  | 'move'
  /** Legal, but it would change nothing — the item is already there. */
  | 'noop'
  /** Refused: it would make a cycle. */
  | 'forbidden';

/**
 * Whether dropping `source` on `targetFolderId` (null is the top level) should
 * do anything.
 *
 * `canMove` is supplied by the caller rather than derived here, because
 * `canMoveFolder` in `src/core/notes/folders.ts` already answers it against
 * the live folder list and tolerates the parent cycles a concurrent sync can
 * produce. A second implementation would agree with it right up until it did
 * not.
 *
 * `noop` and `forbidden` are kept apart on purpose even though neither writes
 * anything: the cursor says `move` for one and `none` for the other, so
 * dropping a note back where it already is feels like a cancelled drag rather
 * than a refused one.
 */
export function dropVerdict(
  source: DragSource,
  targetFolderId: string | null,
  facts: { currentFolderId: string | null; canMove: boolean },
): DropVerdict {
  if (source.kind === 'folder') {
    // Itself, or anywhere inside itself. `canMoveFolder` is also false for a
    // folder that has gone missing under a concurrent delete.
    if (source.id === targetFolderId) return 'forbidden';
    if (!facts.canMove) return 'forbidden';
  }
  return facts.currentFolderId === targetFolderId ? 'noop' : 'move';
}
