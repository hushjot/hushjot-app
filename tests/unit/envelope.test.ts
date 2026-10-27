import { describe, it, expect } from 'vitest';
import {
  seal,
  open,
  sealText,
  openText,
  generateDek,
  importKey,
  exportKey,
  DecryptError,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_BOUND,
  ACCEPT_UNBOUND_LEGACY,
  ALG_AES_256_GCM,
} from '../../src/core/crypto/envelope.ts';
import { isUnboundEnvelope, recordContext } from '../../src/core/crypto/binding.ts';
import { utf8, fromUtf8, toBase64, fromBase64, alloc, randomBytes } from '../../src/core/crypto/bytes.ts';

const key = await generateDek();

describe('envelope round trip', () => {
  it('recovers the exact plaintext', async () => {
    const text = '# Note\n\nSome **markdown** with `code`.';
    expect(await openText(key, await sealText(key, text))).toBe(text);
  });

  it('handles empty content', async () => {
    expect(await openText(key, await sealText(key, ''))).toBe('');
  });

  it('handles multi-byte characters exactly', async () => {
    const text = 'emoji 🎉 accents éàü kanji 日本語 rtl مرحبا';
    expect(await openText(key, await sealText(key, text))).toBe(text);
  });

  it('handles a large note', async () => {
    const text = 'x'.repeat(500_000);
    expect(await openText(key, await sealText(key, text))).toBe(text);
  });

  it('preserves arbitrary bytes', async () => {
    const bytes = alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect([...(await open(key, await seal(key, bytes)))]).toEqual([...bytes]);
  });
});

describe('envelope format', () => {
  it('writes the version and algorithm header', async () => {
    const env = await sealText(key, 'hello');
    expect(env[0]).toBe(ENVELOPE_VERSION);
    expect(env[1]).toBe(ALG_AES_256_GCM);
  });

  it('adds a 12-byte nonce and 16-byte tag', async () => {
    const env = await sealText(key, 'hello');
    // 2 header + 12 nonce + 5 plaintext + 16 tag
    expect(env.length).toBe(2 + 12 + 5 + 16);
  });

  it('never repeats a nonce', async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const env = await sealText(key, 'same plaintext every time');
      nonces.add(toBase64(env.subarray(2, 14)));
    }
    expect(nonces.size).toBe(200);
  });

  it('produces different ciphertext for identical plaintext', async () => {
    // Deterministic ciphertext would leak which notes are identical.
    const a = await sealText(key, 'duplicate');
    const b = await sealText(key, 'duplicate');
    expect(toBase64(a)).not.toBe(toBase64(b));
  });
});

describe('envelope authentication', () => {
  it('rejects a wrong key', async () => {
    const other = await generateDek();
    const env = await sealText(key, 'secret');
    await expect(openText(other, env)).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects a flipped ciphertext bit', async () => {
    const env = await sealText(key, 'secret note');
    env[env.length - 5]! ^= 0x01;
    await expect(openText(key, env)).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects a tampered nonce', async () => {
    const env = await sealText(key, 'secret note');
    env[5]! ^= 0xff;
    await expect(openText(key, env)).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects a downgraded algorithm byte', async () => {
    // The header is authenticated data, so rewriting it must fail rather than
    // letting an attacker negotiate the format.
    const env = await sealText(key, 'secret note');
    env[1] = 99;
    await expect(openText(key, env)).rejects.toThrow(/unsupported algorithm/);
  });

  it('rejects an unknown version', async () => {
    const env = await sealText(key, 'secret note');
    env[0] = 3;
    await expect(openText(key, env)).rejects.toThrow(/unsupported envelope version/);
  });

  it('rejects a truncated envelope', async () => {
    const env = await sealText(key, 'secret note');
    await expect(openText(key, env.subarray(0, 10))).rejects.toBeInstanceOf(DecryptError);
  });

  it('gives the same error for a wrong key and for tampering', async () => {
    // Distinguishable errors would be an oracle.
    const other = await generateDek();
    const env = await sealText(key, 'secret');
    const wrongKey = await openText(other, env).catch((e: Error) => e.message);

    const tampered = await sealText(key, 'secret');
    tampered[tampered.length - 1]! ^= 0x08;
    const tamperedMsg = await openText(key, tampered).catch((e: Error) => e.message);

    expect(wrongKey).toBe(tamperedMsg);
  });
});

describe('bound envelopes (version 2)', () => {
  const a = recordContext('note-body', 'note-a');
  const b = recordContext('note-body', 'note-b');

  it('round-trips under the context it was sealed with', async () => {
    const sealed = await sealText(key, 'hello', a);
    expect(sealed[0]).toBe(ENVELOPE_VERSION_BOUND);
    expect(sealed[1]).toBe(ALG_AES_256_GCM);
    expect(await openText(key, sealed, a)).toBe('hello');
  });

  it('is the same size as an unbound envelope: the context is not stored', async () => {
    const bound = await sealText(key, 'same length', a);
    const unbound = await sealText(key, 'same length');
    expect(bound.length).toBe(unbound.length);
  });

  it('refuses to open under another record', async () => {
    const sealed = await sealText(key, 'hello', a);
    await expect(openText(key, sealed, b)).rejects.toBeInstanceOf(DecryptError);
    await expect(openText(key, sealed, recordContext('note-meta', 'note-a'))).rejects.toBeInstanceOf(DecryptError);
  });

  it('refuses to open without a context', async () => {
    const sealed = await sealText(key, 'hello', a);
    await expect(openText(key, sealed)).rejects.toBeInstanceOf(DecryptError);
  });

  it('cannot be relabelled as version 1 to drop the binding', async () => {
    const sealed = await sealText(key, 'hello', a);
    sealed[0] = ENVELOPE_VERSION;
    await expect(openText(key, sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openText(key, sealed, a)).rejects.toBeInstanceOf(DecryptError);
  });

  it('opens a version-1 envelope under a context while the legacy window is open', async () => {
    const legacy = await sealText(key, 'old note');
    expect(isUnboundEnvelope(legacy)).toBe(true);
    expect(await openText(key, legacy, a)).toBe('old note');
  });

  it('keeps the legacy window open in this format', () => {
    // Closing it is a format change with its own release and its own test
    // that a version-1 record is refused; see `ACCEPT_UNBOUND_LEGACY`.
    expect(ACCEPT_UNBOUND_LEGACY).toBe(true);
  });

  it('still opens an unbound envelope without a context, as key records and shares do', async () => {
    const legacy = await sealText(key, 'old note');
    expect(fromUtf8(await open(key, legacy))).toBe('old note');
  });

  it('does not report a bound envelope as unbound', async () => {
    expect(isUnboundEnvelope(await sealText(key, 'x', a))).toBe(false);
  });
});

describe('key handling', () => {
  it('imports a non-extractable key that still decrypts', async () => {
    const raw = await exportKey(key);
    const nonExtractable = await importKey(raw, false);
    const env = await sealText(nonExtractable, 'works');
    expect(await openText(nonExtractable, env)).toBe('works');
  });

  it('refuses to export a non-extractable key', async () => {
    const raw = await exportKey(key);
    const nonExtractable = await importKey(raw, false);
    await expect(exportKey(nonExtractable)).rejects.toBeTruthy();
  });
});

describe('byte helpers', () => {
  it('round-trips base64', () => {
    const bytes = alloc(1000);
    crypto.getRandomValues(bytes);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it('round-trips base64 for large inputs', () => {
    // Chunked encoding: a naive spread would exceed the argument limit here.
    const bytes = randomBytes(200_000);
    expect([...fromBase64(toBase64(bytes)).subarray(0, 64)]).toEqual([...bytes.subarray(0, 64)]);
    expect(fromBase64(toBase64(bytes)).length).toBe(bytes.length);
  });

  it('generates more randomness than one getRandomValues call allows', () => {
    // The platform caps a single call at 65,536 bytes.
    expect(randomBytes(200_000).length).toBe(200_000);
  });

  it('round-trips utf8', () => {
    const text = 'mixed 🎉 日本語 text';
    expect(fromUtf8(utf8(text))).toBe(text);
  });
});
