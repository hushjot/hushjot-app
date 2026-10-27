/**
 * The `Vault` class itself, which had no test of its own until the re-wrap
 * flows were wired to the UI.
 *
 * `keyRecord.test.ts` covers the crypto one layer down; what is only testable
 * here is the bookkeeping around it — that a re-wrap reaches *storage* and the
 * in-memory `record` getter both (a stale getter is what `exportRecord()`
 * would publish to the account), that a failed re-wrap leaves the stored
 * record untouched rather than half-written, and that the new record is what
 * survives a lock and a reload.
 *
 * `memoryVaultStorage()` was exported "for tests" and referenced by nothing.
 */
import { describe, it, expect } from 'vitest';
import { Vault, memoryVaultStorage } from '../../src/core/crypto/vault.ts';
import {
  createKeyRecord,
  WrongSecretError,
  type KeyRecord,
} from '../../src/core/crypto/keyRecord.ts';
import { generateRecoveryCode } from '../../src/core/crypto/recoveryCode.ts';
import { sealText, openText } from '../../src/core/crypto/envelope.ts';
import { toBase64 } from '../../src/core/crypto/bytes.ts';
import { DEFAULT_ARGON2_PARAMS } from '../../src/core/crypto/kdf.ts';

// As in keyRecord.test.ts: the code path is identical and production
// parameters would cost this file a dozen 64 MiB derivations.
const FAST = { name: 'argon2id', memoryKiB: 1024, iterations: 1, parallelism: 1 } as const;

const PASSPHRASE = 'correct horse battery staple';
const NEXT = 'a completely different passphrase';

function newVault() {
  const storage = memoryVaultStorage();
  return { storage, vault: new Vault(storage, { params: FAST }) };
}

/** A vault with a note already sealed under its key. */
async function withNote() {
  const { storage, vault } = newVault();
  const { recoveryCode } = await vault.create(PASSPHRASE);
  const sealed = await sealText(vault.key, 'preserved');
  return { storage, vault, recoveryCode, sealed };
}

const bytesOf = (record: KeyRecord | undefined): string =>
  record ? toBase64(record.wrappedByPassphrase) + toBase64(record.wrappedByRecovery) : '';

describe('Vault.create', () => {
  it('stores the record and leaves the vault unlocked', async () => {
    const { storage, vault } = newVault();
    const { recoveryCode } = await vault.create(PASSPHRASE);

    expect(vault.state).toBe('unlocked');
    expect(vault.isUnlocked).toBe(true);
    expect(storage.record).toBeDefined();
    expect(recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
  });

  it('refuses to create over an existing record', async () => {
    // A fresh random DEK here orphans every note on the device and on the
    // account, with the user's correct passphrase opening the wrong key.
    const { vault } = newVault();
    await vault.create(PASSPHRASE);
    await expect(vault.create('another')).rejects.toThrow(/vault already exists/);
  });

  it('stamps the current parameters when given none', async () => {
    // The one case that pays a real derivation, so that plumbing `params` up
    // to a caller — and accidentally defaulting it — cannot pass unnoticed.
    const storage = memoryVaultStorage();
    await new Vault(storage).create(PASSPHRASE);
    expect(storage.record?.passphrase.memoryKiB).toBe(DEFAULT_ARGON2_PARAMS.memoryKiB);
    expect(storage.record?.passphrase.iterations).toBe(DEFAULT_ARGON2_PARAMS.iterations);
  });
});

describe('Vault.changePassphrase', () => {
  it('swaps which passphrase opens the vault, leaving the notes alone', async () => {
    const { vault, sealed } = await withNote();
    const before = toBase64(sealed);

    await vault.changePassphrase(PASSPHRASE, NEXT);
    await vault.lock();
    await vault.unlock(NEXT);

    expect(await openText(vault.key, sealed)).toBe('preserved');
    expect(toBase64(sealed)).toBe(before);
  });

  it('leaves the recovery code working', async () => {
    const { vault, recoveryCode, sealed } = await withNote();

    await vault.changePassphrase(PASSPHRASE, NEXT);
    await vault.lock();
    await vault.unlockWithRecovery(recoveryCode);

    expect(await openText(vault.key, sealed)).toBe('preserved');
  });

  it('rejects the old passphrase afterwards', async () => {
    const { vault } = await withNote();
    await vault.changePassphrase(PASSPHRASE, NEXT);
    await vault.lock();
    await expect(vault.unlock(PASSPHRASE)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('updates the record getter, not only storage', async () => {
    // `exportRecord()` publishes this getter. A stale one uploads the old wrap
    // and every other device goes on opening with the retired passphrase.
    const { storage, vault } = await withNote();

    await vault.changePassphrase(PASSPHRASE, NEXT);

    expect(bytesOf(vault.record)).toBe(bytesOf(storage.record));
  });

  it('leaves the stored record byte-identical when the current passphrase is wrong', async () => {
    // A partial re-wrap that reaches disk is a bricked vault, and nothing
    // above this layer could tell.
    const { storage, vault } = await withNote();
    const before = bytesOf(storage.record);

    await expect(vault.changePassphrase('not it', NEXT)).rejects.toBeInstanceOf(WrongSecretError);

    expect(bytesOf(storage.record)).toBe(before);
    expect(bytesOf(vault.record)).toBe(before);
  });

  it('survives a lock and a reload', async () => {
    const { storage, vault } = await withNote();
    await vault.changePassphrase(PASSPHRASE, NEXT);
    await vault.lock();

    const reloaded = new Vault(storage, { params: FAST });
    expect(await reloaded.initialize()).toBe('locked');
    await expect(reloaded.unlock(NEXT)).resolves.toBeUndefined();
  });

  it('refuses on a vault that has no record', async () => {
    const { vault } = newVault();
    await expect(vault.changePassphrase(PASSPHRASE, NEXT)).rejects.toThrow(/no vault/);
  });
});

describe('Vault.rotateRecoveryCode', () => {
  it('returns a new code, retires the old one and keeps the passphrase', async () => {
    const { vault, recoveryCode, sealed } = await withNote();

    const fresh = await vault.rotateRecoveryCode(PASSPHRASE);
    expect(fresh).not.toBe(recoveryCode);

    await vault.lock();
    await expect(vault.unlockWithRecovery(recoveryCode)).rejects.toBeInstanceOf(WrongSecretError);
    await vault.unlockWithRecovery(fresh);
    expect(await openText(vault.key, sealed)).toBe('preserved');

    await vault.lock();
    await expect(vault.unlock(PASSPHRASE)).resolves.toBeUndefined();
  });

  it('leaves the stored record untouched when the passphrase is wrong', async () => {
    const { storage, vault } = await withNote();
    const before = bytesOf(storage.record);

    await expect(vault.rotateRecoveryCode('not it')).rejects.toBeInstanceOf(WrongSecretError);
    expect(bytesOf(storage.record)).toBe(before);
  });
});

describe('Vault.setPassphraseWithRecoveryCode', () => {
  it('sets a new passphrase without ever being told the old one', async () => {
    const { vault, recoveryCode, sealed } = await withNote();

    await vault.lock();
    await vault.setPassphraseWithRecoveryCode(recoveryCode, NEXT);

    await vault.unlock(NEXT);
    expect(await openText(vault.key, sealed)).toBe('preserved');
  });

  it('leaves the vault locked', async () => {
    // It re-wraps the record; it does not open it. Typing the new passphrase
    // once is the only evidence anybody gets that it was saved.
    const { vault, recoveryCode } = await withNote();
    await vault.lock();

    await vault.setPassphraseWithRecoveryCode(recoveryCode, NEXT);

    expect(vault.state).toBe('locked');
    expect(vault.isUnlocked).toBe(false);
  });

  it('retires the old passphrase and keeps the recovery code', async () => {
    const { vault, recoveryCode } = await withNote();
    await vault.lock();

    await vault.setPassphraseWithRecoveryCode(recoveryCode, NEXT);

    await expect(vault.unlock(PASSPHRASE)).rejects.toBeInstanceOf(WrongSecretError);
    await expect(vault.unlockWithRecovery(recoveryCode)).resolves.toBeUndefined();
  });

  it('leaves the stored record untouched when the code is wrong', async () => {
    const { storage, vault } = await withNote();
    const before = bytesOf(storage.record);

    await expect(
      vault.setPassphraseWithRecoveryCode(generateRecoveryCode(), NEXT),
    ).rejects.toBeInstanceOf(WrongSecretError);
    expect(bytesOf(storage.record)).toBe(before);
  });

  it('completes the documented two-step recovery', async () => {
    // `docs/security.md`: lost the passphrase, have the code — set a new
    // passphrase, then re-issue the code in case it was seen.
    const { vault, recoveryCode, sealed } = await withNote();
    await vault.lock();

    await vault.setPassphraseWithRecoveryCode(recoveryCode, NEXT);
    await vault.unlock(NEXT);
    const fresh = await vault.rotateRecoveryCode(NEXT);

    await vault.lock();
    await expect(vault.unlockWithRecovery(recoveryCode)).rejects.toBeInstanceOf(WrongSecretError);
    await vault.unlockWithRecovery(fresh);
    expect(await openText(vault.key, sealed)).toBe('preserved');
  });
});

describe('Vault.replaceRecord', () => {
  /** The account's copy, re-wrapped elsewhere from the same underlying key. */
  async function accountCopy(vault: Vault): Promise<KeyRecord> {
    const elsewhere = new Vault(memoryVaultStorage(), { params: FAST });
    await elsewhere.adoptRecord(vault.record as KeyRecord);
    await elsewhere.unlock(PASSPHRASE);
    await elsewhere.changePassphrase(PASSPHRASE, NEXT);
    return elsewhere.record as KeyRecord;
  }

  it('adopts a record that provably wraps the same key', async () => {
    const { storage, vault, sealed } = await withNote();
    const theirs = await accountCopy(vault);

    expect(await vault.replaceRecord(theirs, NEXT)).toBe(true);

    expect(bytesOf(storage.record)).toBe(bytesOf(theirs));
    expect(await openText(vault.key, sealed)).toBe('preserved');
    await vault.lock();
    await expect(vault.unlock(NEXT)).resolves.toBeUndefined();
    await expect(vault.unlock(PASSPHRASE)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('refuses a record wrapping a different key, leaving this vault alone', async () => {
    // The anti-downgrade guard `adoptRecord` enforces by refusing outright.
    const { storage, vault, sealed } = await withNote();
    const before = bytesOf(storage.record);

    const stranger = await createKeyRecord(NEXT, generateRecoveryCode(), FAST);

    expect(await vault.replaceRecord(stranger.record, NEXT)).toBe(false);
    expect(bytesOf(storage.record)).toBe(before);
    expect(await openText(vault.key, sealed)).toBe('preserved');
  });

  it('refuses the wrong passphrase before it looks at the key at all', async () => {
    const { vault } = await withNote();
    const theirs = await accountCopy(vault);

    await expect(vault.replaceRecord(theirs, 'not it')).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('refuses on a locked vault', async () => {
    const { vault } = await withNote();
    const theirs = await accountCopy(vault);
    await vault.lock();

    await expect(vault.replaceRecord(theirs, NEXT)).rejects.toThrow(/vault is locked/);
  });

  it('keeps the remembered device key in step', async () => {
    const { storage, vault } = await withNote();
    const theirs = await accountCopy(vault);

    expect(await storage.loadDeviceKey()).toBeDefined();
    expect(await vault.replaceRecord(theirs, NEXT)).toBe(true);

    const reloaded = new Vault(storage, { params: FAST });
    expect(await reloaded.initialize()).toBe('unlocked');
  });
});
