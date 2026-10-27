/**
 * The delta pull, against a real Firestore emulator.
 *
 * `tests/unit` cannot reach this code: it issues real queries whose ordering
 * and pagination semantics are the server's, and the bug being guarded against
 * was precisely a disagreement between what the code assumed those semantics
 * guaranteed and what they actually do. A fake would have agreed with the
 * assumption and passed.
 *
 * The bug: notes and folders are read with two separate queries, each with its
 * own limit, and a single shared cursor was advanced to the newest `syncedAt`
 * across both. Whichever collection reached further into the future dragged the
 * cursor past the other's undelivered backlog, and because the next page filters
 * on `syncedAt > cursor`, those documents were never returned again. Folders
 * were the usual casualty — notes are written constantly, folders only on create
 * and delete — so a note would sync to a second device already filed in a folder
 * that did not exist there.
 *
 * `pullPage` is the same function the Firebase adapter calls; the adapter itself
 * cannot be imported here because it is browser code.
 */
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  doc,
  setDoc,
  collection,
  serverTimestamp,
  Bytes,
  type CollectionReference,
  type Firestore,
} from 'firebase/firestore';
import { pullPage } from '../../src/adapters/firebase/pull.ts';

const fs = (context: { firestore: () => unknown }): Firestore =>
  context.firestore() as Firestore;

const UID = 'alice-uid';
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'teksto-pull-test',
    firestore: {
      // Host and port come from FIRESTORE_EMULATOR_HOST, which
      // `firebase emulators:exec` sets — same as the rules suite next door.
      //
      // These cases are about query semantics rather than authorisation, so
      // they seed and read with the rules disabled; authorisation has its own
      // suite. The real rules are still loaded so the documents written here
      // have to be shapes the backend would actually accept.
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

/**
 * Write documents one at a time so each gets a distinct server timestamp.
 *
 * That ordering is the whole subject of these tests: the skew between when a
 * note landed and when a folder did is what the old shared cursor collapsed.
 */
async function seed(
  db: Firestore,
  writes: readonly { path: string; data: Record<string, unknown> }[],
): Promise<void> {
  for (const write of writes) {
    await setDoc(doc(db, write.path), { ...write.data, syncedAt: serverTimestamp() });
  }
}

const note = (revision: number) => ({
  v: 1,
  meta: Bytes.fromUint8Array(new Uint8Array([1, 1, 9])),
  body: Bytes.fromUint8Array(new Uint8Array([1, 1, 7])),
  revision,
  updatedAt: 1_700_000_000_000,
  deleted: false,
});

const folder = () => ({
  v: 1,
  data: Bytes.fromUint8Array(new Uint8Array([1, 1, 5])),
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  deleted: false,
});

/** Page until the backend says there is nothing left, as the engine does. */
async function drain(
  notesCol: CollectionReference,
  foldersCol: CollectionReference,
  pageSize: number,
): Promise<{ notes: Set<string>; folders: Set<string> }> {
  const notes = new Set<string>();
  const folders = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = await pullPage(notesCol, foldersCol, cursor, pageSize);
    for (const n of result.notes) notes.add(n.id);
    for (const f of result.folders) folders.add(f.id);
    // The engine stops when the cursor stops moving, so mirror that here
    // rather than looping forever on a buggy implementation.
    const advanced = result.cursor !== cursor;
    cursor = result.cursor;
    if (!result.hasMore || !advanced) break;
  }
  return { notes, folders };
}

const cols = (db: Firestore): [CollectionReference, CollectionReference] => [
  collection(db, `users/${UID}/notes`),
  collection(db, `users/${UID}/folders`),
];

describe('pullPage', () => {
  /**
   * How the shared cursor actually lost documents.
   *
   * One collection has more pending changes than fit in a page, so its query
   * saturates and leaves a remainder. The *other* collection holds something
   * newer than anything that remainder contains. A single cursor advanced to
   * the newest timestamp across both then landed beyond the remainder, and
   * `syncedAt > cursor` meant those documents were never offered again.
   *
   * Folders were the usual casualty in practice for the opposite reason to
   * the one that might be expected: they are written so rarely that the note
   * stream almost always holds something newer, and nothing ever re-stamps a
   * folder's `syncedAt` to give it a second chance.
   */
  it('delivers every folder when the folders page saturates and a newer note exists', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      // Three folders, so a page size of two leaves f3 behind...
      await seed(db, [
        { path: `users/${UID}/folders/f1`, data: folder() },
        { path: `users/${UID}/folders/f2`, data: folder() },
        { path: `users/${UID}/folders/f3`, data: folder() },
      ]);
      // ...and one note written afterwards, newer than all of them.
      await seed(db, [{ path: `users/${UID}/notes/n1`, data: note(1) }]);

      const [notesCol, foldersCol] = cols(db);
      const seen = await drain(notesCol, foldersCol, 2);

      // f3 is the one the shared cursor stepped over.
      expect([...seen.folders].sort()).toEqual(['f1', 'f2', 'f3']);
      expect([...seen.notes]).toEqual(['n1']);
    });
  });

  it('delivers every note when the notes page saturates and a newer folder exists', async () => {
    // The same failure with the collections swapped. This is what makes it a
    // cursor bug rather than a folder bug: it drops notes just as happily.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await seed(db, [
        { path: `users/${UID}/notes/n1`, data: note(1) },
        { path: `users/${UID}/notes/n2`, data: note(1) },
        { path: `users/${UID}/notes/n3`, data: note(1) },
      ]);
      await seed(db, [{ path: `users/${UID}/folders/f1`, data: folder() }]);

      const [notesCol, foldersCol] = cols(db);
      const seen = await drain(notesCol, foldersCol, 2);

      expect([...seen.notes].sort()).toEqual(['n1', 'n2', 'n3']);
      expect([...seen.folders]).toEqual(['f1']);
    });
  });

  it('delivers every note when a page boundary falls inside one millisecond', async () => {
    // Server timestamps are millisecond-resolution, so a burst of writes — a
    // queue draining after an offline spell, a folder deleted with its notes —
    // routinely gives several documents the same `syncedAt`. Paginating with
    // `syncedAt > position` then dropped whichever of those ties fell beyond
    // the page boundary: the position advanced to that millisecond, and the
    // next page asked for something strictly greater.
    //
    // These five are written without awaiting each other precisely so they
    // collide, which is what a real burst does.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          setDoc(doc(db, `users/${UID}/notes/n${i}`), {
            ...note(1),
            syncedAt: serverTimestamp(),
          }),
        ),
      );

      const [notesCol, foldersCol] = cols(db);
      const seen = await drain(notesCol, foldersCol, 2);

      expect([...seen.notes].sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    });
  });

  it('returns nothing once caught up, and does not move the cursor', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await seed(db, [
        { path: `users/${UID}/notes/n1`, data: note(1) },
        { path: `users/${UID}/folders/f1`, data: folder() },
      ]);

      const [notesCol, foldersCol] = cols(db);
      const first = await pullPage(notesCol, foldersCol, null, 50);
      expect(first.notes).toHaveLength(1);
      expect(first.folders).toHaveLength(1);
      expect(first.hasMore).toBe(false);

      const second = await pullPage(notesCol, foldersCol, first.cursor, 50);
      expect(second.notes).toHaveLength(0);
      expect(second.folders).toHaveLength(0);
      expect(second.cursor).toBe(first.cursor);
    });
  });

  it('picks up only what changed after the cursor', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await seed(db, [{ path: `users/${UID}/notes/n1`, data: note(1) }]);

      const [notesCol, foldersCol] = cols(db);
      const first = await pullPage(notesCol, foldersCol, null, 50);

      await seed(db, [{ path: `users/${UID}/folders/f1`, data: folder() }]);

      const second = await pullPage(notesCol, foldersCol, first.cursor, 50);
      expect(second.notes).toHaveLength(0);
      expect(second.folders.map((f) => f.id)).toEqual(['f1']);
    });
  });

  it('reads a folder written without updatedAt as created-only', async () => {
    // An older client's document. Falling back to `createdAt` keeps it
    // orderable instead of leaving it undefined.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      const { updatedAt, ...legacy } = folder();
      void updatedAt;
      await seed(db, [{ path: `users/${UID}/folders/f1`, data: legacy }]);

      const [notesCol, foldersCol] = cols(db);
      const page = await pullPage(notesCol, foldersCol, null, 50);
      expect(page.folders[0]?.updatedAt).toBe(1_700_000_000_000);
    });
  });
});
