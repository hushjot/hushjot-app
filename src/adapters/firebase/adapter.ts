/**
 * The Firebase implementation of `SyncAdapter`.
 *
 * This is the only file in the app that knows Firebase exists. It is reached
 * through a dynamic import, so the SDK is not on the critical path — §7 is
 * explicit that Firebase must not be initialised before useful UI can render.
 *
 * Three decisions worth stating, all from the plan:
 *
 * - **Ciphertext is stored as `Bytes`, never base64** (issue #4). Base64 costs
 *   a third of Firestore's 1 MiB document budget for nothing, and the rules
 *   reject strings so a regression here fails loudly rather than quietly
 *   halving the maximum note size.
 * - **Firestore's own offline persistence stays off** (issue #7). We already
 *   own an IndexedDB layer; enabling Firestore's would create a second source
 *   of truth with its own conflict semantics.
 * - **Delta queries, not a collection listener** (issue #8). `onSnapshot` over
 *   a whole collection bills a read per document on every cold start, which at
 *   the spec's own 10,000-note target is 10,000 reads to learn nothing changed.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut as fbSignOut,
  onAuthStateChanged,
  browserLocalPersistence,
  inMemoryPersistence,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  memoryLocalCache,
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  orderBy,
  limit as fsLimit,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  Bytes,
  type Firestore,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
  PayloadTooLargeError,
  RevisionConflictError,
  SessionExpiredError,
  SyncNotApprovedError,
  TransientSyncError,
  type ApprovalState,
  type AuthUser,
  type Entitlement,
  type PullResult,
  type SyncAdapter,
} from '../../core/sync/adapter.ts';
import { firebaseSettings } from './config.ts';
import { resetVault } from './vaultReset.ts';
import { pullPage, readNote } from './pull.ts';
import { listVersionPage, pushVersionBatch, VersionAccessDenied } from './versions.ts';
import { publishShare, revokeShare, listShares } from './shares.ts';
import { install as installOpCount, count, countListenChanges } from './opCount.ts';
import { countMeter, meterInto, readUsage, readUsageQuietly, windowRetryAt } from './usage.ts';
import {
  PushLimitError,
  QuotaExceededError,
  SHARES_PER_MONTH,
  ShareLimitError,
  meterDelta,
  pushWindowFull,
} from '../../core/sync/usage.ts';
import { LOCKDOWN_SENTINEL, type PauseVerdict } from '../../core/sync/pause.ts';

/** Firestore's hard limit is 1 MiB; the rules cap payloads at 900 KiB. */
const MAX_PAYLOAD_BYTES = 900 * 1024;
const SCHEMA_VERSION = 1;

let app: FirebaseApp | undefined;
let auth: Auth | undefined;

function ensureApp(): FirebaseApp {
  if (app) return app;
  app = initializeApp({
    apiKey: firebaseSettings.apiKey,
    authDomain: firebaseSettings.authDomain,
    projectId: firebaseSettings.projectId,
    appId: firebaseSettings.appId,
  });
  return app;
}

/**
 * `initializeAuth`, never `getAuth`.
 *
 * `getAuth` bundles in the popup/redirect resolver, which Firebase initialises
 * *proactively* on Safari and iOS by loading `https://apis.google.com/js/api.js`
 * — a third-party script our CSP rightly refuses, fetched on every page load,
 * for a feature we do not have. The only sign-in method here is email and
 * password. Omitting the resolver means the request is never made, and not
 * importing `getAuth` at all keeps the gapi loader out of the bundle entirely.
 *
 * Persistence is declared here rather than through a later `setPersistence`
 * call: the list degrades in order, so a browser blocking local storage falls
 * back to in-memory instead of failing. The encryption passphrase is a separate
 * secret and is not persisted by any of this.
 *
 * `initializeAuth` throws if called twice for one app, hence the memo.
 */
function ensureAuth(application: FirebaseApp): Auth {
  if (auth) return auth;
  auth = initializeAuth(application, {
    persistence: [browserLocalPersistence, inMemoryPersistence],
  });
  return auth;
}

/**
 * The shape the billing API writes to `entitlements/{uid}`.
 * Anything malformed reads as "no plan" rather than throwing: the rules hold
 * the real verdict, and a label must not take a session down.
 */
function toEntitlement(data: DocumentData | undefined): Entitlement | null {
  if (!data) return null;
  const plan = data.plan === 'yearly' ? 'yearly' : 'monthly';
  if (typeof data.active !== 'boolean' || typeof data.until !== 'number') return null;
  return {
    active: data.active,
    plan,
    until: data.until,
    ...(typeof data.periodEnd === 'number' ? { periodEnd: data.periodEnd } : {}),
  };
}

/** Counted bytes of a stored document's ciphertext fields (`core/sync/usage.ts`). */
function storedSize(data: DocumentData | undefined, fields: readonly string[]): number {
  let total = 0;
  for (const field of fields) {
    const value = data?.[field];
    if (value instanceof Bytes) total += value.toUint8Array().length;
  }
  return total;
}

function toAuthUser(user: User | null): AuthUser | null {
  return user ? { uid: user.uid, email: user.email, emailVerified: user.emailVerified } : null;
}

/** Firestore surfaces "you are offline" and "permission denied" the same way. */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  return (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'resource-exhausted' ||
    code === 'internal' ||
    code === 'cancelled'
  );
}

function isPermissionDenied(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'permission-denied';
}

/**
 * Classify a failed *read*.
 *
 * Reads are the unambiguous case. The read rules carry no shape check and no
 * compare-and-swap, and the path is always this user's own uid, so the only
 * way a read is refused is that the account is not authorised at all — the
 * allowlist. Writes need more care; see `pushNote`.
 */
function rethrowReadError(error: unknown): never {
  if (isSessionExpired(error)) throw new SessionExpiredError();
  if (isPermissionDenied(error)) throw new SyncNotApprovedError();
  if (isTransient(error)) throw new TransientSyncError('backend unavailable');
  throw error;
}

/**
 * The session is gone rather than merely unhappy: the token could not be
 * refreshed, or the credential was revoked. Retrying cannot fix it.
 */
function isSessionExpired(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  return (
    code === 'unauthenticated' ||
    code.includes('user-token-expired') ||
    code.includes('user-disabled') ||
    code.includes('user-not-found') ||
    code.includes('invalid-user-token')
  );
}

export async function createFirebaseAdapter(): Promise<SyncAdapter> {
  const application = ensureApp();

  const auth = ensureAuth(application);

  // `initializeFirestore` throws if an instance already exists for this app.
  // The caller memoises, so this should not happen — but a second adapter
  // failing to build is a worse outcome than reusing the existing instance.
  let db: Firestore;
  let firstInit = true;
  try {
    db = initializeFirestore(application, {
      // Memory-only: our IndexedDB repository is the local source of truth.
      localCache: memoryLocalCache(),
    });
  } catch {
    db = getFirestore(application);
    firstInit = false;
  }

  if (firebaseSettings.useEmulators && firstInit) {
    const { emulatorHost, authEmulatorPort, firestoreEmulatorPort } = firebaseSettings;
    connectAuthEmulator(auth, `http://${emulatorHost}:${authEmulatorPort}`, {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, emulatorHost, firestoreEmulatorPort);
    // The benchmarks price a session from this; see `./opCount.ts`.
    installOpCount();
  }

  let current: AuthUser | null = toAuthUser(auth.currentUser);
  const listeners = new Set<(user: AuthUser | null) => void>();

  /**
   * `auth.currentUser` is null until the persisted session is read back out of
   * storage, and so is the first `onAuthChange` callback — which makes "no
   * account" and "not asked yet" the same value. `authStateReady()` is the
   * platform's own answer to that, and the first `onAuthStateChanged` firing is
   * the fallback for anything that lacks it.
   */
  let markAuthReady = (): void => {};
  const authReady = new Promise<void>((resolve) => {
    markAuthReady = resolve;
  });
  if (typeof auth.authStateReady === 'function') {
    void auth.authStateReady().then(markAuthReady, markAuthReady);
  }

  onAuthStateChanged(auth, (user) => {
    current = toAuthUser(user);
    markAuthReady();
    for (const listener of listeners) listener(current);
  });

  /** One read of `entitlements/{uid}`, the account's own and nothing else. */
  const readEntitlement = async (uid: string): Promise<Entitlement | null> => {
    const snapshot = await getDoc(doc(db, `entitlements/${uid}`));
    count('entitlement', 1, 0, false);
    return snapshot.exists() ? toEntitlement(snapshot.data()) : null;
  };

  const requireUid = (): string => {
    if (!current) throw new TransientSyncError('not signed in');
    return current.uid;
  };

  const notesCol = () => collection(db, `users/${requireUid()}/notes`);
  const foldersCol = () => collection(db, `users/${requireUid()}/folders`);

  /**
   * A metered write was refused, and its own document is where the write
   * expected it — so the refusal was the meter's. Three things can make it so,
   * and one read of the meter tells them apart:
   *
   * - the size this device was told the backend holds was wrong (another
   *   device changed a folder, or an anchor is stale): retry with `actual`;
   * - the push window is full: retry once as a reset, which the rules take
   *   only if the window is a day old by the server's clock;
   * - the account is out of space, or the reset was refused: say which.
   *
   * Resolves true when a retry landed, false when nothing here explains the
   * refusal and the caller's own answer stands.
   */
  const settleRefusal = async (
    uid: string,
    id: string,
    size: number,
    actual: number,
    sent: number,
    retry: (stored: number, reset: boolean) => Promise<void>,
  ): Promise<boolean> => {
    const usage = await readUsageQuietly(db, uid);
    const full = usage !== null && pushWindowFull(usage);
    if (actual !== sent || full) {
      try {
        await retry(actual, full);
        return true;
      } catch (error) {
        if (!isPermissionDenied(error)) throw error;
      }
    }
    if (usage) {
      const delta = meterDelta(size, actual);
      if (delta > 0 && usage.bytes + delta > usage.quota) {
        throw new QuotaExceededError(id, delta, usage.bytes, usage.quota);
      }
      if (full) throw new PushLimitError(windowRetryAt(usage));
    }
    return false;
  };

  const adapter: SyncAdapter = {
    get user() {
      return current;
    },

    authReady,

    onAuthChange(listener) {
      listeners.add(listener);
      // Fire immediately so a late subscriber is not left waiting for a change
      // that already happened.
      listener(current);
      return () => listeners.delete(listener);
    },

    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      current = toAuthUser(credential.user);
      return current!;
    },

    async sendVerification() {
      const user = auth.currentUser;
      if (user) await sendEmailVerification(user);
    },

    async resetPassword(email) {
      // With email enumeration protection on, Firebase answers a miss and a
      // hit identically; the caller's copy is neutral either way.
      await sendPasswordResetEmail(auth, email);
    },

    async signOut() {
      await fbSignOut(auth);
      current = null;
    },

    /**
     * Read this account's own plan, then its own allowlist entry — the same
     * order and the same two documents `approved()` in the rules consults, so
     * a paying user costs one read here as there.
     *
     * The rules permit exactly these documents and refuse a list query, so
     * nothing here can enumerate anyone else. The email comes from the live
     * credential rather than from the caller: the sign-in form's casing need
     * not match the stored account's, and a mismatch would read a path that
     * does not exist and report a false denial.
     */
    async checkApproval(): Promise<ApprovalState> {
      const user = auth.currentUser;
      if (!user) return 'unknown';
      try {
        const plan = await readEntitlement(user.uid);
        if (plan && plan.active && plan.until > Date.now()) return 'approved';
        const email = user.email;
        if (!email) return plan ? 'denied' : 'unknown';
        const snapshot = await getDoc(doc(db, `allowlist/${email.toLowerCase()}`));
        count('allowlist', 1, 0, false);
        return snapshot.exists() && snapshot.data().active === true ? 'approved' : 'denied';
      } catch {
        // Offline, or the backend is unhappy. Firestore's own cache is off, so
        // this is the common case on a cold start with no network. Anything
        // other than an authoritative answer must not cost the user their
        // session — the rules decide for real on the next write.
        return 'unknown';
      }
    },

    /**
     * One `get` of the lockdown sentinel. The lockdown ruleset allows it and
     * the normal rules refuse it, so the answer is in whether it was allowed,
     * never in what it returned (the document does not exist). See
     * `core/sync/pause.ts`. Counted without a rules read: the sentinel's rule
     * consults nothing.
     */
    async probePause(): Promise<PauseVerdict> {
      try {
        await getDoc(doc(db, LOCKDOWN_SENTINEL));
        count('lockdown', 1, 0, false);
        return 'paused';
      } catch (error) {
        if (isPermissionDenied(error)) return 'running';
        return 'unknown';
      }
    },

    async loadEntitlement() {
      const user = auth.currentUser;
      if (!user) return null;
      try {
        return await readEntitlement(user.uid);
      } catch {
        return null;
      }
    },

    async loadKeyRecord() {
      try {
        const snapshot = await getDoc(doc(db, `users/${requireUid()}/keys/primary`));
        count('keys', 1, 0);
        if (!snapshot.exists()) return null;
        return snapshot.data().record ?? null;
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async loadKeyDocument() {
      try {
        const snapshot = await getDoc(doc(db, `users/${requireUid()}/keys/primary`));
        count('keys', 1, 0);
        if (!snapshot.exists()) return { record: null, resetAt: null };
        const data = snapshot.data();
        return {
          record: data.record ?? null,
          resetAt: typeof data.resetAt === 'number' ? data.resetAt : null,
        };
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async resetVault(password) {
      await resetVault(auth, firebaseSettings.apiUrl, password);
    },

    async saveKeyRecord(record) {
      try {
        await setDoc(doc(db, `users/${requireUid()}/keys/primary`), {
          v: SCHEMA_VERSION,
          record,
          updatedAt: Date.now(),
        });
        count('keys', 0, 1);
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async pushNote(note, storedBytes) {
      const size = note.meta.length + (note.body?.length ?? 0);
      if (size > MAX_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(note.id, size);
      }

      const payload: Record<string, unknown> = {
        v: SCHEMA_VERSION,
        meta: Bytes.fromUint8Array(note.meta),
        revision: note.revision,
        updatedAt: note.updatedAt,
        // The server clock is the ordering authority: a device with a skewed
        // clock must not be able to hide its writes from another device's
        // cursor, and the rules reject any client-supplied value.
        syncedAt: serverTimestamp(),
        deleted: note.deleted,
      };
      if (note.body) payload.body = Bytes.fromUint8Array(note.body);

      const uid = requireUid();
      const ref = doc(notesCol(), note.id);
      // The note and the meter, one commit. See `./usage.ts`.
      const write = async (stored: number, reset = false) => {
        const batch = writeBatch(db);
        batch.set(ref, payload);
        meterInto(batch, db, uid, `notes/${note.id}`, { bytes: meterDelta(size, stored), reset });
        await batch.commit();
        count('push', 0, 1);
        countMeter();
      };

      try {
        await write(storedBytes);
      } catch (error) {
        if (isSessionExpired(error)) throw new SessionExpiredError();
        if (isPermissionDenied(error)) {
          // A denied write is ambiguous: it is either the compare-and-swap
          // firing — the conflict signal — or the account having lost access
          // entirely. Firestore reports both as `permission-denied`.
          //
          // Reading the same document tells them apart, because the read rules
          // carry no revision check. If the read succeeds the revision was the
          // problem; if it is refused too, authorisation was.
          //
          // Getting this wrong is not a cosmetic bug. The engine answers a
          // conflict by minting a local conflict copy and pushing it, so an
          // authorisation failure misread as a conflict duplicates the note on
          // every retry, forever.
          let stored: DocumentData | undefined;
          try {
            const snapshot = await getDoc(ref);
            count('probe', 1, 0);
            stored = snapshot.exists() ? snapshot.data() : undefined;
          } catch (probe) {
            if (isPermissionDenied(probe)) throw new SyncNotApprovedError();
            throw new TransientSyncError('backend unavailable');
          }

          // The document is where this push expected it, so the revision was
          // not the problem. The meter can be: a wrong stored size, a full push
          // window, or the allowance.
          if (!stored || stored.revision === note.revision - 1) {
            const actual = storedSize(stored, ['meta', 'body']);
            if (await settleRefusal(uid, note.id, size, actual, storedBytes, write)) return;
          }
          throw new RevisionConflictError(note.id, note.revision);
        }
        if (isTransient(error)) throw new TransientSyncError('backend unavailable');
        throw error;
      }
    },

    async pushFolder(folder, storedBytes) {
      const uid = requireUid();
      const ref = doc(foldersCol(), folder.id);
      const size = folder.data.length;
      const write = async (stored: number, reset = false) => {
        const batch = writeBatch(db);
        batch.set(ref, {
          v: SCHEMA_VERSION,
          data: Bytes.fromUint8Array(folder.data),
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
          syncedAt: serverTimestamp(),
          deleted: folder.deleted,
        });
        meterInto(batch, db, uid, `folders/${folder.id}`, { bytes: meterDelta(size, stored), reset });
        await batch.commit();
        count('push', 0, 1);
        countMeter();
      };

      try {
        await write(storedBytes);
      } catch (error) {
        if (isSessionExpired(error)) throw new SessionExpiredError();
        if (isPermissionDenied(error)) {
          // There is no compare-and-swap on a folder, so a denial is never a
          // conflict — but it is still ambiguous between "the rules refused
          // this payload" and "this account lost access". Reading the
          // collection back tells them apart, exactly as `pushNote` does,
          // because the read rules carry no shape check.
          //
          // The distinction is not cosmetic. `SyncNotApprovedError` latches
          // `sessionDead` in the engine, so reporting one malformed folder
          // write as a loss of access silently kills *all* sync for the
          // session behind a misleading "account not approved".
          let actual: number;
          try {
            const snapshot = await getDoc(ref);
            count('probe', 1, 0);
            actual = storedSize(snapshot.data(), ['data']);
          } catch (probe) {
            if (isPermissionDenied(probe)) throw new SyncNotApprovedError();
            throw new TransientSyncError('backend unavailable');
          }
          // Last write wins on a folder, so another device may have changed
          // its size since this one last saw it. The read says what it is now.
          if (await settleRefusal(uid, folder.id, size, actual, storedBytes, write)) return;
          throw new TransientSyncError('the backend refused this folder');
        }
        if (isTransient(error)) throw new TransientSyncError('backend unavailable');
        throw error;
      }
    },

    async loadUsage() {
      if (!auth.currentUser) return null;
      try {
        return await readUsage(db, requireUid());
      } catch {
        return null;
      }
    },

    async pull(cursor, limit): Promise<PullResult> {
      try {
        return await pullPage(notesCol(), foldersCol(), cursor, limit);
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async fetchNote(id) {
      try {
        const snapshot = await getDoc(doc(notesCol(), id));
        count('fetch', 1, 0);
        if (!snapshot.exists()) return null;
        return readNote(snapshot as QueryDocumentSnapshot<DocumentData>);
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async pushVersions(versions) {
      try {
        // Bounded by the caller, and a request is capped at 10 MiB; the
        // rules cap each version at 900 KiB.
        return await pushVersionBatch(db, requireUid(), versions);
      } catch (error) {
        if (error instanceof VersionAccessDenied) throw new SyncNotApprovedError();
        if (isSessionExpired(error)) throw new SessionExpiredError();
        if (isTransient(error)) throw new TransientSyncError('backend unavailable');
        throw error;
      }
    },

    async listVersions(noteId, limit, cursor) {
      try {
        return await listVersionPage(db, requireUid(), noteId, limit, cursor);
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async publishShare(share, index) {
      const uid = requireUid();
      try {
        await publishShare(db, uid, share, index);
      } catch (error) {
        // Two refusals that are not the allowlist: this month's links are
        // used up (`SHARES_PER_MONTH`), or today's pushes are. Saying "not
        // approved" there would send someone with a working plan off to buy
        // one. A full push window gets one reset attempt, as a note push does.
        if (isPermissionDenied(error)) {
          const usage = await readUsageQuietly(db, uid);
          if (usage && usage.sharesThisMonth >= SHARES_PER_MONTH) throw new ShareLimitError();
          if (usage && pushWindowFull(usage)) {
            try {
              await publishShare(db, uid, share, index, true);
              return;
            } catch (retry) {
              if (isPermissionDenied(retry)) throw new PushLimitError(windowRetryAt(usage));
              error = retry;
            }
          }
        }
        // A refused share write is unambiguous in a way a note write is not:
        // there is no compare-and-swap here, the shape is checked client-side
        // first, and the path is this user's own. So a refusal is the
        // allowlist, and `rethrowReadError`'s reasoning applies unchanged.
        rethrowReadError(error);
      }
    },

    async revokeShare(id) {
      try {
        await revokeShare(db, requireUid(), id);
      } catch (error) {
        rethrowReadError(error);
      }
    },

    async listShares() {
      try {
        return await listShares(db, requireUid());
      } catch (error) {
        rethrowReadError(error);
      }
    },

    subscribe(cursor, onChange) {
      if (!current) return () => {};
      void cursor;

      // Watch the *newest* document, descending. An earlier version ordered
      // ascending with limit(1), which watches the oldest change: adding a
      // newer document does not alter that result, so the listener fired once
      // and then never again — deletions and edits from another device only
      // appeared after a manual reload.
      //
      // Descending means any write anywhere in the collection changes the
      // single result and wakes us. One document read per change, rather than
      // a listener over the whole collection (issue #8).
      const watch = (collectionRef: ReturnType<typeof notesCol>) => {
        // Billed for the result set on attach, then per document that enters
        // or changes in it — see `./opCount.ts`.
        let attached = false;
        return onSnapshot(
          query(collectionRef, orderBy('syncedAt', 'desc'), fsLimit(1)),
          (snapshot) => {
            if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
              if (!attached) {
                attached = true;
                count('listen', Math.max(1, snapshot.size), 0);
              } else {
                countListenChanges(snapshot.docChanges().filter((c) => c.type !== 'removed').length);
              }
            }
            // Ignore the local echo of our own write.
            if (snapshot.metadata.hasPendingWrites) return;
            if (!snapshot.empty) onChange();
          },
          () => {
            // Listener errors are transient by nature; the checkpoint timer and
            // the online handler will retry.
          },
        );
      };

      // Folders get their own doorbell. Watching notes alone meant a folder
      // created or renamed on another device stayed invisible until the 10 s
      // checkpoint happened to come round.
      const unsubscribers = [watch(notesCol()), watch(foldersCol())];
      return () => {
        for (const stop of unsubscribers) stop();
      };
    },

    dispose() {
      listeners.clear();
    },
  };

  return adapter;
}
