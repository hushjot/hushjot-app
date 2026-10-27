/**
 * The seam where encryption slots in.
 *
 * Everything the repository writes passes through a `Codec`. Phase 2 uses
 * `plaintextCodec`; Phase 3 replaces it with an AES-256-GCM envelope codec and
 * the repository, the schema and every caller stay exactly as they are.
 *
 * The interface is async because real encryption is — writing it synchronously
 * now would force a rewrite of every call site later.
 */
/**
 * Whatever the codec produces. `Uint8Array` once encryption lands, `string`
 * while it does not — IndexedDB stores both natively via structured clone, so
 * the switch needs no migration.
 *
 * It lives here rather than in `schema.ts`, where it began, because it is a
 * property of the codec and not of the database: `@hushjot/core` publishes the
 * codec to a second client that has no IndexedDB, and importing it from the
 * schema dragged `IDBDatabase` and `IDBTransaction` into that package's public
 * types. `schema.ts` re-exports it, so nothing that used to import it from
 * there had to change.
 */
export type Encoded = string | Uint8Array;

export interface NoteMetaPayload {
  title: string;
  folderId: string | null;
  /**
   * When the note was pinned, or null. Inside the sealed blob like the title:
   * which notes a user keeps at the top is theirs, not the database's.
   *
   * Absent on every record written before pins existed, and on records an
   * older build re-saves — read it through `readNoteMeta`, never raw.
   */
  pinnedAt: number | null;
  /**
   * The opening of the body, for the second line of a phone note row
   * (`excerptOf` in `core/notes/model.ts`). Sealed like the title, and for the
   * same reason: what a note says is the user's, not the database's.
   *
   * Optional, and omitted when empty — see `noteMetaJson`. Absent on every
   * record written before excerpts existed and on records an older build
   * re-saves, so read it through `readNoteMeta`, never raw.
   */
  excerpt?: string;
  /**
   * When the note was created, for the "Date created" sort
   * (`comparatorFor` in `core/notes/model.ts`).
   *
   * Sealed rather than a plaintext column beside `updatedAt`, for the reason
   * `schema.ts` gives: anything the database can read is something we have
   * promised not to encrypt, and sorting 10,000 notes in memory costs ~3.4 ms,
   * so there was nothing to buy by leaking a second timestamp.
   *
   * Optional, and omitted when absent — see `noteMetaJson`. Absent on every
   * record written before this field existed; `loadAllMeta` is the one place
   * that resolves that, falling back to the row's `updatedAt`. Read it through
   * `readNoteMeta`, never raw.
   */
  createdAt?: number;
}

/**
 * The JSON a meta payload is sealed as. Every optional field is omitted when
 * it carries nothing, so a note that is neither pinned nor long enough to have
 * an excerpt is byte-for-byte the shape it had before either existed: no
 * growth across 10,000 notes, and nothing new for an older build to read.
 *
 * Field order is fixed and append-only. It is not load-bearing — the reader is
 * `JSON.parse` — but keeping it stable means two builds sealing the same note
 * produce the same plaintext, which is what makes a diff of the stored bytes
 * mean something while debugging.
 */
export function noteMetaJson(payload: NoteMetaPayload): string {
  const { title, folderId, pinnedAt, excerpt, createdAt } = payload;
  const out: Record<string, unknown> = { title, folderId };
  if (pinnedAt !== null) out.pinnedAt = pinnedAt;
  if (excerpt) out.excerpt = excerpt;
  if (createdAt !== undefined) out.createdAt = createdAt;
  return JSON.stringify(out);
}

/**
 * Normalise a decoded meta payload. `JSON.parse` hands back `undefined` for a
 * field the writer never knew about, and an `undefined` that leaks past here
 * compares unequal to `null` everywhere it is checked.
 */
export function readNoteMeta(raw: Partial<NoteMetaPayload>): NoteMetaPayload {
  return {
    title: raw.title ?? '',
    folderId: raw.folderId ?? null,
    pinnedAt: typeof raw.pinnedAt === 'number' ? raw.pinnedAt : null,
    // Absent rather than empty-string, so `noteMetaJson` round-trips a record
    // written by an older build back to the bytes it started as.
    ...(typeof raw.excerpt === 'string' && raw.excerpt ? { excerpt: raw.excerpt } : {}),
    // Absent rather than 0, for the same round-trip reason, and because 0 is a
    // real instant that would sort a pre-`createdAt` note to the very end.
    ...(typeof raw.createdAt === 'number' ? { createdAt: raw.createdAt } : {}),
  };
}

export interface FolderPayload {
  name: string;
  parentId: string | null;
}

/**
 * Every method takes the id of the record the value belongs to. The encrypted
 * codec binds each envelope to it (`crypto/envelope.ts`, "Version 2"), so a
 * blob only decodes for the note or folder it was written for; the plaintext
 * codec has nothing to bind and ignores it.
 */
export interface Codec {
  readonly name: string;
  encodeNoteMeta(id: string, payload: NoteMetaPayload): Promise<Encoded>;
  decodeNoteMeta(id: string, value: Encoded): Promise<NoteMetaPayload>;
  encodeBody(id: string, content: string): Promise<Encoded>;
  decodeBody(id: string, value: Encoded): Promise<string>;
  encodeFolder(id: string, payload: FolderPayload): Promise<Encoded>;
  decodeFolder(id: string, value: Encoded): Promise<FolderPayload>;
}

function asString(value: Encoded): string {
  if (typeof value === 'string') return value;
  // Tolerates reading records written by a different codec generation.
  return new TextDecoder().decode(value);
}

/**
 * Phase 2 codec: stores readable JSON and text.
 *
 * This is not a security posture, it is a placeholder with a deadline. The
 * database it produces is readable by anything with access to the browser
 * profile — see the Phase 2 caveat in `schema.ts`.
 */
export const plaintextCodec: Codec = {
  name: 'plaintext',

  async encodeNoteMeta(_id, payload) {
    return noteMetaJson(payload);
  },

  async decodeNoteMeta(_id, value) {
    return readNoteMeta(JSON.parse(asString(value)) as Partial<NoteMetaPayload>);
  },

  async encodeBody(_id, content) {
    return content;
  },

  async decodeBody(_id, value) {
    return asString(value);
  },

  async encodeFolder(_id, payload) {
    return JSON.stringify(payload);
  },

  async decodeFolder(_id, value) {
    return JSON.parse(asString(value)) as FolderPayload;
  },
};
