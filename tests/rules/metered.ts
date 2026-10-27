/**
 * Writes as the clients make them: the document and the storage meter in one
 * commit (`src/core/sync/usage.ts`). Every rules test that writes a note, a
 * folder, a version or an owner's share record goes through these, so that a
 * test refused for its own reason is not refused for a missing meter instead.
 *
 * The delta is worked out the honest way, from what is stored now (read with
 * the rules off) and what is being written, minimum charge included
 * (`meterDelta`). Every commit counts one push: `pn` is incremented, or reset
 * with `ws` when the test says so. A test that wants to lie passes `delta`
 * itself.
 */
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Bytes,
  doc,
  getDoc,
  increment,
  serverTimestamp,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';

import { chargedBytes, meterDelta } from '../../src/core/sync/usage.ts';

const size = (data: DocumentData | undefined, fields: readonly string[]): number =>
  fields.reduce((sum, f) => sum + (data?.[f] instanceof Bytes ? (data[f] as Bytes).toUint8Array().length : 0), 0);

const month = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export interface Lie {
  /** Send this bytes delta instead of the true one. */
  delta?: number;
  /** Name this document in `lastDoc` instead. */
  lastDoc?: string;
  /** Leave the meter out of the commit altogether. */
  skip?: boolean;
  /** Leave the push count alone (the meter is written, `pn` is not moved). */
  noPush?: boolean;
  /** Start a new push window rather than counting into the current one. */
  reset?: boolean;
}

/** The push half of a meter write, as `meterInto` sends it. */
export function pushFields(lie: Pick<Lie, 'noPush' | 'reset'> = {}): DocumentData {
  if (lie.noPush) return {};
  return lie.reset ? { ws: serverTimestamp(), pn: 1 } : { pn: increment(1) };
}

export function metered(env: () => RulesTestEnvironment) {
  const stored = async (path: string, fields: readonly string[]): Promise<number> => {
    let bytes = 0;
    await env().withSecurityRulesDisabled(async (ctx) => {
      const snapshot = await getDoc(doc(ctx.firestore() as unknown as Firestore, path));
      bytes = size(snapshot.data(), fields);
    });
    return bytes;
  };

  const usage = (db: Firestore, uid: string) => doc(db, `users/${uid}/usage/current`);

  async function put(
    db: Firestore,
    uid: string,
    relative: string,
    data: DocumentData,
    fields: readonly string[],
    lie: Lie,
  ): Promise<void> {
    const path = `users/${uid}/${relative}`;
    const delta = lie.delta ?? meterDelta(size(data, fields), await stored(path, fields));
    const batch = writeBatch(db);
    batch.set(doc(db, path), data);
    if (!lie.skip) {
      batch.set(
        usage(db, uid),
        {
          lastDoc: lie.lastDoc ?? relative,
          bytes: increment(delta),
          pushes: { [month()]: increment(1) },
          ...pushFields(lie),
        },
        { merge: true },
      );
    }
    await batch.commit();
  }

  return {
    month,
    putNote: (db: Firestore, uid: string, id: string, data: DocumentData, lie: Lie = {}) =>
      put(db, uid, `notes/${id}`, data, ['meta', 'body'], lie),

    putFolder: (db: Firestore, uid: string, id: string, data: DocumentData, lie: Lie = {}) =>
      put(db, uid, `folders/${id}`, data, ['data'], lie),

    /** A version upload, adding `history` (default: its charge) to this month. */
    async putVersion(
      db: Firestore,
      uid: string,
      noteId: string,
      id: string,
      data: DocumentData,
      history?: number,
      lie: Pick<Lie, 'noPush' | 'reset' | 'lastDoc'> = {},
    ) {
      const relative = `notes/${noteId}/versions/${id}`;
      const batch = writeBatch(db);
      batch.set(doc(db, `users/${uid}/${relative}`), data);
      batch.set(
        usage(db, uid),
        {
          lastDoc: lie.lastDoc ?? relative,
          hist: { [month()]: increment(history ?? chargedBytes(size(data, ['meta', 'body']))) },
          ...pushFields(lie),
        },
        { merge: true },
      );
      await batch.commit();
    },

    /** The owner's record of a link, counting one publish this month (or `count`). */
    async putShareIndex(
      db: Firestore,
      uid: string,
      id: string,
      data: DocumentData,
      count = 1,
      lie: Pick<Lie, 'noPush' | 'reset'> = {},
    ) {
      const relative = `shares/${id}`;
      const batch = writeBatch(db);
      batch.set(doc(db, `users/${uid}/${relative}`), data);
      batch.set(
        usage(db, uid),
        { lastDoc: relative, shares: { [month()]: increment(count) }, ...pushFields(lie) },
        { merge: true },
      );
      await batch.commit();
    },

    /**
     * A publish as the app makes it: the owner's record (unless `index` is
     * null, for a record already in place), the public blob and the meter,
     * one commit.
     */
    async putShare(
      db: Firestore,
      uid: string,
      id: string,
      index: DocumentData | null,
      share: DocumentData,
      lie: Pick<Lie, 'noPush' | 'reset' | 'skip'> = {},
    ) {
      const batch = writeBatch(db);
      if (index) batch.set(doc(db, `users/${uid}/shares/${id}`), index);
      batch.set(doc(db, `shares/${id}`), share);
      if (!lie.skip) {
        batch.set(
          usage(db, uid),
          { lastDoc: `shares/${id}`, shares: { [month()]: increment(1) }, ...pushFields(lie) },
          { merge: true },
        );
      }
      await batch.commit();
    },

    /** Set the meter directly, as the billing API's backfill does. */
    async setMeter(uid: string, fields: DocumentData) {
      await env().withSecurityRulesDisabled(async (ctx) => {
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(ctx.firestore() as unknown as Firestore, `users/${uid}/usage/current`), fields);
      });
    },
  };
}
