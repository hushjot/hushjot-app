/**
 * When, if ever, to write first-run content.
 *
 * ## The bug this shape prevents
 *
 * The obvious test — "the note table is empty, so this must be a new user" —
 * is wrong twice over, and both failures were reported as duplicated notes.
 *
 * **It races the first pull.** Seeding runs during startup; sync starts after
 * it. So a device whose local database is empty but whose *account* is not — a
 * private window, cleared site data, a new browser, a new machine — wrote two
 * brand-new notes with fresh ids and then pulled the account's existing pair.
 * Nothing reconciles them: the engine merges by id, and these have different
 * ids, so the user ends up with two of everything on every device, forever.
 *
 * **It counts the wrong rows.** Deletion is a tombstone, not a removal, and
 * `loadAllMeta` hides tombstones — so "I deleted all my notes" also reads as
 * an empty database, and the seeds came back on the next reload.
 *
 * So eligibility asks about *raw* rows and a durable marker, and readiness is a
 * separate question: nothing is written until the account can no longer
 * surprise us. There is no local signal that says whether an account holds
 * notes — the only honest answer is to wait for a pull and look.
 *
 * Deliberately pure. This is the logic that decides whether a user's workspace
 * gains content it did not ask for, which makes it worth testing exhaustively,
 * and testing it means keeping it free of IndexedDB, Firebase and the DOM.
 */

export interface FirstRunEligibility {
  /** Live notes the user can see — `loadAllMeta().length`. */
  liveNotes: number;
  /** Any row at all in the note table, tombstones included. */
  anyNoteRow: boolean;
  /** The durable "this database has already had its first run" marker. */
  seededBefore: boolean;
}

/**
 * Has this database never held a note?
 *
 * A tombstone counts: it is the record of a note the user deleted, and
 * re-creating what they deleted is not a first run.
 */
export function isFirstRun(state: FirstRunEligibility): boolean {
  return state.liveNotes === 0 && !state.anyNoteRow && !state.seededBefore;
}

export interface FirstRunReadiness {
  /** False when no backend is configured at all — the app is local-only. */
  backendConfigured: boolean;
  /** Auth has reported once, so `signedIn` means something. */
  authSettled: boolean;
  signedIn: boolean;
  /**
   * A sync cycle has completed, so anything the account holds is now local.
   * Also set when the account cannot sync at all (session expired, not
   * approved) — those must not block first run forever.
   */
  firstSyncDone: boolean;
}

/**
 * Is it safe to write first-run content yet?
 *
 * With no backend there is nothing to wait for. With one, `signedIn` is
 * meaningless until auth has reported — reading it too early is how a returning
 * user looked like a brand-new one — and a signed-in device waits for a pull.
 *
 * Signed in, offline and empty therefore stays empty until the network returns.
 * That is the intended trade: an empty list with a "+ Note" button is something
 * the user can fix in one keystroke, and a duplicated account is not (§25).
 */
export function firstRunReady(gate: FirstRunReadiness): boolean {
  if (!gate.backendConfigured) return true;
  if (!gate.authSettled) return false;
  return !gate.signedIn || gate.firstSyncDone;
}
