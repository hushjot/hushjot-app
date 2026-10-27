/**
 * Naming the record an envelope belongs to (`envelope.ts`, "Version 2").
 *
 * Its own module rather than part of `envelope.ts` for one reason: the share
 * viewer opens envelopes too, and it has a 57 KB critical-path budget with no
 * room in it. Everything here is needed only by the app and the CLI, which
 * seal and open vault records; a module split is what keeps it out of the
 * chunk the two entries share.
 */
import { ENVELOPE_VERSION } from './envelope.ts';

/** What a bound envelope can belong to. */
export type RecordKind = 'note-meta' | 'note-body' | 'folder' | 'share-key';

/**
 * The context a record's envelope is bound to. The kind keeps a note's meta
 * from passing as its own body (same id, different slot); the id keeps one
 * note's body from passing as another's. Ids never contain `:` (see
 * `history/record.ts`), so the string is unambiguous.
 */
export function recordContext(kind: RecordKind, id: string): string {
  return `hushjot:${kind}:${id}`;
}

/** True for a version-1 envelope — one the legacy re-seal still has to visit. */
export function isUnboundEnvelope(envelope: Uint8Array): boolean {
  return envelope.length > 0 && envelope[0] === ENVELOPE_VERSION;
}
