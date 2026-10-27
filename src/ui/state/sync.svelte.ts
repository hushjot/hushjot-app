/**
 * Reactive sync state.
 *
 * Owns the adapter and the engine, and is the only place the UI learns whether
 * anything is signed in or syncing. The Firebase adapter is behind a dynamic
 * import so the SDK never lands on the critical path (§7).
 *
 * Sync is entirely optional: the app is fully usable with no account, which is
 * how Phases 1–3 shipped and how it stays.
 */
import type { Bytes } from '../../core/crypto/bytes.ts';
import type { SyncAdapter, AuthUser, Entitlement, RemoteNote } from '../../core/sync/adapter.ts';
import { VaultResetError } from '../../core/sync/adapter.ts';
import {
  createSyncEngine,
  type SyncEngine,
  type SyncStatus,
  type ConflictReport,
} from '../../core/sync/engine.ts';
import type { NoteRepository } from '../../core/repo/noteRepository.ts';
import type { Usage } from '../../core/sync/usage.ts';
import type { TabChannel } from '../../core/sync/tabs.ts';
import type { HistoryOutbox } from '../../core/history/outbox.ts';
import { createPauseWatch, type PauseVerdict, type PauseWatch } from '../../core/sync/pause.ts';
import { firebaseConfigured } from '../../adapters/firebase/config.ts';

export type AuthError =
  | 'invalid-credentials'
  | 'no-plan'
  | 'too-many-requests'
  | 'network'
  | 'unknown';

/** Firebase error codes mapped to something worth showing a person. */
function toAuthError(error: unknown): AuthError {
  const code = (error as { code?: string } | null)?.code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'invalid-credentials';
  }
  if (code.includes('too-many-requests')) return 'too-many-requests';
  if (code.includes('network')) return 'network';
  return 'unknown';
}

/** Internal sentinel: the sign-in succeeded but the account has no plan or invitation. */
class NotApprovedError extends Error {}

export class SyncStore {
  #adapter: SyncAdapter | undefined;
  /**
   * The in-flight connection.
   *
   * `connect()` is called from app startup and again the moment a user signs
   * in. Without memoising the *promise*, two concurrent calls both saw
   * `#adapter` still unset and both built an adapter — and the second
   * `initializeFirestore` throws, which surfaced as an intermittent
   * "could not reach the sync service" on a perfectly good network.
   */
  #connecting: Promise<SyncAdapter | null> | undefined;
  #engine: SyncEngine | undefined;
  #unsubscribeAuth: (() => void) | undefined;
  /**
   * Kept so signing out can clear the sync state tied to the account.
   *
   * Set as soon as the repository exists, not when the engine starts. It used
   * to be assigned only inside `startEngine`, so `signOut()` silently cleared
   * nothing whenever sync had never come up this page-life — a locked vault, an
   * unapproved account, a reload — and the next account inherited the previous
   * one's cursor and queue.
   */
  #repo: NoteRepository | undefined;

  /** False when no backend is configured — the app runs local-only. */
  readonly available = firebaseConfigured;

  user = $state<AuthUser | null>(null);
  status = $state<SyncStatus>('idle');
  pending = $state(0);
  busy = $state(false);
  error = $state<AuthError | null>(null);
  /** Conflicts preserved rather than resolved, for the UI to surface. */
  conflicts = $state<ConflictReport[]>([]);
  /** True when the session lapsed and sync stopped. Editing is unaffected. */
  sessionExpired = $state(false);
  /**
   * True when the account is real but has no active plan or invitation.
   * Distinct from `sessionExpired` because signing in again cannot fix it —
   * a plan from hushjot.com/account can. The name predates plans; the engine
   * hook and six callers use it, and the meaning is unchanged: the backend
   * refused the account, whatever the reason.
   */
  notApproved = $state(false);
  /**
   * True when a session was ended because the account's plan had lapsed.
   *
   * `notApproved` cannot carry this: it describes a session that is still
   * there, and `signOut()` clears it. This one outlives the sign-out on
   * purpose, because the banner it drives is the only thing that tells the
   * user why they are no longer signed in. Cleared by the next successful
   * sign-in, or by dismissing the banner.
   */
  planLapsed = $state(false);
  /** The check in flight, so a restore and a refused write share one answer. */
  #enforcing: Promise<void> | undefined;
  /**
   * True while the backend is in a cost lockdown: every client is refused for
   * now, this account included, and none of it is the account's fault
   * (`core/sync/pause.ts`). Nothing is signed out, nothing reads as "no plan",
   * no vault may be created on a device that has none, and no first-run notes
   * are written. Set by the engine's `onPaused`, or by the unlock flow's
   * refused key-record read via `enterPause`; cleared by the pause watch when
   * the normal rules answer again, which is what restarts sync — the effects
   * in `App.svelte` that start the engine and adopt the vault read this flag.
   */
  paused = $state(false);
  #pauseWatch: PauseWatch | undefined;
  /**
   * The account's plan, for the account panel. Null while unknown, while
   * there is none, and while signed out. A label only — the rules decide.
   */
  plan = $state<Entitlement | null>(null);
  /**
   * The account's storage meter, for the account panel. Null while unknown or
   * signed out. Read when the panel opens, never on the sync path.
   */
  usage = $state<Usage | null>(null);
  /**
   * Changes waiting because the account's storage is full. They are queued and
   * editable like any other unsent change; freeing space sends them.
   */
  storageFull = $state(0);
  /**
   * Changes waiting because the account has used its daily pushes, and when
   * this device will try them again (ms, its own clock). Queued and editable;
   * they go once the server starts a new day.
   */
  pushLimited = $state(0);
  pushLimitRetryAt = $state<number | null>(null);
  /**
   * True once the backend has determined the initial auth state.
   *
   * Before that `user` is null because nothing has answered yet, not because
   * nobody is signed in — and reading it too early is how a returning user
   * looked like a brand-new one to first-run content. Driven by the adapter's
   * `authReady`, not by the first `onAuthChange`: that one fires synchronously
   * with whatever is known so far, which is exactly the null we must not
   * believe.
   */
  authSettled = $state(false);
  /**
   * True once this device has learned what the account holds. See
   * `core/notes/firstRun.ts` for why anything waits on it.
   */
  firstSyncDone = $state(false);
  /**
   * Whether this device's vault is demonstrably the account's: it published the
   * key record, or adopted the account's, or holds the very record the account
   * holds. Null until the answer lands — and null, not false, for every way of
   * failing to find out. False is reserved for two records that cannot be shown
   * to be one, because false stops the backfill for the life of the engine.
   *
   * The durable half of the answer is `app:vaultAccount`; see
   * `core/sync/backfill.ts` for why it has to be written down and what
   * comparing two key records can and cannot establish.
   */
  vaultOwnsAccount = $state<boolean | null>(null);
  /**
   * The account's key record is newer than this device's: somebody changed the
   * passphrase somewhere else.
   *
   * `Vault.adoptRecord` refuses to replace a record that already exists — the
   * guard that stops a hostile or stale server swapping a vault out from under
   * a device that has one — so this cannot be repaired silently in the
   * background. It raises a banner instead, and the banner's action is the one
   * place the refusal is lifted, on proof. False rather than null because the
   * absence of an answer and "nothing to say" are the same screen here.
   */
  keyRecordStale = $state(false);
  /** True when this device's notes belong to a different account (§backfill). */
  foreignOwner = $state(false);
  /**
   * The account was reset on another device — its owner lost both secrets and
   * started over — so this device's vault is no longer the account's and sync
   * does not start here. The durable half is `VAULT_RETIRED_KEY`; see
   * `accountResetElsewhere` in `core/sync/backfill.ts`.
   */
  vaultRetired = $state(false);

  get adapter(): SyncAdapter | undefined {
    return this.#adapter;
  }

  get signedIn(): boolean {
    return this.user !== null;
  }

  /** Load the Firebase SDK. Called after first paint, never before. */
  connect(): Promise<SyncAdapter | null> {
    if (!this.available) {
      // No backend to hear from, so waiting for one would wait forever.
      this.authSettled = true;
      return Promise.resolve(null);
    }
    if (this.#adapter) return Promise.resolve(this.#adapter);
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      try {
        const { createFirebaseAdapter } = await import('../../adapters/firebase/adapter.ts');
        const adapter = await createFirebaseAdapter();
        this.#adapter = adapter;
        this.#unsubscribeAuth = adapter.onAuthChange((user) => {
          this.user = user;
        });
        void adapter.authReady.then(() => {
          this.authSettled = true;
          // A session restored from storage has been through no gate at all:
          // `checkApproval` otherwise runs only behind the sign-in form.
          void this.#enforcePlan();
        });
        return adapter;
      } catch {
        // A missing or misconfigured backend must not break a local-only app.
        // Clear the memo so a later attempt can retry.
        this.#connecting = undefined;
        // Nothing is coming. Treat it as settled so the app stops waiting on
        // an answer it cannot get; a retry will correct it if one succeeds.
        this.authSettled = true;
        return null;
      }
    })();

    return this.#connecting;
  }

  /**
   * Begin syncing. Requires both an account (identity) and an unlocked vault
   * (the key) — one without the other cannot produce readable sync.
   */
  startEngine(
    repo: NoteRepository,
    hooks: {
      onRemoteChange: () => void;
      createConflictCopy: (noteId: string, remote?: RemoteNote) => Promise<string | null>;
      rebaseMeta: (noteId: string, local: Bytes, remote: Bytes) => Promise<Bytes | null>;
      beforeSync: () => Promise<void>;
      /** The workspace's tab channel; it outlives this engine. */
      channel?: TabChannel | undefined;
      /** Note history's upload queue, loaded on first use. */
      history?: () => Promise<HistoryOutbox | null>;
    },
  ): SyncEngine | undefined {
    if (!this.#adapter || this.#engine) return this.#engine;

    this.#repo = repo;
    this.#engine = createSyncEngine({
      adapter: this.#adapter,
      repo,
      onStatus: (status) => {
        this.status = status;
        this.pending = this.#engine?.pendingCount ?? 0;
      },
      onRemoteChange: hooks.onRemoteChange,
      beforeSync: hooks.beforeSync,
      onFirstSync: () => {
        this.firstSyncDone = true;
      },
      onPending: (count) => {
        this.pending = count;
      },
      onStorageFull: (waiting) => {
        this.storageFull = waiting;
        // The panel's meter is a label; refresh it if it is open and stale.
        if (this.usage) void this.refreshUsage();
      },
      onPushLimit: (waiting, retryAt) => {
        this.pushLimited = waiting;
        this.pushLimitRetryAt = retryAt;
      },
      // Stretches the listener backstop while nobody is looking at this tab.
      isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
      vaultOwnsAccount: () => this.vaultOwnsAccount,
      onForeignOwner: () => {
        this.foreignOwner = true;
      },
      onConflict: (report) => {
        this.conflicts = [...this.conflicts, report];
      },
      onSessionExpired: () => {
        this.#forgetAccountBinding();
        this.sessionExpired = true;
        this.user = null;
        // Same reasoning as `signOut`, and this path used to skip it entirely:
        // an expired session leaves the cursor, the anchors and the queue in
        // place, so signing in as somebody else resumed a change stream that
        // was not theirs and drained a queue of someone else's notes into
        // their account.
        void this.#clearSyncState();
        // The engine latches `sessionDead` and every later cycle returns
        // early. Leaving it in place meant `startEngine` handed the same dead
        // engine back on the next sign-in — sync was silently finished for the
        // rest of the page's life, with nothing in the UI to say so. Dropping
        // it forces a fresh one. Deferred so the engine can finish the cycle
        // it is reporting from before being torn down.
        queueMicrotask(() => this.stopEngine());
      },
      onPaused: () => {
        this.enterPause();
        // The engine has latched. A fresh one starts when the pause ends —
        // `App.svelte`'s sync effect reads `paused` — because that is what a
        // reload would do, and a lockdown may have interrupted the account
        // binding a fresh engine waits on.
        queueMicrotask(() => this.stopEngine());
      },
      onNotApproved: () => {
        this.notApproved = true;
        // Same latch, same fix: an account approved a minute later gets a
        // working engine on the next sign-in rather than waiting for a reload.
        queueMicrotask(() => this.stopEngine());
        // The backend refused a request, which is also how a plan running out
        // in the middle of a session is discovered. If the refusal is
        // confirmed the session ends; if nobody can say, the flag above
        // stands and the banner asks for nothing.
        void this.#enforcePlan();
      },
      createConflictCopy: hooks.createConflictCopy,
      rebaseMeta: hooks.rebaseMeta,
      channel: hooks.channel,
      ...(hooks.history ? { history: hooks.history } : {}),
    });

    void this.#engine.start();
    return this.#engine;
  }

  get engine(): SyncEngine | undefined {
    return this.#engine;
  }

  stopEngine(): void {
    this.#engine?.stop();
    this.#engine = undefined;
    this.status = 'idle';
    this.pending = 0;
    this.storageFull = 0;
    this.pushLimited = 0;
    this.pushLimitRetryAt = null;
  }

  /** Which tab owns the backend connection, for diagnostics. */
  get role(): string {
    return this.#engine?.role ?? 'follower';
  }

  async signIn(email: string, password: string): Promise<boolean> {
    return this.#signInWith((adapter) => adapter.signIn(email, password));
  }

  /**
   * Mail a password-reset link. Resolves true whether or not the address has
   * an account: the backend answers both the same way with enumeration
   * protection on, and the form's copy is neutral to match.
   */
  async resetPassword(email: string): Promise<boolean> {
    return this.#run(async (adapter) => {
      await adapter.resetPassword(email);
    });
  }

  /**
   * Erase the account's synced data so a new vault can be created; see
   * `src/adapters/firebase/vaultReset.ts`. Throws `VaultResetError`. Deletes
   * nothing on this device — the caller follows a success with the ordinary
   * "remove all data from this device" path.
   */
  async resetVault(password: string): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter || !adapter.user) throw new VaultResetError('signed-out');
    await adapter.resetVault(password);
  }

  /** Re-read the account's plan for the panel. Never throws. */
  async refreshPlan(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter || !adapter.user) {
      this.plan = null;
      return;
    }
    this.plan = await adapter.loadEntitlement();
  }

  /** Re-read the storage meter for the panel. Never throws. */
  async refreshUsage(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter || !adapter.user) {
      this.usage = null;
      return;
    }
    this.usage = await adapter.loadUsage();
  }

  async #signInWith(authenticate: (adapter: SyncAdapter) => Promise<AuthUser>): Promise<boolean> {
    let approved = true;
    const ok = await this.#run(async (adapter) => {
      await authenticate(adapter);

      // The rules are what actually stop an unapproved account; this only buys
      // a sentence the user can act on instead of sync failing mutely. So an
      // inconclusive answer — offline, backend unhappy — is treated as fine.
      if ((await adapter.checkApproval()) === 'denied') {
        approved = false;
        throw new NotApprovedError();
      }

      this.sessionExpired = false;
      this.notApproved = false;
      this.planLapsed = false;
      void this.refreshPlan();
    });

    if (!approved) await this.signOut();
    return ok;
  }

  /**
   * End a session whose account no longer has a plan or an invitation.
   *
   * The sign-in form has always refused such an account; this is the same
   * refusal for a session that was already open — restored from storage on a
   * later visit, or still running when the plan ran out. The rules had stopped
   * syncing it either way. What this adds is that the account is signed out
   * rather than left signed in and inert.
   *
   * Only an authoritative `denied` ends anything. `unknown` is what an offline
   * device gets, and signing someone out because their laptop had no network
   * would be a bug, not caution.
   *
   * `signOut()` and not the app's `signOutNow`: that one locks the vault, and
   * a lapsed plan must not put anyone out of their own notes. Nothing local
   * is touched — the notes stay, readable and editable, on this device.
   */
  #enforcePlan(): Promise<void> {
    if (this.#enforcing) return this.#enforcing;
    const check = (async () => {
      const adapter = this.#adapter;
      const uid = adapter?.user?.uid;
      // `busy` is a sign-in in flight, which runs this same check itself
      // and reports the refusal in the form rather than in a banner.
      if (!adapter || !uid || this.busy) return;
      if ((await adapter.checkApproval()) !== 'denied') return;
      // Somebody else may have signed in while that was in the air.
      if (adapter.user?.uid !== uid || this.busy) return;
      await this.signOut();
      this.planLapsed = true;
      this.error = 'no-plan';
    })();
    this.#enforcing = check;
    // Released from outside the function, not from a `finally` inside it: a
    // call that returns before its first `await` runs to the end before the
    // assignment above, and a `finally` in there would clear the slot first
    // and leave a settled promise in it for good — every later check skipped.
    const release = (): void => {
      if (this.#enforcing === check) this.#enforcing = undefined;
    };
    void check.then(release, release);
    return check;
  }

  /**
   * After a refusal: is it a cost lockdown? Never throws, and answers
   * `running` for a backend with no notion of one — so a refusal stays a
   * refusal there, as it always was.
   */
  async probePause(): Promise<PauseVerdict> {
    const adapter = this.#adapter;
    if (!adapter?.probePause) return 'running';
    return adapter.probePause();
  }

  /**
   * Mark sync paused and wait for it to end. The caller has just probed, so
   * the watch's first probe is a full interval away; `recheckPause` (a focus,
   * the tab coming back, the network returning) can bring it forward.
   */
  enterPause(): void {
    this.paused = true;
    if (this.#pauseWatch?.active) return;
    this.#pauseWatch = createPauseWatch({
      probe: () => this.probePause(),
      isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
      onResume: () => {
        this.#pauseWatch = undefined;
        this.paused = false;
      },
    });
    this.#pauseWatch.start();
  }

  /** The user is looking again: probe now, unless one went out a moment ago. */
  recheckPause(): void {
    void this.#pauseWatch?.recheck();
  }

  #endPause(): void {
    this.#pauseWatch?.stop();
    this.#pauseWatch = undefined;
    this.paused = false;
  }

  dismissPlanLapsed(): void {
    this.planLapsed = false;
  }

  async signOut(): Promise<void> {
    this.stopEngine();
    // Before the credential goes, not after: this is the last moment the
    // cursor, the revision anchors and the queued pushes are still known to
    // belong to *this* account. Leaving them for whoever signs in next pushed
    // one user's notes into another user's Firestore and resumed pulling from
    // a cursor belonging to a different change stream. Best-effort — a failure
    // here must not strand the user signed in.
    await this.#clearSyncState();
    this.#repo = undefined;
    await this.#adapter?.signOut();
    this.user = null;
    this.#forgetAccountBinding();
    this.sessionExpired = false;
    this.notApproved = false;
    this.#endPause();
    this.plan = null;
    this.usage = null;
  }

  /**
   * Forget everything this session believed about the account it was attached
   * to. Whatever the next account holds is unknown again, and so is whether
   * this device's vault will be theirs.
   *
   * Shared by `signOut` and `onSessionExpired` because the two have drifted
   * apart once already — the comment in `onSessionExpired` describes the bug
   * that caused. Expiry used to leave `vaultOwnsAccount` at its last value, so
   * the banner and the backfill gate carried a stale answer straight through
   * re-authentication.
   *
   * Note what is *not* here: `app:vaultAccount`. A vault does not stop being
   * the account's because a credential was dropped, which is why the marker
   * lives outside the `sync:` namespace that `clearSyncState()` wipes — the
   * same reasoning as `app:owner`.
   */
  #forgetAccountBinding(): void {
    this.firstSyncDone = false;
    this.vaultOwnsAccount = null;
    this.keyRecordStale = false;
    this.foreignOwner = false;
    this.vaultRetired = false;
    this.conflicts = [];
  }

  /**
   * Drop the bookkeeping that ties this device to one account. Best-effort by
   * design: a failure here must not strand the user signed in.
   */
  async #clearSyncState(): Promise<void> {
    try {
      await this.#repo?.clearSyncState();
    } catch {
      // Nothing useful to do; whatever prompted this still has to happen.
    }
  }

  /** Called once the repository exists, so sign-out can always clean up. */
  attachRepository(repo: NoteRepository): void {
    this.#repo = repo;
  }

  dismissConflicts(): void {
    this.conflicts = [];
  }

  async #run(action: (adapter: SyncAdapter) => Promise<void>): Promise<boolean> {
    this.busy = true;
    this.error = null;
    try {
      const adapter = await this.connect();
      if (!adapter) {
        this.error = 'network';
        return false;
      }
      await action(adapter);
      return true;
    } catch (err) {
      this.error = err instanceof NotApprovedError ? 'no-plan' : toAuthError(err);
      return false;
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.#endPause();
    this.stopEngine();
    this.#unsubscribeAuth?.();
    this.#adapter?.dispose();
    this.#adapter = undefined;
    this.#connecting = undefined;
  }
}

export const syncStore = new SyncStore();
