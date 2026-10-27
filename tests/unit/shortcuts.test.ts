/**
 * The app shortcut registry, tested against the editor's real keymap: "does
 * this chord collide with CodeMirror" is the facet's answer, not a list kept
 * by hand. The welcome note is checked here too, so it cannot name a key that
 * nothing is bound to.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { editorExtensions } from '../../src/editor/setup.ts';
import { WELCOME_NOTE } from '../../src/ui/state/seed.ts';
import {
  canonicalChord,
  COMMANDS,
  formatChord,
  formatLeader,
  keysFor,
  LEADER_CHORD,
  matchChord,
  matchLeader,
} from '../../src/ui/shortcuts.ts';

const PLATFORMS = [true, false] as const;

function key(key: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}) {
  return {
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  };
}

function appChords(isApple: boolean): string[] {
  return [LEADER_CHORD, ...COMMANDS.flatMap((c) => c.chords ?? [])].map((c) => canonicalChord(c, isApple));
}

function editorChords(isApple: boolean): Set<string> {
  const s = EditorState.create({ doc: '', extensions: editorExtensions({ onChange: () => {} }) });
  const out = new Set<string>();
  for (const binding of s.facet(keymap).flat()) {
    const name = isApple ? (binding.mac ?? binding.key) : binding.key;
    if (!name) continue;
    out.add(canonicalChord(name, isApple));
    if (binding.shift) out.add(canonicalChord(`Shift-${name}`, isApple));
  }
  return out;
}

/**
 * Where each App-group command can be reached on a desktop, by *mouse*.
 *
 * The phone has `moreItems.test.ts`, which refuses to let a command be absent
 * from both More sheets. A wide screen has no such pressure — and the
 * assertion below that every command has at least one keyboard path is
 * precisely what makes a missing button invisible. That is how `shared-links`
 * shipped with a phone row and nothing at all to click on a desktop.
 *
 * A checklist, not a scrape of the markup: it cannot notice a button being
 * deleted, but it does fail the moment an App command is added without anyone
 * deciding where it lives. Kept to the App group because that is the group
 * with no note or folder row to hang off; elsewhere — `tile-next`,
 * `previous-note`, `view-cycle` — keyboard-only is the right answer, since a
 * mouse does those things directly.
 */
const DESKTOP_APP_SURFACES: Record<string, string> = {
  palette: 'deliberately keyboard-only — it is itself the keyboard surface',
  account: 'topbar icon',
  lock: 'topbar icon',
  'export-import': 'sidebar ⇅, and the Account dialog',
  'export-all': 'a row in the Export and import dialog',
  'shared-links': 'sidebar link icon, and the Account dialog when signed in',
  dismiss: "each banner's own ×",
};

describe('registry', () => {
  it('gives every command a unique id and a way to run it', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of COMMANDS) expect(keysFor(command).length).toBeGreaterThan(0);
  });

  it('gives every App-group command a desktop home', () => {
    const app = COMMANDS.filter((c) => c.group === 'App').map((c) => c.id);
    // Set equality, not coverage: removing a command has to update the list
    // too, the same discipline `firestoreIndexes.test.ts` keeps between its
    // two files.
    expect(app.sort()).toEqual(Object.keys(DESKTOP_APP_SURFACES).sort());
  });

  it('never binds one chord to two commands', () => {
    for (const isApple of PLATFORMS) {
      const chords = appChords(isApple);
      expect(new Set(chords).size).toBe(chords.length);
    }
  });

  it('never binds one leader key to two commands', () => {
    const leaders = COMMANDS.flatMap((c) => (c.leader ? [c.leader] : []));
    expect(new Set(leaders).size).toBe(leaders.length);
    for (const leader of leaders) expect(leader).toHaveLength(1);
  });

  it('takes no chord the editor already binds', () => {
    for (const isApple of PLATFORMS) {
      const editor = editorChords(isApple);
      expect(appChords(isApple).filter((c) => editor.has(c))).toEqual([]);
    }
  });
});

describe('matchChord', () => {
  it('reads Mod as ⌘ on a Mac and Ctrl elsewhere, and still takes Ctrl on a Mac', () => {
    expect(matchChord(key('s', { meta: true }), true)).toBe('sync');
    expect(matchChord(key('s', { ctrl: true }), true)).toBe('sync');
    expect(matchChord(key('j', { ctrl: true }), true)).toBe('leader');
    expect(matchChord(key('s', { ctrl: true }), false)).toBe('sync');
    expect(matchChord(key('s', { meta: true }), false)).toBeNull();
  });

  it('tells Shift chords apart, whatever case the key arrives in', () => {
    expect(matchChord(key('p', { ctrl: true }), false)).toBe('find');
    expect(matchChord(key('P', { ctrl: true, shift: true }), false)).toBe('palette');
    expect(matchChord(key('p', { meta: true, shift: true }), true)).toBe('palette');
  });

  it('takes the shifted and numpad forms of the text-size keys', () => {
    expect(matchChord(key('=', { meta: true }), true)).toBe('text-bigger');
    expect(matchChord(key('+', { meta: true, shift: true }), true)).toBe('text-bigger');
    expect(matchChord(key('+', { meta: true }), true)).toBe('text-bigger');
    expect(matchChord(key('_', { ctrl: true, shift: true }), false)).toBe('text-smaller');
  });

  it('knows the leader, F1, and nothing without a modifier', () => {
    expect(matchChord(key('j', { ctrl: true }), false)).toBe('leader');
    expect(matchChord(key('F1'), true)).toBe('palette');
    expect(matchChord(key('s'), true)).toBeNull();
    expect(matchChord({ ...key('s', { meta: true }), isComposing: true }, true)).toBeNull();
  });
});

describe('matchLeader', () => {
  it('matches on the character, so Shift picks a different command', () => {
    expect(matchLeader(key('d'))).toBe('delete-note');
    expect(matchLeader(key('D', { shift: true }))).toBe('delete-folder');
    expect(matchLeader(key('?', { shift: true }))).toBe('palette');
    expect(matchLeader(key('2'))).toBe('tile-2');
  });

  it('tolerates a held ⌘ but not Alt, which changes the character on a Mac', () => {
    expect(matchLeader(key('n', { meta: true }))).toBe('new-note');
    expect(matchLeader(key('n', { alt: true }))).toBeNull();
    // `5` is the example of an unbound key because the plain letters have run
    // out: `z` held this role until the sort menu took it, `y` until focus mode
    // did. The tile commands bind 1 to 4, so the digits past them are what is
    // left.
    expect(matchLeader(key('5'))).toBeNull();
  });

  it("reads a letter's case from Shift, so Caps Lock changes nothing", () => {
    expect(matchLeader(key('D'))).toBe('delete-note');
    expect(matchLeader(key('d', { shift: true }))).toBe('delete-folder');
    expect(matchLeader(key('P'))).toBe('view-preview');
  });
});

describe('formatting', () => {
  it('writes chords the way each platform does', () => {
    expect(formatChord('Mod-Shift-p', true)).toBe('⌘⇧P');
    expect(formatChord('Mod-Shift-p', false)).toBe('Ctrl+Shift+P');
    expect(formatChord('Mod--', false)).toBe('Ctrl+-');
    expect(formatChord('F1', true)).toBe('F1');
  });

  it('writes leader sequences with their Shift', () => {
    expect(formatLeader('n', true)).toBe('⌘J N');
    expect(formatLeader('D', false)).toBe('Ctrl+J Shift+D');
  });
});

describe('welcome note', () => {
  /** Handled by a DOM paste handler rather than the keymap. */
  const OUTSIDE_KEYMAP = new Set(['Mod-Shift-v'].map((c) => canonicalChord(c, false)));
  const LEADER_ITEM = String.raw`(?:Shift\+)?[A-Z0-9?\[\],]`;
  const pattern = new RegExp(
    String.raw`Ctrl\+((?:Shift\+|Alt\+)*)(Enter|[A-Z0-9.=\-\\])(?: to (\d))?` +
      String.raw`(?: then (${LEADER_ITEM}(?:(?:, | or | to )${LEADER_ITEM})*))?`,
    'g',
  );

  function range(first: string, last: string | undefined): string[] {
    if (last === undefined) return [first];
    return Array.from({ length: Number(last) - Number(first) + 1 }, (_, i) => String(Number(first) + i));
  }

  /** Every chord and leader key the welcome note names, in canonical form. */
  function named(): { chords: Set<string>; sequences: Set<string> } {
    const chords = new Set<string>();
    const sequences = new Set<string>();
    for (const match of WELCOME_NOTE.matchAll(pattern)) {
      const mods = ['Mod', ...match[1]!.split('+').filter(Boolean)];
      for (const k of range(match[2]!, match[3])) chords.add(canonicalChord([...mods, k].join('-'), false));

      if (!match[4]) continue;
      const items = match[4].split(/, | or /);
      for (const item of items) {
        const [first, last] = item.split(' to ');
        for (const k of range(first!, last)) {
          sequences.add(k.startsWith('Shift+') ? k.slice(6) : k.toLowerCase());
        }
      }
    }
    return { chords, sequences };
  }

  it('names only shortcuts that are really bound', () => {
    const bound = new Set([...editorChords(false), ...appChords(false), ...OUTSIDE_KEYMAP]);
    const leaders = new Set(COMMANDS.flatMap((c) => (c.leader ? [c.leader] : [])));
    const { chords, sequences } = named();

    expect(chords.size).toBeGreaterThan(15);
    expect(sequences.size).toBeGreaterThan(15);
    expect([...chords].filter((c) => !bound.has(c))).toEqual([]);
    expect([...sequences].filter((k) => !leaders.has(k))).toEqual([]);
  });

  // The other direction. The test above let commands be added without anyone
  // telling the note, which is how a dozen of them went missing from it.
  it('names every app shortcut', () => {
    const { chords, sequences } = named();
    const leaders = COMMANDS.flatMap((c) => (c.leader ? [c.leader] : []));
    expect(leaders.filter((k) => !sequences.has(k))).toEqual([]);

    // F1 is not a Ctrl chord, so the pattern cannot see it; the shifted twins
    // of the text-size keys are the same key, as `keysFor` already treats them.
    const direct = [LEADER_CHORD, ...COMMANDS.flatMap((c) => c.chords ?? [])].filter(
      (c) => c !== 'F1' && !c.endsWith('+') && !c.endsWith('_'),
    );
    expect(direct.map((c) => canonicalChord(c, false)).filter((c) => !chords.has(c))).toEqual([]);
    expect(WELCOME_NOTE).toContain('F1');
  });
});
