/**
 * The sync engine.
 *
 * Sits between the local repository and a `SyncAdapter`, and never holds the
 * encryption key: it moves stored ciphertext to the backend and stores returned
 * ciphertext back, so a note is never decrypted just to be uploaded.
 *
 * ## Shape of a sync
 *
 * ```
 * push   queued local changes ──► backend   (revision CAS may reject)
 * pull   changes since cursor ──► local     (higher revision wins)
 * ```
 *
 * ## Revisions, and the two counters that are not the same counter
 *
 * A note carries a *local* revision that advances on every keystroke, and the
 * backend carries its own, which advances by exactly one per accepted write
 * because that is what the rules enforce. They are different numbers and
 * conflating them is a bug with teeth: pushing a keystroke counter into a slot
 * the server only ever accepts one step of means every push that follows more
 * than one keypress is rejected — on a single device, with nobody else
 * involved. That rejection then reads as a conflict and forks the note, and
 * because nothing rebases, it forks again on the next push, and the next.
 *
 * So the push rebases. `repo.remoteRevision(id)` records where the backend is,
 * and a push sends that plus one whatever the local counter has reached. A
 * note with no record bootstraps with one read.
 *
 * ## Conflicts
 *
 * With the rebase in place, a rejection means what it says: another device
 * moved the note between our last sync and this push. §16 is unambiguous about
 * the response — never discard user text. The local version is preserved as a
 * separate conflict copy and the remote version keeps the original id, so both
 * survive and the user decides. Nothing is merged automatically.
 *
 * Two rejections are not two conflicts. A push that cannot succeed — a payload
 * the rules refuse, which Firestore reports with the same `permission-denied`
 * as a stale revision — would otherwise mint a copy per attempt forever. The
 * second consecutive conflict parks the note instead: the text stays queued and
 * editable, and the status line says something is wrong.
 *
 * A rejection is also not always about text. Pinning or moving a note pushes
 * the whole document, so a pin made here while another device edited the
 * same note loses the compare-and-swap too — and a copy of *this* device's
 * body, which the user never touched, would be a stale duplicate of the note
 * the other device just changed. The sync state therefore remembers the
 * nonce of the body at `base` (`state.ts`, `bodySeal`). When the stored body
 * still carries it, the change was metadata only: the remote version is
 * adopted, `rebaseMeta` lays the local pin and folder over it, and the note
 * stays queued to push the merge. Anything less than proof of an untouched
 * body gets a copy, exactly as before.
 *
 * ## Cadence
 *
 * Four timers, and the first thing to understand is that the idle debounce is
 * *not* the one that governs typing.
 *
 * - **Nudge (100 ms)** — for a structural change: a note created, deleted or
 *   moved, a folder added, renamed or deleted. Those are discrete one-off
 *   actions rather than keystroke bursts, and there is nothing to debounce.
 *   Deliberately not restarted while armed, so deleting a folder — which
 *   enqueues every note inside it — coalesces into one cycle rather than one
 *   per note.
 * - **Idle debounce (~800 ms after a change is queued)** — §8's common case,
 *   so a note reaches the cloud a moment after the user stops typing.
 * - **Ceiling (3 s)** — so continuous typing still checkpoints. Stretched
 *   for notes over 64 KiB, up to 30 s at the size limit (`ceilingFor`).
 * - **Listener backstop (60 s visible, 15 min hidden)** — armed when a cycle
 *   ends with nothing left to retry. See below.
 *
 * §8 suggests a 5 s ceiling, and this used to sit at 10 s on the grounds that
 * a checkpoint is one whole-note upload, billed and re-uploaded in full (plan
 * issue #10). Both numbers assumed the ceiling was a fallback for the unusual
 * case of someone typing without pause. Measured against two signed-in
 * devices, it is not: it is the *only* timer that fires during ordinary
 * typing, and edits took the full ten seconds to cross.
 *
 * The reason is that this debounce sits on top of an already-debounced stream.
 * A change is queued from the workspace's persist step, which runs 150 ms
 * after any pause in typing (`repo/writeScheduler.ts`); normal typing is full
 * of pauses longer than 150 ms and shorter than 800 ms, so `scheduleCheckpoint`
 * restarts the idle timer faster than it can ever expire. Debouncing a
 * debounced stream is the wrong primitive, and the ceiling is what actually
 * decides how fast a device syncs. Hence 3 s — tighter than §8's suggestion
 * rather than looser, which §8 explicitly allows ("these values should be
 * configurable and performance-tested"). `bench/phase5.mjs` has the
 * measurement.
 *
 * All of them stretch on a run of consecutive failures. A failed cycle re-arms
 * the timers, so without backoff a reachable-but-failing backend is hammered
 * every 800 ms forever, costing battery and quota for a request that is not
 * going to start working within the next second. A success, or the network
 * returning, resets it. The nudge does not bypass that: while a failure streak
 * is running it defers to the ordinary checkpoint.
 *
 * ## Why an idle device still needs a timer
 *
 * Remote changes arrive on a listener, not a poll (`adapters/firebase`), so a
 * device with an empty queue used to arm nothing at all: every timer above is
 * reached from `queueNote`/`queueFolder` or from a cycle that left work
 * behind. That made the listener a single point of failure. It can be
 * suspended with the tab or fail outright — the adapter swallows its errors on
 * the stated grounds that "the checkpoint timer will retry", which was untrue
 * for exactly the device that needed it — and a pull-only failure re-armed
 * nothing either, because nothing was queued to retry. Recovery waited on the
 * user refocusing the tab.
 *
 * So a cycle that ends with nothing retryable arms the backstop instead. One
 * minute is slow enough to stay a backstop rather than a poll (four billed
 * reads per minute — two empty queries and the rules' allowlist lookup for
 * each — leader tab only) and fast enough that a
 * dropped listener heals itself without the user noticing. It is skipped once
 * the session is dead, or it would wake forever for a cycle that returns
 * immediately.
 *
 * "Without the user noticing" only needs a minute when there is a user to
 * notice. A pinned tab left open all day spends most of it hidden, and at 60 s
 * it pays for 1,440 empty cycles a day that nobody reads — about four billed
 * reads each, counting the allowlist lookup in the rules. So a hidden tab
 * stretches the backstop to 15 minutes. Nothing a user sees gets slower:
 * remote changes still arrive live on the listener, and coming back to the tab
 * syncs at once (`App.svelte` on `visibilitychange` and `focus`), which re-arms
 * the minute. What is given up is only how quickly a *dead* listener in an
 * unwatched tab is noticed. The delay is read when the timer is armed, so a
 * tab that hides mid-wait fires once more at the minute and stretches after.
 *
 * One tab can be hidden while another is in use: the leader is whichever tab
 * took the lock first, not the one being looked at. A follower cannot sync, so
 * its focus would do nothing for a hidden leader; `syncNow()` on a follower
 * therefore sends `resync`, which the leader answers on the nudge.
 *
 * Local persistence is unaffected and runs on its own much tighter debounce.
 *
 * ## Folders
 *
 * Folders ride the same queue and the same pull, but none of the machinery
 * above applies to them: no revision, no compare-and-swap, no conflict copy.
 * A folder is a name and a parent, not user text, so §16's "preserve both
 * versions" has nothing to preserve, and the later write simply wins —
 * `updatedAt` being what "later" means. `applyRemoteFolder` holds that rule.
 *
 * ## Note versions
 *
 * History (`core/history/`) queues a version whenever it keeps one, and this
 * engine uploads them — but as passengers, never as a reason to sync. Versions
 * go after the note push and before the pull, one bounded page per cycle, and
 * they arm no timer, defer no cycle and never touch `pendingCount` or the
 * status line. A backlog therefore drains on cycles notes were causing anyway,
 * the backstop included, and costs nothing when there is nothing to send. Two
 * exceptions to "after": a tombstone's versions go *before* the tombstone, so
 * a device that learns of the delete can already fetch the text it had, and a
 * remote tombstone about to erase a note here has that note mirrored into
 * history first. Each version is its own commit and its own push
 * (`VERSION_PAGE`), and while the daily push limit holds notes back it holds
 * versions back too.
 *
 * Uploading is gated the way the backfill sweep is, on this device's vault
 * demonstrably being the account's: a version is the note's own ciphertext, so
 * one pushed under the wrong key is as permanent and as unreadable as a note.
 * A database that turns out to belong to another account retires its queued
 * versions along with everything else. A failure in the history database is
 * swallowed; only the backend's own verdicts — offline, session gone, account
 * refused — are allowed to affect a cycle.
 *
 * ## A refusal that is a pause
 *
 * The cost kill switch refuses every client with the same `permission-denied`
 * an account without a plan gets, so a `SyncNotApprovedError` is checked with
 * one probe (`adapter.probePause`, `./pause.ts`) before it is believed. A pause
 * latches exactly like non-approval — no timers, no listener, no more requests
 * — but reports `paused`, fires `onPaused` instead of `onNotApproved`, and does
 * not release the first-sync wait. Waiting for the end of it is the caller's
 * job (`createPauseWatch`), and so is starting a fresh engine afterwards: the
 * account binding and the once-per-session checks `App.svelte` makes before an
 * engine exists are exactly what a lockdown may have interrupted, so a restart
 * is what a reload would have done, without the reload.
 */
import type { NoteRepository, RawNote, RawFolder } from '../repo/noteRepository.ts';
import type { Encoded, QueuedChange } from '../repo/schema.ts';
import {
  loadFolderBytes,
  loadSyncState,
  saveFolderBytes,
  saveSyncState,
  type NoteSyncState,
} from './state.ts';
import { PushLimitError, QuotaExceededError, countedNoteBytes, meterDelta } from './usage.ts';
import { classifyOwner, shouldSweep } from './backfill.ts';
import {
  RevisionConflictError,
  SyncNotApprovedError,
  PayloadTooLargeError,
  SessionExpiredError,
  TransientSyncError,
  type SyncAdapter,
  type SyncCursor,
  type RemoteFolder,
  type RemoteNote,
  type RemoteVersion,
} from './adapter.ts';
import {
  createTabCoordinator,
  createTabChannel,
  nullTabChannel,
  type CoordinatorOptions,
  type TabCoordinator,
  type TabChannel,
  type TabRole,
} from './tabs.ts';
import type { Bytes } from '../crypto/bytes.ts';
import type { HistoryOutbox } from '../history/outbox.ts';
import { sealIdOf, type VersionRecord } from '../history/record.ts';

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'signed-out'
  | 'not-approved'
  /** Every client is refused for now (a cost lockdown); see `./pause.ts`. */
  | 'paused';

const CURSOR_KEY = 'sync:cursor';
/**
 * Durable record that the backfill sweep has run for this account.
 *
 * `sync:`-prefixed on purpose, the opposite choice from `app:owner`:
 * `clearSyncState()` clears it, so signing out and back in re-arms the sweep.
 * That is what catches work done while signed out on a device whose anchors
 * went with the sign-out.
 */
const BACKFILL_KEY = 'sync:backfilled';
const EPOCH_KEY = 'sync:epoch';
const PULL_PAGE = 200;
/**
 * Entries attempted per cycle.
 *
 * `push()` used to drain the whole queue in one call, which is fine for the
 * handful of entries a typing session produces and ruinous for the thousands a
 * backfill produces: each anchorless note costs a read and a write, so ten
 * thousand of them is tens of thousands of serial round trips inside a single
 * cycle — with `pull()` queued behind it the entire time, and `onFirstSync`
 * with it, which is what the first-run gate waits on. Paging keeps a cycle
 * bounded; the queue is durable, so the rest is simply the next cycle's work
 * and a reload resumes where it stopped.
 */
const PUSH_PAGE = 200;

/**
 * Versions uploaded per cycle, one commit each (the rules count every version
 * exactly that way; `adapters/firebase/versions.ts`). Small, because the page
 * is serial round trips inside the cycle; a typical session makes a handful of
 * versions, and a backlog drains over the next few cycles. Bounded by bytes as
 * well, so one cycle does not upload many megabytes on a phone.
 */
const VERSION_PAGE = 20;
const VERSION_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * Coalescing window for a structural change (§8's cadence does not apply).
 *
 * Short enough that a new note reaches the other device in about a round trip,
 * long enough that one user action producing many entries — deleting a folder
 * enqueues a tombstone per note inside it — is one cycle rather than a cycle
 * each.
 */
const NUDGE_MS = 100;

/**
 * How often a device with nothing queued checks anyway.
 *
 * Not a poll: remote changes arrive on a listener. This is the listener's only
 * failure path back, for a tab whose subscription was suspended or errored out.
 * The Cadence notes above have the argument for the number.
 */
const LISTENER_BACKSTOP_MS = 60_000;

/**
 * The backstop while this tab is hidden.
 *
 * Fifteen minutes is 96 checks a day instead of 1,440, a 94% cut in the reads
 * an idle tab costs, and still short enough that a tab left in the background
 * over lunch has healed a dead listener by itself. Returning to the tab syncs
 * immediately regardless, so the number only matters for nobody watching.
 */
const HIDDEN_BACKSTOP_MS = 15 * 60_000;

/**
 * Notes up to this size keep the plain ceiling.
 *
 * Every push replaces the whole document, and the listener's echo pulls it
 * straight back, so a checkpoint costs the note's full size in egress twice.
 * At 3 s that is nothing for a typical note and about 600 MB an hour for
 * someone typing into a 500 KB one, which is the one place a single user's
 * Firestore bill stops being rounding error. Above this size the ceiling
 * stretches in proportion, to ten times the base at the backend's 900 KiB
 * limit: a big note crosses a few seconds later, a small one never notices.
 */
const LARGE_NOTE_BYTES = 64 * 1024;
const MAX_NOTE_BYTES = 900 * 1024;
const LARGE_NOTE_STRETCH = 10;

/** The checkpoint ceiling for a note of `bytes` stored size. */
export function ceilingFor(bytes: number, baseMs: number): number {
  if (bytes <= LARGE_NOTE_BYTES) return baseMs;
  const span = (Math.min(bytes, MAX_NOTE_BYTES) - LARGE_NOTE_BYTES) / (MAX_NOTE_BYTES - LARGE_NOTE_BYTES);
  return Math.round(baseMs * (1 + span * (LARGE_NOTE_STRETCH - 1)));
}

/**
 * Bumped when a bug made the stored cursor untrustworthy.
 *
 * A delta cursor is a claim: "everything before this point has been delivered".
 * When that claim turns out to have been false, no amount of fixing the code
 * that computes it recovers what was already skipped — the cursor has moved
 * past those documents and `syncedAt > cursor` will never offer them again.
 * The only repair is to drop the claim and re-read from the beginning once.
 *
 * Epoch 1 repairs two such bugs, both in `src/adapters/firebase/cursor.ts`:
 * the notes and folders queries shared one cursor, so whichever collection
 * reached further into the future dragged it past the other's undelivered
 * backlog; and the cursor was a bare timestamp, which cannot paginate through
 * documents that share a millisecond, so ties falling across a page boundary
 * were skipped. Folders were the usual casualty of the first, which showed up
 * as a note arriving on a second device filed in a folder that did not exist
 * there. The second could drop anything written in a burst.
 *
 * A backfill is cheap and safe to repeat: `applyRemoteNote` refuses anything at
 * or below the revision it has already recorded, so re-seeing the whole account
 * writes nothing, reloads no metadata, rebuilds no search index and mints no
 * conflict copies. It costs one paged read.
 */
const SYNC_EPOCH = 1;

export interface ConflictReport {
  /** The note whose push was rejected. */
  noteId: string;
  /** The id of the copy holding the local version. */
  copyId: string;
}

export interface SyncEngineOptions {
  adapter: SyncAdapter;
  repo: NoteRepository;
  /**
   * Ceiling during continuous editing.
   *
   * In practice the governing number rather than a fallback — see Cadence at
   * the top of this file for why the idle debounce below does not fire while
   * someone is typing.
   */
  checkpointMs?: number;
  /** Quiet period after a change before pushing. */
  idleMs?: number;
  onStatus?: (status: SyncStatus) => void;
  /**
   * Flush anything the caller is still holding, before the round trip starts.
   *
   * The queue entry is what tells a pull that a note has local text not yet
   * sent. Text sitting in an unflushed write debounce has no entry, so a pull
   * landing in that window adopts the remote version, the editor reloads, and
   * the debounce then writes the user's text back and pushes it at the freshly
   * adopted base — which succeeds, destroying the other device's edit with no
   * conflict copy and no trace. Flushing first turns that race back into the
   * conflict it is.
   *
   * Must flush only; a hook that queues fresh work on every call would sync in
   * a loop.
   */
  beforeSync?: () => Promise<void>;
  /**
   * Remote changes landed in the database underneath this tab; the UI should
   * reload metadata. A sibling tab's write is not reported here — the
   * workspace hears those on the tab channel itself, engine or no engine.
   */
  onRemoteChange?: () => void;
  /** A conflict was preserved rather than resolved. */
  onConflict?: (report: ConflictReport) => void;
  /** The session is no longer valid; the user must sign in again. */
  onSessionExpired?: () => void;
  /** The account is valid but not authorised to sync. Signing in again will
   *  not help; the account has to be approved. */
  onNotApproved?: () => void;
  /**
   * A refusal turned out to be a cost lockdown, not this account's: the
   * backend is refusing every client for now (`./pause.ts`). The engine has
   * latched as it does for `not-approved` and asks nothing more of the
   * backend; the caller waits for the pause to end and starts a new engine,
   * as it would after a reload. Unlike `onNotApproved` nothing here is a
   * reason to sign anyone out, and `onFirstSync` is *not* fired — the account
   * still holds whatever it held, and an empty device must not seed welcome
   * notes that would duplicate once sync resumes.
   */
  onPaused?: () => void;
  /**
   * Fired once, when this device has learned whatever the account holds — a
   * completed cycle, or the discovery that the account cannot sync at all.
   *
   * The workspace waits for this before writing first-run content: a device
   * with an empty local database cannot tell a new account from an existing
   * one without asking, and guessing wrong mints duplicate notes on every
   * device. An account that can never sync still has to release the wait, or
   * an unapproved user would sit in front of an empty app forever.
   */
  onFirstSync?: () => void;
  /**
   * Whether this tab is hidden. Read when the listener backstop is armed, to
   * stretch it while nobody is looking — see Cadence. The engine stays free of
   * the DOM, so the caller answers.
   */
  isHidden?: () => boolean;
  /** The outstanding queue length, as it changes. See `reportPending`. */
  onPending?: (count: number) => void;
  /**
   * How many notes and folders are waiting because the account's storage is
   * full, each time that changes; 0 once space was found for them. They stay
   * queued and editable, exactly like any other unsent change.
   */
  onStorageFull?: (waiting: number) => void;
  /**
   * How many notes and folders are waiting because the account has used its
   * daily pushes (`DAILY_PUSH_LIMIT`), and when the engine will try again; 0
   * and null once they are moving. Held exactly as storage-full changes are.
   */
  onPushLimit?: (waiting: number, retryAt: number | null) => void;
  /**
   * Whether this device's vault is demonstrably the account's, or null while
   * the caller is still finding out. Read rather than passed once, because the
   * answer needs a backend round trip and the engine starts before it lands.
   */
  vaultOwnsAccount?: () => boolean | null;
  /**
   * This database belongs to a different account. Its sync bookkeeping has
   * been dropped and nothing will be uploaded from it.
   */
  onForeignOwner?: () => void;
  /**
   * Creates the local conflict copy. Owned by the caller, which has the key.
   *
   * The remote version is handed over so the caller can decrypt it and decline
   * — returning `null` — when the two sides say the same thing. A duplicate of
   * text that already matches is never worth making.
   */
  createConflictCopy?: (noteId: string, remote?: RemoteNote) => Promise<string | null>;
  /**
   * Carry a metadata-only local change onto the remote version that beat it.
   *
   * Given both sealed metas, returns the sealed meta to store and push — the
   * remote's, with this device's pin and folder laid over it — or null when
   * there is nothing of ours left to keep. Owned by the caller, which has the
   * key; the engine only moves the bytes. See Conflicts at the top of this file.
   */
  rebaseMeta?: (noteId: string, local: Bytes, remote: Bytes) => Promise<Bytes | null>;
  /**
   * Note history's upload queue, loaded on demand. Resolves to null when
   * history is unavailable; versions are then simply not synced.
   */
  history?: () => Promise<HistoryOutbox | null>;
  /**
   * How tabs coordinate. Injected so the engine can be tested without Web
   * Locks, which is unreliable under worker-thread test runners.
   */
  createCoordinator?: (options: CoordinatorOptions) => TabCoordinator;
  /**
   * The tab channel, owned by the caller because it outlives the engine (see
   * `tabs.ts`, "Two lifetimes"). Without one the engine opens and closes its
   * own, which hears siblings but is not what the app does.
   */
  channel?: TabChannel | undefined;
}

export interface SyncEngine {
  start(): Promise<void>;
  stop(): void;
  /** Which tab this is. Only the leader talks to the backend. */
  readonly role: TabRole;
  /**
   * Queue a local change for the next push. Durable across reloads.
   *
   * `immediate` marks a structural change — a note created, deleted or moved, a
   * folder added, renamed or deleted — which syncs on the short nudge rather
   * than the typing debounce. Text edits leave it unset.
   */
  queueNote(id: string, immediate?: boolean): Promise<void>;
  queueFolder(id: string, immediate?: boolean): Promise<void>;
  /** Push and pull now. Resolves when the round trip finishes. */
  syncNow(): Promise<void>;
  readonly status: SyncStatus;
  readonly pendingCount: number;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const {
    adapter,
    repo,
    checkpointMs = 3_000,
    idleMs = 800,
    onStatus,
    beforeSync,
    onRemoteChange,
    onConflict,
    onSessionExpired,
    onNotApproved,
    onPaused,
    onFirstSync,
    isHidden = () => false,
    onPending,
    onStorageFull,
    onPushLimit,
    vaultOwnsAccount = () => null,
    onForeignOwner,
    createConflictCopy,
    rebaseMeta,
    history,
    createCoordinator = createTabCoordinator,
    channel: sharedChannel,
  } = options;

  let status: SyncStatus = 'idle';
  let pendingCount = 0;
  /** True while the queue holds something worth another attempt. */
  let retryable = false;
  /** Consecutive conflicts per note; any push that lands clears the entry. */
  const conflictStreak = new Map<string, number>();
  /** Notes the breaker has stopped pushing. A fresh edit gives them another go. */
  const parked = new Set<string>();
  const CONFLICT_LIMIT = 2;
  /**
   * Stored size of each note as last pushed, for `ceilingFor`. In memory only:
   * a note this session has not pushed yet gets the plain ceiling once, and
   * the stretch from its first push on.
   */
  const pushedBytes = new Map<string, number>();
  /**
   * Changes refused because the account's storage is full. They are parked like
   * any other refusal, but they come back as soon as a push frees space, rather
   * than waiting for an edit: deleting something elsewhere is how a user
   * answers "storage full", and the waiting notes should go on their own then.
   */
  const storageParked = new Set<string>();
  /**
   * Set when a write was refused for space, so the rest of the cycle does not
   * spend a refused write on every other change that would grow the account
   * too. Cleared when a push frees space, and at the start of each cycle.
   */
  let storageFull = false;
  let storageHeldAt = 0;
  const STORAGE_RETRY_MS = 10 * 60_000;
  /**
   * The daily push limit. Until `pushLimitedUntil` every note, folder and
   * version stays on the device without a write being spent on it — each
   * refused push would cost a write and three reads to learn the same thing.
   * The time is the window's start plus 24 h as the meter reported it; it is
   * only a schedule, never a verdict (the server decides when it retries), so
   * it is floored at `PUSH_LIMIT_RETRY_MS` from now, or a device whose clock
   * runs ahead would retry in a tight loop.
   */
  const limitParked = new Set<string>();
  let pushLimitedUntil = 0;
  const PUSH_LIMIT_RETRY_MS = 15 * 60_000;
  /**
   * Consecutive failed cycles, for backoff.
   *
   * A failed sync re-arms the idle timer, which syncs, which fails, which
   * re-arms: against a reachable-but-failing backend that is a permanent
   * `idleMs` hammer with no ceiling, costing battery and quota for a request
   * that is not going to start working within the next second.
   */
  let failureStreak = 0;
  const BACKOFF_CEILING_MS = 5 * 60_000;
  let running = false;
  let stopped = false;
  /** Latched once the session is gone: retrying cannot help until a new sign-in. */
  let sessionDead = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let backstopTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let chain: Promise<void> = Promise.resolve();
  let tabs: TabCoordinator | undefined;
  let isLeader = false;
  let firstSyncFired = false;
  /**
   * Set when a conflict rewrote the local store during `push()`.
   *
   * A resolved conflict replaces the note's stored text with the backend's and
   * adds a copy holding the local version — the same kind of change a pull
   * makes, but made from the push half of the cycle, where `changed` is not
   * watching. Without saying so, the workspace kept showing the pre-conflict
   * text and the search index never learned the adopted version existed, so
   * the other device's edit was present in the database and unfindable.
   */
  let appliedLocally = false;
  /** Set when `push()` stopped at a page boundary with entries still queued. */
  let pushDeferred = false;
  /** Latched once the owner is bound and the sweep question is answered. */
  let backfillSettled = false;
  /** A channel the engine opened for itself, and so must close. */
  let ownChannel: TabChannel | undefined;

  /**
   * Announce, once, that the account's contents are now known here.
   *
   * Followers never run a cycle of their own (`runSync` returns early for
   * them), so the leader broadcasts and they fire on the message instead.
   * Without that a second tab on a fresh install would wait for a pull it is
   * never going to perform.
   */
  function fireFirstSync(): void {
    if (firstSyncFired) return;
    firstSyncFired = true;
    onFirstSync?.();
  }

  function setStatus(next: SyncStatus): void {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  }

  /**
   * Only `navigator.onLine === false` is a trustworthy signal.
   *
   * The property is `undefined` outside a browser and in some webviews, and an
   * earlier version treated that as offline — which left sync permanently
   * stuck reporting "Offline" and never attempting a write. Even in a browser,
   * `onLine === true` does not promise reachability; the network layer is the
   * real test, and a failed attempt is classified as transient anyway.
   */
  const online = () => {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine !== false;
  };

  function clearTimers(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
    if (nudgeTimer !== undefined) clearTimeout(nudgeTimer);
    if (backstopTimer !== undefined) clearTimeout(backstopTimer);
    idleTimer = undefined;
    ceilingTimer = undefined;
    nudgeTimer = undefined;
    backstopTimer = undefined;
  }

  /** The idle delay, stretched by any run of consecutive failures. */
  function retryDelay(): number {
    if (failureStreak === 0) return idleMs;
    const scaled = idleMs * 2 ** Math.min(failureStreak, 12);
    return Math.min(scaled, BACKOFF_CEILING_MS);
  }

  function scheduleCheckpoint(noteId?: string): void {
    if (stopped) return;

    // A follower does not sync; the leader owns the backend connection and the
    // durable queue this change is already sitting in. Waking it is not done
    // here any more — this function also runs on the retry path after a failed
    // cycle, where nothing new has been written and a broadcast would be a lie.
    // The workspace announces from the one place that means a mutation
    // actually happened, and does so with or without an engine.
    if (!isLeader) return;

    // Restarted on every change, so a burst of edits produces one push once
    // the user pauses.
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void syncNow();
    }, retryDelay());

    // Started once per burst, so continuous typing still checkpoints instead
    // of pushing the deadline forward forever.
    if (ceilingTimer === undefined) {
      ceilingTimer = setTimeout(
        () => {
          ceilingTimer = undefined;
          void syncNow();
        },
        // Stretching only the idle timer would achieve nothing: the ceiling
        // re-arms after every failed cycle too, and would go on firing at its
        // own interval.
        Math.max(ceilingFor(noteId === undefined ? 0 : (pushedBytes.get(noteId) ?? 0), checkpointMs), retryDelay()),
      );
    }
  }

  /**
   * Sync a structural change on the short window instead of the typing one.
   *
   * Never restarted while armed. A debounce here would reproduce the bug the
   * Cadence notes describe in miniature: deleting a folder enqueues one entry
   * per note inside it, back to back, and a resettable timer would push the
   * deadline forward with every one of them.
   */
  function scheduleNudge(): void {
    if (stopped) return;

    // Same bargain as `scheduleCheckpoint`: a follower owns no backend
    // connection, and the tab that does has already been told by the
    // workspace's announcement.
    if (!isLeader) return;

    // A structural change is not a reason to bypass backoff. While a failure
    // streak is running, the stretched checkpoint is the whole point.
    if (failureStreak > 0) {
      scheduleCheckpoint();
      return;
    }

    if (nudgeTimer !== undefined) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = undefined;
      void syncNow();
    }, NUDGE_MS);
  }

  /**
   * Keep a device with an empty queue checking, slowly.
   *
   * The listener is the only thing that tells an idle device anything, and it
   * can go quiet without saying so. See "Why an idle device still needs a
   * timer" at the top of this file.
   */
  function scheduleBackstop(): void {
    if (stopped || !isLeader) return;
    // A dead session wakes to a cycle that returns on its first line. Arming
    // this would be a wake-up a minute, forever, for nothing.
    if (sessionDead) return;

    if (backstopTimer !== undefined) clearTimeout(backstopTimer);
    backstopTimer = setTimeout(
      () => {
        backstopTimer = undefined;
        void syncNow();
      },
      // A failing backend is still a failing backend when nothing is queued:
      // a pull that cannot complete would otherwise retry every minute
      // regardless of the streak.
      Math.max(isHidden() ? HIDDEN_BACKSTOP_MS : LISTENER_BACKSTOP_MS, retryDelay()),
    );
  }

  async function loadCursor(): Promise<SyncCursor> {
    return (await repo.get<string>(CURSOR_KEY)) ?? null;
  }

  /**
   * Drop the stored cursor once, if it was written before the current epoch.
   *
   * Runs before the first pull of the session. The marker is written in the
   * same step, so an interrupted backfill simply repeats next time rather than
   * being recorded as done.
   */
  async function applyEpoch(): Promise<void> {
    const seen = (await repo.get<number>(EPOCH_KEY)) ?? 0;
    if (seen >= SYNC_EPOCH) return;
    await repo.set(CURSOR_KEY, null);
    await repo.set(EPOCH_KEY, SYNC_EPOCH);
  }

  /**
   * Re-read the queue.
   *
   * `pendingCount` stays honest about how much work is outstanding, including
   * parked notes — the user has unsynced text either way. `retryable` is the
   * separate question of whether trying again could achieve anything, and only
   * that one decides whether to schedule another attempt. Without the split, a
   * parked note would spin the checkpoint timer forever.
   */
  async function refreshPending(): Promise<void> {
    const queue = await repo.queued();
    pendingCount = queue.length;
    retryable = queue.some((entry) => !parked.has(entry.id));
    reportPending();
  }

  /**
   * Publish the outstanding count.
   *
   * The UI used to read `pendingCount` only from inside the status callback,
   * and `setStatus` returns early when the status has not changed — so a long
   * drain sat on 'syncing' and the counter never moved. A backfill is the first
   * thing slow enough for that to matter: minutes of work with no sign of
   * progress reads as a hang.
   */
  function reportPending(): void {
    onPending?.(pendingCount);
  }

  // --- account binding and backfill ----------------------------------------

  /**
   * Settle who this database belongs to, and sweep its contents into the queue
   * the first time an account claims it.
   *
   * Runs before every push rather than once at start-up, because the vault
   * answer arrives from the caller on its own clock and may still be null on
   * the first cycle; the marker and the binding make re-entry cheap.
   *
   * `core/sync/backfill.ts` holds the reasoning for each refusal. The short
   * version: an unswept backlog can be swept on any later sync, while notes
   * written into the wrong account cannot be taken back — the rules refuse
   * deletes outright — and notes sealed under a key that account cannot open
   * are just as permanent.
   */
  async function bindAccount(): Promise<void> {
    if (backfillSettled) return;
    const uid = adapter.user?.uid;
    if (!uid) return;

    const verdict = classifyOwner(await repo.owner(), uid);

    if (verdict === 'foreign') {
      // Another account's cursor, anchors and queue are still here. They
      // describe a different change stream and a different library, so they go
      // — and nothing is swept, because these notes are not this account's to
      // upload. `signOut()` is supposed to have done this already; it does
      // nothing when the engine never started, and the session-expiry path
      // used not to do it at all, so this is the line that actually holds.
      await repo.clearSyncState();
      await repo.setOwner(uid);
      // Retire the sweep for this library, after the wipe rather than before
      // it — `clearSyncState` would have taken the marker with everything
      // else. Without this the device is now bound to the new account, so the
      // next reload would classify as 'same', find the marker gone, and sweep
      // the previous account's entire library into this one. Work done from
      // here on still syncs normally; it is only what was already stored that
      // stays put.
      await repo.set(BACKFILL_KEY, true);
      // Versions of these notes are this library's too.
      await guardHistory(async () => (await loadHistory())?.retireAll());
      backfillSettled = true;
      onForeignOwner?.();
      return;
    }

    if (verdict === 'adopt') await repo.setOwner(uid);

    const alreadySwept = (await repo.get<boolean>(BACKFILL_KEY)) === true;
    if (!shouldSweep({ owner: verdict, vaultOwnsAccount: vaultOwnsAccount(), alreadySwept })) {
      // Only a settled 'no' ends the matter. A null vault answer means the
      // caller has not finished asking, and the next cycle should try again.
      if (alreadySwept || vaultOwnsAccount() === false) backfillSettled = true;
      return;
    }

    const { notes, folders } = await repo.sweepableIds();
    const queued = new Set((await repo.queued()).map((entry) => entry.id));
    const entries = [
      ...notes.map((id) => ({ id, kind: 'note' as const })),
      ...folders.map((id) => ({ id, kind: 'folder' as const })),
    ].filter((entry) => !queued.has(entry.id));

    // The marker goes down first. A sweep interrupted halfway has queued rows
    // that are durable and will drain; re-running it would only re-queue what
    // is already there, and on a large library that is a second full pass for
    // nothing.
    await repo.set(BACKFILL_KEY, true);
    await repo.enqueueMany(entries);
    backfillSettled = true;
    if (entries.length > 0) await refreshPending();
  }

  // --- note versions --------------------------------------------------------

  async function loadHistory(): Promise<HistoryOutbox | null> {
    return history ? history() : null;
  }

  /**
   * Run history work, letting only the backend's verdicts through. A failing
   * history database must never stop notes from syncing.
   */
  async function guardHistory(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (
        error instanceof SessionExpiredError ||
        error instanceof SyncNotApprovedError ||
        error instanceof TransientSyncError
      ) {
        throw error;
      }
    }
  }

  /** The outbox, if this device may upload into this account at all. */
  async function uploadableHistory(): Promise<HistoryOutbox | null> {
    if (vaultOwnsAccount() !== true) return null;
    return loadHistory();
  }

  function toRemoteVersion(record: VersionRecord): RemoteVersion {
    return {
      noteId: record.noteId,
      id: record.sealId,
      meta: record.meta as Bytes,
      body: record.body as Bytes,
      at: record.at,
      reason: record.reason,
      expireAt: record.expireAt,
    };
  }

  async function uploadVersions(outbox: HistoryOutbox, records: readonly VersionRecord[]): Promise<void> {
    if (records.length === 0 || pushLimited()) return;
    let refused: RemoteVersion[];
    try {
      ({ refused } = await adapter.pushVersions(records.map(toRemoteVersion)));
    } catch (error) {
      // Left pending, not marked local: these go once the window rolls over.
      // Any of the page that did land is re-sent then and refused as a
      // duplicate, which the adapter treats as written.
      if (error instanceof PushLimitError) {
        limitReached(error);
        return;
      }
      throw error;
    }
    const refusedKeys = new Set(refused.map((v) => `${v.noteId}:${v.id}`));
    await outbox.markLocal(records.filter((r) => refusedKeys.has(r.id)).map((r) => r.id));
    await outbox.markPushed(records.filter((r) => !refusedKeys.has(r.id)).map((r) => r.id));
  }

  /** One page of queued versions. Never reports work left behind. */
  function pushVersions(): Promise<void> {
    return guardHistory(async () => {
      const outbox = await uploadableHistory();
      if (!outbox) return;
      await uploadVersions(outbox, await outbox.pending(VERSION_PAGE, VERSION_PAGE_BYTES));
    });
  }

  // --- push ----------------------------------------------------------------

  /**
   * The revision is a parameter, not `raw.revision`, and deliberately so: the
   * two are different numbers, and reading the local one here is the whole bug
   * this file's header describes. Making the caller say which revision it means
   * is what stops it coming back.
   */
  function toRemote(raw: RawNote, revision: number): RemoteNote {
    // Anything reaching here must already be ciphertext. A string would mean a
    // record written before encryption existed, and uploading it would be a
    // silent breach of the whole promise — refuse rather than "handle" it.
    if (typeof raw.meta === 'string' || typeof raw.body === 'string') {
      throw new Error(`note ${raw.id} is not encrypted; refusing to upload`);
    }
    const note: RemoteNote = {
      id: raw.id,
      meta: raw.meta as Bytes,
      revision,
      updatedAt: raw.updatedAt,
      deleted: raw.deleted,
    };
    if (raw.body !== undefined) note.body = raw.body as Bytes;
    return note;
  }

  function sizeOf(value: Encoded | undefined): number {
    if (value === undefined) return 0;
    return typeof value === 'string' ? value.length : value.byteLength;
  }

  /** What a remote note costs against the allowance (`usage.ts`). */
  function remoteBytes(remote: RemoteNote): number {
    return countedNoteBytes(remote.meta, remote.body);
  }

  /** Park a change until a push frees space, and tell the UI how many wait. */
  function holdForSpace(id: string): void {
    storageFull = true;
    storageHeldAt = Date.now();
    parked.add(id);
    if (!storageParked.has(id)) {
      storageParked.add(id);
      onStorageFull?.(storageParked.size);
    }
  }

  /** A push shrank the account: everything waiting for space gets another go. */
  function spaceFreed(): void {
    storageFull = false;
    if (storageParked.size === 0) return;
    for (const id of storageParked) parked.delete(id);
    storageParked.clear();
    onStorageFull?.(0);
  }

  /** A change that was waiting for space, or for the push window, went through after all. */
  function sent(id: string): void {
    if (storageParked.delete(id)) onStorageFull?.(storageParked.size);
    if (limitParked.delete(id)) onPushLimit?.(limitParked.size, limitParked.size > 0 ? pushLimitedUntil : null);
  }

  /** Whether the daily push limit is holding writes back right now. */
  function pushLimited(): boolean {
    return Date.now() < pushLimitedUntil;
  }

  /** The push window is full: hold everything until it rolls over. */
  function limitReached(error: PushLimitError): void {
    pushLimitedUntil = Math.max(error.retryAt ?? 0, Date.now() + PUSH_LIMIT_RETRY_MS);
    // Changes still held from an earlier refusal get the new time too.
    if (limitParked.size > 0) onPushLimit?.(limitParked.size, pushLimitedUntil);
  }

  /** Park a change until the push window rolls over, and tell the UI. */
  function holdForLimit(id: string): void {
    parked.add(id);
    if (!limitParked.has(id)) {
      limitParked.add(id);
      onPushLimit?.(limitParked.size, pushLimitedUntil);
    }
  }

  /**
   * Once the window should have rolled over, let the held changes try again.
   * They stay counted until each one is sent, so the status does not blink to
   * "synced" and back if the server says the day is not over yet.
   */
  function retryHeldForLimit(): void {
    if (limitParked.size === 0 || pushLimited()) return;
    for (const id of limitParked) parked.delete(id);
  }

  /**
   * Try the waiting changes again now and then even if nothing here freed
   * space: another device may have, or the plan may have grown. One refused
   * write per retry, because the first refusal latches `storageFull` again.
   */
  function retryHeldForSpace(): void {
    if (storageParked.size === 0 || Date.now() - storageHeldAt < STORAGE_RETRY_MS) return;
    for (const id of storageParked) parked.delete(id);
  }

  async function pushOne(entry: QueuedChange): Promise<void> {
    const { id, kind, token } = entry;

    if (kind === 'folder') {
      if (parked.has(id)) return;
      if (pushLimited()) {
        holdForLimit(id);
        return;
      }
      const raw = await repo.loadRawFolder(id);
      if (!raw) {
        await repo.dequeue(id);
        return;
      }
      if (typeof raw.data === 'string') {
        throw new Error(`folder ${id} is not encrypted; refusing to upload`);
      }
      const stored = (await loadFolderBytes(repo, id)) ?? 0;
      const size = raw.data.byteLength;
      if (storageFull && meterDelta(size, stored) > 0) {
        holdForSpace(id);
        return;
      }
      try {
        await adapter.pushFolder(
          {
            id: raw.id,
            data: raw.data as Bytes,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            deleted: raw.deleted,
          } satisfies RawFolder & { data: Bytes },
          stored,
        );
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          holdForSpace(id);
          return;
        }
        if (error instanceof PushLimitError) {
          limitReached(error);
          holdForLimit(id);
          return;
        }
        throw error;
      }
      await saveFolderBytes(repo, id, size);
      sent(id);
      if (meterDelta(size, stored) < 0) spaceFreed();
      await repo.dequeue(id, token);
      return;
    }

    // Parked by the breaker. Left in the queue on purpose: the text is not
    // lost, it is just not being thrown at a backend that keeps refusing it.
    if (parked.has(id)) return;
    if (pushLimited()) {
      holdForLimit(id);
      return;
    }

    const raw = await repo.loadRawNote(id);
    if (!raw) {
      // Queued then removed locally with nothing to tombstone.
      await repo.dequeue(id);
      return;
    }

    const state = await loadSyncState(repo, id);

    // A newer backend revision was sighted while this note had unpushed edits.
    // Pushing now would overwrite it, and on a note with no `base` the
    // bootstrap read below would do so *silently*, since it would anchor to
    // the very revision we declined to apply. It is a conflict; say so.
    if (state?.seen !== undefined && state.seen > state.base) {
      await resolveConflict(entry, raw, state);
      return;
    }

    // Rebase onto the backend rather than trusting the local counter — see the
    // note at the top of this file on why those are different numbers.
    let base = state?.base;
    let stored = state?.baseBytes;
    if (base === undefined) {
      // Never pushed from this device, or pushed before this bookkeeping
      // existed. One read to find out where the backend is, once per note.
      //
      // Tempting to skip this during a backfill — a device with no cursor has
      // pulled nothing, so surely a note under its own random id cannot be on
      // the backend, and `base = 0` would save a billed read per note. It is
      // wrong twice: signing out clears the cursor and the anchors but not the
      // notes, and an install that predates `app:owner` has no binding either,
      // so in both cases the document does exist and sits well above revision
      // 1. Assuming zero then pushes revision 1, the compare-and-swap refuses
      // it, and `resolveConflict` forks the note into a conflict copy —
      // every note, on an ordinary sign-in. The read stays.
      const remote = await adapter.fetchNote(id);
      base = remote?.revision ?? 0;
      await saveSyncState(repo, id, { base, baseBytes: remote ? remoteBytes(remote) : 0 });
      stored = remote ? remoteBytes(remote) : 0;
    }
    const next = base + 1;

    // What the backend holds at `base`, for the storage meter. Unknown only on
    // an anchor written before the meter existed; one read settles it, once.
    // A read that finds the note has moved on leaves the guess in place: the
    // compare-and-swap refuses this push anyway, and the conflict path anchors
    // afresh with the size.
    if (stored === undefined) {
      if (base === 0) {
        stored = 0;
      } else {
        const remote = await adapter.fetchNote(id);
        stored = remote ? remoteBytes(remote) : 0;
        if (remote?.revision === base) await saveSyncState(repo, id, { ...state!, baseBytes: stored });
      }
    }
    const size = sizeOf(raw.meta) + sizeOf(raw.body);
    if (storageFull && meterDelta(size, stored) > 0) {
      holdForSpace(id);
      return;
    }

    // A delete's versions land before the delete does, so a device that hears
    // about the tombstone can already fetch what the note said.
    if (raw.deleted) {
      await guardHistory(async () => {
        const outbox = await uploadableHistory();
        if (outbox) await uploadVersions(outbox, await outbox.pendingFor(id));
      });
    }

    try {
      await adapter.pushNote(toRemote(raw, next), stored);
      pushedBytes.set(id, size);
      await saveSyncState(repo, id, withBodySeal({ base: next, baseBytes: size }, raw.body));
      conflictStreak.delete(id);
      sent(id);
      if (meterDelta(size, stored) < 0) spaceFreed();
      // Conditional: an edit made while this push was in flight re-queued the
      // note, and that entry has to survive.
      await repo.dequeue(id, token);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        await resolveConflict(entry, raw, { ...state, base });
        return;
      }
      if (error instanceof QuotaExceededError) {
        // Not this note's fault, and not worth an error status: the text is
        // safe, queued, and goes as soon as there is room.
        holdForSpace(id);
        return;
      }
      if (error instanceof PushLimitError) {
        // The same, for the day's pushes: queued, and goes once the window
        // rolls over.
        limitReached(error);
        holdForLimit(id);
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        // Nothing to retry: the note cannot fit. Park it rather than drop it —
        // it must stay queued, because the queue entry is now what tells a pull
        // this note holds local text it has not managed to send. Dequeuing here
        // would let the stale backend copy overwrite it on the next pull.
        parked.add(id);
        throw error;
      }
      throw error;
    }
  }

  /**
   * Preserve both sides (§16).
   *
   * The remote version keeps the original id, because that is what every other
   * device already agrees on. The local version becomes a new note, so the text
   * the user typed on this device still exists and is theirs to reconcile.
   */
  async function resolveConflict(
    entry: QueuedChange,
    raw: RawNote,
    state: NoteSyncState,
  ): Promise<void> {
    const { id, token } = entry;
    const remote = await adapter.fetchNote(id);

    // The compare-and-swap applies to a document that exists and has moved. If
    // neither is true, the write was refused for some other reason — a payload
    // the rules dislike, say, which Firestore reports with the same
    // `permission-denied`. That is not a conflict, and answering it with a copy
    // would mint one per attempt forever. Park it and let the status line say
    // so; the text stays queued and stays editable.
    if (!remote || remote.revision === state.base) {
      parked.add(id);
      return;
    }

    // Our own write, acknowledged by the backend but not by the network. The
    // stored version already *is* what we sent, so there is nothing to
    // reconcile — forking here would duplicate a note over a dropped packet.
    if (remote.revision === state.base + 1 && remote.updatedAt === raw.updatedAt) {
      await saveSyncState(
        repo,
        id,
        withBodySeal({ base: remote.revision, baseBytes: remoteBytes(remote) }, raw.body),
      );
      conflictStreak.delete(id);
      await repo.dequeue(id, token);
      return;
    }

    // A backstop behind the two discriminators above: whatever else is going
    // on, one note does not get to spawn copies indefinitely.
    const streak = (conflictStreak.get(id) ?? 0) + 1;
    conflictStreak.set(id, streak);
    if (streak >= CONFLICT_LIMIT) {
      parked.add(id);
      return;
    }

    // Only metadata changed here: the stored body is still, byte for byte, the
    // one the backend last agreed to. There is no text of ours to preserve, so
    // no copy — a stale-text duplicate of a note someone just edited elsewhere
    // is exactly the fork §16 is about avoiding. Take the remote version and
    // lay this device's pin and folder over it.
    if (!raw.deleted && !remote.deleted && isUnchangedBody(raw.body, state.bodySeal)) {
      await adoptWithLocalMeta(entry, raw, remote);
      return;
    }

    const copyId = (await createConflictCopy?.(id, remote)) ?? null;

    // Written directly rather than through `applyRemoteNote`, whose guard
    // refuses to overwrite a queued note — which is exactly what this is. Safe
    // here only because the local side has just been copied aside.
    const local = await repo.loadRawNote(id);
    await repo.putRawNote({
      id: remote.id,
      meta: remote.meta,
      body: remote.body,
      updatedAt: remote.updatedAt,
      revision: (local?.revision ?? 0) + 1,
      deleted: remote.deleted,
    });
    await saveSyncState(repo, id, withBodySeal({ base: remote.revision, baseBytes: remoteBytes(remote) }, remote.body));
    appliedLocally = true;

    await repo.dequeue(id, token);
    if (copyId) {
      // The copy is a brand new note, so it pushes cleanly as a create.
      await repo.enqueue(copyId, 'note');
      onConflict?.({ noteId: id, copyId });
    }
  }

  /**
   * The metadata-only half of `resolveConflict`: adopt the remote version, and
   * when the caller says there is local metadata worth keeping, store the
   * remote body under the merged meta and leave the note queued so the next
   * push sends it at the adopted base.
   */
  async function adoptWithLocalMeta(entry: QueuedChange, raw: RawNote, remote: RemoteNote): Promise<void> {
    const { id, token } = entry;
    let meta: Encoded = remote.meta;
    if (rebaseMeta && raw.meta instanceof Uint8Array) {
      try {
        meta = (await rebaseMeta(id, raw.meta as Bytes, remote.meta)) ?? remote.meta;
      } catch {
        // Unreadable either side: the remote version stands on its own.
      }
    }
    const keepLocal = meta !== remote.meta;

    await repo.putRawNote({
      id,
      meta,
      body: remote.body,
      // A fresh stamp for a merged meta, so the push that carries it cannot be
      // mistaken for the remote write it was merged onto (lost-ack check above).
      updatedAt: keepLocal ? Math.max(Date.now(), remote.updatedAt + 1) : remote.updatedAt,
      revision: raw.revision + 1,
      deleted: false,
    });
    await saveSyncState(repo, id, withBodySeal({ base: remote.revision, baseBytes: remoteBytes(remote) }, remote.body));
    appliedLocally = true;

    if (keepLocal) {
      // The entry stays: it now stands for the merged meta. Only a successful
      // push clears the streak, so a note that keeps losing still parks.
      await repo.enqueue(id, 'note');
      return;
    }
    conflictStreak.delete(id);
    await repo.dequeue(id, token);
  }

  /** Returns true when entries were left unattempted and a cycle is owed. */
  async function push(): Promise<boolean> {
    const queue = await repo.queued();
    pendingCount = queue.length;
    reportPending();
    if (queue.length === 0) return false;

    const page = queue.slice(0, PUSH_PAGE);
    const deferred = queue.length > page.length;

    let firstFailure: unknown;
    for (const entry of page) {
      if (stopped || !online()) return true;
      try {
        await pushOne(entry);
      } catch (error) {
        // Whether to keep going turns on whether the *next* entry could do
        // any better.
        //
        // It cannot when the failure is about the connection or the session:
        // the backend is unreachable or will refuse everything, so working
        // through the rest of the queue only produces the same error N times.
        // Rethrowing leaves every entry queued, which is what makes an
        // offline burst resume intact.
        //
        // It can when the failure is about *this record* — a legacy
        // unencrypted one, say. Letting that throw out of an oldest-first
        // loop meant everything behind it went unattempted, and permanently:
        // nothing parked it, so every cycle threw at the same entry and the
        // notes queued after it were never sent again. Park the offender,
        // carry on, and still report the failure afterwards so status and
        // backoff stay honest.
        if (
          error instanceof SessionExpiredError ||
          error instanceof SyncNotApprovedError ||
          error instanceof TransientSyncError
        ) {
          throw error;
        }
        parked.add(entry.id);
        firstFailure ??= error;
      }
      pendingCount = Math.max(0, pendingCount - 1);
      reportPending();
    }
    if (firstFailure !== undefined) throw firstFailure;
    return deferred;
  }

  // --- pull ----------------------------------------------------------------

  /** Returns whether anything was actually written. */
  async function applyRemoteNote(remote: RemoteNote): Promise<boolean> {
    // The wire revision counts accepted backend writes, so anything at or below
    // what we already recorded is our own write echoing back, or a page we have
    // seen before. This is the precise echo filter; the adapter's
    // `hasPendingWrites` check only covers the window before the server acks.
    const state = await loadSyncState(repo, remote.id);
    if (state && remote.revision <= state.base) return false;

    // Local edits not pushed yet. Taking the remote version now would discard
    // text the user has typed; leaving it lets the push decide, and a genuine
    // divergence still preserves both sides. Record the sighting, or a note
    // with no anchor yet would bootstrap straight over this change.
    if (await repo.isQueued(remote.id)) {
      await saveSyncState(repo, remote.id, { ...(state ?? { base: 0 }), seen: remote.revision });
      return false;
    }

    const local = await repo.loadRawNote(remote.id);

    // No anchor and a local copy that is ahead: this note has never been
    // pushed by the rebasing code, so its local revision is still the only
    // evidence available and the old rule is the only safe one. Notes stuck in
    // the duplicate loop sit at a local revision far past the backend's, and
    // adopting the remote here would roll them back to where they froze.
    if (!state && local && local.revision >= remote.revision) return false;

    // Deleted on another device. This device's copy of the text is about to go;
    // keep it in history first, so Recently deleted works here even offline and
    // even if the deleting device kept no version of its own.
    if (remote.deleted && local && !local.deleted && local.body !== undefined) {
      try {
        await (await loadHistory())?.mirror(local);
      } catch {
        // Best-effort: the delete still applies.
      }
    }

    await repo.putRawNote({
      id: remote.id,
      meta: remote.meta,
      body: remote.body,
      updatedAt: remote.updatedAt,
      // The stored revision stays a local counter, and stays monotonic: the
      // crash journal and the editor's "has this note changed" check both
      // read it, and both break if it can go backwards.
      revision: (local?.revision ?? 0) + 1,
      deleted: remote.deleted,
    });
    await saveSyncState(
      repo,
      remote.id,
      withBodySeal({ base: remote.revision, baseBytes: remoteBytes(remote) }, remote.body),
    );
    return true;
  }

  /**
   * Merge one remote folder. Returns whether anything was actually written.
   *
   * Folders carry no revision and get no compare-and-swap — there is no user
   * text in one to lose, only a name and a parent — so `updatedAt` is the whole
   * of the ordering and the later write wins.
   *
   * The earlier rule was `!local || folder.deleted`, which wrote only when the
   * folder was absent or was a tombstone, and so discarded every remote
   * *update* to a folder this device already had. That was invisible while
   * folders could only be created and deleted; it drops renames and reparents
   * silently the moment either exists.
   */
  async function applyRemoteFolder(folder: RemoteFolder): Promise<boolean> {
    // Whatever happens to the local copy, this is what the backend now holds,
    // and so what the next push of this folder replaces.
    await saveFolderBytes(repo, folder.id, folder.data.byteLength);
    const local = await repo.loadRawFolder(folder.id);

    if (!local) {
      await repo.putRawFolder(folder);
      return true;
    }

    // A tombstone wins outright, and a local deletion stands: a deletion is an
    // explicit act, and neither side of it should be undone by a copy that had
    // not heard about it yet.
    if (folder.deleted) {
      if (local.deleted) return false;
      await repo.putRawFolder(folder);
      return true;
    }
    if (local.deleted) return false;

    // Local changes not pushed yet, exactly as `applyRemoteNote` treats a
    // queued note: taking the remote version now would discard a rename the
    // user has made, and the push is about to settle it either way.
    if (await repo.isQueued(folder.id)) return false;

    // Strictly newer, so this device's own write echoing back is a no-op.
    // Reporting a change for an echo would cost a full metadata reload and a
    // search-index rebuild on every cycle that returned a folder.
    if (folder.updatedAt <= (local.updatedAt ?? local.createdAt)) return false;

    await repo.putRawFolder(folder);
    return true;
  }

  async function pull(): Promise<boolean> {
    let cursor = await loadCursor();
    let changed = false;

    for (;;) {
      const result = await adapter.pull(cursor, PULL_PAGE);
      if (result.notes.length === 0 && result.folders.length === 0) {
        if (result.cursor !== cursor) await repo.set(CURSOR_KEY, result.cursor);
        break;
      }

      for (const remote of result.notes) {
        // Only when something was written. Reporting a change for every note in
        // the page costs a full metadata reload and a search-index rebuild on
        // what is usually this device's own write coming back.
        if (await applyRemoteNote(remote)) changed = true;
      }

      for (const folder of result.folders) {
        if (await applyRemoteFolder(folder)) changed = true;
      }

      // A page that reports more to come but does not move the cursor would
      // be refetched forever. That needs a document whose `syncedAt` does not
      // parse, which the rules make unreachable for app writes — but the loop
      // is cheap to make unconditionally terminating, and a spin here would
      // hammer the backend with no way for the user to stop it.
      const advanced = result.cursor !== cursor;
      cursor = result.cursor;
      await repo.set(CURSOR_KEY, cursor);
      if (!result.hasMore || !advanced) break;
    }

    return changed;
  }

  // --- orchestration -------------------------------------------------------

  async function runSync(): Promise<void> {
    if (stopped) return;
    if (!isLeader) return;
    // A dead session stays dead until the user signs in again, which builds a
    // new engine. Without this latch every debounce and checkpoint would
    // re-attempt and re-notify.
    if (sessionDead) return;
    if (!adapter.user) {
      setStatus('idle');
      return;
    }
    if (!online()) {
      setStatus('offline');
      // Keep the queue; `online` will retry it.
      await refreshPending();
      return;
    }

    running = true;
    clearTimers();
    setStatus('syncing');
    appliedLocally = false;
    storageFull = false;
    retryHeldForSpace();
    retryHeldForLimit();
    try {
      await beforeSync?.();
      await bindAccount();
      const deferred = await push();
      pushDeferred = deferred;
      // Passengers: only on a cycle whose notes are all sent, and never a
      // reason for another one. See "Note versions" above.
      if (!deferred) await pushVersions();
      const changed = (await pull()) || appliedLocally;
      await refreshPending();
      failureStreak = 0;
      // A paged push leaves work behind. Say 'syncing' rather than 'error':
      // nothing has gone wrong, there is simply more to send, and the next
      // cycle is already armed below.
      if (deferred) setStatus('syncing');
      else setStatus(pendingCount > 0 ? 'error' : 'idle');
      // Push and pull have both returned, so whatever the account held is now
      // in the local database. Told to the other tabs as well as this one.
      tabs?.post({ type: 'synced' });
      fireFirstSync();
      if (changed) {
        onRemoteChange?.();
        // The other tabs share this database and have just been overtaken by
        // it; tell them to reload rather than let them show stale text.
        tabs?.post({ type: 'changed' });
      }
    } catch (error) {
      await refreshPending();
      failureStreak += 1;

      if (error instanceof SyncNotApprovedError) {
        // A cost lockdown refuses everyone with the same code, so ask the one
        // question that separates the two before believing it (`./pause.ts`).
        // One read, once per engine: the latch below means it is not repeated.
        const verdict = adapter.probePause ? await adapter.probePause().catch(() => 'unknown' as const) : 'running';
        if (verdict === 'paused') {
          // The same latch, and the same reason for it — retrying against
          // rules that refuse everything only spends money the lockdown
          // exists to save. The listener goes too: it is refused as well, and
          // a fresh engine opens a new one when the pause ends.
          sessionDead = true;
          setStatus('paused');
          clearTimers();
          unsubscribe?.();
          unsubscribe = undefined;
          onPaused?.();
          return;
        }
        if (verdict === 'unknown') {
          // The refusal is real but what it means is not known yet, and the
          // two answers are far apart: one is a calm "paused", the other may
          // sign the account out. Decide nothing; the backstop asks again.
          setStatus('offline');
          return;
        }
        // Same latch as an expired session, different cause and different
        // advice: the credential is fine, the authorisation is not, so
        // "sign in again" would be wrong. Everything stays queued, so the
        // work drains by itself if the account is later approved.
        sessionDead = true;
        setStatus('not-approved');
        clearTimers();
        // This account will never tell us what it holds, so stop anything
        // waiting to hear. The device behaves as local-only until approval.
        fireFirstSync();
        onNotApproved?.();
        return;
      }

      if (error instanceof SessionExpiredError) {
        sessionDead = true;
        // Retrying cannot fix this, so stop trying. Everything stays queued
        // and the notes stay fully editable — §17 is explicit that the editor
        // must not be disabled because the backend is unhappy.
        setStatus('signed-out');
        clearTimers();
        fireFirstSync();
        onSessionExpired?.();
        return;
      }

      // Offline and backend-unavailable are the same thing to a user: the
      // work is safe locally and will go when the network returns.
      setStatus(error instanceof TransientSyncError || !online() ? 'offline' : 'error');
    } finally {
      running = false;
      if (retryable) scheduleCheckpoint();
      // Nothing worth retrying means nothing would arm a timer at all, which
      // left the listener with no way back if it stopped talking.
      else scheduleBackstop();
      // Come straight back for the rest of a paged queue instead of waiting out
      // the idle debounce per page — at 200 to a page, that delay is the
      // difference between a backfill taking minutes and taking hours.
      if (pushDeferred && !stopped) {
        pushDeferred = false;
        void syncNow();
      }
    }
  }

  /** Serialise: never let two syncs interleave against the same store. */
  function syncNow(): Promise<void> {
    chain = chain.then(runSync, runSync).catch(() => {});
    return chain;
  }

  const onOnline = () => {
    failureStreak = 0;
    void syncNow();
  };
  const onOffline = () => setStatus('offline');

  return {
    async start() {
      stopped = false;
      if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
      }

      // An injected coordinator (tests) gets a silent channel: a real one would
      // put every test engine in the worker on the same bus.
      let channel = sharedChannel;
      if (!channel) {
        channel = createCoordinator === createTabCoordinator ? createTabChannel() : nullTabChannel();
        ownChannel = channel;
      }
      tabs = createCoordinator({
        channel,
        onBecomeLeader: () => {
          isLeader = true;
          // Both steps go onto the shared chain, and the sync is enqueued
          // synchronously. Doing the setup in a detached async function and
          // only then calling `syncNow` left the ordering up to how many awaits
          // the setup happened to contain: a caller that synced right after
          // `start()` resolved could land *before* the leader's own first
          // sync, which silently reordered the first push against the first
          // pull.
          chain = chain
            .then(async () => {
              await applyEpoch();
              const cursor = await loadCursor();
              // `stop()` can land inside either await above. Without this
              // check the subscription would be created *after* teardown
              // cleared it, leaving a listener calling `syncNow` on a stopped
              // engine with nothing holding its unsubscribe. Both `lockNow()`
              // and signing out reach that window.
              if (stopped) return;
              // Only the leader subscribes, so a dozen open tabs cost one
              // listener rather than a dozen.
              unsubscribe = adapter.subscribe(cursor, () => void syncNow());
            })
            .catch(() => {});
          void syncNow();
        },
        onMessage: (message) => {
          if (message.type === 'local') {
            // Another tab wrote to the database we share. Reloading this tab's
            // list is the workspace's job, not ours — it has to happen with no
            // engine at all. What is ours is the backend: if we own the
            // connection, send it. Through the
            // schedulers rather than straight to `syncNow`: this arrives on
            // every write-scheduler drain in the other tab, and answering each
            // one immediately put a sibling's typing outside the idle debounce,
            // the ceiling and the failure backoff all at once — one full
            // push-and-pull per keystroke burst, which is the cadence this
            // module's header exists to prevent.
            if (isLeader) {
              if (message.immediate) scheduleNudge();
              else scheduleCheckpoint();
            }
          } else if (message.type === 'resync') {
            // A sibling was looked at again. Its own `syncNow` cannot reach
            // the backend, and this tab may be hidden with its backstop
            // stretched. On the nudge, so a focus and a visibilitychange from
            // one tab — or several tabs at once — coalesce into one cycle.
            if (isLeader) scheduleNudge();
          } else if (message.type === 'changed') {
            // The leader wrote remote changes underneath us.
            if (!isLeader) onRemoteChange?.();
          } else if (message.type === 'synced') {
            // The leader finished a cycle, so the account's contents are in
            // the shared database now — true for this tab as much as for it.
            if (!isLeader) fireFirstSync();
          }
        },
      });

      // Wait for the role to settle. Without this, `start()` resolved before
      // leadership was known and the very first sync silently did nothing —
      // the queue then sat until a debounce or a remote event happened to
      // fire. A follower settles on a short grace period rather than waiting
      // for a lock it will not get.
      await tabs.ready;

      // A follower still reports pending work, so its status line is honest.
      await refreshPending();
    },

    stop() {
      stopped = true;
      isLeader = false;
      clearTimers();
      tabs?.stop();
      tabs = undefined;
      ownChannel?.close();
      ownChannel = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    },

    async queueNote(id, immediate = false) {
      // A fresh edit earns a parked note one more attempt. The streak is not
      // reset with it, so a push that still cannot succeed parks again
      // immediately rather than making a second copy.
      parked.delete(id);
      await repo.enqueue(id, 'note');
      await refreshPending();
      // Siblings are told by the workspace, which announces every write with or
      // without an engine. Not from the schedulers either way: those also run
      // on the retry path, where nothing new has been written.
      if (immediate) scheduleNudge();
      else scheduleCheckpoint(id);
    },

    async queueFolder(id, immediate = false) {
      // Same bargain as `queueNote`: a fresh rename earns a parked folder one
      // more attempt. Nothing resets the breaker otherwise, and a folder that
      // failed to push once would stay unsynced for the life of the session.
      parked.delete(id);
      await repo.enqueue(id, 'folder');
      await refreshPending();
      if (immediate) scheduleNudge();
      else scheduleCheckpoint();
    },

    syncNow() {
      // A follower owns no backend connection, so its request goes to the tab
      // that does. Here rather than in the internal `syncNow`, which also runs
      // for `online` — every tab hears that one itself.
      if (!isLeader && tabs && !stopped) tabs.post({ type: 'resync' });
      return syncNow();
    },

    get role() {
      return tabs?.role ?? 'follower';
    },

    get status() {
      return running ? 'syncing' : status;
    },

    get pendingCount() {
      return pendingCount;
    },
  };
}

/** Record which body `base` refers to, when the body is known. */
function withBodySeal(state: NoteSyncState, body: Encoded | undefined): NoteSyncState {
  const seal = body instanceof Uint8Array ? sealIdOf(body) : null;
  return seal ? { ...state, bodySeal: seal } : state;
}

/** True only when the stored body is provably the one the backend agreed to. */
function isUnchangedBody(body: Encoded | undefined, bodySeal: string | undefined): boolean {
  if (bodySeal === undefined || !(body instanceof Uint8Array)) return false;
  return sealIdOf(body) === bodySeal;
}
