/**
 * The cost kill switch's lockdown ruleset (`private/killswitch/lockdown.rules`).
 *
 * It refuses every client request — that is the whole point of releasing it —
 * with one exception: a `get` of the lockdown sentinel, which is how a refused
 * client tells "sync is paused for everyone" from "this account may not sync"
 * (`src/core/sync/pause.ts`). `firestore.rules.test.ts` checks the other half,
 * that the normal rules refuse the same `get`.
 *
 * The ruleset is not published, so this file skips itself in a public
 * checkout rather than failing.
 *
 * Same project id as the other rules suites, because `firebase.json` runs the
 * emulator in single-project mode; suites run one file at a time and each one
 * loads its own rules in `beforeAll`, so loading the lockdown here cannot leak
 * into them.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, type Firestore } from 'firebase/firestore';
import { LOCKDOWN_SENTINEL } from '../../src/core/sync/pause.ts';

const LOCKDOWN = resolve(process.cwd(), 'private/killswitch/lockdown.rules');

const fs = (context: { firestore: () => unknown }): Firestore => context.firestore() as Firestore;

const ALICE = 'alice-uid';
const ALICE_EMAIL = 'alice@example.com';

let env: RulesTestEnvironment;

describe.skipIf(!existsSync(LOCKDOWN))('the lockdown ruleset', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'teksto-rules-test',
      firestore: { rules: readFileSync(LOCKDOWN, 'utf8'), host: '127.0.0.1', port: 8085 },
    });
    await env.clearFirestore();
    // An account that the normal rules would let do everything below: a plan,
    // an invitation, a key record, a note and a live share.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = fs(ctx);
      await setDoc(doc(db, `allowlist/${ALICE_EMAIL}`), { active: true, note: 'fixture', addedAt: 1 });
      await setDoc(doc(db, `entitlements/${ALICE}`), {
        active: true,
        plan: 'monthly',
        until: Date.now() + 86_400_000,
      });
      await setDoc(doc(db, `users/${ALICE}/keys/primary`), { v: 1, record: { a: 1 }, updatedAt: 1 });
      await setDoc(doc(db, `users/${ALICE}/notes/n1`), { v: 1, revision: 1 });
      await setDoc(doc(db, 'shares/s1'), { v: 1, expireAt: new Date(Date.now() + 86_400_000) });
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  const alice = () => fs(env.authenticatedContext(ALICE, { email: ALICE_EMAIL, email_verified: true }));

  it('lets anyone get the sentinel, which does not exist', async () => {
    await assertSucceeds(getDoc(doc(fs(env.unauthenticatedContext()), LOCKDOWN_SENTINEL)));
    await assertSucceeds(getDoc(doc(alice(), LOCKDOWN_SENTINEL)));
  });

  it('allows nothing else at the sentinel', async () => {
    const db = alice();
    await assertFails(getDocs(collection(db, 'status')));
    await assertFails(getDoc(doc(db, 'status/other')));
    await assertFails(setDoc(doc(db, LOCKDOWN_SENTINEL), { a: 1 }));
    await assertFails(deleteDoc(doc(db, LOCKDOWN_SENTINEL)));
    await assertFails(setDoc(doc(db, `${LOCKDOWN_SENTINEL}/below/x`), { a: 1 }));
  });

  it('refuses every read an approved account could otherwise make', async () => {
    const db = alice();
    await assertFails(getDoc(doc(db, `entitlements/${ALICE}`)));
    await assertFails(getDoc(doc(db, `allowlist/${ALICE_EMAIL}`)));
    await assertFails(getDoc(doc(db, `users/${ALICE}/keys/primary`)));
    await assertFails(getDoc(doc(db, `users/${ALICE}/notes/n1`)));
    await assertFails(getDocs(collection(db, `users/${ALICE}/notes`)));
    await assertFails(getDoc(doc(db, `users/${ALICE}/usage/current`)));
  });

  it('refuses every write an approved account could otherwise make', async () => {
    const db = alice();
    await assertFails(setDoc(doc(db, `users/${ALICE}/notes/n2`), { v: 1, revision: 1 }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/keys/primary`), { v: 1, record: { b: 2 }, updatedAt: 2 }));
    await assertFails(deleteDoc(doc(db, `users/${ALICE}/notes/n1`)));
  });

  it('refuses a live share to a stranger', async () => {
    await assertFails(getDoc(doc(fs(env.unauthenticatedContext()), 'shares/s1')));
  });
});
