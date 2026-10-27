/**
 * The synced-storage counter: what it counts, where it lives, how a write moves it.
 *
 * Storage is the one thing an account can grow without bound and the one thing
 * that costs money every month it stays, so it is metered. Writes are the other
 * thing a modified client could run up, so they are counted too. The meter is
 * `users/{uid}/usage/current`, and every client that writes a note, a folder, a
 * version or a shared link moves it in the **same** atomic commit as the write.
 * That is the only way the rules can check it: they compare the counter's
 * change with the document's change and refuse the commit when the two differ.
 * A client cannot under-report, and two devices writing at once cannot lose an
 * update, because the change is a server-side `increment` rather than a value
 * someone read earlier.
 *
 * ## `bytes`: what is stored now
 *
 * What counts is the stored ciphertext, **charged at no less than 1 KiB per
 * document** (`MIN_CHARGED_BYTES`):
 *
 * - a note's `meta` plus `body` (a tombstone has no body);
 * - a folder's `data`.
 *
 * so one document counts `max(size, 1024)`, and a write moves the meter by
 * `max(new, 1024) - max(old, 1024)`, with an absent document counting 0
 * (`chargedBytes`, `meterDelta`). The minimum is the cost of the document
 * itself: Firestore bills every stored document for its name, its fields and
 * its index entries whatever its ciphertext weighs, so without a floor a
 * million empty notes would be free while costing real money every month. A
 * 1 GiB allowance therefore holds at most about a million documents.
 *
 * **A tombstone is charged the minimum too.** Deletion is a tombstone rather
 * than a hard delete (the rules refuse those, §16), so a deleted note stays a
 * stored document forever. Deleting a note frees everything above 1 KiB and
 * keeps the floor; the floor is never refunded, because the document is never
 * removed. Creating and deleting notes in a loop therefore fills the account,
 * which is the point.
 *
 * Field names, revisions and index entries are otherwise left out. Versions and
 * shared links are not in `bytes` at all. They expire by TTL, which runs no
 * rules, so a stored total of them could only ever go up. They are metered per
 * calendar month on upload instead, in `hist` (counted the same way, floor
 * included, one version per commit so the rules can see each one) and `shares`
 * (one per publish).
 *
 * The same definition is implemented in the billing API's recount (it stamps
 * `reconciledAt`) and in `private/recount-usage.mjs`. Change one and you must
 * change the others.
 *
 * ## `ws`/`pn`: pushes in the current day
 *
 * Every metered commit is one **push**, and an account may make at most
 * `DAILY_PUSH_LIMIT` of them per window of at least `PUSH_WINDOW_MS`. `ws` is
 * the window's start (a server timestamp) and `pn` the pushes made in it. A
 * commit either *increments* — `pn + 1`, `ws` unchanged, never past the limit —
 * or *resets* — `ws` set to the server's `request.time`, `pn` to 1, allowed only
 * when the stored window began more than 24 h earlier by the server's own clock
 * (or there is none yet). So no client clock is trusted anywhere: a client
 * always increments, and only when the meter it reads after a refusal says the
 * window is full does it try a reset, which the server either takes (a new day)
 * or refuses (`PushLimitError`, hold everything until `ws + 24 h`). The window
 * is fixed rather than sliding, so a burst straddling a reset can reach twice
 * the limit within 24 h; the bound is on the average, which is what the bill is.
 *
 * `pushes.{YYYYMM}` is the older monthly tally of the same commits, kept because
 * the admin dashboard reads it. The rules do not check it; `pn` is the limit.
 *
 * ## The wire, for a REST client
 *
 * One `:commit` with two writes: the note (a full replace, as always), then
 *
 * ```json
 * { "update": { "name": ".../users/{uid}/usage/current",
 *               "fields": { "lastDoc": { "stringValue": "notes/{id}" } } },
 *   "updateMask": { "fieldPaths": ["lastDoc"] },
 *   "updateTransforms": [
 *     { "fieldPath": "bytes", "increment": { "integerValue": "<meterDelta>" } },
 *     { "fieldPath": "pn", "increment": { "integerValue": "1" } },
 *     { "fieldPath": "pushes.`202610`", "increment": { "integerValue": "1" } } ] }
 * ```
 *
 * and for a reset, `"fieldPaths": ["lastDoc", "pn"]` with `pn` set to
 * `{ "integerValue": "1" }` in `fields` and a `ws` transform of
 * `{ "setToServerValue": "REQUEST_TIME" }` in place of the `pn` increment.
 *
 * The usage document is the one place a mask is right. It is a merge on purpose,
 * because no client holds all of it. `lastDoc` names the document this commit
 * changed, so the rules can find it: `notes/{id}`, `folders/{id}`,
 * `shares/{id}`, or `notes/{id}/versions/{versionId}` for a commit that uploads
 * a version (with or without that note's own write beside it). The month key is
 * quoted because a field path segment may not start with a digit.
 */
import type { Bytes } from '../crypto/bytes.ts';

/** The counter document, relative to `users/{uid}`. */
export const USAGE_DOC = 'usage/current';

/**
 * The allowance every plan includes, and what the rules assume when
 * `entitlements/{uid}.storageBytes` is absent (an invitee, or a plan written
 * before the field existed). Mirrors `BASE_STORAGE_BYTES` in the billing API.
 */
export const BASE_STORAGE_BYTES = 1024 * 1024 * 1024;

/** History uploads allowed per calendar month, in counted bytes. A typical month is a few MB. */
export const HISTORY_BYTES_PER_MONTH = 500 * 1000 * 1000;

/** Shared links that may be published per calendar month. */
export const SHARES_PER_MONTH = 100;

/**
 * The least one stored note, folder or version counts for, whatever its
 * ciphertext weighs: the per-document cost of storing it at all.
 */
export const MIN_CHARGED_BYTES = 1024;

/** Metered commits an account may make per push window. */
export const DAILY_PUSH_LIMIT = 20_000;

/** The shortest a push window lasts, by the server's clock. */
export const PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The account's meter as the account panel shows it. */
export interface Usage {
  /** Counted bytes stored now. */
  bytes: number;
  /** The allowance: `storageBytes` from the plan, or the base. */
  quota: number;
  /** History uploaded this month, in counted bytes. */
  historyThisMonth: number;
  /** Links published this month. */
  sharesThisMonth: number;
  /** When the current push window began (server clock, ms), or null if none has. */
  windowStart: number | null;
  /** Pushes made in that window. */
  pushesInWindow: number;
}

/** The monthly bucket a write falls in: `YYYYMM`, UTC, as the rules derive it. */
export function usageMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The raw ciphertext size of one stored note: `meta` plus `body`. */
export function countedNoteBytes(meta: Bytes | null | undefined, body: Bytes | null | undefined): number {
  return (meta?.length ?? 0) + (body?.length ?? 0);
}

/**
 * What a document of `size` raw ciphertext bytes counts for. Zero means "not
 * stored" — every stored note and folder has ciphertext — and counts nothing.
 */
export function chargedBytes(size: number): number {
  return size <= 0 ? 0 : Math.max(size, MIN_CHARGED_BYTES);
}

/**
 * How far a write moves `bytes`: the new document's charge minus the one it
 * replaces. Both sizes are raw (`countedNoteBytes`, or a folder's `data`), and
 * 0 for "absent". Positive only when the write grows the account.
 */
export function meterDelta(newSize: number, oldSize: number): number {
  return chargedBytes(newSize) - chargedBytes(oldSize);
}

/**
 * Whether a refused push is explained by the push window being full, from the
 * meter as read after the refusal. Says nothing about whether the window has
 * expired: only the server's clock may decide that, by taking or refusing a
 * reset.
 */
export function pushWindowFull(usage: Pick<Usage, 'pushesInWindow'>): boolean {
  return usage.pushesInWindow >= DAILY_PUSH_LIMIT;
}

/**
 * Raised when a write would take the account past its storage allowance.
 *
 * Distinct from `PayloadTooLargeError`, which is about one note, and from
 * `SyncNotApprovedError`, which is about the account. Here the note is fine and
 * so is the plan. The space is full, and freeing some or adding more fixes it.
 * Only writes that **grow** the stored total can raise it: shrinking or deleting
 * a note is always accepted, so a full account can always get back under.
 */
export class QuotaExceededError extends Error {
  constructor(
    readonly noteId: string,
    /** How much the refused write would have added. */
    readonly delta: number,
    /** What the account stores now, when it could be read. */
    readonly used: number | null,
    /** The allowance, when it could be read. */
    readonly quota: number | null,
  ) {
    super(`writing ${noteId} would add ${delta} bytes, over the account's storage allowance`);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Raised when a link cannot be published because this month's allowance of
 * links is used up. Links already published keep working; the count starts
 * again on the 1st (UTC).
 */
export class ShareLimitError extends Error {
  constructor() {
    super(
      `You have published ${SHARES_PER_MONTH} links this month, the most a month allows. ` +
        'Links you already shared keep working, and new ones can be made again from the 1st.',
    );
    this.name = 'ShareLimitError';
  }
}

/**
 * Raised when the account has made `DAILY_PUSH_LIMIT` pushes in the current
 * window and the server has refused to start a new one.
 *
 * Like `QuotaExceededError`, nothing is wrong with the change or the plan, and
 * nothing is lost: the change waits on the device and goes once the window
 * rolls over. `retryAt` is the window's start plus 24 h by the server's clock;
 * a device whose clock disagrees retries early or late, and an early retry is
 * simply refused again.
 */
export class PushLimitError extends Error {
  constructor(
    /** When a new window may begin (ms), or null when the meter could not say. */
    readonly retryAt: number | null,
  ) {
    super(
      `This account has synced ${DAILY_PUSH_LIMIT.toLocaleString('en-US')} changes in the last day, ` +
        'the most a day allows. Changes are kept on this device and sync once the day rolls over.',
    );
    this.name = 'PushLimitError';
  }
}
