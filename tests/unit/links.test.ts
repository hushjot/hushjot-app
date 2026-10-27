import { describe, it, expect } from 'vitest';
import { MAX_LINK_TARGET, parseLinkBody } from '../../src/core/notes/links.ts';
import { notesMatching, type NoteMeta } from '../../src/core/notes/model.ts';

describe('parseLinkBody', () => {
  it('takes a bare target as both target and label', () => {
    expect(parseLinkBody('Design Review')).toEqual({ target: 'Design Review', label: 'Design Review' });
  });

  it('splits on the first bar, so a label may contain one', () => {
    expect(parseLinkBody('Design Review|the review')).toEqual({
      target: 'Design Review',
      label: 'the review',
    });
    expect(parseLinkBody('a|b|c')).toEqual({ target: 'a', label: 'b|c' });
  });

  it('collapses whitespace in both halves', () => {
    expect(parseLinkBody('  My   Note ')).toEqual({ target: 'My Note', label: 'My Note' });
    expect(parseLinkBody('My Note |  the   note ')).toEqual({ target: 'My Note', label: 'the note' });
  });

  it('falls back to the target when the label is empty', () => {
    expect(parseLinkBody('My Note|')).toEqual({ target: 'My Note', label: 'My Note' });
    expect(parseLinkBody('My Note|   ')).toEqual({ target: 'My Note', label: 'My Note' });
  });

  it('refuses a body that is not a link', () => {
    // A bracket would let a link swallow whatever follows it.
    expect(parseLinkBody('a[b')).toBeNull();
    expect(parseLinkBody('a]b')).toBeNull();
    // A link is a label, not a paragraph.
    expect(parseLinkBody('a\nb')).toBeNull();
    // Nothing to resolve.
    expect(parseLinkBody('')).toBeNull();
    expect(parseLinkBody('   ')).toBeNull();
    expect(parseLinkBody('|label')).toBeNull();
  });

  it('refuses a target past the cap, because this is on the typing path', () => {
    expect(parseLinkBody('a'.repeat(MAX_LINK_TARGET))).not.toBeNull();
    expect(parseLinkBody('a'.repeat(MAX_LINK_TARGET + 1))).toBeNull();
  });

  it('keeps a bracket out of the label half too', () => {
    expect(parseLinkBody('ok|not ]ok')).toBeNull();
  });
});

describe('notesMatching', () => {
  const meta = (id: string, title: string, updatedAt = 0): NoteMeta => ({
    id,
    title,
    folderId: null,
    pinnedAt: null,
    updatedAt,
    createdAt: updatedAt,
  });

  it('matches an exact title', () => {
    const metas = [meta('a', 'Design Review'), meta('b', 'Design notes')];
    expect(notesMatching(metas, 'Design Review')).toEqual(['a']);
  });

  it('ignores case and accents, because the title sort already does', () => {
    const metas = [meta('a', 'Café Notes')];
    expect(notesMatching(metas, 'cafe notes')).toEqual(['a']);
    expect(notesMatching(metas, 'CAFÉ NOTES')).toEqual(['a']);
  });

  it('returns every match in the order it was given, not one', () => {
    // Titles are not unique, so the caller decides. `Workspace.metas` is in
    // recency order, which is what makes [0] the most recently edited.
    const metas = [meta('newer', 'Untitled', 20), meta('older', 'Untitled', 10)];
    expect(notesMatching(metas, 'Untitled')).toEqual(['newer', 'older']);
  });

  it('is exact: no prefix and no substring', () => {
    const metas = [meta('a', 'Design Review')];
    expect(notesMatching(metas, 'Design')).toEqual([]);
    expect(notesMatching(metas, 'Review')).toEqual([]);
    expect(notesMatching(metas, 'nothing here')).toEqual([]);
  });
});
