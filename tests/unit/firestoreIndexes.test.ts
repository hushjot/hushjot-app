/**
 * The two Firestore index files must not drift apart.
 *
 * Expiry is a TTL policy, and Firestore only allows TTL on the Blaze plan:
 * deploying one to a Spark project fails with "billing disabled". So the
 * deployed `firestore.indexes.json` carries everything except the TTL
 * policies, and `firestore.indexes.blaze.json` is the same file plus them,
 * and is the one `firebase.json` points at now that the project is on Blaze
 * (docs/firebase-setup.md, "Version expiry"). An index added to one and not
 * the other would silently vanish on the switch, or break the Spark deploy.
 *
 * Two things expire: note versions, and shared links. `shares` names both the
 * public collection and each owner's private record of their links, and the
 * TTL wants to reach both — an expired link's record should go the same day
 * its blob does — which a collection-group override does by construction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Override {
  collectionGroup: string;
  fieldPath: string;
  ttl?: boolean;
}
interface IndexFile {
  indexes: unknown[];
  fieldOverrides: Override[];
}

const read = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), name), 'utf8')) as IndexFile;
const spark = read('firestore.indexes.json');
const blaze = read('firestore.indexes.blaze.json');
const isTtl = (o: Override) => o.ttl !== undefined;

/** Every TTL policy Blaze is meant to add, and nothing else. */
const EXPECTED_TTL: Override[] = [
  { collectionGroup: 'versions', fieldPath: 'expireAt', ttl: true, indexes: [] } as Override,
  { collectionGroup: 'shares', fieldPath: 'expireAt', ttl: true, indexes: [] } as Override,
];

describe('Firestore index files', () => {
  it('deploys no TTL policy on the Spark plan', () => {
    expect(spark.fieldOverrides.some((o) => o.ttl !== undefined)).toBe(false);
  });

  it('adds exactly the expiry TTLs for Blaze, and nothing else', () => {
    const byKey = (o: Override) => `${o.collectionGroup}/${o.fieldPath}`;
    expect(blaze.fieldOverrides.filter(isTtl).map(byKey).sort()).toEqual(EXPECTED_TTL.map(byKey).sort());
    expect(blaze.fieldOverrides.filter(isTtl)).toEqual(expect.arrayContaining(EXPECTED_TTL));
    expect({ ...blaze, fieldOverrides: blaze.fieldOverrides.filter((o) => !isTtl(o)) }).toEqual(spark);
  });

  it('keeps ciphertext out of every index', () => {
    // Indexing a value the database cannot read buys nothing, counts against
    // the per-document index limit, and is billed: every note write updates
    // two index entries of up to 1,500 bytes each, stored for as long as the
    // note is. Pulls order by `syncedAt` and the document id, never by these.
    for (const [group, field] of [
      ['notes', 'meta'],
      ['notes', 'body'],
      ['folders', 'data'],
      ['versions', 'meta'],
      ['versions', 'body'],
      ['shares', 'payload'],
    ]) {
      for (const file of [spark, blaze]) {
        expect(file.fieldOverrides).toContainEqual({ collectionGroup: group, fieldPath: field, indexes: [] });
      }
    }
  });

  it('indexes nothing no query orders or filters by', () => {
    // Every query the app and the CLI make, checked when this list was written:
    // the delta pull and the listener order notes and folders by `syncedAt`
    // (and the document id, which every single-field index carries); history
    // orders a note's versions by `createdAt`; the shared-links dialog orders
    // the owner's records by `createdAt`. The admin dashboard reads the
    // `usage` collection group whole, with no filter. Every other field
    // would only be paid for — an index entry written on every write and
    // stored for as long as the document is.
    const exempt: [string, string[]][] = [
      ['notes', ['v', 'revision', 'updatedAt', 'deleted']],
      ['folders', ['v', 'createdAt', 'updatedAt', 'deleted']],
      ['versions', ['v', 'at', 'reason']],
      ['shares', ['v', 'key', 'noteId']],
      ['usage', ['bytes', 'hist', 'shares', 'pushes', 'ws', 'pn', 'lastDoc', 'reconciledAt']],
      ['keys', ['v', 'record', 'updatedAt', 'resetAt']],
    ];
    for (const [group, fields] of exempt) {
      for (const field of fields) {
        for (const file of [spark, blaze]) {
          expect(file.fieldOverrides).toContainEqual({ collectionGroup: group, fieldPath: field, indexes: [] });
        }
      }
    }
    // And the fields that are queried stay indexed.
    for (const [group, field] of [
      ['notes', 'syncedAt'],
      ['folders', 'syncedAt'],
      ['versions', 'createdAt'],
      ['shares', 'createdAt'],
    ]) {
      for (const file of [spark, blaze]) {
        expect(file.fieldOverrides.some((o) => o.collectionGroup === group && o.fieldPath === field)).toBe(false);
      }
    }
  });

  it('is the Blaze file that firebase.json deploys today', () => {
    // The project moved to Blaze with billing, which is what
    // unparks the TTL policies. Point back at the Spark file only on a project
    // with billing disabled.
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'firebase.json'), 'utf8'));
    expect(config.firestore.indexes).toBe('firestore.indexes.blaze.json');
  });
});
