import { describe, it, expect } from 'vitest';
import {
  PHONE_MORE_LIST,
  PHONE_MORE_NOTE,
  moreItems,
} from '../../src/ui/mobile/moreItems.ts';
import { COMMANDS } from '../../src/ui/shortcuts.ts';

const ids = new Set(COMMANDS.map((c) => c.id));
const always = { available: () => true, run: () => {} };

describe('the phone More sheets', () => {
  it('name only real commands', () => {
    for (const id of [...PHONE_MORE_LIST, ...PHONE_MORE_NOTE]) {
      expect(ids.has(id), `unknown command id "${id}"`).toBe(true);
    }
  });

  it('never offers a command the phone cannot run', () => {
    const desktopOnly = new Set(COMMANDS.filter((c) => c.desktopOnly).map((c) => c.id));
    for (const id of [...PHONE_MORE_LIST, ...PHONE_MORE_NOTE]) {
      expect(desktopOnly.has(id), `"${id}" is desktopOnly`).toBe(false);
    }
  });

  it('lists no id twice within one sheet', () => {
    expect(new Set(PHONE_MORE_LIST).size).toBe(PHONE_MORE_LIST.length);
    expect(new Set(PHONE_MORE_NOTE).size).toBe(PHONE_MORE_NOTE.length);
  });

  it('drops what is not currently available', () => {
    const items = moreItems(['new-folder', 'lock'], {
      available: (id) => id === 'lock',
      run: () => {},
    });
    expect(items.map((i) => i.label)).toEqual(['Lock']);
  });

  it('labels each row from the registry and captures its own id', () => {
    const ran: string[] = [];
    const items = moreItems(['toggle-theme', 'lock'], {
      available: () => true,
      run: (id) => ran.push(id),
    });
    expect(items).toHaveLength(2);
    for (const item of items) item.run();
    expect(ran).toEqual(['toggle-theme', 'lock']);
    expect(items[0]!.label).toBe(COMMANDS.find((c) => c.id === 'toggle-theme')!.label);
  });

  it('appends a value to a row that has one, and leaves the rest alone', () => {
    const items = moreItems(['appearance', 'lock'], {
      available: () => true,
      run: () => {},
      detail: (id) => (id === 'appearance' ? '16 px, Serif' : undefined),
    });
    // The label still comes from the registry; only the value is added here,
    // so the palette and the sheet cannot drift on what a command is called.
    expect(items[0]!.label).toBe('Appearance — 16 px, Serif');
    expect(items[1]!.label).toBe('Lock');
  });

  it('needs no detail at all', () => {
    const items = moreItems(['appearance'], { available: () => true, run: () => {} });
    expect(items[0]!.label).toBe('Appearance');
  });

  it('marks the destructive rows and puts them last', () => {
    const list = moreItems(PHONE_MORE_LIST, always);
    const note = moreItems(PHONE_MORE_NOTE, always);
    expect(list.at(-1)?.danger).toBe(true);
    expect(note.at(-1)?.danger).toBe(true);
    expect(list.filter((i) => i.danger)).toHaveLength(1);
    expect(note.filter((i) => i.danger)).toHaveLength(1);
  });

  it('puts Lock on both sheets — it is the phonedevice’s only way to lock', () => {
    expect(moreItems(PHONE_MORE_LIST, always).some((i) => i.label === 'Lock')).toBe(true);
    expect(moreItems(PHONE_MORE_NOTE, always).some((i) => i.label === 'Lock')).toBe(true);
  });
});

/**
 * The guarantee the whole redesign rests on: moving controls off the topbar
 * must not strand a command. Every non-desktopOnly command has to be reachable
 * on a phone from one of the surfaces below — and `desktopOnly` is the only
 * legitimate omission list, per `available()` in App.svelte.
 */
describe('phone command reachability', () => {
  /** Surfaces that are not a More sheet, with the ids each one carries. */
  const ELSEWHERE = new Set([
    'find', // tab bar: Search
    'new-note', // tab bar: New
    'focus-list', // tab bar: Notes, and the back button
    'dismiss', // the banner's own ×
    'view-cycle', // the header's Edit/Preview control
    'view-edit',
    'view-preview',
    // The Appearance menu, which `appearance` opens: it sets a size directly
    // instead of stepping, so the phone reaches the same preference by a
    // better route than three rows that each closed the sheet.
    'text-bigger',
    'text-smaller',
    'text-reset',
    // The phone header's wrap button, and the Appearance menu's Line wrap row.
    'toggle-wrap',
  ]);

  it('leaves no command unreachable', () => {
    const covered = new Set([...PHONE_MORE_LIST, ...PHONE_MORE_NOTE, ...ELSEWHERE]);
    const stranded = COMMANDS.filter((c) => !c.desktopOnly && !covered.has(c.id)).map((c) => c.id);
    expect(stranded).toEqual([]);
  });
});
