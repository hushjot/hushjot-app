import { describe, it, expect } from 'vitest';
import {
  classifyOwner,
  shouldSweep,
  isSweepable,
  accountResetElsewhere,
  accountWasReset,
  classifyVault,
  keyRecordIsStale,
  type BackfillGate,
  type VaultBindingInput,
} from '../../src/core/sync/backfill.ts';
import {
  changePassphrase,
  createKeyRecord,
  serializeKeyRecord,
} from '../../src/core/crypto/keyRecord.ts';
import { generateRecoveryCode } from '../../src/core/crypto/recoveryCode.ts';

/**
 * Whether a device may upload the notes it already holds.
 *
 * Every case is named after the situation that produces it. Two of them are
 * unrecoverable if this logic is wrong — notes written into another user's
 * account cannot be deleted (the rules refuse deletes outright), and notes
 * sealed under a key that account cannot open are just as permanent — so the
 * table is walked exhaustively rather than sampled.
 */

const gate = (over: Partial<BackfillGate> = {}): BackfillGate => ({
  owner: 'adopt',
  vaultOwnsAccount: true,
  alreadySwept: false,
  ...over,
});

describe('classifyOwner', () => {
  it('treats an unclaimed database as one to adopt', () => {
    expect(classifyOwner(undefined, 'uid-a')).toBe('adopt');
  });

  it('recognises the account that already owns it', () => {
    expect(classifyOwner('uid-a', 'uid-a')).toBe('same');
  });

  it('flags a different account as foreign', () => {
    expect(classifyOwner('uid-a', 'uid-b')).toBe('foreign');
  });

  it('does not collapse "never bound" into "bound elsewhere"', () => {
    // Both mean "do not trust the sync state you find", but only one means
    // "throw it away". Collapsing them either skips a needed wipe or wipes a
    // first-time user's queue out from under them.
    expect(classifyOwner(undefined, 'uid-a')).not.toBe(classifyOwner('uid-b', 'uid-a'));
  });
});

describe('shouldSweep', () => {
  it('sweeps a local-only device signing in for the first time', () => {
    // The whole point: a month of local-only notes reaches the account.
    expect(shouldSweep(gate())).toBe(true);
  });

  it('refuses when the database belongs to a different account', () => {
    expect(shouldSweep(gate({ owner: 'foreign' }))).toBe(false);
  });

  it('refuses when this device is not the account it belongs to, even once bound', () => {
    expect(shouldSweep(gate({ owner: 'foreign', alreadySwept: false }))).toBe(false);
  });

  it('refuses when the account was set up with a different vault', () => {
    // Uploading here produces ciphertext no other device on the account can
    // open, and it cannot be deleted afterwards.
    expect(shouldSweep(gate({ vaultOwnsAccount: false }))).toBe(false);
  });

  it('waits while the vault answer is still unknown', () => {
    // Null is "not asked yet", not "no". Treating it as either a yes or a
    // settled no would upload too early or never.
    expect(shouldSweep(gate({ vaultOwnsAccount: null }))).toBe(false);
  });

  it('does not sweep twice', () => {
    expect(shouldSweep(gate({ alreadySwept: true }))).toBe(false);
  });

  it('sweeps an already-bound account that has not been swept', () => {
    // Signing out clears the marker with the rest of the sync state, so
    // signing back in re-sweeps — which is what catches edits made while
    // signed out.
    expect(shouldSweep(gate({ owner: 'same' }))).toBe(true);
  });
});

describe('isSweepable', () => {
  it('includes an encrypted record', () => {
    expect(isSweepable({ encoded: new Uint8Array([1, 2, 3]) })).toBe(true);
  });

  it('includes a tombstone, whose blob is still encrypted', () => {
    // A deletion that never reaches the backend comes back on the next pull,
    // bringing its notes with it (§16).
    expect(isSweepable({ encoded: new Uint8Array([]) })).toBe(true);
  });

  it('excludes a pre-vault plaintext record', () => {
    // `toRemote` refuses to upload these and the push breaker parks them,
    // which would hold "Waiting to sync" above zero permanently.
    expect(isSweepable({ encoded: '{"title":"readable"}' })).toBe(false);
  });

  it('excludes a record with no blob at all', () => {
    expect(isSweepable({ encoded: undefined })).toBe(false);
  });
});

/**
 * Is this device's vault the account's vault?
 *
 * The answer used to live in a variable in a Svelte component, which meant it
 * was re-derived from nothing on every page load: the device that had just
 * published the account's key record read it back, failed to recognise its own
 * handwriting, and concluded the vault was somebody else's. It then told the
 * user their passphrase was wrong and retired its own backfill.
 *
 * So the cases below are really two claims. `true` must survive a reload, a
 * sign-out and a dropped network — otherwise the bug is back. And `false` must
 * stay rare, because it is the only verdict that both stops the sweep for good
 * and puts a banner on the screen; everything that merely fails to find out has
 * to be `null`.
 */
const FAST = { name: 'argon2id', memoryKiB: 1024, iterations: 1, parallelism: 1 } as const;

async function aRecord() {
  const { record } = await createKeyRecord('pass', generateRecoveryCode(), FAST);
  return serializeKeyRecord(record) as unknown;
}

const vault = (over: Partial<VaultBindingInput> = {}): VaultBindingInput => ({
  boundAccount: undefined,
  uid: 'uid-a',
  remoteRecord: undefined,
  localRecord: null,
  adoptedThisSession: false,
  keyRecordDirty: false,
  ...over,
});

describe('classifyVault', () => {
  it('answers from the marker alone, asking the backend nothing', async () => {
    // The fix for the reported bug, and the reason the marker exists: a device
    // that has already settled this does not re-litigate it every page load,
    // and an offline one is not told its passphrase is wrong.
    const verdict = classifyVault(vault({ boundAccount: 'uid-a', remoteRecord: undefined }));
    expect(verdict).toEqual({ owns: true, bind: false, publish: false });
  });

  it('furnishes an account that has no vault yet', async () => {
    const mine = await aRecord();
    expect(classifyVault(vault({ remoteRecord: null, localRecord: mine }))).toEqual({
      owns: true,
      bind: true,
      publish: true,
    });
  });

  it('claims the vault it has just adopted', () => {
    expect(classifyVault(vault({ adoptedThisSession: true }))).toEqual({
      owns: true,
      bind: true,
      publish: false,
    });
  });

  it('heals a device that published or adopted before there was a marker', async () => {
    // The migration case: the account holds the very record this device holds.
    // Identical bytes are one record in two places — the one thing comparison
    // can establish.
    const mine = await aRecord();
    expect(
      classifyVault(vault({ remoteRecord: structuredClone(mine), localRecord: mine })),
    ).toEqual({ owns: true, bind: true, publish: false });
  });

  it('refuses when both sides hold records that cannot be shown to be one', async () => {
    const mine = await aRecord();
    const theirs = await aRecord();
    expect(classifyVault(vault({ remoteRecord: theirs, localRecord: mine }))).toEqual({
      owns: false,
      bind: false,
      publish: false,
    });
  });

  it('keeps the safety property: a different account is still not ours', async () => {
    const mine = await aRecord();
    const theirs = await aRecord();
    // Bound to someone else, and the record on this account is not ours. The
    // marker must not become a way to inherit a claim across accounts.
    expect(
      classifyVault(vault({ boundAccount: 'uid-b', remoteRecord: theirs, localRecord: mine })),
    ).toEqual({ owns: false, bind: false, publish: false });
  });

  it('rebinds when a different account turns out to hold this very record', async () => {
    // Only reachable when this device published to both, which makes the vault
    // genuinely both accounts'. Signing back and forth self-corrects.
    const mine = await aRecord();
    expect(
      classifyVault(vault({ boundAccount: 'uid-b', remoteRecord: structuredClone(mine), localRecord: mine })),
    ).toEqual({ owns: true, bind: true, publish: false });
  });

  it('says "not yet" rather than "no" when nobody could read the account', async () => {
    // Offline, or the read threw. `null` is retried next cycle; `false` latches
    // `backfillSettled` for the life of the engine. Collapsing the two is how
    // an unreachable backend became a permanent refusal.
    const mine = await aRecord();
    const verdict = classifyVault(vault({ remoteRecord: undefined, localRecord: mine }));
    expect(verdict.owns).toBeNull();
    expect(verdict.bind).toBe(false);
  });

  it('says "not yet" when the account has a vault and this device has none', async () => {
    // An adoption that has not happened, or a record that could not be read as
    // one. Telling a user their passphrase is wrong before they have chosen a
    // passphrase is worse than saying nothing.
    const theirs = await aRecord();
    expect(classifyVault(vault({ remoteRecord: theirs, localRecord: null })).owns).toBeNull();
  });

  it('never binds without a true, and never returns true without binding or being bound', async () => {
    // The durable marker and the live answer must not drift: anything that
    // claims ownership either wrote it down or was reading it back.
    const mine = await aRecord();
    const theirs = await aRecord();
    const cases: VaultBindingInput[] = [
      vault({ boundAccount: 'uid-a' }),
      vault({ adoptedThisSession: true }),
      vault({ remoteRecord: null, localRecord: mine }),
      vault({ remoteRecord: structuredClone(mine), localRecord: mine }),
      vault({ remoteRecord: theirs, localRecord: mine }),
      vault({ remoteRecord: theirs, localRecord: null }),
      vault({ remoteRecord: undefined, localRecord: mine }),
      vault({ boundAccount: 'uid-a', keyRecordDirty: true }),
      vault({ boundAccount: 'uid-b', remoteRecord: theirs, localRecord: mine, keyRecordDirty: true }),
      vault({ remoteRecord: undefined, localRecord: mine, keyRecordDirty: true }),
      vault({ remoteRecord: theirs, localRecord: null, keyRecordDirty: true }),
    ];
    for (const input of cases) {
      const verdict = classifyVault(input);
      if (verdict.bind) expect(verdict.owns).toBe(true);
      if (verdict.owns === true) expect(verdict.bind || input.boundAccount === input.uid).toBe(true);
      if (verdict.publish) expect(verdict.owns).toBe(true);
    }
  });
});

/**
 * The republish half.
 *
 * `VAULT_ACCOUNT_KEY` answers ownership once and then stops asking, which is
 * right, and meant a re-wrapped record was never uploaded again, which was not:
 * a passphrase changed on a bound device reached the account never. The flag is
 * the one thing that may reopen that branch, and it must reopen nothing else.
 */
describe('classifyVault, republishing a re-wrapped record', () => {
  it('publishes again when a bound device has re-wrapped its record', () => {
    expect(classifyVault(vault({ boundAccount: 'uid-a', keyRecordDirty: true }))).toEqual({
      owns: true,
      bind: false,
      publish: true,
    });
  });

  it('still decides that without asking the backend anything', async () => {
    // The local-first property of this branch is the reason it exists. A flag
    // that made it wait on a read would have undone the original fix.
    const verdict = classifyVault(
      vault({ boundAccount: 'uid-a', remoteRecord: undefined, keyRecordDirty: true }),
    );
    expect(verdict).toEqual({ owns: true, bind: false, publish: true });
  });

  it('does not rebind on a republish', () => {
    // The marker is already correct; rewriting it would read as a fresh claim.
    expect(classifyVault(vault({ boundAccount: 'uid-a', keyRecordDirty: true })).bind).toBe(false);
  });

  it('ignores the flag on a device bound to a different account', async () => {
    const mine = await aRecord();
    const theirs = await aRecord();
    expect(
      classifyVault(
        vault({ boundAccount: 'uid-b', remoteRecord: theirs, localRecord: mine, keyRecordDirty: true }),
      ),
    ).toEqual({ owns: false, bind: false, publish: false });
  });

  it('ignores the flag while nobody has read the account', async () => {
    const mine = await aRecord();
    expect(
      classifyVault(vault({ remoteRecord: undefined, localRecord: mine, keyRecordDirty: true }))
        .publish,
    ).toBe(false);
  });

  it('ignores the flag when the account has a vault and this device has none', async () => {
    const theirs = await aRecord();
    expect(
      classifyVault(vault({ remoteRecord: theirs, localRecord: null, keyRecordDirty: true })).publish,
    ).toBe(false);
  });

  it('still furnishes an empty account, dirty or not', async () => {
    const mine = await aRecord();
    expect(
      classifyVault(vault({ remoteRecord: null, localRecord: mine, keyRecordDirty: true })),
    ).toEqual({ owns: true, bind: true, publish: true });
  });
});

describe('keyRecordIsStale', () => {
  it('is true only when this device owns the record, owes nothing, and differs', async () => {
    const mine = await aRecord();
    const theirs = await aRecord();
    expect(
      keyRecordIsStale({
        ownsAccount: true,
        keyRecordDirty: false,
        localRecord: mine,
        remoteRecord: theirs,
      }),
    ).toBe(true);
  });

  it('is false while this device still owes a publish', async () => {
    // The difference is ours: we are the newer one, not the staler one.
    const mine = await aRecord();
    const theirs = await aRecord();
    expect(
      keyRecordIsStale({
        ownsAccount: true,
        keyRecordDirty: true,
        localRecord: mine,
        remoteRecord: theirs,
      }),
    ).toBe(false);
  });

  it('is false when the bytes match', async () => {
    const mine = await aRecord();
    expect(
      keyRecordIsStale({
        ownsAccount: true,
        keyRecordDirty: false,
        localRecord: mine,
        remoteRecord: structuredClone(mine),
      }),
    ).toBe(false);
  });

  it('is false when either record is missing, or the vault is not the account\'s', async () => {
    const mine = await aRecord();
    const theirs = await aRecord();
    const base = { ownsAccount: true, keyRecordDirty: false };
    expect(keyRecordIsStale({ ...base, localRecord: null, remoteRecord: theirs })).toBe(false);
    expect(keyRecordIsStale({ ...base, localRecord: mine, remoteRecord: null })).toBe(false);
    expect(keyRecordIsStale({ ...base, localRecord: mine, remoteRecord: undefined })).toBe(false);
    expect(
      keyRecordIsStale({ ...base, ownsAccount: false, localRecord: mine, remoteRecord: theirs }),
    ).toBe(false);
  });
});

describe('accountWasReset', () => {
  const mine = { v: 1, wrapped: 'mine' };

  it('is true when a device that owns the account finds no record there', () => {
    // Only a purge removes a key record: the rules refuse every client delete.
    expect(accountWasReset({ ownsAccount: true, localRecord: mine, remoteRecord: null })).toBe(true);
  });

  it('is false when nobody managed to look', () => {
    // Offline is not evidence. Republishing on a guess would be a write made
    // on the strength of a failed read.
    expect(accountWasReset({ ownsAccount: true, localRecord: mine, remoteRecord: undefined })).toBe(
      false,
    );
  });

  it('is false when the account still holds a record', () => {
    expect(
      accountWasReset({ ownsAccount: true, localRecord: mine, remoteRecord: structuredClone(mine) }),
    ).toBe(false);
    expect(
      accountWasReset({ ownsAccount: true, localRecord: mine, remoteRecord: { v: 1, wrapped: 'other' } }),
    ).toBe(false);
  });

  it('is false for a device that does not own the account, or has no vault', () => {
    expect(accountWasReset({ ownsAccount: false, localRecord: mine, remoteRecord: null })).toBe(false);
    expect(accountWasReset({ ownsAccount: true, localRecord: null, remoteRecord: null })).toBe(false);
  });
});

describe('accountResetElsewhere', () => {
  /**
   * A bound device asking whether its owner started over from another device.
   * Getting this wrong in the "false" direction undoes the reset — the device
   * republishes its old record over the tombstone, or seals notes into the new
   * vault under the old key — so the tombstone and the different-vault cases
   * are each pinned, as are the cases that must keep their old meaning.
   */
  async function recordAt(createdAt: number) {
    const { record } = await createKeyRecord('pass', generateRecoveryCode(), FAST, createdAt);
    return { record, serialized: serializeKeyRecord(record) as unknown };
  }

  it('is true when the account holds a tombstone', async () => {
    const mine = (await recordAt(1)).serialized;
    expect(
      accountResetElsewhere({ ownsAccount: true, localRecord: mine, remoteRecord: null, remoteResetAt: 99 }),
    ).toBe(true);
  });

  it('is true when the account holds a vault minted after this one', async () => {
    const mine = (await recordAt(1)).serialized;
    const next = (await recordAt(2)).serialized;
    expect(
      accountResetElsewhere({ ownsAccount: true, localRecord: mine, remoteRecord: next, remoteResetAt: null }),
    ).toBe(true);
  });

  it('is false for the same vault re-wrapped elsewhere — that is a passphrase change', async () => {
    const { record, serialized } = await recordAt(1);
    const rewrapped = serializeKeyRecord(await changePassphrase(record, 'pass', 'new', FAST)) as unknown;
    expect(
      accountResetElsewhere({
        ownsAccount: true,
        localRecord: serialized,
        remoteRecord: rewrapped,
        remoteResetAt: null,
      }),
    ).toBe(false);
  });

  it('leaves a missing key document to accountWasReset — a purge, not a reset', async () => {
    const mine = (await recordAt(1)).serialized;
    expect(
      accountResetElsewhere({ ownsAccount: true, localRecord: mine, remoteRecord: null, remoteResetAt: null }),
    ).toBe(false);
  });

  it('is false when nobody managed to look', async () => {
    const mine = (await recordAt(1)).serialized;
    expect(
      accountResetElsewhere({
        ownsAccount: true,
        localRecord: mine,
        remoteRecord: undefined,
        remoteResetAt: undefined,
      }),
    ).toBe(false);
  });

  it('is false for a device that does not own the account, or has no vault', async () => {
    const mine = (await recordAt(1)).serialized;
    expect(
      accountResetElsewhere({ ownsAccount: false, localRecord: mine, remoteRecord: null, remoteResetAt: 99 }),
    ).toBe(false);
    expect(
      accountResetElsewhere({ ownsAccount: true, localRecord: null, remoteRecord: null, remoteResetAt: 99 }),
    ).toBe(false);
  });

  it('is false for a record it cannot read', async () => {
    const mine = (await recordAt(1)).serialized;
    expect(
      accountResetElsewhere({
        ownsAccount: true,
        localRecord: mine,
        remoteRecord: { garbage: true },
        remoteResetAt: null,
      }),
    ).toBe(false);
  });
});
