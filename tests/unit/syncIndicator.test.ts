import { describe, it, expect } from 'vitest';
import { formatPendingCount, syncIndicatorState, type SyncIndicatorInput } from '../../src/ui/syncIndicator.ts';

const base: SyncIndicatorInput = {
  available: true,
  signedIn: true,
  status: 'idle',
  pending: 0,
  sessionExpired: false,
  notApproved: false,
};

const kind = (over: Partial<SyncIndicatorInput>) => syncIndicatorState({ ...base, ...over }).kind;

describe('sync indicator', () => {
  it('distinguishes no backend from nobody signed in', () => {
    expect(kind({ available: false, signedIn: false })).toBe('unavailable');
    expect(kind({ signedIn: false })).toBe('signed-out');
  });

  it('is synced only when idle with nothing queued', () => {
    expect(syncIndicatorState(base)).toEqual({
      kind: 'synced',
      label: 'Synced — all changes uploaded',
      count: null,
    });
    expect(kind({ pending: 2 })).toBe('pending');
  });

  it('spins for a cycle in flight, or while the component holds it', () => {
    expect(kind({ status: 'syncing' })).toBe('syncing');
    expect(kind({ holdingSpin: true })).toBe('syncing');
    expect(syncIndicatorState({ ...base, status: 'syncing', pending: 1 }).label).toBe('Syncing 1 change…');
  });

  it('puts offline ahead of the spinner hold and of error', () => {
    expect(kind({ status: 'offline', holdingSpin: true })).toBe('offline');
    expect(syncIndicatorState({ ...base, status: 'offline', pending: 3 })).toEqual({
      kind: 'offline',
      label: 'Offline — 3 changes saved on this device',
      count: '3',
    });
    expect(kind({ status: 'error' })).toBe('error');
  });

  it('flags the latched states even though the engine has gone', () => {
    expect(kind({ sessionExpired: true, signedIn: false })).toBe('attention');
    expect(kind({ notApproved: true })).toBe('attention');
  });

  it('caps the badge', () => {
    expect(formatPendingCount(0)).toBeNull();
    expect(formatPendingCount(99)).toBe('99');
    expect(formatPendingCount(100)).toBe('99+');
  });

  it('says storage is full rather than retrying, while changes wait for space', () => {
    expect(syncIndicatorState({ ...base, status: 'error', pending: 3, storageFull: 2 })).toEqual({
      kind: 'attention',
      label: 'Sync storage full — 2 changes waiting',
      count: '3',
    });
    // Offline still says offline: nothing can be sent either way.
    expect(kind({ status: 'offline', pending: 3, storageFull: 2 })).toBe('offline');
  });

  it('says the daily sync limit is reached, while changes wait for the day to roll over', () => {
    expect(syncIndicatorState({ ...base, status: 'error', pending: 4, pushLimited: 1 })).toEqual({
      kind: 'attention',
      label: 'Daily sync limit reached — 1 change waiting',
      count: '4',
    });
    // Full storage is the one the user can act on, so it is said first.
    expect(syncIndicatorState({ ...base, status: 'error', pending: 4, storageFull: 2, pushLimited: 4 }).label).toBe(
      'Sync storage full — 2 changes waiting',
    );
    expect(kind({ status: 'offline', pending: 3, pushLimited: 2 })).toBe('offline');
  });

  it('says sync is paused during a cost lockdown, never that a plan is needed', () => {
    // The refusal a lockdown produces is the one non-approval produces, and a
    // paying user reading "needs a plan" buys a second subscription.
    expect(syncIndicatorState({ ...base, status: 'idle', notApproved: true, paused: true })).toEqual({
      kind: 'paused',
      label: 'Sync paused',
      count: null,
    });
    expect(syncIndicatorState({ ...base, status: 'paused', pending: 2, paused: true }).count).toBe('2');
    // Signed out is signed out, paused or not.
    expect(kind({ signedIn: false, paused: true })).toBe('signed-out');
  });
});
