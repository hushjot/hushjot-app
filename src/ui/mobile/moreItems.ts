/**
 * Builds the phone's More sheets from the command registry.
 *
 * The desktop topbar can carry theme, text size, account, sync and lock as
 * icons because a mouse can hit a 30px target. A thumb cannot, so on a phone
 * those move into a sheet of 44px rows — which means something has to turn a
 * list of command ids into `RowAction`s, and that something should not be
 * another hundred lines inside `App.svelte`.
 *
 * It is a pure function so the one thing worth gating is gateable: that every
 * id named here is a real command. A typo would otherwise be a menu row that
 * silently does nothing, on the only surface where the command has no
 * keyboard shortcut to fall back on.
 *
 * Reachability, not preference, decides what appears: `available()` already
 * refuses `desktopOnly` commands on a phone (`App.svelte`), so tiling and
 * split never show up here without this file knowing anything about them.
 */
import type { RowAction } from '../RowActions.svelte';
import { COMMANDS, hint } from '../shortcuts.ts';

/**
 * `Command.id` is a plain string in the registry, so this is documentation
 * rather than a compiler check — `moreItems.test.ts` is what actually gates a
 * typo, by asserting every id below resolves to a real command.
 */
type CommandId = string;

/**
 * The list screen's More sheet: everything that acts on the app or the
 * library rather than on one note.
 */
export const PHONE_MORE_LIST: readonly CommandId[] = [
  'new-folder',
  'new-subfolder',
  'rename-folder',
  'move-folder',
  'go-to-folder',
  'go-to-tag',
  'sort-notes',
  'recently-deleted',
  'export-import',
  'export-all',
  'shared-links',
  'sync',
  'toggle-theme',
  'theme-system',
  'account',
  'palette',
  'lock',
  'delete-folder',
];

/**
 * The note screen's More sheet. The per-note actions (copy, move, pin,
 * export, history, delete) stay on the row `⋯`, which this sheet sits beside
 * rather than duplicating — except that on the editor screen there is no row
 * to reach, so they are here too.
 */
export const PHONE_MORE_NOTE: readonly CommandId[] = [
  'follow-link',
  'copy-note',
  'move-note',
  'pin-note',
  'export-note',
  'share-note',
  'note-history',
  'previous-note',
  // One row where there were three. `text-bigger`/`-smaller`/`-reset` each
  // closed the sheet on press, so stepping twice meant opening it twice and
  // the size was never shown; the Appearance menu carries both the number and
  // the font, and the three commands keep their keys for an iPad with one.
  'appearance',
  'toggle-spellcheck',
  'toggle-theme',
  'theme-system',
  'account',
  'palette',
  'lock',
  'delete-note',
];

const DANGER: ReadonlySet<CommandId> = new Set(['delete-note', 'delete-folder']);

export interface MoreContext {
  /** `App.svelte`'s `available()` — the single authority on reachability. */
  available: (id: CommandId) => boolean;
  run: (id: CommandId) => void;
  /**
   * The current value a row's command would change, appended to its label.
   *
   * The desktop puts the text size in the topbar where it is always on
   * screen; a phone has no room for that, and a row reading only "Appearance"
   * makes the reader open a sheet to learn a number they could have been
   * shown. Only the value belongs here — the label still comes from the
   * registry, so the two surfaces cannot drift on what the command is called.
   */
  detail?: (id: CommandId) => string | undefined;
}

/**
 * Turn ids into menu rows, dropping anything not currently reachable.
 *
 * Each row captures its own id as a plain value, because `RowActions` runs an
 * item's `run` *after* the menu has closed — anything read from reactive
 * state at that point is already gone.
 */
export function moreItems(ids: readonly CommandId[], ctx: MoreContext): RowAction[] {
  const out: RowAction[] = [];
  for (const id of ids) {
    if (!ctx.available(id)) continue;
    const command = COMMANDS.find((c) => c.id === id);
    if (!command) continue;
    const captured = id;
    const detail = ctx.detail?.(captured);
    out.push({
      label: detail ? `${command.label} — ${detail}` : command.label,
      hint: hint(captured) || undefined,
      danger: DANGER.has(captured) || undefined,
      run: () => ctx.run(captured),
    });
  }
  return out;
}
