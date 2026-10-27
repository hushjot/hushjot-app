import { describe, it, expect } from 'vitest';
import {
  newShareKey,
  importShareKey,
  sealShare,
  openShare,
  MAX_SHARE_BYTES,
  ShareTooLargeError,
  ShareFormatError,
} from '../../src/core/share/payload.ts';
import { DecryptError } from '../../src/core/crypto/envelope.ts';
import { toBase64Url, randomBytes } from '../../src/core/crypto/bytes.ts';

const payload = { title: 'Dinner list', body: '# Dinner list\n\n- olives\n- 🍅\n', updatedAt: 1_758_000_000_000 };

describe('share payload', () => {
  it('round-trips through the key a link carries', async () => {
    const { key, encoded } = await newShareKey();
    const sealed = await sealShare(key, payload);
    expect(await openShare(await importShareKey(encoded), sealed)).toEqual(payload);
  });

  it('mints a different key every time', async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, () => newShareKey()));
    expect(new Set(keys.map((k) => k.encoded)).size).toBe(20);
  });

  it('never hands back an extractable key', async () => {
    const { key } = await newShareKey();
    expect(key.extractable).toBe(false);
    expect((await importShareKey(toBase64Url(randomBytes(32)))).extractable).toBe(false);
  });

  it('fails a wrong key exactly as tampering does', async () => {
    const { key } = await newShareKey();
    const sealed = await sealShare(key, payload);
    const other = await importShareKey(toBase64Url(randomBytes(32)));
    await expect(openShare(other, sealed)).rejects.toBeInstanceOf(DecryptError);

    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(openShare(key, tampered)).rejects.toBeInstanceOf(DecryptError);
  });

  it('produces different ciphertext for the same note twice', async () => {
    const { key } = await newShareKey();
    const a = await sealShare(key, payload);
    const b = await sealShare(key, payload);
    expect([...a]).not.toEqual([...b]);
  });

  it('refuses a key that is not 256 bits', async () => {
    await expect(importShareKey(toBase64Url(randomBytes(16)))).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('refuses a key that is not base64url', async () => {
    await expect(importShareKey('not base64url!')).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('refuses a note too large for one document', async () => {
    const { key } = await newShareKey();
    const huge = { ...payload, body: 'x'.repeat(MAX_SHARE_BYTES + 1) };
    await expect(sealShare(key, huge)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it('blames the format, not the key, when the key was right', async () => {
    const { key } = await newShareKey();
    const { sealText } = await import('../../src/core/crypto/envelope.ts');
    await expect(openShare(key, await sealText(key, 'not json'))).rejects.toBeInstanceOf(ShareFormatError);
    await expect(openShare(key, await sealText(key, '{"v":99}'))).rejects.toBeInstanceOf(ShareFormatError);
    await expect(openShare(key, await sealText(key, '{"v":1}'))).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('tolerates a payload missing its optional fields', async () => {
    const { key } = await newShareKey();
    const { sealText } = await import('../../src/core/crypto/envelope.ts');
    expect(await openShare(key, await sealText(key, '{"v":1,"body":"hi"}'))).toEqual({
      title: '',
      body: 'hi',
      updatedAt: 0,
    });
  });
});
