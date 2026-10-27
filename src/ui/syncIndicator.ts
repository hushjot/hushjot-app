/**
 * What the top-bar sync indicator shows.
 *
 * Pure, and kept apart from the component for the same reason `viewMode.ts`
 * is: the rules are unit-testable without a rune harness.
 *
 * - **Reads engine transitions, never keystrokes.** Every input changes on a
 *   status change or a write-scheduler drain, so the indicator adds nothing to
 *   the typing path (§7, §33.4).
 * - **Pending is not syncing.** While someone types, the queue is non-empty
 *   almost continuously and a cycle runs every ~3 s. Spinning for all of that
 *   would be a permanent animation; a still dot says "waiting" and the spinner
 *   is reserved for a cycle actually in flight.
 * - **`holdingSpin` exists because cycles are fast.** A cycle of a few tens of
 *   milliseconds would blink the spinner; the component keeps it up for a
 *   minimum and says so through this flag.
 * - **Offline before error**, matching `saveState` in `App.svelte`: an
 *   unreachable network is the more specific reading of the same failure.
 * - **The latched states get a badge, not a sentence.** Session expiry and
 *   non-approval already raise banners that say what to do.
 * - **A pause is not a fault.** A cost lockdown (`core/sync/pause.ts`) refuses
 *   every client with the same code non-approval gets, so it is told apart
 *   before this runs and wins over "needs a plan": a paying user must never
 *   read their plan as lapsed because the service is paused. Calm colour, no
 *   warning mark — nothing is wrong with the account and nothing is lost.
 */
import type { SyncStatus } from '../core/sync/engine.ts';

export type SyncIndicatorKind =
  | 'unavailable'
  | 'signed-out'
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'attention'
  | 'paused';

export interface SyncIndicatorInput {
  available: boolean;
  signedIn: boolean;
  status: SyncStatus;
  pending: number;
  sessionExpired: boolean;
  notApproved: boolean;
  /** Sync is paused for everyone (a cost lockdown). */
  paused?: boolean;
  /** Changes waiting because the account's storage is full. */
  storageFull?: number;
  /** Changes waiting because the account has used its daily pushes. */
  pushLimited?: number;
  /** True while the component is holding a just-finished spin on screen. */
  holdingSpin?: boolean;
}

export interface SyncIndicatorState {
  kind: SyncIndicatorKind;
  label: string;
  /** Badge text, or null when there is nothing to count. */
  count: string | null;
}

export function formatPendingCount(pending: number): string | null {
  if (pending <= 0) return null;
  return pending > 99 ? '99+' : String(pending);
}

function changes(pending: number): string {
  return pending === 1 ? '1 change' : `${pending} changes`;
}

export function syncIndicatorState(input: SyncIndicatorInput): SyncIndicatorState {
  const { available, signedIn, status, pending, sessionExpired, notApproved, holdingSpin } = input;
  const storageFull = input.storageFull ?? 0;
  const pushLimited = input.pushLimited ?? 0;
  const count = formatPendingCount(pending);

  if (!available) return { kind: 'unavailable', label: 'Sync is not configured', count: null };
  if (input.paused && signedIn) return { kind: 'paused', label: 'Sync paused', count };
  if (notApproved) return { kind: 'attention', label: 'Sync needs a plan', count: null };
  if (sessionExpired) return { kind: 'attention', label: 'Session expired — sign in again', count: null };
  if (!signedIn) return { kind: 'signed-out', label: 'Not signed in — notes stay on this device', count: null };

  if (status === 'offline') {
    return {
      kind: 'offline',
      label: pending > 0 ? `Offline — ${changes(pending)} saved on this device` : 'Offline',
      count,
    };
  }
  // Ahead of 'syncing' and 'error': the cycle runs and fails the same way each
  // time until space is freed, and "retrying" would promise something that
  // will not happen on its own.
  if (storageFull > 0) {
    return { kind: 'attention', label: `Sync storage full — ${changes(storageFull)} waiting`, count };
  }
  // The same reasoning, for the daily push limit: nothing retries until the
  // day rolls over, so say that rather than "retrying".
  if (pushLimited > 0) {
    return { kind: 'attention', label: `Daily sync limit reached — ${changes(pushLimited)} waiting`, count };
  }
  if (status === 'syncing' || holdingSpin) {
    return { kind: 'syncing', label: pending > 0 ? `Syncing ${changes(pending)}…` : 'Syncing…', count };
  }
  if (status === 'error') return { kind: 'error', label: 'Sync failed — retrying', count };
  if (pending > 0) return { kind: 'pending', label: `${changes(pending)} waiting to sync`, count };
  return { kind: 'synced', label: 'Synced — all changes uploaded', count: null };
}
