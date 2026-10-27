/**
 * The delta-sync cursor, as a position *per collection*.
 *
 * ## The bug this shape exists to prevent
 *
 * `pull()` reads notes and folders with two separate queries, each with its own
 * `limit`. An earlier version tracked one cursor for both and advanced it to the
 * newest `syncedAt` seen across either result set. Because the next page filters
 * on `syncedAt > cursor`, anything the cursor passed over was never offered
 * again — so this silently and permanently lost documents, two ways:
 *
 * A third failure, independent of the split and fixed alongside it, is that a
 * timestamp is not a position at all: several documents routinely share one
 * millisecond, and `syncedAt > at` skips whichever of those ties land beyond a
 * page boundary. See `Position` below.
 *
 *  1. **One query saturates, the other holds something newer.** Say three
 *     folders are pending and the page fits two: the folders query returns two
 *     and leaves a remainder, while the notes query returns a note written
 *     after all three. The shared cursor jumped to the note's timestamp, which
 *     is past the third folder, and that folder was gone. Covered by
 *     `tests/rules/pull.test.ts`, which reproduces it against a real emulator.
 *  2. **The two reads are not one snapshot.** `Promise.all` runs them
 *     concurrently and they resolve against different server states. A folder
 *     committed between them is missed by the folders query while the notes
 *     query picks up a later note, and the shared cursor advances past a folder
 *     that was never delivered. This needs no volume at all, which is why the
 *     bug showed up on an account with a handful of notes. It is also why the
 *     fix cannot be "take the minimum of the two" — there is no single position
 *     that is correct for both streams.
 *
 * Folders were the usual casualty, for the opposite reason to the obvious one:
 * they are written so rarely that the note stream almost always holds something
 * newer, and nothing ever re-stamps a folder's `syncedAt` to give it a second
 * chance. The symptom was a note arriving on a second device already filed in a
 * folder that did not exist there.
 *
 * Keeping one position per collection makes each advance depend only on
 * documents that collection actually delivered, which is the invariant the whole
 * delta protocol rests on.
 *
 * ## Why this is a separate module
 *
 * `SyncCursor` is opaque to everything above the adapter, so the encoding is
 * ours to choose. It lives here rather than inside `adapter.ts` because the
 * adapter is browser code — it calls `initializeAuth` with browser persistence
 * — and cannot be imported by a test at all. These functions are pure, so the
 * arithmetic that caused the data loss is cheap to pin down directly
 * (`tests/unit/cursor.test.ts`); `./pull.ts` holds the part that needs a real
 * server to be worth testing.
 */
import type { SyncCursor } from '../../core/sync/adapter.ts';

/**
 * A position in one collection's change stream.
 *
 * A timestamp alone is not a position. Firestore hands out `serverTimestamp()`
 * at millisecond resolution, so a burst of writes — a folder deleted with its
 * notes, a queue draining after an offline spell — routinely produces several
 * documents sharing one value. Paginating with `syncedAt > at` then loses
 * whichever of those ties fall on the far side of a page boundary: the position
 * advances to `at`, and the next page asks for something strictly greater, so
 * the remaining documents at `at` are never returned again.
 *
 * Pairing the timestamp with the document id makes the ordering total, which is
 * what pagination requires. `id` is the last document consumed at `at`; the
 * empty string means "before any document", so `{ at: 0, id: '' }` is the
 * beginning of the stream.
 */
export interface Position {
  at: number;
  id: string;
}

export interface CursorPositions {
  /** Position in the notes collection. */
  notes: Position;
  /** Position in the folders collection. */
  folders: Position;
}

const START: Position = { at: 0, id: '' };

export const CURSOR_START: CursorPositions = { notes: START, folders: START };

/**
 * Decode a stored cursor.
 *
 * A bare numeric string is a cursor written before the positions were split,
 * when one number covered both collections. Seeding both sides from it is the
 * only honest reading: it is the last point we can claim to have consumed
 * either collection up to. Anything unparseable restarts from the beginning,
 * which costs one full re-pull and cannot lose data — the opposite trade would
 * be to guess a position we never reached.
 */
export function decodeCursor(cursor: SyncCursor): CursorPositions {
  if (!cursor) return { ...CURSOR_START };

  // Legacy single-position cursor.
  if (/^\d+$/.test(cursor)) {
    const at = toMillis(cursor);
    return { notes: { at, id: '' }, folders: { at, id: '' } };
  }

  try {
    const parsed: unknown = JSON.parse(cursor);
    if (!parsed || typeof parsed !== 'object') return { ...CURSOR_START };
    const { n, f } = parsed as { n?: unknown; f?: unknown };
    return { notes: toPosition(n), folders: toPosition(f) };
  } catch {
    return { ...CURSOR_START };
  }
}

function toMillis(value: unknown): number {
  const at = typeof value === 'string' || typeof value === 'number' ? Number(value) : 0;
  return Number.isFinite(at) && at > 0 ? at : 0;
}

function toPosition(value: unknown): Position {
  // Tolerate the shape from before ids were part of a position: a bare number
  // is a timestamp, and resuming at the start of that millisecond re-delivers
  // a few documents rather than skipping any.
  if (typeof value === 'string' || typeof value === 'number') {
    return { at: toMillis(value), id: '' };
  }
  if (!value || typeof value !== 'object') return { ...START };
  const { at, id } = value as { at?: unknown; id?: unknown };
  return { at: toMillis(at), id: typeof id === 'string' ? id : '' };
}

/** Encode positions back into the opaque string the engine persists. */
export function encodeCursor(positions: CursorPositions): string {
  const one = (p: Position) => ({ at: String(p.at), id: p.id });
  return JSON.stringify({ n: one(positions.notes), f: one(positions.folders) });
}

/**
 * The position after consuming a page of one collection.
 *
 * The page is ordered by `(syncedAt, documentId)`, so its last document *is*
 * the new position — no comparison needed, and none wanted: picking the
 * "newest" by timestamp would reintroduce the tie problem the id is here to
 * solve. An empty page leaves the position alone, because a page that
 * delivered nothing is not evidence that anything was consumed.
 */
export function advance(from: Position, page: readonly Position[]): Position {
  const last = page.at(-1);
  if (!last) return from;

  // A document whose `syncedAt` cannot be read reports `at: 0`, and Firestore
  // sorts a null ahead of every timestamp, so such a document can end up last
  // in a page. Adopting it would rewind the cursor to the start of time and
  // re-pull the whole account on every cycle, forever. The rules make this
  // unreachable for app writes — `syncedAt == request.time` — but a cursor
  // that can move backwards is not worth leaving to that.
  return last.at < from.at ? from : last;
}
