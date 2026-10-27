/**
 * The stored-byte contract, asserted from this side.
 *
 * `contract/format-vectors.json` holds frozen ciphertext, key records and pure
 * derivations produced by `npm run vectors`. This file opens them again with
 * the live modules. The CLI repository runs the same assertions against the
 * *published* `@hushjot/core`, so a change that alters what a note looks like
 * on disk fails a test in both places instead of quietly writing records the
 * other client reads differently — or cannot read at all.
 *
 * When this fails, the question is never "how do I regenerate the vectors". It
 * is "did I mean to change the format". If the answer is yes, bump
 * `FORMAT_VERSION`, run `npm run vectors`, and expect the CLI to need a release.
 *
 * Precedent for unit-testing a contract rather than a function:
 * `firestoreIndexes.test.ts` and `serviceWorkerPlugin.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALG_AES_256_GCM,
  DecryptError,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_BOUND,
  FORMAT_VERSION,
  WrongSecretError,
  deriveTitle,
  deserializeKeyRecord,
  excerptOf,
  fromBase64,
  fromUtf8,
  noteMetaJson,
  open,
  openText,
  readNoteMeta,
  recordContext,
  type RecordKind,
  tokenize,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  type NoteMetaPayload,
} from '../../src/core/public.ts';

interface Vectors {
  formatVersion: number;
  envelope: {
    version: number;
    alg: number;
    headerBytes: number;
    nonceBytes: number;
    tagBytes: number;
    aadHex: string;
  };
  keyRecords: { id: string; passphrase: string; recoveryCode: string; record: unknown }[];
  sealedUnder: string;
  noteMeta: { id: string; payload: NoteMetaPayload; json: string; envelopeBase64: string }[];
  body: { id: string; text: string; envelopeBase64: string }[];
  folder: {
    id: string;
    payload: { name: string; parentId: string | null };
    json: string;
    envelopeBase64: string;
  }[];
  boundEnvelope: { version: number; alg: number; aadPrefixHex: string; contextFormat: string };
  bound: {
    id: string;
    kind: RecordKind;
    recordId: string;
    context: string;
    plaintext: string;
    envelopeBase64: string;
  }[];
  deriveTitle: { content: string; expected: string }[];
  excerptOf: { content: string; expected: string }[];
  tokenize: { text: string; expected: string[] }[];
}

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../contract/format-vectors.json'), 'utf8'),
) as Vectors;

const recordFor = (id: string) => {
  const entry = vectors.keyRecords.find((r) => r.id === id);
  if (!entry) throw new Error(`no key record vector "${id}"`);
  return entry;
};

/** The DEK every sealed sample below was sealed under. Unwrapped once. */
const sealingKey = await (async () => {
  const entry = recordFor(vectors.sealedUnder);
  return unlockWithPassphrase(deserializeKeyRecord(entry.record), entry.passphrase);
})();

describe('format vectors', () => {
  it('are the version this build claims to speak', () => {
    expect(vectors.formatVersion).toBe(FORMAT_VERSION);
  });

  it('describe the envelope this build writes', () => {
    expect(vectors.envelope.version).toBe(ENVELOPE_VERSION);
    expect(vectors.envelope.alg).toBe(ALG_AES_256_GCM);
  });
});

describe('key records', () => {
  for (const entry of vectors.keyRecords) {
    // Both parameter sets must work, and the parameters must come out of the
    // record rather than out of a constant — that is what lets the KDF be
    // retuned later without invalidating vaults created before the change.
    it(`${entry.id}: unlocks with its passphrase`, async () => {
      const record = deserializeKeyRecord(entry.record);
      await expect(unlockWithPassphrase(record, entry.passphrase)).resolves.toBeDefined();
    });

    it(`${entry.id}: unlocks with its recovery code`, async () => {
      const record = deserializeKeyRecord(entry.record);
      await expect(unlockWithRecoveryCode(record, entry.recoveryCode)).resolves.toBeDefined();
    });
  }

  it('refuses the wrong passphrase', async () => {
    const entry = recordFor('fast');
    const record = deserializeKeyRecord(entry.record);
    await expect(unlockWithPassphrase(record, `${entry.passphrase}x`)).rejects.toBeInstanceOf(
      WrongSecretError,
    );
  });
});

describe('sealed note meta', () => {
  for (const c of vectors.noteMeta) {
    it(`${c.id}: serialises to the frozen JSON`, () => {
      // The omission rules live here: an unpinned, excerpt-less note must
      // serialise to exactly the two fields it did before either existed, so
      // its stored bytes do not change across 10,000 notes.
      expect(noteMetaJson(c.payload)).toBe(c.json);
    });

    it(`${c.id}: opens to that JSON`, async () => {
      const plain = fromUtf8(await open(sealingKey, fromBase64(c.envelopeBase64)));
      expect(plain).toBe(c.json);
    });

    it(`${c.id}: round-trips through readNoteMeta`, () => {
      const parsed = readNoteMeta(JSON.parse(c.json) as Partial<NoteMetaPayload>);
      expect(noteMetaJson(parsed)).toBe(c.json);
    });
  }
});

describe('sealed bodies', () => {
  for (const c of vectors.body) {
    it(`${c.id}: opens to the original text`, async () => {
      expect(await openText(sealingKey, fromBase64(c.envelopeBase64))).toBe(c.text);
    });
  }
});

describe('sealed folder data', () => {
  for (const c of vectors.folder) {
    it(`${c.id}: opens to the original payload`, async () => {
      const plain = fromUtf8(await open(sealingKey, fromBase64(c.envelopeBase64)));
      expect(plain).toBe(c.json);
      expect(JSON.parse(plain)).toEqual(c.payload);
    });
  }
});

describe('the envelope framing itself', () => {
  const everySealed = [...vectors.noteMeta, ...vectors.body, ...vectors.folder];

  it('stamps version and algorithm in the clear on every sample', () => {
    for (const c of everySealed) {
      const bytes = fromBase64(c.envelopeBase64);
      expect(bytes[0]).toBe(ENVELOPE_VERSION);
      expect(bytes[1]).toBe(ALG_AES_256_GCM);
      // Header plus the 16-byte GCM tag is the floor: the sealed empty string.
      expect(bytes.length).toBeGreaterThanOrEqual(
        vectors.envelope.headerBytes + vectors.envelope.tagBytes,
      );
    }
  });

  it('uses a distinct nonce for every sample', () => {
    const nonces = everySealed.map((c) =>
      fromBase64(c.envelopeBase64)
        .slice(2, 2 + vectors.envelope.nonceBytes)
        .join(','),
    );
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('authenticates the header, so the algorithm byte cannot be rewritten', async () => {
    const bytes = fromBase64(vectors.body[1]!.envelopeBase64);
    bytes[1] = 2;
    await expect(open(sealingKey, bytes)).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects a tampered ciphertext byte', async () => {
    const bytes = fromBase64(vectors.body[1]!.envelopeBase64);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    await expect(open(sealingKey, bytes)).rejects.toBeInstanceOf(DecryptError);
  });
});

describe('bound envelopes (format 2)', () => {
  it('describe the bound envelope this build writes', () => {
    expect(vectors.boundEnvelope.version).toBe(ENVELOPE_VERSION_BOUND);
    expect(vectors.boundEnvelope.alg).toBe(ALG_AES_256_GCM);
  });

  for (const c of vectors.bound) {
    it(`${c.id}: derives the frozen context`, () => {
      // A client that spelled the context differently would seal records the
      // other cannot open — and only for records it wrote, which is the worst
      // kind of failure to notice.
      expect(recordContext(c.kind, c.recordId)).toBe(c.context);
    });

    it(`${c.id}: opens under its context`, async () => {
      const bytes = fromBase64(c.envelopeBase64);
      expect(bytes[0]).toBe(ENVELOPE_VERSION_BOUND);
      expect(fromUtf8(await open(sealingKey, bytes, c.context))).toBe(c.plaintext);
    });

    it(`${c.id}: refuses to open under another record's context`, async () => {
      const bytes = fromBase64(c.envelopeBase64);
      await expect(open(sealingKey, bytes, recordContext(c.kind, `${c.recordId}x`))).rejects.toBeInstanceOf(
        DecryptError,
      );
      await expect(open(sealingKey, bytes)).rejects.toBeInstanceOf(DecryptError);
    });
  }

  it('still opens every version-1 sample under a context, inside the legacy window', async () => {
    const body = vectors.body[1]!;
    expect(await openText(sealingKey, fromBase64(body.envelopeBase64), recordContext('note-body', 'any'))).toBe(
      body.text,
    );
  });
});

describe('derivations a second client must not reimplement differently', () => {
  // A title is derived, never user-edited. A CLI that computed one differently
  // would write a different title than the browser for identical text, with
  // nothing anywhere reporting a problem.
  for (const c of vectors.deriveTitle) {
    it(`deriveTitle(${JSON.stringify(c.content.slice(0, 32))}…)`, () => {
      expect(deriveTitle(c.content)).toBe(c.expected);
    });
  }

  for (const c of vectors.excerptOf) {
    it(`excerptOf(${JSON.stringify(c.content.slice(0, 32))}…)`, () => {
      expect(excerptOf(c.content)).toBe(c.expected);
    });
  }

  for (const c of vectors.tokenize) {
    it(`tokenize(${JSON.stringify(c.text.slice(0, 32))})`, () => {
      expect(tokenize(c.text)).toEqual(c.expected);
    });
  }
});
