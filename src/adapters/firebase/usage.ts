/**
 * The storage meter, Firestore side (`core/sync/usage.ts` has the why).
 *
 * Every write that changes what the account stores carries a second write in
 * the same batch: a merge into `users/{uid}/usage/current` that moves a counter
 * by a server-side `increment`. Same batch, because the rules can only check
 * the counter against the document when the two are one commit, and because a
 * counter moved for a write that then failed would be wrong forever.
 * `increment` rather than a value, so two devices writing at once both land
 * without either reading first.
 *
 * Every one of those commits is also one push against the daily limit: `pn`
 * is incremented, or — when `reset` is set because a refusal showed the window
 * full — `ws` is set to the server's time and `pn` to 1, which the rules accept
 * only once the old window is a day old by their own clock. The client never
 * decides from its clock whether a day has passed; it asks by trying.
 *
 * Cost: one more document write per push, and no reads. The meter is read only
 * when the account panel asks, and when a refused write needs explaining.
 */
import {
  doc,
  getDoc,
  increment,
  serverTimestamp,
  Timestamp,
  type Firestore,
  type WriteBatch,
} from 'firebase/firestore';

import {
  BASE_STORAGE_BYTES,
  PUSH_WINDOW_MS,
  USAGE_DOC,
  usageMonth,
  type Usage,
} from '../../core/sync/usage.ts';
import { count } from './opCount.ts';

export interface MeterChange {
  /** The `bytes` change, `meterDelta(new, old)`. */
  bytes?: number;
  /** History uploaded, as the version's `chargedBytes`. */
  history?: number;
  /** Links published. */
  shares?: number;
  /** Start a new push window instead of counting into the current one. */
  reset?: boolean;
}

const usageRef = (db: Firestore, uid: string) => doc(db, `users/${uid}/${USAGE_DOC}`);

/**
 * Add the meter's half of a write to `batch`. `lastDoc` names the document the
 * batch changes, relative to `users/{uid}`, so the rules can find it.
 */
export function meterInto(
  batch: WriteBatch,
  db: Firestore,
  uid: string,
  lastDoc: string,
  change: MeterChange,
): void {
  const month = usageMonth(Date.now());
  const data: Record<string, unknown> = { lastDoc, pushes: { [month]: increment(1) } };
  if (change.reset) {
    data.ws = serverTimestamp();
    data.pn = 1;
  } else {
    data.pn = increment(1);
  }
  if (change.bytes !== undefined) data.bytes = increment(change.bytes);
  if (change.history) data.hist = { [month]: increment(change.history) };
  if (change.shares) data.shares = { [month]: increment(change.shares) };
  batch.set(usageRef(db, uid), data, { merge: true });
}

/** Tally the meter write of a batch that committed. Its rules lookup is the batch's. */
export function countMeter(): void {
  count('usage', 0, 1, false);
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The meter and the allowance, read the way the rules read them: an absent
 * counter is zero, and an absent `storageBytes` is the base allowance.
 */
export async function readUsage(db: Firestore, uid: string): Promise<Usage> {
  const [meter, plan] = await Promise.all([
    getDoc(usageRef(db, uid)),
    getDoc(doc(db, `entitlements/${uid}`)),
  ]);
  count('usage', 1, 0);
  count('entitlement', 1, 0, false);
  const data = meter.data() ?? {};
  const month = usageMonth(Date.now());
  const quota = plan.data()?.storageBytes;
  const ws = data.ws;
  return {
    bytes: num(data.bytes),
    quota: typeof quota === 'number' && quota > 0 ? quota : BASE_STORAGE_BYTES,
    historyThisMonth: num((data.hist as Record<string, unknown> | undefined)?.[month]),
    sharesThisMonth: num((data.shares as Record<string, unknown> | undefined)?.[month]),
    windowStart: ws instanceof Timestamp ? ws.toMillis() : null,
    pushesInWindow: num(data.pn),
  };
}

/** When a full push window may be replaced, by the stored window's own start. */
export function windowRetryAt(usage: Usage): number | null {
  return usage.windowStart === null ? null : usage.windowStart + PUSH_WINDOW_MS;
}

/** The meter, or null when it cannot be read. Only ever used to explain a refusal. */
export async function readUsageQuietly(db: Firestore, uid: string): Promise<Usage | null> {
  try {
    return await readUsage(db, uid);
  } catch {
    return null;
  }
}
