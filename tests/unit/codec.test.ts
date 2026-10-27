import { describe, it, expect } from 'vitest';
import { noteMetaJson, plaintextCodec, readNoteMeta } from '../../src/core/repo/codec.ts';
import { encryptedCodec } from '../../src/core/repo/encryptedCodec.ts';

/**
 * The note meta payload gained `pinnedAt` long after records existed, and an
 * older build still writes records without it. Both sides of that are here.
 */
describe('note meta payload', () => {
  it('reads a record written before pins existed as unpinned', async () => {
    expect(await plaintextCodec.decodeNoteMeta('n1', JSON.stringify({ title: 't', folderId: null }))).toEqual({
      title: 't',
      folderId: null,
      pinnedAt: null,
    });
    expect(readNoteMeta({ title: 't', folderId: 'f' }).pinnedAt).toBeNull();
  });

  it('writes an unpinned note in exactly the old shape', async () => {
    expect(await plaintextCodec.encodeNoteMeta('n1', { title: 't', folderId: 'f', pinnedAt: null })).toBe(
      JSON.stringify({ title: 't', folderId: 'f' }),
    );
  });

  it('round-trips a pin through the encrypted codec', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const codec = encryptedCodec(() => key);
    const payload = { title: 't', folderId: 'f', pinnedAt: 1234 };
    expect(await codec.decodeNoteMeta('n1', await codec.encodeNoteMeta('n1', payload))).toEqual(payload);
    const unpinned = { ...payload, pinnedAt: null };
    expect(await codec.decodeNoteMeta('n1', await codec.encodeNoteMeta('n1', unpinned))).toEqual(unpinned);
  });
});

/**
 * The encrypted codec binds every blob to its record (`crypto/envelope.ts`,
 * "Version 2"). Without that, whoever holds the database could move one
 * note's body into another's slot and it would decode as the second note.
 */
describe('records bound to their slot', () => {
  const freshCodec = async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return encryptedCodec(() => key);
  };

  it("refuses one note's body in another note's slot", async () => {
    const codec = await freshCodec();
    const a = await codec.encodeBody('note-a', 'A secret');
    expect(await codec.decodeBody('note-a', a)).toBe('A secret');
    await expect(codec.decodeBody('note-b', a)).rejects.toThrow();
  });

  it("refuses one note's meta in another note's slot", async () => {
    const codec = await freshCodec();
    const a = await codec.encodeNoteMeta('note-a', { title: 'A', folderId: null, pinnedAt: null });
    await expect(codec.decodeNoteMeta('note-b', a)).rejects.toThrow();
  });

  it('refuses a meta blob as a folder with the same id, and a body as meta', async () => {
    const codec = await freshCodec();
    const meta = await codec.encodeNoteMeta('x', { title: 'A', folderId: null, pinnedAt: null });
    await expect(codec.decodeFolder('x', meta)).rejects.toThrow();
    const body = await codec.encodeBody('x', '{"title":"looks like meta","folderId":null}');
    await expect(codec.decodeNoteMeta('x', body)).rejects.toThrow();
  });

  it("refuses one folder's data in another folder's slot", async () => {
    const codec = await freshCodec();
    const f = await codec.encodeFolder('f1', { name: 'Work', parentId: null });
    expect(await codec.decodeFolder('f1', f)).toEqual({ name: 'Work', parentId: null });
    await expect(codec.decodeFolder('f2', f)).rejects.toThrow();
  });
});

describe('the note excerpt in sealed meta', () => {
  it('is omitted when empty, so a record without one keeps its old bytes', () => {
    const before = noteMetaJson({ title: 'T', folderId: null, pinnedAt: null });
    const after = noteMetaJson({ title: 'T', folderId: null, pinnedAt: null, excerpt: '' });
    expect(after).toBe(before);
    expect(before).toBe(JSON.stringify({ title: 'T', folderId: null }));
  });

  it('round-trips through seal and read', () => {
    const json = noteMetaJson({ title: 'T', folderId: 'f1', pinnedAt: 7, excerpt: 'the body' });
    expect(readNoteMeta(JSON.parse(json))).toEqual({
      title: 'T',
      folderId: 'f1',
      pinnedAt: 7,
      excerpt: 'the body',
    });
  });

  it('reads a record written before excerpts existed without inventing one', () => {
    const old = JSON.parse(JSON.stringify({ title: 'T', folderId: null }));
    const read = readNoteMeta(old);
    expect('excerpt' in read).toBe(false);
    // And re-sealing it must not grow the record.
    expect(noteMetaJson(read)).toBe(JSON.stringify({ title: 'T', folderId: null }));
  });

  /**
   * The trap. `putNoteMeta` is the pin-and-move write and has no body to
   * derive an excerpt from, so it must carry the one already on the meta. This
   * reproduces that call's shape: if the spread is ever dropped, pinning a
   * note silently blanks its second line in the list.
   */
  it('survives a metadata-only write that has no body to derive from', () => {
    const meta = { title: 'T', folderId: null, pinnedAt: null, excerpt: 'kept' };
    const pinned = { ...meta, pinnedAt: 42 };
    expect(readNoteMeta(JSON.parse(noteMetaJson(pinned))).excerpt).toBe('kept');
  });
});

describe('the created date in sealed meta', () => {
  it('is omitted when absent, so every record written before it keeps its bytes', () => {
    const before = noteMetaJson({ title: 'T', folderId: null, pinnedAt: null });
    // `as never`: `exactOptionalPropertyTypes` forbids writing this in typed
    // code, which is the point — the guard is for a JS caller that can.
    const after = noteMetaJson({ title: 'T', folderId: null, pinnedAt: null, createdAt: undefined } as never);
    expect(after).toBe(before);
    expect(before).toBe(JSON.stringify({ title: 'T', folderId: null }));
  });

  it('is appended last, so an existing record only grows at the end', () => {
    expect(noteMetaJson({ title: 'T', folderId: null, pinnedAt: 7, excerpt: 'e', createdAt: 5 })).toBe(
      JSON.stringify({ title: 'T', folderId: null, pinnedAt: 7, excerpt: 'e', createdAt: 5 }),
    );
  });

  it('keeps 0, which is a real instant', () => {
    expect(readNoteMeta(JSON.parse(noteMetaJson({ title: 'T', folderId: null, pinnedAt: null, createdAt: 0 })))
      .createdAt).toBe(0);
  });

  it('round-trips through seal and read', () => {
    const json = noteMetaJson({ title: 'T', folderId: 'f1', pinnedAt: 7, createdAt: 1700 });
    expect(readNoteMeta(JSON.parse(json))).toEqual({
      title: 'T',
      folderId: 'f1',
      pinnedAt: 7,
      createdAt: 1700,
    });
  });

  it('reads a record written before the field existed without inventing one', () => {
    // Absent rather than 0: 0 is an instant, and it would sort every old note
    // to the far end of a created-date list. `loadAllMeta` is the one place
    // that resolves the absence, and it falls back to the row's `updatedAt`.
    const read = readNoteMeta(JSON.parse(JSON.stringify({ title: 'T', folderId: null })));
    expect('createdAt' in read).toBe(false);
    expect(noteMetaJson(read)).toBe(JSON.stringify({ title: 'T', folderId: null }));
  });

  it('discards a non-number, which cannot be compared', () => {
    expect('createdAt' in readNoteMeta({ title: 'T', folderId: null, createdAt: 'no' } as never)).toBe(false);
  });

  /**
   * The excerpt's trap, one field along. `putNoteMeta` is the pin-and-move
   * write and has no note to re-derive from, so it must carry the created date
   * already on the meta — otherwise pinning a note resets its created date, and
   * the reset syncs.
   */
  it('survives a metadata-only write that has no note to re-derive from', () => {
    const meta = { title: 'T', folderId: null, pinnedAt: null, createdAt: 1700 };
    const pinned = { ...meta, pinnedAt: 42 };
    expect(readNoteMeta(JSON.parse(noteMetaJson(pinned))).createdAt).toBe(1700);
  });
});
