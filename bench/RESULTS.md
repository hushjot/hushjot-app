# Phase 0 — Spike Results

Measured on **Apple M4, 16 GB, macOS**, Chromium via Playwright, production Vite builds.
Raw output: `bench/results.json`, `bench/results-size.json`.
Reproduce with `node bench/run.mjs` and `npm run bench:size`.

**Verdict: GO.** All five budgets pass. Five findings change the design; two were
measurement caveats needing real hardware. One is now closed — Argon2id, measured
on a Google Pixel 9a on 21 Sep 2026, in [Spike 2](#spike-2--argon2id-unlock). The
editor end-of-document tail is still only a throttled proxy.

| # | Spike | Budget | Result | |
|---|---|---|---|---|
| 1 | Editor keystroke p95, 200 KB note | < 16 ms | **3.4 ms** (native) | PASS |
| 2 | Argon2id unlock, m=64 MiB t=3 | < 1.5 s | **94.7 ms** M4, **232.7 ms** Pixel 9a | PASS |
| 3 | 10k notes → interactive list | < 400 ms | **41.2 ms** | PASS |
| 4 | Encrypt + persist p95 | < 20 ms | **0.2 ms** | PASS |
| 5 | Critical-path JS, gzipped | < 160 KB | **107.2 KB** | PASS |

---

## Spike 1 — Editor typing latency

200 KB Markdown note, 6,738 lines, dense fenced code.

| | mount | keystroke p95 (mid-doc) | keystroke p95 (end-of-doc) | p50 | long tasks |
|---|---|---|---|---|---|
| native | 5.8 ms | 3.4 ms | 3.4 ms | 2.3 ms | 0 |
| 4× CPU throttle | 18.4 ms | 4.4 ms | **22.5 ms** | 2.1 ms | 0 |

Markdown correctness (`markdownLean`, see Spike 5):

- All 15 required §10 node types present — headings, bold, italic, strikethrough,
  links, bullet lists, ordered lists, task lists, blockquotes, inline code,
  fenced code, horizontal rules, tables. `requiredNodeTypesMissing: []`.
- 46 highlight ranges assigned by `highlightTree`.
- Fenced code: **0 → 10 highlighted spans in ~101 ms** as the Rust and SQL
  grammars arrive by dynamic import. Lazy loading works end to end.

**Caveat.** The 22.5 ms end-of-doc tail at 4× throttle is a tail only — p50 is
2.1 ms and mid-document p95 is 4.4 ms. It is specific to typing at the very end
of a 6,700-line document with `scrollIntoView`, and produced zero long tasks.
Not a blocker at native speed; re-verify on a real phone in Phase 6.

---

## Spike 2 — Argon2id unlock

`hash-wasm` Argon2id in a Web Worker.

| params | p50 | max |
|---|---|---|
| **m=64 MiB, t=3, p=1** | **94.7 ms** | 95.0 ms |
| m=64 MiB, t=2, p=1 | 64.0 ms | 65.0 ms |
| m=32 MiB, t=3, p=1 | 44.5 ms | 45.0 ms |
| m=19 MiB, t=2, p=1 | 17.1 ms | 17.4 ms |

Cold first unlock, including the lazy wasm fetch and instantiate: **98.8 ms**.

**Why CDP throttling was never the answer here.** Throttling barely moved
these numbers (94.7 ms at both 1x and 4x), because Argon2id is
memory-bandwidth-bound and CDP throttling models CPU scheduling, not memory.
**The 4x column is not a phone proxy**, and that reasoning still holds — it is
why the real-hardware run below exists. The guess made at the time, a mid-range
phone 4-8x slower at 400-800 ms, turned out to be pessimistic by roughly
double: the measured figure is 2.4x and 232.7 ms.

Keep m=64 MiB, t=3. KDF parameters are stored in the key record, so they can be
retuned later without invalidating existing accounts.

### The real-hardware run — 21 September 2026

**Verdict: keep m=64 MiB, t=3, p=1.** Measured on a **Google Pixel 9a** (Tensor
G4, 8 cores, 8 GB, Chrome 153, 1080x2424). Second-pass p50 of **232.7 ms**
against the 1.5 s budget — 6.4x of headroom — and **no allocation failure** on
any candidate. This settles security open item #2; `DEFAULT_ARGON2_PARAMS` does
not change.

| params | M4 p50 | Pixel 9a p50 | p95 | max | ratio |
|---|---|---|---|---|---|
| **m=64 MiB, t=3, p=1** | 96.8 ms | **232.7 ms** | 264.4 ms | 264.4 ms | 2.4x |
| m=64 MiB, t=2, p=1 | 64.7 ms | 160.4 ms | 188.6 ms | 188.6 ms | 2.5x |
| m=32 MiB, t=3, p=1 | 46.3 ms | 110.3 ms | 136.3 ms | 136.3 ms | 2.4x |
| m=19 MiB, t=2, p=1 | 17.1 ms | 45.4 ms | 69.5 ms | 69.5 ms | 2.7x |

Three things the grid alone does not show:

- **Cold first unlock: 456 ms**, against 117.7 ms for the same harness on the
  M4 — a 3.9x ratio where the warm figures are 2.4x. Worker startup and the
  lazy wasm fetch dominate on mobile, and this is the number a new user
  actually feels on a first unlock. It is still under a third of the budget.
- **Thermal drift is real and small.** First pass 208.4 ms, second 232.7 ms
  after 184 derivations across a 45-second soak: 11.7 per cent. The soak earned
  its place in the harness; the effect is nowhere near budget-threatening.
- **The trim order never had to fire.** The budget was met at the first rung,
  so the corrected rule in `docs/security.md` — iterations before memory — was
  not needed. It stays written down for the next device.

**How far this generalises.** One device, and the upper half of "mid-range":
the Pixel 9a has a Tensor G4 and 8 GB of LPDDR5X. A 4 GB phone on a low-tier
Snapdragon with LPDDR4X could plausibly be 2-3x slower again — which still
lands near 700 ms, inside the budget. The timing conclusion therefore rests on
the measurement *plus* the headroom, not on the measurement alone.

The allocation question generalises less well. 64 MiB in a worker is
comfortable on 8 GB; the refusal this harness was built to catch is most likely
on a 4 GB device under memory pressure, and that case is still untested. "No
failure on the 9a" is not "no failure anywhere".

**The JSON cannot name the handset.** Chrome sends a reduced user-agent
(`Android 10; K`, whatever the device) and `navigator.deviceMemory` is
secure-context-gated, so it is `null` over the page's plain-http LAN origin —
the same reason the page posts to the KDF worker directly. The model above was
recorded by hand, and has to be.

For reference, the harness driven headlessly on the M4 reproduces the Spike 2
table to within ~2 ms, which is the evidence that it measures the same thing.

<details>
<summary>Raw JSON from the device</summary>

```json
{
  "note": "Real-device Argon2id measurement. The \"second\" pass is the one to quote.",
  "environment": {
    "userAgent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
    "deviceMemoryGiB": null,
    "hardwareConcurrency": 8,
    "screen": "376x844@2.875",
    "measuredAt": "2026-09-21T10:33:46.497Z"
  },
  "coldFirstUnlockMs": 456,
  "soak": {
    "seconds": 45,
    "derivations": 184
  },
  "runsPerCandidate": 7,
  "first": [
    {
      "label": "m=64MiB,t=3,p=1",
      "memoryKiB": 65536,
      "iterations": 3,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 202.6,
        "p50": 208.4,
        "p95": 224.3,
        "p99": 224.3,
        "max": 224.3,
        "mean": 210.6
      }
    },
    {
      "label": "m=64MiB,t=2,p=1",
      "memoryKiB": 65536,
      "iterations": 2,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 146.9,
        "p50": 148.9,
        "p95": 218.2,
        "p99": 218.2,
        "max": 218.2,
        "mean": 162.6
      }
    },
    {
      "label": "m=32MiB,t=3,p=1",
      "memoryKiB": 32768,
      "iterations": 3,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 98.8,
        "p50": 100.9,
        "p95": 134,
        "p99": 134,
        "max": 134,
        "mean": 109.3
      }
    },
    {
      "label": "m=19MiB,t=2,p=1",
      "memoryKiB": 19456,
      "iterations": 2,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 40.4,
        "p50": 42,
        "p95": 70.9,
        "p99": 70.9,
        "max": 70.9,
        "mean": 46.6
      }
    }
  ],
  "second": [
    {
      "label": "m=64MiB,t=3,p=1",
      "memoryKiB": 65536,
      "iterations": 3,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 223.2,
        "p50": 232.7,
        "p95": 264.4,
        "p99": 264.4,
        "max": 264.4,
        "mean": 237.3
      }
    },
    {
      "label": "m=64MiB,t=2,p=1",
      "memoryKiB": 65536,
      "iterations": 2,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 157.5,
        "p50": 160.4,
        "p95": 188.6,
        "p99": 188.6,
        "max": 188.6,
        "mean": 169.4
      }
    },
    {
      "label": "m=32MiB,t=3,p=1",
      "memoryKiB": 32768,
      "iterations": 3,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 105.5,
        "p50": 110.3,
        "p95": 136.3,
        "p99": 136.3,
        "max": 136.3,
        "mean": 116.2
      }
    },
    {
      "label": "m=19MiB,t=2,p=1",
      "memoryKiB": 19456,
      "iterations": 2,
      "parallelism": 1,
      "verdict": "ok",
      "summary": {
        "n": 7,
        "min": 43.4,
        "p50": 45.4,
        "p95": 69.5,
        "p99": 69.5,
        "max": 69.5,
        "mean": 48.5
      }
    }
  ]
}
```

</details>

---

## Spike 3 — 10,000-note cold start

10,000 synthetic notes, 30.7 MB plaintext, 40,016 unique search tokens.

| layout | IDB read | decrypt | parse+sort+render | **total** |
|---|---|---|---|---|
| **A** — single ciphertext (spec §14 shape) | 93.0 ms | 45.5 ms | 44.9 ms | **183.4 ms** |
| **B** — split ciphertexts, one store | 79.9 ms | 18.7 ms | 3.6 ms | **102.2 ms** |
| **C** — separate meta store *(chosen)* | 20.6 ms | 17.2 ms | 3.4 ms | **41.2 ms** |

Layout C is **4.5× faster** than the shape the spec implies.

The instructive detail: the dominant cost is the **IndexedDB read (93.0 → 20.6 ms)**,
not decryption. Splitting the ciphertexts alone (B) saves 81 ms; putting the
bodies in a *separate object store* saves another 61 ms, because the cold-start
read then never deserializes 30 MB of body bytes it is not going to use.

Other measurements:

- Note open (read body + decrypt): **p50 0.1 ms, p95 0.3 ms**.
- Virtualized list renders **18 DOM nodes** for 10,000 notes.
- Ciphertext overhead: 30.67 MB plaintext → 30.83 MB body ciphertext (+0.5%),
  0.88 MB total for all 10,000 encrypted meta records.
- Background index sweep: read 54.1 ms + decrypt 36.0 ms + build 353.3 ms =
  **443 ms**. This does not block the list, but it is the one genuinely
  expensive operation and belongs in a worker.
- Search prefix scan over 40,016 tokens: **p50 0.3 ms, p95 0.6 ms**.
- Heap with all 10,000 plaintext bodies retained: **410 MB**.

---

## Spike 4 — Encrypt and persist

AES-256-GCM via WebCrypto, envelope format from `bench/lib/crypto.ts`.

Encryption only, by note size:

| size | p50 | p95 | max |
|---|---|---|---|
| 1 KB | 0.0 ms | 0.1 ms | 0.1 ms |
| 10 KB | 0.0 ms | 0.1 ms | 0.1 ms |
| 100 KB | 0.1 ms | 0.2 ms | 0.2 ms |
| 500 KB | 0.4 ms | 0.5 ms | 0.5 ms |

| | p50 | p95 | max |
|---|---|---|---|
| Full save cycle (encrypt + IDB write) | 0.1 ms | 0.2 ms | 0.5 ms |
| Worker round trip (encrypt off-thread) | 0.0 ms | 0.1 ms | 0.2 ms |

Teardown flush, 5 dirty notes: **0.3 ms total**. Round-trip integrity: **5/5
verified, 0 mismatched**.

---

## Spike 5 — Critical-path bundle

| variant | eager gzip | eager brotli | lazy gzip | lazy chunks | budget |
|---|---|---|---|---|---|
| `@codemirror/lang-markdown` | 174.7 KB | 149.0 KB | 211.7 KB | 16 | **FAIL** |
| `markdownLean` *(chosen)* | **107.2 KB** | **93.2 KB** | 278.7 KB | 21 | **PASS** |

`@codemirror/lang-markdown` statically imports `@codemirror/lang-html`, which
statically imports `@codemirror/lang-css` and `@codemirror/lang-javascript`.
Using it forces three full grammars into the startup bundle regardless of how
carefully everything else is lazy-loaded, which defeats §28 outright.

`src/editor/markdownLean.ts` builds the same language support directly on
`@lezer/markdown` (whose only dependencies are `@lezer/common` and
`@lezer/highlight`), keeping every code grammar behind a dynamic import.
It saves **67.5 KB gzipped** and, because it enables GFM by default where
`markdown()` defaults to CommonMark, it covers *more* of §10 — 46 highlight
ranges against 40, including strikethrough, tables and task lists.

Leaves ~53 KB of gzipped headroom for the Svelte shell inside the 160 KB budget.

---

## Design changes forced by the data

1. **Separate object stores, not just separate ciphertexts.** The plan proposed
   splitting `metaCipher` from `bodyCipher`. The data shows the IndexedDB read
   dominates, so they must also live in *separate object stores*
   (`noteMeta` / `noteBody`). 102.2 ms → 41.2 ms.

2. **Drop the encryption worker from the MVP.** Encrypting a 500 KB note takes
   0.5 ms on the main thread, and the worker round trip (0.1 ms) is
   indistinguishable from doing it inline (0.2 ms). The worker adds a key-transfer
   path, an init handshake and a message protocol to save nothing measurable.
   Encrypt on the main thread; keep the debounce for write batching, not for
   latency. This also removes the awkward "worker normally, main thread on
   pagehide" special case in the §7/§13 resolution — it is main thread
   throughout, and the numbers justify it. (§33.15: prefer the simplest solution.)

3. **Keep a worker for the search index.** The index sweep is 443 ms, the only
   operation big enough to matter. That is where the worker earns its place.

4. **Do not retain plaintext bodies after indexing.** 410 MB heap with 10,000
   bodies held. Index, then drop; keep only the open note's plaintext in memory.
   This also shrinks the window in which plaintext is resident (§13).

5. **`markdownLean` replaces `@codemirror/lang-markdown`** — already written and
   verified, 67.5 KB saved with broader syntax coverage.

## Open items to re-measure later

- ~~**Argon2id on real mobile hardware**~~ — **done, 21 Sep 2026.** 232.7 ms
  p50 on a Google Pixel 9a, no allocation failure; parameters unchanged. What
  is *not* closed is the low end: a 4 GB device on a low-tier SoC is untested,
  and that is where a 64 MiB allocation would be refused if it ever is. Re-run
  `npm run bench:kdfDevice` on one when there is one to hand; it needs a
  physical device and a person holding it, so it is not part of `npm run
  verify` and cannot gate.
- **Editor end-of-document tail** on a real phone (Phase 6).
- **Search scan at higher cardinality.** The prefix scan walks every token
  (0.6 ms at 40k). At ~500k tokens that becomes ~7 ms, which is still usable but
  would justify a sorted token array with binary search. Revisit in Phase 2.

---

# Cross-device sync latency

Added after a two-device report of edits taking about ten seconds to cross.
Measured by `bench/phase5.mjs` through the real UI on two browser contexts
against the Firestore emulator, so the figures include the write debounce, the
push, the listener and the pull. Reproduce with `npm run bench:phase5`.

§7 and §27 both asked for synchronisation to be instrumented and it never was.
That is how this survived: the engine's idle debounce is restarted by every
queued change, changes are queued on every write-scheduler drain, and so during
ordinary typing the debounce never expired and the 10 s ceiling was the only
timer that ever fired. Nothing measured it, so the ceiling silently *was* the
cadence rather than a fallback.

| Case | Budget | Before | After | |
|---|---|---|---|---|
| Edit made mid-sentence → visible on other device | < 6 s | **9535 ms** | **2495 ms** | PASS |
| New note → visible on other device | < 3 s | 1089 ms | **241 ms** | PASS |

The fix is three changes in `src/core/sync/engine.ts`: the ceiling drops from
10 s to 3 s, structural changes (create, delete, move, folder edits) sync on a
100 ms coalescing nudge instead of the typing debounce, and a cycle that ends
with an empty queue arms a 60 s backstop so a dropped listener heals itself.

**How the typing case is measured matters more than how fast the typing is.** A
word, a pause of a few hundred milliseconds, the next word — that is what keeps
the write debounce draining faster than the sync debounce can expire. Typing
continuously with no pauses does *not* reproduce it: the write debounce then
only drains on its own 2 s ceiling, which is slower than the idle timer and lets
it fire. An earlier version of this benchmark typed that way and reported
2937 ms against the unfixed engine — a measurement that agreed with the code
comments and disagreed with the user.

Budgets are deliberately loose. This runs against a real emulator over a real
socket; the job is to catch a regression to the old order of magnitude, not to
police a few hundred milliseconds.

# Firestore operations per session

Added to replace the cost *estimate* in `private/viability-assessment.md` §7 with
measurements. `src/adapters/firebase/opCount.ts` counts billed operations at the
adapter seam in emulator builds (empty queries bill one read; listeners bill per
changed document; every request under `/users` bills one more read for the
allowlist lookup in `firestore.rules`) and forwards them to the benches.
`bench:phase4` and `bench:phase5` print a Firestore-ops row per scenario;
phase5's "operations per session" scenario is the table below and writes
`bench/results-ops.json`. Reproduce with `npm run bench:phase5`.

One signed-in device, 17 Sep 2026. "Billed reads" includes the rules lookups.

| Activity | Billed reads | Writes | Gate |
|---|---|---|---|
| Sign in and first sync (key record, allowlist, listeners, backfill) | 33 | 3 | — |
| One minute of typing (word, 300 ms pause, word…) | 170 | 17 | ≤ 26 writes |
| Create three notes | 87 | 9 | — |
| Idle, visible, 125 s | 8 | 0 | 1–3 backstop cycles |
| Hide the tab (flushes the open note) | 10 | 1 | — |
| Idle, hidden, 125 s | **0** | 0 | ≤ 1 cycle |
| Come back to the tab | 4 | 0 | ≥ 1 cycle |

**Where the reads go.** An idle backstop cycle is two empty queries plus two
rules lookups: 4 reads. A push is not 1 write — it is 1 write, its rules lookup,
the cycle's own pull (4), the listener hearing the device's own acknowledged
write (1), and the full second cycle that echo triggers (4): **10 billed reads
per write**, which is why a typing minute is 170 reads for 17 writes. That echo
cycle is 40% of a typing session's reads and is the next lever; the hidden-tab
backstop could not reach it.

**The hidden-tab backstop.** 60 s visible, 15 min hidden
(`HIDDEN_BACKSTOP_MS`, `src/core/sync/engine.ts`). Modelled over a day from the
table — 30 min typing, 1 h visible idle, 20 tab switches, 2 cold starts:

| Tab open | Reads before | Reads after | Cut |
|---|---|---|---|
| 8 h | 7,246 | 5,790 | 20% |
| 24 h (never closed) | 11,086 | 6,046 | 45% |

Writes are unchanged at ~536 a day.

# Markdown preview

`bench/preview.mjs`, headless Chromium, production build, a ~50 KB note using
every construct the preview renders. Reproduce with `npm run bench:preview`.

| Case | Budget | Measured |
|---|---|---|
| Keystroke p95, typing at the top of the note beside a live split preview | 16 ms | 0.3 ms |
| Long tasks (> 50 ms) while typing | 0 | 0 |
| Typing stops → edit visible in the preview | 1500 ms | ~80 ms |
| Open split on the 50 KB note (chunk fetch + first render) | 500 ms | ~90 ms |

Critical path is unchanged at 51.1 KB gzip. The preview's JavaScript is a lazy
chunk that shares `@lezer/markdown` with the editor. Its 0.9 KB of CSS counts
as eager under `bench/size.mjs`'s rule that every stylesheet does.

Catch-up comes in under the 150 ms debounce because 120 keystrokes take longer
than the 1 s ceiling, so renders also land during typing. They do so in idle
callbacks, and the long-task count shows none of them cost a frame.

# Pinned notes and tags

`bench/scale.mjs`, headless Chromium, production build. The seeder pins every
twentieth note (at most 50) and gives three notes in ten one to three `#tags`
from a pool of 200, so the pin ordering and the tag index run under load.
Reproduce with `npm run bench:scale`.

| Case, 10,000 notes | Budget | Measured |
|---|---|---|
| Reload to first list row | 1500 ms | 213 ms |
| Reload to the Tags section (index has read every body) | 3000 ms | 907 ms |
| Click a tag → filtered list rendered, p95 | 50 ms | 26.8 ms |
| `#tag word` in the finder, p95 | 50 ms | 15.3 ms |
| `in:Work word` in the finder, p95 | 50 ms | 21.9 ms |
| `"exact phrase"` in the finder, p95 | 200 ms | 18.4 ms |
| Keystroke p95 | 16 ms | 0.5 ms |
| `[[` completion, keystroke to ranked list | 1000 ms | 211 ms |

The first three p95s are one frame, and that is all they measure: they set the
input and stop at the next `requestAnimationFrame`, so what they really gate is
that the main thread stayed responsive. That is the right thing to measure for
a query the worker answers from memory — and the wrong thing for a phrase,
whose work is a series of IndexedDB reads and decryptions off the main thread.
A phrase sample shaped like the others would have passed unconditionally and
gated nothing, so **the phrase case waits for the result list to actually
change** before stopping the clock, and fails the run if it never does.

`in:` costs nothing measurable because it is a filter over a map the query
already walks. The phrase number is the interesting one: verifying adjacency
means re-reading candidate bodies (`core/search/phrase.ts`, and
`docs/security.md` for why the index holds no positions to do it from), which
would be ~3 s across this collection if it read all of them. It is 18.4 ms
because it stops at the caller's limit and never opens more than `VERIFY_MAX`
(200) bodies. The 200 ms budget is far above the measurement on purpose: it is
there to catch either bound being lost, which would be seconds, not to police
frame-level noise on a slower machine.

The seeder plants two literal phrases in disjoint sets of notes, and — for this
bench only, via `{ folders: true }` — files the notes across a small nested
tree. Both are needed for the two cases above to mean anything: `in:` has
nothing to scope to in a flat collection, and a phrase bench where every
candidate matches exits on its first read. Every note holds all four phrase
words, so neither query can be answered by the index alone. Both cases assert a
non-empty result list as well as a latency, because a timing over nothing is
not a measurement — and the folder fixture is exactly the kind that can fail to
land while every number still looks fine.

The folders are opt-in rather than always on because a populated sidebar is
taller, which moves the note list down the viewport; `bench:rowMenu` asserts
against where the first row lands and fails when it shifts.

The first row after reload is asserted to be pinned. Critical path
after both features: 74.4 KB gzip (`bench:size`); the tag extractor rides in the
worker and preview chunks and the editor highlighter in the editor chunk.

Tags cost the index build almost nothing because `extractTags` returns on one
`indexOf('#')` for a body with no hash, and the page hears about tags only when
the set or a count changes — nearly every edit changes neither.



# Share a note by link

`bench/size.mjs` and `bench/share.mjs`. Reproduce with `npm run bench:size` and
`npm run bench:share` (the latter wraps itself in `firebase emulators:exec`).

## The budget is now per document

There are two HTML entries — the app, and the share viewer at `/s/` — and the
old gate summed every entry into one number. Nobody downloads both, so that sum
would have looked like a critical-path figure while measuring nothing, and the
viewer's Markdown renderer would have eaten the app's headroom in silence.

| Document | Budget | Measured (gzip) | Headroom |
|---|---|---|---|
| `index.html` (the app) | 160 KB | 90.9 KB | 69.1 KB |
| `s/index.html` (the viewer) | 56 KB | 49.1 KB | 6.9 KB |

The viewer's 49 KB is the Svelte runtime (15.5), `@lezer/common` and
`@lezer/markdown` (22.9), the preview model (4.9), the page itself (3.3) and
1.7 of CSS. There is no cheaper way to render Markdown here that does not mean
a second renderer, and the second renderer is the one that would not have the
no-`innerHTML` guarantee.

**The gate earned its keep on the first run.** The viewer came in at 136.9 KB —
47 over — because `src/editor/preview/render.ts` statically imported
`LanguageDescription` from `@codemirror/language`, which drags in
`@codemirror/view` and `@codemirror/state`: the whole editor runtime, 111 KB
gzipped, on a page that shows one read-only note. Moving the highlighting to
`src/editor/preview/highlight.ts` behind a dynamic import cost nothing in
behaviour, because that path was already asynchronous — a fence renders as
plain text and is upgraded when its grammar arrives — and took the viewer to
48.3 KB.

## Correctness, in two browsers

`bench/share.mjs` is a gate on behaviour rather than a budget, like
`bench:vault`: the claim is about two pages, two storage states and a URL
fragment, and none of it means anything outside a real browser.

| Check | Result |
|---|---|
| A context with no vault, no notes and no account opens the link and reads the note | pass |
| The key appears in no URL anything fetched | pass |
| The share id appears in nothing but the one Firestore document | 1 request |
| The viewer holds no `teksto` database, no `teksto:` key, no unlock form, no `#app` | pass |
| A link stripped of its fragment says so and asks the backend for nothing | pass |
| "Save to my notes" carries the link, not the plaintext | pass |
| Revoking takes effect immediately, not at expiry | pass |

`bench/phase6.mjs` adds the half only an installed service worker can show: a
navigation to `/s/` is answered with the viewer's shell and not the app's. Its
precache cap moved from 32 to 48 entries, which is the viewer's shell and
chunks plus the share dialog — every first-level dynamic import is precached on
purpose, and the viewer's shell *must* be, because the worker's navigation
branch reads it from there.

It moved again, from 48 to 56, on 12 October 2026, when the build reached 50:
the dialogs added since — vault secrets, start over, remove data, quick
capture — are each a first-level dynamic import and so each precached. No chunk
outside that rule had crept in.

## Drag and drop

`bench/dragDrop.mjs`, like `bench:vault`, `bench:rowMenu` and `bench:share`, is
a gate on behaviour rather than a budget: whether a drag starts, whether the
target sees it, and whether it cleans up after itself are all platform
questions with no meaning outside a real browser.

It is in two halves, and the reason is a limitation worth writing down.
**Playwright replays a native drag through CDP and delivers `dragstart` and
`drop` but not the stream of `dragover` in between**, so it can prove a drag
completes and can observe nothing while one is in flight. Every mid-flight
check therefore dispatches real `DragEvent`s over one shared `DataTransfer`,
which is what a browser does and what the handlers actually read; one native
drag is kept for the end-to-end case, because only it proves the row is
draggable at all.

The list is seeded to 150 notes, past `VIRTUALIZE_ABOVE`, so the drag source is
the destroyed-on-scroll kind.

| Check | Result |
|---|---|
| `dragstart` carries both hushjot formats and no `text/plain` | pass |
| A folder row accepts a note drag and lights up | pass |
| The list gains no DOM rows during a drag (20 at 10,000 notes; budget 60) | pass |
| A note dropped where it already is is declined, not refused | pass |
| The move is announced in the live region, with an Undo that reverses it | pass |
| A folder dropped inside its own subtree is refused and the tree is unchanged | pass |
| A folder dropped elsewhere is re-parented | pass |
| A collapsed folder springs open under a held drag | pass |
| An abandoned drag leaves no row highlighted | pass |
| A drop still lands after the source row is destroyed by scrolling | pass |
| A file dragged **over a folder row** still reaches the import dialog | pass |
| A real pointer drag moves a note into a folder | pass |

The last two are the ones worth keeping. The file check is the only coverage
anywhere of the seam that lets note drag and file import share a window: they
coexist only because their `dataTransfer` formats do not overlap. The
destroyed-source check is what notices if teardown ever moves off the window
and back onto the row.


# The last of the first-hour edges (§4.1 item 7)

`npm run bench:size`, `npm run bench:app`. Measured 25 Sep 2026 on the same
Apple M4, against the parent commit built from a clean `git archive` of `HEAD`
with `.env.production` copied in — without that the baseline builds local-only,
never dynamically imports the Firebase SDK, and reports 238 KB transferred
against the real build's 345 KB. That is a trap for anyone comparing two
checkouts here, and it is why the figures below are stated as a delta.

Five changes in one pass: bracket and quote auto-close, a three-way editor
font, an Appearance menu, the theme toggle's state made legible, and a
durable-storage action for Firefox.

| | parent | after | delta | budget |
|---|---|---|---|---|
| `index.html` eager gzip | 98.9 KB | 100.2 KB | **+1.3 KB** | 160 KB |
| `s/index.html` eager gzip | 49.3 KB | 49.5 KB | **+0.2 KB** | 56 KB |
| Transferred on cold load | 345 KB | 347 KB | +2 KB | — |
| Keystroke p95 | 0.5 / 0.6 ms | 0.4 ms | below noise | 16 ms |

**The viewer number is the one worth watching**, and +0.2 KB is the whole point
of it: the font choice publishes two custom properties, and both shells declare
the tokens while only the app ships the store. Had `editorFont.svelte.ts`
reached `src/viewer/`, this row would have carried a rune store and a
`localStorage` read onto the page a stranger opens, for a preference that
reader never set. The 0.2 KB is `markdown.css` gaining a nested `var()`
fallback inside its `font:` shorthand.

**Keystroke p95 is the §7 question**, because `closeBrackets()` is now
unconditional and installs a `StateField` on the typing path — a `RangeSet` of
the positions it closed itself, mapped through every transaction and narrowed
to the cursor's line. The parent measured 0.5 ms and 0.6 ms on two runs and the
change measured 0.4 ms, so the field costs less than the run-to-run spread.
`bench:preview` separately reports 0.2 ms p95 and zero long tasks typing beside
a live preview.

It is unconditional because it is free to be. `closeBrackets` takes no options
and reads its bracket set from the language data at the cursor, so the choice
of brackets is one key on `markdownLean`'s facet and a per-device switch would
have bought nothing but a Compartment — which reaches the mounted `EditorState`
and not the other twenty-three `Editor.svelte` caches.

`bench:mobile`, `bench:rowMenu`, `bench:preview` and `bench:phase6` were re-run
and pass unchanged; phase6 matters here because both shells' token blocks moved
and it is the gate on CSP, SRI and the service-worker update path.

---

# Note links (§10 Tier A item 6)

Apple M4, 27 September 2026, production builds. `[[Title]]` and `[[Title|label]]`
in the editor and the preview, with a completion over note titles, a ⌘-click and
the `follow-link` command.

| | before | after | delta | budget |
|---|---|---|---|---|
| `index.html` eager gzip | 100.2 KB | 100.4 KB | **+0.2 KB** | 160 KB |
| `s/index.html` eager gzip | 49.5 KB | 50.0 KB | **+0.5 KB** | 56 KB |
| Keystroke p95, `bench:app` | 0.4 ms | 0.5 ms | below noise | 16 ms |
| Keystroke p95 beside a live preview | 0.2 ms | 0.2 ms | none | 16 ms |
| Long tasks while typing beside a preview | 0 | 0 | none | 0 |

**The viewer row is the one that was in danger, and +0.5 KB is the whole report.**
The completion and the ⌘-click reach `@codemirror/language` and
`@codemirror/view`; the share viewer reaches `preview/model.ts`, which needs the
same *syntax*. Putting them in one module would have put the editor runtime on
the page a stranger opens — the 136.9 KB failure recorded under "Share a note by
link" above, for the second time and by a different route. So the grammar is its
own module importing only `@lezer/*`, and the 0.5 KB is that inline parser plus
the preview's `noteLink` case plus three CSS rules. The split is visible in the
size table: the viewer's `@lezer/*` chunk is now entered through
`noteLinkSyntax`, and it grew from 22.9 KB to 23.2 KB.

## The `[[` completion at scale

New case in `bench:scale`, because this is the one keystroke whose cost scales
with the collection: `wikiLinkCompletion` filters and ranks **every** title in
the vault each time the popup re-ranks.

| Notes | Keystroke → ranked list painted | Budget |
|---|---|---|
| 100 | 141 ms | 1000 ms |
| 1,000 | 206 ms | 1000 ms |
| 10,000 | 211 ms | 1000 ms |

Flat from 1,000 to 10,000, and the reason is that the number is almost entirely
frame waits: it types fifteen characters into an open popup, yielding to
`requestAnimationFrame` between each, so ~240 ms is the floor at 60 Hz and the
ranking itself is below the spread. A cheap `startsWith`/`includes` test before
any scoring is what buys that, and the budget is deliberately far above the
measurement rather than close to it — the regression worth catching is that
pre-filter being replaced by something that scores 10,000 titles properly, which
would be seconds, not milliseconds. The case also fails the run if the popup
offered nothing, since otherwise the budget would be timing a list that never
appeared.

**It is measured as "keystroke to painted list", not as keystroke latency**, and
that distinction is the same one the phrase case makes. CodeMirror debounces the
completion off the keystroke, so a sample that timed `insertText` would record
main-thread responsiveness, pass unconditionally and gate nothing.

## Two correctness gates rather than budgets

`bench:share` gains **the viewer's note links are inert** beside the existing
checkbox check. The model renders every link `disabled` and only the renderer
enables it, and only where the page passed a resolver — so the assertion is that
a viewer's links are `disabled` *and* still carry their target. That is the gate
on the security claim in `docs/security.md`, not a nicety: a page with no vault
must not offer navigation into one.

`bench:preview` gains the mirror of it — the app **does** pass a resolver, so its
270 rendered links must all be enabled and carry a target — and its fixture now
holds a plain link, an aliased one and one that resolves to nothing.

## A latent bug in `bench:preview`, found by the fixture change

Worth recording because the bench had been passing by luck. It types 120
characters at the top of a 50 KB note and checks that they landed, and it read
the "before" length straight after `collapseToStart()`. CodeMirror reads a DOM
selection change from its observer rather than synchronously, so at that moment
the caret was still at the end of the note and the viewport had not scrolled:
`content.querySelector('.cm-line')` returned whichever line was still rendered.
The old fixture happened to leave a line there whose length made the check's
floor of 100 pass; adding two lines per section moved which line that was, and it
reported 53 of 120.

Fixed in the measurement, not the fixture: two `requestAnimationFrame`s after
`collapseToStart()` so the view scrolls to the caret, and the check is now
**exact** — 120 of 120 — because the floor is what let it drift unnoticed.

## Focus mode, as a correctness gate on `bench:app`

27 September 2026. Focus mode hides the topbar, the sidebar and the status bar,
which means every way it can break looks identical from the outside: nothing
happens. So it is gated rather than measured, and on `bench:app` rather than in
a new file — that bench already drives the desktop shell and already measures
keystroke p95 on the same page, which is the number anyone would ask about a
change to the editor's surroundings.

It presses the leader chord and `y`, choosing ⌘ or Ctrl from `navigator.userAgent`
the way `shortcuts.ts` does, then leaves by **clicking the floating control**
rather than by the chord, so the one route a mouse has out of a chrome-free
screen is the one under test.

Measured on the run that introduced it:

| | topbar | status | sidebar | exit control | editor height |
|---|---|---|---|---|---|
| before | yes | yes | yes | no | 612 px |
| in focus mode | no | no | no | yes | 682 px |
| after leaving | yes | yes | yes | no | 612 px |

The 70 px is the 44 px header plus the 26 px status bar, which is the assertion
that the space the chrome gave up actually reached the editor rather than
becoming padding.

The first row is itself a check: it asserts the chrome was there *before* the
test began, so the gate cannot pass by looking at an app that never rendered.
That is the same guard `bench/phase3.mjs` puts on the ciphertext audit, and it
is the one that matters here — every other assertion in this block is a
`false`, and a page that failed to load would satisfy all of them.

One thing it deliberately does not assert: that the status bar reappears for
`Offline` and `Not synced`. That rule is the reason focus mode is safe to ship
(`ui/focusMode.ts` has the argument), but forcing those states in a browser
bench means faking the sync engine, so it is pinned in
`tests/unit/focusMode.test.ts` instead, where the rule is a pure function.

---

# Reading preferences in the share viewer

Apple M4, 9 October 2026, production builds. The share viewer gains the app's
light/dark toggle, text size (− / value / +) and font choice, by importing
`ui/state/theme`, `textSize` and `editorFont` unchanged.

| | before | after | delta | budget |
|---|---|---|---|---|
| `s/index.html` eager gzip | 50.1 KB | 54.1 KB | **+4.0 KB** | 56 KB |

**The stores are not where the bytes went.** Measured one piece at a time:
importing the three stores costs 1.1 KB; the theme button and the size pill
cost 2.6 KB; the font picker costs the rest. Most of it is Svelte runtime that
these controls are the first thing in the viewer to need. The runtime lands in
the chunk the viewer shares with the app, so the app pays nothing extra.

The first version used a popover menu like the app's Appearance menu, which
needed outside-click and Escape handling. It came to 55.8 KB, 0.2 KB under
budget. A native `<select>` did the same job for about a quarter of the bytes,
and on a phone it opens the platform's own picker. Binding the select by
`value` or by per-option `selected` measured the same.

1.9 KB of headroom is left. The next addition to the viewer should be measured
against that number before it is designed, not after.

`bench:share` adds four checks: the toggle sets `data-theme`, + grows
`.markdown`'s computed size, the picker sets `--preview-font`, and afterwards the
only `teksto:` keys are the three preference keys. The existing check that the
viewer stores nothing still runs before the reader touches anything, and still
passes.
