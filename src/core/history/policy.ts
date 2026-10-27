/**
 * When a save should also keep the text it is about to replace.
 *
 * ## Sessions, not saves
 *
 * The write scheduler persists a note every 150 ms pause and at least every
 * 2 s while someone types. A version per save would be thousands a day, each
 * one keystroke from its neighbour — noise to scroll through, and storage for
 * nothing. What people reach for is "how this looked before I started on it
 * this morning", so a version is the note as it stood when an *editing
 * session* began:
 *
 * - **Session start.** The first save after `SESSION_GAP` of quiet (or the
 *   first this page has seen) keeps the stored text it overwrites. That is the
 *   end state of the previous session, which is the version worth having.
 * - **Checkpoint.** A long unbroken session is still cut every `CHECKPOINT`,
 *   so an afternoon of rewriting cannot leave only the morning's version.
 *
 * Deletes and restores are captured unconditionally by their callers; they do
 * not go through here.
 *
 * ## On the typing path? No
 *
 * `observe` runs on the write-scheduler drain, never per keystroke, and is two
 * map reads. It is the only part of history that ships eagerly; everything
 * that touches the history database is a lazy chunk.
 */

export const SESSION_GAP_MS = 5 * 60_000;
export const CHECKPOINT_MS = 10 * 60_000;

interface Seen {
  lastPersistAt: number;
  lastCaptureAt: number;
}

export class CaptureTracker {
  #seen = new Map<string, Seen>();
  readonly sessionGapMs: number;
  readonly checkpointMs: number;

  constructor(sessionGapMs = SESSION_GAP_MS, checkpointMs = CHECKPOINT_MS) {
    this.sessionGapMs = sessionGapMs;
    this.checkpointMs = checkpointMs;
  }

  /**
   * Record a save of `noteId` at `now`, returning whether the text it replaces
   * should be kept.
   */
  observe(noteId: string, now: number): boolean {
    const seen = this.#seen.get(noteId);
    const capture =
      !seen ||
      now - seen.lastPersistAt >= this.sessionGapMs ||
      now - seen.lastCaptureAt >= this.checkpointMs ||
      // A clock that went backwards: start over rather than never capturing again.
      now < seen.lastPersistAt;

    this.#seen.set(noteId, {
      lastPersistAt: now,
      lastCaptureAt: capture || !seen ? now : seen.lastCaptureAt,
    });
    return capture;
  }

  /** Forget everything, e.g. on lock. */
  clear(): void {
    this.#seen.clear();
  }
}
