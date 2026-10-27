# Agentic AI Build Specification: High-Performance Encrypted Cloud Notepad

## 1. Mission

Build an **extremely fast, minimal, encrypted, local-first cloud
notepad** for browsers and phones.

The product should feel closer to **Notepad++ / a lightweight code
editor in the cloud** than to Notion, OneNote, or a complex productivity
suite.

The core promise is:

> **Open instantly. Type instantly. Never press Save. Find anything
> instantly. Access it anywhere.**

Performance is the highest-priority user-facing requirement. Security
and encryption are non-negotiable. Markdown syntax highlighting is
mandatory.

The application should be deliberately simple and should resist feature
creep.

------------------------------------------------------------------------

## 2. Product Principles

Prioritize these requirements in this order:

1.  **Perceived performance**
2.  **Data safety and reliability**
3.  **Client-side/end-to-end encryption**
4.  **Excellent text and Markdown editing**
5.  **Offline/local-first behavior**
6.  **Fast search and navigation**
7.  **Cross-device synchronization**
8.  **Simple UX**
9.  Maintainability
10. Additional features

Never sacrifice editor responsiveness to perform network operations.

The network must **never be in the critical path of typing**.

------------------------------------------------------------------------

## 3. Target Users

Primary users:

-   Software developers
-   Technical users
-   People who collect snippets, commands, SQL, JSON, URLs, ideas,
    notes, and Markdown
-   People who want a simple private cloud notepad
-   Users moving frequently between desktop computers, laptops,
    browsers, and phones

The product should also remain simple enough for a non-technical user
who merely wants to write:

``` markdown
# Holiday ideas

## Portugal

- Visit Évora
- Go to the beach
- Book restaurant
```

------------------------------------------------------------------------

## 4. Core User Experience

The basic workflow must be:

``` text
Open application
      ↓
Authenticate if necessary
      ↓
Recent/local notes appear immediately
      ↓
Select or create note
      ↓
Type
      ↓
Local save immediately
      ↓
Background encryption + cloud synchronization
```

There should be **no manual Save button** in the normal workflow.

Display a subtle status indicator:

``` text
Saved ✓
Saving…
Offline
Syncing…
```

The status indicator must never interrupt typing.

------------------------------------------------------------------------

## 5. Technology Direction

Use:

-   **Firebase Authentication**
-   **Cloud Firestore**
-   **Firebase Hosting** or another static/CDN hosting option if
    objectively faster
-   **IndexedDB** for local persistence
-   PWA capabilities for mobile/home-screen use
-   Client-side encryption using established, audited cryptographic
    primitives/libraries
-   A high-performance Markdown/code editor suitable for browser and
    mobile use

The application architecture should be designed so Firebase can later be
replaced by a generic synchronization API without rewriting the editor
or local persistence layers.

Do **not** tightly couple UI components directly to Firestore.

Use abstraction boundaries such as:

``` text
UI / Editor
    ↓
Note Service
    ↓
Local Repository
    ↓
Encryption Service
    ↓
Sync Service
    ↓
Firebase Adapter
```

------------------------------------------------------------------------

## 6. Local-First Architecture

The local database is the primary source for interactive UI operations.

Firestore is the synchronization backend.

### Critical rule

Opening an existing locally cached note should **not require a Firestore
round trip**.

Expected behavior:

``` text
User clicks note
      ↓
Read local decrypted/cached state
      ↓
Render immediately
      ↓
Check/synchronize remote revision asynchronously
```

The application must remain usable when Firebase is temporarily
unreachable.

------------------------------------------------------------------------

## 7. Performance Requirements

Performance is a product feature, not merely an implementation detail.

### Editor

Typing latency must be effectively imperceptible.

A keystroke must:

1.  Update editor state immediately.
2.  Update the local persistence queue.
3.  Schedule background synchronization.

A keystroke must **never wait for**:

-   Firebase
-   encryption of the complete note
-   network requests
-   search indexing
-   analytics
-   remote synchronization

### Startup

Optimize aggressively for:

-   minimal JavaScript/WASM bundle size
-   lazy loading
-   CDN caching
-   application shell caching
-   IndexedDB reads
-   minimal blocking initialization
-   avoiding unnecessary Firebase SDK initialization before useful UI
    can render

Target:

-   Application shell visible almost immediately on repeat visits.
-   Cached note list displayed without waiting for network.
-   Recently opened note available immediately from local storage.
-   Editor interactive as early as possible.

### Performance instrumentation

Measure at minimum:

-   app startup to first useful paint
-   startup to editor interactive
-   note-open latency
-   search latency
-   keystroke/input latency
-   IndexedDB read/write latency
-   encryption time
-   synchronization duration
-   initial bundle size
-   memory consumption with large note collections

Performance regressions should be detectable in automated testing where
practical.

------------------------------------------------------------------------

## 8. Autosave Strategy

Do not write to Firestore for every keystroke.

Suggested flow:

``` text
Keystroke
   ↓
Update editor immediately
   ↓
Mark local note dirty
   ↓
Persist locally
   ↓
Debounce cloud synchronization
   ↓
Encrypt
   ↓
Upload encrypted revision
```

Suggested starting values:

-   Remote sync approximately **500--1000 ms after typing stops**
-   If continuous typing continues, force a remote checkpoint
    approximately every **5 seconds**

These values should be configurable and performance-tested.

Local persistence should happen sufficiently quickly that
closing/crashing the browser shortly after typing has minimal risk of
losing content.

Consider batching local persistence if required for performance, while
keeping an in-memory dirty state until persistence succeeds.

------------------------------------------------------------------------

## 9. Notes

A note should initially contain only what is genuinely necessary.

Logical model:

``` text
Note
- id
- title
- content
- created_at
- updated_at
- revision
- folder_id (optional)
```

Do not add complex schemas prematurely.

Titles and content are encrypted before cloud storage.

Firestore must not contain plaintext note titles or note bodies.

------------------------------------------------------------------------

## 10. Markdown Editor

Markdown support is mandatory.

The editor should support Markdown syntax highlighting for at least:

-   headings
-   bold
-   italic
-   strikethrough
-   links
-   lists
-   numbered lists
-   blockquotes
-   inline code
-   fenced code blocks
-   horizontal rules
-   tables where practical
-   task lists where practical

Example:

``` markdown
# PostgreSQL commands

Start server:

```bash
docker compose up -d
```

## Query

``` sql
SELECT id, name
FROM customers
WHERE active = true;
```


    The editor should provide syntax highlighting without forcing the user into a rich-text/block-editor model.

    The underlying note remains **plain Markdown text**.

    ### Code highlighting

    Fenced Markdown code blocks should support language-aware syntax highlighting, including common languages such as:

    - Rust
    - JavaScript
    - TypeScript
    - Python
    - Java
    - Kotlin
    - C#
    - C/C++
    - Go
    - Swift
    - SQL
    - JSON
    - YAML
    - TOML
    - HTML
    - CSS
    - Bash/Shell
    - PowerShell
    - XML

    Prefer lazy-loading language grammars rather than shipping every grammar in the initial bundle.

    ### Diagrams

    In the preview, a fenced `mermaid` block is drawn as a diagram in the app's own light or dark palette. Mermaid is loaded only when a note being previewed contains such a block. Until it loads, or when the diagram does not parse, the block shows as its source, with mermaid's error message beneath it in the parse case.

    ### Editor behavior

    Support normal developer-friendly keyboard behavior.

    Desktop shortcuts should eventually include:

    ```text
    Cmd/Ctrl + N    New note
    Cmd/Ctrl + P    Quick note finder
    Cmd/Ctrl + F    Find in current note
    Cmd/Ctrl + S    May trigger immediate sync, but saving must never depend on it

The editor must work well on touch/mobile devices.

Do not make Markdown preview necessary to understand the note.
Syntax-highlighted Markdown editing itself is the primary experience.

A rendered preview can be added later if it does not compromise
simplicity or performance.

------------------------------------------------------------------------

## 11. Quick Finder

A fast global note finder is a core feature.

`Cmd/Ctrl + P` should open a lightweight finder similar to VS Code.

Example:

``` text
> postgres

Postgres commands
Postgres Docker setup
PostgreSQL test notes
Old server configuration
```

Search results should update essentially instantly while typing.

### Search architecture

Because note contents are end-to-end encrypted, server-side plaintext
search is unacceptable.

Search should therefore be performed locally.

Maintain a local search index based on decrypted notes available to the
authenticated client.

Search should support:

-   title matches
-   content matches
-   partial matches
-   sensible ranking
-   keyboard navigation

Do not upload plaintext search indexes to Firebase.

For the MVP, prefer a simple, extremely fast local search implementation
over a sophisticated heavyweight search engine.

Benchmark before adding dependencies.

------------------------------------------------------------------------

## 12. Folder Structure

Provide a simple optional hierarchy.

Example:

``` text
📁 Ideas
📁 Code
   ├── Rust
   ├── SQL
   └── Commands
📁 Work
📁 Personal
```

Avoid building a full document-management system.

The user should also be able to ignore folders completely and use
search/recent notes.

Consider folders organizational metadata that must also be encrypted
where their names could reveal private information.

------------------------------------------------------------------------

## 13. Encryption

Encryption is mandatory and must be designed correctly from the
beginning.

### Security goal

The server/database operator should not be able to read users' note
titles or contents.

The system should provide genuine client-side/end-to-end encryption
rather than merely relying on Firebase's encryption at rest.

Conceptually:

``` text
Plaintext note
     ↓
Client encryption
     ↓
Encrypted payload
     ↓
Firestore
```

Firestore stores ciphertext.

### Cryptography

Do **not invent cryptographic algorithms**.

Use mature, audited cryptographic libraries and modern authenticated
encryption.

An appropriate design may use:

-   AES-256-GCM or XChaCha20-Poly1305 for authenticated encryption
-   a modern password-based KDF such as Argon2id where supported and
    appropriate
-   cryptographically secure random salts/nonces
-   versioned encrypted payload formats

The implementation must receive a dedicated security review before
production.

### Key management

Authentication and encryption are separate concepts.

Firebase Authentication proves who the user is.

It must not automatically mean Firebase has access to the plaintext
encryption key.

Design a secure mechanism for deriving/wrapping the user's encryption
key.

The design must consider:

-   password changes
-   forgotten passwords
-   new-device login
-   key derivation
-   key rotation/versioning
-   logout
-   local key removal
-   recovery strategy
-   multi-device use

Clearly communicate any security consequences of password recovery. Do
not create a backdoor that silently defeats the encryption promise.

### Local security

Do not casually persist plaintext notes in insecure browser storage.

The implementation must explicitly document:

-   what is stored decrypted in memory
-   what is stored in IndexedDB
-   whether IndexedDB content is encrypted
-   when decrypted keys are held
-   what logout clears
-   behavior on shared computers

Prefer encrypted local persistence if it can be implemented without
damaging startup performance.

------------------------------------------------------------------------

## 14. Firebase Data Model

Keep Firestore simple.

Possible high-level structure:

``` text
users/{uid}
users/{uid}/notes/{noteId}
users/{uid}/folders/{folderId}
users/{uid}/usage/current        (the storage and push meter, §15)
```

An encrypted note record may resemble:

``` json
{
  "version": 1,
  "ciphertext": "...",
  "nonce": "...",
  "revision": 42,
  "updatedAt": "...",
  "deleted": false
}
```

Do not store plaintext:

-   note title
-   note body
-   folder names
-   code snippets
-   search terms

Minimize metadata leakage where practical.

------------------------------------------------------------------------

## 15. Firebase Security Rules

Firestore rules must ensure that a user can only access records
belonging to that authenticated Firebase UID.

Security rules must be tested automatically.

Tests must verify at minimum:

-   unauthenticated users cannot read notes
-   unauthenticated users cannot write notes
-   User A cannot read User B's notes
-   User A cannot modify User B's notes
-   authenticated users can access their own allowed records

Never rely solely on UI logic for authorization.

The rules must also bound what one account can cost, for the same reason:
a modified client is the case that matters. As built (`firestore.rules`,
`src/core/sync/usage.ts`):

-   storage: 1 GiB per account plus purchased add-ons, every stored note
    and folder counting at least 1 KiB (tombstones included)
-   writes: 20,000 pushes per account per rolling day, by the server's clock
-   history and shared links: 500 MB and 100 per calendar month
-   ids: note and folder ids at most 64 characters; one key record

A refused write is never lost: it waits on the device and syncs when the
limit allows (§25).

------------------------------------------------------------------------

## 16. Synchronization

The sync layer must handle:

-   first login on a new device
-   local changes
-   remote changes
-   temporary offline operation
-   browser refresh
-   multiple browser tabs
-   two devices editing the same note
-   deletion
-   interrupted uploads
-   stale revisions

Start with a simple revision-based conflict strategy.

Never silently discard user text.

If an automatic merge cannot safely resolve a conflict, preserve both
versions.

Data integrity is more important than creating a clever
conflict-resolution algorithm.

------------------------------------------------------------------------

## 17. Offline Support

The application should be usable offline after it has been loaded
previously.

Offline behavior:

``` text
Open cached application
       ↓
Load local notes
       ↓
Edit normally
       ↓
Save locally
       ↓
Display "Offline"
       ↓
Network returns
       ↓
Encrypt pending changes
       ↓
Synchronize
       ↓
Display "Saved ✓"
```

Do not disable the editor simply because Firebase is unavailable.

A backend that answers but refuses every client for a while — the cost kill
switch's lockdown (§15) — is treated like being offline, not like a refused
account: display "Sync paused" with a calm notice that the notes are safe on
the device and will sync when it resumes; sign nobody out, never report it as
a missing plan, offer no purchase, create no vault on a device that has none,
seed no first-run notes, and resume by itself when the backend accepts
requests again. As built, a refused request is checked with one read of a
sentinel that only the lockdown rules allow (`src/core/sync/pause.ts`).

------------------------------------------------------------------------

## 18. Authentication

For MVP, support a secure, simple authentication mechanism through
Firebase Authentication.

Email/password is sufficient initially.

The UX should support:

-   register
-   login
-   logout
-   session persistence
-   account recovery consistent with encryption design

Do not add social login unless there is a clear product reason.

Keep authentication screens extremely lightweight.

------------------------------------------------------------------------

## 19. PWA / Mobile

The application must work well in:

-   Chrome
-   Safari
-   Firefox
-   Edge
-   Android browsers
-   iPhone/iPad browsers

It should be installable as a PWA where platform support allows.

Mobile requirements:

-   editor fills useful screen area
-   no desktop-only assumptions
-   responsive note/folder navigation
-   touch-friendly controls
-   virtual keyboard does not break layout
-   autosave works reliably
-   offline mode works
-   search is easy to invoke
-   no unnecessary animations

------------------------------------------------------------------------

## 20. Desktop Layout

Suggested initial layout:

``` text
┌───────────────────────────────────────────────────────────┐
│ App                          Search / Cmd+P        + Note │
├──────────────────┬────────────────────────────────────────┤
│                  │                                        │
│ FOLDERS          │  # Note title                          │
│                  │                                        │
│ Ideas            │  Markdown content...                   │
│ Code             │                                        │
│ Work             │                                        │
│ Personal         │                                        │
│                  │                                        │
│ RECENT           │                                        │
│                  │                                        │
│ API idea         │                                        │
│ Rust commands    │                                        │
│ Website text     │                               Saved ✓  │
└──────────────────┴────────────────────────────────────────┘
```

Keep visual chrome minimal.

The text is the product.

------------------------------------------------------------------------

## 21. Mobile Layout

On small screens, use a simple navigation model:

``` text
Notes list
    ↓
Tap note
    ↓
Full-screen editor
```

A back/menu control returns to notes/folders/search.

Do not permanently reserve large amounts of screen space for navigation
on mobile.

------------------------------------------------------------------------

## 22. Features Explicitly Out of Scope for MVP

Do not build these unless instructed later:

-   AI assistant
-   collaborative editing
-   comments
-   teams
-   calendars
-   kanban boards
-   spreadsheets
-   databases
-   image editing
-   PDF editing
-   video
-   complex attachments
-   whiteboards
-   presentations
-   publishing platform
-   complex rich-text/block editor
-   social features
-   plugin marketplace

Do not turn the product into Notion.

------------------------------------------------------------------------

## 23. Potential Future Features

Architect so these can be added later without implementing them now:

-   Markdown preview
-   import/export
-   encrypted backup
-   note history
-   sharing individual encrypted notes
-   additional themes
-   pinned notes
-   favorites
-   tags
-   code-snippet conveniences
-   API
-   desktop wrapper/native application
-   native mobile applications
-   self-hosted synchronization server

------------------------------------------------------------------------

## 24. Export and Data Portability

Avoid user lock-in.

Plan for export of decrypted user data after local
authentication/unlocking.

A future export format should preferably be understandable without
proprietary software, for example:

``` text
export/
  Ideas/
    startup.md
    website.md
  Code/
    postgres.md
    rust.md
```

Plain Markdown is the canonical human-readable format.

Import is the same promise from the other side: a folder or zip of Markdown
or text arrives as notes and folders. Exports whose real content is JSON are
recognised as well — Simplenote (tags, pins, dates) and Google Keep via
Google Takeout (labels, checklists, pins, archive, dates) — with tags and
labels written into the text as `#tags`. Attachments are not imported, and
the import summary lists them.

------------------------------------------------------------------------

## 25. Reliability

User notes must never disappear because of an optimization.

Implement defensive persistence.

Important scenarios to test:

-   user types and immediately closes tab
-   browser crashes
-   phone goes offline
-   Firebase write fails
-   token expires during editing
-   same note edited on two devices
-   IndexedDB unavailable
-   storage quota reached
-   synced storage allowance or daily push limit reached
-   backend refusing every client (a cost lockdown), and its end
-   encryption fails
-   corrupted remote payload
-   stale local revision
-   app upgrade changes encrypted payload version

Prefer preserving duplicate/conflicting data over silently losing it.

------------------------------------------------------------------------

## 26. Testing

Create automated tests for:

### Unit tests

-   encryption/decryption
-   serialization
-   note repository
-   sync state
-   revision handling
-   search
-   Markdown behavior where appropriate

### Integration tests

-   Firebase Authentication
-   Firestore security rules
-   local persistence
-   sync
-   offline → online transition
-   multi-device conflict simulation

### End-to-end tests

At minimum:

1.  Create account.
2.  Create note.
3.  Type Markdown.
4.  Confirm automatic local save.
5.  Confirm encrypted remote save.
6.  Reload.
7.  Note appears.
8.  Log in from simulated second device.
9.  Note synchronizes and decrypts.
10. Edit offline.
11. Reconnect.
12. Changes synchronize.
13. Search finds note instantly.
14. User A cannot access User B data.

------------------------------------------------------------------------

## 27. Performance Tests

Create repeatable benchmarks using realistic datasets.

Test at least:

-   100 notes
-   1,000 notes
-   10,000 notes

Include notes containing code and Markdown.

Measure:

-   initial startup
-   warm startup
-   note list rendering
-   opening a note
-   Cmd/Ctrl+P opening
-   search-as-you-type
-   editor typing responsiveness
-   encryption
-   local persistence
-   synchronization

Large collections must not cause the editor to become sluggish.

Use virtualization for long note lists where necessary.

Do not render thousands of note DOM elements unnecessarily.

------------------------------------------------------------------------

## 28. Dependency Policy

Every dependency must justify:

-   bundle-size cost
-   startup cost
-   security implications
-   maintenance implications

Prefer browser/platform capabilities where they are robust enough.

Do not import a large framework/library to solve a trivial problem.

Lazy-load functionality that is not necessary for initial editing.

Markdown syntax highlighting should avoid forcing all language
definitions into the startup bundle.

Mermaid (preview diagrams) is the largest dependency in the app, and it is
accepted on these terms. It is never in either document's eager graph. It is
fetched only from a note that contains a `mermaid` fence: about 200 KB
gzipped for the core and a flowchart, plus about 3–150 KB for each further
diagram type. Its output is sanitised before it reaches the page
(`docs/security.md`, "The Markdown preview").

------------------------------------------------------------------------

## 29. Privacy

Collect the minimum possible user data.

Do not add invasive analytics.

If analytics are later required, they must never capture:

-   note titles
-   note bodies
-   code
-   search queries
-   decrypted content
-   encryption keys

Logging must never accidentally log plaintext notes or secrets.

------------------------------------------------------------------------

## 30. Product Positioning

Design around this concept:

> **A private, lightning-fast Notepad++ for the web.**

Potential product promises:

-   Your text, everywhere.
-   No Save button.
-   Works offline.
-   Markdown built in.
-   Designed for code and plain text.
-   Encrypted before it reaches the cloud.
-   Fast enough to replace local Notepad/TextEdit for everyday scratch
    notes.

------------------------------------------------------------------------

## 31. MVP Acceptance Criteria

The MVP is complete when a user can:

-   create an account
-   securely unlock encryption
-   create a note
-   add a title
-   type plain text
-   type Markdown with live syntax highlighting
-   use fenced code blocks with syntax highlighting
-   have every edit automatically persisted locally
-   have changes automatically encrypted and synchronized to Firestore
-   refresh without losing work
-   use the application offline
-   reconnect and synchronize
-   organize notes into simple folders
-   search notes locally and very quickly
-   use Cmd/Ctrl+P as a quick note finder
-   use the product comfortably on desktop
-   use the product comfortably on a phone
-   log into another device and retrieve/decrypt notes
-   log out securely

And:

-   Firebase contains no plaintext note titles/bodies.
-   Firestore security rules prevent cross-user access.
-   The application remains responsive with thousands of notes.
-   Typing does not depend on network availability.

------------------------------------------------------------------------

## 32. Implementation Sequence for the Agent

Implement incrementally.

### Phase 1 --- Performance shell

Build:

-   minimal application shell
-   responsive desktop/mobile layout
-   editor
-   Markdown syntax highlighting
-   local in-memory note state

Measure startup and editor performance immediately.

### Phase 2 --- Local-first persistence

Add:

-   IndexedDB repository
-   note creation/update/deletion
-   folders
-   recent notes
-   local search
-   Cmd/Ctrl+P finder
-   crash/reload persistence

The application should already be useful without Firebase.

### Phase 3 --- Cryptography

Add:

-   key management
-   authenticated encryption
-   encrypted local/remote serialization
-   encryption versioning
-   security tests

Do not proceed with production synchronization until the crypto design
has been reviewed carefully.

### Phase 4 --- Firebase

Add:

-   Firebase Authentication
-   Firestore
-   strict security rules
-   encrypted sync
-   revision tracking
-   background autosave
-   offline queue

### Phase 5 --- Multi-device reliability

Add/test:

-   second-device synchronization
-   concurrent edits
-   conflict preservation
-   deletion synchronization
-   reconnect behavior
-   token/session expiry

### Phase 6 --- PWA

Add:

-   installable manifest
-   application shell caching
-   offline startup
-   mobile polish

### Phase 7 --- Hardening

Perform:

-   security review
-   performance profiling
-   bundle analysis
-   Firestore cost analysis
-   browser compatibility tests
-   load tests
-   data-loss scenario tests

------------------------------------------------------------------------

## 33. Instructions to the Agentic Coding System

When implementing this specification:

1.  **Do not overengineer the MVP.**
2.  Keep modules small and responsibilities explicit.
3.  Make performance measurements rather than assuming something is
    fast.
4.  Never put Firebase/network operations in the editor's synchronous
    interaction path.
5.  Never send plaintext note contents or titles to Firebase.
6.  Never implement custom cryptographic primitives.
7.  Do not weaken encryption to simplify password recovery.
8.  Do not add product features outside this specification without
    explicit approval.
9.  Preserve user data rather than resolving conflicts destructively.
10. Keep the application usable without a network connection.
11. Treat Markdown editing as a first-class feature.
12. Optimize for developers without making the application difficult for
    ordinary users.
13. Keep Firebase behind an adapter so the backend can be replaced
    later.
14. Continuously monitor bundle size and startup performance.
15. Prefer the simplest solution that satisfies security, reliability,
    and performance requirements.

Before making a major architectural choice, ask:

> **Will this make opening, typing, finding, or saving a note slower?**

If yes, find a better design unless the tradeoff is required for
security or data integrity.

------------------------------------------------------------------------

## 34. Definition of the Product

This application is **not** a document-management suite.

It is **not** a collaboration platform.

It is **not** an AI workspace.

It is:

> **An extremely fast, encrypted, local-first cloud text and Markdown
> notepad that automatically saves and synchronizes across devices.**

That definition should guide every engineering and product decision.
