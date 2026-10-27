/**
 * One page of the delta pull.
 *
 * Separated from `adapter.ts` so it can be exercised against a real Firestore
 * emulator without building and driving the whole app. That matters more here
 * than anywhere else in the adapter: this is where a cursor bug silently and
 * permanently dropped documents, and the only way to catch such a thing is to
 * run the real queries against a real server. The adapter above it is browser
 * code — it calls `initializeAuth` with browser persistence — so the seam has
 * to be below the adapter rather than at it.
 *
 * Reading two collections means two queries, and two queries mean two
 * positions. Why that is not negotiable is written up in `./cursor.ts`.
 */
import {
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  where,
  startAfter,
  documentId,
  Timestamp,
  Bytes,
  type CollectionReference,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { PullResult, RemoteFolder, RemoteNote, SyncCursor } from '../../core/sync/adapter.ts';
import type { Bytes as RawBytes } from '../../core/crypto/bytes.ts';
import { advance, decodeCursor, encodeCursor, type Position } from './cursor.ts';
import { count } from './opCount.ts';

export function readNote(snapshot: QueryDocumentSnapshot<DocumentData>): RemoteNote {
  const data = snapshot.data();
  const note: RemoteNote = {
    id: snapshot.id,
    meta: (data.meta as Bytes).toUint8Array() as RawBytes,
    revision: data.revision as number,
    updatedAt: data.updatedAt as number,
    deleted: Boolean(data.deleted),
  };
  if (data.body) note.body = (data.body as Bytes).toUint8Array() as RawBytes;
  return note;
}

export function readFolder(snapshot: QueryDocumentSnapshot<DocumentData>): RemoteFolder {
  const data = snapshot.data();
  const createdAt = data.createdAt as number;
  return {
    id: snapshot.id,
    data: (data.data as Bytes).toUint8Array() as RawBytes,
    createdAt,
    // Written by a client predating folder mutation, so fall back to the
    // creation time: such a folder has only ever been created.
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : createdAt,
    deleted: Boolean(data.deleted),
  };
}

/**
 * One page of a collection's change stream, ordered totally.
 *
 * `orderBy(syncedAt)` alone is not a total order — Firestore's server
 * timestamps collide at millisecond resolution — so pagination has to break
 * ties on something, and the document id is the only other thing every
 * document has. `startAfter` on the pair is then exact: it resumes at the
 * document after the last one consumed, whether or not its neighbours share a
 * timestamp. A `where('syncedAt', '>', …)` filter cannot express that, which is
 * how documents sharing a millisecond with a page boundary used to be skipped.
 *
 * `documentId()` is appended to every single-field index, so this needs no
 * composite index.
 */
const changesSince = (col: CollectionReference, from: Position, pageSize: number) => {
  // `startAfter` is validated against the orderBy clauses already on the
  // query, so the ordering has to be applied first.
  const ordered = query(col, orderBy('syncedAt'), orderBy(documentId()));

  // No id yet: either the stream has never been read, or the position came
  // from a cursor written before ids were part of one. `startAfter` cannot
  // express that — it resolves its id argument against the collection path,
  // and an empty string is not a document — so bound it inclusively instead.
  // Re-delivering the documents sitting exactly on `at` costs nothing: the
  // engine discards an echo. Skipping them would not be recoverable.
  if (from.id === '') {
    return query(ordered, where('syncedAt', '>=', Timestamp.fromMillis(from.at)), fsLimit(pageSize));
  }

  return query(ordered, startAfter(Timestamp.fromMillis(from.at), from.id), fsLimit(pageSize));
};

const positionOf = (snapshot: QueryDocumentSnapshot<DocumentData>): Position => {
  const value: unknown = snapshot.data().syncedAt;
  return {
    at: value instanceof Timestamp ? value.toMillis() : 0,
    id: snapshot.id,
  };
};

export async function pullPage(
  notesCol: CollectionReference,
  foldersCol: CollectionReference,
  cursor: SyncCursor,
  pageSize: number,
): Promise<PullResult> {
  const from = decodeCursor(cursor);

  const [noteSnaps, folderSnaps] = await Promise.all([
    getDocs(changesSince(notesCol, from.notes, pageSize)),
    getDocs(changesSince(foldersCol, from.folders, pageSize)),
  ]);
  // An empty result is still a billed read.
  count('pull', Math.max(1, noteSnaps.size), 0);
  count('pull', Math.max(1, folderSnaps.size), 0);

  // Each position advances only over documents its *own* query returned.
  //
  // A single shared position let one collection's newest timestamp carry the
  // cursor past documents the other had not delivered yet — either because
  // that other query saturated its page and left a remainder, or simply
  // because these two reads are not one atomic snapshot. Since the next page
  // resumed after that position, anything stepped over was never offered
  // again. `./cursor.ts` has the full account.
  const next = {
    notes: advance(from.notes, noteSnaps.docs.map(positionOf)),
    folders: advance(from.folders, folderSnaps.docs.map(positionOf)),
  };

  return {
    notes: noteSnaps.docs.map(readNote),
    folders: folderSnaps.docs.map(readFolder),
    cursor: encodeCursor(next),
    hasMore: noteSnaps.size === pageSize || folderSnaps.size === pageSize,
  };
}
