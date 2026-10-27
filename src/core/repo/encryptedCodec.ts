/**
 * The encrypted codec — the whole point of the `Codec` seam in Phase 2.
 *
 * Swapping this in is the only change needed to turn a plaintext database into
 * an encrypted one: no schema change, no new stores, no migration of the
 * columns the database indexes (`id`, `updatedAt`, `revision`, `deleted` were
 * always outside the blob for exactly this reason).
 *
 * Encryption happens on the calling thread. Spike 4 measured AES-GCM at 0.5 ms
 * for a 500 KB note and 0.1 ms for 10 KB, and the write itself is debounced —
 * so a worker would add a message protocol and a key handoff to save nothing
 * measurable (bench/RESULTS.md, design change 2).
 *
 * Every envelope is bound to its record: meta, body and folder each seal under
 * `recordContext(kind, id)`, so a blob moved into another note's slot — or a
 * note's meta into its own body slot — fails authentication instead of
 * decoding as someone else's text (`crypto/envelope.ts`, "Version 2").
 */
import { seal, open } from '../crypto/envelope.ts';
import { recordContext } from '../crypto/binding.ts';
import { utf8, fromUtf8 } from '../crypto/bytes.ts';
import { noteMetaJson, readNoteMeta, type Codec, type NoteMetaPayload, type FolderPayload } from './codec.ts';
import type { Encoded } from './schema.ts';

function asBytes(value: Encoded): Uint8Array {
  if (typeof value === 'string') {
    // A record written by the Phase 2 plaintext codec. Decoding it here would
    // hand back gibberish, so it is rejected loudly and handled by the
    // migration path instead.
    throw new Error('record is not encrypted');
  }
  return value;
}

/**
 * @param key the vault's data-encryption key. Held by reference rather than
 * copied, so `lock()` dropping it takes effect everywhere at once.
 */
export function encryptedCodec(getKey: () => CryptoKey): Codec {
  return {
    name: 'aes-256-gcm',

    async encodeNoteMeta(id: string, payload: NoteMetaPayload) {
      return seal(getKey(), utf8(noteMetaJson(payload)), recordContext('note-meta', id));
    },

    async decodeNoteMeta(id, value) {
      return readNoteMeta(
        JSON.parse(
          fromUtf8(await open(getKey(), asBytes(value), recordContext('note-meta', id))),
        ) as Partial<NoteMetaPayload>,
      );
    },

    async encodeBody(id: string, content: string) {
      return seal(getKey(), utf8(content), recordContext('note-body', id));
    },

    async decodeBody(id, value) {
      return fromUtf8(await open(getKey(), asBytes(value), recordContext('note-body', id)));
    },

    async encodeFolder(id: string, payload: FolderPayload) {
      return seal(getKey(), utf8(JSON.stringify(payload)), recordContext('folder', id));
    },

    async decodeFolder(id, value) {
      return JSON.parse(
        fromUtf8(await open(getKey(), asBytes(value), recordContext('folder', id))),
      ) as FolderPayload;
    },
  };
}
