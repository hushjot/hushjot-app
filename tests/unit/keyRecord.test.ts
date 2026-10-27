import { describe, it, expect } from 'vitest';
import {
  createKeyRecord,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  changePassphrase,
  rotateRecoveryCode,
  setPassphraseWithRecoveryCode,
  WrongSecretError,
  KEY_RECORD_VERSION,
  serializeKeyRecord,
  deserializeKeyRecord,
  sameKeyRecord,
} from '../../src/core/crypto/keyRecord.ts';
import { sealText, openText } from '../../src/core/crypto/envelope.ts';
import { toBase64 } from '../../src/core/crypto/bytes.ts';
import {
  generateRecoveryCode,
  canonicalize,
  format,
  looksLikeRecoveryCode,
} from '../../src/core/crypto/recoveryCode.ts';

// Argon2id at production parameters is ~100 ms per derivation; these tests do
// many. Weak parameters keep them fast — the code path is identical.
const FAST = { name: 'argon2id', memoryKiB: 1024, iterations: 1, parallelism: 1 } as const;

const PASSPHRASE = 'correct horse battery staple';

async function newVault(code = generateRecoveryCode()) {
  const created = await createKeyRecord(PASSPHRASE, code, FAST);
  return { ...created, code };
}

describe('createKeyRecord', () => {
  it('produces a usable key', async () => {
    const { dek } = await newVault();
    expect(await openText(dek, await sealText(dek, 'hello'))).toBe('hello');
  });

  it('stores only ciphertext, salts and parameters', async () => {
    const { record } = await newVault();
    // Nothing in the record may be a secret the server must not see.
    const serialized = JSON.stringify(record, (_k, v) =>
      v instanceof Uint8Array ? toBase64(v) : v,
    );
    expect(serialized).not.toContain(PASSPHRASE);
    expect(record.version).toBe(KEY_RECORD_VERSION);
    expect(record.passphrase.salt.length).toBe(32);
    expect(record.recovery.salt.length).toBe(32);
  });

  it('uses independent salts for the two paths', async () => {
    const { record } = await newVault();
    expect(toBase64(record.passphrase.salt)).not.toBe(toBase64(record.recovery.salt));
  });

  it('gives every vault a distinct salt', async () => {
    const a = await newVault();
    const b = await newVault();
    expect(toBase64(a.record.passphrase.salt)).not.toBe(toBase64(b.record.passphrase.salt));
  });
});

describe('unlocking', () => {
  it('unlocks with the passphrase and yields the same key', async () => {
    const { record, dek } = await newVault();
    const sealed = await sealText(dek, 'the note');

    const reopened = await unlockWithPassphrase(record, PASSPHRASE);
    expect(await openText(reopened, sealed)).toBe('the note');
  });

  it('unlocks with the recovery code and yields the same key', async () => {
    const { record, dek, code } = await newVault();
    const sealed = await sealText(dek, 'the note');

    const reopened = await unlockWithRecoveryCode(record, code);
    expect(await openText(reopened, sealed)).toBe('the note');
  });

  it('rejects a wrong passphrase', async () => {
    const { record } = await newVault();
    await expect(unlockWithPassphrase(record, 'not it')).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('rejects a wrong recovery code', async () => {
    const { record } = await newVault();
    await expect(
      unlockWithRecoveryCode(record, generateRecoveryCode()),
    ).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('accepts a recovery code however the user formats it', async () => {
    const { record, code } = await newVault();
    const variants = [
      code.toLowerCase(),
      code.replace(/-/g, ''),
      code.replace(/-/g, ' '),
      `  ${code}  `,
    ];
    for (const variant of variants) {
      await expect(unlockWithRecoveryCode(record, variant)).resolves.toBeTruthy();
    }
  });
});

describe('changePassphrase', () => {
  it('opens with the new passphrase and not the old', async () => {
    const { record, dek } = await newVault();
    const sealed = await sealText(dek, 'preserved');

    const updated = await changePassphrase(record, PASSPHRASE, 'a brand new passphrase', FAST);

    const reopened = await unlockWithPassphrase(updated, 'a brand new passphrase');
    expect(await openText(reopened, sealed)).toBe('preserved');
    await expect(unlockWithPassphrase(updated, PASSPHRASE)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('leaves the recovery code working', async () => {
    // Re-wrapping one copy must not disturb the other.
    const { record, dek, code } = await newVault();
    const sealed = await sealText(dek, 'preserved');

    const updated = await changePassphrase(record, PASSPHRASE, 'another passphrase', FAST);
    const viaRecovery = await unlockWithRecoveryCode(updated, code);
    expect(await openText(viaRecovery, sealed)).toBe('preserved');
  });

  it('does not re-encrypt notes', async () => {
    // The whole point of a random DEK: changing the passphrase touches 32
    // bytes, not the note collection.
    const { record, dek } = await newVault();
    const sealed = await sealText(dek, 'untouched');
    const before = toBase64(sealed);

    await changePassphrase(record, PASSPHRASE, 'new one', FAST);
    expect(toBase64(sealed)).toBe(before);
  });

  it('refuses with the wrong current passphrase', async () => {
    const { record } = await newVault();
    await expect(changePassphrase(record, 'wrong', 'new', FAST)).rejects.toBeInstanceOf(
      WrongSecretError,
    );
  });

  it('re-stamps the parameters it is given', async () => {
    // The only route a KDF retune has to an existing vault: the record carries
    // its own parameters, and nothing else ever rewrites them.
    const { record } = await newVault();
    const stronger = { ...FAST, iterations: 3 } as const;

    const updated = await changePassphrase(record, PASSPHRASE, 'retuned', stronger);

    expect(updated.passphrase.iterations).toBe(3);
    expect(await unlockWithPassphrase(updated, 'retuned')).toBeTruthy();
  });
});

describe('setPassphraseWithRecoveryCode', () => {
  it('opens with the new passphrase and not the old', async () => {
    const { record, dek, code } = await newVault();
    const sealed = await sealText(dek, 'preserved');

    const updated = await setPassphraseWithRecoveryCode(record, code, 'the new one', FAST);

    const reopened = await unlockWithPassphrase(updated, 'the new one');
    expect(await openText(reopened, sealed)).toBe('preserved');
    await expect(unlockWithPassphrase(updated, PASSPHRASE)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('leaves the recovery code working', async () => {
    // Deliberate: the code is the only secret this user has demonstrably still
    // got, and retiring it in the same act that mints a passphrase they have
    // not yet retyped would leave them with nothing.
    const { record, code } = await newVault();

    const updated = await setPassphraseWithRecoveryCode(record, code, 'the new one', FAST);

    expect(toBase64(updated.wrappedByRecovery)).toBe(toBase64(record.wrappedByRecovery));
    expect(toBase64(updated.recovery.salt)).toBe(toBase64(record.recovery.salt));
    await expect(unlockWithRecoveryCode(updated, code)).resolves.toBeTruthy();
  });

  it('does not re-encrypt notes', async () => {
    const { record, dek, code } = await newVault();
    const sealed = await sealText(dek, 'untouched');
    const before = toBase64(sealed);

    await setPassphraseWithRecoveryCode(record, code, 'new one', FAST);
    expect(toBase64(sealed)).toBe(before);
  });

  it('accepts the code however the user formats it', async () => {
    // It comes off a piece of paper, not a clipboard.
    const { record, code } = await newVault();
    const typed = code.toLowerCase().replace(/-/g, ' ');

    const updated = await setPassphraseWithRecoveryCode(record, typed, 'new one', FAST);
    await expect(unlockWithPassphrase(updated, 'new one')).resolves.toBeTruthy();
  });

  it('refuses with the wrong recovery code', async () => {
    const { record } = await newVault();
    await expect(
      setPassphraseWithRecoveryCode(record, generateRecoveryCode(), 'new', FAST),
    ).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('re-stamps the parameters it is given', async () => {
    const { record, code } = await newVault();
    const stronger = { ...FAST, iterations: 3 } as const;

    const updated = await setPassphraseWithRecoveryCode(record, code, 'retuned', stronger);
    expect(updated.passphrase.iterations).toBe(3);
  });

  it('refuses an unsupported record version', async () => {
    const { record, code } = await newVault();
    await expect(
      setPassphraseWithRecoveryCode({ ...record, version: 99 }, code, 'new', FAST),
    ).rejects.toThrow(/unsupported key record version/);
  });
});

describe('rotateRecoveryCode', () => {
  it('invalidates the old code and honours the new one', async () => {
    const { record, dek, code } = await newVault();
    const sealed = await sealText(dek, 'still here');

    const fresh = generateRecoveryCode();
    const updated = await rotateRecoveryCode(record, PASSPHRASE, fresh);

    const viaNew = await unlockWithRecoveryCode(updated, fresh);
    expect(await openText(viaNew, sealed)).toBe('still here');
    await expect(unlockWithRecoveryCode(updated, code)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('leaves the passphrase working', async () => {
    const { record } = await newVault();
    const updated = await rotateRecoveryCode(record, PASSPHRASE, generateRecoveryCode());
    await expect(unlockWithPassphrase(updated, PASSPHRASE)).resolves.toBeTruthy();
  });
});

describe('recovery codes', () => {
  it('are formatted in readable groups', () => {
    expect(generateRecoveryCode()).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
  });

  it('carry 160 bits of entropy', () => {
    expect(canonicalize(generateRecoveryCode()).length).toBe(32);
  });

  it('are unique', () => {
    const codes = new Set(Array.from({ length: 500 }, generateRecoveryCode));
    expect(codes.size).toBe(500);
  });

  it('omit the characters people misread', () => {
    // Crockford base32: no I, L, O or U.
    for (let i = 0; i < 200; i++) {
      expect(canonicalize(generateRecoveryCode())).not.toMatch(/[ILOU]/);
    }
  });

  it('repair common transcription mistakes', () => {
    // O->0, I->1, l->1, U->V, and dashes dropped.
    expect(canonicalize('O0-Il-1U')).toBe('00111V');
    expect(canonicalize('o0 i1 Lu')).toBe('00111V');
  });

  it('validate structurally', () => {
    expect(looksLikeRecoveryCode(generateRecoveryCode())).toBe(true);
    expect(looksLikeRecoveryCode('too-short')).toBe(false);
    expect(looksLikeRecoveryCode('')).toBe(false);
  });

  it('round-trip through formatting', () => {
    const code = generateRecoveryCode();
    expect(format(canonicalize(code))).toBe(code);
  });
});

/**
 * Comparison is load-bearing in one direction only.
 *
 * `core/sync/backfill.ts` uses `sameKeyRecord` to decide that a device's vault
 * *is* the account's, which lets it upload notes into a store whose rules
 * refuse deletes. So the two claims that matter are that equality never fires
 * for two genuinely independent vaults, and that it survives the round trip
 * through a backend — including one that hands the fields back in a different
 * order, which a map type is under no obligation to preserve.
 */
describe('sameKeyRecord', () => {
  it('recognises a record as itself', async () => {
    const { record } = await newVault();
    const serialized = serializeKeyRecord(record);
    expect(sameKeyRecord(serialized, serializeKeyRecord(record))).toBe(true);
  });

  it('survives a round trip through the serialized form', async () => {
    const { record } = await newVault();
    const wire = serializeKeyRecord(record);
    const home = serializeKeyRecord(deserializeKeyRecord(wire));
    expect(sameKeyRecord(wire, home)).toBe(true);
  });

  it('does not care what order a backend hands the fields back in', async () => {
    const { record } = await newVault();
    const wire = serializeKeyRecord(record);
    // Firestore reconstructs the record from a protobuf map; nothing in that
    // contract preserves field order. A comparison that stringified would pass
    // every other test here and silently stop healing anyone.
    const shuffled = Object.fromEntries(Object.entries(wire).reverse());
    expect(sameKeyRecord(wire, shuffled)).toBe(true);
  });

  it('separates two vaults made with the same passphrase and recovery code', async () => {
    // The whole reason a passphrase cannot answer this question: the DEK is
    // random, so "same passphrase" and "same vault" are unrelated claims.
    const code = generateRecoveryCode();
    const a = await createKeyRecord(PASSPHRASE, code, FAST);
    const b = await createKeyRecord(PASSPHRASE, code, FAST);
    expect(sameKeyRecord(serializeKeyRecord(a.record), serializeKeyRecord(b.record))).toBe(false);
  });

  it('reports a re-wrapped record as different, which callers must read as "cannot tell"', async () => {
    // Same DEK, new salts. Inequality is not evidence of a different vault —
    // it is the absence of evidence, and `classifyVault` only ever reaches its
    // `false` after the durable marker has already failed to answer.
    const { record } = await newVault();
    const rewrapped = await changePassphrase(record, PASSPHRASE, 'a different passphrase');
    expect(sameKeyRecord(serializeKeyRecord(record), serializeKeyRecord(rewrapped))).toBe(false);
  });

  it('answers false rather than throwing on anything it cannot read', async () => {
    const { record } = await newVault();
    const wire = serializeKeyRecord(record);
    expect(sameKeyRecord(wire, null)).toBe(false);
    expect(sameKeyRecord(wire, undefined)).toBe(false);
    expect(sameKeyRecord(wire, {})).toBe(false);
    expect(sameKeyRecord(wire, { ...wire, passphrase: undefined })).toBe(false);
    expect(sameKeyRecord(wire, 'not a record')).toBe(false);
  });
});
