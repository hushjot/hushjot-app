/**
 * Every app-level command, and the keys that run it.
 *
 * One registry rather than chords scattered through components, because three
 * things read the same list and must never disagree: the keyboard dispatcher
 * in `App.svelte`, the command palette (`>` in the finder), and the tests that
 * prove no app chord collides with the editor's keymap and that the welcome
 * note names only keys that exist.
 *
 * ## Why a leader key
 *
 * A browser tab has very few two-key chords left to give. Chrome never lets a
 * page take ⌘N/T/W or their Shift forms; ⌘1–9 switch tabs; ⌘⌥←/→ switch tabs
 * on a Mac; ⌘⇧I/J/C open DevTools; Ctrl+Alt+letter is AltGr on Polish, German
 * and other European layouts, so binding one breaks typing ś or €. CodeMirror
 * and `formatKeys.ts` hold most of what remains. Giving each of ~25 actions
 * its own chord would mean a per-browser footnote on half of them.
 *
 * So the long tail sits behind ⌘J / Ctrl+J followed by one plain key, the way
 * VS Code puts its rarer commands behind Ctrl+K. No browser binds the second
 * key, a hint lists them if the user pauses, and a sequence is still two
 * keystrokes. ⌘J itself is Chrome's and Firefox's downloads shortcut, which —
 * unlike ⌘N — a page is allowed to take back.
 *
 * The most frequent actions keep direct chords as well: ⌘P, ⌘N, ⌘S, ⌘\ and
 * the text-size keys. ⌘⇧P is the palette by VS Code convention, but Firefox
 * keeps it for a private window, so F1 and typing `>` in ⌘P are the paths that
 * always work — the same shape as ⌘N having ⌘J N behind it.
 *
 * Pure apart from reading `navigator` once: no Svelte, so the tests import it
 * directly.
 */

export type CommandGroup = 'Notes' | 'Folders' | 'Tiles and view' | 'App';

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Direct chords in CodeMirror key syntax (`Mod-s`, `Mod-Shift-p`, `F1`). */
  chords?: readonly string[];
  /**
   * The key pressed after the leader; `event.key`, so `D` means Shift+D. A
   * letter's case comes from Shift alone (`matchLeader`), so Caps Lock is moot.
   */
  leader?: string;
  /** Meaningless on a phone, which shows one note and no sidebar. */
  desktopOnly?: boolean;
}

/** The leader chord. Not a command itself: it arms the next key. */
export const LEADER_CHORD = 'Mod-j';

export const COMMANDS: readonly Command[] = [
  // Notes
  { id: 'find', label: 'Find a note', group: 'Notes', chords: ['Mod-p'] },
  { id: 'palette', label: 'Show all commands', group: 'App', chords: ['Mod-Shift-p', 'F1'], leader: '?' },
  { id: 'new-note', label: 'New note', group: 'Notes', chords: ['Mod-n'], leader: 'n' },
  { id: 'beside', label: 'Open a note beside this one', group: 'Notes', chords: ['Mod-\\'], leader: 't', desktopOnly: true },
  { id: 'previous-note', label: 'Go back to the previous note', group: 'Notes', leader: 'j' },
  // L rather than l, which is the note list. The keyboard's only route to a
  // `[[link]]`: ⌘-click is a mouse, and a phone has neither — it reaches this
  // through the More sheet.
  { id: 'follow-link', label: 'Open the note link at the cursor', group: 'Notes', leader: 'L' },
  { id: 'copy-note', label: 'Copy note text', group: 'Notes', leader: 'c' },
  { id: 'move-note', label: 'Move note to a folder', group: 'Notes', leader: 'm' },
  // Shift+P and Shift+T: lowercase p is the preview and lowercase t opens a
  // note beside this one. `#` would read better than T for the tag picker, but
  // it is ⌥3 on a UK Mac layout and `matchLeader` refuses Alt — the character
  // it produces is not the one the user pressed.
  { id: 'pin-note', label: 'Pin or unpin note', group: 'Notes', leader: 'P' },
  { id: 'go-to-tag', label: 'Go to tag', group: 'Notes', leader: 'T' },
  { id: 'delete-note', label: 'Delete note', group: 'Notes', leader: 'd' },
  { id: 'export-note', label: 'Export note as Markdown', group: 'Notes', leader: 'E' },
  { id: 'share-note', label: 'Share note by link', group: 'Notes', leader: 'S' },
  { id: 'note-history', label: 'Show note history', group: 'Notes', leader: 'h' },
  { id: 'recently-deleted', label: 'Recently deleted notes', group: 'Notes', leader: 'u' },
  { id: 'focus-list', label: 'Go to the note list', group: 'Notes', leader: 'l' },
  // z, with no mnemonic in the word, because every letter of "sort" and "order"
  // is bound: s is the split view, S is share, o is go to folder, r is rename,
  // d is delete, t opens a note beside. z is free and reads as A→Z, which is
  // half of what the menu offers.
  { id: 'sort-notes', label: 'Sort the note list', group: 'Notes', leader: 'z' },
  { id: 'sync', label: 'Save and sync now', group: 'Notes', chords: ['Mod-s'] },

  // Folders
  { id: 'new-folder', label: 'New folder', group: 'Folders', leader: 'f' },
  { id: 'go-to-folder', label: 'Go to folder', group: 'Folders', leader: 'o' },
  { id: 'new-subfolder', label: 'New subfolder in this folder', group: 'Folders', leader: 'F' },
  { id: 'move-folder', label: 'Move this folder', group: 'Folders', leader: 'M' },
  { id: 'rename-folder', label: 'Rename this folder', group: 'Folders', leader: 'r' },
  { id: 'delete-folder', label: 'Delete this folder', group: 'Folders', leader: 'D' },

  // Tiles and view
  ...[1, 2, 3, 4].map(
    (n): Command => ({
      id: `tile-${n}`,
      label: `Focus tile ${n}`,
      group: 'Tiles and view',
      leader: String(n),
      desktopOnly: true,
    }),
  ),
  { id: 'tile-prev', label: 'Previous tile', group: 'Tiles and view', leader: '[', desktopOnly: true },
  { id: 'tile-next', label: 'Next tile', group: 'Tiles and view', leader: ']', desktopOnly: true },
  { id: 'close-tile', label: 'Close tile', group: 'Tiles and view', leader: 'w', desktopOnly: true },
  { id: 'cycle-layout', label: 'Change tile layout', group: 'Tiles and view', leader: 'g', desktopOnly: true },
  { id: 'view-cycle', label: 'Cycle editor, split and preview', group: 'Tiles and view', chords: ['Mod-Shift-e'] },
  { id: 'view-edit', label: 'Editor only', group: 'Tiles and view', leader: 'e' },
  { id: 'view-split', label: 'Editor and preview', group: 'Tiles and view', leader: 's', desktopOnly: true },
  { id: 'view-preview', label: 'Preview only', group: 'Tiles and view', leader: 'p' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', group: 'Tiles and view', leader: 'b', desktopOnly: true },
  // y, because every letter of "focus" and of "zen" is taken: f is a new
  // folder, o go to folder, c copy, u recently deleted, s the split view, z the
  // sort menu, e editor only, n a new note. y was the last unbound plain
  // letter, which is why `shortcuts.test.ts` had been using it as its example
  // of one and now uses a digit instead.
  //
  // Desktop only, like the sidebar toggle above, and for a stronger reason: a
  // phone's chrome is the only route to Lock, Account and the palette, and
  // there is no leader key there to get back out of a mode that hid them.
  { id: 'toggle-focus', label: 'Focus mode', group: 'Tiles and view', leader: 'y', desktopOnly: true },
  // Shift+= arrives as `+` with Shift held, the numpad's `+` without it.
  { id: 'text-bigger', label: 'Larger text', group: 'Tiles and view', chords: ['Mod-=', 'Mod-+', 'Mod-Shift-+'] },
  { id: 'text-smaller', label: 'Smaller text', group: 'Tiles and view', chords: ['Mod--', 'Mod-_', 'Mod-Shift-_'] },
  { id: 'text-reset', label: 'Reset text size', group: 'Tiles and view', chords: ['Mod-0'] },
  // W for wrap: window ↔ the last fixed measure (`ui/lineWrap.ts`). A leader key,
  // not Alt+Z, because Option+Z on a Mac types Ω and the leader is free.
  { id: 'toggle-wrap', label: 'Toggle line wrap', group: 'Tiles and view', leader: 'W' },
  { id: 'toggle-theme', label: 'Switch light and dark mode', group: 'Tiles and view', leader: 'i' },
  // O for the OS. Offered only while the theme is pinned (`available()`), so
  // it is a way back rather than a third state: the toggle already reaches
  // "follow the system" in one tap, but never by that name, and a rule nobody
  // can see is one nobody trusts. `src/ui/theme.ts` has the whole argument.
  { id: 'theme-system', label: 'Follow my system theme', group: 'Tiles and view', leader: 'O' },
  // The comma, because it is what every application on the machine means by
  // preferences. ⌘, itself belongs to the browser on a Mac; the second key of
  // a leader sequence belongs to nobody, which is the point of the leader.
  { id: 'appearance', label: 'Appearance', group: 'Tiles and view', leader: ',' },
  // v, with no mnemonic, because every letter of the word is already bound: s
  // is the split view, S is share, c is copy, k is shared links. This is a
  // preference found once in the palette, not something anyone touch-types, so
  // a free key is worth more than a clever one.
  { id: 'toggle-spellcheck', label: 'Turn spellcheck on or off', group: 'Tiles and view', leader: 'v' },

  // App
  { id: 'account', label: 'Account and sync', group: 'App', leader: 'a' },
  { id: 'export-import', label: 'Export or import notes', group: 'App', leader: 'I' },
  { id: 'export-all', label: 'Export all notes as a zip', group: 'App', leader: 'A' },
  { id: 'shared-links', label: 'Shared links', group: 'App', leader: 'k' },
  { id: 'dismiss', label: 'Dismiss notices', group: 'App', leader: 'x' },
  { id: 'lock', label: 'Lock', group: 'App', leader: 'q' },
];

export const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS']);

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * `Mod-Shift-p` in one fixed spelling, keeping `Mod--` whole, so a registry
 * chord and a keydown can be compared as strings. Shift is kept even for
 * punctuation: CodeMirror binds `Shift-Mod-\`, and folding it into `Mod-\`
 * would report a collision that no keyboard can produce.
 */
export function canonicalChord(chord: string, isApple = IS_APPLE): string {
  const key = chord.endsWith('--') ? '-' : chord.slice(chord.lastIndexOf('-') + 1);
  const mods = new Set(chord.slice(0, chord.length - key.length).split('-').filter(Boolean));
  const name = key.length === 1 ? key.toLowerCase() : key;

  const out: string[] = [];
  const mod = mods.has('Mod') || mods.has(isApple ? 'Cmd' : 'Ctrl') || mods.has(isApple ? 'Meta' : 'Control');
  if (mod) out.push('Mod');
  if (isApple && (mods.has('Ctrl') || mods.has('Control'))) out.push('Ctrl');
  if (mods.has('Alt')) out.push('Alt');
  if (mods.has('Shift')) out.push('Shift');
  return [...out, name].join('-');
}

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

function eventChord(event: KeyLike, isApple: boolean): string {
  const mods: string[] = [];
  if (isApple ? event.metaKey : event.ctrlKey) mods.push('Mod');
  if (isApple && event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  return canonicalChord([...mods, event.key].join('-'), isApple);
}

const chordIndex = new Map<boolean, Map<string, string>>();

function indexFor(isApple: boolean): Map<string, string> {
  let index = chordIndex.get(isApple);
  if (!index) {
    index = new Map([[canonicalChord(LEADER_CHORD, isApple), 'leader']]);
    for (const command of COMMANDS) {
      for (const chord of command.chords ?? []) index.set(canonicalChord(chord, isApple), command.id);
    }
    chordIndex.set(isApple, index);
  }
  return index;
}

/**
 * The command a keydown names directly: a command id, `'leader'` for ⌘J, or
 * null. Called on every keystroke, so it returns before building anything when
 * no modifier is held.
 *
 * On a Mac, Ctrl stands in for ⌘ as well, as it always has here: people move
 * between machines and their hands do not. The cost is that Ctrl+P and Ctrl+N
 * no longer move the cursor Emacs-style inside a note on a Mac.
 */
export function matchChord(event: KeyLike, isApple = IS_APPLE): string | null {
  if (event.isComposing) return null;
  if (!event.metaKey && !event.ctrlKey && event.key !== 'F1') return null;
  const direct = indexFor(isApple).get(eventChord(event, isApple));
  if (direct) return direct;
  if (isApple && event.ctrlKey && !event.metaKey) {
    return indexFor(false).get(eventChord(event, false)) ?? null;
  }
  return null;
}

/**
 * The command for the key after the leader. A held ⌘ is ignored — typing the
 * sequence without letting go (⌘J ⌘N) is how a fast hand does it — but Alt is
 * not, because on a Mac it changes the character.
 */
export function matchLeader(event: KeyLike): string | null {
  if (event.isComposing || event.altKey) return null;
  // A letter's case is read from Shift, not from `event.key`: with Caps Lock
  // on, `d` arrives as `D`, and ⌘J d would delete the folder instead of the note.
  const key = /^[a-z]$/i.test(event.key)
    ? event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase()
    : event.key;
  return COMMANDS.find((c) => c.leader === key)?.id ?? null;
}

const MAC_GLYPH: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };

/** `Mod-Shift-p` as `⌘⇧P` or `Ctrl+Shift+P`. */
export function formatChord(chord: string, isApple = IS_APPLE): string {
  const key = chord.endsWith('--') ? '-' : chord.slice(chord.lastIndexOf('-') + 1);
  const mods = chord.slice(0, chord.length - key.length).split('-').filter(Boolean);
  const name = key.length === 1 ? key.toUpperCase() : key;
  if (isApple) return mods.map((m) => MAC_GLYPH[m] ?? m).join('') + name;
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), name].join('+');
}

/** `D` after the leader as `⌘J ⇧D` or `Ctrl+J Shift+D`. */
export function formatLeader(key: string, isApple = IS_APPLE): string {
  const shifted = /^[A-Z]$/.test(key);
  const name = shifted ? (isApple ? `⇧${key}` : `Shift+${key}`) : key.toUpperCase();
  return `${formatChord(LEADER_CHORD, isApple)} ${name}`;
}

/** Every way to run a command, for the palette: `⌘S`, or `⌘⇧P · F1 · ⌘J ?`. */
export function keysFor(command: Command, isApple = IS_APPLE): string[] {
  const keys = (command.chords ?? [])
    // `Mod-+` and `Mod-_` are the shifted twins of `Mod-=` and `Mod--`.
    .filter((c) => !c.endsWith('+') && !c.endsWith('_'))
    .map((c) => formatChord(c, isApple));
  if (command.leader) keys.push(formatLeader(command.leader, isApple));
  return keys;
}

/** A button tooltip suffix: the first way to run `id`, or nothing. */
export function hint(id: string, isApple = IS_APPLE): string {
  const command = COMMANDS.find((c) => c.id === id);
  const first = command ? keysFor(command, isApple)[0] : undefined;
  return first ? `  ${first}` : '';
}
