/**
 * "Sync is paused": telling a cost lockdown apart from a refused account.
 *
 * The cost kill switch (`private/cost-monitoring.md`) replaces the Firestore
 * rules with a ruleset that refuses every client request. Every read and write
 * then fails with the same `permission-denied` an account with no plan gets,
 * and a client that reads it the ordinary way tells a paying user their plan
 * has lapsed, offers them a second subscription, lets a brand-new device mint a
 * second vault and seeds welcome notes that later duplicate. A refusal alone
 * cannot say which of the two it is.
 *
 * ## The sentinel
 *
 * One document path settles it: `LOCKDOWN_SENTINEL`. The lockdown ruleset
 * allows a `get` of it — and nothing else — and the normal rules have no match
 * for it, so their catch-all refuses it. The document does not exist and does
 * not need to: an allowed `get` of a missing document answers with an empty
 * snapshot (REST: 404), and a refused one with `permission-denied` (REST: 403).
 * So after a refusal, one read answers the question:
 *
 * - allowed → the lockdown is in place → **paused**: say so calmly, sign
 *   nobody out, treat nothing as "no plan", and wait;
 * - refused → the normal rules are live → the refusal meant what it said, and
 *   the existing not-approved handling applies unchanged;
 * - neither (offline, backend unhappy) → **unknown**, which decides nothing.
 *
 * Why a probe rather than a status document clients read on every start: the
 * probe costs nothing at all while things are normal, because it is only made
 * after a refusal, and normal refusals are rare (an account without a plan).
 * During a lockdown it is the one billable request a client makes, which is why
 * every caller probes after a refusal and then only on a slow timer.
 *
 * ## Waiting it out
 *
 * `createPauseWatch` is that slow timer: one probe every `PAUSE_POLL_MS` while
 * the tab is visible, and an immediate one when the caller says the user came
 * back (focus, visibility, the network returning), rate-limited by
 * `PAUSE_RECHECK_MIN_MS` so a user flicking between tabs is not a read per
 * flick. A hidden tab does not poll at all; coming back is what checks. When a
 * probe is refused again — the normal rules are back — it calls `onResume`
 * once and stops, and the caller restarts sync exactly as a reload would.
 *
 * Platform-free like the rest of `core/`: the caller supplies the probe (the
 * adapter's), the visibility test and the clock.
 */

/**
 * The document the lockdown ruleset lets anyone `get`. Shared with
 * `@hushjot/cli` and mirrored by `private/killswitch/lockdown.rules`, the share
 * viewer and the hushjot.com account page; `tests/rules/lockdown.test.ts`
 * checks it against both rulesets.
 */
export const LOCKDOWN_SENTINEL = 'status/lockdown';

/** What one probe of the sentinel said. See the module comment. */
export type PauseVerdict = 'paused' | 'running' | 'unknown';

/**
 * A refusal that a probe showed to be a lockdown, for a client that reports
 * errors by type (the CLI). Not an account problem and not the user's to fix:
 * nothing was written, and the same request works once sync resumes.
 */
export class SyncPausedError extends Error {
  constructor() {
    super('HushJot sync is paused for maintenance; try again later.');
    this.name = 'SyncPausedError';
  }
}

/** How often a visible device re-checks a pause. */
export const PAUSE_POLL_MS = 15 * 60_000;
/** The closest two probes may be, whatever asks for them. */
export const PAUSE_RECHECK_MIN_MS = 60_000;

export interface PauseWatchOptions {
  probe: () => Promise<PauseVerdict>;
  /** The normal rules are back. Called once; the watch has stopped by then. */
  onResume: () => void;
  isHidden?: () => boolean;
  pollMs?: number;
  minGapMs?: number;
  now?: () => number;
}

export interface PauseWatch {
  /** Arm the slow timer. The caller has just probed, so nothing is sent now. */
  start(): void;
  /** Probe now, unless one was made within `minGapMs`. Resolves when it has. */
  recheck(): Promise<void>;
  stop(): void;
  readonly active: boolean;
}

export function createPauseWatch(options: PauseWatchOptions): PauseWatch {
  const {
    probe,
    onResume,
    isHidden = () => false,
    pollMs = PAUSE_POLL_MS,
    minGapMs = PAUSE_RECHECK_MIN_MS,
    now = () => Date.now(),
  } = options;

  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastProbeAt = 0;
  let inFlight: Promise<void> | undefined;

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const arm = (): void => {
    disarm();
    if (!active) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Nobody is looking, so nobody is waiting: re-arm without spending a
      // read. Coming back to the tab calls `recheck`, which probes at once.
      if (isHidden()) arm();
      else void check();
    }, pollMs);
  };

  const check = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      lastProbeAt = now();
      let verdict: PauseVerdict;
      try {
        verdict = await probe();
      } catch {
        verdict = 'unknown';
      }
      if (!active) return;
      if (verdict === 'running') {
        active = false;
        disarm();
        onResume();
        return;
      }
      arm();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    start() {
      if (active) return;
      active = true;
      // The refusal that started this was followed by a probe of the caller's
      // own; count it, so a focus a moment later does not send another.
      lastProbeAt = now();
      arm();
    },
    recheck() {
      if (!active) return Promise.resolve();
      if (inFlight) return inFlight;
      if (now() - lastProbeAt < minGapMs) return Promise.resolve();
      return check();
    },
    stop() {
      active = false;
      disarm();
    },
    get active() {
      return active;
    },
  };
}
