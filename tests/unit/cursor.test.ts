/**
 * The delta cursor.
 *
 * These are unit tests for arithmetic that used to live inline in the Firebase
 * adapter, where nothing could reach it: the adapter is browser code and cannot
 * be imported by a test at all. Two bugs hid there, both of which silently and
 * permanently dropped documents — one cursor shared between two independently
 * paged queries, and a bare timestamp used as though it were a position.
 * The visible symptom was a note syncing to a second device already filed in a
 * folder that did not exist there.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  advance,
  CURSOR_START,
  type Position,
} from '../../src/adapters/firebase/cursor.ts';

const at = (ms: number, id: string): Position => ({ at: ms, id });

describe('decoding', () => {
  it('starts from the beginning when there is no cursor', () => {
    expect(decodeCursor(null)).toEqual(CURSOR_START);
  });

  it('seeds both collections from a legacy single-position cursor', () => {
    // Written before the positions were split. It is the last point we can
    // claim to have consumed *either* collection up to, so it is the only
    // honest starting point for both.
    expect(decodeCursor('1700000000000')).toEqual({
      notes: at(1700000000000, ''),
      folders: at(1700000000000, ''),
    });
  });

  it('reads a bare timestamp from before ids were part of a position', () => {
    // Resuming at the start of that millisecond re-delivers a handful of
    // documents. Re-delivery is free — `applyRemoteNote` discards an echo —
    // whereas resuming after it would skip whatever shared the millisecond.
    expect(decodeCursor('{"n":"1700000000000","f":900}')).toEqual({
      notes: at(1700000000000, ''),
      folders: at(900, ''),
    });
  });

  it('round-trips a split cursor', () => {
    const positions = { notes: at(1700000000500, 'n9'), folders: at(1699999999000, 'f2') };
    expect(decodeCursor(encodeCursor(positions))).toEqual(positions);
  });

  it('restarts from the beginning rather than guessing at a position it cannot read', () => {
    // A full re-pull costs one paged read and cannot lose anything; inventing
    // a position we never reached would skip whatever sat behind it.
    expect(decodeCursor('not json')).toEqual(CURSOR_START);
    expect(decodeCursor('{"n":')).toEqual(CURSOR_START);
    expect(decodeCursor('null')).toEqual(CURSOR_START);
    expect(decodeCursor('{"n":{"at":"abc"},"f":{}}')).toEqual(CURSOR_START);
    expect(decodeCursor('{"n":{"at":-5},"f":{"at":"-9"}}')).toEqual(CURSOR_START);
  });
});

describe('advancing', () => {
  it('takes the last document of the page, not the newest timestamp', () => {
    // The page arrives ordered by (syncedAt, id), so its last entry *is* the
    // new position. Picking the maximum timestamp instead would reintroduce
    // the tie problem the id exists to solve.
    const page = [at(10, 'a'), at(10, 'b'), at(10, 'c')];
    expect(advance(at(0, ''), page)).toEqual(at(10, 'c'));
  });

  it('does not move for an empty page', () => {
    // A page that delivered nothing is not evidence that anything was
    // consumed. Advancing here would step over undelivered documents.
    expect(advance(at(10, 'x'), [])).toEqual(at(10, 'x'));
  });
});

describe('the regression: positions must not drag each other forward', () => {
  it('advancing over notes leaves the folder position where it was', () => {
    // A saturated notes page reaching further into the future than anything
    // the folders query returned used to drag the shared cursor past folders
    // that had never been delivered — and because the next page resumed after
    // it, they were never offered again. Folders were the usual casualty:
    // they are written so rarely that the note stream almost always holds
    // something newer, and nothing re-stamps a folder to give it another go.
    const from = decodeCursor(encodeCursor({ notes: at(100, 'n0'), folders: at(100, 'f0') }));

    const next = {
      notes: advance(from.notes, [at(400, 'n1'), at(900, 'n2')]),
      folders: advance(from.folders, []),
    };

    expect(next.notes).toEqual(at(900, 'n2'));
    expect(next.folders).toEqual(at(100, 'f0'));
  });

  it('advancing over folders leaves the note position where it was', () => {
    const from = decodeCursor(encodeCursor({ notes: at(100, 'n0'), folders: at(100, 'f0') }));

    const next = {
      notes: advance(from.notes, []),
      folders: advance(from.folders, [at(900, 'f1')]),
    };

    expect(next.folders).toEqual(at(900, 'f1'));
    expect(next.notes).toEqual(at(100, 'n0'));
  });

  it('survives the round trip through storage, which is where the skew was lost', () => {
    // The engine persists the encoded string and hands it back; if the
    // encoding collapsed the two positions the fix would be undone on the
    // next page.
    const encoded = encodeCursor({ notes: at(900, 'n2'), folders: at(100, 'f0') });
    expect(decodeCursor(encoded)).toEqual({ notes: at(900, 'n2'), folders: at(100, 'f0') });
  });
});

describe('the regression: a timestamp is not a position', () => {
  it('keeps the id of a page that ends mid-millisecond', () => {
    // Three documents share one millisecond and the page fits two. The
    // position has to record *which* of them was the last one consumed, or
    // the third is either skipped (resume after the millisecond) or the page
    // repeats forever (resume at it).
    const page = [at(500, 'a'), at(500, 'b')];
    const next = advance(at(0, ''), page);

    expect(next).toEqual(at(500, 'b'));
    // Survives storage, which is the only reason it is any use.
    const reloaded = decodeCursor(encodeCursor({ notes: next, folders: next })).notes;
    expect(reloaded).toEqual(at(500, 'b'));
  });
});

describe('the cursor never rewinds', () => {
  it('ignores a page whose last document has no readable timestamp', () => {
    // Firestore sorts a null timestamp ahead of every real one, so such a
    // document can land last in a page. Adopting it would send the cursor back
    // to the start of time and re-pull the whole account on every cycle.
    expect(advance(at(900, 'n2'), [at(0, 'broken')])).toEqual(at(900, 'n2'));
  });
});
