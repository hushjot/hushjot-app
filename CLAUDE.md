# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HushJot (repository name: teksto) is an encrypted, local-first Markdown notepad. Notes are
end-to-end encrypted in the browser; Firebase is a sync backend that stores ciphertext it
cannot read. The full product specification is `encrypted-cloud-notepad-agentic-ai-spec.md` —
it is the authority, and the code cites it by section (`§7`, `§13`, `§16`…). Read the cited
section before changing anything that references one. `docs/security.md` is the companion
document for the crypto and threat model and must be updated alongside any change it describes.

## Commands

```bash
npm run dev              # Vite dev server on :5173
npm run build            # production build to dist/
npm run check            # svelte-check — this is the only type/lint gate; there is no ESLint
npm test                 # vitest unit suite (excludes tests/rules)
npm run build:core       # emit the publishable @hushjot/core into dist-core/
npm run vectors          # REGENERATE contract/format-vectors.json — see below, rarely
npm run verify           # check + build:core + test + test:rules + bench — the full gate
```

Single test file / single case:

```bash
npx vitest run tests/unit/syncEngine.test.ts
npx vitest run tests/unit/syncEngine.test.ts -t 'conflict'
npx vitest            # watch mode
```

Emulator-backed work (needs Java):

```bash
npm run emulators        # firestore :8085 + auth :9098, project teksto-dev
npm run test:rules       # firestore.rules tests, own vitest config, serial, own project id
```

Benchmarks are regression **gates**, not reports — they fail the command when a budget is
exceeded. `npm run bench` runs all of them; individual ones are `bench:size`, `bench:app`,
`bench:phase2`…`bench:phase6`, `bench:mobile`, `bench:scale`, `bench:allowlist`,
`bench:vault`, `bench:preview`, `bench:history`, `bench:historySync`, `bench:share`, `bench:lockdown`, `bench:rowMenu`,
`bench:capture`, `bench:dragDrop`. The Firebase-dependent ones (`phase4`, `phase5`, `allowlist`, `vault`, `historySync`, `share`, `lockdown`) wrap
themselves in `firebase emulators:exec`, so they need no running emulator. Two gate correctness
rather than a budget, because what they check has no meaning outside a real browser:
`bench:vault`, whether a device still knows its vault is the account's *after a reload*; and
`bench:rowMenu`, where the row `⋯` menu lands against a real viewport, including the flip near
the bottom edge and the clamp in a window too short for either side. `bench:share` is a third:
whether a browser that has never seen the app can open a link, and what the page it lands on
does *not* have on it. `bench:dragDrop` is a fourth: whether a drag
starts, lands, and cleans up after itself against a real viewport. `bench:lockdown` is another:
it swaps the emulator's rules for the kill switch's lockdown ruleset and back, and checks that the
app says "Sync paused" (not "needs a plan"), holds a new device's create form shut, and resumes
without a reload — it waits out the one-minute probe rate limit, so it takes a little over a minute. `bench:capture` is a fifth, and
the only bench that builds in **production** mode on purpose — `registerServiceWorker()` returns early unless
`import.meta.env.PROD`, so a development build would exercise none of the share-target path and
still pass. Results and Phase 0 spike
measurements live in `bench/RESULTS.md`.

`npm run bench:kdfDevice` is the exception to all of that: it builds `bench/device/` and serves it
on the LAN so it can be opened on a **physical phone**, and it gates nothing and is not in
`npm run verify`. It exists because Argon2id is memory-hard, so CDP CPU throttling cannot model it
— Spike 2 measured the same 94.7 ms at 1× and 4×. It has been run: **232.7 ms on a Google Pixel 9a,
21 Sep 2026**, which closed security open item #2 and left the parameters unchanged. Re-run it when
a materially different device is available — particularly a 4 GB one, where a 64 MiB allocation
could be refused outright, the one case the 9a did not test. `docs/security.md` § "Settling it on
hardware" holds the decision rule and the phone-side procedure.

Deploy (see `docs/firebase-setup.md`):

```bash
firebase deploy --only firestore:rules,firestore:indexes   # always BEFORE hosting
firebase deploy --only hosting           # predeploy runs npm run build
```

## Architecture

Layers, with a strict dependency direction — each layer may import downward, never upward:

```
src/viewer/              the share viewer's own document — no vault, no SDK
src/ui/*.svelte          Svelte 5 components (runes only)
src/ui/state/*.svelte.ts reactive singleton stores: workspace, vault, sync, search
src/editor/              CodeMirror 6 configuration (no I/O)
src/core/                platform-free logic: notes, crypto, repo, search, sync
src/adapters/firebase/   the ONLY files that know Firebase exists
```

`src/core/**` must stay free of DOM, Svelte and Firebase — it is what the unit tests exercise
directly.

**The write path.** A keystroke does one thing: `workspace.update()` writes a string into
memory and marks the note dirty. Everything else is deferred — `writeScheduler.ts` debounces
(150 ms idle, 2 s max latency, flush on `pagehide`), `encryptedCodec.ts` seals on the way into
IndexedDB, and the sync engine pushes on its own timers. Search indexing happens
in a worker. Nothing on the typing path may wait for encryption of a whole note, IndexedDB,
Firebase or the network (§7, §33.4).

**The encryption seam.** `src/core/repo/codec.ts` defines a `Codec`; the repository, the
IndexedDB schema and every caller are written against it. Turning a plaintext database into an
encrypted one is a codec swap — no schema change, no migration. Keep new persistence work
behind this seam.

**What is plaintext in the database.** Only `id`, `updatedAt`, `revision`, `deleted`. Titles,
folder names and a note's `createdAt` live *inside* the encoded blob. An index cannot be built over a value the database
cannot read, so **anything you index is something you have promised not to encrypt** — sorting
and filtering 10,000 notes in memory costs ~3.4 ms, so there is nothing to buy by indexing more.

**Sync cadence.** Nominally an 800 ms idle debounce with a 3 s ceiling, but the ceiling is the
number that matters: a change is queued on every write-scheduler drain, which happens 150 ms
after any pause in typing, so the idle timer is restarted faster than it can expire and does not
fire while someone is typing. Structural changes — a note created, deleted or moved, a folder
added, renamed or deleted — skip the debounce entirely on a 100 ms coalescing nudge. A cycle
that ends with nothing queued arms a 60 s backstop, because remote changes otherwise arrive
only on a listener that can go quiet without saying so. While the tab is hidden the backstop is
15 min instead (it is most of an idle tab's Firestore bill); returning to the tab syncs at once,
and a follower that is focused sends `resync` so a hidden leader does too. The Cadence comment at the top of
`src/core/sync/engine.ts` is the authority; do not re-derive these numbers from §8 alone.

**The sync boundary.** `src/core/sync/adapter.ts` mentions no Firebase type. Everything crossing
it is `Bytes` ciphertext; the engine never holds the encryption key. The Firebase adapter is
reached by dynamic import so the SDK never lands on the critical path.

**Search** (`src/core/search/`) is a hand-written inverted index with two-character prefix
buckets, running in a worker, because the content is E2E-encrypted and cannot be searched
server-side. It holds tokens, never text. It also derives inline `#tags`
(`src/core/notes/tags.ts`) as it indexes — tags are text in the note, never a stored field — and
posts the page the tag names with counts, only when they change and never mid-build. The sidebar's
Tags section and a tag's note list come from the worker, so with no worker there are no tags.

**The query grammar** is `parseQuery` (`src/core/search/query.ts`), shared with `@hushjot/cli` so a
query pasted from the app means the same thing in an agent's hands: `#tag` prefix-filters,
`in:Work/DB` scopes to a folder *and its subtree* (`in:/` is unfiled), `"quoted"` is a literal
phrase and `-` negates any of them. Four things about it are load-bearing. **Quoted runs are lifted
before anything else is looked at**, which is what makes quotes the escape for a literal `#` or `-`
— `"#include"` was previously unsearchable, because `#` has been the one operator since the index
was written. That lifting reads the token *before* the quote, so `-` still negates and `in:` still
claims it: without that, `in:"My Work"` — the obvious way to write a folder name with a space —
parses as a bare `in:` plus a phrase search, which is wrong and silent. **An unterminated quote is
plain words**, because this re-parses on every keystroke.
**`in:` is not resolved here**: folder names are sealed, so only the page (or the CLI) can turn one
into ids, and the index is handed ids it never maps back to a name. And **a query that only
excludes returns nothing** (`hasPositiveTerm`), because `-draft` alone has no answer but "every
note you own".

**Phrases are verified against re-read bodies** (`src/core/search/phrase.ts`), not resolved in the
index. Adjacency needs word positions, and positions beside the tokens would make the index close
enough to a note to rebuild it — which is exactly what `docs/security.md` says it cannot do. So the
index narrows to notes holding all the phrase's words in any order and the worker re-reads those
few bodies, discarding each, bounded by `VERIFY_MAX` and by an early exit at the caller's limit.
The CLI runs the same function with its already-open bodies. `bench:scale` gates it with its own
budget, and that bench case — unlike every other one in that file — waits for the results to
actually render, because a phrase is the only query whose work is off the main thread.

**The index knows each note's folder, and a move has to tell it.** `IndexDocument.folderId` is
optional (the published type must tolerate a CLI that predates it) while `protocol.ts`'s
`UpsertRequest.doc` makes it required, so `tsc` names every app write path — the same split
`createdAt` uses. The trap is `Workspace.#writeMeta`, the pin-and-move write, which holds **no
body**: routing a move through `search.upsert` would carry `content: ''` and, since
`SearchIndex.add` is remove-then-add, delete every word the note owns from the index. That is why
`setFolder` is its own protocol message and its own index method. Remote moves need none of this —
the engine writes ciphertext and `#scheduleSearchRebuild` re-reads the store.

**Pinned notes** live in the sealed meta as `pinnedAt` (omitted from the JSON when null, so an
unpinned record is byte-identical to before). `orderForList` (`src/core/notes/model.ts`) puts pins
first by pin time in every list view and the empty-query finder; the list marks them in-row, never
with a header row, because the virtual window needs uniform row heights.

**The list's sort order** is still decided in that one function. `comparatorFor` offers
`edited` (the default), `created` and `title`, each reversible; `ui/state/noteSort.svelte.ts`
holds the choice in `localStorage` per device, as the theme and the text size do, and
`filterForList` takes it through `ListFilter.sort` so the sidebar and the phone cannot drift.
Three things are load-bearing. **The default sort is the original code path**, identity fast-path
included — it trusts the caller's recency order, which `Workspace` guarantees, and
`tests/unit/model.test.ts` asserts the array comes back by reference; every other sort builds a
list and orders it itself. **Pins lead under every key** and are ordered by that key, except under
the default, where they keep `pinnedAt` order so the top of the list holds still while a pinned
note is edited. And **text search is not sorted by it** — a relevance score answers "which note did
I mean" better than a date, so only browsing views and the empty-query finder apply the choice.

**A note's `createdAt` is sealed, not indexed.** `NoteMetaPayload.createdAt` is optional and
omitted when absent, so records written before it existed keep their bytes; `NoteMeta` and
`PersistedNote` make it **required**, which is what makes the compiler name every write path that
has to carry it. Exactly one place resolves its absence — `loadAllMeta` falls back to the row's
`updatedAt`, the note's own value rather than a clock, so every device agrees and the answer
freezes on that note's next write. No migration, no `DB_VERSION` bump. `putNoteMeta` is the trap,
the same one the excerpt comment describes: it is the pin-and-move write and has no note to
re-derive from, so dropping the field there resets the created date of every note anyone pins.

**Markdown preview** (`src/editor/preview/`, `src/ui/Preview.svelte`): each tile is in Edit,
Split or Preview mode (`src/ui/viewMode.ts`, persisted per note id in `teksto:tile-modes`). The
preview is a lazy chunk. It re-parses with `@lezer/markdown` on a 150 ms debounce (1 s ceiling)
in an idle callback, and reuses the DOM of every top-level block whose source text did not
change, so a keystroke in Split rebuilds one block. The editor is hidden, never unmounted, in
Preview, so undo history and scroll survive; nothing may focus it there — which is also what lets
a preview checkbox tick: it resolves its `data-task` offset (relative to its block, because blocks
outlive the text ahead of them) and dispatches one transaction into that hidden view, so the tick
takes the ordinary write path and is one undo step. A preview with no `onToggleTask` — the share
viewer, the history panel — keeps its boxes `disabled`. `bench:preview` gates keystroke latency
beside a live preview.

**Export and import** (`src/core/portability/`, `src/ui/portability.ts`, `src/ui/Portability.svelte`):
a hand-written zip (STORE out; STORE and DEFLATE in via `DecompressionStream`), the §24 folder
layout, and `Workspace.importNotes` as the bulk write path — batched `putNotes`/`enqueueMany`,
never `create()` per file. All of it is lazy. File drops and pastes are caught by capture-phase
window listeners in `App.svelte` so CodeMirror never inserts a dropped file; they stage the files
in the dialog and nothing is written until Import. `docs/security.md` § "Export and import".

**Share a note by link** (`src/core/share/`, `src/ui/share.ts`, `src/ui/ShareLink.svelte`,
`src/viewer/`, `s/index.html`). Publishing mints a **fresh random 256-bit key — never the DEK**,
which is non-extractable and could not go in a URL anyway — then seals a *snapshot* of the note
with the existing envelope and writes one blob to a public-read `shares/{id}`. The link is
`/s/#s1.<id>.<key>`: **everything is in the fragment**, which browsers never transmit, so the web
host's own logs cannot say which share was opened and an unfurl bot gets a shell with no content
in it. Two documents per share and the split is the point — the public one holds ciphertext and
two timestamps and deliberately **no owner id** (two links from one person must not be
correlatable), while `users/{uid}/shares/{id}` proves ownership to the rules and carries the
share's key *sealed under the vault*, which is what lets the link be copied again or updated from
another device. **Publish is one commit** — private record, public blob and storage meter
together, the rules checking the blob against the record as the commit leaves it (`getAfter`), so
a publish is metered like any push and cannot leave half of itself behind. **Revoke's order is
load-bearing**: it deletes the public blob first (deleting the record first would remove the proof
the delete rule needs). Expiry is enforced by the **read rule**; the TTL (active, like
the version TTL) only cleans up, typically within a day. `bench:share` is the gate; `docs/security.md` § "Sharing a note by link".
The two commands land differently on each surface: `share-note` is on the note row's `⋯` and in
`PHONE_MORE_NOTE`, while `shared-links` — the standalone list — is the **sidebar's link icon** on
a desktop (plus a secondary link in the Account dialog) and `PHONE_MORE_LIST` on a phone. It
shipped with the phone row and no desktop button at all, because `moreItems.test.ts` forces the
phone and nothing forced the desktop; `tests/unit/shortcuts.test.ts` now names a home for every
`App`-group command. **The sidebar icon is ungated on purpose**: `syncStore.signedIn` is
`user !== null` with no `authSettled`, so it is false for the first moments of every load and
permanently false in a build with no backend — gating a control on it makes the control vanish
rather than explain itself, which is exactly how this was unreachable the first time.

**The share viewer is a second HTML document**, `s/index.html` → `src/viewer/`, not a route.
It carries no vault, no IndexedDB, no unlock form and no Firebase SDK — the fetch is one plain
REST `GET` (`src/adapters/firebase/shareRest.ts`) — so a link from a stranger cannot present a
fake passphrase prompt on the real origin. Three build-time things know about the second entry
and each fails quietly if it stops: `bench/size.mjs` budgets **per entry** (summing two documents
different people download would make the critical-path number meaningless); `src/sw.js` picks the
shell by longest matching prefix from `BUILD_SHELLS`, or every navigation — a share link
included — is answered with the app's `index.html`; and `BUILD_VERSION` hashes **both** shells,
since neither is content-hashed. `tests/unit/serviceWorkerPlugin.test.ts` guards the last two.
The design tokens are inline in both shells for first paint and therefore duplicated, kept in
step by `tests/unit/shellTokens.test.ts`. The viewer's theme, text-size and typeface controls are the app's own
stores (`ui/state/theme`, `textSize`, `editorFont`) imported unchanged — they touch only `<html>`
and share the app's `teksto:` keys on purpose, the only storage the viewer ever writes.

**Quick capture** (`src/core/capture/`, `src/ui/state/capture.ts`, `App.svelte`'s `readCapture`,
`src/ui/QuickCapture.svelte`, `docs/quick-capture.md`). Text shared *into* the app, by two routes
that meet at one applier. Android: the manifest declares a `share_target` **POST** to `/capture` —
POST and not GET because a GET target puts the user's note in a query string, which is the address
bar, session history and Hosting's access log; `src/sw.js` reads the body, holds it **in memory
only** keyed by `event.resultingClientId`, `waitUntil`s until claimed or a minute passes, and
answers with the precached shell. iOS: a hand-built Shortcut opens `/#c1.<percent-encoded text>`,
percent-encoded because Shortcuts has a one-action "URL Encode" and base64url would need three.
`core/share/link.ts` reserved the `s1.` prefix as a discriminator for exactly this, and
`tests/unit/capture.test.ts` asserts neither parser reads the other's fragment. Three things are
load-bearing: `main.ts` claims the share **before mount**, because the worker's memory will not
wait for a passphrase; a `hashchange` listener exists because a Shortcut may reuse an open tab,
which is a same-document navigation where `startWorkspace` never runs again; and the note is
written and opened with an **Undo** flash rather than offered like an incoming share link — a
capture that costs a confirmation tap is not quick capture, and `docs/security.md` § "Quick
capture" states the residual that buys (a cross-origin page can forge a POST and make a junk
note). `bench:capture` is the gate.

**Note history** (`src/core/history/`, `src/ui/HistoryPanel.svelte`, `src/ui/RecentlyDeleted.svelte`): a version
is a byte-for-byte copy of a note's stored ciphertext, kept in a **separate** IndexedDB database,
`teksto-history`, so its schema can never block the note database's upgrade. `#persist` issues
`repo.loadRawNotes` *before* `putNotes` and does not await it — IndexedDB runs the read against the old
rows, and `bench:history` checks that the browser really does. `policy.ts` decides when (session start
after 5 min quiet, a checkpoint every 10 min, and always before delete or restore); `retention.ts` fixes
the expiry at capture (24 h / 7 d / 30 d tiers plus a size cap). Only `CaptureTracker` is eager; the
service, store, diff and both dialogs are lazy. History failures are swallowed and never surface as a
save failure. Undelete restores under the **original** id. Versions sync as passengers: the engine uploads a
small page per cycle (`VERSION_PAGE`, one commit and one meter write per version, so the rules count
each one) after the note push (a tombstone's versions go *before* it), gated on `vaultOwnsAccount`, and
never arms a timer or counts as pending. They live at `users/{uid}/notes/{id}/versions/{sealId}` — a
subcollection, so the pull cursor and the listener never see them — are create-only in the rules, and are
removed by a TTL policy, active since the project moved to Blaze: `firebase.json` deploys
`firestore.indexes.blaze.json` (`tests/unit/firestoreIndexes.test.ts` keeps it in step with `firestore.indexes.json`).
The sweep lags expiry by up to about a day, so every reader still filters on `expireAt`. They are fetched on demand, never pulled.

**The phone shell** (`src/ui/mobile/`, one lazy barrel). Below 720px
(`MOBILE_QUERY`) the desktop chrome is replaced rather than compressed: a
`PhoneHeader` (the filter button *is* the list's title; back + a full-size
Edit/Preview control + `⋯` on a note), a four-slot `TabBar` — Notes, Search,
New, More — and a `KeyBar` of Markdown keys that takes the tab bar's place
while the editor holds the keyboard. The note list renders `NoteList` directly;
the folder tree and Tags section do not exist there (§21), they are behind the
header's filter, which reuses `FolderPicker`. The More sheets reuse
`RowActions` with `anchored={false}` — it is already a centred, scrimmed sheet
of 44px rows — and their contents are built by `mobile/moreItems.ts`, whose
test asserts no non-`desktopOnly` command is left unreachable. Nothing outside
`src/ui/mobile/` may static-import from it. **A dynamic import saves JS but
never CSS**: `bench/size.mjs` marks every `.css` asset eager unconditionally,
so phone styles are charged to the 160 KB budget wherever they live.

**Desktop must render byte-identically.** The seam is a `{#if mobile.matches}`
branch wrapping the existing desktop markup in `{:else}`, never rewriting it,
plus `.app.mobile` rules in `App.svelte` and a `@media (max-width: 720px)`
block inside each shared child. That last part is not style: Svelte scopes CSS
per component, so a `.app.mobile .status` rule written in `App.svelte` could
never match `StatusBar`'s own markup — which is why `StatusBar` is gated with
an `{#if}` instead.

**The virtual keyboard.** `interactive-widget=resizes-content` plus `100dvh`
is a complete answer on Android Chrome. iOS Safari implements neither, so
`mobile/keyboardInset.ts` publishes `--kb-inset` from `visualViewport`. The
measurement needs no platform check — on Android the viewport has already
shrunk, so it evaluates to 0. It sits on the typing path (iOS fires
`visualViewport.scroll` while keeping the caret visible), so it does no
layout-forcing reads, coalesces into one `requestAnimationFrame`, writes a CSS
property directly rather than through a rune, and ignores sub-pixel changes.
`.cm-content` is padded by that inset plus the key bar's height, because
CodeMirror scrolls the caret into the *layout* viewport, which on iOS does not
know the keyboard is there. **None of the iOS half is covered by CI** — every
bench runs Chromium.

**The note excerpt.** A phone row shows the note's opening line under its
title. It is sealed into the *meta* record (`excerptOf`, `NoteMetaPayload`),
never read from the body, because bodies are a separate store `loadAllMeta`
deliberately never touches. The trap: `putNoteMeta` — the pin-and-move write —
has no body to derive from, so `excerpt` must be a field on `NoteMeta` **and**
be written back there, or pinning a note silently blanks its second line.
`docs/security.md` records that the sealed meta now holds body text.

**Swipe** (`src/ui/rowSwipe.ts`, pure and unit-tested) is an accelerator over
the pin and `⋯` buttons, never a replacement — `bench:phase6` requires both
stay visible at 44×44. Its listeners are delegated to the `<ul>`, because a
virtualized row is destroyed on every scroll frame, and the row in play is
tracked by note id for the same reason. `touch-action: pan-y` is what keeps
vertical scrolling native. The `{#each}` is keyed, so the transform must be
cleared *before* pinning — otherwise the same node arrives at the top of the
list still translated.

**Row menus** (`src/ui/RowActions.svelte`): one component serves the note row's `⋯` and the
folder row's. On a pointer screen it anchors to the button — below it, flipped above when the
bottom of the window will not take it, clamped inside the viewport when neither side fits;
below 720px it stays the centred, dimmed sheet it began as. Three things are load-bearing and
each has a comment saying so: the caller passes the button's **rect**, not the element (a
virtualized row is destroyed on scroll and a detached node answers `getBoundingClientRect`
with zeroes); placement writes `top`, `left` and `visibility` straight onto the node, because
a `$state` write would not reach the DOM before the same effect calls `.focus()` and a hidden
element cannot take focus; and scroll or resize **close** the menu rather than moving it.
Every item's `run` fires *after* `act()` has closed the menu, so each must have captured its
id as a plain value — `App.svelte` builds both item lists in a `$derived.by` for exactly that
reason. `bench:rowMenu` is the gate.

**Note links** (`src/core/notes/links.ts`, `src/editor/noteLinkSyntax.ts`,
`src/editor/wikiLink.ts`, `preview/model.ts`'s `noteLink`, `App.svelte`'s `followLink`).
`[[Title]]` and `[[Title|label]]` reference another note. **A link is a resolution, not a
pointer**, and that is the whole design: a note has no title field — `deriveTitle` takes the first
line and `portability/exportTree.ts` records that titles are not unique — so `notesMatching`
(`core/notes/model.ts`) answers "which note" when the link is *followed*, against `Workspace.metas`,
using the same `TITLE_ORDER` collator the title sort uses so the link and the sidebar cannot
disagree about what one title is. Nothing is stored: no sealed field, no format vector, no
`FORMAT_VERSION` move, no CLI release, and `tokenize` already indexes `[[My Note]]` as `my` and
`note`, so a link is findable by its words in the app and in `hushjot search` with no index change.
Five things are load-bearing. **The syntax is a lezer node, not a regex**, because `[[Some Note]]`
already parses as an inner unresolved `Link` (`Link@5-16`) and the preview's plain-text pass never
sees it — so `noteLinkSyntax.ts` installs an inline parser `before: 'Link'`, and both the editor's
parser and the preview's take the *same* extension. **Adding it to one `configure` and not the other
is silent**, which is why `tests/unit/noteLinks.test.ts` parses one string with both.
**`noteLinkSyntax.ts` is a separate file from `wikiLink.ts`** because the share viewer downloads the
first and must never reach `@codemirror/language` through the second — the 87 KB regression
`preview/render.ts` has a comment about. **The preview renders a `button.notelink` with `data-note`
and no `href`**, `disabled` by default, and `render.ts` enables it only where the caller passed
`onNoteLink`: the task-checkbox contract, one control along, which is what leaves the share viewer
and the history panel inert (`bench:share` gates it). And **⌘-click is not free** —
`clickAddsSelectionRange` defaults to it — so `noteLinkClick` takes the event only when the click
lands inside a `NoteLink` and every other ⌘-click still adds a cursor; the keyboard route is the
`follow-link` command (⌘J ⇧L) — **ungated on purpose**, as
the sidebar's Shared links icon is, because "is the caret in a link" lives in the syntax tree and is
not a Svelte dependency, so gating it would hide the command on a stale caret; it flashes instead. The
touch route is the **link chip** (`src/editor/linkChip.ts`), Obsidian's "Follow link" popover: a
click or tap that places the caret in a note link, Markdown link or bare URL shows one button — Open
note, Create "Title" for an unresolved link, or Open link through the preview's `safeHref` (now in
`preview/href.ts`, re-exported by `model.ts`, so the editor reaches it without the lazy chunk). It is
pointer-only and goes
on the next edit or caret move, so it costs a keystroke nothing. An unresolved link offers to
create the note it names, because a link rots whenever the first line of its target is edited and
rewriting other notes' bodies from a keystroke is what §7 forbids. Accepted edge: a note whose first
line is a bare `[[Foo]]` is titled `[[Foo]]`, because `cleanLine` is a frozen derivation.

**Drag and drop** (`src/ui/dragDrop.ts`, `src/ui/state/drag.svelte.ts`, `NoteList.svelte`,
`Sidebar.svelte`): a note onto a folder row, a folder onto another folder, either onto "All notes"
for the top level. **Re-parenting only** — there is no manual ordering and it is not an oversight:
a rank would have to live in the sealed meta, and `sealNote` in the CLI builds that payload field
by field over a full-replace write, so a field it did not carry would be deleted from the note on
every device (`src/core/public.ts` states the rule). Folders have no `revision` and no CAS, so
concurrent reorders would collide silently. Every drop reuses `Workspace.moveToFolder` /
`moveFolder` and `canMoveFolder`; there is no new write path. Four things are load-bearing and each
carries a comment. **Nothing is offered as `text/plain`** — CodeMirror's own drop handler reads it
and would insert the note into the note — and the two private formats are also what keeps file
import working untouched, because its capture-phase window handlers gate on `types.includes('Files')`
and the two never overlap. **The kind travels as an empty second format**, because
`dataTransfer.getData()` returns "" during `dragover`: a target must decide whether to accept a drag
long before it may see the id, so `types` is the whole message and the verdict is recomputed on
drop. **Teardown is on the window, not the row**: above `VIRTUALIZE_ABOVE` the source `<li>` is
destroyed when it scrolls out, and `dragend` never reaches a detached node — bound to the row, an
abandoned drag left a folder lit up forever. And **listeners are delegated to the two `<ul>`s**, as
`rowSwipe`'s are, so `bench/scale.mjs`'s 60-row DOM budget is untouched. The move is announced
through `showFlash` with an Undo, on the drag *and* the dialog path so the two cannot drift — the
flash is the app's only `aria-live` region. Desktop only: below 720px there is no folder tree to
drop onto (§21). `bench:dragDrop` is the gate, and its comment explains why the mid-flight checks
dispatch `DragEvent`s by hand rather than using Playwright's native drag.

**The published core** (`src/core/public.ts`, `tsconfig.core.json`, `tools/build-core.mjs`,
`contract/`). `@hushjot/core` is a Node package built out of this repo for a **second client**:
`@hushjot/cli`, a CLI and MCP server that hold the key on the operator's machine. `public.ts` is a curated barrel — a *list*, not a
re-export of the directory, because admitting a symbol makes it an API with a release cycle —
covering the envelope, key records, `codec.ts`'s sealed-JSON helpers, `notes/`, `search/index.ts`
and the `sync/adapter.ts` types. Nothing above `src/core/` and nothing that touches IndexedDB.

The reason it exists rather than the CLI reimplementing the format: **a second implementation of
`deriveTitle` or `noteMetaJson` would work perfectly and disagree silently.** `contract/` is the
guard — `format-vectors.json` holds frozen ciphertext, key records and derivations that
`tests/unit/formatVectors.test.ts` asserts here and the CLI asserts against the *published*
package, and the build copies the live `firestore.rules` in so the CLI's emulator tests run the
real rules. **`npm run vectors` regenerates those frozen bytes and is almost never the right
move**: a vector regenerated on every run proves nothing, so a failure means "did I mean to
change the format", and if yes, `FORMAT_VERSION` moves and the CLI needs a release.

Three build details, each with a comment saying so. It is **tsc, not Vite** — Vite's worker
plugin would try to bundle `kdf.ts`'s `new Worker(new URL('./kdf.worker.ts'))` into a package
where that branch is unreachable; the worker is deleted from the output for the same reason, so
the package's KDF is Node-only. `tsconfig.core.json` needs **`include: []` beside `files`**,
because `extends` inherits the app's globs and without it tsc emits the whole app next to the
sources (it did, once — 468 stray files); `build-core.mjs` checks for that and fails loudly.
And the package ships a **`globals.d.ts` declaring `CryptoKey`** as an interface, because
`@types/node` keeps it in the `webcrypto` namespace and a Node consumer with `lib: ["ES2022"]`
could not otherwise typecheck a call; `importKey` takes `Bytes` rather than `BufferSource` for
the same reason, since a type alias cannot be redeclared the way an interface can merge.

**Multi-tab**: exactly one tab syncs, elected by a Web Lock (`src/core/sync/tabs.ts`); others
persist locally. Leadership is about the *backend*, not the database — every tab writes to the
same IndexedDB and holds its own copy of the note list, so a tab that writes broadcasts `local`
to all the others (any role, both directions) and they re-read. The channel is owned by the
workspace and lent to the engine, so it works with no account — the engine only borrows it. That refresh is rate-limited to
1 s rather than debounced, skips the search rebuild, and never reopens a note whose editor the
user has touched (checked per tile); `docs/security.md` § "Multi-tab" has the reasons for all three.

**Crash journal** (`src/core/repo/journal.ts`): `localStorage` is the only synchronous storage
API, so it is the only thing that reliably completes during `pagehide`. It holds one sealed
copy per open note (up to four tiles, `src/ui/tiling.ts`) — **ciphertext only**, never plaintext.

## Invariants that are easy to break

- **Two revision counters, not one.** A note's local `revision` advances per keystroke; the
  backend's advances by exactly one per accepted write (the rules enforce it). Pushing one into
  the other's slot rejects every multi-keystroke push, which reads as a conflict and forks the
  note repeatedly. `src/core/sync/state.ts` records the backend's position so a push can send
  `base + 1`. Read that file before touching push logic.
- **A pin or a move must not fork a note.** Both push the whole document, so they lose the
  compare-and-swap to another device's edit like text does. The sync state records the nonce of
  the body at `base` (`bodySeal`); a rejected push whose stored body still carries it is
  metadata-only, so the engine adopts the remote and `Workspace.rebaseMeta` lays the local pin and
  folder over it — no conflict copy. Anything short of that proof still gets a copy. And a pending
  save carries a meta *snapshot*: `#writeMeta` flushes before writing, and `#persist` takes pin and
  folder from the live list, or the keystrokes typed just before a pin undo it.
- **An empty local database is not an empty account.** First-run content is decided by
  `src/core/notes/firstRun.ts` and written only by `Workspace.completeFirstRun()`, which waits
  for the gate in `App.svelte` — no backend, or auth reporting nobody, or a completed sync
  cycle. Seeding straight from "`loadAllMeta()` returned nothing" is how a private window or a
  new machine wrote a second welcome note and "Scratch" and synced them everywhere. Two
  traps behind it: `loadAllMeta` hides tombstones, so a user who deleted every note looks brand
  new (use `hasAnyNote()`), and `adapter.user` is null before the session is restored, so only
  `adapter.authReady` distinguishes "nobody" from "not asked yet".
- **Local mutations are always queued; whether the queue may drain is a separate
  question.** `Workspace.#queue` writes to `syncQueue` with or without an account, because
  work done before a sign-in was otherwise invisible to sync forever. What decides whether
  any of it reaches a backend is `src/core/sync/backfill.ts`: the `app:owner` binding (kept
  outside the `sync:` namespace so a sign-out cannot erase it) and whether this device owns
  the account's key record — `app:vaultAccount`, in the same namespace and for the same
  reason. **That answer must be written down.** Held in a component variable it was
  re-derived from nothing on every page load, so the device that published the account's own
  key record read it back, failed to recognise it, told the user their passphrase was wrong
  and retired its own backfill. Comparing two key records settles this in one direction only:
  identical bytes are one record in two places, but inequality proves nothing — no
  identifier, salts re-randomised by a passphrase change, and unwrap-success proves only the
  passphrase. `sameKeyRecord` is therefore a migration aid, never the primary answer. A push
  into the wrong account is permanent: the rules refuse deletes.
- **`adapter.user` being null is not "signed out"** — and this trap has a second victim
  besides first-run seeding. `adoptRemoteVault` in `App.svelte` must wait on
  `syncStore.authSettled`, not `signedIn`: `connect()` resolves before Firebase restores the
  session, so a one-shot call finds nobody, adopts nothing, and leaves a signed-in user on
  the *create* screen. `Vault.create()` mints a fresh random DEK — the passphrase wraps the
  key, it never derives it — so the right passphrase then produces the wrong vault, for good.
  The unlock screen enforces the same invariant from the other side, in `App.svelte`'s
  `accountVault` derivation: the create form is held shut for the whole window before
  `authSettled`, not merely while the key-record lookup is in flight, because a fast typist
  could otherwise win the race the effect exists to prevent. `src/ui/accountVault.ts` says
  what each state means; `bench:phase4` asserts the create form was never reachable on a
  signed-in device's journey.
- **`push()` is paged.** `PUSH_PAGE` bounds a cycle the way `PULL_PAGE` bounds a pull. An
  unbounded drain turns a backfill into tens of thousands of serial round trips inside one
  cycle, with `pull()` — and therefore `onFirstSync`, and therefore the first-run gate —
  queued behind all of it.
- **Sign out locks, and the lock lives in the UI.** `signOutNow` in
  `App.svelte` is flush → `syncStore.signOut()` → `workspace.shutdown()` →
  `vaultStore.lock()`, in that order: the sign-out writes through the
  repository that the shutdown then closes. Do not move the lock into
  `syncStore.signOut()` — that method is also called mid-sign-in when an
  account has no plan or invitation, and it would throw the user out of their
  own vault. Sign-out deletes nothing; the notes stay, encrypted.
- **A reset tells the other tabs before it touches anything.** `removeLocalData`
  posts `{ type: 'reset' }` on the workspace's tab channel and then every tab
  runs `applyReset` — sign out (while the repository lives) → `shutdown()`
  (which closes the repository, the history store and the search worker, the
  other three connections to `teksto`) → `vaultStore.reset()` → clear every
  `teksto:` localStorage key → reload. There is deliberately **no flush**: the
  one place this differs from `lockNow`. The broadcast is load-bearing, because
  `deleteDb` resolves on `onblocked` (`core/repo/idb.ts`) — a sibling that
  holds its connection turns the delete into a *pending* delete the caller is
  told succeeded, while that tab still shows the notes. `core/repo/deviceData.ts`
  scans the `teksto:` prefix rather than listing keys, because a list is wrong
  the first time somebody adds a preference and fails silently. `bench:vault` is
  the gate for all of it.
- **A share key is never the vault key, and never leaves the fragment.** Each share mints its
  own key (`core/share/payload.ts`), because the link is handed to someone else; the DEK is
  non-extractable precisely so this cannot be done by accident. The key reaches the page through
  `location.hash` and goes nowhere else — not a query string, not a header, not an error message,
  not `sessionStorage`. That last one is why the viewer's "Save to my notes" navigates with *the
  link* rather than the decrypted text.
- **The preview renderer must not static-import `@codemirror/language`.** `LanguageDescription`
  drags in the editor runtime, ~110 KB gzipped, which is free inside the app and is the entire
  page on the share viewer. The highlighting lives in `src/editor/preview/highlight.ts` behind a
  dynamic import; the path was always asynchronous (a fence renders plain and is upgraded), so
  nothing changed but the graph.
- **There is a second client, and it reads these bytes.** `@hushjot/cli` speaks the same
  Firestore protocol from Node. Two consequences. Any change to stored bytes — the envelope,
  `noteMetaJson`'s omission rules, `deriveTitle`, `excerptOf`, the tokeniser — is a change to a
  published contract: add or update a case in `contract/format-vectors.json`, move
  `FORMAT_VERSION`, and expect the CLI to need a release. And any change to `firestore.rules`
  reaches the CLI's emulator tests immediately, because the build ships the live rules file
  inside the package. The CLI is read-only on `users/{uid}/keys/primary` and has no delete verb;
  `docs/security.md` § "The CLI and MCP server" is the contract for what it may do.
  **And a third:** the Rust SDK (`../hushjot-rs`) ports `src/core/` and the sync engine for
  third-party apps. It vendors `contract/` (`tools/sync-contract.sh`), so a format or rules change
  must also pass its `cargo test` and `tools/emulator-test.sh`. Behaviour it must reproduce but that
  is not stored bytes — the query grammar, tags, folders, list order, search ranking — is pinned in
  `contract/behaviour-vectors.json` (`npm run vectors:behaviour`, deterministic, safe to regenerate;
  `tests/unit/behaviourVectors.test.ts` fails when it is stale). `docs/security.md` § "Third-party
  clients: the Rust SDK" is its contract.
- **Every vault-key seal names its record.** Notes (meta and body), folders and share-key index
  entries are sealed with `recordContext(kind, id)` (envelope version 2), and must be opened with
  the same context — through `Codec`, which takes the id on every call, or explicitly as the crash
  journal and `ui/share.ts` do. A new place that seals under the DEK without a context writes an
  unbound version-1 record that the legacy re-seal has already finished with, and that will stop
  opening when `ACCEPT_UNBOUND_LEGACY` closes. Key-record wraps and share payloads are unbound on
  purpose. `docs/security.md` § "Encryption envelope" has the legacy window.
- **Never resolve a conflict destructively** (§16, §33.9). A rejected push keeps the local text
  as a separate conflict copy; nothing is auto-merged, nothing is discarded.
- **Never send plaintext titles or bodies to Firebase** (§33.5), and never invent cryptographic
  primitives (§33.6).
- **The passphrase generator and estimator stay lazy.** `src/core/crypto/passphrase.ts` and its two
  vendored lists (`wordlist.ts`, `commonPasswords.ts`, ~17 KB) are reached only through the dynamic
  `import()` in `Unlock.svelte`, and the type import beside it must stay `import type` so it erases.
  A static import would put them between every returning user and their notes to answer a question
  asked once, on the create path. Argon2id buys 15-17 bits against offline guessing, so the
  passphrase is the larger half of that trade — `docs/security.md` § "The passphrase itself".
- **Critical-path budget: 160 KB gzipped**, enforced by `bench/size.mjs`. "Eager" bytes are
  everything reachable from the entry without crossing a dynamic import. Do not static-import
  `@codemirror/lang-*` grammars or `@codemirror/lang-markdown` — the latter drags in HTML, CSS
  and JS grammars, which is why `src/editor/markdownLean.ts` exists. Code grammars load
  dynamically per language. The same applies to `@codemirror/language-data`: it is the ~130
  language fallback behind the curated registry and is reached only through the dynamic import
  in `findInCatalogue` (`src/editor/languages.ts`).
- **A fence naming an unknown language must cost one lookup, not a spin.**
  `ParseContext.getSkippingParser(until)` re-parses when `until` settles, so an unmemoised
  catalogue lookup would mint a fresh promise on every re-parse, forever. `markdownLean.ts`
  caches misses as an explicit `null`; `tests/unit/languages.test.ts` guards it.
- **The preview never parses markup.** Note text reaches the DOM only via `createElement`,
  `textContent` and `setAttribute` — never `innerHTML` or `{@html}`. Links pass `safeHref`,
  images are never fetched, heading anchors are `data-anchor` rather than `id`.
  The single exception is a mermaid diagram's SVG. It is parsed inertly and
  allow-listed by `preview/mermaidSvg.ts` before it is adopted, and mermaid is
  reached only by `render.ts`'s dynamic import, never statically.
  `docs/security.md` § "The Markdown preview" is the contract.
- **Syntax beyond GFM is one shared list.** `src/editor/extendedSyntax.ts` (highlight,
  sub/superscript, emoji, heading ids, footnotes, definition lists) is spread into *both*
  `configure` calls, the `noteLinks` arrangement; `tests/unit/extendedSyntax.test.ts` parses with
  both. Its two block constructs apply at the top level only. Footnotes are numbered in
  **definition** order, because citation order would make a block's output depend on the blocks
  before it and break block reuse; their text joins the model's epoch. The emoji table
  (`emojiMap.ts`) is reached only by `render.ts`'s dynamic import — the share viewer had 0.1 KB
  of budget left after this file, so nothing more goes into its eager path. (Its budget is now
  59 KB. It was raised by 1 KB for the phone header's popovers and the hushjot.com link. Envelope binding then took the rest (see `core/crypto/binding.ts` for why it is a separate module), so it was raised by 1 KB again for the mermaid hook, leaving ~0.7 KB spare; the lockdown probe and its "temporarily unavailable" screen then took most of that, leaving ~0.2 KB; it was raised to 59 KB when the Oct 2026 dependency refresh's Svelte and lezer
  releases added 1 KB.)
- **App shortcuts live in one registry.** `src/ui/shortcuts.ts` drives the dispatcher in
  `App.svelte`, the command palette (`>` in ⌘P) and the ⌘J hint. The dispatcher is a
  *capture-phase* window listener so it runs before CodeMirror — the key after the ⌘J leader
  would otherwise be typed into the note — and it must return on its first line for a key with
  no modifier, because it sits on the typing path. Browsers keep most free chords (⌘N/T/W,
  ⌘1–9, ⌘⌥←/→ on a Mac, Ctrl+Alt+letter is AltGr), so new actions go behind the leader rather
  than on a new chord. `tests/unit/shortcuts.test.ts` fails if an app chord collides with the
  editor keymap, if the welcome note names a key nothing binds, or if it
  leaves out an app shortcut — a new command has to be written into the note.
- **Runes only.** `svelte.config.js` sets `runes: true`; no legacy `$:` reactive statements.
- **A new build must not activate silently, and three pieces enforce that together.**
  `src/sw.js` does *not* call `skipWaiting()` in `install`; navigations are answered from that
  worker's **own precache**, not network-first; and `src/ui/state/update.svelte.ts` is the only
  sender of the `skip-waiting` message, on an explicit user action. Change any one alone and the
  gate silently stops working — most subtly the navigation strategy, because network-first fetches
  the new shell and its new asset URLs miss the cache and load from the network, so the new build
  runs while the new worker is still waiting. The point is not that a backdoored build is
  impossible (the worker comes from the same host) but that swapping one in cannot be invisible.
  `docs/security.md` § "A malicious or coerced host" is the reasoning; `bench:phase6` deploys a
  second build mid-run and is the gate. Note `BUILD_VERSION` must keep hashing `index.html`'s own
  bytes — the shell is not content-hashed, so without that a shell-only change never reaches
  anyone. The same goes for everything in `extraAssets`: `public/` is copied through unhashed, so
  their **bytes** are hashed too. They were not, once, and the consequence was that editing
  `manifest.webmanifest` — which now declares `share_target` — produced a byte-identical `sw.js`
  and reached nobody who already had the app.
- **Two CSP policies, not one.** The HTML meta tag comes from `tools/vite-plugin-csp.mjs`; the
  policy that governs workers (including the Argon2id WASM worker) comes from the `/assets/**`
  headers block in `firebase.json`. Changing one without the other breaks unlock in a way that
  only shows up in a deployed build. `docs/security.md` § "Two policies, not one" explains the
  trap.
- **Sync needs a plan or an invitation.** `approved()` in the rules is `entitled() || invited()`:
  `entitlements/{uid}` written by the billing API from Paddle webhooks, or
  the hand-kept `allowlist/{email}` (now the comp path). Accounts are
  self-serve but **created on hushjot.com only** — the app has no sign-up form, and never loads
  a payment script; plans are bought on hushjot.com, and `src/ui/billingLinks.ts` holds the only
  links there. An account the backend refuses is **signed out**, not left signed in: at sign-in,
  on a restored session and on a refusal mid-session, all through `SyncStore.#enforcePlan` and
  only on an authoritative `denied` — `unknown` is what offline looks like and must change
  nothing. That sign-out is `syncStore.signOut()`, never `signOutNow`: a lapsed plan must not
  lock anyone out of their own vault. Ninety days after a lapse the billing API empties the
  account; `accountWasReset` in `core/sync/backfill.ts` is what
  puts the key record back, and `bench:allowlist` gates all of it. A **vault reset** (a signed-in
  user who lost both secrets starts over, `StartOver.svelte` → the billing API) is the opposite
  case and must be told apart from a purge: it leaves a *tombstone* key document (`resetAt`, no
  `record`) rather than none. A bound device checks `accountResetElsewhere` **before** anything in
  `bindVaultToAccount` can publish, and on a yes writes `app:vaultRetired` and never starts the
  engine for that account — not merely the backfill, because ordinary edits would seal notes into
  the new vault under the old key. The app is fully usable with no account
  at all — local-only is a supported mode, not an error state. The one exception to "nothing is readable without a
  session" is `shares/{id}`, whose read rule consults no `request.auth` at all — that is what a
  link *is*. `list` is denied there as it is for the allowlist, so it cannot be enumerated, and
  publishing still requires an approved account.
- **A refusal is checked for a pause before it is believed.** The cost kill switch
  releases a lockdown ruleset (`bench/lib/lockdown.mjs` has an equivalent), which refuses every
  client with the same `permission-denied` an unapproved account gets — so read naively it tells
  paying users their plan lapsed, offers them a second subscription, lets a new device create a
  second vault and releases the first-run gate. That ruleset allows exactly one thing, a `get` of
  `LOCKDOWN_SENTINEL` (`status/lockdown`, a document that does not exist), which the normal rules'
  catch-all refuses; `tests/rules/` checks both halves. After a `SyncNotApprovedError` the engine
  asks `adapter.probePause()` once: `paused` latches the engine (`status: 'paused'`, `onPaused`,
  **no** `onNotApproved` and **no** `onFirstSync`), `running` is the old not-approved path, and
  `unknown` decides nothing. `SyncStore.paused` drives the "Sync paused" indicator and banner, the
  account panel (no plan label, no "Get sync…"), and the unlock screen's `'paused'` verdict (create
  held shut). `createPauseWatch` (`core/sync/pause.ts`) re-probes every 15 min while visible and on
  focus at most once a minute; when the sentinel is refused again `paused` goes false and
  `App.svelte`'s sync and adopt effects — which read it — start a fresh engine and adopt the vault,
  as a reload would. Never add a status document clients read on start instead: the probe costs
  nothing until something has already been refused. The share viewer (`shareRest.ts`), the
  hushjot.com account page and the CLI make the same probe their own way. `bench:lockdown` is the gate.
- **Storage and crypto identifiers are frozen at the original name.** The product is HushJot;
  the IndexedDB database, every `teksto:` localStorage key, the sync Web Lock and channel, the
  service-worker cache prefix and the HKDF label in `src/core/crypto/kdf.ts` all still say
  `teksto`, and each carries a comment saying so. Renaming one orphans every existing vault,
  loses the crash journal, elects two sync leaders across a deploy, or — for the HKDF label —
  invalidates every recovery code ever issued. `docs/security.md` § "Frozen identifiers" is the
  list. Firebase project ids (`hushjot`, `teksto-dev`) cannot be renamed at all — a move means a
  new project, which is what the migration off the original Firebase project was.
- **Every write is metered, and the meter is the cost bound.** A note, folder, version or link
  write is one commit with a merge into `users/{uid}/usage/current` (`core/sync/usage.ts` is the
  definition, `adapters/firebase/usage.ts` the writer). `bytes` moves by `meterDelta(new, old)` —
  every stored document charged at least 1 KiB, tombstones included — and `pn` counts the commit
  against 20,000 pushes a day, in a window the **server's** clock opens (`ws`). There is no
  "nothing changed, skip the meter" case: the rules refuse any document write whose commit did not
  count a push. A client never decides from its own clock that a day has passed; it always
  increments, and only when a refusal's meter read shows the window full does it send a reset,
  which the rules take or refuse. Refused, the engine holds every change like "storage full"
  (`PushLimitError`, `onPushLimit`). The billing API's recount must use the same `bytes` formula.
- **Dependency policy (§28).** Every dependency must justify bundle size, startup cost, security
  and maintenance. Prefer platform capabilities; the service worker and the search index are
  hand-written for exactly this reason.

## Conventions

Modules open with a block comment explaining *why* the design is what it is — the trade-off
considered, the measurement that settled it, the bug the shape prevents. Match that when adding
or changing a module; a change that invalidates one of those comments must update it.

Env config is `VITE_*` in `.env.local` / `.env.production` (see `.env.example`). The Firebase
values are public by design — authorisation lives entirely in `firestore.rules`. With no API key
and emulators off, the app runs local-only.

Before a major architectural choice, §33 asks: *will this make opening, typing, finding, or
saving a note slower?* If yes, find a better design unless security or data integrity requires it.
