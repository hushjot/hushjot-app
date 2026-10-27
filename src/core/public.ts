/**
 * The published surface of `@hushjot/core`.
 *
 * This file exists because there is a second client. The CLI and MCP server
 * (`@hushjot/cli`) run in Node, hold the key on the
 * operator's machine, and speak the same Firestore protocol as the browser. The
 * one thing they must never do is *reimplement* the format — the envelope
 * framing, `noteMetaJson`'s omit-when-null rule, `deriveTitle`, `excerptOf`, the
 * tokeniser. Every one of those is a place "Invariants that are easy to break"
 * in CLAUDE.md records a bug that already happened once, and a second
 * implementation is a second chance at each of them. So the CLI imports them
 * rather than owning them, and this barrel is the list of what it may import.
 *
 * **It is a list, not a re-export of the directory.** Naming each entry is the
 * point: admitting a symbol here makes it an API with a release cycle, and
 * removing one later is a breaking change for a package this repo does not
 * control. Everything below is already exercised from Node — the unit suite
 * runs in vitest's default `node` environment with no polyfills and no
 * `fake-indexeddb`, and imports these modules directly.
 *
 * **Deliberately absent**, and each for a reason rather than an oversight:
 *
 * - `repo/` above `codec.ts`, and `search/worker.ts` — IndexedDB. The CLI keeps
 *   a ciphertext cache on disk instead; `NoteRepository` is a 30-method
 *   interface bound to a storage engine Node does not have.
 * - `portability/`, `share/`, and `history/` beyond the two helpers below —
 *   adding these to the package before something needs them would be
 *   committing to an API on speculation, which §28's spirit is against. The
 *   CLI's `replace` needs exactly two things from history: how a version is
 *   named (`sealIdOf`) and how long one is kept (`TIER_MONTH_MS`), so that a
 *   copy it uploads before overwriting is the same record the app would have
 *   made and shows up in the app's History panel.
 * - all of `src/ui/` and `src/adapters/` — the layering rule. `src/core/**` is
 *   free of DOM, Svelte and Firebase, which is exactly what makes it portable;
 *   nothing above that line can be.
 *
 * Anything added here must also gain a case in `contract/format-vectors.json`
 * if it touches stored bytes. That file is how drift between the two repos
 * fails a test instead of corrupting a vault.
 */

/**
 * Bumped when stored bytes change shape. The CLI refuses a core it cannot read.
 *
 * It did **not** move for `NoteMetaPayload.createdAt`, and the reasoning is
 * worth keeping because the next additive field will ask the same question.
 * Every frozen vector in `contract/format-vectors.json` still verifies
 * unmodified — the field is omitted when absent, so no existing byte changed
 * shape — and an older core reads a record carrying it without complaint,
 * which is the property this number tracks. The real hazard was the other
 * direction: an older *writer* drops an unknown field, so `hushjot append`
 * would have stripped the created date from any note it touched. That is fixed
 * in the CLI in the same change rather than announced by a version bump, and
 * `tests/unit.test.ts` there fails if it regresses. Moving this would have said
 * "the envelope or the omission rules changed", and neither did.
 *
 * It **did** move to 2 for the bound envelope (`crypto/envelope.ts`, "Version
 * 2"). A core at 1 cannot open a version-2 record at all, and a writer at 1
 * would keep sealing unbound records into a vault that is trying to leave
 * them behind — both are exactly what this number exists to refuse.
 */
export const FORMAT_VERSION = 2;

// --- bytes -----------------------------------------------------------------
// Base64 here is *standard, padded* — the encoding Firestore's REST API uses
// for a `bytesValue`, and the encoding the key record is serialised in. The
// base64url pair is for share links, and is the one that must not be confused
// with it.
export {
  alloc,
  concat,
  fromBase64,
  fromBase64Url,
  fromUtf8,
  randomBytes,
  timingSafeEqual,
  toBase64,
  toBase64Url,
  utf8,
  type Bytes,
} from './crypto/bytes.ts';

// --- envelope --------------------------------------------------------------
// The wire format every sealed byte in the product shares:
//
//   [0]      version (u8) = 1
//   [1]      alg id  (u8) = 1 (AES-256-GCM)
//   [2..14)  nonce, 12 random bytes
//   [14..]   ciphertext || 16-byte GCM tag
//
// Bytes [0..2) are the additional authenticated data, so the algorithm byte
// cannot be rewritten to negotiate something weaker without failing the tag.
export {
  ACCEPT_UNBOUND_LEGACY,
  ALG_AES_256_GCM,
  DecryptError,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_BOUND,
  exportKey,
  generateDek,
  importKey,
  open,
  openText,
  seal,
  sealText,
} from './crypto/envelope.ts';
export { isUnboundEnvelope, recordContext, type RecordKind } from './crypto/binding.ts';

// --- key derivation --------------------------------------------------------
// `deriveKekFromPassphrase` runs Argon2id in a Web Worker in the browser and
// falls through to `hash-wasm` on the calling thread when there is no global
// `Worker` — which is Node. That guard is what makes this module portable at
// all, and `tests/unit/keyRecord.test.ts` has depended on it since Phase 3.
export {
  DEFAULT_ARGON2_PARAMS,
  KdfError,
  deriveKekFromPassphrase,
  deriveKekFromRecoveryCode,
  normalizeCode,
  type Argon2Params,
  type DerivedKey,
} from './crypto/kdf.ts';

// --- key record ------------------------------------------------------------
// A CLI is a *reader* of the account's key record and never a writer: the rules
// permit create and update on `users/{uid}/keys/primary` and refuse delete
// outright, so a record written from outside the app would be permanent. The
// write half (`createKeyRecord`, `changePassphrase`, `rotateRecoveryCode`,
// `setPassphraseWithRecoveryCode`) is therefore not published.
//
// The last of those is the one that would matter most. It needs no passphrase
// at all, only a recovery code, so publishing it would put a full
// account-takeover primitive — write a new passphrase wrap from a code sitting
// in a config file — into a package that has no interactive confirmation
// anywhere in it, and the record it wrote would be permanent.
export {
  KEY_RECORD_VERSION,
  WrongSecretError,
  deserializeKeyRecord,
  sameKeyRecord,
  serializeKeyRecord,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  type KeyRecord,
  type SerializedKeyRecord,
} from './crypto/keyRecord.ts';

export { canonicalize, format, looksLikeRecoveryCode } from './crypto/recoveryCode.ts';

// --- the sealed payloads ---------------------------------------------------
// `noteMetaJson` and `readNoteMeta` are the plaintext *inside* a meta envelope.
// A note body has no wrapper at all — it is the Markdown as UTF-8.
export {
  noteMetaJson,
  readNoteMeta,
  type Codec,
  type Encoded,
  type FolderPayload,
  type NoteMetaPayload,
} from './repo/codec.ts';

// --- notes -----------------------------------------------------------------
// `deriveTitle` and `excerptOf` are the two that matter most to a second
// client: a title is *derived*, never user-edited, so a CLI that computed one
// differently would write a different title than the browser would for the same
// text, silently and forever. `excerptOf` has the same property plus a trap —
// the excerpt is sealed into the meta and must be written back there, or pinning
// a note blanks the second line of its phone row.
export {
  DEFAULT_NOTE_SORT,
  UNTITLED,
  byRecency,
  comparatorFor,
  createNote,
  deriveTitle,
  excerptOf,
  filterForList,
  isDefaultSort,
  orderForList,
  pinnedCount,
  toMeta,
  withContent,
  withFolder,
  withPinned,
  type CreateNoteOptions,
  type ListFilter,
  type Note,
  type NoteMeta,
  type NoteSort,
  type NoteSortKey,
  type SortableNote,
} from './notes/model.ts';

export {
  ancestorIds,
  buildTree,
  canMoveFolder,
  createFolder,
  flattenTree,
  folderPath,
  foldersMatching,
  subtreeIds,
  visibleRows,
  type Folder,
  type FolderNode,
} from './notes/folders.ts';

export {
  MAX_TAG_LENGTH,
  TAG_PATTERN,
  extractTags,
  normaliseTag,
  tagMatches,
  tagTree,
  type Tag,
  type TagRow,
} from './notes/tags.ts';

export { countWords } from './notes/text.ts';

// --- search ----------------------------------------------------------------
// The index is pure and holds tokens, never text. A CLI feeds it from its own
// ciphertext cache instead of from `worker.ts`'s IndexedDB read, and nothing in
// the class changes. Note what it does *not* store: a hit is an id and a score,
// so turning one into a snippet means re-reading that note's body.
export {
  SearchIndex,
  tokenize,
  type IndexDocument,
  type SearchHit,
  type SearchOptions,
  type TagCount,
} from './search/index.ts';

// The query grammar, published because the CLI shares the search box's one.
// `parseQuery` is where `#tag`, `in:`, `"phrase"` and `-` are decided; it does
// not resolve `in:` to ids, because folder names are sealed and only a client
// that has opened them can. `foldersMatching` above is the shared resolver.
export {
  hasPositiveTerm,
  normalisePhrase,
  parseQuery,
  type ParsedQuery,
} from './search/query.ts';

// --- the sync wire ---------------------------------------------------------
// Types and the error vocabulary only; `SyncAdapter` itself is the browser's
// engine seam and a CLI implements none of it. `RevisionConflictError` and
// `SyncNotApprovedError` are published because telling those two apart is the
// single sharpest thing a second client has to get right: Firestore reports a
// stale revision and "you may not write here" with the same code, and reading
// one as the other forks a note on every retry.
export {
  PayloadTooLargeError,
  RevisionConflictError,
  SessionExpiredError,
  SyncNotApprovedError,
  TransientSyncError,
  type ApprovalState,
  type AuthUser,
  type PullResult,
  type RemoteFolder,
  type RemoteNote,
  type SyncCursor,
} from './sync/adapter.ts';

// The cost lockdown's sentinel. A refusal is either "this account may not sync"
// or "every client is refused for now", and only a read of this one path tells
// a second client which — see the header of `sync/pause.ts`.
export { LOCKDOWN_SENTINEL, SyncPausedError, type PauseVerdict } from './sync/pause.ts';

// The storage meter. A second client must move it in the same commit as every
// note write, or the rules refuse the write once enforcement is on, so the
// path, the month key and what counts are shared here, not written out again.
// See the header of `sync/usage.ts` for the wire shape.
export {
  BASE_STORAGE_BYTES,
  DAILY_PUSH_LIMIT,
  HISTORY_BYTES_PER_MONTH,
  MIN_CHARGED_BYTES,
  PUSH_WINDOW_MS,
  PushLimitError,
  QuotaExceededError,
  SHARES_PER_MONTH,
  ShareLimitError,
  USAGE_DOC,
  chargedBytes,
  countedNoteBytes,
  meterDelta,
  pushWindowFull,
  usageMonth,
  type Usage,
} from './sync/usage.ts';

// Note history, as far as a second client needs it: the snapshot it uploads
// before an overwrite must be named and dated exactly as the app names and
// dates its own, or two devices capturing the same sealing would not collapse
// to one version and the rules' 31-day ceiling on `expireAt` would refuse it.
export { EMPTY_SEAL_BYTES, sealIdOf, type VersionReason } from './history/record.ts';
export { TIER_MONTH_MS } from './history/retention.ts';
