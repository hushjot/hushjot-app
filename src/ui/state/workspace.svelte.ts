/**
 * The reactive workspace: the single place UI components read note state from.
 *
 * ## What lives in memory
 *
 * Metadata for every note, and the text of the **open notes only** — one per
 * tile, at most `MAX_TILES`. Spike 3 measured 410 MB of heap when all 10,000
 * note bodies were retained, so bodies are read on demand (p95 0.3 ms) and
 * released when the note closes. Beyond the memory, this keeps the window in
 * which plaintext is resident short (§13).
 *
 * ## Tiles
 *
 * Each tile is a `Pane`: the note it shows, that note's text, and the
 * bookkeeping that used to exist once for "the open note". The focused pane is
 * what `selectedId`, `openContent` and `bodyReady` report, so everything written
 * before tiling — the status bar, ⌘P, copy, the first-run gate — still sees one
 * open note. The rules for opening, replacing and closing tiles are in
 * `ui/tiling.ts`.
 *
 * ## The typing path
 *
 * `update()` writes one string into memory and marks the note dirty. That is
 * all. Persistence is debounced, the search index is updated off-thread, and
 * the note list's title and ordering refresh on the same debounce — so the
 * sidebar does not reshuffle under the user's cursor while they type (§7).
 *
 * ## First run is deferred, not decided here
 *
 * `init()` can conclude this database has never held a note, but it must not
 * act on that: sync has not started yet, so an empty local database is not
 * evidence of an empty account. It raises `firstRunPending` and the gate in
 * `App.svelte` decides when `completeFirstRun()` may write anything. See
 * `core/notes/firstRun.ts` for the duplicate-notes bug that shape prevents.
 */
import {
  createNote,
  deriveTitle,
  excerptOf,
  byRecency,
  type Note,
  type NoteMeta,
} from '../../core/notes/model.ts';
import {
  buildTree,
  canMoveFolder,
  createFolder,
  flattenTree,
  subtreeIds,
  type Folder,
  type FolderNode,
} from '../../core/notes/folders.ts';
import {
  openRepository,
  type NoteRepository,
  type PersistedNote,
  type RawNote,
} from '../../core/repo/noteRepository.ts';
import { createWriteScheduler, type WriteScheduler } from '../../core/repo/writeScheduler.ts';
import { checkPersisted, requestPersistence, isQuotaExceeded, type StorageDurability } from '../../core/repo/storage.ts';
import {
  readJournal,
  writeJournal,
  clearJournal,
  planReplay,
  type JournalEntry,
} from '../../core/repo/journal.ts';
import { encryptedCodec } from '../../core/repo/encryptedCodec.ts';
import { SyncNotApprovedError, TransientSyncError, type RemoteNote, type SyncCursor } from '../../core/sync/adapter.ts';
import {
  createTabChannel,
  watchSiblingWrites,
  type TabChannel,
} from '../../core/sync/tabs.ts';
import { seal, open } from '../../core/crypto/envelope.ts';
import { recordContext } from '../../core/crypto/binding.ts';
import { utf8, fromUtf8, type Bytes } from '../../core/crypto/bytes.ts';
import { vaultStore } from './vault.svelte.ts';
import { syncStore } from './sync.svelte.ts';
import { SearchClient } from './search.svelte.ts';
import { isFirstRun } from '../../core/notes/firstRun.ts';
import { WELCOME_NOTE, SCRATCH_NOTE } from './seed.ts';
import { createOpensTile, planClose, planTile, restoreTiles } from '../tiling.ts';
import { readOpenTiles, readTileModes, writeOpenTiles, writeTileModes } from './tiling.svelte.ts';
import { modesToStore, storedModeFor, type ViewMode } from '../viewMode.ts';
import { CaptureTracker } from '../../core/history/policy.ts';
import type { HistoryService } from '../../core/history/service.ts';
import type { VersionReason } from '../../core/history/record.ts';
import type { ImportPlan } from '../../core/portability/importTree.ts';
import type { ExportNote } from '../../core/portability/exportTree.ts';

/**
 * The §4 indicator's vocabulary.
 *
 * `sync-failed` is the odd one out: the other four describe where the user's
 * text has got to, and this one says it has stopped getting anywhere. It was
 * added because a cycle that threw fell through to 'saved' — a backend that
 * kept refusing every push sat behind a green tick indefinitely, with the raw
 * status string in the account panel as the only sign (§25). It is deliberately
 * not raised for the two latched failures, `not-approved` and `signed-out`:
 * both stop the engine and put up their own banner, and a second signal for a
 * state the user has already been told about is noise.
 */
export type SaveState = 'saved' | 'saving' | 'offline' | 'syncing' | 'sync-failed';

export interface StorageWarning {
  kind: 'not-persistent' | 'unavailable' | 'quota' | 'write-failed';
  detail: string;
}

/**
 * The eviction notice, as a single frozen value rather than one built per read.
 * `warning` derives it, so a fresh object each time would churn any `$effect`
 * downstream of the getter.
 */
const NOT_PERSISTENT_WARNING: StorageWarning = Object.freeze({
  kind: 'not-persistent',
  detail:
    'Notes are stored only in this browser. Clearing browser data, or the browser itself, can delete them. Install the app or export a copy.',
});

/**
 * One tile's open note.
 *
 * The reactive fields are per pane, so a keystroke in one tile invalidates that
 * tile's readers and nothing else.
 */
export class Pane {
  id = $state<string | null>(null);
  content = $state('');
  /**
   * The note whose body is actually resident in `content`. Distinct from `id`,
   * which is set the moment the user clicks — the gap between the two is
   * exactly the window in which an edit must not be accepted.
   */
  loadedId = $state<string | null>(null);
  loading = $state(false);
  /** Editor, rendered preview, or both. Belongs to the tile, not the note. */
  mode = $state<ViewMode>('edit');
  /**
   * Whether this pane's note has been edited since it was loaded or last
   * queued.
   *
   * Without it committing a note bumped the revision and scheduled an upload
   * for a note nobody had touched — on every pane switch, every new note,
   * every folder created and every tab close. That is what published the
   * untouched welcome note to the backend and duplicated it across devices.
   */
  dirty = false;
  /** Sealed copy of this pane's note, kept current for the teardown journal. */
  journalEntry: JournalEntry | undefined;
  journalGeneration = 0;

  /** True once the note's text is actually resident and editable. */
  get ready(): boolean {
    return this.loadedId !== null && this.loadedId === this.id;
  }
}

class Workspace {
  // `$state.raw`: these arrays hold thousands of entries and are replaced
  // wholesale. Deep proxying every element would cost far more than it buys.
  #metas = $state.raw<NoteMeta[]>([]);
  #folders = $state.raw<Folder[]>([]);

  /** Never empty: a workspace with no note open still has one blank pane. */
  #panes = $state.raw<Pane[]>([new Pane()]);
  #focused = $state(0);
  #saveState = $state<SaveState>('saved');
  #warning = $state<StorageWarning | null>(null);
  #initialized = $state(false);
  /**
   * True between "this database has never held a note" and the moment it is
   * safe to act on that. `init()` only ever sets it; `completeFirstRun()` is
   * what actually writes anything, once the account can no longer surprise us.
   */
  #firstRunPending = $state(false);
  /** Re-entrancy guard: the gate's `$effect` can run more than once. */
  #firstRunSettling = false;

  /** Mobile only: whether the editor pane covers the list (§21). */
  editorOpen = $state(false);

  readonly search = new SearchClient();

  #repo: NoteRepository | undefined;
  /**
   * The bus to the other tabs on this database. Owned here rather than by the
   * sync engine because a stale note list has nothing to do with an account:
   * the engine exists only when signed in, and with the channel inside it every
   * local-only tab went deaf to its siblings. See `core/sync/tabs.ts`.
   */
  #tabs: TabChannel | undefined;
  #stopWatchingSiblings: (() => void) | undefined;
  #scheduler: WriteScheduler<string, PersistedNote> | undefined;
  /** Non-reactive bookkeeping: revisions and pending edits. */
  #revisions = new Map<string, number>();

  /**
   * Notes and folders that exist in memory but are not on disk yet.
   *
   * `create()` selects the note before the write resolves, so a refresh in
   * that window would read the database, not find it, and decide the user's
   * brand-new note had been deleted elsewhere. Rare when only a remote pull
   * could trigger one; ordinary now that a sibling tab's write can.
   *
   * `addFolder()` has the same window. `refreshFromStore` replaces the lists
   * wholesale, so it keeps anything still in here rather than dropping it —
   * a new folder used to vanish from the sidebar until the next refresh.
   */
  #uncommitted = new Set<string>();

  /**
   * Advanced whenever a structural local write (a note created, moved or
   * deleted; a folder added, renamed or deleted) reaches the database.
   *
   * `#uncommitted` covers a refresh that reads entirely before a commit; this
   * covers one whose read straddles it, which would otherwise assign a list
   * that predates the write. Not advanced on the typing path: every drain
   * would force a re-read. `#removing` covers the third case.
   */
  #localEpoch = 0;

  /**
   * Notes and folders gone from memory whose tombstones are not on disk yet —
   * `#uncommitted` the other way round.
   *
   * `remove()` drops a note from the list, then awaits closing its tile, and
   * only then writes the tombstone. A refresh whose read finishes inside that
   * window sees the note still in the database, and the epoch has not moved,
   * so it put the note straight back. The body was then deleted under it,
   * which left an empty row that only a second delete removed. Closing the
   * delete's `confirm()` refocuses the window, and focus refreshes, so this
   * was the ordinary path, not a rare one.
   */
  #removing = new Set<string>();

  /**
   * Set when a sibling tab's write has landed but the search index has not
   * been rebuilt for it. Settled lazily — see `refreshFromStore`.
   */
  #searchStale = false;
  /** Plain field: the once-guard, which nothing renders. */
  #askedForPersistence = false;
  // Reactive: `warning` derives the eviction notice from these. `#durability`
  // only means anything once `#durabilityKnown` is set, which is why the two
  // are separate — the default of 'unavailable' would otherwise read as a
  // refusal during the request itself.
  #durability = $state<StorageDurability>('unavailable');
  #durabilityKnown = $state(false);
  #persistenceNoticeDismissed = $state(false);
  /**
   * The journal entry of the most recently closed tile. Its note may still be
   * one write-scheduler window from disk, and closing the tile must not also
   * drop the only teardown-safe copy of that last keystroke.
   */
  #closedJournalEntry: JournalEntry | undefined;
  #searchRebuildTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Note history (`core/history/`). The tracker is the only eager part: it
   * decides, on the write debounce, whether a save should keep the text it
   * replaces. The service — and the database behind it — load the first time
   * that answer is yes, and resolve to null for the session if they cannot.
   */
  #captureTracker = new CaptureTracker();
  #history: Promise<HistoryService | null> | undefined;

  // --- lifecycle -----------------------------------------------------------

  async init(): Promise<void> {
    if (this.#initialized) return;

    try {
      // The codec reads the key at point of use rather than capturing it, so
      // locking the vault takes effect on the very next read or write.
      this.#repo = await openRepository({ codec: encryptedCodec(() => vaultStore.key()) });
      // With the repository, before anything can await: the engine is only
      // ever started once `repository` is set, and it must find this channel
      // rather than open a second one in the same tab — two channel objects
      // are two senders, and each would hear the other's posts.
      this.#tabs = createTabChannel();
      this.#stopWatchingSiblings = watchSiblingWrites(this.#tabs, () => {
        void this.refreshFromStore('sibling');
      });
    } catch {
      // No IndexedDB (private mode, disabled storage). The app still works for
      // this session; it just cannot promise the text survives a reload (§25).
      this.#warning = {
        kind: 'unavailable',
        detail: 'Local storage is unavailable, so notes will not survive a reload.',
      };
      this.#seedInMemory();
      this.#initialized = true;
      return;
    }

    this.#scheduler = createWriteScheduler<string, PersistedNote>({
      write: (batch) => this.#persist(batch),
      onError: (error) => this.#onWriteError(error),
      onStateChange: (pending) => {
        this.#saveState = pending ? 'saving' : 'saved';
      },
    });

    const [metas, folders, anyNoteRow, seededBefore] = await Promise.all([
      this.#repo.loadAllMeta(),
      this.#repo.loadFolders(),
      this.#repo.hasAnyNote(),
      this.#repo.firstRunDone(),
    ]);

    // Folders are assigned on both branches. They used to be set only when
    // notes existed, so "every note deleted, folders kept" dropped the folder
    // list out of memory until the next remote change happened to reload it.
    this.#folders = folders;

    if (isFirstRun({ liveNotes: metas.length, anyNoteRow, seededBefore })) {
      // Nothing is written here. See `core/notes/firstRun.ts`: seeding before
      // the first pull is what mints duplicate notes on a device whose local
      // database is empty but whose account is not.
      this.#firstRunPending = true;
    } else {
      this.#metas = metas.map(({ revision, ...meta }) => {
        // Revisions must survive a reload. Restarting them at 1 each session
        // would make every note look freshly created to Phase 4's conflict
        // detection.
        this.#revisions.set(meta.id, revision);
        return meta;
      });
      await this.#replayJournal(metas);
      // An install that predates the marker has notes but no claim, so it
      // would still look eligible the day it reached zero live notes.
      if (!seededBefore) void this.#repo.markFirstRunDone();
    }

    this.#initialized = true;

    // A returning user who only reads never writes, so the write-time request
    // would never run and the eviction notice would never show. `persisted()`
    // puts nothing on screen, so it is safe here; asking still waits for a write.
    if (anyNoteRow) void this.#checkPersistence();

    // Reopen last session's tiles, or the most recent note — §6's "recently
    // opened note available immediately".
    const live = new Set(this.#metas.map((m) => m.id));
    const restored = restoreTiles(readOpenTiles(), (id) => live.has(id));
    if (restored.length > 0) {
      const modes = readTileModes();
      const panes = restored.map((id) => {
        const pane = new Pane();
        pane.mode = storedModeFor(modes, id);
        return pane;
      });
      this.#panes = panes;
      this.#focused = 0;
      await Promise.all(restored.map((id, i) => this.#openInto(panes[i]!, id)));
    } else {
      const first = this.#metas[0];
      if (first) await this.#openInto(this.#pane, first.id);
    }

    this.search.start();
  }

  /**
   * Write first-run content, now that the account can no longer surprise us.
   *
   * Called from the gate in `App.svelte`, which decides *when* — no backend,
   * or no account, or a sync cycle has completed. This decides *whether*, and
   * has to re-check: the pull that released the gate may have brought the
   * user's notes down, in which case there is nothing to seed.
   *
   * The claim is taken here rather than in `init()` on purpose. Marking the
   * database claimed and then dying before writing the notes would leave a
   * permanently empty workspace with no way back.
   */
  async completeFirstRun(): Promise<void> {
    if (!this.#firstRunPending || this.#firstRunSettling || !this.#repo) return;
    this.#firstRunSettling = true;

    try {
      if (this.#metas.length > 0 || (await this.#repo.hasAnyNote())) {
        // The account had notes after all, or another tab got there first.
        this.#firstRunPending = false;
        return;
      }
      if (!(await this.#repo.claimFirstRun())) {
        this.#firstRunPending = false;
        return;
      }

      await this.#seedPersisted();
      this.#firstRunPending = false;

      const first = this.#metas[0];
      if (first) await this.#openInto(this.#pane, first.id);
    } finally {
      this.#firstRunSettling = false;
    }
  }

  #seedInMemory(): void {
    const welcome = createNote({ content: WELCOME_NOTE });
    const scratch = createNote({ content: SCRATCH_NOTE, now: Date.now() - 60_000 });
    this.#metas = [welcome, scratch].map(toMetaOf).sort(byRecency);
    this.#revisions.set(welcome.id, welcome.revision);
    this.#revisions.set(scratch.id, scratch.revision);
    const pane = this.#pane;
    pane.id = welcome.id;
    pane.content = welcome.content;
    pane.loadedId = welcome.id;
    pane.dirty = false;
  }

  /**
   * Write the first-run notes. Only ever reached through
   * `completeFirstRun()`, which has established that the account holds nothing.
   *
   * They are queued for upload like any other note, and that matters: left
   * local-only, a second device would pull nothing, conclude it was also a
   * first run, and seed its own pair — and the two pairs would meet the moment
   * either was edited. Pushing them is what makes every later device see notes
   * already there and decline to seed. `#queue` now does this for every note,
   * so there is nothing special here beyond the reason it must not regress.
   *
   * Indexed explicitly because `search.start()` has already built from the
   * database by the time the gate releases; without this the seeds would be
   * invisible to Cmd+P until the next reload.
   */
  async #seedPersisted(): Promise<void> {
    const welcome = createNote({ content: WELCOME_NOTE });
    const scratch = createNote({ content: SCRATCH_NOTE, now: Date.now() - 60_000 });
    const notes = [welcome, scratch];

    for (const note of notes) this.#revisions.set(note.id, note.revision);
    this.#metas = notes.map(toMetaOf).sort(byRecency);

    try {
      await this.#repo!.putNotes(notes.map(toPersisted));
      for (const note of notes) {
        this.search.upsert({
          id: note.id,
          title: note.title,
          content: note.content,
          updatedAt: note.updatedAt,
          folderId: note.folderId,
        });
        this.#queue(note.id, 'note');
      }
    } catch (error) {
      this.#onWriteError(error);
    }
  }

  /**
   * Recover edits whose database write never landed because the page was torn
   * down mid-flight.
   */
  async #replayJournal(stored: readonly { id: string; revision: number }[]): Promise<void> {
    const entries = readJournal();
    if (entries.length === 0) return;

    const revisions = new Map(stored.map((m) => [m.id, m.revision]));
    const { restore } = planReplay(entries, revisions);

    if (restore.length > 0) {
      try {
        // The journal holds ciphertext, so recovery needs the vault open.
        const recovered: PersistedNote[] = [];
        for (const entry of restore) {
          const meta = this.#metas.find((m) => m.id === entry.id);
          if (!meta) continue;
          const content = fromUtf8(await open(vaultStore.key(), entry.cipher, recordContext('note-body', entry.id)));
          recovered.push({
            id: entry.id,
            title: deriveTitle(content),
            folderId: meta.folderId,
            pinnedAt: meta.pinnedAt,
            content,
            updatedAt: entry.updatedAt,
            createdAt: meta.createdAt,
            revision: entry.revision,
          });
        }

        if (recovered.length > 0) {
          await this.#repo!.putNotes(recovered);
          for (const note of recovered) this.#revisions.set(note.id, note.revision);
          this.#metas = this.#metas
            .map((meta) => {
              const note = recovered.find((n) => n.id === meta.id);
              return note ? { ...meta, title: note.title, updatedAt: note.updatedAt } : meta;
            })
            .sort(byRecency);
        }
      } catch (error) {
        // Leave the journal in place so the next start can try again.
        this.#onWriteError(error);
        return;
      }
    }

    clearJournal();
  }

  /**
   * Called from `pagehide`/`visibilitychange`: write everything, now.
   *
   * The journal write is synchronous and comes first, because the async
   * database write below is not guaranteed to survive page teardown — measured,
   * not assumed. Whichever one wins, the text is safe.
   */
  flush(): Promise<void> {
    for (const pane of this.#panes) this.#commitPane(pane);
    // Synchronous, and using ciphertext prepared as the user typed — sealing
    // here would be async and would not finish before the page dies.
    writeJournal(this.#journalEntries());
    return this.#scheduler?.flush() ?? Promise.resolve();
  }

  /**
   * Write out pending text, and nothing else.
   *
   * Deliberately not `flush()`: that commits the open note first, which
   * schedules a save, which queues a change, which schedules a sync. The sync
   * engine calls this one before every round trip, so a version of it that
   * creates work would never stop syncing.
   */
  flushPending(): Promise<void> {
    return this.#scheduler?.flush() ?? Promise.resolve();
  }

  /**
   * One entry per note, newest revision wins. A pane's entry outlives the note
   * it was sealed for until that pane's next keystroke, so after a note moves
   * between tiles two panes can hold entries for it, and replaying the older
   * one second would put stale text back.
   */
  #journalEntries(): JournalEntry[] {
    const byId = new Map<string, JournalEntry>();
    const candidates = [this.#closedJournalEntry, ...this.#panes.map((p) => p.journalEntry)];
    for (const entry of candidates) {
      if (!entry) continue;
      const held = byId.get(entry.id);
      if (!held || entry.revision > held.revision) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  dispose(): void {
    this.#closeTabs();
    this.#scheduler?.dispose();
    this.search.dispose();
    this.#repo?.close();
  }

  #closeTabs(): void {
    this.#stopWatchingSiblings?.();
    this.#stopWatchingSiblings = undefined;
    this.#tabs?.close();
    this.#tabs = undefined;
  }

  /**
   * Tear down for a lock: drop every piece of plaintext this store is holding
   * and return to an uninitialised state, so a later unlock starts clean.
   *
   * Caller flushes first — dropping the key with edits still queued would turn
   * them into ciphertext nobody can open.
   */
  async shutdown(): Promise<void> {
    // First: a sibling refresh armed a moment ago must not fire into a closed
    // repository, and a locked tab has no list to keep current.
    this.#closeTabs();
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.search.dispose();
    this.#repo?.close();
    this.#repo = undefined;
    void this.#history?.then((history) => history?.close());
    this.#history = undefined;
    this.#captureTracker.clear();
    this.#versionsFetchedAt.clear();

    this.#metas = [];
    this.#folders = [];
    // Fresh panes rather than cleared ones: any seal still in flight writes
    // into an object nothing references any more. The remembered tile ids are
    // left alone, so unlocking again brings the same tiles back.
    this.#panes = [new Pane()];
    this.#focused = 0;
    this.#revisions.clear();
    this.#closedJournalEntry = undefined;
    if (this.#searchRebuildTimer !== undefined) clearTimeout(this.#searchRebuildTimer);
    this.#searchRebuildTimer = undefined;
    this.#initialized = false;
    this.#askedForPersistence = false;
    this.#durabilityKnown = false;
    this.#persistenceNoticeDismissed = false;
    this.#saveState = 'saved';
    this.#warning = null;
    this.editorOpen = false;

    // The journal holds ciphertext for a key we are about to forget.
    clearJournal();
  }

  // --- reads ---------------------------------------------------------------

  get initialized(): boolean {
    return this.#initialized;
  }

  /** True while first-run content is owed but not yet safe to write. */
  get firstRunPending(): boolean {
    return this.#firstRunPending;
  }

  /** The tab channel, lent to the sync engine. Set whenever `repository` is. */
  get tabChannel(): TabChannel | undefined {
    return this.#tabs;
  }

  /** The local store, for the sync engine. It moves ciphertext, not notes. */
  get repository(): NoteRepository | undefined {
    return this.#repo;
  }

  get metas(): readonly NoteMeta[] {
    return this.#metas;
  }

  get folders(): readonly Folder[] {
    return this.#folders;
  }

  get saveState(): SaveState {
    return this.#saveState;
  }

  /**
   * Latched failures first: a write that actually failed outranks a durability
   * caveat. The eviction notice is derived rather than latched because sync
   * state arrives well after the persistence request settles — `connect()` is
   * deliberately deferred past first paint — and because signing in or out must
   * flip it without a reload.
   */
  get warning(): StorageWarning | null {
    if (this.#warning) return this.#warning;
    if (!this.#durabilityKnown || this.#durability === 'persistent') return null;
    if (this.#persistenceNoticeDismissed) return null;
    // Syncing makes eviction a cache loss, not data loss — storage.ts's "local
    // storage is a cache, sync is the durability guarantee". An unapproved
    // account is signed in but its writes are refused, so it still needs the
    // notice; an expired session clears `user`, so it needs no term of its own.
    if (syncStore.signedIn && !syncStore.notApproved) return null;
    return NOT_PERSISTENT_WARNING;
  }

  get #pane(): Pane {
    return this.#panes[this.#focused] ?? this.#panes[0]!;
  }

  /** Every tile, in layout order. */
  get panes(): readonly Pane[] {
    return this.#panes;
  }

  get focusedIndex(): number {
    return this.#focused;
  }

  /** The focused tile's note. */
  get selectedId(): string | null {
    return this.#pane.id;
  }

  get openContent(): string {
    return this.#pane.content;
  }

  get loadingBody(): boolean {
    return this.#pane.loading;
  }

  /** True once the focused note's text is actually resident and editable. */
  get bodyReady(): boolean {
    return this.#pane.ready;
  }

  readonly selectedMeta = $derived<NoteMeta | null>(
    this.#metas.find((m) => m.id === this.#pane.id) ?? null,
  );

  /** The nested tree, for the sidebar, which collapses branches of it. */
  readonly folderRoots = $derived<FolderNode[]>(buildTree(this.#folders));

  /** Every folder in tree order, for the pickers, which never collapse. */
  readonly folderTree = $derived<FolderNode[]>(flattenTree(this.folderRoots));

  readonly noteCountByFolder = $derived<Map<string | null, number>>(
    this.#metas.reduce((acc, m) => {
      acc.set(m.folderId, (acc.get(m.folderId) ?? 0) + 1);
      return acc;
    }, new Map<string | null, number>()),
  );

  metaById(id: string): NoteMeta | undefined {
    return this.#metas.find((m) => m.id === id);
  }

  /**
   * The full text of any note, for reading only — nothing is queued or bumped.
   *
   * The open note answers from memory, because the database can be up to one
   * write-scheduler window behind what is on screen. Any other note is read
   * after a flush: the note just switched away from may still be pending.
   */
  async bodyOf(id: string): Promise<string> {
    const pane = this.#paneShowing(id);
    if (pane) return pane.content;
    await this.#scheduler?.flush();
    return (await this.#repo?.loadBody(id)) ?? '';
  }

  // --- writes --------------------------------------------------------------

  /**
   * Mark a record as needing to go to the backend.
   *
   * Not simply `syncStore.engine?.queueNote(id)`. The engine does not exist
   * until sign-in *and* vault unlock *and* the repository have all landed, and
   * an optional call through a missing engine silently does nothing — so a note
   * created in that window never entered the queue at all and never synced,
   * until something happened to touch it again later. That window is wide open
   * exactly when a user is most likely to be typing: right after signing in.
   *
   * The queue is a table in the database, not state inside the engine, so
   * writing to it directly is safe and durable; the engine drains whatever it
   * finds when it starts.
   *
   * Queued with no account too. It used to be skipped, on the grounds that
   * local-only is a supported mode with nothing to drain into — but "nothing
   * to drain into *yet*" was the real situation, and everything written before
   * a sign-in was therefore invisible to sync forever. Cheap to keep: the queue
   * is keyed by id, so it is bounded by how many notes exist, not by how much
   * they are edited, and it is inert for a user who never signs in. Whether the
   * queue may actually *drain* into an account is decided by `app:owner` and
   * key-record ownership in `core/sync/backfill.ts`, not by this.
   */
  #queue(id: string, kind: 'note' | 'folder', immediate = true): void {
    const engine = syncStore.engine;
    const queued = engine
      ? kind === 'note'
        ? engine.queueNote(id, immediate)
        : engine.queueFolder(id, immediate)
      : this.#repo?.enqueue(id, kind);
    // Every write is announced, engine or not — the sibling tabs holding a copy
    // of this list do not care whether anyone is signed in, and a leader tab
    // needs to hear about a write from a tab whose engine has not started yet.
    // After the enqueue, so a leader that syncs on hearing it finds the entry.
    // `#queue` runs on the write-scheduler drain, never per keystroke.
    void Promise.resolve(queued)
      .catch(() => {})
      .then(() => this.#tabs?.post({ type: 'local', immediate }));
  }


  /**
   * The typing path. One assignment and one map write, then return.
   * Everything else happens on the debounce.
   */
  update(id: string, content: string): void {
    // At most four panes: a scan, not a lookup structure.
    //
    // Refuse edits for a note whose body has not finished loading. Without
    // this, an editor mounted against a not-yet-loaded note would persist its
    // empty document over the real text — the exact "notes must never
    // disappear because of an optimization" failure §25 warns about.
    const pane = this.#paneShowing(id);
    if (!pane) return;
    if (pane.content === content) return;

    pane.content = content;
    pane.dirty = true;
    this.#scheduleSave(id, content);
    // Keep a sealed copy current so the teardown handler has ciphertext ready
    // to journal synchronously. Fire-and-forget: the typing path never waits.
    void this.#refreshJournalCipher(pane, id, content);
  }

  /** The pane whose loaded, editable text is `id`'s. */
  #paneShowing(id: string): Pane | undefined {
    return this.#panes.find((p) => p.id === id && p.loadedId === id);
  }

  /**
   * Re-seal a pane's note in the background.
   *
   * A generation counter drops results that a newer keystroke has already
   * superseded, so the journal never regresses to older text.
   */
  async #refreshJournalCipher(pane: Pane, id: string, content: string): Promise<void> {
    if (!vaultStore.isUnlocked) return;
    const generation = ++pane.journalGeneration;
    const revision = this.#revisions.get(id) ?? 1;

    try {
      const cipher = await seal(vaultStore.key(), utf8(content), recordContext('note-body', id));
      if (generation !== pane.journalGeneration) return;
      pane.journalEntry = { id, revision, updatedAt: Date.now(), cipher };
    } catch {
      // A failed seal leaves the previous entry in place, which is stale but
      // still better than nothing.
    }
  }

  #scheduleSave(id: string, content: string): void {
    const meta = this.#metas.find((m) => m.id === id);
    if (!meta) return;

    const revision = (this.#revisions.get(id) ?? 0) + 1;
    this.#revisions.set(id, revision);

    this.#scheduler?.schedule(id, {
      id,
      title: deriveTitle(content),
      folderId: meta.folderId,
      pinnedAt: meta.pinnedAt,
      content,
      updatedAt: Date.now(),
      createdAt: meta.createdAt,
      revision,
    });

    if (!this.#scheduler) this.#saveState = 'saved';
  }

  /**
   * Push a pane's current text into the queue without waiting.
   *
   * A no-op for a note nobody has edited. It used to run unconditionally,
   * which bumped the revision and queued an upload every time the user
   * switched notes, started a note, made a folder or closed the tab — and that
   * is how an untouched welcome note reached the backend and duplicated itself
   * across devices.
   */
  #commitPane(pane: Pane): void {
    if (!pane.dirty) return;
    const id = pane.id;
    if (!id) return;
    this.#scheduleSave(id, pane.content);
    pane.dirty = false;
  }

  /** Show `id` in the focused tile, or focus the tile already showing it. */
  async select(id: string): Promise<void> {
    const at = this.#panes.findIndex((p) => p.id === id);
    if (at !== -1) {
      this.#focused = at;
      this.editorOpen = true;
      return;
    }
    const pane = this.#pane;
    // Make sure the note being left is queued before switching away from it.
    this.#commitPane(pane);
    await this.#openInto(pane, id);
    this.editorOpen = true;
  }

  /** Open `id` in a new tile beside the focused one. See `ui/tiling.ts`. */
  async tile(id: string): Promise<void> {
    if (!this.#metas.some((m) => m.id === id)) return;
    const current = this.#pane;
    if (current.id === null) return this.select(id);

    const plan = planTile(
      this.#panes.map((p) => p.id ?? ''),
      this.#focused,
      id,
    );
    // Already tiled, or the cap is reached: both come down to `select`, which
    // focuses an open note or replaces the focused tile.
    if (plan.ids.length === this.#panes.length) return this.select(id);

    const pane = new Pane();
    const panes = [...this.#panes];
    panes.splice(plan.focused, 0, pane);
    this.#panes = panes;
    this.#focused = plan.focused;
    await this.#openInto(pane, id);
    this.editorOpen = true;
  }

  closePane(index: number): void {
    const pane = this.#panes[index];
    if (!pane || this.#panes.length <= 1) return;
    const plan = planClose(
      this.#panes.map((p) => p.id ?? ''),
      this.#focused,
      index,
    );
    this.#commitPane(pane);
    if (pane.journalEntry) this.#closedJournalEntry = pane.journalEntry;
    this.#panes = this.#panes.filter((p) => p !== pane);
    this.#focused = plan.focused;
    this.#rememberTiles();
  }

  focusPane(index: number): void {
    if (index >= 0 && index < this.#panes.length) this.#focused = index;
  }

  setMode(index: number, mode: ViewMode): void {
    const pane = this.#panes[index];
    if (!pane || pane.mode === mode) return;
    pane.mode = mode;
    this.#rememberTiles();
  }

  #rememberTiles(): void {
    writeOpenTiles(this.#panes.flatMap((p) => (p.id ? [p.id] : [])));
    writeTileModes(modesToStore(this.#panes));
  }

  async #openInto(pane: Pane, id: string): Promise<void> {
    const meta = this.#metas.find((m) => m.id === id);
    if (!meta) return;

    pane.id = id;
    pane.loadedId = null;
    pane.loading = true;
    this.#rememberTiles();
    try {
      const body = (await this.#repo?.loadBody(id)) ?? '';
      // Another note may have been opened in this pane while the read was in
      // flight; dropping a stale result stops it clobbering the newer one.
      if (pane.id !== id) return;
      pane.content = body;
      pane.loadedId = id;
      // Freshly loaded text matches the database by definition.
      pane.dirty = false;
    } catch {
      if (pane.id !== id) return;
      pane.content = '';
      pane.loadedId = id;
      pane.dirty = false;
      this.#warning = { kind: 'write-failed', detail: 'That note could not be read.' };
    } finally {
      if (pane.id === id) pane.loading = false;
    }
  }

  /**
   * Create a note and show it. With `tile` set and two or three tiles open it
   * gets a new tile beside the focused one; otherwise it replaces the focused
   * tile. See `ui/tiling.ts`.
   */
  async create(folderId: string | null = null, options: { tile?: boolean } = {}): Promise<Note> {
    this.#commitPane(this.#pane);
    let pane = this.#pane;
    if (options.tile && createOpensTile(this.#panes.length)) {
      pane = new Pane();
      const at = this.#focused + 1;
      const panes = [...this.#panes];
      panes.splice(at, 0, pane);
      this.#panes = panes;
      this.#focused = at;
    }

    const note = createNote({ folderId });
    this.#revisions.set(note.id, note.revision);
    this.#metas = [toMetaOf(note), ...this.#metas];
    pane.id = note.id;
    pane.content = '';
    pane.loadedId = note.id;
    pane.loading = false;
    // Written to the database below, so the empty document is not an edit.
    pane.dirty = false;
    // A blank note has nothing to preview, and preview would hide the editor
    // the caller is about to focus. The tile's previous mode was its old note's.
    pane.mode = 'edit';
    this.#rememberTiles();
    this.editorOpen = true;

    // Not awaited, for the reason `#persist` gives at its own call: this is a
    // round trip through a permission API that can put a prompt on screen, and
    // the note is in `#metas` and selected but not yet on disk until it
    // resolves. A refresh landing in that window — a sibling tab's write is now
    // enough — would find no such note in the database and move the user off
    // the one they just created.
    void this.#requestPersistenceOnce();
    this.#uncommitted.add(note.id);
    try {
      await this.#repo?.putNote(toPersisted(note));
      this.search.upsert({
        id: note.id,
        title: note.title,
        content: '',
        updatedAt: note.updatedAt,
        folderId: note.folderId,
      });
      this.#queue(note.id, 'note');
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      this.#uncommitted.delete(note.id);
      this.#localEpoch++;
    }
    return note;
  }

  /**
   * Close every tile whose note is gone, whether deleted here on its own, with
   * the folder that held it, or on another device. Shared so the paths cannot
   * drift: leaving a pane pointing at a dropped note is what shows an editor
   * full of text that no longer exists anywhere.
   *
   * If that leaves no tile, the last one is re-homed onto `fallbackIndex` in the
   * list, so the editor is never blank while notes remain.
   */
  async #closeRemoved(gone: (id: string) => boolean, fallbackIndex: number): Promise<void> {
    const survivors = this.#panes.filter((p) => p.id === null || !gone(p.id));
    if (survivors.length === this.#panes.length) return;

    if (survivors.length > 0) {
      const focusedPane = this.#pane;
      let focused = survivors.indexOf(focusedPane);
      if (focused === -1) {
        // The focused tile went: move left, as closing it by hand would.
        const before = this.#panes
          .slice(0, this.#focused)
          .filter((p) => survivors.includes(p)).length;
        focused = Math.max(0, before - 1);
      }
      this.#panes = survivors;
      this.#focused = focused;
      this.#rememberTiles();
      return;
    }

    const pane = this.#pane;
    this.#panes = [pane];
    this.#focused = 0;
    const fallback = this.#metas[Math.min(fallbackIndex, this.#metas.length - 1)];
    if (fallback) {
      await this.#openInto(pane, fallback.id);
      return;
    }
    pane.id = null;
    pane.content = '';
    pane.loadedId = null;
    pane.loading = false;
    pane.dirty = false;
    this.#rememberTiles();
    this.editorOpen = false;
  }

  async remove(id: string): Promise<void> {
    if (!this.#metas.some((m) => m.id === id)) return;

    // Land any pending text first, for two reasons. A save still in the
    // scheduler would otherwise write *after* the tombstone and bring the note
    // back. And the version kept for Recently deleted should hold the last
    // keystroke, not the last debounce.
    const showing = this.#paneShowing(id);
    if (showing) this.#commitPane(showing);
    await this.#scheduler?.flush();
    await this.#captureNow([id], 'delete');

    const index = this.#metas.findIndex((m) => m.id === id);
    if (index === -1) return;

    this.#removing.add(id);
    this.#metas = this.#metas.filter((m) => m.id !== id);
    this.#revisions.delete(id);
    this.search.remove(id);

    await this.#closeRemoved((gone) => gone === id, index);

    try {
      await this.#repo?.deleteNote(id);
      // The tombstone has to reach the other devices, or the note simply
      // reappears on their next push (§16).
      this.#queue(id, 'note');
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      this.#removing.delete(id);
      this.#localEpoch++;
    }
  }

  async moveToFolder(id: string, folderId: string | null): Promise<void> {
    const meta = this.#metas.find((m) => m.id === id);
    if (!meta || meta.folderId === folderId) return;
    await this.#writeMeta(id, { folderId });
  }

  /**
   * Pin or unpin a note. Pinned notes lead every list, newest pin first
   * (`orderForList`).
   *
   * The pin lives in the sealed meta record, so it syncs with the note and
   * costs no extra backend reads. Stamping `updatedAt` is required, not
   * cosmetic — see `withPinned`.
   */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    const meta = this.#metas.find((m) => m.id === id);
    if (!meta || (meta.pinnedAt !== null) === pinned) return;
    await this.#writeMeta(id, { pinnedAt: pinned ? Date.now() : null });
  }

  /**
   * A metadata-only change: shown at once, written after any pending save.
   *
   * The order matters. A save waiting in the scheduler carries a snapshot of
   * the meta taken when it was scheduled, and `putNotes` rewrites the whole
   * meta row from it — so a pin written first was quietly undone by the
   * keystrokes typed just before it, and the stored revision went backwards.
   * Flushing first lands those keystrokes; `#persist` also takes pin and
   * folder from the live list, for a save scheduled while this one waits.
   */
  async #writeMeta(id: string, change: Partial<Pick<NoteMeta, 'folderId' | 'pinnedAt'>>): Promise<void> {
    const now = Date.now();
    // Re-sorted: the stamp moves an unpinned note to the top of the recent list,
    // which is where the user has just been looking at it.
    this.#metas = this.#metas.map((m) => (m.id === id ? { ...m, ...change, updatedAt: now } : m)).sort(byRecency);

    this.#localEpoch++;
    try {
      const showing = this.#paneShowing(id);
      if (showing) this.#commitPane(showing);
      await this.#scheduler?.flush();

      // Re-read: the flush may have moved the title, and the note may be gone.
      const current = this.#metas.find((m) => m.id === id);
      if (!current) return;
      const revision = (this.#revisions.get(id) ?? 0) + 1;
      this.#revisions.set(id, revision);
      await this.#repo?.putNoteMeta({ ...current, revision });
      // The search index scopes `in:` by folder, so a move has to reach it —
      // and it has to reach it as `setFolder`, not `upsert`. There is no body
      // in hand here, and an upsert carrying `content: ''` would take every
      // word of the note out of the index (`SearchIndex.setFolder` says why).
      // Same trap as the sealed excerpt, one field along.
      if ('folderId' in change) this.search.setFolder(id, current.folderId);
      this.#queue(id, 'note');
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      this.#localEpoch++;
    }
  }

  /**
   * The sync engine's `rebaseMeta` hook: this device changed only a note's pin
   * or folder, and another device's write won the compare-and-swap. Returns the
   * remote meta with ours laid over it, or null when there is nothing to keep.
   *
   * Pin and folder come from the local side wholesale — last writer wins, as
   * for folders themselves. A folder that no longer exists here is not
   * restored over the remote's.
   */
  async rebaseMeta(noteId: string, local: Bytes, remote: Bytes): Promise<Bytes | null> {
    const codec = encryptedCodec(() => vaultStore.key());
    const [mine, theirs] = await Promise.all([codec.decodeNoteMeta(noteId, local), codec.decodeNoteMeta(noteId, remote)]);
    const folderId =
      mine.folderId === null || this.#folders.some((f) => f.id === mine.folderId) ? mine.folderId : theirs.folderId;
    if (folderId === theirs.folderId && mine.pinnedAt === theirs.pinnedAt) return null;
    return (await codec.encodeNoteMeta(noteId, { ...theirs, folderId, pinnedAt: mine.pinnedAt })) as Bytes;
  }

  /**
   * Add a folder. Synchronous up to the point the sidebar can show it: the
   * folder is in `#folders` when this returns, and `saved` is the write.
   *
   * A new note appears the instant it is made; a folder that waited on
   * encryption and IndexedDB before the caller could select it did not.
   * Failures are reported through `#onWriteError`, so nobody has to await `saved`.
   */
  addFolder(name: string, parentId: string | null = null): { folder: Folder; saved: Promise<void> } {
    const folder = createFolder(name, parentId);
    this.#folders = [...this.#folders, folder];
    this.#uncommitted.add(folder.id);
    const saved = (async () => {
      try {
        await this.#repo?.putFolder(folder);
        this.#queue(folder.id, 'folder');
      } catch (error) {
        this.#onWriteError(error);
      } finally {
        this.#uncommitted.delete(folder.id);
        this.#localEpoch++;
      }
    })();
    return { folder, saved };
  }

  /**
   * Write an import plan (`core/portability/importTree.ts`) under `intoFolderId`.
   *
   * A bulk path rather than `create()` per file: `create()` opens the note in a
   * tile and does one transaction and one queue write per note, which for a
   * vault of a few thousand files is minutes of flicker. Here notes go down in
   * batches through `putNotes` and `enqueueMany`, and nothing is opened.
   *
   * Folders are matched by name (ignoring case) under the same parent before a
   * new one is made, so importing an export onto a second device — or into an
   * account that already has `Code/` — lands in the existing tree rather than
   * beside a duplicate of it. Notes are never matched: an import only ever adds,
   * so nothing already here can be overwritten (§16).
   *
   * Everything is queued exactly as a local write is, with or without an
   * account; whether it may drain is `core/sync/backfill.ts`'s question.
   */
  async importNotes(
    plan: ImportPlan,
    intoFolderId: string | null,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ notes: number; folders: number; firstNoteId: string | null }> {
    const repo = this.#repo;
    if (!repo) throw new Error('Notes are not open yet.');
    const now = Date.now();

    const folderIds = new Map<string, string>();
    const created: Folder[] = [];
    for (const planned of plan.folders) {
      const parentId = planned.parentKey === null ? intoFolderId : folderIds.get(planned.parentKey)!;
      const name = planned.name.trim().toLowerCase();
      const existing = [...this.#folders, ...created].find(
        (f) => f.parentId === parentId && f.name.trim().toLowerCase() === name,
      );
      if (existing) {
        folderIds.set(planned.key, existing.id);
      } else {
        const folder = createFolder(planned.name, parentId, now);
        created.push(folder);
        folderIds.set(planned.key, folder.id);
      }
    }

    const believable = (t: number | undefined): t is number => t !== undefined && Number.isFinite(t) && t > 0 && t <= now;
    const notes = plan.notes.map((n) => {
      // The file's own date, so an imported library keeps its order — unless
      // the archive carried nothing believable.
      const updated = believable(n.modified) ? n.modified : now;
      const note = createNote({
        content: n.content,
        folderId: n.folderKey === null ? intoFolderId : folderIds.get(n.folderKey)!,
        now: updated,
      });
      // Another app's own created date and pin (`core/portability/sources.ts`);
      // a created date after the last edit is not believable either.
      if (believable(n.created) && n.created <= updated) note.createdAt = n.created;
      if (n.pinned) note.pinnedAt = updated;
      return note;
    });

    const ids = [...created.map((f) => f.id), ...notes.map((n) => n.id)];
    for (const id of ids) this.#uncommitted.add(id);
    try {
      if (created.length > 0) {
        this.#folders = [...this.#folders, ...created];
        for (const folder of created) await repo.putFolder(folder);
        await repo.enqueueMany(created.map((f) => ({ id: f.id, kind: 'folder' as const })));
      }

      const BATCH = 250;
      const bulk = notes.length > BATCH;
      for (let i = 0; i < notes.length; i += BATCH) {
        const batch = notes.slice(i, i + BATCH);
        await repo.putNotes(batch.map(toPersisted));
        await repo.enqueueMany(batch.map((n) => ({ id: n.id, kind: 'note' as const })));
        for (const n of batch) {
          this.#revisions.set(n.id, n.revision);
          if (!bulk) {
            this.search.upsert({
              id: n.id,
              title: n.title,
              content: n.content,
              updatedAt: n.updatedAt,
              folderId: n.folderId,
            });
          }
        }
        this.#metas = [...batch.map(toMetaOf), ...this.#metas].sort(byRecency);
        onProgress?.(Math.min(i + BATCH, notes.length), notes.length);
      }
      // Thousands of worker messages would each re-tokenise; one rebuild reads the store.
      if (bulk) this.#scheduleSearchRebuild();
    } catch (error) {
      this.#onWriteError(error);
      throw error;
    } finally {
      for (const id of ids) this.#uncommitted.delete(id);
      this.#localEpoch++;
    }

    void this.#requestPersistenceOnce();
    this.#tabs?.post({ type: 'local', immediate: true });
    void syncStore.engine?.syncNow();

    return { notes: notes.length, folders: created.length, firstNoteId: notes[0]?.id ?? null };
  }

  /**
   * Every note's text, for export — or only those under `rootFolderId`.
   *
   * One flush up front rather than `bodyOf` per note, which would flush 10,000
   * times. An open note answers from its pane, which can be one scheduler
   * window ahead of the database.
   */
  async exportSnapshot(
    rootFolderId: string | null = null,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ folders: Folder[]; notes: ExportNote[] }> {
    await this.#scheduler?.flush();
    const folders = [...this.#folders];
    const inScope = rootFolderId ? new Set(subtreeIds(folders, rootFolderId)) : null;
    const metas = this.#metas.filter((m) => !inScope || (m.folderId !== null && inScope.has(m.folderId)));

    const notes: ExportNote[] = [];
    for (const [i, meta] of metas.entries()) {
      const pane = this.#paneShowing(meta.id);
      const content = pane ? pane.content : ((await this.#repo?.loadBody(meta.id)) ?? '');
      notes.push({ ...meta, content });
      if (i % 100 === 99) onProgress?.(i + 1, metas.length);
    }
    onProgress?.(metas.length, metas.length);
    return { folders, notes };
  }

  /**
   * Rename a folder.
   *
   * `updatedAt` advances because it is the only ordering a folder has — there
   * is no revision and no compare-and-swap on the folder collection, so the
   * receiving device decides between its copy and this one by timestamp alone.
   * A rename that did not move it would be indistinguishable from a stale
   * copy and would simply be ignored on the other device.
   */
  async renameFolder(id: string, name: string): Promise<void> {
    const folder = this.#folders.find((f) => f.id === id);
    const trimmed = name.trim();
    if (!folder || !trimmed || trimmed === folder.name) return;

    const updated: Folder = { ...folder, name: trimmed, updatedAt: Date.now() };
    this.#folders = this.#folders.map((f) => (f.id === id ? updated : f));

    try {
      await this.#repo?.putFolder(updated);
      this.#queue(id, 'folder');
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      this.#localEpoch++;
    }
  }

  /**
   * Move a folder, and everything inside it, under `parentId` (null is the
   * top level).
   *
   * Refused when the target is inside the folder's own subtree: that is the
   * one move that would make a cycle. `updatedAt` advances for the reason
   * `renameFolder` gives — it is the only ordering another device has.
   */
  async moveFolder(id: string, parentId: string | null): Promise<void> {
    const folder = this.#folders.find((f) => f.id === id);
    if (!folder || folder.parentId === parentId) return;
    if (!canMoveFolder(this.#folders, id, parentId)) return;

    const updated: Folder = { ...folder, parentId, updatedAt: Date.now() };
    this.#folders = this.#folders.map((f) => (f.id === id ? updated : f));

    try {
      await this.#repo?.putFolder(updated);
      this.#queue(id, 'folder');
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      this.#localEpoch++;
    }
  }

  /** What deleting `id` would take with it, not counting the folder itself. */
  folderContents(id: string): { folders: number; notes: number } {
    const doomed = new Set(subtreeIds(this.#folders, id));
    if (doomed.size === 0) return { folders: 0, notes: 0 };
    return {
      folders: doomed.size - 1,
      notes: this.#metas.filter((m) => m.folderId !== null && doomed.has(m.folderId)).length,
    };
  }

  /**
   * Delete a folder with everything inside it — subfolders and notes alike.
   *
   * A folder is what the user sees the notes *in*, so emptying it onto the
   * root would leave them holding a pile of loose notes they thought they had
   * thrown away. §25 forbids losing data silently, not deleting it on request:
   * the caller warns with the counts from `folderContents` first, and those
   * counts come from the same traversal used here so the two cannot disagree.
   *
   * Every tombstone has to be queued. A folder deleted locally but never
   * pushed simply comes back on the next pull, taking its notes with it (§16).
   */
  async removeFolder(id: string): Promise<void> {
    const doomed = new Set(subtreeIds(this.#folders, id));
    if (doomed.size === 0) return;

    // Pending text lands, and every note's final text is kept, before anything
    // disappears — for the reasons `remove` gives.
    for (const pane of this.#panes) {
      const meta = pane.id ? this.#metas.find((m) => m.id === pane.id) : undefined;
      if (meta?.folderId && doomed.has(meta.folderId)) this.#commitPane(pane);
    }
    await this.#scheduler?.flush();
    const victims = this.#metas.filter((m) => m.folderId !== null && doomed.has(m.folderId));
    const victimIds = new Set(victims.map((m) => m.id));
    await this.#captureNow([...victimIds], 'delete');
    const selectedId = this.selectedId;
    // Where the focused note sat once the other victims above it are gone, so
    // the fallback lands next to where the user was rather than at the end of
    // the list. `remove()` drops one note and can pass its index straight through.
    const selectedIndex = this.#metas
      .slice(0, Math.max(0, this.#metas.findIndex((m) => m.id === selectedId)))
      .filter((m) => m.folderId === null || !doomed.has(m.folderId)).length;

    for (const removed of [...victimIds, ...doomed]) this.#removing.add(removed);
    this.#metas = this.#metas.filter((m) => m.folderId === null || !doomed.has(m.folderId));
    this.#folders = this.#folders.filter((f) => !doomed.has(f.id));
    for (const meta of victims) {
      this.#revisions.delete(meta.id);
      this.search.remove(meta.id);
    }

    await this.#closeRemoved((id) => victimIds.has(id), selectedIndex);

    try {
      for (const meta of victims) {
        await this.#repo?.deleteNote(meta.id);
        this.#queue(meta.id, 'note');
      }
      // One clock for the whole subtree: these tombstones describe a single
      // user action, and giving them separate timestamps would let another
      // device order them against each other for no reason.
      const at = Date.now();
      for (const folderId of doomed) {
        await this.#repo?.deleteFolder(folderId, at);
        this.#queue(folderId, 'folder');
      }
    } catch (error) {
      this.#onWriteError(error);
    } finally {
      for (const removed of [...victimIds, ...doomed]) this.#removing.delete(removed);
      this.#localEpoch++;
    }
  }

  /**
   * Reload metadata after the sync engine wrote remote changes underneath us.
   *
   * The engine stores ciphertext directly, so the in-memory view is stale
   * until this runs. Deliberately cheap: metadata only, and the open note's
   * body is refetched only if that note actually changed.
   */
  /**
   * Re-read the note list from the database.
   *
   * @param source who moved the database underneath us. `'remote'` is a pull
   * landing — rare, and worth paying for in full. `'sibling'` is another tab in
   * this browser writing, which happens as often as that tab's user pauses
   * typing, and is therefore held to a much tighter budget: no search rebuild,
   * and no reopening a note this tab's user is in the middle of.
   */
  async refreshFromStore(source: 'remote' | 'sibling' = 'remote'): Promise<void> {
    if (!this.#repo || !this.#initialized) return;

    // Remote notes are written as ciphertext straight into the store, so the
    // search index knows nothing about them — it is only fed by local writes.
    // Without this a synced note is invisible to Cmd+P until the next reload.
    // Debounced, because a burst of remote changes should cost one rebuild.
    //
    // Not on the sibling path. A rebuild is the most expensive thing this app
    // does — Spike 3 measures 443 ms, reading and decrypting every body — and
    // its own 500 ms debounce is no protection against a stream arriving once a
    // second: it would expire cleanly between each one and burn a full rebuild
    // per second, in every open tab, because somebody is typing in one of them.
    // The flag defers it to a moment when it can possibly matter instead.
    if (source === 'remote') this.#scheduleSearchRebuild();
    else this.#searchStale = true;

    // Re-read if a local structural write committed while the read was in
    // flight: the result predates it, and assigning it would undo the write on
    // screen — a folder just added disappearing until the next refresh. Bounded,
    // because a steady stream of local writes must not stall the refresh.
    let metas: Awaited<ReturnType<NoteRepository['loadAllMeta']>>;
    let folders: Folder[];
    for (let attempt = 0; ; attempt++) {
      const epoch = this.#localEpoch;
      [metas, folders] = await Promise.all([this.#repo.loadAllMeta(), this.#repo.loadFolders()]);
      if (epoch === this.#localEpoch || attempt === 2) break;
    }

    // A read that finished before a delete committed still holds the record.
    // Assigning it would bring the note back as an empty row; see `#removing`.
    if (this.#removing.size > 0) {
      metas = metas.filter((m) => !this.#removing.has(m.id));
      folders = folders.filter((f) => !this.#removing.has(f.id));
    }

    // A read that finished before a write committed cannot see it at all.
    // Keep what is still on its way to disk rather than dropping it.
    if (this.#uncommitted.size > 0) {
      const loadedFolders = new Set(folders.map((f) => f.id));
      folders = [...folders, ...this.#folders.filter((f) => this.#uncommitted.has(f.id) && !loadedFolders.has(f.id))];
      const loadedNotes = new Set(metas.map((m) => m.id));
      const pending = this.#metas
        .filter((m) => this.#uncommitted.has(m.id) && !loadedNotes.has(m.id))
        .map((m) => ({ ...m, revision: this.#revisions.get(m.id) ?? 1 }));
      metas = [...pending, ...metas];
    }

    // What each tile showed, and at which revision, before the reload.
    const before = new Map(
      this.#panes.map((p) => [p, { id: p.id, revision: p.id ? this.#revisions.get(p.id) : undefined }]),
    );

    this.#metas = metas.map(({ revision, ...meta }) => {
      // `Math.max`, not a plain set. `#scheduleSave` advances this counter when
      // it *schedules* a write, so while a save is pending the in-memory value
      // is legitimately ahead of what is on disk — and the guard further down
      // that knows about pending saves comes after this line, too late to help.
      // Lowering it here makes the next save re-issue a revision number that
      // has already been written with different text, and `applyRemoteNote`
      // states why that is not survivable: the crash journal and the editor's
      // "has this note changed" check both read it, and both break if it can go
      // backwards. A genuinely newer remote revision still wins the comparison.
      this.#revisions.set(meta.id, Math.max(revision, this.#revisions.get(meta.id) ?? 0));
      return meta;
    });
    this.#folders = folders;

    if (this.#panes.every((p) => p.id === null)) {
      // Nothing was open because there was nothing to open — a fresh device
      // waiting for its first pull. Now that notes have arrived, show one:
      // §6 wants a note available immediately, and leaving the editor pane
      // empty next to a populated list reads as the app being broken.
      const first = this.#metas[0];
      if (first) await this.#openInto(this.#pane, first.id);
      return;
    }

    // Deleted on another device while open here. Close those tiles, or move the
    // last one to whatever remains rather than leaving it pointed at nothing.
    const live = new Set(this.#metas.map((m) => m.id));
    await this.#closeRemoved((id) => !live.has(id) && !this.#uncommitted.has(id), 0);

    // Only rewrite an open document if the remote revision actually moved,
    // so a sync landing elsewhere never disturbs what the user is typing.
    //
    // And not at all while a save is still pending: the in-memory counter has
    // already advanced past what is on disk, so the comparison would fire on
    // this device's own unflushed typing and reload older text over it.
    if (this.#scheduler?.pending) return;
    // And never on the sibling path while this tab's user has been working in
    // the note. `#openInto` re-docs the editor and takes the caret with it, and
    // "the same note open in two tabs" is a thing people do deliberately —
    // without this, the two tabs pull the document back and forth between them
    // every time either one pauses. A remote device's edit still wins, because
    // that is a different machine and §16 says it must be seen.
    for (const pane of this.#panes) {
      const was = before.get(pane);
      // A pane re-homed by `#closeRemoved` has just been loaded fresh.
      if (!pane.id || was?.id !== pane.id) continue;
      if (source === 'sibling' && pane.dirty) continue;
      const nextRevision = this.#revisions.get(pane.id);
      if (nextRevision !== undefined && nextRevision !== was.revision) {
        await this.#openInto(pane, pane.id);
      }
    }
  }

  /**
   * Rebuild the search index if a sibling tab's writes have left it stale.
   *
   * Called where staleness starts to cost something — the tab becoming visible,
   * and the next query — rather than on a timer. A tab nobody looks at pays
   * nothing, which is the entire point of not rebuilding on the sibling path.
   */
  settleSearchIndex(): void {
    if (!this.#searchStale) return;
    this.#searchStale = false;
    this.#scheduleSearchRebuild();
  }

  /**
   * Rebuild the search index after remote changes.
   *
   * A full rebuild rather than targeted upserts: the engine writes ciphertext
   * and does not report which ids changed, and the worker can re-read the
   * store itself. Spike 3 measured the sweep at 443 ms for 10,000 notes, off
   * the main thread, so paying it once per burst of remote changes is cheap
   * next to the alternative of unsearchable notes.
   */
  #scheduleSearchRebuild(): void {
    if (this.#searchRebuildTimer !== undefined) clearTimeout(this.#searchRebuildTimer);
    this.#searchRebuildTimer = setTimeout(() => {
      this.#searchRebuildTimer = undefined;
      if (vaultStore.isUnlocked) this.search.rebuild();
    }, 500);
  }

  /**
   * Preserve the local version of a note the backend refused (§16).
   *
   * Called by the sync engine when the revision compare-and-swap rejects a
   * push: another device got there first. Rather than merge — which §16 warns
   * against — the local text becomes a separate note that pushes cleanly, and
   * the remote version keeps the original id.
   */
  async createConflictCopy(noteId: string, remote?: RemoteNote): Promise<string | null> {
    if (!this.#repo) return null;

    try {
      const content =
        this.#paneShowing(noteId)?.content ?? ((await this.#repo.loadBody(noteId)) ?? '');
      if (!content) return null;

      // Both sides may well say the same thing — a push retried after a lost
      // ack, two devices that made the same edit. A duplicate of text that
      // already matches is worse than useless, so decline. A body that will not
      // decrypt falls through and makes the copy: preserving text twice beats
      // losing it once.
      if (remote?.body !== undefined) {
        try {
          const codec = encryptedCodec(() => vaultStore.key());
          if ((await codec.decodeBody(noteId, remote.body)) === content) return null;
        } catch {
          // Unreadable remote body. Make the copy.
        }
      }

      const meta = this.#metas.find((m) => m.id === noteId);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const copy = createNote({ content, folderId: meta?.folderId ?? null });
      const titled: PersistedNote = {
        id: copy.id,
        title: `${deriveTitle(content)} (conflict copy ${stamp})`,
        folderId: copy.folderId,
        pinnedAt: null,
        content,
        updatedAt: copy.updatedAt,
        createdAt: copy.createdAt,
        revision: 1,
      };

      await this.#repo.putNotes([titled]);
      this.#revisions.set(copy.id, 1);
      this.#metas = [
        {
          id: copy.id,
          title: titled.title,
          folderId: copy.folderId,
          pinnedAt: null,
          updatedAt: copy.updatedAt,
          createdAt: copy.createdAt,
        },
        ...this.#metas,
      ];
      this.search.upsert({
        id: copy.id,
        title: titled.title,
        content,
        updatedAt: copy.updatedAt,
        folderId: copy.folderId,
      });
      return copy.id;
    } catch {
      // Failing to make the copy must not also lose the remote version; the
      // engine continues and the local text stays in the editor.
      return null;
    }
  }

  // --- history -------------------------------------------------------------

  /**
   * The history service, loading it on first use. Null when history cannot run
   * this session — no database, a blocked upgrade, a locked vault at load.
   */
  history(): Promise<HistoryService | null> {
    const repo = this.#repo;
    if (!repo) return Promise.resolve(null);
    this.#history ??= (async () => {
      try {
        const [{ createHistoryService }, { openHistoryStore }] = await Promise.all([
          import('../../core/history/service.ts'),
          import('../../core/history/store.ts'),
        ]);
        const service = createHistoryService({
          store: await openHistoryStore(),
          repo,
          codec: encryptedCodec(() => vaultStore.key()),
          capBytes: await historyCapBytes(),
          withLock: async (task) => {
            if (typeof navigator === 'undefined' || !navigator.locks) return task();
            // Another tab pruning is as good as this one doing it: skip, never queue.
            // Frozen from day one: see docs/security.md § "Frozen identifiers".
            await navigator.locks.request('teksto-history-prune', { ifAvailable: true }, async (lock) => {
              if (lock) await task();
            });
          },
        });
        idle(() => void service.maybePrune().catch(() => {}));
        return service;
      } catch {
        return null;
      }
    })();
    return this.#history;
  }

  async #captureRows(rows: Promise<RawNote[]>, reason: VersionReason): Promise<void> {
    try {
      const history = await this.history();
      await history?.capture(await rows, reason);
    } catch {
      // History is best-effort: a lost version must never read as a lost note.
    }
  }

  #captureNow(ids: readonly string[], reason: VersionReason): Promise<void> {
    if (!this.#repo || ids.length === 0) return Promise.resolve();
    return this.#captureRows(this.#repo.loadRawNotes(ids), reason);
  }

  /**
   * Replace a note's text with an earlier version's.
   *
   * Goes through `update()`, the same path as typing, so the editor adopts it
   * as one change — ⌘Z takes it back — and the save, the journal and the queue
   * all behave as for any edit. The text being replaced is kept as a `restore`
   * version first, so a restore can itself be undone from history later.
   */
  async restoreText(noteId: string, text: string, options: { keepCurrent?: boolean } = {}): Promise<boolean> {
    if (!this.#metas.some((m) => m.id === noteId)) return false;
    await this.select(noteId);
    const pane = this.#paneShowing(noteId);
    if (!pane) return false;

    this.#commitPane(pane);
    await this.#scheduler?.flush();
    if (options.keepCurrent !== false) await this.#captureNow([noteId], 'restore');
    this.update(noteId, text);
    return true;
  }

  /** A version's text as a new note in `folderId` (or the top level if that folder is gone). */
  async restoreAsNewNote(text: string, folderId: string | null): Promise<string | null> {
    const folder = folderId && this.#folders.some((f) => f.id === folderId) ? folderId : null;
    const note = createNote({ content: text, folderId: folder });
    return (await this.#insertNote(toPersisted(note))) ? note.id : null;
  }

  /**
   * Bring a deleted note back from its final version, under its own id.
   *
   * Same id rather than a copy: the backend accepts a tombstone advancing to a
   * live revision like any other write, the note keeps its history, and two
   * devices restoring it at once meet as a conflict whose texts are identical —
   * which `createConflictCopy` declines to duplicate. A copy per device would
   * leave the user with two of it.
   */
  async undelete(noteId: string): Promise<{ restored: boolean; folderGone: boolean }> {
    const repo = this.#repo;
    const history = await this.history();
    const failed = { restored: false, folderGone: false };
    if (!repo || !history) return failed;

    try {
      const raw = await repo.loadRawNote(noteId);
      if (!raw?.deleted) return failed;
      const version = await history.latest(noteId);
      if (!version) return failed;

      const content = await history.decodeBody(version);
      let folderId: string | null = null;
      let pinnedAt: number | null = null;
      let createdAt: number | undefined;
      try {
        ({ folderId, pinnedAt, createdAt } = await history.decodeMeta(version));
      } catch {
        // Unreadable meta: the text is what matters; put it at the top level.
      }
      const folder = folderId && this.#folders.some((f) => f.id === folderId) ? folderId : null;
      const restored = await this.#insertNote({
        id: noteId,
        title: deriveTitle(content),
        folderId: folder,
        // A note comes back as it was, pin included: it is the same note.
        pinnedAt,
        content,
        updatedAt: Date.now(),
        // The same note coming back, so it keeps the date it was created. A
        // version captured before the field existed carries none; its own
        // timestamp is then the best evidence there is, and it is at least not
        // "now", which would make every restored note look brand new.
        createdAt: createdAt ?? version.at,
        revision: raw.revision + 1,
      });
      return { restored, folderGone: restored && folderId !== folder };
    } catch (error) {
      this.#onWriteError(error);
      return failed;
    }
  }

  /**
   * Deleted notes worth offering back, newest first.
   *
   * With a version on this device, always. Without one, only when this device
   * can ask the account — another device may have kept the text — and then
   * `local` is false and the caller fetches before it can restore.
   */
  async recentlyDeleted(): Promise<
    { id: string; title: string; folderId: string | null; deletedAt: number; local: boolean }[]
  > {
    const repo = this.#repo;
    const history = await this.history();
    if (!repo || !history) return [];
    const [tombstones, kept] = await Promise.all([
      repo.loadTombstones(Date.now() - RECENTLY_DELETED_MS),
      history.noteIds(),
    ]);
    const remote = this.remoteHistoryAvailable;
    return tombstones
      .filter((t) => remote || kept.has(t.id))
      .map((t) => ({ id: t.id, title: t.title, folderId: t.folderId, deletedAt: t.updatedAt, local: kept.has(t.id) }));
  }

  /**
   * Whether versions kept by the account's other devices can be read here: an
   * approved account, and a vault that is demonstrably that account's. The same
   * gate as uploading, for the same reason — another account's ciphertext
   * would not open with this key.
   */
  get remoteHistoryAvailable(): boolean {
    return (
      syncStore.signedIn &&
      !syncStore.notApproved &&
      !syncStore.foreignOwner &&
      syncStore.vaultOwnsAccount === true &&
      syncStore.adapter !== undefined
    );
  }

  /** When each note's versions were last fetched, so reopening the panel is free. */
  #versionsFetchedAt = new Map<string, number>();

  /**
   * Fetch a page of a note's versions from the account into local history.
   *
   * On demand only — history is never part of the pull. The newest page is
   * fetched at most once a minute per note; `cursor` asks for an older page.
   */
  async fetchRemoteVersions(
    noteId: string,
    options: { cursor?: SyncCursor; limit?: number; force?: boolean } = {},
  ): Promise<
    | { status: 'fetched'; cursor: SyncCursor; hasMore: boolean }
    | { status: 'cached' | 'unavailable' | 'offline' | 'failed' }
  > {
    const adapter = syncStore.adapter;
    const history = await this.history();
    if (!adapter || !history || !this.remoteHistoryAvailable) return { status: 'unavailable' };

    const newest = options.cursor === undefined;
    const fetchedAt = this.#versionsFetchedAt.get(noteId);
    if (newest && !options.force && fetchedAt !== undefined && Date.now() - fetchedAt < 60_000) {
      return { status: 'cached' };
    }
    try {
      const page = await adapter.listVersions(noteId, options.limit ?? 20, options.cursor);
      await history.addRemote(page.versions);
      if (newest) this.#versionsFetchedAt.set(noteId, Date.now());
      return { status: 'fetched', cursor: page.cursor, hasMore: page.hasMore };
    } catch (error) {
      if (error instanceof TransientSyncError) return { status: 'offline' };
      if (error instanceof SyncNotApprovedError) return { status: 'unavailable' };
      return { status: 'failed' };
    }
  }

  async #insertNote(note: PersistedNote): Promise<boolean> {
    if (!this.#repo) return false;
    this.#uncommitted.add(note.id);
    try {
      await this.#repo.putNotes([note]);
      this.#revisions.set(note.id, note.revision);
      this.#metas = [
        {
          id: note.id,
          title: note.title,
          folderId: note.folderId,
          pinnedAt: note.pinnedAt,
          updatedAt: note.updatedAt,
          createdAt: note.createdAt,
        },
        ...this.#metas.filter((m) => m.id !== note.id),
      ].sort(byRecency);
      this.search.upsert({
        id: note.id,
        title: note.title,
        content: note.content,
        updatedAt: note.updatedAt,
        folderId: note.folderId,
      });
      this.#queue(note.id, 'note');
      return true;
    } catch (error) {
      this.#onWriteError(error);
      return false;
    } finally {
      this.#uncommitted.delete(note.id);
      this.#localEpoch++;
    }
  }

  setSaveState(state: SaveState): void {
    this.#saveState = state;
  }

  dismissWarning(): void {
    // One × button, two sources: clear the latched failure if there is one,
    // otherwise silence the derived notice.
    if (this.#warning) this.#warning = null;
    else this.#persistenceNoticeDismissed = true;
  }

  // --- persistence internals ----------------------------------------------

  async #persist(batch: PersistedNote[]): Promise<void> {
    if (!this.#repo) return;

    // Deliberately not awaited: asking for persistent storage is a round trip
    // through a permission API, and on a page's first write that delay lands
    // squarely on the teardown flush — the one write that has no time to
    // spare. The answer changes nothing about how we write, only what we warn.
    void this.#requestPersistenceOnce();

    // Keep the text this save replaces when it starts a new editing session
    // (`core/history/policy.ts`). The read is issued before `putNotes` and not
    // awaited: IndexedDB runs it against the rows as they were, and the save
    // does not wait on it.
    const now = Date.now();
    // A save carries the meta as it stood when it was scheduled. Pin and folder
    // may have changed since, and are not the typing path's to write — take
    // them from the live list, or this save undoes a pin made a moment ago.
    batch = batch.map((note) => {
      const live = this.#metas.find((m) => m.id === note.id);
      return live && (live.folderId !== note.folderId || live.pinnedAt !== note.pinnedAt)
        ? { ...note, folderId: live.folderId, pinnedAt: live.pinnedAt }
        : note;
    });
    const keep = batch.filter((note) => this.#captureTracker.observe(note.id, now)).map((note) => note.id);
    const before = keep.length > 0 ? this.#repo.loadRawNotes(keep).catch(() => []) : undefined;

    await this.#repo.putNotes(batch);
    if (before) void this.#captureRows(before, 'edit');

    // Refresh list metadata on the debounce, not per keystroke: the sidebar
    // stays still while the user types and updates once they pause.
    const byId = new Map(batch.map((n) => [n.id, n]));
    let changed = false;
    const next = this.#metas.map((meta) => {
      const written = byId.get(meta.id);
      if (!written) return meta;
      if (written.title === meta.title && written.updatedAt === meta.updatedAt) return meta;
      changed = true;
      // The excerpt is refreshed on the same debounce as the title, and from
      // the same text, so the list's two lines can never describe different
      // versions of the note.
      return {
        ...meta,
        title: written.title,
        updatedAt: written.updatedAt,
        excerpt: excerptOf(written.content),
      };
    });
    if (changed) this.#metas = next.sort(byRecency);

    for (const note of batch) {
      this.search.upsert({
        id: note.id,
        title: note.title,
        content: note.content,
        updatedAt: note.updatedAt,
        folderId: note.folderId,
      });
      // Queue after the local write, never before: the queue must only ever
      // reference something that is already durable here.
      //
      // The one non-immediate caller. This runs on the write debounce, which
      // means several times a second while someone types, and the sync engine's
      // idle timer is what turns that stream into one push per pause.
      this.#queue(note.id, 'note', false);
    }

    // The database now holds everything the journal was insuring against.
    if (!this.#scheduler?.pending) clearJournal();
  }

  /**
   * Ask for persistent storage the first time we actually write something.
   * Asking at startup would prompt before the user has any stake in the answer.
   */
  async #checkPersistence(): Promise<void> {
    const durability = await checkPersisted();
    // A write-time request that has started owns the answer: `persist()` may
    // be granting right now, and this older reading would undo it.
    if (this.#askedForPersistence) return;
    this.#durability = durability;
    this.#durabilityKnown = true;
  }

  /**
   * Ask for durable storage because the reader pressed the button.
   *
   * Deliberately outside the `#askedForPersistence` latch that guards the
   * write-time request: that latch exists so the app asks *at most once on
   * its own*, and this is not the app asking. It still sets the latch, so a
   * `checkPersisted()` still in flight cannot come back and overwrite a grant
   * with the reading it took before it.
   *
   * The caller needs the answer, not just the state change: Firefox does not
   * re-prompt a permission already refused, so a `'best-effort'` here means
   * "silently impossible" and the banner has directions for that case.
   */
  async requestPersistenceNow(): Promise<StorageDurability> {
    this.#askedForPersistence = true;
    const durability = await requestPersistence();
    this.#durability = durability;
    this.#durabilityKnown = true;
    return durability;
  }

  async #requestPersistenceOnce(): Promise<void> {
    if (this.#askedForPersistence) return;
    this.#askedForPersistence = true;

    // Honest framing: the browser may evict this data (plan issue #6). The
    // notice itself is left to `warning`, which can also see whether sync has
    // since made that eviction survivable.
    const durability = await requestPersistence();
    this.#durability = durability;
    this.#durabilityKnown = true;
  }

  #onWriteError(error: unknown): void {
    if (isQuotaExceeded(error)) {
      this.#warning = {
        kind: 'quota',
        detail: 'Storage is full. Delete some notes to free space — nothing has been lost.',
      };
    } else {
      this.#warning = {
        kind: 'write-failed',
        detail: 'A note could not be saved locally. It is still queued and will be retried.',
      };
    }
  }
}

function toMetaOf(note: Note): NoteMeta {
  return {
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    pinnedAt: note.pinnedAt,
    updatedAt: note.updatedAt,
    createdAt: note.createdAt,
    excerpt: excerptOf(note.content),
  };
}

function toPersisted(note: Note): PersistedNote {
  return {
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    pinnedAt: note.pinnedAt,
    content: note.content,
    updatedAt: note.updatedAt,
    createdAt: note.createdAt,
    revision: note.revision,
  };
}

/** How long Recently deleted offers a note back: the delete version's tier. */
const RECENTLY_DELETED_MS = 30 * 24 * 60 * 60_000;

/** Versions may use 5 % of the origin's quota, and never more than 50 MB. */
async function historyCapBytes(): Promise<number> {
  const ceiling = 50 * 1024 * 1024;
  try {
    const quota = (await navigator.storage?.estimate?.())?.quota;
    return quota ? Math.min(ceiling, quota * 0.05) : ceiling;
  } catch {
    return ceiling;
  }
}

function idle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 10_000 });
  else setTimeout(task, 2_000);
}

export const workspace = new Workspace();
