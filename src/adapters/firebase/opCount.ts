/**
 * A tally of billed Firestore operations, for the benchmarks.
 *
 * An earlier estimate priced the backend from a model of the sync
 * cadence, and a model is only as good as the guess about which calls happen.
 * This counts the calls that actually happen, at the one seam every Firestore
 * request passes through, so `bench:phase4` and `bench:phase5` can say what a
 * session costs.
 *
 * It counts what Firestore *bills*, not what the SDK sends, because those
 * differ in the places that matter:
 *
 * - a query that returns nothing is still one read;
 * - a listener is billed for its result set when it attaches and one read per
 *   changed document after that, not per snapshot;
 * - every request under `/users/{uid}` runs `approved()` in `firestore.rules`,
 *   whose allowlist `exists()`/`get()` pair is one more billed read — the rules
 *   cache it within a request, not across requests. The allowlist document
 *   itself is read under a rule with no lookup, so that one costs nothing
 *   extra.
 *
 * It does not see requests the rules refuse outright (billed as their lookups
 * only), and it cannot see the emulator's own view of the bill, which does not
 * exist. Close enough to price a session; not an invoice.
 *
 * Installed only in emulator builds, on `window.__hushjotOps`. Production never
 * reaches `install`, and the whole module lives in the lazy adapter chunk, so
 * it costs the critical path nothing.
 *
 * Every count is also forwarded to `window.__hushjotOpsSink` when something has
 * put one there — the benches do, with Playwright's `exposeBinding`. A tally
 * held only in the page dies with every reload and every closed tab, and the
 * scenarios that matter most do both.
 */

export type OpCause =
  | 'pull'
  | 'push'
  | 'probe'
  | 'fetch'
  | 'listen'
  | 'keys'
  | 'allowlist'
  | 'entitlement'
  | 'versions'
  | 'shares'
  | 'usage'
  | 'lockdown';

export interface OpTally {
  reads: number;
  writes: number;
  /** The allowlist lookup inside `approved()`, one per request. */
  rulesReads: number;
  byCause: Record<OpCause, { reads: number; writes: number; rulesReads: number }>;
}

const empty = (): OpTally => ({
  reads: 0,
  writes: 0,
  rulesReads: 0,
  byCause: {
    pull: { reads: 0, writes: 0, rulesReads: 0 },
    push: { reads: 0, writes: 0, rulesReads: 0 },
    probe: { reads: 0, writes: 0, rulesReads: 0 },
    fetch: { reads: 0, writes: 0, rulesReads: 0 },
    listen: { reads: 0, writes: 0, rulesReads: 0 },
    keys: { reads: 0, writes: 0, rulesReads: 0 },
    allowlist: { reads: 0, writes: 0, rulesReads: 0 },
    entitlement: { reads: 0, writes: 0, rulesReads: 0 },
    versions: { reads: 0, writes: 0, rulesReads: 0 },
    shares: { reads: 0, writes: 0, rulesReads: 0 },
    usage: { reads: 0, writes: 0, rulesReads: 0 },
    lockdown: { reads: 0, writes: 0, rulesReads: 0 },
  },
});

let tally: OpTally | undefined;

type Sink = (op: { cause: OpCause; reads: number; writes: number; rulesReads: number }) => void;
const sink = (): Sink | undefined =>
  (window as unknown as { __hushjotOpsSink?: Sink }).__hushjotOpsSink;

/** Start counting and expose the tally. Emulator builds only. */
export function install(): void {
  if (tally || typeof window === 'undefined') return;
  tally = empty();
  (window as unknown as { __hushjotOps: unknown }).__hushjotOps = {
    snapshot: (): OpTally => structuredClone(tally!),
    reset: () => {
      tally = empty();
    },
  };
}

/**
 * Record one request.
 *
 * `rulesChecked` is false only for the allowlist and entitlement reads, whose
 * rules do no lookup of their own.
 */
export function count(cause: OpCause, reads: number, writes: number, rulesChecked = true): void {
  if (!tally) return;
  const rulesReads = rulesChecked ? 1 : 0;
  tally.reads += reads;
  tally.writes += writes;
  tally.rulesReads += rulesReads;
  const entry = tally.byCause[cause];
  entry.reads += reads;
  entry.writes += writes;
  entry.rulesReads += rulesReads;
  sink()?.({ cause, reads, writes, rulesReads });
}

/** A listener's later snapshots: changed documents only, no rules lookup. */
export function countListenChanges(changes: number): void {
  if (!tally || changes === 0) return;
  tally.reads += changes;
  tally.byCause.listen.reads += changes;
  sink()?.({ cause: 'listen', reads: changes, writes: 0, rulesReads: 0 });
}
