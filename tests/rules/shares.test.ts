/**
 * Shared links against a real Firestore emulator: the rules, and the adapter
 * functions that publish, list and revoke.
 *
 * In one file for the reason `versions.test.ts` gives — the adapter's
 * behaviour *is* a reading of the rules — and with one extra weight here. This
 * is the only collection in the product that an unauthenticated stranger may
 * read, so the tests that matter most are the ones asserting what that stranger
 * still cannot do: enumerate the collection, read an expired link, write
 * anything, or delete somebody's share.
 */
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { metered } from './metered.ts';
import { resolve } from 'node:path';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  serverTimestamp,
  Timestamp,
  Bytes,
  type Firestore,
} from 'firebase/firestore';
import { publishShare, revokeShare, listShares } from '../../src/adapters/firebase/shares.ts';
import type { RemoteShare } from '../../src/core/sync/adapter.ts';

const fs = (context: { firestore: () => unknown }): Firestore => context.firestore() as Firestore;

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const DAY = 24 * 60 * 60_000;

/** 22 base64url characters, as `newShareId()` produces. */
const ID = 'AAAABBBBCCCCDDDDEEEEFF';
const OTHER_ID = 'ZZZZYYYYXXXXWWWWVVVVUU';
const NOTE = 'note-1';

let env: RulesTestEnvironment;
const { putShareIndex, putShare } = metered(() => env);

const signedIn = (uid: string, email: string) =>
  fs(env.authenticatedContext(uid, { email, email_verified: true }));
const anonymous = () => fs(env.unauthenticatedContext());

async function invite(email: string, active = true): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `allowlist/${email}`), { active, note: 'test fixture', addedAt: 1 });
  });
}

/** The owner's record, which is what authorises writing the public document. */
/** The share key, sealed under the vault — opaque bytes as far as the rules go. */
const SEALED_KEY = Bytes.fromUint8Array(new Uint8Array([1, 1, 5, 5, 5]));

function indexDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    noteId: NOTE,
    key: SEALED_KEY,
    expireAt: Timestamp.fromMillis(Date.now() + DAY),
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

function shareDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    payload: Bytes.fromUint8Array(new Uint8Array([1, 1, 4, 2])),
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + DAY),
    ...overrides,
  };
}

/** Put a share in place without going through the rules, for read tests. */
async function seed(id: string, uid: string, expireAt: number): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = fs(ctx);
    await putShareIndex(db, uid, id, {
      v: 1,
      noteId: NOTE,
      key: SEALED_KEY,
      expireAt: Timestamp.fromMillis(expireAt),
      createdAt: Timestamp.fromMillis(Date.now()),
    });
    await setDoc(doc(db, `shares/${id}`), {
      v: 1,
      payload: Bytes.fromUint8Array(new Uint8Array([9, 9])),
      createdAt: Timestamp.fromMillis(Date.now()),
      expireAt: Timestamp.fromMillis(expireAt),
    });
  });
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'teksto-rules-test',
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8085,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  // Clearing wipes the allowlist too, so the invitations are re-issued.
  await env.clearFirestore();
  await invite(ALICE_EMAIL);
  await invite(BOB_EMAIL);
});

describe('reading a shared link', () => {
  it('lets anyone with the id read a live share', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    await assertSucceeds(getDoc(doc(anonymous(), `shares/${ID}`)));
  });

  it('refuses an expired share, even though nothing has deleted it', async () => {
    // This is the whole point of enforcing expiry on the read: the TTL policy
    // is parked on the Spark plan, so the document is still sitting there.
    await seed(ID, ALICE, Date.now() - 1000);
    await assertFails(getDoc(doc(anonymous(), `shares/${ID}`)));
  });

  it('refuses an expired share to its own owner too', async () => {
    await seed(ID, ALICE, Date.now() - 1000);
    await assertFails(getDoc(doc(signedIn(ALICE, ALICE_EMAIL), `shares/${ID}`)));
  });

  it('will not enumerate the collection', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    await assertFails(getDocs(collection(anonymous(), 'shares')));
    await assertFails(getDocs(collection(signedIn(ALICE, ALICE_EMAIL), 'shares')));
  });

  it('answers a share that was never published the same way as a revoked one', async () => {
    await assertFails(getDoc(doc(anonymous(), `shares/${ID}`)));
  });
});

describe('publishing', () => {
  it('accepts the owner record, the public document and the meter as one commit', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const expireAt = Timestamp.fromMillis(Date.now() + DAY);
    await assertSucceeds(putShare(db, ALICE, ID, indexDoc({ expireAt }), shareDoc({ expireAt })));
  });

  it('accepts a share whose owner record is already in place', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const expireAt = Timestamp.fromMillis(Date.now() + DAY);
    await assertSucceeds(putShareIndex(db, ALICE, ID, indexDoc({ expireAt })));
    await assertSucceeds(putShare(db, ALICE, ID, null, shareDoc({ expireAt })));
  });

  it('refuses the public document when no owner record exists', async () => {
    await assertFails(putShare(signedIn(ALICE, ALICE_EMAIL), ALICE, ID, null, shareDoc()));
  });

  it('refuses the public document written without the meter', async () => {
    // It used to be an unmetered write of its own; now it is a push.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putShareIndex(db, ALICE, ID, indexDoc());
    await assertFails(setDoc(doc(db, `shares/${ID}`), shareDoc()));
    await assertFails(putShare(db, ALICE, ID, null, shareDoc(), { skip: true }));
  });

  it('refuses a share whose expiry disagrees with its owner record', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putShareIndex(db, ALICE, ID, indexDoc());
    await assertFails(
      putShare(db, ALICE, ID, null, shareDoc({ expireAt: Timestamp.fromMillis(Date.now() + 20 * DAY) })),
    );
  });

  it('refuses an account that is not on the allowlist', async () => {
    await invite(BOB_EMAIL, false);
    const db = signedIn(BOB, BOB_EMAIL);
    await assertFails(putShareIndex(db, BOB, ID, indexDoc()));
  });

  it('refuses another account writing into your record', async () => {
    await assertFails(putShareIndex(signedIn(BOB, BOB_EMAIL), ALICE, ID, indexDoc()));
  });

  it('refuses an unauthenticated write', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    await assertFails(setDoc(doc(anonymous(), `shares/${ID}`), shareDoc()));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['a payload that is a string, not bytes', { payload: 'plaintext, somehow' }],
    ['no payload at all', { payload: undefined }],
    ['a client clock for createdAt', { createdAt: Date.now() }],
    ['an expiry in the past', { expireAt: Timestamp.fromMillis(Date.now() - 1000) }],
    ['an expiry beyond the ceiling', { expireAt: Timestamp.fromMillis(Date.now() + 40 * DAY) }],
    ['an unknown field', { extra: 'hello' }],
    ['a wrong schema version', { v: 2 }],
  ];

  it.each(bad)('refuses %s', async (_label, overrides) => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const expireAt = (overrides.expireAt as Timestamp | undefined) ?? Timestamp.fromMillis(Date.now() + DAY);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(fs(ctx), `users/${ALICE}/shares/${ID}`), {
        v: 1,
        noteId: NOTE,
        key: SEALED_KEY,
        expireAt,
        createdAt: Timestamp.fromMillis(Date.now()),
      });
    });
    const payload = { ...shareDoc({ expireAt }), ...overrides };
    if (overrides.payload === undefined && 'payload' in overrides) delete (payload as Record<string, unknown>).payload;
    await assertFails(putShare(db, ALICE, ID, null, payload));
  });

  it('refuses an id that is not 22 base64url characters', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(fs(ctx), `users/${ALICE}/shares/short`), indexDoc({ createdAt: Timestamp.fromMillis(1) }));
    });
    await assertFails(putShare(db, ALICE, 'short', null, shareDoc()));
  });
});

describe('revoking', () => {
  it('lets the owner delete both documents', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(deleteDoc(doc(db, `shares/${ID}`)));
    await assertSucceeds(deleteDoc(doc(db, `users/${ALICE}/shares/${ID}`)));
  });

  it('refuses everybody else', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    await assertFails(deleteDoc(doc(anonymous(), `shares/${ID}`)));
    await assertFails(deleteDoc(doc(signedIn(BOB, BOB_EMAIL), `shares/${ID}`)));
    await assertFails(deleteDoc(doc(signedIn(BOB, BOB_EMAIL), `users/${ALICE}/shares/${ID}`)));
  });

  it('still lets a revoked account take its own links down', async () => {
    // Losing the invitation must not strand a published note.
    await seed(ID, ALICE, Date.now() + DAY);
    await invite(ALICE_EMAIL, false);
    await assertSucceeds(deleteDoc(doc(signedIn(ALICE, ALICE_EMAIL), `shares/${ID}`)));
  });
});

describe('the owner’s record', () => {
  const write = (overrides: Record<string, unknown>) =>
    putShareIndex(signedIn(ALICE, ALICE_EMAIL), ALICE, ID, { ...indexDoc(), ...overrides });

  it('requires the link key as ciphertext', async () => {
    await assertFails(write({ key: 'the key, in the clear' }));
    const { key: _dropped, ...withoutKey } = indexDoc();
    await assertFails(putShareIndex(signedIn(ALICE, ALICE_EMAIL), ALICE, ID, withoutKey));
  });

  it('requires a note id and a bounded expiry', async () => {
    await assertFails(write({ noteId: '' }));
    await assertFails(write({ noteId: 'n'.repeat(65) }));
    await assertFails(write({ noteId: 'not/an/id' }));
    await assertFails(write({ expireAt: Timestamp.fromMillis(Date.now() + 40 * DAY) }));
    await assertFails(write({ expireAt: Timestamp.fromMillis(Date.now() - 1000) }));
  });

  it('refuses a client clock and unknown fields', async () => {
    await assertFails(write({ createdAt: Date.now() }));
    await assertFails(write({ extra: 1 }));
  });
});

describe('the owner’s list', () => {
  it('is readable only by its owner', async () => {
    await seed(ID, ALICE, Date.now() + DAY);
    await assertSucceeds(getDocs(collection(signedIn(ALICE, ALICE_EMAIL), `users/${ALICE}/shares`)));
    await assertFails(getDocs(collection(signedIn(BOB, BOB_EMAIL), `users/${ALICE}/shares`)));
    await assertFails(getDocs(collection(anonymous(), `users/${ALICE}/shares`)));
  });
});

describe('the adapter', () => {
  const share = (id: string, expireAt: number): RemoteShare => ({
    id,
    payload: new Uint8Array([1, 1, 2, 3, 5]) as RemoteShare['payload'],
    expireAt,
  });

  const record = (id: string) => ({
    id,
    noteId: NOTE,
    key: SEALED_KEY.toUint8Array() as RemoteShare['payload'],
  });

  it('publishes, lists and revokes', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await publishShare(db, ALICE, share(ID, Date.now() + DAY), record(ID));

    // A stranger with the link can read it.
    const read = await getDoc(doc(anonymous(), `shares/${ID}`));
    expect(read.exists()).toBe(true);

    const listed = await listShares(db, ALICE);
    expect(listed).toEqual([expect.objectContaining({ id: ID, noteId: NOTE })]);
    // The owner's record carries the link's key, sealed. The public one must not.
    expect([...listed[0]!.key]).toEqual([...SEALED_KEY.toUint8Array()]);
    expect(Object.keys(read.data()!).sort()).toEqual(['createdAt', 'expireAt', 'payload', 'v']);

    await revokeShare(db, ALICE, ID);
    expect(await listShares(db, ALICE)).toEqual([]);
    await assertFails(getDoc(doc(anonymous(), `shares/${ID}`)));
  });

  it('re-publishes to the same id, which is what keeps a link working', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await publishShare(db, ALICE, share(ID, Date.now() + DAY), record(ID));
    const first = await getDoc(doc(anonymous(), `shares/${ID}`));

    await publishShare(
      db,
      ALICE,
      { ...share(ID, Date.now() + 2 * DAY), payload: new Uint8Array([7, 7, 7]) as RemoteShare['payload'] },
      record(ID),
    );
    const second = await getDoc(doc(anonymous(), `shares/${ID}`));

    expect(second.exists()).toBe(true);
    expect(second.data()!.payload).not.toEqual(first.data()!.payload);
    expect(await listShares(db, ALICE)).toHaveLength(1);
  });

  it('leaves an expired link out of the list', async () => {
    await seed(ID, ALICE, Date.now() - 1000);
    await seed(OTHER_ID, ALICE, Date.now() + DAY);
    const listed = await listShares(signedIn(ALICE, ALICE_EMAIL), ALICE);
    expect(listed.map((s) => s.id)).toEqual([OTHER_ID]);
  });

  it('revokes twice without complaining', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await publishShare(db, ALICE, share(ID, Date.now() + DAY), record(ID));
    await revokeShare(db, ALICE, ID);
    await expect(revokeShare(db, ALICE, ID)).resolves.toBeUndefined();
  });
});
