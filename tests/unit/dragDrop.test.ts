import { describe, it, expect } from 'vitest';
import {
  DRAG_MIME,
  KIND_MIME,
  decodeDrag,
  dropVerdict,
  encodeDrag,
  kindFromTypes,
  type DragSource,
} from '../../src/ui/dragDrop.ts';
import { canMoveFolder, type Folder } from '../../src/core/notes/folders.ts';

const note = (id: string): DragSource => ({ kind: 'note', id });
const folder = (id: string): DragSource => ({ kind: 'folder', id });

/** `Code / Rust`, plus a `Work` alongside them. */
function tree(): Folder[] {
  const at = (id: string, parentId: string | null): Folder => ({
    id,
    name: id,
    parentId,
    createdAt: 0,
    updatedAt: 0,
  });
  return [at('code', null), at('rust', 'code'), at('async', 'rust'), at('work', null)];
}

describe('what a drop would do', () => {
  it('moves a note to another folder', () => {
    expect(dropVerdict(note('n1'), 'code', { currentFolderId: null, canMove: true })).toBe('move');
    expect(dropVerdict(note('n1'), 'work', { currentFolderId: 'code', canMove: true })).toBe('move');
  });

  it('does nothing when the note is already there', () => {
    expect(dropVerdict(note('n1'), 'code', { currentFolderId: 'code', canMove: true })).toBe('noop');
  });

  it('treats the top level as a folder like any other', () => {
    expect(dropVerdict(note('n1'), null, { currentFolderId: 'code', canMove: true })).toBe('move');
    expect(dropVerdict(note('n1'), null, { currentFolderId: null, canMove: true })).toBe('noop');
  });

  it('refuses a folder dropped on itself', () => {
    expect(dropVerdict(folder('code'), 'code', { currentFolderId: null, canMove: false })).toBe(
      'forbidden',
    );
  });

  it('refuses a folder dropped inside its own subtree', () => {
    const folders = tree();
    // The facts the sidebar would supply, from the function that owns the rule.
    expect(canMoveFolder(folders, 'code', 'async')).toBe(false);
    expect(
      dropVerdict(folder('code'), 'async', {
        currentFolderId: null,
        canMove: canMoveFolder(folders, 'code', 'async'),
      }),
    ).toBe('forbidden');
  });

  it('does nothing when a folder is dropped on the parent it already has', () => {
    const folders = tree();
    expect(canMoveFolder(folders, 'rust', 'code')).toBe(true);
    expect(
      dropVerdict(folder('rust'), 'code', {
        currentFolderId: 'code',
        canMove: canMoveFolder(folders, 'rust', 'code'),
      }),
    ).toBe('noop');
  });

  it('moves a folder somewhere unrelated', () => {
    const folders = tree();
    expect(
      dropVerdict(folder('rust'), 'work', {
        currentFolderId: 'code',
        canMove: canMoveFolder(folders, 'rust', 'work'),
      }),
    ).toBe('move');
  });

  it('lifts a nested folder to the top level', () => {
    const folders = tree();
    expect(
      dropVerdict(folder('rust'), null, {
        currentFolderId: 'code',
        canMove: canMoveFolder(folders, 'rust', null),
      }),
    ).toBe('move');
  });
});

describe('the payload', () => {
  it('round-trips both kinds', () => {
    for (const source of [note('n1'), folder('f1')]) {
      expect(decodeDrag(encodeDrag(source))).toEqual(source);
    }
  });

  it('survives an id containing the separator', () => {
    const source = note('a:b:c');
    expect(decodeDrag(encodeDrag(source))).toEqual(source);
  });

  it('refuses junk rather than throwing', () => {
    for (const raw of ['', ':', 'note:', ':n1', 'note', 'tag:t1', 'n1']) {
      expect(decodeDrag(raw)).toBeNull();
    }
  });
});

describe('recognising our own drag mid-flight', () => {
  it('reads the kind from the types alone', () => {
    expect(kindFromTypes([DRAG_MIME, KIND_MIME.note])).toBe('note');
    expect(kindFromTypes([DRAG_MIME, KIND_MIME.folder])).toBe('folder');
  });

  /*
   * The seam that keeps file import working. `App.svelte`'s capture-phase
   * handlers own any drag carrying `Files`; if this ever answered one of
   * those, a folder row would start swallowing dropped zips.
   */
  it('takes no interest in a file drag', () => {
    expect(kindFromTypes(['Files'])).toBeNull();
    expect(kindFromTypes(['Files', 'application/x-moz-file'])).toBeNull();
    expect(kindFromTypes([])).toBeNull();
  });

  /*
   * The other seam. CodeMirror's own drop handler reads `text/plain`, so a
   * note dragged across the editor would be inserted into it as text.
   */
  it('offers no format the editor would insert', () => {
    const ours = [DRAG_MIME, ...Object.values(KIND_MIME)];
    expect(ours).not.toContain('text/plain');
    expect(ours.every((type) => type.startsWith('application/x-hushjot-'))).toBe(true);
  });
});
