# HushJot — security design

Status: **Phase 6 complete.** The full MVP is implemented: local encryption,
encrypted cloud sync, multi-device reliability, and an installable offline PWA.

Spec §13 requires this document to state explicitly what is stored decrypted,
what is in IndexedDB, whether that content is encrypted, when keys are held,
what logout clears, and how the app behaves on a shared computer. Those answers
are in [What is stored, and where](#what-is-stored-and-where) and
[Lock, logout and shared computers](#lock-logout-and-shared-computers).

---

## The promise, precisely

**Nobody without your passphrase or recovery code can read your note titles,
note bodies, or folder names — including whoever runs the server.**

That holds **as long as the code running in your browser is the code we
published**. It is a real condition, not a formality: a web app is delivered by
its server on every load, so a host that wanted to read your notes would not
attack the cryptography, it would send you a different app. No browser app can
close that completely today. What this one does about it is in
[A malicious or coerced host](#a-malicious-or-coerced-host), and that section is
part of the promise, not a footnote to it.

Everything below is either how the promise is achieved, or an honest statement
of where it stops.

---

## Key hierarchy

```
passphrase ──Argon2id(m=64MiB, t=3, p=1, salt_p)──► KEK_p ──┐
                                                            ├──► wraps DEK
recovery code ──HKDF-SHA-256(salt_r)────────────► KEK_r ──┘

DEK (256-bit, random) ──AES-256-GCM──► note bodies, note metadata, folder names
```

**The DEK is random, never derived from the passphrase.** Two consequences that
drove the design:

- Changing the passphrase re-wraps 32 bytes. It does not re-encrypt a single
  note. `keyRecord.test.ts` asserts this by checking existing ciphertext is
  byte-identical afterwards.
- Two independent secrets open the same vault without either deriving the other.
- **The corollary: changing a secret revokes nothing.** A device that is
  already unlocked, or holds the key under "Stay unlocked", keeps the same DEK
  and keeps decrypting after a passphrase or recovery-code change elsewhere.
  For a lost or stolen device the steps are: sign that account out everywhere
  the provider allows, lock or remove data on any device you still control, and
  change the passphrase so the old one stops unwrapping the account's key
  record. None of that re-keys the notes; DEK rotation is open item 4.

**Why two different KDFs.** A passphrase is human-chosen and low-entropy, so its
derivation must be expensive and memory-hard — that is Argon2id's job. A
recovery code is 160 bits from a CSPRNG; there is no dictionary to guess and
2^160 is unreachable, so stretching it buys nothing. Spending 100 ms of
Argon2id on it would be cargo-culting the expensive option onto a case that
does not need it.

### Parameters

| | value | note |
|---|---|---|
| KDF | Argon2id | via `hash-wasm`, in a Web Worker |
| memory | 64 MiB | OWASP floor is 19 MiB |
| iterations | 3 | |
| parallelism | 1 | |
| salt | 32 bytes, random, per vault | |
| measured, laptop | 94.7 ms | Apple M4, Spike 2 |
| measured, phone | **232.7 ms** | Google Pixel 9a, 21 Sep 2026 |

Parameters live **in the key record**, not in code, so they can be retuned later
without invalidating existing vaults.

> **Settled on hardware, 21 September 2026.** A Google Pixel 9a derives at
> **232.7 ms** p50 warm (264.4 ms p95), against a 1.5 s budget — 6.4× of
> headroom — with no allocation failure at 64 MiB. Cold first unlock, which
> includes worker startup and the wasm fetch, is 456 ms. The parameters stand
> unchanged.
>
> This replaces an earlier estimate that has to be read carefully. A
> phone-profile run at 6× CPU throttle unlocked in ~220 ms end to end
> (`npm run bench:mobile`), and that figure was **never** a phone measurement:
> CDP throttling scales CPU scheduling, while Argon2id's cost is random access
> across 64 MiB, which throttling barely touches. That reasoning was right, and
> it is why the real run happened. The extrapolation built on it — 4–8× slower,
> 400–800 ms — was pessimistic by about double.
>
> **One device, and the upper half of mid-range**: a Tensor G4 with 8 GB of
> LPDDR5X. A 4 GB phone on a low-tier SoC could be 2–3× slower again, which
> still lands near 700 ms. The conclusion rests on the measurement *plus* the
> headroom. The allocation question generalises less well — see open item 2.

### Settling it on hardware

`npm run bench:kdfDevice` builds the measurement page, serves it on the LAN, and
prints the address to type into the phone. It drives the production KDF worker,
creates no vault and stores nothing, and takes about two minutes: a cold first
derivation, the Spike 2 candidate grid, a 45-second soak, then the grid again.
**Quote the second pass** — a phone's first derivation is its fastest, and a
user unlocking mid-use gets a warm, thermally-limited core.

On the phone, before tapping Run: screen timeout to its longest setting, battery
saver off, unplugged from the charger, other apps closed. Then stay in the tab
for the whole run. A hidden or sleeping tab is throttled and the timings it
produces look entirely reasonable, which makes it the most dangerous way this
measurement fails; the page records `backgroundedDuringRun` so it can be caught,
and a run with that flag set must be discarded rather than interpreted. Write the
handset model down by hand — Chrome's reduced user-agent and the
secure-context-gated `navigator.deviceMemory` leave nothing in the JSON that
identifies it.

The rule below was written down *before* the number, so the measurement settled
the question instead of being argued with afterwards. It **fired on 21 Sep 2026
and selected the first row** — 232.7 ms, no allocation failure, keep. It is kept
here as the procedure for the next device, not as a pending decision.

| second-pass p50 | decision |
|---|---|
| ≤ 1.5 s, no allocation failure | **keep m=64 MiB, t=3.** ← selected, 232.7 ms |
| > 1.5 s | **iterations first**: t=3 → t=2, memory held at 64 MiB. |
| still over, or allocation fails | only then 64 → 32 MiB, never below m=19 MiB / t=2. |

Iterations come down before memory, and this reverses what `bench/spikes/kdf.ts`
originally said. Memory-hardness is the entire reason this is Argon2id rather
than PBKDF2: t=3 → t=2 makes each guess 1.5× cheaper, while 64 → 32 MiB halves
an attacker's memory cost per parallel guess, which concedes more of the thing
worth keeping.

Allocation failure is the outcome to watch for, not latency. A mobile browser
under memory pressure can refuse a 64 MiB allocation in a worker, and that is
not a slow unlock — it is a device that cannot open its own notes. The page
reports a refusal as its own verdict for that reason. The Pixel 9a, with 8 GB,
never came close; the case that would actually provoke it — a 4 GB phone under
pressure — is still untested, and is the live half of open item 2.

A retune reaches new vaults immediately and existing ones only through a
re-wrap, which re-stamps whatever parameters it is given. Three of those exist
and all three are reachable from the app: changing the passphrase, re-issuing
the recovery code, and setting a new passphrase from the recovery code. So a
user who does any one of them lands on the current parameters; a user who does
none of them keeps the parameters their vault was created with, indefinitely.
There is still no *standalone* "re-wrap at today's parameters" action — see open
item 4, which is now narrower than it was.

---

## The passphrase itself

Argon2id at these parameters buys roughly 15–17 bits against offline guessing.
That is a multiplier on the passphrase, not a substitute for one, and it is the
reason tuning the KDF in isolation would be sharpening the stronger blade: a
ten-character human choice can be worth less than the KDF adds.

`src/core/crypto/passphrase.ts` is the other half. Both of its wordlists sit
behind a dynamic `import()`, so none of this is on the unlock path or in the
160 KB critical-path budget.

**Generate.** Six words drawn with `crypto.getRandomValues` from the EFF short
wordlist — 1296 words, so 10.34 bits each and ~62 bits in total. Selection is
rejection-sampled rather than `% 1296`, because 2^32 is not a multiple of 1296
and a modulo would leave the first 448 words slightly likelier. The words are
the encoding, not the entropy: the same split `recoveryCode.ts` makes between
160 random bits and the Crockford base32 a human copies down. This is the
highest-value control on the screen, because the best outcome is that the user
never chooses a passphrase at all.

**Estimate.** Several models run and the **lowest** wins, because a real
attacker also picks their best model. A charset model scores "correct horse
battery staple" at 131 bits; the word model scores it at 44, and 44 is the
honest number. There are also models for repeats, keyboard and alphabet runs,
and — the only one that blocks a submission — a known password wearing a
decoration. That last one folds leet substitutions and looks for the longest
entry of a 1000-password list *inside* the result, so `P4ssw0rd!x` scores ~24
bits rather than the ~66 its character classes would suggest. It only fires when
the match dominates the string, since blocking a good passphrase that merely
contains a common word would be the worse failure.

**What it does not do.** The estimate is a floor, reported as bits and a word,
and it is not calibrated well enough to quote a crack time. It cannot tell a
random ten-character string from a person typing one that looks random — both
score ~66 bits, and marking the second down would be theatre. `zxcvbn` would
estimate better and costs ~800 KB to tell a user something they can fix in one
click on the generator, which is the wrong trade under §28.

Only two things block creation: the ten-character minimum, and the
common-password verdict. Everything else advises, because advice dressed as a
failure is how people learn to click past it.

---

## Encryption envelope

```
[0]      version  (u8)  = 1 (unbound) or 2 (bound to a record)
[1]      alg id   (u8)  = 1 (AES-256-GCM)
[2..14)  nonce    (12 bytes, random per encryption)
[14..]   ciphertext || 16-byte GCM tag
```

- **AES-256-GCM** via WebCrypto. No cryptography is implemented here; this is
  framing around `crypto.subtle` (§33.6).
- **The header is authenticated** — passed to GCM as additional authenticated
  data — so an attacker cannot rewrite the algorithm byte to negotiate a weaker
  format without failing the tag check. Tested.
- **Every note, folder and share-key record is bound to its slot (version 2).**
  The AAD is the two header bytes followed by `hushjot:<kind>:<id>` — kind is
  `note-meta`, `note-body`, `folder` or `share-key`. The context is supplied by
  the opener, not stored, so no blob grew. Without it (version 1, everything
  before format 2) GCM proved a blob unmodified but not that it belonged where
  it was found: whoever holds the database or the Firestore project could move
  one note's body into another note's slot, or a meta blob into a folder's, and
  it would decrypt as that record. Now it fails authentication, with the same
  error as a wrong key. A bound envelope relabelled as version 1 fails too,
  because its tag was computed over the context. Tested in
  `tests/unit/envelope.test.ts`, `codec.test.ts` and the format vectors.
- **Key-record wraps and share payloads stay version 1** on purpose: each is
  sealed under a key that seals exactly one thing, so there is nothing to
  substitute, and binding them would mean migrating key records for no gain.
- **Rollback is not covered by the binding.** An *older* valid sealing of the
  same record still verifies in that record's slot. Against the server, the
  defence is the revision compare-and-swap in `firestore.rules` and the
  monotonic local revision — a server that serves an old revision can show you
  an old version of your note, not someone else's text and not a forgery.
  History versions are, by design, older sealings of the same note.
- **The legacy window.** Vaults created before format 2 hold version-1 records,
  and so do the server's copies of notes not edited since and up to thirty days
  of history. `ACCEPT_UNBOUND_LEGACY` in `envelope.ts` keeps them readable. On
  the first unlock after upgrading, `resealLegacyRecords`
  (`core/repo/migrateToEncrypted.ts`) re-seals every version-1 record on that
  device in the background and marks the database done; it queues nothing for
  sync (the plaintext is unchanged, so pushing would only race other devices
  into conflict copies), and the server's version-1 copy is replaced the next
  time the note is edited. **While the window is open, substituting a version-1
  blob is still possible**, so it is a planned close, not a permanent state:
  turning `ACCEPT_UNBOUND_LEGACY` off is a format change (it moves
  `FORMAT_VERSION`), and must first re-push every remaining version-1 record
  from a device that holds the key, and wait out the thirty-day history tail.
- **Nonces are random per encryption**, never counter-derived. A counter that
  restarts (a device restored from backup, a corrupted write) would repeat a
  nonce, which is catastrophic for GCM.
- **Identical plaintext produces different ciphertext.** Deterministic output
  would leak which notes are identical.
- **A wrong key and a tampered payload produce the identical error.**
  Distinguishable errors would be an oracle. Tested.

There is no separate "verifier" field in the key record: GCM's tag already fails
on the wrong key, so a failed unwrap *is* the wrong-passphrase signal. Adding a
verifier would hand an offline attacker a cheaper target than the real one.

---

## What is stored, and where

### IndexedDB (`teksto`)

| Store | Field | Encrypted? |
|---|---|---|
| `noteMeta` | `id` | no — random UUID |
| | `updatedAt`, `revision`, `deleted` | no — needed to order and reconcile |
| | `meta` (title, folderId, pinnedAt, excerpt, createdAt) | **yes** |
| `noteBody` | `id` | no |
| | `body` (note content) | **yes** |
| `folders` | `id`, `createdAt`, `updatedAt`, `deleted` | no |
| | `data` (name, parentId) | **yes** |
| `kv` | `vault:keyRecord` | ciphertext + salts + parameters only |
| | `vault:deviceKey` | non-extractable `CryptoKey` handle |
| | `app:owner` | no — the uid of the account this database belongs to |
| | `app:seeded` | no — a flag; first-run content has been settled |
| | `app:vaultAccount` | no — the uid whose key record this device's vault is |
| | `app:keyRecordDirty` | no — a flag; this device has re-wrapped its record and the account has not been told |
| | `sync:cursor`, `sync:epoch`, `sync:note:*` | no — delta position, per-note revision anchors, and the nonce of the body each anchor refers to |
| | `sync:backfilled` | no — a flag; this device's existing notes have been queued |

**`app:owner` and `app:vaultAccount` outlive a sign-out on purpose.** Everything
`sync:`-prefixed is deleted when an account goes away, so that the next account
cannot inherit a change stream or a queue that is not its own. That wipe leaves
nothing to say *whose* notes are still on the device — and the sweep described
below keys on "never pushed", which without a binding is indistinguishable from
"belongs to the previous account". `app:owner` is that binding. It holds a uid,
which is not secret and is already in the URL of every document the device
writes. `app:vaultAccount` is the same shape answering the neighbouring
question — not *whose notes are these* but *whose key is this* — and is
described under [Signing in uploads what is already
here](#signing-in-uploads-what-is-already-here).

**The note list's excerpt is inside the envelope.** The phone's note rows show
the opening of each note under its title. That text is *not* read from the body
at render time — bodies are a separate encrypted store that `loadAllMeta` never
touches, and decrypting ten thousand of them to draw a list would be both slow
and a much larger key exposure. Instead the first ~100 characters after the
title are sealed into the meta record beside the title itself
(`excerptOf` in `core/notes/model.ts`, `NoteMetaPayload.excerpt` in
`core/repo/codec.ts`).

The consequence worth stating plainly: **the sealed meta now contains a short
piece of note body, not only its title.** It is encrypted with the same key,
under the same envelope, and goes nowhere the title does not already go — so it
changes no boundary in this document. What it changes is the blast radius of
the meta record alone: anyone who could decrypt a meta could already read the
title, and can now also read the note's first line. Since decrypting a meta
means holding the DEK, and holding the DEK means being able to decrypt the body
too, that is not a new capability.

The field is omitted when empty, so a note that is neither pinned nor long
enough to have an excerpt seals byte-for-byte as it did before either existed.
Notes written by an older build carry no excerpt until they are next saved;
their rows show the title across two lines instead.

**A note's creation date is inside the envelope too.** The note list can be
ordered by date created (`ui/noteSort.ts`), which needs a second timestamp per
note — and the obvious place to put it was beside the plaintext `updatedAt`,
where an IndexedDB index could sort on it. It is sealed instead. The rule this
follows is stated at the top of `core/repo/schema.ts`: anything the database can
read is something we have promised not to encrypt, and sorting ten thousand
notes in memory costs about 3.4 ms, so an index would have bought nothing for a
second piece of metadata in the clear. `updatedAt` is unavoidably plaintext
because reconciliation and the delta cursor are built on it; `createdAt` is not,
so it is not.

Like the excerpt, the field is omitted when absent, so every note written before
it existed seals byte-for-byte as it did. Those notes have no stored creation
date at all, and exactly one place decides what to show instead: `loadAllMeta`
in `core/repo/noteRepository.ts` falls back to the row's own `updatedAt`. That
is the note's own value rather than a clock, so every device resolves the same
number for the same note, and it freezes into the sealed record the next time
that note is written. There is no migration pass and no schema version change.

**Pins and tags add nothing in the clear.** Whether a note is pinned, and since
when, sits inside the sealed meta beside the title; an unpinned note's meta is
sealed in exactly the shape it had before pins existed, so pinning is not even
visible as a size change across the collection. Pinning a note does advance its
plaintext `revision` and `updatedAt`, as any edit does. Tags are not stored at
all: a `#tag` is text in the note body, and the tag list is derived from bodies
in memory (below).

The `sync:note:*` anchors also record the 24-hex-character nonce of the body
ciphertext the backend last agreed to. A nonce is already in the clear inside
every envelope; recording it lets a rejected push tell a metadata-only change (a
pin, a move) from a text edit by comparing bytes, without decrypting anything
(`src/core/sync/state.ts`).

**Why `updatedAt` and `revision` are in the clear:** they are what the database
indexes and what sync reconciles. Anything indexed is something we have promised
not to encrypt, so the set is kept to the minimum that makes ordering and
conflict detection work. Spike 3 confirmed there is no performance argument for
leaking more — sorting and filtering 10,000 notes in memory costs ~3.4 ms.

### IndexedDB (`teksto-history`)

Note history (`src/core/history/`) keeps earlier versions of notes in a database
of its own, so that a schema change there can never block an upgrade of the note
database and strand a user in an empty workspace. A version is a **byte-for-byte
copy of the note's stored ciphertext**, taken just before something replaced it:
at the start of an editing session, every 10 minutes during a long one, and
before a delete or a restore. Nothing is decrypted or re-encrypted to take one.

| Store | Field | Encrypted? |
|---|---|---|
| `versions` | `id` (`noteId:sealId`), `noteId` | no — random UUID plus the body's nonce |
| | `sealId` | no — the body envelope's 96-bit nonce, which is already in the clear inside the ciphertext |
| | `at`, `capturedAt`, `expireAt` | no — when the text was current, when it was copied, when it expires |
| | `reason` (`edit`, `delete`, `restore`), `bytes`, `state` | no — needed to label, prune and (later) sync without decrypting |
| | `meta` (title, folderId, excerpt, createdAt) | **yes** — copied ciphertext |
| | `body` (note content) | **yes** — copied ciphertext |
| `meta` | `prunedAt` | no — when retention last ran |

Versions expire by tier: every version for 24 hours, the first of each UTC hour
for 7 days, the first of each UTC day — and a deleted note's final text — for
30 days. Past a size cap (50 MB, or 5 % of the origin's quota if smaller) the
shortest-lived versions go first.

**What this adds for someone holding the database.** Before history, a copy of
IndexedDB showed each note's *current* size and last-modified time. It now also
shows a 30-day timeline of each note's editing sessions, deletes and restores,
with sizes. That is the same class of metadata already listed under
[Not defended](#not-defended--and-why), over a longer window. **Deleting a note
no longer removes its text from this device at once**: the ciphertext stays in
this database for 30 days so Recently deleted can offer it back. "Remove local
data" deletes this database with the notes.

When sync is on, versions are also uploaded to the account — see the next
section — and versions another device kept are fetched into this database when
the history panel or Recently deleted asks for them (`state: remote`).

### Firestore (Phase 4)

| Path | Field | Encrypted? |
|---|---|---|
| `users/{uid}/notes/{id}` | `meta` (title, folderId, pinnedAt, excerpt, createdAt) | **yes** — `bytes` |
| | `body` (content) | **yes** — `bytes` |
| | `revision`, `updatedAt`, `deleted` | no — reconciliation fields |
| | `syncedAt` | no — **server** clock, set by `serverTimestamp()` |
| `users/{uid}/folders/{id}` | `data` (name, parentId) | **yes** — `bytes` |
| | `createdAt`, `updatedAt`, `deleted` | no — reconciliation fields |
| | `syncedAt` | no — **server** clock, set by `serverTimestamp()` |
| `users/{uid}/keys/primary` | `record` | wrapped key + salts + KDF parameters; the only id the rules accept is `primary` |
| `users/{uid}/usage/current` | `bytes`, `hist`, `shares`, `pushes`, `ws`, `pn`, `lastDoc` | no — the meter: stored size, monthly uploads, pushes in the current day, and the last document written. See [Usage limits](#usage-limits) |
| `shares/{shareId}` | `payload` (title and body of one note) | **yes** — `bytes`, under a key that is **not** the vault's |
| | `createdAt` | no — **server** clock, set by `serverTimestamp()` |
| | `expireAt` | no — when the link stops working; at most 31 days out |
| `users/{uid}/shares/{shareId}` | `key` (the share's own key) | **yes** — `bytes`, sealed under the DEK |
| | `noteId`, `createdAt`, `expireAt` | no — the owner's list, so a link can be copied again or withdrawn |
| `users/{uid}/notes/{id}/versions/{sealId}` | `meta` (title, folderId, pinnedAt, excerpt, createdAt) | **yes** — `bytes`, copied from the note |
| | `body` (content) | **yes** — `bytes`, copied from the note |
| | document id | no — the body's nonce, already in the clear inside `body` |
| | `at`, `reason` | no — when the text was current; `edit`, `delete` or `restore` |
| | `createdAt` | no — **server** clock, set by `serverTimestamp()` |
| | `expireAt` | no — when it expires; at most 31 days out |

**Note versions on the backend.** A version is the note's own ciphertext, copied,
so it adds no new kind of secret — but it does add *history* the server can see.
Before, the backend held each note's current ciphertext and a revision counter.
It now also holds up to 30 days of earlier ciphertexts per note, with when each
was current and whether it preceded an edit session, a delete or a restore. That
is a timeline of editing sessions and their sizes, and it is stated here rather
than hidden. Two consequences worth saying plainly:

- **Deleting a note does not remove its text from the backend.** With the TTL
  policy, which is active, it goes up to 30 days later, typically within a day
  of expiry (docs/firebase-setup.md, "Version and share expiry"). Until then it
  is hidden by the app but present, and it stays encrypted throughout. Someone deleting a pasted secret should know that
  the ciphertext outlives the delete; a leaked key would open it for as long as
  it exists.
- **No client can delete a version**, not even its owner. That is deliberate: a
  stolen session could otherwise overwrite a user's notes *and* erase the history
  that lets them recover. Expiry is the only way out.

Versions are uploaded only when this device's vault is demonstrably the
account's (the same gate as the backfill sweep), and never from a database bound
to a different account. They are read on demand — opening the history panel,
selecting a deleted note — and are never part of the delta pull or the listener.

Ciphertext is stored as Firestore's native `bytes`, never base64: base64 would
waste a third of the 1 MiB per-document budget, and the rules **reject strings**
so a client that skipped encryption fails loudly instead of silently uploading
readable notes.

### Usage limits

What one account can cost is bounded by the rules, not by the client, because
the threat that matters for the bill is a modified or compromised client
(`src/core/sync/usage.ts` and the meter section of `firestore.rules` have the
mechanics):

- **Storage.** 1 GiB per account plus add-ons (`entitlements/{uid}.storageBytes`).
  Every stored note and folder counts `max(size, 1 KiB)` — a document costs
  something to store whatever its ciphertext weighs — and a tombstone keeps
  its 1 KiB, because it is never removed. So an account holds at most about a
  million documents, however small.
- **Pushes.** 20,000 metered commits per account per day, by a window the
  server's clock opens and closes (`ws`, `pn` on the meter). Every note, folder,
  version and link write is one, the public share document included. The window
  is fixed rather than sliding, so a burst across a reset can reach twice that
  in 24 hours; the average is what is bounded.
- **History and links.** 500 MB of versions and 100 links per calendar month,
  each version its own commit so every one is counted exactly.
- **Ids and shapes.** Note and folder ids are at most 64 characters of
  `[A-Za-z0-9_-]`; the key record is one document, `primary`, whose map is held
  to its known fields with every string capped (under 3 KiB in all). A folder is
  capped at 16 KiB and any ciphertext at 900 KiB.

The meter adds no new secret — the backend already saw every write — but it
does record how often an account writes, in one place. A client cannot lower
any of it: increments are server-side, the rules tie every change to the
document it names, and the meter cannot be deleted.

`syncedAt` must equal `request.time`, enforced in the rules. A device with a
skewed clock therefore cannot hide its writes from another device's delta
cursor, nor jump ahead of it.

**A folder's `updatedAt` is plaintext, and is a client clock.** Folders carry no
revision and get no compare-and-swap: there is no user text in one to lose, only
a name and a parent, so §16's "preserve both versions" does not apply and the
later write wins. `updatedAt` is what "later" is decided by. It leaks when a
folder was renamed, which is the same class of metadata as a note's `updatedAt`
and is already implied by `syncedAt`. It is optional in the rules so that a
device running an older client is not locked out mid-rollout; a folder without
one has only ever been created, and readers fall back to `createdAt`.

**The delta cursor is a `(syncedAt, documentId)` pair, one per collection.**
Both halves of that are load-bearing, and getting either wrong lost documents
permanently rather than merely delaying them.

*One position per collection,* because notes and folders are read with separate
queries, each with its own page limit, and the two reads do not share a server
snapshot. A single position let one collection's newest timestamp carry the
cursor past documents the other had not delivered yet.

*A document id alongside the timestamp,* because `serverTimestamp()` is
millisecond-resolution and a burst of writes gives several documents the same
value. Paginating on the timestamp alone skipped whichever of those ties fell
beyond a page boundary. Pagination is `startAfter(timestamp, id)` over
`orderBy(syncedAt, documentId())`, which is a total order; `documentId()` is
appended to every single-field index, so no composite index is needed.

See `src/adapters/firebase/cursor.ts`; `tests/rules/pull.test.ts` reproduces
both losses against the emulator.

The key record is base64 inside a map rather than `bytes` — it is a couple of
hundred bytes and portability across backends matters more there than density.

**One collection is readable without a session, and only one.** `shares/{id}`
is where a published link's ciphertext lives, and its read rule consults no
`request.auth` at all — that is what lets a recipient with no account open it.
What stands in for a session there is the URL: 128 random bits of document id,
and a key that never reaches a server. `list` is denied outright, as it is for
the allowlist, so the collection cannot be enumerated. See
[Sharing a note by link](#sharing-a-note-by-link).

**What the server can still see:** how many notes you have, roughly how large
each is, when each changed, how often you edit, and the shape of your folder
tree. Hiding that needs padding and cover traffic, which is disproportionate
here. It is stated, not fixed. Note that sync cadence sets the granularity of
the "how often you edit" part: a checkpoint every 3 s while typing describes a
writing session more finely than one every 10 s did.

### Who may sync

Authentication and authorisation are separate here, and both are server-side.
Signing in proves an identity; it does not grant access. Every path under
`users/{uid}` additionally requires `approved()`, which is one of two things:
a **paid plan**, `entitlements/{uid}` with `active == true` and an `until`
(epoch milliseconds) still ahead of the server's clock; or an **invitation**,
`allowlist/{lowercased email from the ID token}` with `active == true`. An
account with neither can authenticate and then do nothing.

Accounts are self-serve and are created on hushjot.com/account; the app has no
sign-up form and links there. Where the form lives is not the boundary, and
neither was the sign-up switch: the API key is public, so anyone could always
call the endpoint, and it is the rules that decide what an account may hold.

An account the rules refuse is also signed out by the app — at sign-in, when a
stored session is restored, and when a request is refused mid-session — but
only on an authoritative answer: a device that is offline is never signed out
for it. The sign-out drops the credential and nothing else. The vault stays
unlocked and the notes stay on the device.

Synced data is not promised forever for an account nobody pays for: it is kept
at least 90 days after a plan lapses, and after that the billing API may delete
it from Firestore, after two emailed warnings.
That purge is built but switched off in production as of October 2026. That deletes ciphertext
we could never read, and nothing on any device.

The plan document is written only by the billing API — a service account on
the billing server, driven by Paddle's signed webhooks.
No client can write it, and a lapsed plan needs no write to switch off: the
rules compare `until` to `request.time`. The billing system learns your email,
your uid, what you paid and when; it never sees a note, a title or a key.

Both documents are readable one at a time, and only your own — `list` is
denied outright, so neither can be used to enumerate who else has access.
They hold no note content, no key material, and nothing derived from either.

Revocation takes effect on the next request. A revoked device keeps working
offline and keeps every note it already has; it stops syncing and says so. It
is not a remote wipe, and nothing here can read the notes it still holds.

**A failure mode worth naming.** Firestore reports "your revision is stale" and
"you may not write here" with the same `permission-denied` code. The sync
engine answers a stale revision by preserving both versions as a conflict copy,
so an authorisation failure misread as a conflict would duplicate a note on
every retry for as long as the app stayed open. The adapter disambiguates the
two by re-reading the document — reads carry no revision check, so a read that
is also refused means authorisation — and `tests/unit/syncEngine.test.ts`
guards it.

### Multi-tab

Exactly one tab syncs, elected with the **Web Locks API**. The browser releases
the lock when the holder goes away — including a crash or force-quit — so
failover needs no heartbeat of our own. Other tabs edit and persist normally and
the leader broadcasts back over `BroadcastChannel` when remote changes land.

Without this every tab ran its own engine against the same database. The
revision compare-and-swap kept that *safe*, but it manufactured conflict copies
out of one user typing in one place.

Leadership is about the backend, not the database. Every tab writes to the same
IndexedDB and each holds its own copy of the note list, so a write in one tab is
invisible in the next until something says so — and for a while nothing did. The
only two messages described the backend ("leader, go and sync" and "leader here,
a pull landed"), and neither describes a tab writing a note. A note created in
one tab simply did not appear in the other until a reload, in both directions.
The `local` message is the one that says it, and it travels between all tabs
rather than towards the leader.

**The channel belongs to the workspace, the lock to the engine.** The two used to
share a lifetime: the coordinator opened the `BroadcastChannel`, and the
coordinator only exists inside a sync engine, which only exists with an account.
So local-only mode, a signed-out or unapproved tab, and the seconds after sign-in
before the engine starts were all deaf — two windows side by side disagreed
about which notes existed until one was focused, and a write from a tab without
an engine did not wake the leader either, leaving it to the 60 s backstop. Now
the workspace opens the channel when the vault unlocks, announces every write
and refreshes on its siblings'; the engine borrows it to route `local` into the
leader's cadence and to post `changed` and `synced`, and leaves it open when it
stops. One channel object per tab, not one per listener: a `BroadcastChannel`
never delivers to its sender, but two objects in one tab are two senders, and
the tab would hear itself. `resync` — a follower brought back into view, asking a
leader whose backstop is stretched while hidden to sync now — is the same kind of
message. The messages carry no note content — ids are not
even included — so the channel adds nothing to what another tab of the same
origin could already read from IndexedDB.

Three constraints on it, all learned the hard way:

- **It is rate-limited, not debounced.** The announcement rides the sender's
  write-scheduler drain, several times a second while someone types, so a timer
  restarted by each message would be restarted faster than it could expire and
  the other tab would show nothing until the typing stopped. One refresh per
  second, armed by the first message of a burst.
- **A sibling's write does not rebuild the search index.** A rebuild reads and
  decrypts every body — the most expensive thing the app does — and its own
  debounce is no defence against a once-a-second stream. The index is marked
  stale and settled when the tab becomes visible or the next query runs, so a
  tab nobody looks at pays nothing.
- **A sibling's write never reopens a note the user is working in.** A refresh
  that re-docs the editor takes the caret with it, and two tabs on one note is
  something people do deliberately. A remote device's edit still wins, because
  that is a different machine and §16 says it must be seen. With notes tiled,
  this is decided per tile: an untouched tile beside the one being typed in
  still picks up the sibling's edit.

### Security rules

Two jobs, both of which §15 says must not be left to the client:

1. **Isolation** — every path is gated on `request.auth.uid == uid`.
2. **Revision compare-and-swap** — an update must carry exactly
   `previous + 1`. Without it, a device with a stale copy silently overwrites
   another's edit; with it, the write is rejected and the client preserves both
   versions (§16).

Hard deletes are denied outright. Deletion propagates as a tombstone, because a
hard delete simply resurrects from another device's next push. The key record
cannot be deleted at all — losing it would orphan every note.

Note versions are **create-only**: no update, no delete, for anyone. The id must
be a 24-hex nonce, both payloads must be `bytes` under 900 KiB together,
`createdAt` must be the server clock, and `expireAt` must be a timestamp in the
future and no more than 31 days out, so no client can choose to keep text on
the backend for longer. Removal is Firestore's TTL policy on `expireAt`
(`firestore.indexes.blaze.json`, active); between expiry and the TTL's sweep
an expired version is still stored and the app ignores it.
`tests/rules/versions.test.ts` covers each refusal.

The rules tests in `tests/rules/` cover these, including every case §15 enumerates.

`users/{uid}/consents/{version}` is the one per-user path outside `approved()`:
the account page records there that the holder agreed to a version of the
terms, at sign-up or at checkout. It holds two version strings and how they
were agreed to (`via`). There is nothing secret in it. It is create-only and
stamped with the server clock, because evidence the client could edit or
backdate is not evidence. `tests/rules/consents.test.ts`.

### Backups

Firestore PITR (7 days) and weekly backups stay inside the `hushjot` project.
A weekly function also copies Firestore **and Firebase Auth**
to a bucket in a separate project, in the `US` multi-region
(a managed export cannot leave the database's location). That
bucket has a locked 30-day retention policy. None of this changes what the
server can read:
- the Firestore copies are the same ciphertext;
- the Auth copy holds what Firebase Auth already holds: emails, scrypt password
  hashes and salts. Those hashes are useless for anything but the account
  password, which is not the vault passphrase.

The scrypt hash parameters are kept out of the bucket. A copy in the vault is
retained for up to 35 days after the user deletes the original, and the
privacy policy discloses up to 60 days.
Restoring from these is covered by the operator's runbook.

### The service-worker cache

The app shell, so HushJot opens with no network (§17). Content-hashed assets, so
a cache hit is always the right bytes.

**Firebase Auth and Firestore are never cached**, and neither is any non-GET
request. A stale token served from a cache looks like a backend fault rather
than a cache one, which is close to undebuggable. Those requests reach the
network or fail honestly.

The cache holds ciphertext-free application code only — no note data ever
passes through it.

### localStorage (`teksto:journal:v2`)

**Ciphertext only**, plus a note id, revision and timestamp in the clear.

The journal exists because IndexedDB writes cannot be relied on to complete
during page teardown — measured, not assumed: `pagehide` fires, the flush
starts, the transaction never commits. `localStorage` is the only synchronous
storage API, so it is the only thing that can save text typed in the last
debounce window (§25, "user types and immediately closes tab").

Encryption is asynchronous and cannot run during teardown, so the app keeps an
up-to-date sealed copy of each open note — one per tile, at most four — as the user types (0.1 ms for a 10 KB
note, Spike 4) and writes whichever ciphertext is current when the page dies.
**The journal can therefore lag by at most one keystroke** — the price of never
letting plaintext reach localStorage.

### The operator's machine, when the CLI is installed

Two locations outside the browser, and neither exists until someone installs
`@hushjot/cli` and runs `hushjot login`. They are listed here so this section
stays the complete answer to "where is my data".

| Where | What | Encrypted? |
|---|---|---|
| OS keychain (macOS Keychain, libsecret, Windows Credential Manager) | the **raw DEK**, the account password, the refresh token | by the OS, at rest, gated by the login session |
| `~/.hushjot/cache/<uid>/store.json` | sealed note and folder rows, byte-for-byte as Firestore returned them, plus the delta cursor | **yes** — ciphertext only, as in IndexedDB |
| `~/.hushjot/config.json` | project id, API key, account email, scope folders, MCP switches | no — none of it is secret |

The passphrase itself is stored nowhere. Full reasoning, including why the
search index is deliberately *not* written to disk, is under
[The CLI and MCP server](#the-cli-and-mcp-server).

### In memory, while unlocked

- The DEK, as a non-extractable `CryptoKey`.
- The **open notes'** plaintext, and nothing else — one note per tile, at most
  four. Metadata for all notes is resident; note bodies are read on demand and
  released when their tile closes or shows another note. This is why heap at
  10,000 notes is 13 MB rather than the 410 MB Spike 3 measured when bodies
  were retained — and it keeps the plaintext-resident window narrow.
- The search index holds **tokens, not text**. It cannot reconstruct a note, and
  the worker discards each body as soon as it is indexed. That claim is the
  reason a `"quoted phrase"` is answered the way it is: matching one needs word
  *positions*, and positions stored beside the tokens would bring the index
  close enough to the note to rebuild it. So the index is left holding tokens,
  and the worker re-reads a bounded number of candidate bodies from its own
  IndexedDB connection to check the words are adjacent — reading, testing and
  dropping each, the same exposure a build already has, over far fewer notes.
  Nothing new crosses the worker boundary: the answer is still ids and scores
  (`src/core/search/phrase.ts`, `src/core/search/protocol.ts`).
- **Folder ids**, so search can be scoped to a folder. Ids only — the *names*
  are sealed and the worker never sees one, which is why `in:Work` is resolved
  to ids by the page before the query is sent.
- **Tag names.** The worker derives inline `#tags` from each body as it indexes
  and sends the page the list of names with a count for each — the one thing
  that crosses back out of the search worker besides ids and scores
  (`src/core/search/protocol.ts`). The list says nothing about which note holds
  which tag or where in it; it is the same kind of exposure as the titles the
  page already holds, and like them it is never stored or sent anywhere.

### How long local storage lasts

Everything above can be deleted by the browser. Nobody has to attack it. Safari deletes all
script-writable storage (IndexedDB, localStorage and service-worker caches, crash journal included)
after seven days without interaction, unless the site is installed to the Home Screen or Dock.
Chromium and Firefox evict under storage pressure unless `navigator.storage.persist()` was granted.
Every browser deletes it on "clear site data". The position is the one `src/core/repo/storage.ts`
states: **local storage is a cache, sync is the durability guarantee.**

The app says this out loud. `persisted()` is checked when the workspace opens; it never shows a
prompt. `persist()` is requested on the first write, because Firefox can prompt for it. While the
answer is anything but persistent and the user is not syncing to an approved account, a banner
says the notes can be deleted and offers two fixes: **Install app** and **Export**. Install
calls Chromium's deferred `beforeinstallprompt`, or on Safari says where the menu item is. Export
downloads the full zip. WebKit grants `persist()` mostly to Home Screen web apps, so on Safari
installing is the fix. × hides the banner for the session only, so it returns on the next load
until the risk is actually gone.

### Never stored anywhere by us

The passphrase, the recovery code, and any key derived from them.

---

## Lock, logout and shared computers

| Action | Key in memory | Device key | Notes on disk | Note history | Journal |
|---|---|---|---|---|---|
| **Lock** | dropped | deleted | kept (encrypted) | kept (encrypted) | cleared |
| **Sign out** | dropped | deleted | kept (encrypted) | kept (encrypted) | cleared |
| **Remove all data from this device** | dropped | deleted | **deleted** | **deleted** | cleared |
| Close the tab | dropped by the OS | kept | kept | kept | written, then replayed |

Locking flushes pending writes **before** dropping the key. Dropping it first
would turn queued edits into ciphertext for a key we no longer hold.

### Sign out locks

Sign out is Lock plus the account, and the row above says so because it did
not always. The two used to be disjoint: signing out severed the *account* —
the engine, the pull cursor, the revision anchors, the queued pushes and the
credential — and never touched the vault. The key stayed in memory, the
remembered device key stayed on disk, and every note stayed on screen behind
an account panel that did not even close itself. Someone on a borrowed machine
had done the one thing they knew to do, and it had not worked.

The lock is applied by the UI wrapper (`signOutNow` in `App.svelte`), never
inside `syncStore.signOut()`. That method is also called part-way through
signing *in*, when an account turns out to have no plan or invitation, and
throwing a user out of their own vault for that would be nonsense. The order
is the same as Lock's, with the account torn down first, because the sign-out
writes through the repository that the shutdown then closes.

What sign-out does **not** do is delete anything. The notes stay, encrypted,
and the next unlock opens them. That is the local-first promise: an account is
a way to move bytes between devices, not the thing that owns them.

### Remove all data from this device

The destructive one, and until recently it was a function with no button —
`Vault.reset()` existed, documented as "log out and remove local data", and
nothing in the app called it. Two people needed it. Someone on a machine that
is not theirs had no way to take their notes off it. And someone who had lost
**both** the passphrase and the recovery code was stranded on the unlock
screen permanently, because the vault could not be opened and nothing else in
the app is reachable while it is shut.

It is reachable from two places, and the second is the important one:

- the account panel, last and quiet, under "Export or import…";
- the **unlock screen** — "Lost both? Remove all data from this device". When
  an account is signed in, that link is "Lost both? Start over with a new
  vault" instead, because for that user removing the device's data alone is a
  loop (see [Starting over on an account](#starting-over-on-an-account)); the
  start-over dialog still offers the device-only removal as a second choice.

It deletes the `teksto` and `teksto-history` databases whole rather than
emptying stores, so nothing — including a store added by a future schema
version — can survive it, and the key record cannot outlive the notes or the
other way round. It then clears every `teksto:`-prefixed `localStorage` key:
the crash journal and ten per-device preferences, found by **scanning the
prefix rather than listing names**, because a hard-coded list is wrong the
first time somebody adds a preference and the failure is silent. Finally it
reloads, rather than trying to return the running app to a pristine state by
hand. The service-worker precache is deliberately left alone: it holds the
application, not the user's data.

The confirmation says three different things, because what is honest depends
on where else the notes exist:

| | What it says |
|---|---|
| Signed in, first sync done | The account keeps its copy. Warns separately about changes that have not reached it yet. |
| No account | These notes are on this device only and cannot be recovered. Offers an export. |
| Locked (the unlock screen) | Export is impossible — exporting means decrypting — so no export button is shown, and it says why. |

The export is never chained to the delete. `exportZip` resolves when the
download is handed to the browser, not when the file is on disk, so one button
doing both would be claiming a guarantee we do not have.

**Every unlocked tab wipes, not just the one that was clicked.** A `reset`
message goes out on the tab channel first, and each tab that hears it runs the
same teardown. This is not tidiness: a sibling holding its IndexedDB connection
turns `deleteDatabase` into a *pending* delete that `deleteDb` reports to the
caller as success, while that tab still holds the key and shows the notes. Two
tabs both requesting a delete is safe — the second is a no-op, and if one tab's
reload re-creates the database before the other's delete lands, an empty
`teksto` is the correct end state anyway, because no key record means no vault.

A tab sitting on the *lock* screen is the exception, and deliberately so: the
channel belongs to the workspace, which does not exist while the vault is shut,
so that tab hears nothing. It has no plaintext to show and its connection is
closed for it by the `versionchange` the delete fires. What it is left holding
is a stale belief that a vault exists, which its next reload corrects.

### Signing in uploads what is already here

Be clear about this one, because it is the only place where an action that looks
like authentication also moves data: **notes written on this device without an
account are uploaded to the first account that signs in on it.** Deleted notes
go too, as tombstones — a deletion that never reaches the backend comes back on
the next pull. They are uploaded as ciphertext, sealed under this device's key;
the server sees no more of them than it sees of any other note.

That is what makes signing in mean what a user expects it to mean. It is also
why two refusals exist, both in `src/core/sync/backfill.ts`:

- **A different account.** If `app:owner` names someone else, the sweep does not
  run and the device's stored notes stay local. A create cannot be undone —
  `firestore.rules` refuses deletes outright — so one user's library landing in
  another's would be permanent. Work done *after* that point syncs normally; it
  is only what was already stored that stays put.
- **A different vault.** If the account already holds a key record and this
  device holds its own, and the two cannot be shown to be the same record,
  uploading would put ciphertext on the account that none of its other devices
  can open. Nothing is uploaded, and a banner says so.

The second refusal is deliberately pessimistic, because a key record settles
the question in one direction only. It carries no identifier, `changePassphrase`
re-randomises the salts for an unchanged key, and a successful unwrap shows the
passphrase matched rather than that the key did — so two records can never be
shown to be *different* vaults. They can be shown to be the *same* one:
`createKeyRecord` draws two 32-byte salts, a random DEK and two AES-GCM nonces,
none of which a second call reproduces, so byte-identical records are one record
held in two places. `sameKeyRecord` asserts exactly that much and callers must
read `false` as "cannot tell".

Sameness is not the primary answer, though, because it stops being available the
moment a record is legitimately re-wrapped. The primary answer is **who owns the
account's record** — this device published it, or adopted it, or neither — and
it is written down, in `app:vaultAccount`, naming the account it refers to.

That marker is the fix for a bug worth recording. The answer used to live in a
variable in a Svelte component, so it was re-derived from nothing on every page
load: a device read back the key record *it had published itself*, could not
recognise its own handwriting, and concluded the vault was somebody else's. It
told the user their passphrase was wrong and retired its own backfill — and
because `sync:backfilled` is cleared on sign-out while the binding is not, the
sweep never ran again on that device. Comparison is now used once, as a
migration, to heal the installs that had already been told this.

The marker is `app:`-namespaced, alongside `app:owner`, because a vault does not
stop being the account's when a credential is dropped. It names a uid rather
than being a flag, so signing into a different account still answers no. And it
must never outlive the key it describes: it lives in the same IndexedDB database
as the key record, and `clearAll()` deletes that database whole.

Two things the marker deliberately does not do. It is a cache, not an authority
— a mismatch sends the code to ask the account, never straight to a refusal.
And it is written only after the record is known to be in place: publishing is a
read-then-write with no atomicity, so two devices signing in within one round
trip can both find an empty account and both publish. The loser reads back what
the account actually kept and declines to claim it.

**A re-wrap has to be published, and a second marker is what remembers that.**
`app:vaultAccount` answers the ownership question once and then stops asking,
which is exactly right for ownership and was silently wrong for freshness: a
device that had settled the question never uploaded a key record again, so a
passphrase changed here reached the account never, and the CLI and every device
signing in later went on being handed the old wrap. `app:keyRecordDirty` is set
*before* any re-wrap and cleared only once a publish has been written **and read
back**, so a tab closed mid-flight retries on its next sync rather than
forgetting. The flag reaches exactly one branch of the decision — the one where
this device has already proved the account's record is its own — because a
pending publish must never become a way to write over a record this device
cannot show is its. The read-back compares bytes, which is the one place that
comparison means something: these are the bytes we uploaded a moment ago, so an
echo of them is proof, where comparing a record across a legitimate re-wrap
proves nothing at all.

What the publish does **not** do is update a device that already holds its own
copy. `Vault.adoptRecord` refuses to replace an existing record, deliberately —
a hostile or stale server must not be able to swap a vault out from under a
device that has one — so a second device goes on unlocking with the old
passphrase until its user acts. It is told rather than left wrong: a device
whose record differs from the account's, and which owes the account nothing,
raises a banner saying the passphrase was changed elsewhere. Its action is the
only place that refusal is lifted, and it is lifted on evidence rather than
trust. `Vault.replaceRecord` unwraps the incoming record with the passphrase the
user types, seals a random probe under the key this device already holds, and
asks the candidate key to open it. AES-GCM's tag answers "same data key or not"
without either key's material being readable — which matters, because the DEK is
non-extractable precisely so nothing can compare it directly.

**On a shared computer this matters more than the vault does.** Anyone who can
unlock the vault can already read the notes; what is new is that signing in
moves them to their account. If that is not wanted, sign in first and write
afterwards.

That advice used to depend on the user knowing it. The setup screen now asks
how they want to start — sign in, or this device only — **before a note can be
written**, so "sign in first and write afterwards" is the path a syncing user is
already on rather than a footnote they had to find. The same question closes a
sharper hole on the way past: the screen used to offer a passphrase and a
sign-in side by side, and choosing the passphrase first on a device whose
account already had a vault produced a second one that neither side could read.
The create form is now held shut until this device can *prove* that creating a
vault will not fork the account's — which includes the whole window before
Firebase has restored a persisted session, not merely while the key record is
being fetched. `bench:phase4` asserts the create form was never reachable on a
signed-in device's journey.

### "Stay unlocked on this device"

Opt-in, default on, revoked by Lock. The DEK is stored in IndexedDB as a
**non-extractable `CryptoKey`**: JavaScript on this origin can use it to
decrypt, but Web Crypto will not hand its raw bytes to any script.

Be clear about what that does and does not buy:

- **Protects against** raw-key export — a script, including injected script,
  cannot read the key out and carry it away to use somewhere else later, and
  an export of the IndexedDB contents through the web platform yields an
  opaque handle, not key bytes.
- **Does not protect against** code running *in* the unlocked app. Injected
  script cannot take the key, but it can ask the browser to decrypt with it
  and send out the plaintext. That is the XSS row below, not this one.
- **Is not device binding.** The Web Crypto specification does not promise
  how the browser stores the key underneath, or that another process with
  the same OS privileges cannot copy the browser profile, key and all. It is
  not a hardware key; disk encryption and an OS login are still what stand
  between a stolen laptop and its profile.
- **Does not protect against** someone who already has your unlocked computer
  and browser profile. They can open the app and read your notes.

**On a shared computer, uncheck it.** Then the passphrase is required on every
load and nothing usable is left behind when you close the tab. If the notes
themselves should not be left behind either, that is
[Remove all data from this device](#remove-all-data-from-this-device).

---

## Threat model

### Defended

| Threat | How |
|---|---|
| Server operator reads notes | Server only ever receives ciphertext (Phase 4) |
| Database dump / backup leak | Titles, bodies and folder names are AES-256-GCM |
| Tampering with stored notes | GCM tag fails; no silent corruption |
| Moving a record into another's slot | Each envelope is bound to its record kind and id (version 2); see the legacy window under [Encryption envelope](#encryption-envelope) |
| Downgrade to a weaker algorithm | Header is authenticated data |
| Raw-key export from the browser | Device key is non-extractable; script can use it in place but not read it out (see above for what that does not cover) |
| Offline passphrase guessing | Argon2id, 64 MiB memory-hard, over a passphrase the user can have generated at ~62 bits |
| Correlating identical notes | Random nonce per encryption |
| Accidental overwrite or delete | Encrypted versions for 30 days, on each device and in the account; restores keep the replaced text too |
| A stolen session erasing history | Versions are create-only in the rules; only expiry removes them (TTL, once enabled) |

### Not defended — and why

| Threat | Position |
|---|---|
| **Metadata** | Note count, per-note ciphertext size, timestamps, edit frequency and folder-tree *shape* are visible to anyone holding the database — and, through note history, 30 days of each note's editing sessions and sizes, on the device and on the backend. Hiding them needs padding and dummy traffic, which is disproportionate for a notepad. Stated rather than fixed. |
| **A compromised device** | Malware or a hostile browser extension with access to an unlocked session can read plaintext. No browser app can defend this. |
| **XSS on our own origin** | Injected script could use the key even though it cannot read it. Mitigated by having no `innerHTML` on user content, no third-party scripts, and a CSP (Phase 6). The Markdown preview is the one place note text becomes rendered content, so it has its own section: [The Markdown preview](#the-markdown-preview). |
| **A malicious or coerced host** | The server composes and delivers this client on every load, so it could serve one user a backdoored build that reads the passphrase as it is typed. This is the structural limit of *any* web app's encryption promise, and it is not closed — only made harder to do quietly. See [A malicious or coerced host](#a-malicious-or-coerced-host). |
| **A weak passphrase** | Argon2id raises the cost per guess; it cannot rescue `password123`. Mitigated rather than solved — see [The passphrase itself](#the-passphrase-itself). The create screen offers a generated ~62-bit phrase, estimates what a typed one is worth, enforces a 10-character minimum, and refuses a known password in a decoration. A user who declines the generator and types something mediocre still gets a mediocre vault. |
| **A server withholding or replaying versions** | A version is the note's own envelope, bound to the note's id, so a backend cannot present one note's version under another (for records sealed since format 2). It can still withhold versions, or serve an older revision of a note in place of a newer one — binding does not cover rollback. It cannot read or forge text. |
| **A shared link, once sent** | Whoever holds the link can read that note until it expires or it is revoked — the chat history it was pasted into and the recipient's browser history included. A link is a bearer token by construction; the key is in it, which is what keeps it away from the server. See [Sharing a note by link](#sharing-a-note-by-link). |
| **Forgotten passphrase + lost recovery code** | The notes are gone. Permanently. By design — see below. A signed-in user can start over with a new vault, which erases the account's unreadable copy; see [Starting over on an account](#starting-over-on-an-account). |

### A malicious or coerced host

This is the objection to end-to-end encryption in a web app, and it is a fair
one. It deserves to be answered here rather than met for the first time in
public.

**The attack.** Native apps are installed once from a signed package; a web app
is re-delivered by its server on every single load. So whoever controls the
server — an attacker who has taken it, or an operator compelled by a court —
does not need to break AES-256-GCM or Argon2id. They serve one targeted user a
build with three extra lines in it, and that build posts the passphrase
somewhere as it is typed. It has been filed against Bitwarden, Proton and
Standard Notes, and it is why Signal ships through app stores instead.

**It cannot be closed from inside the page.** The browser-side answers are all
still early in 2026: Meta's Code Verify is Meta-only, WEBCAT is a Firefox-only
alpha, WAICT is a draft behind a flag, and Isolated Web Apps are enterprise-only.
Nobody shipping a web app today can honestly claim this is solved.

**What is actually done about it.**

1. **A new build cannot arrive silently.** The service worker installs an update
   but will not run it until you accept the prompt (`src/sw.js`,
   `src/ui/state/update.svelte.ts`). Navigations are answered from the worker's
   own precache, so the code on the page stays the build you were already
   running — network-first would have defeated this entirely, since the new
   shell's asset URLs would simply be fetched fresh. A targeted build therefore
   has to ask, on a day you might remember, rather than slip in on a reload.
2. **Subresource Integrity** on the shell's entry script and stylesheet
   (`tools/vite-plugin-sri.mjs`), so what was served is checkable against a
   published hash.
3. **A CSP with no third-party script origin at all**, and a short list of
   origins anything may connect to — this one and the Firebase endpoints sync
   needs. That narrows where injected code could send what it reads; it does
   not close it, because an attacker who controls the host also controls the
   policy it serves. See [Two policies, not one](#two-policies-not-one).

**What each of those is worth, precisely.** The update gate buys *visibility*,
not a guarantee: the worker enforcing it comes from the same host, so an
attacker willing to replace the app can replace the gate. Its value is that
doing so is no longer invisible, and that the window for a silent swap closes.
It costs something real, too — ignore the prompt and you keep running an old
build, security fixes included.

SRI is weaker still, and should not be read as a second lock. Its threat model
is HTML from one origin and scripts from another; both come from the same origin
here, so a host rewriting the bundle rewrites the attribute with it. It is also
partial by construction: `integrity` covers the files named in the HTML, not the
~130 chunks they import. What it genuinely provides is the machine-readable form
of "this is the build that was published", which only becomes a check once the
hashes are published out of band with tagged releases — that part is not done
yet.

**The honest summary.** Against a database breach, a subpoena of the stored
data, or an honest-but-curious operator, the encryption does exactly what this
document says. Against a host actively willing to attack one named user, a web
app is the wrong threat model, and no amount of client-side cryptography changes
that. Anyone who needs that guarantee should want a signed, installed
application — and should be told so rather than reassured.

### The Markdown preview

A note is attacker-controllable text: it arrives by sync from any device on the
account, or by paste. The preview (`src/editor/preview/`) turns it into rendered
content, and does so without ever giving a browser markup to parse:

- **No HTML string exists.** `model.ts` parses with `@lezer/markdown` into plain
  objects. `render.ts` builds nodes with `createElement`, and note text reaches
  the DOM only through `textContent` and `setAttribute`. Tag and attribute names
  come from fixed TypeScript unions, never from the note. There is no
  `innerHTML`, no `{@html}` and no sanitizer to get wrong.
- **Raw HTML is shown as text.** `<script>`, `<img onerror>` and HTML comments in
  a note appear literally (comments are dropped) and are never interpreted.
- **Links are allowlisted.** Only `http:`, `https:`, `mailto:` and in-note
  `#fragment` targets become links. The scheme is checked after removing the
  control and whitespace characters a URL parser would strip, so
  `java\tscript:` is refused. Everything else, relative URLs included, renders
  as inert text. External links open with `rel="noopener noreferrer"`, and the
  site's `Referrer-Policy: no-referrer` applies as well.
- **Images are never fetched.** A remote image renders as a link to itself. The
  CSP's `img-src` would block it anyway, but not fetching also means opening a
  note tells no image host who opened it or when. Only raster `data:` URIs
  (png, jpeg, gif, webp, never SVG) display inline, because their bytes are
  already in the note.
- **No ids from note text.** Heading anchors are `data-anchor` attributes,
  resolved by the preview's own click handler. An `id` would let a heading
  clobber a named global, and would collide across tiles.
- **Task checkboxes edit the source, and only where there is one.** A checkbox
  renders `disabled`; the renderer removes that only when the page gave it a
  way to write back, so the share viewer and the history panel show inert
  boxes. The clickable ones carry `data-task`, a number the renderer wrote
  itself — the offset of the `[ ]` within its block, never note text. A click
  is cancelled, the offset is resolved against the block's current position and
  handed to the editor, which checks that the line really is a task item
  starting there and refuses otherwise. The tick comes from the source; the
  preview never edits its own DOM into a state the note does not hold.
- **A note link is a button with a data attribute, and no URL at all.** `[[Title]]`
  becomes `<button class="notelink" data-note="…">` — its label through
  `textContent`, its target through `setAttribute`, built the same way as
  everything else here. It deliberately has **no `href`**: the target is a note
  *title*, not an address, so there is no scheme for `safeHref` to judge and no
  way for note text to reach a navigation. Resolving that title to a note needs
  the decrypted meta list, which only the app has, so the renderer never does it.
  A link renders `disabled` and the renderer removes that only when the page
  handed over a resolver — so the share viewer and the history panel show inert
  text, exactly as they do for task checkboxes. `bench/share.mjs` fails if a
  viewer's note link is enabled.
- **Tags are buttons with a data attribute.** A `#tag` in plain text becomes a
  `<button class="tag" data-tag="…">` built the same way as everything else —
  its label through `textContent`, its key through `setAttribute` — and the
  preview's click handler reads the attribute to filter the list. Tags are never
  recognised inside code, link labels or URLs.
- **Extended syntax adds tags, never a new kind of output.** `==highlight==`,
  sub/superscript, definition lists and footnotes become `mark`, `sub`, `sup`,
  `dl`/`dt`/`dd` and `sup`/`a`/`ol` — fixed names added to the same unions,
  built the same way. A footnote's links are `#fn-N` / `#fnref-N` fragments to
  `data-anchor`s whose numbers the model wrote itself, never note text. A
  heading's `{#custom-id}` changes only which name goes into its `data-anchor`
  (slugged, so it carries the same characters a heading's text could), never an
  `id`. A `:shortcode:` is a span holding the shortcode as text; `render.ts`
  later replaces that text with an emoji from a fixed table, through
  `textContent`, or leaves it as typed.
- **A mermaid diagram is the one piece of markup the preview adopts, and it is
  fenced three ways.** A ```` ```mermaid ```` fence renders as its source, and
  `src/editor/preview/mermaid.ts` later draws it as a diagram. Mermaid can only
  return an SVG *string*, so:
  1. Mermaid runs with `securityLevel: 'strict'`, which runs labels through its
     own DOMPurify and switches off `click` callbacks and links. HTML labels are
     also off, so no `<foreignObject>` HTML is produced.
  2. The string is parsed by `DOMParser`, which builds an inert document that
     runs no script and fetches nothing.
  3. `mermaidSvg.ts` then keeps SVG-namespace elements only. It drops
     `<script>`, `<foreignObject>`, `<image>`, `<feImage>` and every animation
     element. It removes every `on*` attribute and every `href` that is not an
     in-diagram `#fragment`. It prefixes every id with the render's own id,
     because some diagram types turn note text into element ids.

  Only after that is the tree imported into the page. The CSP is unchanged:
  mermaid's `<style>` inside the SVG falls under the existing
  `style-src 'unsafe-inline'`, and mermaid needs no `eval`. Mermaid is a
  bundled, self-hosted dependency, so this adds no third-party origin. It is
  still a large one, and it is reached only by dynamic import, from a note
  that has a diagram.

`tests/unit/previewModel.test.ts`, `tests/unit/extendedSyntax.test.ts` and `tests/unit/mermaidSvg.test.ts` cover each of these, and `bench/preview.mjs`
fails if the rendered page requests a remote image or logs a console error. It also fails if a mermaid fence is not drawn under the real CSP, carries `<foreignObject>` into the page, or keeps its colours across a theme change.

### Export and import

Export (spec §24) is the one deliberate way decrypted text leaves the app as
files, and it is shaped so that it goes exactly where the user sends it:

- **User-initiated only.** A click in the Export and import dialog, the folder
  `⋯` menu, or ⌘J ⇧A / ⌘J ⇧E. Nothing exports on a timer, on sign-out or on
  lock — and the backup offered by
  [Remove all data from this device](#remove-all-data-from-this-device) is a
  separate press, not part of the removal.
- **Never touches the network.** The zip is built in memory
  (`src/core/portability/zip.ts`), handed to the browser as a `blob:` URL on a
  `download` link, and the URL is revoked a minute later. There is no share
  sheet, no upload, no "export to cloud".
- **Plaintext, said plainly.** The dialog states that an export is not
  encrypted. That is the point of it — lock-in is the threat §24 answers — so
  there is no encrypted export format to lull anyone.

Import reads files the user dropped, pasted or picked, entirely in the page:

- **Nothing new reaches the backend in plaintext.** Imported notes and folders
  go through `Workspace.importNotes`, which writes via the same codec as a
  keystroke and queues through the same `syncQueue`, so titles, bodies and
  folder names are sealed like any other write and upload rules
  (`app:owner`, vault ownership) apply unchanged.
- **Only adds.** Notes are never matched to existing ones, so an import cannot
  overwrite anything. Folders with the same name under the same parent are
  reused, which is metadata only.
- **Text is never interpreted.** Only `.md`, `.markdown`, `.mdown` and `.txt`
  are read, decoded as strict UTF-8 (a NUL byte or invalid sequence skips the
  file), and stored as a string — the preview's rules above still govern how
  it is rendered.
- **JSON is read as data, for two known exports only.** A `.json` file is
  decoded as strict UTF-8 and passed to `JSON.parse`, nothing else; it becomes
  notes only when it has the shape of a Simplenote `notes.json` or a Google Keep
  Takeout note (`core/portability/sources.ts`), and then only string, number
  and boolean fields of the expected names are read. Their text becomes a
  note's content like any other file's. Anything else, or anything that does
  not parse, is skipped and listed.
- **Hostile archives.** Zip paths never touch a file system, so `../` is just a
  folder name. What is guarded is the tab: at most 20,000 entries and 200 MB
  inflated, each entry inflated no further than its declared size, CRC-32
  checked, and ZIP64 or encrypted entries refused with a message.
  `tests/unit/zip.test.ts` covers the bomb and corruption cases.
- **Drops and pastes.** A capture-phase window listener takes any drag that
  carries files, so CodeMirror never inserts a dropped file's bytes into a
  note. Files are staged in the dialog and imported only on an explicit
  Import, so a mis-aimed drag writes nothing.

### Sharing a note by link

Publishing a note behind a link is the second deliberate way a note leaves the
app, and it is shaped so that what leaves is ciphertext and what opens it never
touches a server.

```
https://hushjot.com/s/#s1.<id 22 chars>.<key 43 chars>
                     │  └──────────────────────────── never sent in any request
                     └───────────────────────────── the only path any server sees
```

- **A fresh key, never the vault's.** Each share mints its own 256-bit key from
  the same CSPRNG the DEK comes from, uses it for one document, and is done. The
  DEK could not be used here even if that were wanted — it is imported
  non-extractable — and it must not be, because the key is handed to someone
  else. A leaked link therefore exposes exactly one snapshot of one note: not
  the vault, not the account, not the other shares.
- **The key is in the fragment, and a fragment is not transmitted.** It is not
  in the request line, not in `Referer` (and `Referrer-Policy: no-referrer` is
  set besides), and no proxy or CDN in front of Hosting ever receives it. The id
  is in the fragment too, so the *web host's own access log* cannot say which
  share was opened — only Firestore learns that, because it has to serve the
  document.
- **Link previews get nothing.** An unfurling bot — Slack, WhatsApp, iMessage —
  fetches the URL without its fragment, so the preview it builds comes from
  `s/index.html` and nothing else. There is deliberately no Open Graph markup
  there, and there must not be: the page cannot know the note's title without
  the key, and nothing should teach it to.
- **A snapshot, not a feed.** Publishing seals the note as it stands. Later
  edits change nothing a recipient sees until "Update link", which re-seals
  under the same id and key so a link already sent keeps working. Nothing is
  published on a timer, on a sync cycle, or on a keystroke.
- **The viewer page carries none of the vault.** `/s/` is a second HTML document
  with no IndexedDB, no key record, no unlock form and no Firebase SDK — it
  reads the key from the fragment, fetches one document over plain REST,
  decrypts and renders. Someone following a link from a stranger therefore
  cannot be shown a passphrase prompt on the real origin, and no code on that
  page can reach the data key. `bench:share` asserts all of that against a
  browser that has never seen the app. What it does store is the reader's
  display preferences — theme, text size, typeface — under the app's own three
  `teksto:` keys, and only once the reader changes one: preferences, never note
  text or a key, shared with the app on purpose so a reader sees a link the way
  they see their own notes.
- **Rendering is the preview's rendering.** Note text reaches the DOM through
  `createElement` and `textContent` only — see
  [The Markdown preview](#the-markdown-preview), whose rules matter more here
  than in the app, because here the text is somebody else's.
- **Saving a shared note asks inside the app.** The viewer's "Save to my notes"
  navigates to the app with the link in the fragment, never the text, and the
  app fetches and decrypts it itself. That fragment can be linked to directly,
  so nothing in it can prove the reader already chose to save, and the app
  shows the shared note — read-only, through the same inert preview — with
  Save and Dismiss. Nothing is written until Save.
- **Publishing needs a plan or an invitation.** The write rules require an approved account
  that holds the matching record under its own `users/` path once the commit lands, so shares
  cannot be used as anonymous storage, and each is capped at 900 KiB like every
  other document. The record, the public document and the meter are one commit,
  so a publish counts against the month's links and the day's pushes, and no
  failure leaves half of one behind.

**Expiry and revocation.** A link carries an expiry — 1 hour, 1 day, 7 days
(the default) or 30 days — and the *read rule* enforces it: `allow get: if
resource.data.expireAt > request.time`. That is what makes an expired link stop
working, not the TTL policy, which only cleans up afterwards, exactly as the
note version TTL does. Revoking deletes the public document and the link dies at once.

Two things follow, and they are the same two that follow for note history:

- **An expired link's ciphertext outlives its expiry** until the TTL sweeps
  it, typically within a day. It is unreadable — the rules refuse the read, and nobody but the holder of that
  link's key could open it anyway — but it is still there. Someone sharing a
  pasted secret should know that.
- **Unlike a version, a share may be deleted by its owner**, and that is the
  opposite rule for the opposite reason. History exists to protect a user from a
  stolen session overwriting their notes, so that session must not be able to
  erase it. A share exists to be withdrawn, and a session that deletes every
  share has destroyed nothing, because the notes are still there. Refusing
  deletes would mean a mis-sent link could not be pulled back, which is the main
  thing anyone wants from sharing at all.

**Where the link's key lives.** Two places and no others: the URL the user
copied, and — sealed under the vault — the owner's own record of the share. The
second is what lets "Shared links" copy a link again, or re-publish an edited
note to the same URL, from any of the user's devices. The public document, which
anyone holding the id can read, never carries it.

**What this does not defend.**

- **A link is a bearer token.** Anyone who has it can read that note until it
  expires — including the chat history it was pasted into, the recipient's
  browser history (a fragment is part of a URL and is stored there), and anyone
  they forward it to. That is the feature; it is also the whole risk, and the
  dialog says so in those words before it publishes anything.
- **The viewer is same-origin with the app.** A separate origin would be
  stronger, since then a flaw in the viewer could not reach the app's storage at
  all. It is not what this does: one origin keeps one service worker, one CSP
  and one deploy, and the viewer's whole surface is a `fetch`, an AES-GCM open
  and the preview renderer. Stated rather than fixed.
- **Metadata.** The backend sees how many links an account has published, how
  large each is and when each expires, exactly as it sees those things for
  notes.

### Quick capture

Text shared *into* the app from somewhere else — the third deliberate way a
note crosses the boundary, after export and share links. Two routes, because
the two platforms have nothing in common here.

```
Android   share sheet ──POST /capture──▶ service worker ──▶ page memory ──▶ vault
iOS       Shortcut ──▶ https://hushjot.com/#c1.<percent-encoded text> ──▶ vault
```

- **The Android target is a POST, and that is the security control.** A Web
  Share Target may be declared `GET`, in which case the browser puts the shared
  text in a **query string**: the address bar, session history, and — the
  moment anything fails to intercept the navigation — the web host's access
  log. A `POST` body reaches the service worker and stops there. The choice
  costs a fetch handler and buys the property the whole product rests on, so
  `bench:capture` asserts the method rather than leaving it to review.
- **The worker holds the text in memory, never in storage.** `src/sw.js` parks
  the parsed form in a module-level map keyed by the client the response will
  create, extends its own lifetime with `waitUntil`, and deletes the entry when
  the page claims it or after sixty seconds. It is not written to the Cache API
  or to IndexedDB, and there is no encrypted option: the vault may be locked,
  so there would be no key. The consequence is stated rather than hidden — if
  the worker is terminated before the page claims the share, the capture is
  **lost**, and the user shares again. Plaintext on disk would not be
  recoverable in the same sense.
- **The page claims it before the unlock screen, not after.** `main.ts` asks
  for the share beside `captureInstallPrompt()`, because a passphrase takes as
  long as it takes and the worker will not wait. From that moment the text
  lives in page memory exactly as an open note's text does, and it reaches
  storage only through the vault's codec. A user who never unlocks never has it
  written anywhere.
- **The iOS fragment is never transmitted**, for the same reason the share
  link's is: no request line, no `Referer`, no proxy. It *is* in the address bar
  and in session history, which is why `clearCaptureUrl()` replaces the URL with
  `/` the moment the text is in hand. The `c1.` prefix cannot be confused with a
  share link's `s1.`, and `tests/unit/capture.test.ts` asserts that in both
  directions.
- **A captured note is an ordinary note from the first instant.** It is created
  through `workspace.create` and sealed by the same codec; `bench:capture`
  checks the shared text appears in no cache entry and in no IndexedDB record.
- **A capture can be forged, and this is the residual.** `/capture` is a plain
  endpoint, so a cross-origin page can auto-submit a form POST to it and a link
  someone clicks can create a note. It is bounded: nothing can be *read* this
  way, the vault is untouched, the note opens in front of the user rather than
  landing silently, and the flash offers Undo — which tombstones into Recently
  deleted rather than destroying anything. This is a deliberate departure from
  the incoming-share link above, which asks first: that one arrives from a URL
  the user may have been handed, while this one is reached from an OS share
  sheet the user opened, and quick capture that costs a confirmation tap is not
  quick capture. Nuisance notes were judged the better trade.
- **Only text.** `title`, `text` and `url`. The manifest declares no `files`
  member, so the share sheet cannot hand the worker a document to parse.

`docs/quick-capture.md` is the user-facing half, including the iOS caveat that
matters most in practice: a Shortcut opens the *default browser*, and since
iOS 16.4 a home screen web app keeps storage separate from Safari, so a capture
can land in a second, separately-locked copy of the app.

---

---

## The CLI and MCP server

`@hushjot/cli` is a second client that is not a browser. It signs in to the same
account over the Identity Toolkit REST endpoint, reads and writes the same
ciphertext at `users/{uid}/notes/*` over the Firestore REST API, and does the
Argon2id derivation and the AES-256-GCM opens **in a process on the operator's
own machine**. The backend is handed nothing it was not already handed by a
browser, and the rules are enforced identically — `firestore.rules` never sees
which transport a request arrived on.

So the promise at the top of this page is unchanged by it. Three things are new,
and all three belong here rather than in a README.

### The data key is cached in the OS keychain

Argon2id costs ~95 ms on a laptop, and a command-line tool called in a loop
would pay it on every invocation. So after the first unlock the raw 32-byte DEK
is stored in the platform's own secret store — the macOS Keychain via
`security`, the system keyring via `secret-tool` on Linux, and Credential
Manager on Windows, through the built-in Windows PowerShell calling
`CredReadW`/`CredWriteW`. On Windows the item is a generic credential persisted
to the local machine only (never roamed with the profile), and the secret is
passed to PowerShell on stdin, never as an argument.

This is the same trade as [Stay unlocked on this
device](#stay-unlocked-on-this-device), and it lands in a stricter place. The
browser keeps a non-extractable `CryptoKey` in IndexedDB, which script on the
origin can use and cannot read; the keychain holds raw bytes, which script on
the origin cannot reach at all, and which are encrypted at rest and gated by the
login session. What both share is the limit: **neither protects against someone
who already has your unlocked machine and your user account.** They can run
`hushjot cat`.

The cached item is named after a SHA-256 of the key record's
`wrappedByPassphrase`. Changing the passphrase on *any* device re-randomises
`salt_p` and rewrites that blob, so the name changes, the lookup misses, and the
CLI derives again. Invalidation falls out of the format rather than depending on
a message reaching another machine. `hushjot logout` removes the key, the
refresh token and the account password; it deletes no notes.

Where no keychain exists — a container, CI, a server without a desktop — the
CLI stores nothing at all. It reads `HUSHJOT_PASSWORD` and `HUSHJOT_PASSPHRASE`
on every run, signs in afresh and derives the key again, and says so in
`hushjot status`. That is the weaker path and is documented as one: an
environment variable is readable by every process the shell starts, an agent
included.

### A ciphertext cache on disk

`~/.hushjot/cache/<uid>/store.json` holds the sealed note and folder rows
byte-for-byte as Firestore returned them, plus the delta cursor. The rule is the
one IndexedDB follows: **ciphertext only**. Copying that file gets someone
exactly what a breach of the backend would give them and nothing more.

It exists for search, which needs every body — without it, one search would pull
the whole account. The **token index is deliberately not persisted**, even
though rebuilding it on every search is the slow part: a serialised inverted
index is the words of every note in the clear, which is most of what the
encryption was for. It is built in memory and discarded.

Deleting the directory loses nothing. Nothing is queued there — writes go
straight to Firestore — so none of the backfill and ownership machinery under
[Signing in uploads what is already
here](#signing-in-uploads-what-is-already-here) has an analogue, and there is no
state in it that another device needs.

### An MCP server puts note text in front of a model

This is the genuinely new disclosure, and it has no equivalent in the browser
app. `hushjot mcp` exposes eleven tools to whatever model is driving the session
— Claude Code, Codex, Copilot or any other MCP client — (four with `hushjot mcp
enable --read-only`). `cat` and `take` return whole notes, `search` and `ls`
return titles and excerpts, and `pending` returns titles. `hushjot_protocol`
returns only the server's own working instructions.
**Everything the model reads goes to its provider in plaintext** — that is what
reading it means, and the CLI's own docs say so where the server is set up.
Four controls, none of them decoration:

- **It refuses to start until `hushjot mcp enable` has been run.** Installing a
  CLI must not silently make every note available to an agent; that is one
  deliberate action taken once by a person.
- **`hushjot scope` confines it to one or more folders' subtrees** — reads and
  writes both. Every folder a tool argument names is resolved *inside* the scope
  (`resolveInScope`), so an agent cannot write outside it by naming a folder, and
  a not-found or ambiguity error lists only folders it can already see. A note
  pushed without a folder lands inside the scope rather than at the root. A scope
  entry that no longer resolves stops every command rather than being skipped,
  because skipping the last one would widen to the whole vault. `hushjot mcp
  --scope <folder>` narrows further for one server process — one agent project,
  one folder — and is refused if it names anything outside the configured scope.
  The search grammar's `in:` operator cannot widen any of this, and not because
  it is checked: `notesInScope` decides what gets indexed at all, so a query
  naming a folder outside the scope matches nothing because no such note was
  ever put in the index.
- **No tool can destroy text.** `push` and `mkdir` only create, under fresh
  UUIDs. `append` only adds, and on a compare-and-swap refusal it retries against
  the re-read body and then reports failure. `replace` is the one overwrite, and
  two rules make it undoable: it is a compare-and-swap on the revision the caller
  *read*, never retried, so an edit made on a phone in the meantime refuses it
  rather than being flattened; and the stored ciphertext it replaces is copied,
  byte for byte, into `notes/{id}/versions/{sealId}` **in the same atomic
  commit** as the new text, named and dated exactly as the app names its own
  versions, so the app's History panel restores it for 30 days. There is no
  delete verb — the rules refuse a hard delete outright, and the CLI does not
  write tombstones either.
- **Read-only mode** advertises only `search`, `cat`, `ls` and `pending` and
  refuses the others if called anyway.

**What the scope is not.** It is containment for the MCP tools, not a sandbox.
The server runs as the operator, holds the data key, and is configured by a file
the operator owns. An agent that can also run shell commands as the same user
can run `hushjot scope clear`, or read the key out of the keychain with the
platform's own tool, and nothing in this process can stop that. The CLI's README
says so, and each agent's setup guide (`docs/agents.md` there) gives that
agent's deny rules for the `hushjot` command and the keychain tools (`security`
on macOS, `secret-tool` on Linux). Windows has no such single command: any
PowerShell script running as the user can read Credential Manager. Making the scope a
cryptographic boundary would mean per-folder keys, which is a format change and
is not planned.

### What the CLI will not do

- **Write `users/{uid}/keys/primary`.** Read-only, always. The rules permit
  create *and* update there and refuse delete outright, so a key record written
  from outside the app would be permanent, and every browser device already
  bound to the old one would be unable to open notes sealed under the new one.
  Creating a vault stays in the app, where a recovery code can be shown once to
  a person rather than printed into a scrollback or an agent transcript.
- **Seal with a key that did not come from the account's own record.** That is
  the CLI's equivalent of `vaultOwnsAccount == true`, and it is strictly
  stronger than what a browser can prove: the CLI holds no local vault and has
  nothing to fork the account with, so `classifyVault` has no counterpart there.
- **Assume a revision.** Every write reads the document first and sends
  `stored + 1`. Assuming zero is how the engine once forked every note in an
  account on a loop, and the comment around `pushOne` records it.

### Verification

`npm run test:integration` in the CLI repository runs the whole tool against the
Firestore emulator loaded with **this repository's rules**, shipped in
`@hushjot/core/contract/firestore.rules`. It asserts, among other things, that
no sentinel from a pushed note's body appears anywhere in what Firestore stored
— the same audit `bench/phase3.mjs` performs against IndexedDB — and that the
rules still refuse a client-supplied `syncedAt`, ciphertext sent as a string, a
revision that does not advance by exactly one, and a hard delete. Over a real
JSON-RPC session it also asserts that a scoped agent's push into a folder outside
its scope is refused, that `--scope` cannot widen the configured scope, that a
`replace` with a stale revision is refused, and that one with the read revision
leaves the old text in `versions/` under the real rules.

---

## Recovery, and why there is no reset link

A password-reset link that restored access to notes would mean the server could
decrypt them. That is precisely the backdoor §13 forbids, and it would make the
central promise false.

So recovery is a **recovery code**: 160 bits, Crockford base32, shown exactly
once at setup behind an "I have written this down" confirmation. It wraps a
second, independent copy of the same DEK.

Crockford's alphabet omits `I`, `L`, `O` and `U` — the characters people misread
— and input is normalised for case, spacing, dashes, and the usual `O`/`0` and
`I`/`1` substitutions, because this is a string a user writes on paper and types
back months later.

- **Lost the passphrase, have the code** → on the unlock screen, "Lost your
  passphrase? Use this code to set a new one". The code unwraps the data key and
  a fresh passphrase-derived KEK re-wraps it. The code itself is deliberately
  left alone: it is the only secret that user has demonstrably still got, and
  retiring it in the same act that mints a passphrase they have not yet retyped
  would leave them with nothing. Re-issue it afterwards if it may have been
  seen. This does not unlock the vault — it re-wraps the record, and typing the
  new passphrase once immediately is the only evidence anyone gets that it was
  written down.
- **Lost the code, have the passphrase** → Account → "Re-issue recovery code…".
  The old code stops working the moment the new one is shown, and the new one is
  shown exactly once, behind the same "I have written this down" confirmation as
  at setup.
- **Both still held, and one of them may have been seen** → Account → "Change
  passphrase…", and re-issue the code as well. The dialog says so on the way
  out, because the two are independent secrets and changing one does nothing at
  all to the other.
- **Lost both** → **the notes cannot be recovered, by us or by anyone.** What
  is left is to start over, and that is a different act depending on whether
  an account is involved:
  - *No account:* "Lost both? Remove all data from this device" (see
    [Remove all data from this device](#remove-all-data-from-this-device)).
  - *Signed in:* "Lost both? Start over with a new vault". Removing the device's
    data alone does not work here — the account still holds the old key record,
    the rules refuse any client a delete of it, and the next sign-in adopts it
    again. So the account's synced data is erased first, by the billing API; see
    [Starting over on an account](#starting-over-on-an-account).

None of these re-encrypts a note. The data key is random and is only ever
wrapped, so each one rewrites a couple of hundred bytes; see
[Key hierarchy](#key-hierarchy).

The setup screen says the last of those in those words rather than in a
euphemism.

### Starting over on an account

`POST /hushjot/vault/reset` on the billing API (a separate, closed-source
service; client half `src/adapters/firebase/vaultReset.ts`, dialog
`src/ui/StartOver.svelte`). It erases ciphertext nobody can open, so it costs
the user nothing they still had — but it is irreversible and it is reachable
with a session token, so it is guarded:

- **A fresh sign-in.** The API refuses an ID token whose `auth_time` is more
  than five minutes old. The dialog re-authenticates with the account password
  first. A session token lifted from a device left signed in is therefore not
  enough to empty an account.
- **A typed confirmation** (`erase`), in the dialog and in the request body.

What it does, in order, all as a service account (the rules do not apply):

1. Replaces `users/{uid}/keys/primary` with a **tombstone** — `{ v, resetAt,
   updatedAt }`, no `record`. First, so that no device ever sees the account
   without a key document: absence is what a retention purge leaves, and a
   device bound to the old vault answers absence by republishing its record
   (`accountWasReset`), which would undo the reset.
2. Deletes share blobs and their index, versions, notes and folders — the same
   code as the retention purge, minus the key record.
3. Sets the storage meter's `bytes` to 0. The monthly `hist`/`shares` figures
   are left alone: lowering them would buy budget back.

Then the device runs the ordinary removal and reloads. Signing in finds the
tombstone; `loadKeyRecord` reads it as "no record", so the create form opens,
and `saveKeyRecord` overwrites it with a plain update the rules already allow
(a client cannot write a tombstone itself: the rule requires `record`).

**The user's other devices** still hold the old vault, and one of them may
still open it ("remember this device"). Each bound device takes one look at the
key document per session, *before* anything it does could publish, and
`accountResetElsewhere` (`core/sync/backfill.ts`) answers whether the account
moved on: a tombstone, or a record with a different `createdAt`. `createdAt` is
stamped once by `createKeyRecord` and carried through every re-wrap, so a
different value is the one inequality between two records that *can* be shown
— two `createKeyRecord` calls, two random DEKs. On a yes the device writes
`app:vaultRetired`, clears `app:vaultAccount`, and never starts sync for that
account again; a banner offers export and removal. Sync has to be off
entirely, not just the backfill: `vaultOwnsAccount` gates only the sweep and
history, and ordinary edits would otherwise seal notes into the new vault under
the old key, where nobody can open them or delete them.

**Residual.** A device that is open and syncing *while* the reset happens keeps
its running engine until it reloads; the check is per session. Anything it
pushes in that window lands in the new vault as an "Unreadable note" row, which
the user can delete. The billing API's service account has the Datastore scope
only, so it does not revoke the account's other sessions.

---

## Logging and telemetry

- No analytics, no third-party scripts, no network calls beyond the app's own
  assets (and Firestore in Phase 4).
- Errors report a *shape*, never a value: the KDF worker and the search worker
  return an error name, never the passphrase, salt, query or note content (§29).
- The decrypt path deliberately discards the underlying reason for a failure so
  it cannot become an oracle.

---

## Two policies, not one

There are two Content Security Policies, and the split is not cosmetic.

**The document policy** (`**` in `firebase.json`, mirrored as a meta tag by
`tools/vite-plugin-csp.mjs`) governs the page. This is the one that matters for
XSS, and it is the strict one. Its `connect-src` names the Firebase endpoints
and one other origin, the billing API, which the app calls for a vault reset
and nothing else. The plugin takes it from `VITE_HUSHJOT_API_URL`, the same
variable the adapter reads; `firebase.json` names the default, so a different
API URL has to be written there too.

**The asset policy** (`/assets/**`, which must stay *after* the catch-all —
Firebase applies later matching blocks over earlier ones) governs the workers.
A worker fetched over HTTP does not inherit the page's policy; it takes its own
from its own response headers. The KDF worker compiles Argon2id from
WebAssembly, so this policy — and only this policy — needs
`'wasm-unsafe-eval'`. That token permits `WebAssembly.compile` and nothing
else; it is not `'unsafe-eval'`.

### The trap, which already caught us once

`/assets/**` is served `max-age=31536000, immutable`, and **a cached response
carries its headers**. So an asset's CSP is frozen for a year alongside its
bytes, and a browser that already holds `kdf.worker-<hash>.js` keeps enforcing
whatever policy was in force when it first fetched it. Reloading does not help;
`immutable` means it will not even revalidate.

Content-hashed filenames make this self-correcting *only when the file's
content changes too*. Tightening or loosening the asset policy on its own
reaches new visitors and no one else. If the asset policy ever has to change,
the affected worker's contents must change with it, so it is served under a new
URL — otherwise returning users are stranded on the old policy with no way back
short of clearing their cache.

This is why the asset policy is deliberately minimal and boring: the less
reason it has to change, the less this can bite. The document policy is free to
evolve, because `index.html` is `no-cache`.

`bench/phase6.mjs` asserts the ordering, the `'wasm-unsafe-eval'` token and the
immutability, since no browser-side test can observe headers that
`vite preview` never sends.

---

## Frozen identifiers

The product was renamed from teksto to HushJot on 16 September 2026. Every string a person
reads changed. The strings below did not, because a browser has already persisted or derived
something under them, and each carries a comment in the code pointing here.

| Identifier | Where | What renaming it would do |
|---|---|---|
| HKDF info `teksto/recovery-kek/v1` | `src/core/crypto/kdf.ts` | Change the recovery KEK derived from every recovery code ever issued, so no existing code would unwrap the DEK. There is no migration: the old label would have to be kept forever anyway. |
| IndexedDB database `teksto` | `src/core/repo/schema.ts` | Open an empty database beside the real one: every existing vault would look like a first run. |
| `teksto:journal:v2` (and the legacy `v1` key it deletes) | `src/core/repo/journal.ts` | Make the crash journal written by the previous build invisible to the next one, losing exactly the keystrokes it exists to protect. |
| `teksto:tile-layout`, `teksto:open-tiles`, `teksto:tile-modes`, `teksto:sidebar-hidden`, `teksto:folders-collapsed`, `teksto:tags-collapsed`, `teksto:theme`, `teksto:editor-font-size`, `teksto:editor-font`, `teksto:line-wrap`, `teksto:line-wrap-fixed`, `teksto:spellcheck`, `teksto:focus-mode`, `teksto:local-only-notice-dismissed`, `teksto:last-export-at`, `teksto:backup-reminder-snoozed-at`, `teksto:backup-reminder-since` | `src/ui/state/*.svelte.ts`, `src/ui/App.svelte`, `src/ui/backupReminder.ts` | Reset layout, collapsed folders, theme, text size, editor font, line wrap, the spellcheck choice, focus mode, the dismissed local-only notice and the backup reminder's clock on the first load after a deploy. |
| Web Lock `teksto:sync-leader`, BroadcastChannel `teksto:sync` | `src/core/sync/tabs.ts` | A tab still running the old build and a tab running the new one would not see each other: two sync leaders, and `local` broadcasts lost between them, until every tab reloads. |
| Cache prefix `teksto-shell-` | `src/sw.js` | The activate step deletes caches by this prefix; a new prefix would leave every old shell cache in place for good. |
| IndexedDB database `teksto-history`, Web Lock `teksto-history-prune` | `src/core/history/names.ts`, `src/ui/state/workspace.svelte.ts` | Postdate the rename, but take the storage prefix so every identifier this app persists shares one. Renaming the database would orphan every version and empty Recently deleted; renaming the lock would let two builds prune at once. |
| Firebase emulator project ids `teksto-dev`, `teksto-rules-test`, `teksto-pull-test` | `package.json`, `src/adapters/firebase/config.ts`, `bench/`, `tests/rules/` | Nothing: these are local fakes the emulator invents on the fly and they never reach Google. They stay so that one rule covers all of them. The *deployed* project is a different matter — Firebase does not allow a project id to change, so the move off the original project was a new project (`hushjot`) rather than a rename. |

A migration could rename the localStorage keys and the database, copying under the old name and
deleting after. Nothing above is user-visible, so there is nothing to buy, and the HKDF label
could not be migrated at all.
## Verification

Run `npm run verify`. Two things specifically prove the claims on this page:

- **`bench/phase3.mjs` — the ciphertext audit.** Writes notes containing
  sentinel strings, dumps every byte in IndexedDB (the note database and the
  history database) and localStorage, and greps for them. Zero hits is a hard
  pass/fail gate. It also asserts the audit can
  see stored data at all, so it cannot pass by looking at nothing.
- **`tests/unit/envelope.test.ts` and `keyRecord.test.ts`** — nonce uniqueness,
  tamper detection, header authentication, error indistinguishability,
  non-extractability, passphrase change without re-encryption, and recovery-code
  rotation.
- **`bench/share.mjs` — the share link, in two browsers.** Publishes from an
  account, opens the link in a context with no vault and no notes, and asserts
  the note reads; that the key appears in no URL anything fetched and the share
  id in nothing but the one Firestore document; that a link stripped of its
  fragment asks the backend for nothing at all; that the viewer page holds no
  `teksto` database, no `teksto:` key and no unlock form until the reader
  changes a display preference, and then only those three keys; and that revoking
  takes effect immediately rather than at expiry. `bench/phase6.mjs` adds the
  half that only an installed service worker can show: a share link opens the
  viewer and not the app.
- **`bench/capture.mjs` — quick capture, from outside the origin.** Submits the
  multipart POST the Android share sheet makes, from `about:blank`, because our
  own pages cannot (`form-action 'none'`), and asserts the share becomes an open
  note; that the manifest's target is a `POST` inside scope, since a `GET` one
  would work just as well and leak; that the address bar is back to `/`
  afterwards; that the shared text appears in **no cache entry and no IndexedDB
  record**, which is the memory-only claim above; that a `c1.` fragment produces
  the same note and a malformed one produces nothing; and that the handoff
  survives a passphrase being typed in between.
- **`tests/rules/shares.test.ts`** — what a stranger still cannot do with the
  one collection they may read: enumerate it, read an expired link, write
  anything, or delete somebody else's share.
- **`npm run test:integration` in the CLI repository** — the second client, end
  to end against the Firestore emulator loaded with *these* rules. It asserts
  that no sentinel from a pushed note's body appears anywhere in what Firestore
  stored, and that the rules still refuse a client-supplied `syncedAt`,
  ciphertext sent as a string, a revision that does not advance by exactly one,
  and a hard delete. See [The CLI and MCP server](#the-cli-and-mcp-server).

---

## Open items before production

1. **Independent security review.** This document and the code are a
   self-assessment. §13 requires a dedicated review before production, and this
   has not had one.
2. ~~**Argon2id parameters on real mobile hardware**~~ — **done, 21 Sep 2026.**
   232.7 ms p50 on a Google Pixel 9a with no allocation failure, so the
   parameters stand; see [Settling it on hardware](#settling-it-on-hardware).
   **One thing it did not settle:** 64 MiB was allocated comfortably on an 8 GB
   phone, but a 4 GB device on a low-tier SoC under memory pressure is where a
   refusal would actually happen, and none has been tested. A refusal is not a
   slow unlock — it is a device that cannot open its own notes — so this is
   worth re-running on the cheapest Android to hand.
3. ~~Content Security Policy~~ — **done.** `script-src 'self'`, no inline
   script, no `eval`, no third-party origins. `style-src` allows inline because
   CodeMirror builds its theme at runtime and the pre-hydration shell is an
   inline `<style>`; neither is a script vector. `img-src` allows
   `https://www.google.com` for Firestore's connectivity probe. Served both as
   a meta tag and as a real header, since `frame-ancestors` is ignored in meta.
   See [Two policies, not one](#two-policies-not-one) for the worker half.
4. **Data-key rotation.** Secret rotation is built: the passphrase and the
   recovery code can each be changed in the app, and each re-wraps the same data
   key under a fresh salt at the current parameters. What is *not* built is
   rotation of the data key itself — that means re-encrypting every note, every
   version and every share, and it is the only one of the three that is not
   cheap. It is also the only one that helps if the DEK is the thing that
   leaked. Nothing forces it today.
5. **Rate limiting and abuse — writes bounded, reads not.** The rules now bound
   write frequency as well as size and shape: 20,000 pushes per account per day,
   every stored document charged at least 1 KiB against the storage allowance,
   500 MB of history and 100 links a month (see [Usage limits](#usage-limits)).
   So a compromised client can cost about 40,000 writes a day, about a dollar a
   month, and no more storage than the account pays for. Two small write paths
   are not metered: the key record (one document, which Firestore
   serialises — roughly one write a second sustained, though that is contention
   rather than a hard cap, so up to about $2.30 a month at worst) and
   terms consents (create-only, at most 10,000 tiny ids). **Reads are still
   unbounded**: rules cannot count them, and an approved account can run queries
   from as many sessions as it likes, each pulling what it pushed (egress
   included — a 900 KiB note rewritten 20,000 times is 18 GB for every device
   that pulls it). Shared links are world-readable to whoever holds an id, so a
   popular link is reads too, bounded by the 900 KiB cap, the expiry and needing
   a plan to publish. Firebase App Check is the usual answer for reads — but it
   would lock out `@hushjot/cli`, a legitimate non-browser client that cannot
   attest as one, so enabling it needs a deliberate answer for the CLI (a debug
   token, a separate service identity, or accepting that sync is browser-only),
   not just a switch. Until then the backstops are the budget alerts and the
   kill switch. The kill switch's ruleset is not
   quite deny-all: it allows anyone a `get` of one document,
   `status/lockdown`, which does not exist and which the normal rules refuse.
   Being allowed to read it is how a refused client knows sync is paused for
   everyone rather than refused for its account (`src/core/sync/pause.ts`), so
   a lockdown does not tell paying users their plan lapsed or let a new device
   create a second vault. It discloses only that a lockdown is in place, which
   every client is about to say on screen anyway. It is the one billable request
   left during a lockdown: clients make it once after a refusal and then every
   15 minutes while visible, and someone scripting it costs one read a request,
   which the hourly read alert catches like any other read loop.
6. **Close the version-1 legacy window.** See
   [Encryption envelope](#encryption-envelope). Needs a release that re-seals
   and re-pushes the server's remaining version-1 notes, folders and share-key
   records, then turns `ACCEPT_UNBOUND_LEGACY` off and moves `FORMAT_VERSION`.
   Not before every existing vault has run the format-2 build and thirty days
   of history have aged out.
7. **Conflict resolution is preservation, not merging.** Both versions survive
   and the user reconciles them by hand. A three-way merge would be nicer and
   is riskier; §16 is explicit that data integrity beats cleverness here.
8. **Expiry lags by up to a day.** The TTL policies that remove expired note
   versions and expired shared links are active (October 2026), but Firestore
   sweeps them typically within a day of `expireAt`, not at that moment. Until
   then the ciphertext is stored and unreadable: the app filters expired
   versions, and the rules refuse to serve an expired share at all. See
   docs/firebase-setup.md, "Version and share expiry".
