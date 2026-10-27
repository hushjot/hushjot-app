import { describe, it, expect } from 'vitest';
import { isFirstRun, firstRunReady } from '../../src/core/notes/firstRun.ts';

/**
 * The reported bug: a user cleared every note, then opened the app in a
 * private window on one machine and a normal window on another. Both seeded
 * "Welcome to HushJot" and "Scratch", and creating a folder produced a second
 * copy of each — real documents on the account, propagating to every device.
 *
 * Every case below is named after the situation that produced it, because the
 * cost of getting this wrong is content in a user's workspace they did not ask
 * for and cannot easily untangle.
 */

const eligible = (over: Partial<Parameters<typeof isFirstRun>[0]> = {}) =>
  isFirstRun({ liveNotes: 0, anyNoteRow: false, seededBefore: false, ...over });

const ready = (over: Partial<Parameters<typeof firstRunReady>[0]> = {}) =>
  firstRunReady({
    backendConfigured: true,
    authSettled: true,
    signedIn: true,
    firstSyncDone: true,
    ...over,
  });

describe('isFirstRun', () => {
  it('accepts a database that has never held a note', () => {
    expect(eligible()).toBe(true);
  });

  it('refuses a database with notes in it', () => {
    expect(eligible({ liveNotes: 3, anyNoteRow: true })).toBe(false);
  });

  it('refuses after the user deleted every note', () => {
    // Deletion tombstones rather than removes, and `loadAllMeta` hides
    // tombstones — so live notes are 0 while rows remain. Treating that as a
    // first run is what brought the seed notes back on the next reload.
    expect(eligible({ liveNotes: 0, anyNoteRow: true })).toBe(false);
  });

  it('refuses once the claim has been made, whatever the note count says', () => {
    expect(eligible({ seededBefore: true })).toBe(false);
    // Belt and braces: a claimed database stays claimed even if its rows were
    // cleared out from underneath us by something other than the app.
    expect(eligible({ seededBefore: true, anyNoteRow: false, liveNotes: 0 })).toBe(false);
  });
});

describe('firstRunReady', () => {
  it('writes immediately when there is no backend at all', () => {
    // Local-only is a supported mode, and nothing can arrive to contradict us.
    expect(ready({ backendConfigured: false, authSettled: false, signedIn: false, firstSyncDone: false })).toBe(true);
  });

  it('waits for auth before trusting "nobody is signed in"', () => {
    // `signedIn` is false before auth reports because nothing has answered,
    // not because there is no account. Acting on it is how a returning user
    // looked brand new and seeded a duplicate pair.
    expect(ready({ authSettled: false, signedIn: false, firstSyncDone: false })).toBe(false);
  });

  it('writes once auth reports no account', () => {
    expect(ready({ signedIn: false, firstSyncDone: false })).toBe(true);
  });

  it('waits for a signed-in device to find out what the account holds', () => {
    // The private-window case. The local database is empty; the account is not.
    expect(ready({ firstSyncDone: false })).toBe(false);
  });

  it('writes once a signed-in device has completed a cycle', () => {
    expect(ready()).toBe(true);
  });

  it('stays blocked for a signed-in device that is offline', () => {
    // Deliberate: an empty list with a "+ Note" button is one keystroke from
    // fixed, and a duplicated account is not (§25).
    expect(ready({ firstSyncDone: false })).toBe(false);
  });
});
