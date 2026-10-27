/**
 * The synchronisation backend interface.
 *
 * §5 asks that Firebase be replaceable by a generic sync API without rewriting
 * the editor or the local persistence layers, and §33.13 that it stay behind an
 * adapter. This file is that boundary: it mentions no Firebase type, and the
 * UI never imports anything below it.
 *
 * Everything crossing this interface is **ciphertext**. The adapter cannot read
 * what it transports, which is what makes "the server operator cannot read your
 * notes" true of the transport as well as the store.
 */
import type { Bytes } from '../crypto/bytes.ts';
import type { Usage } from './usage.ts';
import type { PauseVerdict } from './pause.ts';

/** A note as it exists remotely: opaque payloads plus reconciliation fields. */
export interface RemoteNote {
  id: string;
  /** Sealed `{ title, folderId, pinnedAt }`. */
  meta: Bytes;
  /** Sealed content. Absent on a tombstone. */
  body?: Bytes;
  revision: number;
  /** Client clock, for display only — never trusted for ordering. */
  updatedAt: number;
  deleted: boolean;
}

export interface RemoteFolder {
  id: string;
  /** Sealed `{ name, parentId }`. */
  data: Bytes;
  createdAt: number;
  /**
   * Client clock, and the only ordering a folder has.
   *
   * Folders carry no revision: there is no compare-and-swap on them and no
   * conflict copy, because a folder is a name and a parent rather than user
   * text, and §16's "preserve both versions" is about text. That leaves
   * last-write-wins, and this is what it compares.
   */
  updatedAt: number;
  deleted: boolean;
}

/**
 * An opaque position in the backend's change stream. For Firestore this is a
 * server timestamp; another backend might use a sequence number. Callers
 * persist it and hand it back, and must not interpret it.
 */
export type SyncCursor = string | null;

/**
 * One earlier version of a note, as the backend stores it.
 *
 * Immutable once written: the backend refuses updates and deletes, and removes
 * it itself when `expireAt` passes. `meta` and `body` are the note's ciphertext
 * exactly as it was stored when the version was taken — never re-sealed.
 */
export interface RemoteVersion {
  noteId: string;
  /** The body envelope's nonce as 24 hex characters; unique per sealing. */
  id: string;
  meta: Bytes;
  body: Bytes;
  /** Client clock: when this text was current. Display only. */
  at: number;
  reason: 'edit' | 'delete' | 'restore';
  /**
   * When it expires. The backend removes it after this once its TTL policy is
   * enabled (Blaze only, parked until then); readers treat it as gone either way.
   */
  expireAt: number;
  /** Server clock, set on write. Absent on a version not yet written. */
  createdAt?: number;
}

export interface VersionPage {
  /** Newest first. */
  versions: RemoteVersion[];
  /** Pass back to fetch the next, older page. */
  cursor: SyncCursor;
  hasMore: boolean;
}

/**
 * A note published behind a link (`src/core/share/`).
 *
 * `payload` is sealed under a key that is **not** the vault's: a fresh random
 * one, minted per share, which lives only in the URL fragment the user copied.
 * So this is the one piece of ciphertext the backend holds that the account's
 * own key would not open — and the one an adapter must never be asked to
 * decrypt, because nothing on this side of the boundary has the key either.
 *
 * There is no owner field. The backend proves ownership from the matching
 * `ShareIndexEntry` under the user's own path instead, so that two links from
 * the same person are not correlatable by anyone holding them.
 */
export interface RemoteShare {
  /** 16 random bytes in base64url; 22 characters. */
  id: string;
  payload: Bytes;
  /** When it stops being readable. Bounded by the backend at 31 days. */
  expireAt: number;
  /** Server clock, set on write. Absent on a share not yet written. */
  createdAt?: number;
}

/**
 * The owner's record of a link they published: which note, and until when.
 *
 * It carries the link's key **sealed under the vault**, which is what lets the
 * owner copy a link again, or re-publish an edited note to the same URL, from
 * any of their devices. The backend can no more read it than it can read a
 * note; the public document, which recipients can read, never holds it.
 *
 * Read on demand, never pulled and never part of the delta cursor.
 */
export interface ShareIndexEntry {
  id: string;
  noteId: string;
  /** The share key, sealed under the DEK. Not the key itself. */
  key: Bytes;
  expireAt: number;
  createdAt: number;
}

export interface PullResult {
  notes: RemoteNote[];
  folders: RemoteFolder[];
  cursor: SyncCursor;
  /** True when more changes remain beyond this page. */
  hasMore: boolean;
}

/**
 * Raised when the backend rejects a write because the revision was stale —
 * another device got there first. The caller resolves it by preserving both
 * versions (§16); it is never retried blindly.
 */
export class RevisionConflictError extends Error {
  constructor(
    readonly noteId: string,
    readonly attemptedRevision: number,
  ) {
    super(`revision ${attemptedRevision} for note ${noteId} is out of date`);
    this.name = 'RevisionConflictError';
  }
}

/** Raised for anything transient: offline, timeout, backend unavailable. */
export class TransientSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSyncError';
  }
}

/**
 * Raised when the backend no longer accepts this session: the token expired
 * and could not be refreshed, the password changed elsewhere, or the account
 * was disabled.
 *
 * Distinct from a transient failure because retrying will not help — the user
 * has to sign in again. Editing continues regardless; only sync stops.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('the sync session is no longer valid');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Raised when the backend accepts the session but refuses the account access to
 * any data: no active plan and no invitation, or whichever it had has lapsed.
 *
 * Distinct from `SessionExpiredError` because signing in again changes nothing
 * — the credential is fine, the authorisation is not. Distinct from
 * `RevisionConflictError` because there is no conflict to resolve, and treating
 * it as one would spawn a conflict copy per attempt forever. Editing continues;
 * only sync stops.
 */
export class SyncNotApprovedError extends Error {
  constructor() {
    super('this account is not approved for syncing');
    this.name = 'SyncNotApprovedError';
  }
}

/**
 * What `SyncAdapter.loadKeyDocument` found. `record` is null for no key
 * document *and* for a tombstone; `resetAt` is what tells the two apart.
 */
export interface KeyDocument {
  record: unknown | null;
  /** Set only on a tombstone left by a vault reset, in ms since the epoch. */
  resetAt: number | null;
}

/**
 * Why a vault reset did not happen. In every case nothing was deleted on
 * this device; on the backend, `failed` and `unreachable` may have got part
 * way, and asking again finishes the job — every step is idempotent.
 */
export type VaultResetFailure =
  /** The account password was wrong. */
  | 'wrong-password'
  /** Too many attempts; the identity provider is refusing for a while. */
  | 'rate-limited'
  /** The sign-in was not fresh enough for the backend. Retrying re-authenticates. */
  | 'reauth-required'
  /** Nobody is signed in, or the session is gone. */
  | 'signed-out'
  /** Offline, or the backend did not answer. */
  | 'unreachable'
  /** The backend answered with a refusal or an error. */
  | 'failed';

export class VaultResetError extends Error {
  constructor(readonly reason: VaultResetFailure) {
    super(`vault reset failed: ${reason}`);
    this.name = 'VaultResetError';
  }
}

/** Raised when the payload is too large for the backend to store. */
export class PayloadTooLargeError extends Error {
  constructor(
    readonly noteId: string,
    readonly bytes: number,
  ) {
    super(`note ${noteId} is ${bytes} bytes, which exceeds the backend limit`);
    this.name = 'PayloadTooLargeError';
  }
}

export interface AuthUser {
  uid: string;
  email: string | null;
  /** Whether the address has been confirmed. Absent where the backend has no notion of it. */
  emailVerified?: boolean;
}

/** See `SyncAdapter.checkApproval`. */
export type ApprovalState = 'approved' | 'denied' | 'unknown';

/**
 * A paid plan, as the billing API wrote it. `until` is epoch milliseconds —
 * the period end plus grace — and is what the backend compares against its
 * clock, so a lapsed plan switches itself off without any write.
 *
 * `periodEnd` is the same date without the grace, and is the one to show:
 * grace is up to two weeks, and "renews on" a date two weeks after the card
 * is charged is wrong. Absent on a plan that is paused or canceled, and on a
 * document written before the field existed.
 */
export interface Entitlement {
  active: boolean;
  plan: 'monthly' | 'yearly';
  until: number;
  periodEnd?: number;
}

export interface SyncAdapter {
  /** The signed-in user, or null. */
  readonly user: AuthUser | null;

  onAuthChange(listener: (user: AuthUser | null) => void): () => void;

  /**
   * Resolves once the initial auth state is known.
   *
   * `user` and `onAuthChange` both report null before the backend has restored
   * a persisted session, and that null is indistinguishable from "nobody is
   * signed in". Anything that would act differently for a signed-in user has
   * to await this first — see `core/notes/firstRun.ts` for what acting on the
   * early null cost.
   */
  readonly authReady: Promise<void>;

  signIn(email: string, password: string): Promise<AuthUser>;
  /** Ask the backend to mail a verification link to the signed-in address. Best effort. */
  sendVerification(): Promise<void>;
  /**
   * Ask the backend to mail a password-reset link. Resolves the same way
   * whether or not the address has an account, so a caller cannot use it to
   * enumerate addresses; the backend enforces that too.
   */
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;

  /**
   * Whether the signed-in account is authorised to sync — a plan or an
   * invitation, whichever the backend finds first.
   *
   * Tri-state on purpose. The backend is the authority and enforces this
   * regardless, so this exists only to produce a good error message — which
   * means a network failure must report `unknown`, never `denied`. Signing
   * someone out because their laptop was offline would be a bug, not caution.
   */
  checkApproval(): Promise<ApprovalState>;

  /**
   * After a refusal: is the backend in a cost lockdown rather than refusing
   * this account? One read of `LOCKDOWN_SENTINEL` (`./pause.ts` has the
   * design). `paused` when it was allowed, `running` when it was refused — the
   * normal rules are live, so the refusal meant what it said — and `unknown`
   * on any other failure, which must decide nothing. Never throws.
   *
   * Optional so an adapter without the notion behaves exactly as before: a
   * refusal is a refusal.
   */
  probePause?(): Promise<PauseVerdict>;

  /**
   * The signed-in account's plan, for the account panel. Null when there is
   * none, and null on any failure: it is a label, and the rules decide for real.
   */
  loadEntitlement(): Promise<Entitlement | null>;

  /**
   * The wrapped key record, so a second device can unlock with the passphrase.
   * Ciphertext, salts and KDF parameters only — nothing that opens it.
   */
  loadKeyRecord(): Promise<unknown | null>;
  saveKeyRecord(record: unknown): Promise<void>;

  /**
   * The key document in full: the record, and the stamp a vault reset leaves
   * in its place. `loadKeyRecord` reads a tombstone as "no record", which is
   * what adoption and creation want; a device bound to the old vault needs to
   * tell it apart from a retention purge (`accountResetElsewhere`).
   */
  loadKeyDocument(): Promise<KeyDocument>;

  /**
   * Erase the account's synced data and leave a tombstone where its key record
   * was, so a new vault can be created. For a user who has lost both the
   * passphrase and the recovery code. Re-authenticates with `password` first —
   * the billing API refuses a sign-in older than a few minutes — and throws
   * `VaultResetError` on any failure.
   */
  resetVault(password: string): Promise<void>;

  /**
   * Push one note. Throws `RevisionConflictError` if the backend refuses.
   *
   * `storedBytes` is the raw size of the document this write replaces, as
   * far as the caller knows: `meta` plus `body` at the base revision, 0 when
   * there is none. The storage meter moves by `meterDelta(size, storedBytes)`,
   * in the same commit (`usage.ts`). A wrong figure is not fatal: the adapter
   * learns the real size from the refusal and tries once more. Throws
   * `QuotaExceededError` when the write would grow the account past its
   * allowance, and `PushLimitError` when the day's pushes are used up and the
   * server would not start a new window.
   */
  pushNote(note: RemoteNote, storedBytes: number): Promise<void>;
  /** Push one folder. `storedBytes` as for `pushNote`: the stored `data` size, or 0. */
  pushFolder(folder: RemoteFolder, storedBytes: number): Promise<void>;

  /** The account's storage meter, for the account panel. Null on any failure. */
  loadUsage(): Promise<Usage | null>;

  /** Everything changed since `cursor`, oldest first. */
  pull(cursor: SyncCursor, limit: number): Promise<PullResult>;

  /** Fetch one note's current remote state, for conflict resolution. */
  fetchNote(id: string): Promise<RemoteNote | null>;

  /**
   * Write note versions. A version whose id already exists is not an error —
   * another device or an earlier retry stored the same sealing — and counts as
   * written. Those the backend refuses for their shape, or that this month's
   * history budget cannot take, come back in `refused`; refusing the account
   * throws `SyncNotApprovedError` as any write does, and a full push window
   * throws `PushLimitError` with the rest of the page unsent.
   */
  pushVersions(versions: readonly RemoteVersion[]): Promise<{ refused: RemoteVersion[] }>;

  /** One page of a note's versions, newest first. Read on demand, never pulled. */
  listVersions(noteId: string, limit: number, cursor?: SyncCursor): Promise<VersionPage>;

  /**
   * Publish, or re-publish, a shared link.
   *
   * `index` is recorded for the owner's list only; the backend never relates
   * it to the published ciphertext. The owner's record, the public document
   * and the meter are one commit: the rules authorise the public write by the
   * record as the commit leaves it, and meter the publish as a push, so
   * nothing can leave a published note nobody is allowed to withdraw. Throws
   * `ShareLimitError` or `PushLimitError` when this month's links or today's
   * pushes are used up.
   */
  publishShare(share: RemoteShare, index: Omit<ShareIndexEntry, 'expireAt' | 'createdAt'>): Promise<void>;

  /**
   * Withdraw a link. The public document goes first: its delete rule needs the
   * owner's record, so deleting that first would strand the blob.
   */
  revokeShare(id: string): Promise<void>;

  /** Every link this account has published that has not expired. */
  listShares(): Promise<readonly ShareIndexEntry[]>;

  /** Live changes from other devices. Returns an unsubscribe function. */
  subscribe(cursor: SyncCursor, onChange: () => void): () => void;

  dispose(): void;
}
