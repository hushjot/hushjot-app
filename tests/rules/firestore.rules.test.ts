/**
 * Firestore security rules tests (§15).
 *
 * These run against the Firestore emulator. §15 requires that rules be tested
 * automatically and lists the minimum cases; this covers those plus the
 * revision compare-and-swap, which is the rule that turns a silent overwrite
 * into a detectable conflict.
 *
 * Start the emulator with `npm run emulators`, or run `npm run test:rules`
 * which starts one for the duration of the run.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { metered } from './metered.ts';
import { LOCKDOWN_SENTINEL } from '../../src/core/sync/pause.ts';
import { resolve } from 'node:path';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  serverTimestamp,
  increment,
  writeBatch,
  Bytes,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';

/**
 * Firestore's SDK does not accept a raw `Uint8Array` — it requires the `Bytes`
 * wrapper, which is what maps to the `bytes` type the rules check for. The
 * adapter uses the same conversion.
 */
const bytes = (value: Uint8Array) => Bytes.fromUint8Array(value);

/**
 * `@firebase/rules-unit-testing` hands back the *compat* Firestore type while
 * the app and these tests use the modular SDK. The objects are the same at
 * runtime; only the declarations differ, so bridge them in one place rather
 * than casting at every call site.
 */
const fs = (context: { firestore: () => unknown }): Firestore =>
  context.firestore() as Firestore;

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';

/**
 * An authenticated context carrying an email claim.
 *
 * Every rule now runs through `approved()`, which is keyed on the email rather
 * than the uid — an invitation is issued to an address, and the uid does not
 * exist until the account does. A bare `authenticatedContext(uid)` has no
 * email claim and is denied everything, which is correct but makes for
 * confusing tests, so the claim is never left out by accident.
 */
const signedIn = (uid: string, email: string) =>
  fs(env.authenticatedContext(uid, { email, email_verified: true }));

/** Put an address on the invitation list, bypassing the rules as an operator would. */
async function invite(email: string, active = true): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `allowlist/${email}`), {
      active,
      note: 'test fixture',
      addedAt: 1_700_000_000_000,
    });
  });
}

/**
 * Give a uid a paid plan, bypassing the rules as the billing API does with
 * its service account. `until` defaults to a day out; the emulator evaluates
 * `request.time` against the wall clock, so `Date.now()` is the right base.
 */
async function entitle(
  uid: string,
  o: { active?: boolean; until?: number | string; plan?: string; periodEnd?: number; storageBytes?: number } = {},
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `entitlements/${uid}`), {
      active: o.active ?? true,
      plan: o.plan ?? 'monthly',
      until: o.until ?? Date.now() + 86_400_000,
      ...(o.periodEnd === undefined ? {} : { periodEnd: o.periodEnd }),
      ...(o.storageBytes === undefined ? {} : { storageBytes: o.storageBytes }),
      paddleSubscriptionId: 'sub_test',
      updatedAt: Date.now(),
    });
  });
}

let env: RulesTestEnvironment;
const { putNote, putFolder, putShareIndex, putShare, putVersion, setMeter, month } = metered(() => env);

/**
 * A key record as `serializeKeyRecord` writes it — the frozen vector, so the
 * rules are tested against the shape the app really produces.
 */
const KEY_RECORD = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'contract/format-vectors.json'), 'utf8')) as {
    keyRecords: { record: Record<string, unknown> }[];
  }
).keyRecords[0]!.record;

/** A well-formed encrypted note, as the app would write it. */
function noteDoc(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    meta: bytes(new Uint8Array([1, 1, 9, 9, 9])),
    body: bytes(new Uint8Array([1, 1, 7, 7, 7])),
    revision,
    updatedAt: 1_700_000_000_000,
    syncedAt: serverTimestamp(),
    deleted: false,
    ...overrides,
  };
}

function folderDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    data: bytes(new Uint8Array([1, 1, 5, 5])),
    createdAt: 1_700_000_000_000,
    syncedAt: serverTimestamp(),
    deleted: false,
    ...overrides,
  };
}

const notes = (db: Firestore, uid: string) => collection(db, `users/${uid}/notes`);
const note = (db: Firestore, uid: string, id: string) => doc(db, `users/${uid}/notes/${id}`);

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
  await env?.cleanup();
});

beforeEach(async () => {
  // `clearFirestore` wipes the allowlist too, so the invitations are re-issued
  // for every test rather than seeded once.
  await env.clearFirestore();
  await invite(ALICE_EMAIL);
  await invite(BOB_EMAIL);
});

describe('isolation', () => {
  it('denies unauthenticated reads', async () => {
    const db = fs(env.unauthenticatedContext());
    await assertFails(getDoc(note(db, ALICE, 'n1')));
  });

  it('denies unauthenticated writes', async () => {
    const db = fs(env.unauthenticatedContext());
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1)));
  });

  it('denies unauthenticated collection listing', async () => {
    const db = fs(env.unauthenticatedContext());
    await assertFails(getDocs(notes(db, ALICE)));
  });

  it('lets a user write and read their own note', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
    await assertSucceeds(getDoc(note(db, ALICE, 'n1')));
  });

  it('denies user A reading user B notes', async () => {
    const bob = signedIn(BOB, BOB_EMAIL);
    await assertSucceeds(putNote(bob, BOB, 'n1', noteDoc(1)));

    const alice = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(getDoc(note(alice, BOB, 'n1')));
    await assertFails(getDocs(notes(alice, BOB)));
  });

  it('denies user A writing to user B notes', async () => {
    const alice = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(alice, BOB, 'n1', noteDoc(1)));
  });

  it('denies user A modifying an existing user B note', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(note(fs(ctx), BOB, 'n1'), noteDoc(1));
    });

    const alice = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(updateDoc(note(alice, BOB, 'n1'), { revision: 2 }));
  });
});

describe('revision compare-and-swap', () => {
  beforeEach(async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putNote(db, ALICE, 'n1', noteDoc(1));
  });

  it('accepts the next revision', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(2)));
  });

  it('rejects a stale revision', async () => {
    // The exact case a second device produces when it has fallen behind.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1)));
  });

  it('rejects a repeated revision', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(2)));
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(2)));
  });

  it('rejects a revision that skips ahead', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(5)));
  });

  it('rejects a revision that goes backwards', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(0)));
  });

  it('accepts a create at any revision, for local-first notes', async () => {
    // A note written offline for a week arrives at revision 40 the first time
    // it is ever pushed. Demanding 1 here made such a note permanently
    // unsyncable and spawned a duplicate on every attempt.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'localFirst', noteDoc(40)));
  });

  it('still requires +1 for the update that follows a high-revision create', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'localFirst', noteDoc(40)));
    await assertFails(putNote(db, ALICE, 'localFirst', noteDoc(42)));
    await assertSucceeds(putNote(db, ALICE, 'localFirst', noteDoc(41)));
  });
});

describe('document shape', () => {
  it('rejects a note with no ciphertext', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { meta: 'plaintext title' })));
  });

  it('rejects base64-encoded ciphertext', async () => {
    // Strings would waste a third of the 1 MiB document budget and usually
    // mean a client that skipped encryption entirely (plan issue #4).
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { body: 'AQEJCQk=' })));
  });

  it('rejects a payload over the size limit', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const huge = bytes(new Uint8Array(950 * 1024));
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { body: huge })));
  });

  it('accepts a payload under the size limit', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const large = bytes(new Uint8Array(500 * 1024));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1, { body: large })));
  });

  it('rejects unknown fields', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { plaintextTitle: 'oops' })));
  });

  it('rejects a client-supplied syncedAt', async () => {
    // Ordering must come from the server clock, or a skewed device could hide
    // its writes from another device's delta cursor.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { syncedAt: 1_700_000_000_000 })));
  });

  it('rejects an unknown schema version', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1, { v: 2 })));
  });

  it('allows a tombstone with no body', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
    const { body, ...tombstone } = noteDoc(2, { deleted: true });
    void body;
    await assertSucceeds(putNote(db, ALICE, 'n1', tombstone));
  });
});

describe('deletion', () => {
  it('denies hard deletes of notes', async () => {
    // A hard delete would simply resurrect from another device's next push;
    // deletion propagates as a tombstone instead (§16).
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putNote(db, ALICE, 'n1', noteDoc(1));
    await assertFails(deleteDoc(note(db, ALICE, 'n1')));
  });

  it('denies deleting the key record', async () => {
    // Losing it would orphan every note the user owns.
    const db = signedIn(ALICE, ALICE_EMAIL);
    const ref = doc(db, `users/${ALICE}/keys/primary`);
    await setDoc(ref, { v: 1, record: KEY_RECORD, updatedAt: 1 });
    await assertFails(deleteDoc(ref));
  });
});

describe('key record', () => {
  it('lets the owner store and read it', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const ref = doc(db, `users/${ALICE}/keys/primary`);
    await assertSucceeds(setDoc(ref, { v: 1, record: KEY_RECORD, updatedAt: 1 }));
    await assertSucceeds(getDoc(ref));
  });

  it('denies another user reading it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(fs(ctx), `users/${BOB}/keys/primary`), {
        v: 1,
        record: KEY_RECORD,
        updatedAt: 1,
      });
    });

    const alice = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(getDoc(doc(alice, `users/${BOB}/keys/primary`)));
  });

  it('lets the owner replace a vault-reset tombstone with a new record', async () => {
    // The billing API's reset leaves `{ v, resetAt, updatedAt }` with no
    // `record`, as a service account. The next device creates the new vault
    // with an ordinary `saveKeyRecord`, which has to pass as an update — and
    // a full set, so `resetAt` does not survive into the new vault.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(fs(ctx), `users/${ALICE}/keys/primary`), { v: 1, resetAt: 5, updatedAt: 5 });
    });

    const db = signedIn(ALICE, ALICE_EMAIL);
    const ref = doc(db, `users/${ALICE}/keys/primary`);
    await assertSucceeds(setDoc(ref, { v: 1, record: KEY_RECORD, updatedAt: 6 }));
    const after = (await getDoc(ref)).data();
    expect(after?.record).toEqual(KEY_RECORD);
    expect(after && 'resetAt' in after).toBe(false);
  });

  it('denies a client writing a tombstone itself', async () => {
    // Only the billing API may retire a record: a client that could would be
    // a stolen session able to orphan every note.
    const db = signedIn(ALICE, ALICE_EMAIL);
    const ref = doc(db, `users/${ALICE}/keys/primary`);
    await setDoc(ref, { v: 1, record: KEY_RECORD, updatedAt: 1 });
    await assertFails(setDoc(ref, { v: 1, resetAt: 2, updatedAt: 2 }));
  });

  it('is only ever `primary`', async () => {
    // A client free to choose ids could keep unmetered documents here.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(setDoc(doc(db, `users/${ALICE}/keys/secondary`), { v: 1, record: KEY_RECORD, updatedAt: 1 }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/keys/x`), { v: 1, record: KEY_RECORD, updatedAt: 1 }));
  });

  it('bounds the record by its shape, since a map has no byte size', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const ref = doc(db, `users/${ALICE}/keys/primary`);
    const put = (record: unknown) => setDoc(ref, { v: 1, record, updatedAt: 1 });
    const passphrase = KEY_RECORD.passphrase as Record<string, unknown>;

    await assertFails(put({ wrapped: 'x' }));
    await assertFails(put({ ...KEY_RECORD, padding: 'x' }));
    await assertFails(put({ ...KEY_RECORD, wrappedByPassphrase: 'A'.repeat(1025) }));
    await assertFails(put({ ...KEY_RECORD, wrappedByRecovery: { nested: 'A'.repeat(100) } }));
    await assertFails(put({ ...KEY_RECORD, passphrase: { ...passphrase, salt: 'A'.repeat(257) } }));
    await assertFails(put({ ...KEY_RECORD, passphrase: { ...passphrase, extra: 1 } }));
    await assertFails(put({ ...KEY_RECORD, recovery: { name: 'HKDF-SHA256', salt: 'A'.repeat(257) } }));
    await assertFails(put({ ...KEY_RECORD, version: 'one' }));
    const { createdAt: _gone, ...missing } = KEY_RECORD;
    await assertFails(put(missing));
    await assertFails(setDoc(ref, { v: 1, record: KEY_RECORD, updatedAt: 1, extra: true }));

    // At the caps, and comfortably over today's ~500 bytes, it still fits.
    await assertSucceeds(
      put({
        ...KEY_RECORD,
        wrappedByPassphrase: 'A'.repeat(1024),
        wrappedByRecovery: 'A'.repeat(1024),
        passphrase: { ...passphrase, salt: 'A'.repeat(256) },
      }),
    );
  });
});

describe('document ids', () => {
  it('accepts the UUIDs every client mints, and short ids', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, crypto.randomUUID(), noteDoc(1)));
    await assertSucceeds(putFolder(db, ALICE, crypto.randomUUID(), folderDoc()));
    await assertSucceeds(putNote(db, ALICE, 'a'.repeat(64), noteDoc(1)));
  });

  it('refuses ids over 64 characters or outside [A-Za-z0-9_-]', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'a'.repeat(65), noteDoc(1)));
    await assertFails(putFolder(db, ALICE, 'f'.repeat(65), folderDoc()));
    await assertFails(putNote(db, ALICE, 'has space', noteDoc(1)));
    await assertFails(putNote(db, ALICE, 'dot.ted', noteDoc(1)));
    await assertFails(putFolder(db, ALICE, 'ünï', folderDoc()));
  });
});

describe('folders', () => {
  it('lets the owner write an encrypted folder', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc()));
  });

  it('rejects a plaintext folder name', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(
      putFolder(db, ALICE, 'f1', folderDoc({ data: 'Personal' })),
    );
  });

  it('denies another user writing a folder', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putFolder(db, BOB, 'f1', folderDoc()));
  });

  it('accepts a folder carrying updatedAt', async () => {
    // How a rename or a reparent is ordered against another device's copy.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(
      putFolder(db, ALICE, 'f1', folderDoc({ updatedAt: 1_700_000_001_000 }),
      ),
    );
  });

  it('still accepts a folder without updatedAt', async () => {
    // Optional on purpose: a device still running an older client must not be
    // locked out of syncing altogether part-way through a rollout. Such a
    // folder has only ever been created, and readers fall back to createdAt.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc()));
  });

  it('rejects a non-numeric updatedAt', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(
      putFolder(db, ALICE, 'f1', folderDoc({ updatedAt: 'yesterday' })),
    );
  });

  it('rejects an unknown field on a folder', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(
      putFolder(db, ALICE, 'f1', folderDoc({ name: 'Personal' })),
    );
  });
});

describe('the storage meter', () => {
  const GiB = 1024 ** 3;
  const usage = (db: Firestore, uid: string) => doc(db, `users/${uid}/usage/current`);
  const meterOf = async (uid: string) => {
    let data: Record<string, unknown> = {};
    await env.withSecurityRulesDisabled(async (ctx) => {
      data = (await getDoc(doc(fs(ctx), `users/${uid}/usage/current`))).data() ?? {};
    });
    return data;
  };
  /** A note whose stored size is exactly `n` bytes. */
  const noteOf = (revision: number, n: number) =>
    noteDoc(revision, { body: bytes(new Uint8Array(n - 5)) });
  const KiB = 1024;

  it('accepts a write that moves it by exactly what changed, and keeps count', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 2000)));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 4000)));
    await assertSucceeds(putNote(db, ALICE, 'n2', noteOf(1, 50)));
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc()));
    // Small documents count the 1 KiB minimum.
    expect(await meterOf(ALICE)).toMatchObject({ bytes: 4000 + KiB + KiB, lastDoc: 'folders/f1', pn: 4 });
  });

  it('adds up two devices writing at the same moment', async () => {
    const one = signedIn(ALICE, ALICE_EMAIL);
    const two = signedIn(ALICE, ALICE_EMAIL);
    await Promise.all([putNote(one, ALICE, 'a', noteOf(1, 3000)), putNote(two, ALICE, 'b', noteOf(1, 7000))]);
    expect(await meterOf(ALICE)).toMatchObject({ bytes: 10_000, pn: 2 });
  });

  it('charges every note and folder at least 1 KiB, tombstones included', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    // Created at 100 bytes: the minimum, not the size.
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 100), { delta: 100 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 100), { delta: KiB }));
    // Growing inside the minimum moves nothing; past it, only the excess.
    await assertFails(putNote(db, ALICE, 'n1', noteOf(2, 900), { delta: 800 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 900), { delta: 0 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(3, 1500), { delta: 1500 - KiB }));
    // Deleting frees everything above the floor and keeps the floor: the
    // tombstone stays stored for good.
    const { body: _gone, ...tombstone } = noteDoc(4, { deleted: true });
    await assertFails(putNote(db, ALICE, 'n1', tombstone, { delta: -1500 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', tombstone, { delta: KiB - 1500 }));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc(), { delta: 4 }));
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc(), { delta: KiB }));
    expect((await meterOf(ALICE)).bytes).toBe(2 * KiB);
  });

  it('moves on every write, even one that changes no size', async () => {
    // There used to be an exemption: a same-size write could leave the meter
    // out when it already named the document. Every push now counts.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 100)));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(2, 100), { skip: true }));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(2, 100), { noPush: true }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 100)));
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc()));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc(), { skip: true }));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc(), { noPush: true }));
  });

  it('refuses a write that leaves it out', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 100), { skip: true }));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc(), { skip: true }));
  });

  it('refuses a write that reports the wrong change, either way', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 2000), { delta: 0 }));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 2000), { delta: 1999 }));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 2000), { delta: 2001 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 2000)));
    // An update is charged the difference, not the whole note again.
    await assertFails(putNote(db, ALICE, 'n1', noteOf(2, 2500), { delta: 2500 }));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 2500), { delta: 500 }));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc(), { delta: 0 }));
  });

  it('refuses a meter that names a different document', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 100), { lastDoc: 'notes/n2' }));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(1, 100), { lastDoc: 'folders/n1' }));
  });

  it('cannot be moved on its own, in either direction', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 100)));
    const pn = increment(1);
    for (const by of [-100, -1, 1]) {
      await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', bytes: increment(by), pn }, { merge: true }));
    }
    await assertFails(
      setDoc(usage(db, ALICE), { lastDoc: 'notes/n1/versions/x', bytes: increment(-100), pn }, { merge: true }),
    );
    await assertFails(
      setDoc(
        usage(db, ALICE),
        { lastDoc: 'notes/n1/versions/a1b2c3d4e5f60718293a4b5c', bytes: increment(-100), pn },
        { merge: true },
      ),
    );
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'keys/primary', bytes: increment(-100), pn }, { merge: true }));
    // Naming something unchanged with no change only spends a push, and is allowed;
    // without the push it is not.
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', bytes: increment(0) }, { merge: true }));
    await assertSucceeds(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', bytes: increment(0), pn }, { merge: true }));
  });

  it('cannot pay for one note by shrinking another in the same commit', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'big', noteOf(1, 500)));
    const batch = writeBatch(db);
    batch.set(note(db, ALICE, 'big'), noteOf(2, 100));
    batch.set(note(db, ALICE, 'new'), noteOf(1, 400));
    batch.set(usage(db, ALICE), { lastDoc: 'notes/new', bytes: increment(0), pn: increment(1) }, { merge: true });
    await assertFails(batch.commit());
  });

  it('refuses growth past the allowance, and only growth', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 2000)));
    // As the backfill would leave an account that is all but full.
    await setMeter(ALICE, { bytes: GiB - 50 });

    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 2050)));
    await assertFails(putNote(db, ALICE, 'n1', noteOf(3, 2051)));
    await assertFails(putNote(db, ALICE, 'n2', noteOf(1, 10)));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc()));
    // Growing within the 1 KiB floor adds nothing, so it fits even here.
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(3, 2000)));

    // Over the line already (a plan lowered, say): shrinking and deleting go
    // through, so the account can always get back under.
    await setMeter(ALICE, { bytes: GiB + 1000 });
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(4, 1200)));
    const { body: _gone, ...tombstone } = noteDoc(5, { deleted: true });
    await assertSucceeds(putNote(db, ALICE, 'n1', tombstone));
  });

  it('takes the allowance from the plan, and 1 GiB without one', async () => {
    const CAROL = 'carol-uid';
    await entitle(CAROL, { storageBytes: 11 * GiB });
    const db = fs(env.authenticatedContext(CAROL));
    await setMeter(CAROL, { bytes: 5 * GiB });
    await assertSucceeds(putNote(db, CAROL, 'n1', noteOf(1, 100)));

    await entitle(CAROL);
    await assertFails(putNote(db, CAROL, 'n2', noteOf(1, 100)));
  });

  it('never lets a client delete it or stamp its own reconciliation', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 2000)));
    await setMeter(ALICE, { bytes: 2000, reconciledAt: 1 });
    await assertFails(deleteDoc(usage(db, ALICE)));
    await assertFails(
      setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', reconciledAt: 2, pn: increment(1) }, { merge: true }),
    );
    // Carrying the billing API's stamp over unchanged is fine.
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(2, 2010)));
    expect(await meterOf(ALICE)).toMatchObject({ bytes: 2010, reconciledAt: 1 });
  });

  it('never lets a monthly figure go down', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteOf(1, 100)));
    await setMeter(ALICE, { bytes: 1024, hist: { [month()]: 5000 }, shares: { [month()]: 7 } });
    const pn = increment(1);
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', hist: { [month()]: 0 }, pn }, { merge: true }));
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', shares: { [month()]: 0 }, pn }, { merge: true }));
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', hist: {}, pn }));
    // Nor go up outside the commit that uploads a version or publishes a link.
    await assertFails(
      setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', hist: { [month()]: increment(1) }, pn }, { merge: true }),
    );
    await assertFails(
      setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', shares: { [month()]: increment(1) }, pn }, { merge: true }),
    );
  });

  it('keeps it to the owner', async () => {
    const bob = signedIn(BOB, BOB_EMAIL);
    await assertFails(setDoc(usage(bob, ALICE), { lastDoc: 'notes/n1', bytes: 1 }));
    await assertFails(getDoc(usage(bob, ALICE)));
  });

  it('refuses any other document or a malformed one', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(setDoc(doc(db, `users/${ALICE}/usage/other`), { lastDoc: 'notes/n1', bytes: 0 }));
    await assertFails(setDoc(usage(db, ALICE), { bytes: 0 }));
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', bytes: '0' }));
    await assertFails(setDoc(usage(db, ALICE), { lastDoc: 'notes/n1', extra: true }));
  });

  it('caps a folder at 16 KiB, so folders cannot be used as storage', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc({ data: bytes(new Uint8Array(16 * 1024)) })));
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc({ data: bytes(new Uint8Array(16 * 1024 - 1)) })));
  });
});

describe('the monthly budgets', () => {
  const sealed = (n: number) => bytes(new Uint8Array(n));
  const meterHist = async (uid: string) => {
    let value = 0;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const data = (await getDoc(doc(fs(ctx), `users/${uid}/usage/current`))).data() ?? {};
      value = (data.hist as Record<string, number> | undefined)?.[month()] ?? 0;
    });
    return value;
  };
  const versionDoc = (body = 100) => ({
    v: 1,
    meta: sealed(20),
    body: sealed(body),
    at: 1,
    reason: 'edit',
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + 86_400_000),
  });
  const V1 = 'a1b2c3d4e5f60718293a4b5c';
  const V2 = 'b1b2c3d4e5f60718293a4b5c';

  const V3 = 'c1b2c3d4e5f60718293a4b5c';

  it('charges history to this month, at exactly its charge', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    // 120 bytes counts the 1 KiB minimum, no less and no more.
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc(), 120));
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc(), 1025));
    await assertSucceeds(putVersion(db, ALICE, 'n1', V1, versionDoc()));
    await assertSucceeds(putVersion(db, ALICE, 'n1', V2, versionDoc(2000), 2020));
    const batch = writeBatch(db);
    batch.set(doc(db, `users/${ALICE}/notes/n1/versions/${V3}`), versionDoc());
    await assertFails(batch.commit());
    expect(await meterHist(ALICE)).toBe(1024 + 2020);
  });

  it('takes one version per commit, so none goes uncounted', async () => {
    // A page used to be one batch that only had to raise `hist` by its
    // largest version. Now the meter names the one version a commit carries.
    const db = signedIn(ALICE, ALICE_EMAIL);
    const batch = writeBatch(db);
    batch.set(doc(db, `users/${ALICE}/notes/n1/versions/${V1}`), versionDoc());
    batch.set(doc(db, `users/${ALICE}/notes/n1/versions/${V2}`), versionDoc());
    batch.set(
      doc(db, `users/${ALICE}/usage/current`),
      { lastDoc: `notes/n1/versions/${V2}`, hist: { [month()]: increment(1024) }, pn: increment(1) },
      { merge: true },
    );
    await assertFails(batch.commit());
    // Naming another version, or the note, does not cover this one.
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc(), undefined, { lastDoc: `notes/n1/versions/${V2}` }));
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc(), undefined, { lastDoc: 'notes/n1' }));
    // And it is a push like any other.
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc(), undefined, { noPush: true }));
    await assertSucceeds(putVersion(db, ALICE, 'n1', V1, versionDoc()));
    // A meter write naming a version that already exists moves nothing.
    await assertFails(
      setDoc(
        doc(db, `users/${ALICE}/usage/current`),
        { lastDoc: `notes/n1/versions/${V1}`, hist: { [month()]: increment(1024) }, pn: increment(1) },
        { merge: true },
      ),
    );
  });

  it('lets a note and one version of it share a commit, as `replace` does', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const noteRef = doc(db, `users/${ALICE}/notes/n1`);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1, { body: sealed(3000) })));
    const both = (bytesDelta: number, hist: number) => {
      const batch = writeBatch(db);
      batch.set(noteRef, noteDoc(2, { body: sealed(5000) }));
      batch.set(doc(db, `users/${ALICE}/notes/n1/versions/${V1}`), versionDoc(3000));
      batch.set(
        doc(db, `users/${ALICE}/usage/current`),
        { lastDoc: `notes/n1/versions/${V1}`, bytes: increment(bytesDelta), hist: { [month()]: increment(hist) }, pn: increment(1) },
        { merge: true },
      );
      return batch.commit();
    };
    await assertFails(both(0, 3020));
    await assertFails(both(2000, 0));
    await assertSucceeds(both(2000, 3020));
    // The note may not name another note's version.
    const batch = writeBatch(db);
    batch.set(noteRef, noteDoc(3, { body: sealed(5000) }));
    batch.set(doc(db, `users/${ALICE}/notes/n2/versions/${V2}`), versionDoc());
    batch.set(
      doc(db, `users/${ALICE}/usage/current`),
      { lastDoc: `notes/n2/versions/${V2}`, hist: { [month()]: increment(1024) }, pn: increment(1) },
      { merge: true },
    );
    await assertFails(batch.commit());
  });

  it('stops history at 500 MB a month', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await setMeter(ALICE, { bytes: 0, hist: { [month()]: 500_000_000 - 1024 } });
    await assertSucceeds(putVersion(db, ALICE, 'n1', V1, versionDoc()));
    await assertFails(putVersion(db, ALICE, 'n1', V2, versionDoc()));
    // Last month's figure is not this month's.
    await setMeter(ALICE, { bytes: 0, hist: { '200001': 500_000_000 } });
    await assertSucceeds(putVersion(db, ALICE, 'n1', V2, versionDoc()));
  });

  it('counts a published link, and stops at 100 a month', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const expireAt = Timestamp.fromMillis(Date.now() + 86_400_000);
    const index = { v: 1, noteId: 'n1', key: sealed(5), expireAt, createdAt: serverTimestamp() };
    await assertFails(putShareIndex(db, ALICE, 'AAAABBBBCCCCDDDDEEEEFF', index, 0));
    await assertFails(putShareIndex(db, ALICE, 'AAAABBBBCCCCDDDDEEEEFF', index, 2));
    await assertFails(putShareIndex(db, ALICE, 'AAAABBBBCCCCDDDDEEEEFF', index, 1, { noPush: true }));
    await assertSucceeds(putShareIndex(db, ALICE, 'AAAABBBBCCCCDDDDEEEEFF', index));
    await setMeter(ALICE, { bytes: 0, shares: { [month()]: 100 } });
    await assertFails(putShareIndex(db, ALICE, 'ZZZZYYYYXXXXWWWWVVVVUU', index));
    // Withdrawing one is never refused.
    await assertSucceeds(deleteDoc(doc(db, `users/${ALICE}/shares/AAAABBBBCCCCDDDDEEEEFF`)));
  });
});

describe('the daily push limit', () => {
  const HOUR = 3_600_000;
  const usage = (db: Firestore) => doc(db, `users/${ALICE}/usage/current`);
  const meterOf = async () => {
    let data: Record<string, unknown> = {};
    await env.withSecurityRulesDisabled(async (ctx) => {
      data = (await getDoc(doc(fs(ctx), `users/${ALICE}/usage/current`))).data() ?? {};
    });
    return data;
  };
  const ago = (ms: number) => Timestamp.fromMillis(Date.now() - ms);
  const V1 = 'a1b2c3d4e5f60718293a4b5c';
  const versionDoc = () => ({
    v: 1,
    meta: bytes(new Uint8Array(20)),
    body: bytes(new Uint8Array(100)),
    at: 1,
    reason: 'edit',
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + 86_400_000),
  });
  const SHARE = 'AAAABBBBCCCCDDDDEEEEFF';
  const shareParts = () => {
    const expireAt = Timestamp.fromMillis(Date.now() + 86_400_000);
    return {
      index: { v: 1, noteId: 'n1', key: bytes(new Uint8Array(5)), expireAt, createdAt: serverTimestamp() },
      share: { v: 1, payload: bytes(new Uint8Array([1, 1, 4, 2])), createdAt: serverTimestamp(), expireAt },
    };
  };

  it('counts every commit, and lets a meter without a window count on', async () => {
    // The meters written before the limit have no `ws`; they keep working.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await setMeter(ALICE, { bytes: 0, lastDoc: 'notes/x' });
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
    await assertSucceeds(putFolder(db, ALICE, 'f1', folderDoc()));
    await assertSucceeds(putVersion(db, ALICE, 'n1', V1, versionDoc()));
    expect(await meterOf()).toMatchObject({ pn: 3 });
    expect('ws' in (await meterOf())).toBe(false);
    // And may start one at any time, at the server's clock.
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(2), { reset: true }));
    const after = await meterOf();
    expect(after.pn).toBe(1);
    expect(after.ws).toBeInstanceOf(Timestamp);
  });

  it('refuses the push past 20,000 in a window', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await setMeter(ALICE, { bytes: 0, ws: ago(HOUR), pn: 19_999, lastDoc: 'notes/x' });
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
    expect((await meterOf()).pn).toBe(20_000);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(2)));
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc()));
    await assertFails(putVersion(db, ALICE, 'n1', V1, versionDoc()));
    const { index, share } = shareParts();
    await assertFails(putShareIndex(db, ALICE, SHARE, index));
    await assertFails(putShare(db, ALICE, SHARE, index, share));
    // A window an hour old cannot be reset.
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(2), { reset: true }));
  });

  it('starts a new window once the old one is over a day old, by the server clock', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await setMeter(ALICE, { bytes: 0, ws: ago(23 * HOUR), pn: 20_000, lastDoc: 'notes/x' });
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1), { reset: true }));
    await setMeter(ALICE, { bytes: 0, ws: ago(25 * HOUR), pn: 20_000, lastDoc: 'notes/x' });
    // Still not by counting on: the window is full until it is replaced.
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1)));
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1), { reset: true }));
    expect((await meterOf()).pn).toBe(1);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(2)));
    expect((await meterOf()).pn).toBe(2);
  });

  it('takes no clock but the server’s, and no count but one more', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1), { reset: true }));
    await setMeter(ALICE, { ...(await meterOf()), ws: ago(25 * HOUR), pn: 50 });
    const meter = (fields: Record<string, unknown>) =>
      setDoc(usage(db), { lastDoc: 'notes/n1', ...fields }, { merge: true });

    // A window start the client chose is refused. (Not tested at "now": a
    // local emulator can land in the same millisecond, which proves nothing —
    // and a guess that exact could only start a window the server would have.)
    await assertFails(meter({ ws: Timestamp.fromMillis(Date.now() - 1000), pn: 1 }));
    await assertFails(meter({ ws: Timestamp.fromMillis(Date.now() + HOUR), pn: 1 }));
    // A reset must come down to one; a count may only go up by one.
    await assertFails(meter({ ws: serverTimestamp(), pn: 2 }));
    await assertFails(meter({ pn: 10 }));
    await assertFails(meter({ pn: increment(2) }));
    await assertFails(meter({ pn: increment(-1) }));
    // Moving the window without resetting the count, or dropping it, is refused.
    await assertFails(meter({ ws: ago(48 * HOUR), pn: increment(1) }));
    await assertFails(setDoc(usage(db), { bytes: 1024, lastDoc: 'notes/n1', pn: 1 }));
    await assertFails(meter({ ws: 'yesterday', pn: 1 }));
    await assertSucceeds(meter({ pn: increment(1) }));
  });

  it('counts a publish once, for both of its documents', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const { index, share } = shareParts();
    await assertSucceeds(putShare(db, ALICE, SHARE, index, share));
    expect(await meterOf()).toMatchObject({ pn: 1, shares: { [month()]: 1 } });
    // The public document is a push too: no longer writable unmetered.
    await assertFails(setDoc(doc(db, `shares/${SHARE}`), share));
    await assertFails(putShare(db, ALICE, SHARE, null, share, { noPush: true }));
    await assertSucceeds(putShare(db, ALICE, SHARE, null, share));
    expect(await meterOf()).toMatchObject({ pn: 2, shares: { [month()]: 2 } });
  });
});

describe('unmatched paths', () => {
  it('denies collections the rules do not name', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(setDoc(doc(db, 'somethingElse/x'), { a: 1 }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/unexpected/x`), { a: 1 }));
  });

  // The lockdown sentinel (src/core/sync/pause.ts). A client that has been
  // refused reads it to learn whether the cost kill switch is in place: the
  // lockdown ruleset allows this `get`, so these rules must refuse it — to
  // everyone, approved or not — or every refused client would believe sync
  // is paused and no lapsed plan would ever be reported. The other half is
  // tests/rules/lockdown.test.ts.
  it('refuses the lockdown sentinel to everyone', async () => {
    await assertFails(getDoc(doc(fs(env.unauthenticatedContext()), LOCKDOWN_SENTINEL)));
    await entitle(ALICE);
    const alice = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(getDoc(doc(alice, LOCKDOWN_SENTINEL)));
    await assertFails(getDocs(collection(alice, 'status')));
    await assertFails(setDoc(doc(alice, LOCKDOWN_SENTINEL), { a: 1 }));
  });
});

describe('the allowlist', () => {
  it('lets an approved user sync', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
  });

  it('denies an address that was never invited', async () => {
    const db = signedIn('carol-uid', 'carol@example.com');
    await assertFails(putNote(db, 'carol-uid', 'n1', noteDoc(1)));
    await assertFails(getDoc(note(db, 'carol-uid', 'n1')));
  });

  it('denies an invitation that has been deactivated', async () => {
    await invite(ALICE_EMAIL, false);
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1)));
    await assertFails(getDoc(note(db, ALICE, 'n1')));
  });

  it('denies a token with no email claim at all', async () => {
    const db = fs(env.authenticatedContext(ALICE));
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(1)));
  });

  it('ignores the casing of the address on the token', async () => {
    // The invitation is written lowercase; the account signs in as typed.
    const db = signedIn(ALICE, 'Alice@Example.COM');
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));
  });

  it('revokes access mid-session without touching stored notes', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putNote(db, ALICE, 'n1', noteDoc(1)));

    await invite(ALICE_EMAIL, false);

    await assertFails(getDoc(note(db, ALICE, 'n1')));
    await assertFails(putNote(db, ALICE, 'n1', noteDoc(2)));
  });

  it('also gates folders and the key record', async () => {
    await invite(ALICE_EMAIL, false);
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(putFolder(db, ALICE, 'f1', folderDoc()));
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/keys/primary`), { v: 1, record: {}, updatedAt: 1 }),
    );
  });

  it('lets a user read their own invitation', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(getDoc(doc(db, `allowlist/${ALICE_EMAIL}`)));
  });

  it("denies reading someone else's invitation", async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(getDoc(doc(db, `allowlist/${BOB_EMAIL}`)));
  });

  it('denies listing the invitations — no address enumeration', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertFails(getDocs(collection(db, 'allowlist')));
  });

  it('denies a user inviting themselves', async () => {
    const db = signedIn('carol-uid', 'carol@example.com');
    await assertFails(
      setDoc(doc(db, 'allowlist/carol@example.com'), { active: true, addedAt: 1 }),
    );
  });

  it('denies an unauthenticated read of the allowlist', async () => {
    const db = fs(env.unauthenticatedContext());
    await assertFails(getDoc(doc(db, `allowlist/${ALICE_EMAIL}`)));
  });
});

describe('entitlements', () => {
  const CAROL = 'carol-uid';
  const CAROL_EMAIL = 'carol@example.com';
  const DAY = 86_400_000;

  it('lets a paying user sync without an invitation', async () => {
    await entitle(CAROL);
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertSucceeds(putNote(db, CAROL, 'n1', noteDoc(1)));
    await assertSucceeds(getDoc(note(db, CAROL, 'n1')));
    await assertSucceeds(putFolder(db, CAROL, 'f1', folderDoc()));
  });

  it('decides on until, whatever periodEnd says', async () => {
    // `periodEnd` is the renewal date for the clients to show. Inside the
    // grace it is already in the past while `until` is not, and the plan
    // must go on working: grace is the whole reason the two differ.
    await entitle(CAROL, { until: Date.now() + DAY, periodEnd: Date.now() - DAY });
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertSucceeds(putNote(db, CAROL, 'n1', noteDoc(1)));

    await entitle(CAROL, { until: Date.now() - 1000, periodEnd: Date.now() + DAY });
    await assertFails(getDoc(note(db, CAROL, 'n1')));
  });

  it('denies a plan whose until has passed', async () => {
    await entitle(CAROL, { until: Date.now() - 1000 });
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertFails(putNote(db, CAROL, 'n1', noteDoc(1)));
    await assertFails(getDoc(note(db, CAROL, 'n1')));
  });

  it('denies a plan that is not active, whatever until says', async () => {
    await entitle(CAROL, { active: false, until: Date.now() + DAY });
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertFails(putNote(db, CAROL, 'n1', noteDoc(1)));
  });

  it('denies a plan whose until is not an integer', async () => {
    // The billing API encodes `until` as a Firestore integer; a string here
    // would mean that encoding broke, and the rules must fail closed.
    await entitle(CAROL, { until: String(Date.now() + DAY) });
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertFails(putNote(db, CAROL, 'n1', noteDoc(1)));
  });

  it('lets a user read their own plan and nobody else’s', async () => {
    await entitle(CAROL);
    await entitle(ALICE);
    await assertSucceeds(getDoc(doc(signedIn(CAROL, CAROL_EMAIL), `entitlements/${CAROL}`)));
    await assertFails(getDoc(doc(signedIn(CAROL, CAROL_EMAIL), `entitlements/${ALICE}`)));
    await assertFails(getDoc(doc(signedIn(ALICE, ALICE_EMAIL), `entitlements/${CAROL}`)));
    await assertFails(getDoc(doc(fs(env.unauthenticatedContext()), `entitlements/${CAROL}`)));
  });

  it('denies a user writing their own plan', async () => {
    await entitle(CAROL, { active: false });
    const db = signedIn(CAROL, CAROL_EMAIL);
    const mine = doc(db, `entitlements/${CAROL}`);
    await assertFails(setDoc(mine, { active: true, plan: 'yearly', until: Date.now() + DAY }));
    await assertFails(updateDoc(mine, { active: true }));
    await assertFails(deleteDoc(mine));
    await assertFails(
      setDoc(doc(db, `entitlements/${ALICE}`), { active: true, plan: 'yearly', until: Date.now() + DAY }),
    );
  });

  it('denies listing the plans', async () => {
    await entitle(CAROL);
    await assertFails(getDocs(collection(signedIn(CAROL, CAROL_EMAIL), 'entitlements')));
  });

  it('keeps invitations working beside plans', async () => {
    // Alice is invited and has no plan; Carol has a plan and no invitation.
    await entitle(CAROL);
    await assertSucceeds(putNote(signedIn(ALICE, ALICE_EMAIL), ALICE, 'n1', noteDoc(1)));
    await assertSucceeds(putNote(signedIn(CAROL, CAROL_EMAIL), CAROL, 'n1', noteDoc(1)));
    // An invitation that was withdrawn is not rescued by someone else's plan.
    await invite(BOB_EMAIL, false);
    await assertFails(putNote(signedIn(BOB, BOB_EMAIL), BOB, 'n1', noteDoc(1)));
  });

  it('lets a paying user publish a share, and an expired one not', async () => {
    const expireAt = Timestamp.fromMillis(Date.now() + DAY);
    const key = bytes(new Uint8Array([1, 1, 5, 5, 5]));
    const index = { v: 1, noteId: 'n1', key, expireAt, createdAt: serverTimestamp() };
    const share = { v: 1, payload: bytes(new Uint8Array([1, 1, 4, 2])), createdAt: serverTimestamp(), expireAt };

    // A share id is 22 base64url characters; the rules match the shape.
    const FIRST = 'AAAABBBBCCCCDDDDEEEEFF';
    const SECOND = 'ZZZZYYYYXXXXWWWWVVVVUU';

    await entitle(CAROL);
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertSucceeds(putShare(db, CAROL, FIRST, index, share));

    await entitle(CAROL, { until: Date.now() - 1000 });
    await assertFails(putShareIndex(db, CAROL, SECOND, index));
    // Revocation needs no plan: a lapsed account can still take its links down.
    await assertSucceeds(deleteDoc(doc(db, `shares/${FIRST}`)));
  });

  it('is keyed by uid, so a token with no email claim still syncs', async () => {
    await entitle(CAROL);
    const db = fs(env.authenticatedContext(CAROL));
    await assertSucceeds(putNote(db, CAROL, 'n1', noteDoc(1)));
  });

  it('revokes access mid-session when the plan is switched off', async () => {
    await entitle(CAROL);
    const db = signedIn(CAROL, CAROL_EMAIL);
    await assertSucceeds(putNote(db, CAROL, 'n1', noteDoc(1)));

    await entitle(CAROL, { active: false });

    await assertFails(getDoc(note(db, CAROL, 'n1')));
    await assertFails(putNote(db, CAROL, 'n1', noteDoc(2)));
  });
});
