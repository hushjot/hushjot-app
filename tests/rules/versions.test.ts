/**
 * Note versions against a real Firestore emulator: the rules, and the adapter
 * functions that write and page through them.
 *
 * The two belong in one file because the adapter's behaviour *is* a reading of
 * the rules. A duplicate version is refused as an update, and the batch push
 * decides whether that refusal was harmless by reading the document back; a
 * fake would have to guess what the rules do, and the whole point is not to.
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
  updateDoc,
  deleteDoc,
  collection,
  collectionGroup,
  getDocs,
  serverTimestamp,
  Timestamp,
  Bytes,
  type Firestore,
} from 'firebase/firestore';
import {
  listVersionPage,
  pushVersionBatch,
  VersionAccessDenied,
} from '../../src/adapters/firebase/versions.ts';
import type { RemoteVersion } from '../../src/core/sync/adapter.ts';
import { PushLimitError } from '../../src/core/sync/usage.ts';

const fs = (context: { firestore: () => unknown }): Firestore => context.firestore() as Firestore;

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const DAY = 24 * 60 * 60_000;
const SEAL = 'a1b2c3d4e5f60718293a4b5c';

let env: RulesTestEnvironment;
const { putVersion, setMeter, month } = metered(() => env);

const signedIn = (uid: string, email: string) =>
  fs(env.authenticatedContext(uid, { email, email_verified: true }));

async function invite(email: string, active = true): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `allowlist/${email}`), { active, note: 'test fixture', addedAt: 1 });
  });
}

const version = (db: Firestore, uid: string, noteId: string, id: string) =>
  doc(db, `users/${uid}/notes/${noteId}/versions/${id}`);

function versionDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    meta: Bytes.fromUint8Array(new Uint8Array([1, 1, 9, 9])),
    body: Bytes.fromUint8Array(new Uint8Array([1, 1, 7, 7])),
    at: 1_700_000_000_000,
    reason: 'edit',
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + DAY),
    ...overrides,
  };
}

function remote(noteId: string, id: string, overrides: Partial<RemoteVersion> = {}): RemoteVersion {
  return {
    noteId,
    id,
    meta: new Uint8Array([1, 1, 3, 3]) as RemoteVersion['meta'],
    body: new Uint8Array([1, 1, 4, 4]) as RemoteVersion['body'],
    at: 1_700_000_000_000,
    reason: 'edit',
    expireAt: Date.now() + DAY,
    ...overrides,
  };
}

const hex = (n: number) => n.toString(16).padStart(24, '0');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'teksto-versions-test',
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8') },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await invite(ALICE_EMAIL);
  await invite(BOB_EMAIL);
});

describe('version rules', () => {
  it('lets the owner create and read a version', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(putVersion(db, ALICE, 'n1', SEAL, versionDoc()));
    await assertSucceeds(getDoc(version(db, ALICE, 'n1', SEAL)));
    await assertSucceeds(getDocs(collection(db, `users/${ALICE}/notes/n1/versions`)));
  });

  it('refuses anyone else, and an account that is not approved', async () => {
    const bob = signedIn(BOB, BOB_EMAIL);
    await assertFails(putVersion(bob, ALICE, 'n1', SEAL, versionDoc()));

    await putVersion(signedIn(ALICE, ALICE_EMAIL), ALICE, 'n1', SEAL, versionDoc());
    await assertFails(getDoc(version(bob, ALICE, 'n1', SEAL)));
    await assertFails(getDocs(collection(bob, `users/${ALICE}/notes/n1/versions`)));

    await invite(ALICE_EMAIL, false);
    await assertFails(getDoc(version(signedIn(ALICE, ALICE_EMAIL), ALICE, 'n1', SEAL)));
    await assertFails(putVersion(signedIn(ALICE, ALICE_EMAIL), ALICE, 'n1', hex(2), versionDoc()));
  });

  it('never lets a version change or be deleted, even by its owner', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putVersion(db, ALICE, 'n1', SEAL, versionDoc());
    await assertFails(putVersion(db, ALICE, 'n1', SEAL, versionDoc()));
    await assertFails(updateDoc(version(db, ALICE, 'n1', SEAL), { reason: 'delete' }));
    await assertFails(deleteDoc(version(db, ALICE, 'n1', SEAL)));
  });

  it('refuses a query across every user’s versions', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await putVersion(db, ALICE, 'n1', SEAL, versionDoc());
    await assertFails(getDocs(collectionGroup(db, 'versions')));
  });

  it.each([
    ['an id that is not a nonce', { id: 'not-a-nonce' }],
    ['a plaintext body', { body: 'hello' }],
    ['a missing body', { body: undefined }],
    ['an unknown field', { title: 'oops' }],
    ['an unknown reason', { reason: 'backup' }],
    ['a client-supplied createdAt', { createdAt: Timestamp.now() }],
    ['an expiry in the past', { expireAt: Timestamp.fromMillis(Date.now() - 60_000) }],
    ['an expiry beyond 31 days', { expireAt: Timestamp.fromMillis(Date.now() + 32 * DAY) }],
    ['an expiry that is not a timestamp', { expireAt: Date.now() + DAY }],
    ['a payload over 900 KiB', { body: Bytes.fromUint8Array(new Uint8Array(950 * 1024)) }],
  ])('refuses %s', async (_label, change) => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const { id = SEAL, ...fields } = change as Record<string, unknown> & { id?: string };
    const data = versionDoc(fields);
    for (const [key, value] of Object.entries(data)) if (value === undefined) delete data[key as keyof typeof data];
    await assertFails(putVersion(db, ALICE, 'n1', id, data));
  });

  it('accepts an expiry at the longest tier', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await assertSucceeds(
      putVersion(db, ALICE, 'n1', SEAL, versionDoc({ expireAt: Timestamp.fromMillis(Date.now() + 30 * DAY) })),
    );
  });
});

describe('pushVersionBatch', () => {
  it('writes a page, one commit per version', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const result = await pushVersionBatch(db, ALICE, [remote('n1', hex(1)), remote('n2', hex(2))]);
    expect(result.refused).toEqual([]);
    expect((await getDoc(version(db, ALICE, 'n2', hex(2)))).exists()).toBe(true);
  });

  it('treats a version that is already stored as written', async () => {
    // Another device uploaded the same sealing, or a retry lost its ack.
    const db = signedIn(ALICE, ALICE_EMAIL);
    await pushVersionBatch(db, ALICE, [remote('n1', hex(1))]);
    const result = await pushVersionBatch(db, ALICE, [remote('n1', hex(1)), remote('n1', hex(3))]);
    expect(result.refused).toEqual([]);
    expect((await getDoc(version(db, ALICE, 'n1', hex(3)))).exists()).toBe(true);
  });

  it('returns only the version the rules refused, and writes the rest', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const bad = remote('n1', hex(9), { expireAt: Date.now() + 90 * DAY });
    const result = await pushVersionBatch(db, ALICE, [remote('n1', hex(1)), bad, remote('n1', hex(2))]);
    expect(result.refused.map((v) => v.id)).toEqual([hex(9)]);
    expect((await getDoc(version(db, ALICE, 'n1', hex(2)))).exists()).toBe(true);
  });

  it('meters a full page exactly: every version counted, each one a push', async () => {
    // A page the engine really sends (`VERSION_PAGE`), from an invited
    // account, which costs the most rule lookups per commit.
    const db = signedIn(ALICE, ALICE_EMAIL);
    const page = Array.from({ length: 20 }, (_, i) =>
      remote(`n${i % 7}`, hex(i + 1), i === 3 ? { body: new Uint8Array(3000) as RemoteVersion['body'] } : {}),
    );
    const result = await pushVersionBatch(db, ALICE, page);
    expect(result.refused).toEqual([]);
    let meter: Record<string, unknown> = {};
    await env.withSecurityRulesDisabled(async (ctx) => {
      meter = (await getDoc(doc(fs(ctx), `users/${ALICE}/usage/current`))).data() ?? {};
    });
    // 19 small versions at the 1 KiB minimum, and one of 3,004 bytes.
    expect((meter.hist as Record<string, number>)[month()]).toBe(19 * 1024 + 3004);
    expect(meter.pn).toBe(20);
  });

  it('holds the page when the push window is full, and resets one that is over', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    const ws = Timestamp.fromMillis(Date.now() - 60 * 60_000);
    await setMeter(ALICE, { bytes: 0, ws, pn: 20_000, lastDoc: 'notes/x' });
    const error = await pushVersionBatch(db, ALICE, [remote('n1', hex(1))]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushLimitError);
    expect((error as PushLimitError).retryAt).toBe(ws.toMillis() + DAY);
    expect((await getDoc(version(db, ALICE, 'n1', hex(1)))).exists()).toBe(false);

    await setMeter(ALICE, { bytes: 0, ws: Timestamp.fromMillis(Date.now() - 25 * 60 * 60_000), pn: 20_000, lastDoc: 'notes/x' });
    const result = await pushVersionBatch(db, ALICE, [remote('n1', hex(1)), remote('n1', hex(2))]);
    expect(result.refused).toEqual([]);
    expect((await getDoc(version(db, ALICE, 'n1', hex(2)))).exists()).toBe(true);
  });

  it('keeps a page on the device once the month\'s history is spent', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await setMeter(ALICE, { bytes: 0, hist: { [month()]: 500_000_000 - 1 } });
    const page = [remote('n1', hex(1)), remote('n1', hex(2))];
    const result = await pushVersionBatch(db, ALICE, page);
    expect(result.refused.map((v) => v.id)).toEqual([hex(1), hex(2)]);
    expect((await getDoc(version(db, ALICE, 'n1', hex(1)))).exists()).toBe(false);
  });

  it('reports a refused account, not a refused version', async () => {
    await invite(ALICE_EMAIL, false);
    const db = signedIn(ALICE, ALICE_EMAIL);
    await expect(pushVersionBatch(db, ALICE, [remote('n1', hex(1))])).rejects.toBeInstanceOf(VersionAccessDenied);
  });
});

describe('listVersionPage', () => {
  it('pages newest first without skipping versions that share a createdAt', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    // As an old batched upload left them, or a burst within one millisecond:
    // five versions with the same `createdAt`.
    const at = Timestamp.fromMillis(Date.now() - 60_000);
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await setDoc(version(fs(ctx), ALICE, 'n1', hex(i + 1)), versionDoc({ createdAt: at }));
      }
    });
    await pushVersionBatch(db, ALICE, [remote('n1', hex(10))]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await listVersionPage(db, ALICE, 'n1', 2, cursor);
      seen.push(...result.versions.map((v) => v.id));
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    expect(seen[0]).toBe(hex(10));
    expect(new Set(seen).size).toBe(6);
  });

  it('round-trips the ciphertext and fields, and hides an expired version', async () => {
    const db = signedIn(ALICE, ALICE_EMAIL);
    await pushVersionBatch(db, ALICE, [remote('n1', hex(1), { reason: 'delete' })]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(version(fs(ctx), ALICE, 'n1', hex(2)), versionDoc({ expireAt: Timestamp.fromMillis(Date.now() - 1) }));
    });

    const { versions } = await listVersionPage(db, ALICE, 'n1', 10);
    expect(versions).toHaveLength(1);
    const [only] = versions;
    expect(only).toMatchObject({ noteId: 'n1', id: hex(1), reason: 'delete', at: 1_700_000_000_000 });
    expect([...only!.body]).toEqual([1, 1, 4, 4]);
    expect(only!.createdAt).toBeGreaterThan(0);
  });
});
