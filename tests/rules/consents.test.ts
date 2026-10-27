/**
 * Terms acceptance records against a real Firestore emulator.
 *
 * The record is only worth anything as evidence if the account holder cannot
 * rewrite it: no backdating (the server stamps the time), no edits, no
 * deletes. And it must be writable before a plan exists, because an account
 * agrees to the terms when it is created, not when it pays.
 */
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';

const fs = (context: { firestore: () => unknown }): Firestore => context.firestore() as Firestore;

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let env: RulesTestEnvironment;

// Deliberately not invited and with no entitlement: a brand-new account.
const signedIn = (uid: string) =>
  fs(env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: false }));

const consent = (db: Firestore, uid: string, version: string) => doc(db, `users/${uid}/consents/${version}`);

function consentDoc(overrides: Record<string, unknown> = {}) {
  return { terms: '1.0', privacy: '1.0', via: 'signup', acceptedAt: serverTimestamp(), ...overrides };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'teksto-consents-test',
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8') },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe('consent rules', () => {
  it('lets a new account without a plan record and read its own acceptance', async () => {
    const db = signedIn(ALICE);
    await assertSucceeds(setDoc(consent(db, ALICE, '1.0'), consentDoc()));
    await assertSucceeds(getDoc(consent(db, ALICE, '1.0')));
    await assertSucceeds(setDoc(consent(db, ALICE, '1.1'), consentDoc({ terms: '1.1', via: 'checkout' })));
  });

  it('refuses anyone else, and anyone signed out', async () => {
    await assertFails(setDoc(consent(signedIn(BOB), ALICE, '1.0'), consentDoc()));
    await setDoc(consent(signedIn(ALICE), ALICE, '1.0'), consentDoc());
    await assertFails(getDoc(consent(signedIn(BOB), ALICE, '1.0')));
    await assertFails(getDoc(consent(fs(env.unauthenticatedContext()), ALICE, '1.0')));
  });

  it('refuses a client clock, a mismatched version, and extra fields', async () => {
    const db = signedIn(ALICE);
    await assertFails(setDoc(consent(db, ALICE, '1.0'), consentDoc({ acceptedAt: Timestamp.fromMillis(0) })));
    await assertFails(setDoc(consent(db, ALICE, '1.0'), consentDoc({ terms: '1.1' })));
    await assertFails(setDoc(consent(db, ALICE, 'latest'), consentDoc({ terms: 'latest' })));
    // Unmetered and needing no plan, so the id is bounded: no free storage here.
    await assertFails(setDoc(consent(db, ALICE, '100.0'), consentDoc({ terms: '100.0' })));
    await assertFails(setDoc(consent(db, ALICE, '1.123'), consentDoc({ terms: '1.123' })));
    await assertSucceeds(setDoc(consent(db, ALICE, '12.34'), consentDoc({ terms: '12.34' })));
    await assertFails(setDoc(consent(db, ALICE, '1.0'), consentDoc({ via: 'console' })));
    await assertFails(setDoc(consent(db, ALICE, '1.0'), consentDoc({ ip: '1.2.3.4' })));
  });

  it('never lets a record change or be deleted, even by its owner', async () => {
    const db = signedIn(ALICE);
    await setDoc(consent(db, ALICE, '1.0'), consentDoc());
    await assertFails(setDoc(consent(db, ALICE, '1.0'), consentDoc()));
    await assertFails(updateDoc(consent(db, ALICE, '1.0'), { via: 'checkout' }));
    await assertFails(deleteDoc(consent(db, ALICE, '1.0')));
  });
});
