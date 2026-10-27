<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Sidebar from './Sidebar.svelte';
  import NoteList from './NoteList.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import RowActions, { type RowAction } from './RowActions.svelte';
  import StatusBar from './StatusBar.svelte';
  import QuickFinder from './QuickFinder.svelte';
  import Unlock from './Unlock.svelte';
  import type { AccountVault } from './accountVault.ts';
  import type { AccessoryId } from '../editor/accessoryKeys.ts';
  import Account from './Account.svelte';
  import SyncIndicator from './SyncIndicator.svelte';
  import { workspace } from './state/workspace.svelte.ts';
  import { vaultStore } from './state/vault.svelte.ts';
  import { syncStore } from './state/sync.svelte.ts';
  import type { KeyDocument, SyncAdapter, VaultResetFailure } from '../core/sync/adapter.ts';
  import { SyncNotApprovedError, VaultResetError } from '../core/sync/adapter.ts';
  import { install } from './state/install.svelte.ts';
  import { updateStore } from './state/update.svelte.ts';
  import { INSTALL_STEPS } from './install.ts';
  import { filterForList, notesMatching, pinnedCount } from '../core/notes/model.ts';
  import type { NoteLink } from '../core/notes/links.ts';
  import { mediaQuery, MOBILE_QUERY } from './state/media.svelte.ts';
  import { spellcheck } from './state/spellcheck.svelte.ts';
  import { noteSort } from './state/noteSort.svelte.ts';
  import { NOTE_SORT_KEYS, SORT_LABELS, directionLabel } from './noteSort.ts';
  import { textSize } from './state/textSize.svelte.ts';
  import { TEXT_SIZES, DEFAULT_TEXT_SIZE } from './textSize.ts';
  import { lineWrap } from './state/lineWrap.svelte.ts';
  import { LINE_WRAP_CHOICES, lineWrapLabel } from './lineWrap.ts';
  import { theme } from './state/theme.svelte.ts';
  import { editorFont } from './state/editorFont.svelte.ts';
  import { FONT_CHOICES, FONT_LABELS } from './editorFont.ts';
  import { tiling } from './state/tiling.svelte.ts';
  import { focusMode } from './state/focusMode.svelte.ts';
  import { showStatusBar } from './focusMode.ts';
  import { folderTree } from './state/folderTree.svelte.ts';
  import { ancestorIds, canMoveFolder, folderPath, subtreeIds } from '../core/notes/folders.ts';
  import { drag } from './state/drag.svelte.ts';
  import { effectiveViewMode, nextViewMode, type ViewMode } from './viewMode.ts';
  import { countWords } from '../core/notes/text.ts';
  import { tagMatches, tagTree } from '../core/notes/tags.ts';
  import { firstRunReady } from '../core/notes/firstRun.ts';
  import {
    accountResetElsewhere,
    accountWasReset,
    classifyVault,
    keyRecordIsStale,
    KEY_RECORD_DIRTY_KEY,
    VAULT_ACCOUNT_KEY,
    VAULT_RETIRED_KEY,
  } from '../core/sync/backfill.ts';
  import type {
    RepublishOutcome,
    VaultSecretAction,
    VaultSecretResult,
    VaultSecretsMode,
  } from './vaultSecrets.ts';
  import { clearDevicePreferences } from '../core/repo/deviceData.ts';
  import { backupReminderDue, snoozeBackupReminder } from './backupReminder.ts';
  import { sameKeyRecord } from '../core/crypto/keyRecord.ts';
  import type { NoteRepository } from '../core/repo/noteRepository.ts';
  import type { PaletteCommand } from './QuickFinder.svelte';
  import type { ImportSource } from './portability.ts';
  import {
    COMMANDS,
    formatChord,
    formatLeader,
    hint,
    isModifierKey,
    keysFor,
    matchChord,
    matchLeader,
  } from './shortcuts.ts';

  const mobile = mediaQuery(MOBILE_QUERY);

  /**
   * The one-time "this device only" notice.
   *
   * A user with no account is not in an error state and must not be nagged, so
   * this is dismissible and the dismissal sticks. localStorage rather than the
   * repository because it is a UI preference, not data worth encrypting, and
   * the journal already establishes localStorage as somewhere we write.
   */
  // Frozen at the original name: see docs/security.md § "Frozen identifiers".
  const LOCAL_ONLY_NOTICE_KEY = 'teksto:local-only-notice-dismissed';

  let localOnlyDismissed = $state(readDismissed());

  function readDismissed(): boolean {
    try {
      return localStorage.getItem(LOCAL_ONLY_NOTICE_KEY) === '1';
    } catch {
      // Private mode with storage blocked. Showing the notice is the safe
      // default; it is one line of text.
      return false;
    }
  }

  function dismissLocalOnly(): void {
    localOnlyDismissed = true;
    try {
      localStorage.setItem(LOCAL_ONLY_NOTICE_KEY, '1');
    } catch {
      // Nothing to do — it reappears next launch, which is harmless.
    }
  }

  const showLocalOnlyNotice = $derived(
    syncStore.available &&
      !syncStore.signedIn &&
      // Signed out for a lapsed plan has its own banner, saying why.
      !syncStore.planLapsed &&
      !localOnlyDismissed &&
      // The durability banner says "this device only" more urgently, with
      // its own actions; two banners saying it is one too many.
      workspace.warning?.kind !== 'not-persistent',
  );

  /*
   * The backup reminder (`backupReminder.ts`): a device that does not sync
   * holds the only copy, persistent storage or not, so every 30 days it is
   * asked to export. A syncing device is asked too, in other words: sync is a
   * second copy, not a backup — a bad edit or a lost vault reaches every
   * device — and the terms (§9) tell the user so. Read once per unlock — the
   * clock runs in days, not keystrokes — and re-read when the export dialog
   * closes. Not at startup: reading starts the clock, and a locked or freshly
   * wiped device should leave nothing behind.
   */
  let backupDue = $state(false);
  $effect(() => {
    if (vaultReady) backupDue = untrack(() => backupReminderDue());
  });

  function snoozeBackup(): void {
    snoozeBackupReminder();
    backupDue = false;
  }

  const showBackupReminder = $derived(
    backupDue &&
      workspace.metas.length > 0 &&
      !syncStore.planLapsed &&
      // The durability banner already offers Export, more urgently.
      workspace.warning?.kind !== 'not-persistent' &&
      !showLocalOnlyNotice,
  );

  /** Directions shown inline, for a hint whose action cannot be taken here. */
  let installStepsShown = $state(false);

  /**
   * The banner's first action, which is not the same action everywhere.
   *
   * Chromium can be asked to install. Safari can only be told where the menu
   * item is. Firefox cannot install at all — but it is the one browser that
   * *prompts* for durable storage, which is what installing was a proxy for,
   * so there the button asks for that instead. It can still come back
   * refused, silently, because a permission already denied is not re-asked;
   * that is the one case where this hint falls back to directions too.
   */
  async function installApp(): Promise<void> {
    if (install.hint === 'prompt') {
      await install.prompt();
      return;
    }
    if (install.hint === 'firefox') {
      const durability = await workspace.requestPersistenceNow();
      // Granted, and `warning` derives from durability, so the banner goes.
      installStepsShown = durability !== 'persistent';
      return;
    }
    installStepsShown = !installStepsShown;
  }

  // What the note list shows: every note, one folder, or one tag. A tag and a
  // folder never filter together; `showFolder` and `showTag` keep it so.
  let activeFolderId = $state<string | null>(null);
  let activeTag = $state<string | null>(null);
  /** Notes carrying `activeTag`, as the search index last reported. */
  let tagNoteIds = $state.raw<ReadonlySet<string> | null>(null);

  /** For the editor's `#` completion: read when the list opens, never per keystroke. */
  const tagSource = () => workspace.search.tags;

  /** The same, for the editor's `[[` completion. Recency order is the tie-break. */
  const titleSource = () => workspace.metas;

  /**
   * Tags as the folder picker's rows, so ⌘J ⇧T reuses the dialog ⌘J O already
   * uses. A tag has no children of its own to expand — `tagTree` only decides
   * how deep each row sits — so the tree is flat and the nesting is the indent.
   */
  const tagPickerRows = $derived(
    tagTree(workspace.search.tags).map((row) => ({
      id: row.tag.key,
      name: `#${row.name}`,
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      depth: row.depth,
      children: [],
      hasChildren: false,
    })),
  );

  const tagPickerCounts = $derived(
    new Map<string | null, number>(workspace.search.tags.map((t) => [t.key as string | null, t.count])),
  );

  function showFolder(id: string | null): void {
    activeFolderId = id;
    activeTag = null;
  }

  function showTag(key: string): void {
    activeFolderId = null;
    // Blank for the moment the index takes to answer, rather than the previous
    // tag's notes under the new tag's name.
    if (activeTag !== key) tagNoteIds = null;
    activeTag = key;
    if (mobile.matches) workspace.editorOpen = false;
  }

  // Ask the index which notes carry the tag, again whenever tags change —
  // a note gaining or losing it moves the version.
  $effect(() => {
    const tag = activeTag;
    void workspace.search.tagVersion;
    if (tag === null) {
      tagNoteIds = null;
      return;
    }
    let cancelled = false;
    void workspace.search.tagIds(tag).then((ids) => {
      if (!cancelled) tagNoteIds = new Set(ids);
    });
    return () => {
      cancelled = true;
    };
  });

  // The last note carrying the tag lost it: an empty list with nothing in the
  // sidebar to click would be a dead end, so go back to all notes.
  $effect(() => {
    const tag = activeTag;
    if (tag !== null && !workspace.search.tags.some((t) => tagMatches(t.key, tag))) showFolder(null);
  });
  let finderOpen = $state(false);
  let finderMode = $state<'notes' | 'beside' | 'commands'>('notes');
  let accountOpen = $state(false);
  let goToFolderOpen = $state(false);
  let goToTagOpen = $state(false);
  let moveNoteId = $state<string | null>(null);
  /**
   * The row whose `⋯` menu is open, and where its button was when it was
   * clicked. The rect travels with the id because `RowActions` anchors to it
   * and a virtualized note row can be gone before anyone could measure again.
   */
  let noteActions = $state<{ id: string; anchor: DOMRect | null } | null>(null);
  let folderActions = $state<{ id: string; anchor: DOMRect } | null>(null);
  /**
   * The sort menu, and where the button that opened it was. Null rather than a
   * boolean because the anchor travels with it, exactly as the row menus'
   * rects do: the sidebar header button is stable, but ⌘J and the palette open
   * the same menu with nothing to anchor to, and that is what `null` means.
   */
  let sortActions = $state<{ anchor: DOMRect | null } | null>(null);
  /** The topbar wrap pill's measure picker, anchored like the sort menu. */
  let wrapActions = $state<{ anchor: DOMRect } | null>(null);
  /** The folder being moved. */
  let moveFolderId = $state<string | null>(null);
  /** Where the keyboard goes when the move picker closes; see `restoreMoveFocus`. */
  let moveReturn: 'row' | 'editor' | 'list' = 'row';
  let sidebarRef = $state<{ focusList: () => void }>();
  /** The note highlighted in the list while it has focus — what ⌘J actions target there. */
  let listActiveId: string | null = null;
  /** One editor per tile, keyed by the pane so a closed tile's ref goes with it. */
  const editorRefs = new WeakMap<
    object,
    {
      focus: () => void;
      topPosition: () => number;
      runAccessory: (id: AccessoryId) => void;
      blurEditor: () => void;
      toggleTaskAt: (at: number) => boolean;
      linkAtCursor: () => NoteLink | null;
    }
  >();
  const previewRefs = new WeakMap<object, { focus: () => void; scrollToSource: (pos: number) => void }>();

  /** The mode a tile actually shows: split is preview on a phone. */
  function modeOf(pane: { mode: ViewMode }): ViewMode {
    return effectiveViewMode(pane.mode, { mobile: mobile.matches });
  }

  /**
   * Focus whatever the focused tile is showing. In preview mode the editor is
   * still mounted, only hidden, so that its undo history and scroll survive.
   * Focusing it there would send keystrokes into text nobody can see.
   */
  function focusEditor(): void {
    const pane = workspace.panes[workspace.focusedIndex];
    if (!pane) return;
    if (modeOf(pane) === 'preview') previewRefs.get(pane)?.focus();
    else editorRefs.get(pane)?.focus();
  }

  /**
   * The `[[link]]` the focused tile's caret sits in, or null.
   *
   * The editor owns the answer because it owns the syntax tree — `App.svelte`
   * holds text, not a parse — so this is the same shape as `toggleTaskAt`: an
   * imperative reach into the tile that is showing.
   */
  function linkAtFocusedCursor(): NoteLink | null {
    const pane = workspace.panes[workspace.focusedIndex];
    return pane ? (editorRefs.get(pane)?.linkAtCursor() ?? null) : null;
  }

  /**
   * The one place the sidebar is toggled, shared by the ⌘J B command and the
   * top-bar button, because the focus move is load-bearing: `showListPane`
   * renders the pane conditionally, so hiding *unmounts* it and focus sitting
   * inside would be dropped on the document, where the next keystroke goes
   * nowhere. Two copies of this would drift.
   */
  function toggleSidebar(): void {
    const hide = !tiling.sidebarHidden;
    tiling.setSidebarHidden(hide);
    if (hide) focusEditor();
  }

  /**
   * Focus mode, ⌘J Y and the control that floats over the focused tile. Same
   * focus move as `toggleSidebar` above and for the same reason: the list pane
   * is rendered conditionally, so entering the mode *unmounts* it and focus
   * sitting inside would be dropped on the document.
   */
  function toggleFocus(): void {
    const on = !focusMode.on;
    focusMode.set(on);
    if (on) focusEditor();
  }

  /**
   * Show the list because the user asked for something that lives in it — a
   * tag, a folder, the list itself. One function rather than the four copies it
   * replaces, because there are now *two* reasons the list can be hidden and a
   * copy that clears only one of them leaves the caller's own command doing
   * nothing.
   *
   * Desktop only, and deliberately silent on a phone rather than swapping the
   * panes: there is no flag to clear there — the list and the editor take turns
   * — and the callers do not agree on whether picking a tag should leave the
   * note you are reading. The two that want that say so themselves.
   */
  function revealList(): void {
    if (mobile.matches) return;
    focusMode.set(false);
    if (tiling.sidebarHidden) tiling.setSidebarHidden(false);
  }

  const VIEW_MODE_LABEL = { edit: 'Editor only', split: 'Editor and preview', preview: 'Preview only' } as const;
  const SWITCH_MODES: readonly ViewMode[] = ['edit', 'split', 'preview'];
  const PHONE_SWITCH_MODES: readonly ViewMode[] = ['edit', 'preview'];

  async function setViewMode(index: number, mode: ViewMode): Promise<void> {
    workspace.focusPane(index);
    workspace.setMode(index, mode);
    const pane = workspace.panes[index];
    if (!pane) return;
    await loadPreview(mode);
    await tick();
    if (modeOf(pane) === 'split') {
      const top = editorRefs.get(pane)?.topPosition();
      if (top !== undefined) previewRefs.get(pane)?.scrollToSource(top);
    }
    focusEditor();
  }

  /**
   * The preview is its own chunk (§28): someone who never leaves edit mode
   * never downloads it. A tile restored in preview mode fetches it on start.
   */
  let PreviewComponent = $state<typeof import('./Preview.svelte').default | null>(null);
  let previewLoad: Promise<void> | undefined;

  function loadPreview(mode: ViewMode): Promise<void> {
    if (mode === 'edit') return Promise.resolve();
    previewLoad ??= import('./Preview.svelte').then((module) => {
      PreviewComponent = module.default;
    });
    return previewLoad;
  }

  $effect(() => {
    for (const pane of workspace.panes) void loadPreview(pane.mode);
  });

  /**
   * The phone chrome (`src/ui/mobile/`), as one lazy chunk.
   *
   * Started at module scope rather than from an effect: the import runs while
   * the vault check is still in IndexedDB — and, for a returning user, while
   * the key is unwrapped — so by the time `.app` renders there are hundreds of
   * milliseconds of cover and no blank bar. The effect below is the
   * correctness half, for a window resized across the breakpoint.
   *
   * The `catch` is load-bearing. `void promise` does not swallow a rejection,
   * and `bench/mobile.mjs` fails on any unhandled rejection.
   */
  let PhoneChrome = $state<typeof import('./mobile/index.ts') | null>(null);
  let phoneLoad: Promise<void> | undefined;

  function loadPhoneChrome(): Promise<void> {
    phoneLoad ??= import('./mobile/index.ts')
      .then((module) => {
        PhoneChrome = module;
      })
      .catch(() => {
        // Let a later attempt retry rather than caching the failure forever.
        phoneLoad = undefined;
      });
    return phoneLoad;
  }

  if (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches) {
    void loadPhoneChrome();
  }

  $effect(() => {
    if (mobile.matches) void loadPhoneChrome();
  });

  /** The phone's list, which stands in for the sidebar that is not mounted. */
  let phoneListRef = $state<{ focusList: () => void }>();

  /**
   * Put the keyboard on whichever note list exists.
   *
   * On a phone `<Sidebar>` is not mounted, so `sidebarRef` is undefined and
   * every `sidebarRef?.focusList()` would silently no-op — ⌘J L would change
   * screen but never move the highlight, and `listActiveId` would stay null,
   * which is what `targetNoteId()` reads to decide which note Delete takes.
   */
  function focusNoteList(): void {
    (sidebarRef ?? phoneListRef)?.focusList();
  }

  /**
   * The phone row is three lines instead of two, so it is 70px rather than 44.
   * The number is here, not in CSS: the virtual window is arithmetic over it
   * (`NoteList` hands the same value to CSS through `--row-h`).
   */
  const PHONE_ROW_HEIGHT = 70;

  /**
   * The phone's list, filtered the way the sidebar filters its own — same
   * function, so the two can never disagree about what a filter means.
   */
  const visibleNotes = $derived(
    filterForList(workspace.metas, { activeTag, tagNoteIds, activeFolderId, sort: noteSort.current }),
  );
  const visiblePinnedCount = $derived(pinnedCount(visibleNotes));

  /** Folder id → name, for the phone row's meta line. */
  const folderNames = $derived.by(() => {
    const map = new Map<string, string>();
    for (const folder of workspace.folders) map.set(folder.id, folder.name);
    return map;
  });

  /** What the phone header's filter button says, and so what the list shows. */
  const phoneFilterLabel = $derived.by(() => {
    if (activeTag !== null) {
      const tag = workspace.search.tags.find((t) => t.key === activeTag);
      return `#${tag?.label ?? activeTag}`;
    }
    if (activeFolderId === null) return 'All notes';
    return workspace.folders.find((f) => f.id === activeFolderId)?.name ?? 'All notes';
  });

  /** The view mode of the tile the phone is showing — never 'split' there. */
  const focusedMode = $derived.by(() => {
    const pane = workspace.panes[workspace.focusedIndex];
    return pane ? modeOf(pane) : ('edit' as ViewMode);
  });

  /**
   * The note `⋯` on the phone's editor header. It opens the same menu the list
   * row opens, on the open note — with no anchor, because there is no row to
   * measure and the phone sheet is centred anyway.
   */
  function openNoteMenuForOpenNote(): void {
    const id = workspace.selectedId;
    if (!id) return;
    menuRow = { kind: 'note', id };
    noteActions = { id, anchor: null };
  }

  /**
   * Whether the phone's editor holds the keyboard, which is the only time the
   * key bar should exist. Tracked with focusin/focusout on the shell rather
   * than from `Editor.svelte`, because the bar's own buttons must not count as
   * losing focus — they `preventDefault` on pointerdown, so focus never
   * actually leaves the editor, but the events still pass through here.
   */
  let editorFocused = $state(false);

  $effect(() => {
    if (!mobile.matches || !workspace.editorOpen) editorFocused = false;
  });

  /**
   * Publish `--kb-inset` only while the phone key bar is up. On Android it
   * measures 0 and nothing moves; on iOS it is how the bar clears the
   * keyboard at all. See `mobile/keyboardInset.ts` for why it is safe to have
   * on the typing path.
   */
  $effect(() => {
    if (!mobile.matches || !editorFocused || !PhoneChrome) return;
    return PhoneChrome.trackKeyboardInset();
  });

  /** The key bar takes the tab bar's place while the note has the keyboard. */
  const keyBarUp = $derived(
    mobile.matches && workspace.editorOpen && editorFocused && focusedMode !== 'preview',
  );

  let moreSheetOpen = $state(false);

  const moreSheetItems = $derived.by(() => {
    if (!moreSheetOpen || !PhoneChrome) return [];
    const { moreItems, PHONE_MORE_LIST, PHONE_MORE_NOTE } = PhoneChrome;
    return moreItems(workspace.editorOpen ? PHONE_MORE_NOTE : PHONE_MORE_LIST, {
      available,
      run: (id) => void run(id),
      // The one row whose value the phone has nowhere else to show.
      detail: (id) =>
        id === 'appearance'
          ? `${textSize.px} px, ${FONT_LABELS[editorFont.choice]}` +
            (lineWrap.isDefault ? '' : `, ${lineWrap.label.toLowerCase()}`)
          : undefined,
    });
  });

  const tiled = $derived(workspace.panes.length > 1 && !mobile.matches);
  const tiledIds = $derived(
    new Set(workspace.panes.flatMap((p) => (p.id ? [p.id] : []))),
  );

  const LAYOUT_LABEL = {
    vertical: 'Side by side',
    horizontal: 'Stacked',
    grid: '2 × 2 grid',
  } as const;

  /**
   * The editor is the single largest thing we ship, and on a first run the
   * user is looking at a passphrase form that does not need it (§28). It is
   * imported as soon as the app mounts, in parallel with the vault check, so
   * the everyday remembered-device path pays nothing for the split.
   */
  let EditorComponent = $state<typeof import('./Editor.svelte').default | null>(null);

  const selected = $derived(workspace.selectedMeta);

  /**
   * Derived rather than a captured `NoteMeta`: the metas are reactive state, so
   * if a pull tombstones this note while the picker is open the target goes
   * null and the dialog unmounts, instead of sitting there pointed at a note
   * that no longer exists.
   */
  const moveTarget = $derived(moveNoteId ? (workspace.metaById(moveNoteId) ?? null) : null);

  /** Derived for the same reason: a note deleted elsewhere closes its `⋯`. */
  const noteActionsTarget = $derived(
    noteActions ? (workspace.metaById(noteActions.id) ?? null) : null,
  );

  /** Derived for the same reason: a folder deleted elsewhere closes its dialogs. */
  const folderActionsTarget = $derived.by(() => {
    const open = folderActions;
    return open ? (workspace.folders.find((f) => f.id === open.id) ?? null) : null;
  });
  const moveFolderTarget = $derived(
    moveFolderId ? (workspace.folders.find((f) => f.id === moveFolderId) ?? null) : null,
  );

  /**
   * Export and import (§24). The dialog and everything behind it — the zip
   * code, the tree planning — are one lazy chunk, fetched on first use (§28).
   */
  let PortabilityComponent = $state<typeof import('./Portability.svelte').default | null>(null);
  let portabilityOpen = $state(false);
  /** Files from the latest drop or paste, handed to the dialog to stage. */
  let stagedImport = $state<ImportSource | null>(null);
  let fileDragging = $state(false);
  let fileDragDepth = 0;

  function openPortability(source: ImportSource | null = null): void {
    stagedImport = source;
    portabilityOpen = true;
    void import('./Portability.svelte').then((module) => {
      PortabilityComponent = module.default;
    });
  }

  /**
   * "Remove all data from this device".
   *
   * Lazy like the others, and for a sharper reason: it is reachable from the
   * unlock screen, which is the critical path `bench:size` budgets, and the
   * export it offers drags the whole zip chunk behind it.
   */
  let RemoveDataComponent = $state<typeof import('./RemoveData.svelte').default | null>(null);
  let removeDataOpen = $state(false);

  function openRemoveData(): void {
    removeDataOpen = true;
    void import('./RemoveData.svelte').then((module) => {
      RemoveDataComponent = module.default;
    });
  }

  /**
   * "Start over": a signed-in user who has lost both secrets erases the
   * account's synced data, then this device's. Lazy for the same reason as the
   * dialog above. See `StartOver.svelte`.
   */
  let StartOverComponent = $state<typeof import('./StartOver.svelte').default | null>(null);
  let startOverOpen = $state(false);

  function openStartOver(): void {
    startOverOpen = true;
    void import('./StartOver.svelte').then((module) => {
      StartOverComponent = module.default;
    });
  }

  async function eraseAccountVault(password: string): Promise<VaultResetFailure | null> {
    try {
      await syncStore.resetVault(password);
      return null;
    } catch (error) {
      return error instanceof VaultResetError ? error.reason : 'failed';
    }
  }

  /**
   * Note history and Recently deleted. Both dialogs, and the history service
   * behind them, are lazy chunks (§28).
   */
  let HistoryComponent = $state<typeof import('./HistoryPanel.svelte').default | null>(null);
  let DeletedComponent = $state<typeof import('./RecentlyDeleted.svelte').default | null>(null);
  let historyNoteId = $state<string | null>(null);
  let deletedOpen = $state(false);

  function openHistory(noteId: string): void {
    historyNoteId = noteId;
    void import('./HistoryPanel.svelte').then((module) => {
      HistoryComponent = module.default;
    });
  }

  function openRecentlyDeleted(): void {
    deletedOpen = true;
    void import('./RecentlyDeleted.svelte').then((module) => {
      DeletedComponent = module.default;
    });
  }

  /**
   * Share by link, and the list of links already published (§23).
   *
   * Lazy like the others. It also drags the AES envelope's share helpers and
   * the SDK-free reader behind it, none of which a user who never shares
   * anything should pay for (§28).
   */
  let ShareComponent = $state<typeof import('./ShareLink.svelte').default | null>(null);
  let shareOpen = $state(false);
  let shareNoteId = $state<string | null>(null);

  function openShare(noteId: string | null): void {
    shareNoteId = noteId;
    shareOpen = true;
    void import('./ShareLink.svelte').then((module) => {
      ShareComponent = module.default;
    });
  }

  /**
   * How to send text in from another app.
   *
   * Lazy like the rest: instructions somebody reads once should not be in the
   * bytes everybody downloads.
   */
  let QuickCaptureComponent = $state<typeof import('./QuickCapture.svelte').default | null>(null);
  let quickCaptureOpen = $state(false);

  function openQuickCapture(): void {
    quickCaptureOpen = true;
    void import('./QuickCapture.svelte').then((module) => {
      QuickCaptureComponent = module.default;
    });
  }

  /**
   * Change the passphrase, re-issue the recovery code, set a new passphrase
   * from the recovery code, or take a record re-wrapped on another device.
   *
   * Lazy like the rest, and it drags nothing heavy with it: the passphrase
   * generator and its wordlists stay behind the same dynamic import
   * `Unlock.svelte` uses. The stylesheet is not free even so —
   * `bench/size.mjs` charges the CSS of a *dynamically* imported component to
   * the eager budget, because it is still a `<link>` in the document.
   *
   * Mounted outside the `vaultReady` gate, like the remove-data dialog and for
   * the same reason: `reset-passphrase` is reached from the unlock screen and
   * has to render over it.
   */
  let VaultSecretsComponent = $state<typeof import('./VaultSecrets.svelte').default | null>(null);
  let vaultSecretsOpen = $state(false);
  let vaultSecretsMode = $state<VaultSecretsMode>('change-passphrase');

  function openVaultSecrets(mode: VaultSecretsMode): void {
    vaultSecretsMode = mode;
    vaultSecretsOpen = true;
    void import('./VaultSecrets.svelte').then((module) => {
      VaultSecretsComponent = module.default;
    });
  }

  /**
   * A shared link opened in the app rather than in the viewer.
   *
   * The share viewer's "Save to my notes" navigates here with the link in the
   * fragment — the link, deliberately, and never the decrypted text, which
   * would otherwise have to pass through storage in the clear. So this is the
   * same fetch-and-decrypt the viewer does, and the note it creates is an
   * ordinary note from that moment on.
   *
   * The fragment is cleared once the note is saved or the offer is dismissed,
   * and deliberately not before: this navigation *replaced* the viewer tab, so
   * clearing it up front would leave someone whose connection dropped with no
   * way back to the link at all. While the offer stands, reloading retries it;
   * afterwards the address bar holds nobody's key.
   *
   * While the offer stands the shared note is what is on screen
   * (`IncomingShare.svelte`), not a toast over whichever note was open last:
   * asking someone to save a note they cannot see, under a different one, read
   * as the app having opened the wrong note.
   */
  let incomingShare = $state<{ title: string; body: string } | null>(null);
  let incomingBusy = $state(false);
  let IncomingShareComponent = $state<typeof import('./IncomingShare.svelte').default | null>(null);

  async function readIncomingShare(): Promise<void> {
    const { parseFragment } = await import('../core/share/link.ts');
    const ref = parseFragment(window.location.hash);
    if (!ref) return;
    try {
      const [{ openLink }, panel] = await Promise.all([import('./share.ts'), import('./IncomingShare.svelte')]);
      const payload = await openLink(ref);
      if (payload) {
        IncomingShareComponent = panel.default;
        incomingShare = { title: payload.title, body: payload.body };
      } else {
        // Gone for good, so there is nothing to retry and no reason to keep it.
        dismissIncomingShare();
        showFlash('That shared link has expired or was withdrawn');
      }
    } catch {
      showFlash('That shared link could not be opened — reload to try again');
    }
  }

  function dismissIncomingShare(): void {
    incomingShare = null;
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  async function acceptIncomingShare(): Promise<void> {
    if (!incomingShare || incomingBusy) return;
    incomingBusy = true;
    try {
      const { saveToNotes } = await import('./share.ts');
      const id = await saveToNotes({ ...incomingShare, updatedAt: Date.now() }, activeFolderId);
      dismissIncomingShare();
      await tick();
      await workspace.select(id);
      await tick();
      focusEditor();
    } catch {
      showFlash('That note could not be saved');
    } finally {
      incomingBusy = false;
    }
  }

  /** Guards against the boot path and `hashchange` both landing a share. */
  let capturing = false;

  /**
   * Quick capture: text the operating system handed over.
   *
   * Two arms, one applier. On Android the share sheet POSTs to `/capture` and
   * `src/sw.js` parks the body until `state/capture.ts` claims it, which has
   * already happened by the time this runs — the claim is in `main.ts`,
   * because the worker's memory is not something to keep waiting on. On iOS
   * Safari will not offer its share sheet to a web app at all, so a Shortcut
   * opens the app with the text percent-encoded in the fragment.
   *
   * ## Why this writes the note instead of offering it
   *
   * `readIncomingShare` above asks first, and says why: a link that arrives on
   * its own must not be able to add notes. This does not ask, and the
   * difference is the point of the feature — quick capture is worth having
   * only if it costs no taps, and the user has *already* chosen HushJot from a
   * share sheet. The residual is real and `docs/security.md` § "Quick capture"
   * states it: a cross-origin page can auto-submit a form POST to `/capture`,
   * so an arriving link can create a note. It cannot read one, the note opens
   * in front of the user rather than landing silently, and the flash offers
   * Undo — `workspace.remove` tombstones into Recently deleted, so nothing is
   * destroyed either way.
   *
   * The URL is cleared as soon as there is text in hand, and only then: an
   * early clear would take the `s1.` fragment out from under
   * `readIncomingShare`, which is running beside this one and needs it until
   * the offer is accepted or dismissed.
   */
  async function readCapture(): Promise<void> {
    // Both entry points can arrive; the share must become one note, not two.
    if (capturing) return;
    capturing = true;
    try {
      await applyCapture();
    } finally {
      capturing = false;
    }
  }

  /**
   * A capture arriving at a tab that is already open.
   *
   * The iOS half is a Shortcut that opens a URL, and a browser asked to open a
   * URL it already has a tab for may simply reuse it — which is a *same
   * document* navigation: the fragment changes, nothing reloads, and
   * `startWorkspace` never runs again. Without this the second capture of the
   * day silently does nothing, which is the worst way for it to fail. The
   * share viewer answers the same problem the same way
   * (`Viewer.svelte`'s `onhashchange`).
   *
   * `clearCaptureUrl` uses `replaceState`, which fires no `hashchange`, so
   * clearing up after a capture cannot start another one.
   */
  function onHashChange(): void {
    if (vaultReady && workspace.initialized) void readCapture();
  }

  async function applyCapture(): Promise<void> {
    const [{ takeSharedText, clearCaptureUrl }, { parseCaptureFragment }] = await Promise.all([
      import('./state/capture.ts'),
      import('../core/capture/link.ts'),
    ]);

    const shared = await takeSharedText();
    const fragment = parseCaptureFragment(window.location.hash);
    if (!shared && fragment === null) return;

    const { composeCapture } = await import('../core/capture/compose.ts');
    const body = shared ? composeCapture(shared) : fragment;
    clearCaptureUrl();
    // An app that offers "share" on an empty selection is a real thing, and
    // the right answer to it is silence rather than a blank note.
    if (!body) return;

    try {
      const note = await workspace.create(activeFolderId);
      workspace.update(note.id, body);
      await tick();
      await workspace.select(note.id);
      await tick();
      focusEditor();
      showFlash('Captured', { label: 'Undo', run: () => void workspace.remove(note.id) });
    } catch {
      showFlash('That shared text could not be saved');
    }
  }

  function clock(at: number): string {
    return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  async function restoreVersion(noteId: string, text: string, at: number, replaced: string): Promise<void> {
    historyNoteId = null;
    if (!(await workspace.restoreText(noteId, text))) {
      showFlash('That note could not be restored');
      return;
    }
    await tick();
    focusEditor();
    showFlash(`Restored the version from ${clock(at)}`, {
      label: 'Undo',
      run: () => void workspace.restoreText(noteId, replaced, { keepCurrent: false }).then(focusEditor),
    });
  }

  async function restoreAsNewNote(text: string, folderId: string | null): Promise<void> {
    historyNoteId = null;
    deletedOpen = false;
    const id = await workspace.restoreAsNewNote(text, folderId);
    if (!id) {
      showFlash('The note could not be restored');
      return;
    }
    await workspace.select(id);
    await tick();
    focusEditor();
    showFlash('Restored as a new note');
  }

  async function undelete(noteId: string): Promise<void> {
    deletedOpen = false;
    const { restored, folderGone } = await workspace.undelete(noteId);
    if (!restored) {
      showFlash('That note could not be restored');
      return;
    }
    await workspace.select(noteId);
    await tick();
    focusEditor();
    showFlash(folderGone ? 'Restored to the top level — its folder was deleted' : 'Note restored');
  }

  /** Commands that export without the dialog: a flash says what happened. */
  async function exportFromCommand(
    kind: 'all' | 'folder' | 'note',
    folder = activeFolderId,
    noteId: string | null = null,
  ): Promise<void> {
    // A ⌘J export means the highlighted or open note; the row's `⋯` names one.
    const note = noteId ?? targetNoteId();
    try {
      const portability = await import('./portability.ts');
      if (kind === 'note') {
        if (note) showFlash(`Downloaded “${await portability.exportNote(note)}”`);
        return;
      }
      showFlash('Preparing export…');
      const { fileName } = await portability.exportZip(kind === 'folder' ? folder : null);
      if (kind === 'all') backupDue = false;
      showFlash(`Downloaded “${fileName}”`);
    } catch {
      showFlash('The export failed');
    }
  }

  /*
   * File drops and pastes, anywhere in the app.
   *
   * Capture phase on the window, for the reason the shortcut dispatcher gives:
   * CodeMirror has its own drop handler, and it reads a dropped file as text
   * and inserts it into the note — a 2 MB zip included. Only events that carry
   * files are touched; dragging text within or between notes never gets here.
   * The paste listener returns on its first line unless the clipboard holds a
   * file, which a text paste never does.
   */
  const IMPORTABLE_NAME = /\.(md|markdown|mdown|txt|zip)$/i;

  function carriesFiles(event: DragEvent): boolean {
    return vaultReady && workspace.initialized && (event.dataTransfer?.types.includes('Files') ?? false);
  }

  function onDragEnterCapture(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    fileDragDepth++;
    fileDragging = true;
  }

  function onDragOverCapture(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = 'copy';
  }

  function onDragLeaveCapture(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    // `relatedTarget` is null when the drag leaves the window, whatever the count says.
    if (fileDragDepth === 0 || event.relatedTarget === null) {
      fileDragDepth = 0;
      fileDragging = false;
    }
  }

  function onDropCapture(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepth = 0;
    fileDragging = false;
    const dt = event.dataTransfer!;
    // Entries must be taken now: they are invalid once this handler returns.
    const entries = [...dt.items].map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null));
    openPortability({ entries, files: [...dt.files] });
  }

  /**
   * Teardown for an internal note or folder drag. Idempotent, because `drop`
   * and `dragend` both fire for a completed drag and only `dragend` for an
   * abandoned one. It takes no interest in a file drag, which owns the
   * handlers above and carries none of our state.
   */
  function endInternalDrag(): void {
    if (drag.source !== null) drag.end();
  }

  function onPasteCapture(event: ClipboardEvent): void {
    const pasted = event.clipboardData?.files;
    if (!pasted || pasted.length === 0 || !vaultReady || !workspace.initialized) return;
    const files = [...pasted].filter((f) => IMPORTABLE_NAME.test(f.name));
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    openPortability({ entries: [], files });
  }

  /**
   * Selecting a folder inside a collapsed branch — from ⌘J O, or by creating
   * one — opens the branch, so the highlighted row is never hidden. Only on a
   * change of folder: collapsing the active folder's parent afterwards is the
   * user's choice, and reopening it under them would fight it.
   */
  $effect(() => {
    const id = activeFolderId;
    if (id === null) return;
    untrack(() => folderTree.expandAll(ancestorIds(workspace.folders, id), workspace.folders));
  });

  /**
   * The §4 indicator, combining local persistence and remote sync.
   *
   * Local state wins while a write is outstanding: "Saving…" is about the
   * user's text reaching durable storage, which matters more than whether it
   * has reached the cloud yet. Only once local is settled do we report the
   * sync layer, and only when signed in — a local-only user should never see
   * "Offline", because nothing about their setup is.
   *
   * The 'error' case is the one that used not to be here, and its absence was
   * a lie rather than an omission: a cycle that threw with nothing left queued
   * fell through to "Saved ✓" and stayed there, so a backend refusing every
   * read kept retrying on its own timers behind a green tick, with the raw
   * status string in the account panel as the only sign anywhere (§25). It
   * sits after 'offline' because an unreachable network is the more specific
   * and more actionable reading of the same situation.
   *
   * 'not-approved' and 'signed-out' deliberately still fall through. Both
   * latch, both tear the engine down, and both raise their own banner with
   * copy that says what to do; adding a second signal for a state the user has
   * already been told about in a sentence would only make the bar noisier.
   */
  const saveState = $derived.by(() => {
    if (workspace.saveState === 'saving') return 'saving' as const;
    if (!syncStore.signedIn) return workspace.saveState;
    if (syncStore.status === 'offline') return 'offline' as const;
    if (syncStore.status === 'syncing' || syncStore.pending > 0) return 'syncing' as const;
    if (syncStore.status === 'error') return 'sync-failed' as const;
    return 'saved' as const;
  });
  const showEditorPane = $derived(!mobile.matches || workspace.editorOpen);
  // Focus mode is read *beside* `sidebarHidden` rather than writing it, which
  // is what makes leaving the mode restore the sidebar to whatever it was
  // without anything remembering. `state/focusMode.svelte.ts` has the argument.
  const showListPane = $derived(
    mobile.matches ? !workspace.editorOpen : !tiling.sidebarHidden && !focusMode.on,
  );

  // The vault gates everything: notes cannot be read, written or indexed
  // without the key, so nothing else starts until it is open.
  const vaultReady = $derived(vaultStore.isUnlocked && vaultStore.pendingRecoveryCode === null);

  async function startWorkspace(): Promise<void> {
    if (!workspace.initialized) await workspace.init();
    watchSiblingReset();
    // After the workspace, so the note a link becomes has somewhere to go, and
    // never before the vault is open — these are the entry points that start
    // from outside the app: somebody else's URL, and the OS share sheet.
    void readIncomingShare();
    void readCapture();
    await startSync();
  }

  let stopWatchingReset: (() => void) | undefined;

  /**
   * Another tab is removing the local data, so this one must let go too.
   *
   * Re-subscribed on every unlock rather than once, because the channel is
   * the workspace's: `shutdown()` closes it and a later unlock opens a new
   * one, and a closed channel's handlers go with it.
   */
  function watchSiblingReset(): void {
    stopWatchingReset?.();
    stopWatchingReset = workspace.tabChannel?.subscribe((message) => {
      if (message.type === 'reset') void applyReset();
    });
  }

  /**
   * Start sync as soon as both halves exist, whenever that happens to be.
   *
   * Sync needs an account and an unlocked vault, and the two arrive on
   * independent clocks: the vault from IndexedDB, the account from Firebase
   * restoring a persisted session over the network. Calling `startSync()` at
   * the two points where one of them lands is a race — if auth is restored
   * *after* the last of those calls has already run and found no user, nothing
   * tries again, and the tab simply never syncs. A second tab loses that race
   * routinely, because it has no sign-in flow of its own to fall back on, and a
   * slow network can lose it in the first tab too.
   *
   * An effect has no such ordering to get wrong: it runs again when the thing
   * it was waiting for actually appears. `startEngine` already returns the
   * existing engine rather than building a second one, so re-entry is cheap.
   */
  let startingSync = false;
  $effect(() => {
    if (!syncStore.signedIn || !vaultReady || !workspace.initialized) return;
    // A cost lockdown refuses everything; an engine started now would spend a
    // refused cycle and a probe to learn it again. Read here so the end of the
    // pause re-runs this effect and brings sync back without a reload.
    if (syncStore.paused) return;
    if (syncStore.engine || startingSync) return;
    // `startSync` awaits a backend read before it builds the engine, so the
    // `engine` check alone leaves a window in which a second run of this
    // effect would start a second one.
    startingSync = true;
    void startSync().finally(() => {
      startingSync = false;
    });
  });

  /**
   * Bind this device's older records to their ids, once the notes are on
   * screen. Waits for the workspace so the one-off read of every body does not
   * compete with the cold start; `resealLegacy` is idempotent and once-only.
   */
  $effect(() => {
    if (!vaultReady || !workspace.initialized) return;
    void vaultStore.resealLegacy();
  });

  /**
   * First-run content waits here.
   *
   * A device with an empty local database cannot tell a brand-new user from
   * one whose notes are all on the backend, and guessing wrong writes a second
   * copy of every seed note — which then syncs everywhere. So nothing is
   * written until the account can no longer surprise us: no backend at all, or
   * auth has reported nobody, or a sync cycle has completed.
   *
   * An effect rather than a call after `init()`, for the same reason as
   * `startSync` above: the three inputs land on independent clocks, and
   * whichever arrives last is the one that has to trigger the write.
   */
  $effect(() => {
    if (!workspace.firstRunPending) return;
    if (
      !firstRunReady({
        backendConfigured: syncStore.available,
        authSettled: syncStore.authSettled,
        signedIn: syncStore.signedIn,
        firstSyncDone: syncStore.firstSyncDone,
      })
    ) {
      return;
    }
    void workspace.completeFirstRun();
  });

  /**
   * Bring sync up once both halves exist: an account for identity, and an
   * unlocked vault for the key. Either alone produces nothing readable.
   */
  async function startSync(): Promise<void> {
    if (!syncStore.signedIn || !vaultStore.isUnlocked) return;
    // Paused: the effect above starts sync when the pause ends.
    if (syncStore.paused) return;
    const repo = workspace.repository;
    if (!repo) return;

    // A re-wrap from the unlock screen had no repository to write its flag to.
    if (keyRecordDirtyPending) {
      await repo.set(KEY_RECORD_DIRTY_KEY, true);
      keyRecordDirtyPending = false;
    }

    // A vault retired by a reset elsewhere must not sync at all: not the
    // backfill, not new edits, not history. Every one of those would seal
    // notes into the account's new vault under a key it cannot open.
    if ((await bindVaultToAccount(repo)) === 'retired') return;

    syncStore.startEngine(repo, {
      onRemoteChange: () => void workspace.refreshFromStore('remote'),
      createConflictCopy: (noteId, remote) => workspace.createConflictCopy(noteId, remote),
      rebaseMeta: (noteId, local, remote) => workspace.rebaseMeta(noteId, local, remote),
      // Pending text has to reach the queue before the round trip, or a pull
      // arriving mid-debounce silently wins over it.
      beforeSync: () => workspace.flushPending(),
      // Borrowed: the channel belongs to the workspace so that tabs with no
      // engine still hear each other (core/sync/tabs.ts, "Two lifetimes").
      channel: workspace.tabChannel,
      // Versions upload on the engine's own cycles; see core/sync/engine.ts.
      history: () => workspace.history(),
    });
  }

  /**
   * Answer "is this device's vault the account's vault?" and write the answer
   * down.
   *
   * Publishing the wrapped key record when the account has none is part of the
   * same act (§31): it is what lets a second device unlock with the same
   * passphrase, and it is what makes this device demonstrably the account's.
   * The record is ciphertext; the backend gains nothing by holding it.
   *
   * The decision itself is `classifyVault`, in core, where it can be tested.
   * This function is only the I/O around it — and the local-first ordering,
   * which is why a bound device asks the network nothing at all for
   * *ownership*. It asks once per session whether the account has moved on
   * without it (a re-wrap elsewhere, a purge, a reset), and the reset question
   * comes before anything else: a bound device with a re-wrap to publish would
   * otherwise write its old record over the tombstone, undoing the reset.
   *
   * Answers `'retired'` when this device must not sync with the account at all.
   */
  async function bindVaultToAccount(repo: NoteRepository): Promise<'ok' | 'retired'> {
    const adapter = syncStore.adapter;
    const uid = adapter?.user?.uid;
    if (!adapter || !uid) return 'ok';

    try {
      if ((await repo.get<string>(VAULT_RETIRED_KEY)) === uid) {
        syncStore.vaultRetired = true;
        return 'retired';
      }

      const boundAccount = await repo.get<string>(VAULT_ACCOUNT_KEY);
      const keyRecordDirty = (await repo.get<boolean>(KEY_RECORD_DIRTY_KEY)) === true;
      const localRecord = vaultStore.exportRecord();

      // The once-per-session look at the account, taken early on a bound
      // device so a reset is seen before anything below can publish. A failed
      // read is not an answer: an offline device goes on exactly as before,
      // and the stale check further down asks again.
      let keyDocument: KeyDocument | undefined;
      if (boundAccount === uid && staleCheckedFor !== uid) {
        try {
          keyDocument = await adapter.loadKeyDocument();
        } catch {
          keyDocument = undefined;
        }
        if (
          keyDocument &&
          accountResetElsewhere({
            ownsAccount: true,
            localRecord,
            remoteRecord: keyDocument.record,
            remoteResetAt: keyDocument.resetAt,
          })
        ) {
          await retireVault(repo, uid);
          return 'retired';
        }
      }
      // Nothing else is worth reading when the answer is already on disk. An
      // offline device used to be told its passphrase was wrong here.
      let remoteRecord: unknown | null | undefined;
      if (boundAccount !== uid && !adoptedFromAccount) {
        remoteRecord = await adapter.loadKeyRecord();
      }

      const verdict = classifyVault({
        boundAccount,
        uid,
        remoteRecord,
        localRecord,
        adoptedThisSession: adoptedFromAccount,
        keyRecordDirty,
      });

      // Publishing is a read-then-write with no atomicity, so two devices that
      // each hold their own vault and sign in within one round trip can both
      // see an empty account and both publish. The account keeps the last
      // write; the loser would otherwise remember that it owns a vault the
      // account does not have, and — now that the answer is durable — never
      // re-check. Reading back what the account actually kept costs one extra
      // document once in an account's lifetime and settles it.
      let owns = verdict.owns;
      let bind = verdict.bind;
      if (verdict.publish && localRecord) {
        if (await publishKeyRecord(adapter, localRecord)) {
          // Whatever this device owed the account is paid.
          if (keyRecordDirty) await repo.set(KEY_RECORD_DIRTY_KEY, false);
        } else if (boundAccount !== uid) {
          // Somebody else's record is what the account holds. Not our vault,
          // and nothing of ours may be swept into it.
          owns = false;
          bind = false;
        }
        // Losing the read-back on a device that is *already* bound is a
        // different event and must not be read as the one above: ownership was
        // settled before either re-wrap, so this is two re-wraps of the same
        // vault inside one round trip. The flag stays up and the next cycle
        // tries again. There is no write war to fear — a device retries only
        // while its own flag is up, and a confirmed read-back takes it down.
      }
      // Bound only after the record is known to be in place: a marker written
      // ahead of a failed upload would remember a claim that is not true.
      if (bind) await repo.set(VAULT_ACCOUNT_KEY, uid);
      syncStore.vaultOwnsAccount = owns;

      // Has somebody changed the passphrase on another device?
      //
      // One extra document, once per session, on a device that has already
      // settled ownership and otherwise asks the backend nothing at all. It
      // buys the difference between a device that is quietly wrong and one
      // that says so — the same trade `vaultOwnsAccount === false` makes, and
      // the residue of `Vault.adoptRecord` refusing to replace a record that
      // already exists.
      if (owns === true && staleCheckedFor !== uid) {
        staleCheckedFor = uid;
        const accountRecord = keyDocument
          ? keyDocument.record
          : (remoteRecord ?? (await adapter.loadKeyRecord()));
        if (accountWasReset({ ownsAccount: true, localRecord, remoteRecord: accountRecord })) {
          // The account was emptied after a long lapse and has a plan again.
          // Put the key record back first, then forget what this device
          // believes it has already uploaded: every anchor describes a
          // document that no longer exists. The engine has not started, so the
          // sweep that follows re-arms and sends the library again.
          if (localRecord && (await publishKeyRecord(adapter, localRecord))) {
            await repo.clearSyncState();
          } else {
            // Ask again on the next start rather than remembering a repair
            // that did not happen.
            staleCheckedFor = null;
          }
        } else {
          syncStore.keyRecordStale = keyRecordIsStale({
            ownsAccount: true,
            keyRecordDirty: (await repo.get<boolean>(KEY_RECORD_DIRTY_KEY)) === true,
            localRecord,
            remoteRecord: accountRecord,
          });
        }
      }
    } catch {
      // Best-effort; sync still works for this device. Leave the vault question
      // unanswered rather than guessing — the sweep waits and asks again.
    }
    return 'ok';
  }

  /**
   * This device's vault stopped being the account's: its owner reset the
   * account from another device. Written down before anything else so a
   * reload cannot forget it (`VAULT_RETIRED_KEY` says why that matters), and
   * the ownership marker cleared so `republishKeyRecord` answers `not-owner`
   * to a passphrase change made here later. The notes stay on this device,
   * readable with the old passphrase, until the user exports or removes them.
   */
  async function retireVault(repo: NoteRepository, uid: string): Promise<void> {
    await repo.set(VAULT_RETIRED_KEY, uid);
    await repo.set(VAULT_ACCOUNT_KEY, null);
    await repo.set(KEY_RECORD_DIRTY_KEY, false);
    syncStore.vaultRetired = true;
  }

  /**
   * Put this device's key record on the account, and prove it landed.
   *
   * The read-back is one extra document and it settles the only thing the
   * write cannot: what the account actually *kept*. `sameKeyRecord` compares
   * bytes, which is right here and misleading almost everywhere else — these
   * are the bytes we uploaded a moment ago, so an echo of them is proof, where
   * comparing a record across a legitimate re-wrap proves nothing at all.
   */
  async function publishKeyRecord(adapter: SyncAdapter, record: unknown): Promise<boolean> {
    await adapter.saveKeyRecord(record);
    return sameKeyRecord(await adapter.loadKeyRecord(), record);
  }

  /**
   * The account the stale check has already run for.
   *
   * Once per account rather than once per session: keyed on a bare boolean it
   * would skip the check for a second account signed into in the same session,
   * and there is no sign-out hook here to reset it from.
   */
  let staleCheckedFor: string | null = null;

  /**
   * A re-wrap that happened before there was a repository to write the flag to.
   *
   * "Set a new passphrase from the recovery code" runs on the unlock screen,
   * with the workspace shut and no `NoteRepository` in existence. Memory is
   * enough: the only way off that screen is an unlock in this same tab, which
   * starts the workspace, which flushes this in `startSync` before the first
   * `bindVaultToAccount`.
   */
  let keyRecordDirtyPending = false;

  /** Arm the durable retry. Answers whether it was already armed. */
  async function markKeyRecordDirty(): Promise<boolean> {
    const repo = workspace.repository;
    if (!repo) {
      const was = keyRecordDirtyPending;
      keyRecordDirtyPending = true;
      return was;
    }
    const was = (await repo.get<boolean>(KEY_RECORD_DIRTY_KEY)) === true;
    await repo.set(KEY_RECORD_DIRTY_KEY, true);
    return was;
  }

  /**
   * One publish attempt, now rather than on the next sync cycle.
   *
   * Guarded on `boundAccount === uid` and nothing else. That marker *is* the
   * claim "this device owns the account's record"; it is the only branch of
   * `classifyVault` that publishes on a dirty flag, and re-deriving the same
   * answer here from a fresh read would be a second opinion able to disagree
   * with the first.
   */
  async function republishKeyRecord(): Promise<RepublishOutcome> {
    const repo = workspace.repository;
    const adapter = syncStore.adapter;
    const uid = adapter?.user?.uid;
    if (!repo || !adapter || !uid || !syncStore.signedIn) return 'no-account';

    const record = vaultStore.exportRecord();
    if (!record) return 'no-account';

    try {
      if ((await repo.get<string>(VAULT_ACCOUNT_KEY)) !== uid) return 'not-owner';
      if (!(await publishKeyRecord(adapter, record))) return 'unreachable';
      await repo.set(KEY_RECORD_DIRTY_KEY, false);
      syncStore.keyRecordStale = false;
      return 'published';
    } catch {
      return 'unreachable';
    }
  }

  /**
   * Re-wrap a secret, then tell the account. The whole operation, because the
   * order is load-bearing and belongs here beside `bindVaultToAccount` rather
   * than inside a dialog the user can close halfway through.
   *
   * The flag goes up *before* the re-wrap, never after. A tab killed between
   * the two then retries a publish it may not owe, which costs one idempotent
   * write. The other order skips a publish it does owe, which is another
   * device unlocking with the retired passphrase for ever — the failure this
   * exists to stop. On a failed re-wrap the flag is put back exactly as it was
   * found, so a mistyped passphrase cannot arm a republish and an *older*
   * unpublished re-wrap is not disarmed either.
   */
  async function runVaultSecretAction(action: VaultSecretAction): Promise<VaultSecretResult> {
    // Adopting is the one action that re-wraps nothing and owes the account
    // nothing: this device is taking the account's *own* bytes, so afterwards
    // it holds exactly what the account holds. Arming the retry here would be
    // actively harmful — a tab killed mid-adopt would wake up owing a publish
    // and push its stale record back over the newer one.
    if (action.kind === 'adopt-record') return adoptAccountRecord(action.passphrase);

    const wasDirty = await markKeyRecordDirty();

    let code: string | null = null;
    let ok: boolean;
    switch (action.kind) {
      case 'change-passphrase':
        ok = await vaultStore.changePassphrase(action.current, action.next);
        break;
      case 'reset-passphrase':
        ok = await vaultStore.setPassphraseWithRecoveryCode(action.code, action.next);
        break;
      case 'reissue-code':
        code = await vaultStore.reissueRecoveryCode(action.passphrase);
        ok = code !== null;
        break;
    }

    // `vaultStore.error` is global and the unlock screen renders it — and this
    // dialog can be mounted over that screen. Carried out in the result, or a
    // mistyped code here also accuses the passphrase field behind.
    const error = vaultStore.error;
    vaultStore.error = null;

    if (!ok) {
      if (!wasDirty) {
        const repo = workspace.repository;
        if (repo) await repo.set(KEY_RECORD_DIRTY_KEY, false);
        else keyRecordDirtyPending = false;
      }
      return { ok: false, error: error ?? 'unknown', code: null, publish: 'no-account' };
    }

    if (action.kind === 'reset-passphrase') passphraseResetSeq += 1;

    return { ok: true, error: null, code, publish: await republishKeyRecord() };
  }

  /**
   * Take the account's re-wrapped record in place of this device's; see
   * `Vault.replaceRecord` for the proof that makes it safe.
   *
   * Nothing is published — `no-account` is the literal truth here, nothing was
   * owed — and the banner comes down only once the record has actually landed.
   */
  async function adoptAccountRecord(passphrase: string): Promise<VaultSecretResult> {
    const adapter = syncStore.adapter;
    const remote = await adapter?.loadKeyRecord();
    const ok = remote ? await vaultStore.replaceRecord(remote, passphrase) : false;

    const error = vaultStore.error;
    vaultStore.error = null;
    if (!ok) return { ok: false, error: error ?? 'unknown', code: null, publish: 'no-account' };

    syncStore.keyRecordStale = false;
    return { ok: true, error: null, code: null, publish: 'no-account' };
  }

  /**
   * Bumped whenever a passphrase is set from the recovery code, so the unlock
   * screen behind the dialog can return to its passphrase field. See
   * `Unlock.svelte`'s `resetSeq` prop.
   */
  let passphraseResetSeq = $state(0);

  /**
   * Set when this device took its vault from the account, which makes the two
   * the same vault by construction — the other half of the question
   * `bindVaultToAccount` answers. Session-scoped, and that is now fine: the
   * durable half of the answer is `VAULT_ACCOUNT_KEY`.
   */
  let adoptedFromAccount = false;

  /**
   * A device with an account but no local vault takes the wrapped key record
   * from the backend, so the passphrase can unlock it here too.
   *
   * An effect, for the same reason `startSync` is one — and this is the more
   * dangerous race of the two. `signedIn` is false until Firebase has restored
   * the persisted session, which happens *after* `connect()` resolves, so the
   * one-shot call this replaced routinely ran on a signed-in device, found no
   * user, did nothing, and was never retried. The user was then shown "Create
   * vault", typed the right passphrase, and got a brand-new random data key:
   * `Vault.create` never derives the key from the passphrase. Same passphrase,
   * different vault, permanently. `authSettled` is the only signal that
   * separates "nobody" from "not asked yet".
   */
  let adopting = false;
  $effect(() => {
    if (!syncStore.authSettled || !syncStore.signedIn) return;
    // Paused: the account's key record cannot be read until the lockdown
    // ends, and the end of it re-runs this effect, which adopts it then.
    if (syncStore.paused) return;
    // `vaultStore.state`, not `vaultStore.hasRecord`: the latter reads a plain
    // field on the vault and is invisible to the effect system, so an effect
    // gated on it would neither track it nor re-run when `initialize()` lands.
    // `state` is also the stricter guard — `'loading'` is not `'empty'`, and
    // "we have not read the vault yet" must not look like "there is no vault".
    if (vaultStore.state !== 'empty' || adoptedFromAccount || adopting) return;
    if (!syncStore.adapter) return;
    adopting = true;
    void adoptRemoteVault().finally(() => {
      adopting = false;
    });
  });

  /** The raw verdict, written only by `adoptRemoteVault` below. */
  let accountVaultLookup = $state<AccountVault>('idle');

  /**
   * A verdict belongs to the account it was read with. Signing out and into a
   * different one must not leave this device telling the new account's user
   * that "this account already has a vault" on the strength of the old one's
   * answer. The derivation below hides a stale verdict while nobody is signed
   * in; this is what stops it reappearing for the next account.
   */
  $effect(() => {
    if (!syncStore.signedIn) accountVaultLookup = 'idle';
  });

  /**
   * What the unlock screen is allowed to offer.
   *
   * `'checking'` holds the create form shut, and it means more than "a lookup
   * is in flight". It means **we cannot yet prove that creating a vault here
   * will not fork the account's**, and there are two other ways to be in that
   * position that the raw verdict above cannot express:
   *
   *  - Before auth has settled. `connect()` resolves before Firebase has
   *    restored a persisted session, so a device with an account looks exactly
   *    like a device without one for as long as the SDK takes to load. A user
   *    who wins that race gets the right passphrase and the wrong vault, and
   *    `Vault.create` mints a fresh random key, so there is no way back.
   *  - The frame between `signedIn` landing and the adopt effect writing
   *    `'checking'`. The effect runs after the DOM flush that already rendered
   *    an enabled form.
   *
   * It also resets itself on sign-out: a `'failed'` or `'none'` verdict belongs
   * to the account it was read with and must not outlive that credential.
   *
   * `'failed'` still lets the user through, loudly — an offline new device that
   * is locked out entirely is the worse failure of the two.
   */
  const accountVault = $derived.by<AccountVault>(() => {
    if (!syncStore.available) return 'idle';
    if (!syncStore.authSettled) return 'checking';
    if (!syncStore.signedIn) return 'idle';
    // Before the raw verdict: `'paused'` holds the create form shut for as
    // long as the lockdown lasts, and becomes whatever the lookup finds after.
    if (vaultStore.state === 'empty' && syncStore.paused) return 'paused';
    if (vaultStore.state === 'empty' && accountVaultLookup === 'idle') return 'checking';
    return accountVaultLookup;
  });

  async function adoptRemoteVault(): Promise<void> {
    if (vaultStore.state !== 'empty' || !syncStore.signedIn) return;
    accountVaultLookup = 'checking';
    try {
      const record = await syncStore.adapter?.loadKeyRecord();
      // The result matters: `adoptRecord` reports false for a malformed record
      // and for one that arrived after a local vault existed. Claiming a vault
      // we failed to adopt is the one false positive that can put unreadable
      // ciphertext on an account, and the rules refuse deletes.
      if (record && (await vaultStore.adoptRecord(record))) {
        adoptedFromAccount = true;
        // `'adopted'`, not `'idle'`: the unlock screen says a different thing
        // for a vault that just arrived from the account, and the derivation
        // above reads `'idle'` as "never asked" and would hold the form shut.
        accountVaultLookup = 'adopted';
        return;
      }
      // No record means the account has no vault yet and creating one here is
      // exactly right. A record we could not adopt is the opposite, and must
      // not be reported as the same thing.
      accountVaultLookup = record ? 'failed' : 'none';
    } catch (error) {
      // A refusal on a new device is either an account that may not sync or a
      // cost lockdown, and the second must not be met with "create a
      // passphrase": the account almost certainly has a vault, and creating
      // one here would fork it. One probe tells them apart.
      if (error instanceof SyncNotApprovedError && (await syncStore.probePause()) === 'paused') {
        syncStore.enterPause();
        accountVaultLookup = 'checking';
        return;
      }
      // Offline on a new device: nothing to adopt yet, and the unlock screen
      // says so rather than quietly offering to create a second vault.
      accountVaultLookup = 'failed';
    }
  }

  onMount(() => {
    void import('./Editor.svelte').then((module) => {
      EditorComponent = module.default;
    });

    void (async () => {
      await vaultStore.initialize();

      // Firebase is loaded after the vault check, never before it — §7 forbids
      // initialising it ahead of useful UI.
      // Adoption is not called from here: it needs auth to have *settled*, and
      // `connect()` resolves before Firebase has restored the session. The
      // effect above waits for the real signal.
      void syncStore.connect().then(async () => {
        if (vaultStore.isUnlocked && workspace.initialized) await startSync();
      });

      if (vaultStore.isUnlocked) await startWorkspace();

      // Hand the repository over whether or not sync ever starts, so signing
      // out can always drop this account's bookkeeping.
      const repo = workspace.repository;
      if (repo) syncStore.attachRepository(repo);
    })();

    // `pagehide` is the reliable teardown signal — `beforeunload` does not fire
    // on mobile Safari when the app is backgrounded, which is exactly the case
    // §25's "user types and immediately closes tab" cares about.
    const flush = () => void workspace.flush();
    // Coming back is as important as leaving. A backgrounded tab's Firestore
    // listener may have been suspended, and nothing here polls, so without this
    // a tab left alone can sit on stale text until the next local edit.
    //
    // Re-reading the store is half of it, and the half that was missing: a
    // sibling tab's write never produces a pull worth reporting — the leader
    // pushed it, so it comes back as this device's own echo — so syncing alone
    // would find nothing and the list would stay as stale as it was. Live
    // updates between visible tabs come from the workspace's tab channel; this
    // covers a tab that was asleep, or a browser without BroadcastChannel.
    //
    // The same pair as `syncNow`, minus the flush: this runs on every window
    // focus, and a write on each of those is work the scheduler already owns.
    const resync = () => {
      void syncStore.engine?.syncNow();
      // While sync is paused there is no engine; this is the prompt check
      // that ends the pause for someone who comes back to the tab.
      syncStore.recheckPause();
      void workspace.refreshFromStore('sibling');
      workspace.settleSearchIndex();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else resync();
    };

    window.addEventListener('pagehide', flush);
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', onVisibility);
      void workspace.flush();
    };
  });

  async function lockNow(): Promise<void> {
    // Write everything before dropping the key, or the last edits become
    // unreadable ciphertext we no longer have a key for.
    await workspace.flush();
    syncStore.stopEngine();
    await workspace.shutdown();
    await vaultStore.lock();
  }

  /**
   * Sign out, and lock.
   *
   * The two used to be disjoint. `syncStore.signOut()` severs the *account* —
   * engine, cursor, revision anchors, queued pushes, credential — and never
   * touches the vault, so signing out left the key in memory, the device key
   * on disk, and every note on screen behind a dialog that did not even close
   * itself. A user on a borrowed machine had done the one thing they knew to
   * do and it had not worked.
   *
   * The lock lives here rather than inside `syncStore.signOut()` on purpose:
   * that method is also called mid-sign-in, when an account turns out not to
   * be on the allowlist (`sync.svelte.ts`, `if (!approved) await signOut()`),
   * and throwing a user out of their own vault for that would be absurd.
   *
   * Ordering is `lockNow`'s, with the account torn down first: the sign-out
   * writes through the repository to clear this account's bookkeeping, and
   * `shutdown()` is what closes it.
   */
  async function signOutNow(): Promise<void> {
    await workspace.flush();
    await syncStore.signOut();
    await workspace.shutdown();
    await vaultStore.lock();
  }

  /**
   * Remove everything this browser holds: both databases, the journal, and
   * every per-device preference. Then reload, so the app boots exactly as it
   * would on a machine that had never seen it.
   *
   * Every line is ordered against something that bites:
   *
   * - **The other tabs are told first.** The channel belongs to the workspace
   *   and `shutdown()` closes it. And they have to be told at all: a sibling
   *   that keeps its connection open turns `deleteDatabase` into a *pending*
   *   delete, which `deleteDb` reports to us as success (`core/repo/idb.ts`),
   *   while that tab still holds the key and shows the notes.
   * - **No flush**, the one place that differs from `lockNow`. Sealing the
   *   last keystrokes into a database on its way to being deleted is work for
   *   nothing.
   * - **Sign out before `shutdown()`**, because it writes through the
   *   repository — and because it is what clears Firebase's own auth
   *   database, which is the whole point on a machine that is not yours.
   * - **`shutdown()` before `reset()`.** Four things hold a connection to
   *   `teksto`: the repository, the vault storage, the search worker's own
   *   repository, and transiently the migration. `shutdown()` closes the
   *   repository and the history store and terminates the search worker;
   *   `clearAll()` closes the vault storage itself before deleting.
   * - **Reload last**, rather than trying to return the app to a pristine
   *   in-memory state by hand. There is no version of that which is easier to
   *   be sure of than starting the page again.
   *
   * Best-effort throughout: a failure partway leaves a half-cleared device,
   * which is worse than either end, so the reload happens regardless and the
   * next load sees whatever actually survived.
   */
  function removeLocalData(): void {
    // Told before anything is torn down: the channel belongs to the workspace
    // and `shutdown()` closes it.
    workspace.tabChannel?.post({ type: 'reset' });
    void applyReset();
  }

  /**
   * The wipe itself, run by every tab rather than only the one the user
   * clicked in — which is what makes the multi-tab case safe without any
   * coordination beyond the one message.
   *
   * Two tabs both requesting a delete cannot go wrong: the second is a no-op,
   * and if one tab's reload re-creates the database before the other's delete
   * lands, an *empty* `teksto` is the correct end state anyway — no key
   * record means no vault, which is the setup screen. The failure this avoids
   * is the opposite one, a sibling that holds its connection and turns the
   * delete into a pending delete `deleteDb` reports as success.
   */
  async function applyReset(): Promise<void> {
    try {
      if (syncStore.signedIn) await syncStore.signOut();
      else syncStore.stopEngine();
      await workspace.shutdown();
      await vaultStore.reset();
      clearDevicePreferences();
    } catch (err) {
      // A half-cleared device is worse than either end, so the reload happens
      // regardless and the next load works from whatever actually survived.
      console.error('[reset]', err);
    } finally {
      location.reload();
    }
  }

  /**
   * A manual cycle: flush, push and pull, then re-read the store. Saving never
   * depends on this (§10) — it only stops waiting for timers. The re-read is the
   * half `resync` already learned it needed: a sibling tab's write comes back
   * as this device's own echo, so a cycle alone would leave the list stale.
   *
   * Returns false when no cycle was possible — signed out, sync unconfigured,
   * session expired or not approved — so each caller can say so its own way.
   */
  async function syncNow(): Promise<boolean> {
    await workspace.flush();
    // Asking to sync is a good moment to ask whether the pause is over. The
    // answer arrives on its own: the sync effect restarts the engine.
    if (syncStore.paused) syncStore.recheckPause();
    const engine = syncStore.engine;
    if (!engine) return false;
    void engine.syncNow();
    void workspace.refreshFromStore('sibling');
    workspace.settleSearchIndex();
    return true;
  }

  async function onCloudClick(): Promise<void> {
    // Signing in is the only thing that helps in the states where a cycle is
    // impossible, so the cloud falls back to the account panel there — the
    // same place the local-only and session-expired banners send you.
    if (await syncNow()) showFlash('Syncing now');
    else accountOpen = true;
  }

  /**
   * Counts are debounced rather than derived. Deriving them would walk the
   * whole document on every keystroke — O(n) work on the one path §7 says must
   * stay clear. A count that lags typing by a moment costs the user nothing.
   */
  let counts = $state({ words: 0, chars: 0 });

  $effect(() => {
    const content = workspace.openContent;
    const handle = setTimeout(() => {
      counts = { words: countWords(content), chars: content.length };
    }, 250);
    return () => clearTimeout(handle);
  });

  function handleChange(noteId: string, content: string): void {
    workspace.update(noteId, content);
  }

  async function newNote(): Promise<void> {
    await workspace.create(activeFolderId, { tile: !mobile.matches });
    focusEditor();
  }

  async function tileNote(id: string): Promise<void> {
    await workspace.tile(id);
    focusEditor();
  }

  /**
   * Copying a note's whole text from its row.
   *
   * Safari drops the click's user activation across an `await`, and the body
   * may have to come out of IndexedDB first — so the clipboard write starts
   * synchronously with a promised payload, and `writeText` after the read is
   * only the fallback for browsers without `ClipboardItem`.
   */
  async function copyNote(id: string): Promise<boolean> {
    const body = workspace.bodyOf(id);
    try {
      if (typeof ClipboardItem !== 'undefined') {
        const blob = body.then((text) => new Blob([text], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
        return true;
      }
    } catch {
      // Fall through to writeText.
    }
    try {
      await navigator.clipboard.writeText(await body);
      return true;
    } catch {
      // Clipboard permission denied — the note is still there to copy by hand.
      return false;
    }
  }

  /**
   * Copy, then say so. Shared by ⌘J C and the row's `⋯`: from either the note
   * may be off screen, so the flash is the only confirmation there is.
   *
   * Not `await copyNote(...)` first: the clipboard write has to start in the
   * same turn as the click (see `copyNote`), and this keeps that true.
   */
  function copyNoteWithFlash(id: string): void {
    const title = workspace.metaById(id)?.title ?? 'Note';
    void copyNote(id).then((ok) =>
      showFlash(ok ? `Copied “${title}”` : 'Could not copy — clipboard blocked'),
    );
  }

  /** Pinned notes lead every list; see `orderForList`. */
  async function togglePin(id: string): Promise<void> {
    const meta = workspace.metaById(id);
    if (!meta) return;
    await workspace.setPinned(id, meta.pinnedAt === null);
  }

  async function deleteNote(id: string): Promise<void> {
    const meta = workspace.metaById(id);
    // Deletion propagates to every device, so it is worth one question.
    const ok = confirm(
      `Delete “${meta?.title ?? 'this note'}”? This removes it from all your devices. It stays in Recently deleted for 30 days.`,
    );
    if (!ok) return;
    await workspace.remove(id);
    showFlash(`Deleted “${meta?.title ?? 'note'}”`, { label: 'Undo', run: () => void undelete(id) });
  }

  /**
   * Filing the note, then putting the keyboard back where it was.
   *
   * The finder and the account panel both close by focusing the editor, which
   * would be wrong here: the user is working in the list, and the note being
   * moved need not be the one that is open. The row's own `⋯` — the button the
   * move was started from — is the place to return to, and it may legitimately
   * have gone, because the note can leave the visible list the moment it lands
   * in another folder, so the lookup is allowed to find nothing.
   */
  async function restoreMoveFocus(id: string | null): Promise<void> {
    if (!id) return;
    await tick();
    // Opened from the keyboard: go back to wherever the keyboard was.
    if (moveReturn === 'editor') return focusEditor();
    if (moveReturn === 'list') return focusNoteList();
    focusRowMore('note', id);
  }

  /**
   * What the note row's `⋯` offers. Everything here is an existing ⌘J command,
   * so the hints are real and `shortcuts.ts` gains nothing; the menu is what
   * makes them findable with a pointer. Delete is last, and `danger`, so the
   * destructive one keeps the edge the old hover strip gave it.
   *
   * Pin appears here as well as on the row, the same way "New subfolder" is
   * both the folder row's `+` and the first item of its menu.
   */
  const noteMenuItems = $derived.by((): readonly RowAction[] => {
    const note = noteActionsTarget;
    if (!note) return [];
    const id = note.id;
    return [
      // A phone shows one note; there is nothing to open beside it.
      ...(mobile.matches
        ? []
        : [{ label: 'Open beside', hint: hint('beside'), run: () => void tileNote(id) }]),
      {
        label: note.pinnedAt === null ? 'Pin to top' : 'Unpin',
        hint: hint('pin-note'),
        run: () => void togglePin(id),
      },
      { label: 'Copy note text', hint: hint('copy-note'), run: () => copyNoteWithFlash(id) },
      {
        label: 'Move to…',
        hint: hint('move-note'),
        run: () => {
          moveReturn = 'row';
          moveNoteId = id;
        },
      },
      {
        label: 'Export as Markdown',
        hint: hint('export-note'),
        run: () => void exportFromCommand('note', activeFolderId, id),
      },
      { label: 'Share by link…', hint: hint('share-note'), run: () => openShare(id) },
      { label: 'Note history', hint: hint('note-history'), run: () => openHistory(id) },
      { label: 'Delete', hint: hint('delete-note'), danger: true, run: () => void deleteNote(id) },
    ];
  });

  /**
   * The folder row's `⋯`, built the same way and for the same reason: the id is
   * pulled into a plain local *here*, so every `run` closes over a string.
   * `act()` closes the menu before it runs anything, which nulls
   * `folderActionsTarget` — a `run` that reached back through it would find
   * nothing, and `{@const}` is reactive enough to hand it that nothing.
   */
  const folderMenuItems = $derived.by((): readonly RowAction[] => {
    const folder = folderActionsTarget;
    if (!folder) return [];
    const id = folder.id;
    return [
      { label: 'New subfolder', hint: hint('new-subfolder'), run: () => void addFolder(id) },
      { label: 'Rename', hint: hint('rename-folder'), run: () => renameFolder(id) },
      { label: 'Move to…', hint: hint('move-folder'), run: () => (moveFolderId = id) },
      { label: 'Export as zip', run: () => void exportFromCommand('folder', id) },
      { label: 'Delete', hint: hint('delete-folder'), danger: true, run: () => void deleteFolder(id) },
    ];
  });

  /**
   * The sort menu: one choice of key, then an independent direction switch.
   *
   * Built in a `$derived.by` like the row menus, for the same reason — `act()`
   * closes the menu before running anything, so each `run` has to close over
   * plain values rather than reach back through reactive state. Here that is
   * only the key, which the loop already holds.
   */
  const sortMenuItems = $derived.by((): readonly RowAction[] => {
    const sort = noteSort.current;
    const items: RowAction[] = NOTE_SORT_KEYS.map((key) => {
      const captured = key;
      const chosen = key === sort.key;
      return {
        // The direction is spelled out on the chosen row only: on the others it
        // would be a promise about an order the reader cannot see yet.
        label: chosen ? `${SORT_LABELS[key]} — ${directionLabel(sort)}` : SORT_LABELS[key],
        checkable: 'radio',
        selected: chosen,
        run: () => noteSort.setKey(captured),
      };
    });
    items.push({
      label: 'Reverse order',
      checkable: 'checkbox',
      selected: sort.reversed,
      run: () => noteSort.toggleReversed(),
    });
    return items;
  });

  /**
   * The Appearance menu, and which of its three panels is showing.
   *
   * One `RowActions` and a level, rather than three components: the panels
   * replace each other in the same sheet, which on a phone is the same
   * gesture as any other menu and on a desktop is the same anchored panel the
   * sort menu already is.
   *
   * The root's rows are plain actions, so the menu correctly does *not* claim
   * `role="menu"` — that belongs to a panel whose every row carries a state.
   * The two leaves do, and they are separate panels for that reason rather
   * than one list with a rule across it: two radio groups flattened into one
   * menu read to a screen reader as one group of ten, which is worse than
   * either menu alone.
   *
   * The root labels carry the current values, so this is also where the phone
   * finally gets the numeric text size the topbar pill has always had.
   */
  let appearanceLevel = $state<'root' | 'font' | 'size' | 'wrap' | null>(null);

  /** One radio row per wrap mode: the Appearance leaf and the topbar picker. */
  const wrapMenuItems = $derived.by((): readonly RowAction[] =>
    LINE_WRAP_CHOICES.map((mode) => {
      const captured = mode;
      return {
        label: mode === 'window' ? `${lineWrapLabel(mode)} — default` : lineWrapLabel(mode),
        checkable: 'radio' as const,
        selected: mode === lineWrap.mode,
        run: () => lineWrap.set(captured),
      };
    }),
  );

  const appearanceMenu = $derived.by((): { heading: string; items: readonly RowAction[] } => {
    if (appearanceLevel === 'font') {
      return {
        heading: 'Editor font',
        items: FONT_CHOICES.map((choice) => {
          const captured = choice;
          return {
            label: FONT_LABELS[choice],
            checkable: 'radio' as const,
            selected: choice === editorFont.choice,
            run: () => editorFont.set(captured),
          };
        }),
      };
    }
    if (appearanceLevel === 'size') {
      return {
        heading: 'Text size',
        items: TEXT_SIZES.map((px) => {
          const captured = px;
          return {
            // The default is named on its own row, because "reset" is the one
            // thing the ladder cannot say by itself.
            label: px === DEFAULT_TEXT_SIZE ? `${px} px — default` : `${px} px`,
            checkable: 'radio' as const,
            selected: px === textSize.px,
            run: () => textSize.set(captured),
          };
        }),
      };
    }
    if (appearanceLevel === 'wrap') {
      return { heading: 'Line wrap', items: wrapMenuItems };
    }
    const items: RowAction[] = [
      { label: `Editor font — ${FONT_LABELS[editorFont.choice]}`, run: () => (appearanceLevel = 'font') },
      { label: `Text size — ${textSize.px} px`, run: () => (appearanceLevel = 'size') },
      { label: `Line wrap — ${lineWrap.label}`, run: () => (appearanceLevel = 'wrap') },
    ];
    // Only while there is something to go back from: see `src/ui/theme.ts`.
    if (theme.pinned) {
      items.push({ label: 'Follow my system theme', run: () => theme.followSystem() });
    }
    return { heading: 'Appearance', items };
  });

  /**
   * The row an open `⋯` belongs to, as a plain value rather than `$state`: the
   * menu's `onClosed` runs after it has gone, by which time everything
   * reactive that named the row has already fallen back to null.
   */
  let menuRow: { kind: 'note' | 'folder'; id: string } | null = null;

  function focusMenuRow(): void {
    if (menuRow) focusRowMore(menuRow.kind, menuRow.id);
  }

  /**
   * The row's `⋯`, which every dialog opened from a row hands the keyboard back
   * to. Hidden until hovered or focused, and `.row-action:focus-visible` is
   * what makes it visible again once it has the keyboard. The lookup is allowed
   * to find nothing: the row may have left the list, or been virtualized away.
   */
  function focusRowMore(kind: 'note' | 'folder', id: string): void {
    document
      .querySelector<HTMLButtonElement>(`.more[data-${kind}-id="${CSS.escape(id)}"]`)
      // The row lives in a scroll container, so a plain focus() would scroll it
      // back — undoing the very scroll that closed the menu.
      ?.focus({ preventScroll: true });
  }

  /**
   * The name of a folder as the user would say it, for the flash.
   * `null` is the top level, which has no folder to name.
   */
  function destinationName(folderId: string | null): string {
    return folderId ? (workspace.folders.find((f) => f.id === folderId)?.name ?? 'a folder') : 'All notes';
  }

  /**
   * Move a note, say so, and offer it back.
   *
   * Both routes to a move come through here — the dialog and a drag — so the
   * two cannot drift. The flash is doing three jobs at once. It is the app's
   * only `aria-live` region, so it is what announces the move to a screen
   * reader; it carries the Undo that delete, pin, capture and restore already
   * have and a move did not; and it supplies the confirmation the gesture
   * lacks. `moveNote` below explains why the list deliberately does not follow
   * the note to its destination — the row simply leaves, which reads as a
   * disappearance unless something says where it went.
   */
  async function moveNoteTo(id: string, folderId: string | null): Promise<void> {
    const meta = workspace.metaById(id);
    if (!meta || meta.folderId === folderId) return;
    const from = meta.folderId;
    const title = meta.title;
    await workspace.moveToFolder(id, folderId);
    showFlash(`Moved “${title}” to “${destinationName(folderId)}”`, {
      label: 'Undo',
      run: () => void workspace.moveToFolder(id, from),
    });
  }

  /** The same, for a folder re-parented by drag or by the dialog. */
  async function moveFolderTo(id: string, parentId: string | null): Promise<void> {
    const folder = workspace.folders.find((f) => f.id === id);
    if (!folder || folder.parentId === parentId) return;
    if (!canMoveFolder(workspace.folders, id, parentId)) return;
    const from = folder.parentId;
    const name = folder.name;
    await workspace.moveFolder(id, parentId);
    // Opened so the folder is visible where it landed, as creating one does.
    if (parentId) folderTree.expand(parentId, workspace.folders);
    showFlash(`Moved “${name}” to “${destinationName(parentId)}”`, {
      label: 'Undo',
      run: () => void workspace.moveFolder(id, from),
    });
  }

  async function moveNote(folderId: string | null): Promise<void> {
    const id = moveNoteId;
    moveNoteId = null;
    if (id) await moveNoteTo(id, folderId);

    // Deliberately not following the note to its destination: while a folder is
    // active the row simply leaves the list, which looks like a disappearance
    // but is the confirmation that the move happened. Re-pointing
    // `activeFolderId` would yank the user out of the folder they are working
    // in, which is the worse surprise.
    await restoreMoveFocus(id);
    moveReturn = 'row';
  }

  /**
   * A folder is only ever made as somewhere to put something, so making one
   * ends where the user was going anyway: inside it, in a blank note, cursor
   * ready. Leaving them on the previous note costs two more clicks to reach
   * the same place.
   *
   * Selected before its write finishes, as a new note is: waiting on
   * encryption and IndexedDB left the folder unhighlighted, and the new note
   * outside it, for a visible moment. The note only needs the folder's id.
   */
  async function addFolder(parentId: string | null = null): Promise<void> {
    const parentName = parentId ? workspace.folders.find((f) => f.id === parentId)?.name : undefined;
    if (parentId && parentName === undefined) return;
    const name = prompt(parentName === undefined ? 'Folder name' : `New folder inside “${parentName}”`);
    if (!name?.trim()) return;

    const { folder } = workspace.addFolder(name, parentId);
    if (parentId) folderTree.expand(parentId, workspace.folders);
    showFolder(folder.id);
    await newNote();
  }

  function renameFolder(id: string): void {
    const folder = workspace.folders.find((f) => f.id === id);
    if (!folder) return;

    // `prompt` to match how a folder is created — a bespoke inline editor
    // would be the only one of its kind in the app.
    const name = prompt('Rename folder', folder.name);
    if (name === null) return;
    void workspace.renameFolder(id, name);
  }

  async function deleteFolder(id: string): Promise<void> {
    const name = workspace.folders.find((f) => f.id === id)?.name ?? 'this folder';
    const { folders, notes } = workspace.folderContents(id);

    // There is no trash and no undo (§23 defers note history), so this one
    // question is the only thing standing between a click and the notes.
    const inside = [
      notes > 0 ? `${notes} note${notes === 1 ? '' : 's'}` : '',
      folders > 0 ? `${folders} subfolder${folders === 1 ? '' : 's'}` : '',
    ].filter(Boolean);

    const message =
      inside.length === 0
        ? `Delete the empty folder “${name}”?`
        : `Delete “${name}” and the ${inside.join(' and ')} inside it?\n\n` +
          'The notes are deleted from all your devices. This cannot be undone.';
    if (!confirm(message)) return;

    await workspace.removeFolder(id);

    // The list filters on this id: left pointing at a folder that no longer
    // exists, it would show an empty pane with no way back.
    if (activeFolderId !== null && !workspace.folders.some((f) => f.id === activeFolderId)) {
      showFolder(null);
    }
  }

  /**
   * Open the note a `[[link]]` names — from the preview's button, a ⌘-click in
   * the editor, or ⌘J ⇧L.
   *
   * A title is not an id (`core/notes/links.ts` says why it cannot be), so this
   * is a resolution and it can come back with none or several.
   *
   * **Several opens the most recently edited, and says nothing.** `metas` is in
   * recency order so `[0]` is that note, and two notes called `Untitled` are
   * common enough that a notice on the ordinary case would be worse than the
   * ambiguity.
   *
   * **None offers to create it**, which is the whole reason forward links are
   * worth having here. A link rots whenever the first line of its target is
   * edited, because that is what renames a note; rewriting other notes' bodies
   * from a keystroke is what §7 forbids, so the repair is one tap instead. The
   * flash is the app's only `aria-live` region, so this is announced too.
   */
  function followLink(target: string): void {
    const ids = notesMatching(workspace.metas, target);
    const found = ids[0];
    if (found !== undefined) {
      void workspace.select(found).then(focusEditor);
      return;
    }
    showFlash(`No note titled \u201c${target}\u201d`, {
      label: 'Create',
      run: () => void createTitled(target),
    });
  }

  /**
   * A note whose title is `title`, opened.
   *
   * `# ` because `deriveTitle` strips heading marks, so the heading reads as one
   * and the title comes back exactly as the link asked for — which is what makes
   * the link resolve on the next click.
   */
  async function createTitled(title: string): Promise<void> {
    try {
      const note = await workspace.create(activeFolderId);
      workspace.update(note.id, `# ${title}\n\n`);
      await tick();
      await workspace.select(note.id);
      await tick();
      focusEditor();
    } catch {
      showFlash('That note could not be created');
    }
  }

  async function pickFromFinder(id: string): Promise<void> {
    finderOpen = false;
    await workspace.select(id);
    focusEditor();
  }

  /**
   * The previous note, for ⌘J J. Tracked here rather than in the workspace:
   * it is navigation, not data, and "the focused tile's note changed" is
   * exactly what `selectedId` already reports — tile focus changes included.
   */
  let currentNoteId: string | null = null;
  let previousNoteId = $state<string | null>(null);
  $effect(() => {
    const id = workspace.selectedId;
    if (!id || id === currentNoteId) return;
    if (currentNoteId) previousNoteId = currentNoteId;
    currentNoteId = id;
  });

  /** The note a ⌘J action means: the highlighted row in the list, else the open note. */
  function targetNoteId(): string | null {
    return listActiveId ?? workspace.selectedId;
  }

  const noticeShowing = $derived(
    workspace.warning !== null ||
      showLocalOnlyNotice ||
      showBackupReminder ||
      syncStore.conflicts.length > 0,
  );

  /** Whether a command can do anything right now. Hidden from the palette when not. */
  function available(id: string): boolean {
    const command = COMMANDS.find((c) => c.id === id);
    if (command?.desktopOnly && mobile.matches) return false;
    const tiles = workspace.panes.length;
    const hasNote = workspace.selectedId !== null;

    if (id.startsWith('tile-') && id !== 'tile-prev' && id !== 'tile-next') {
      return tiled && Number(id.slice(5)) <= tiles;
    }
    switch (id) {
      case 'tile-prev':
      case 'tile-next':
      case 'close-tile':
      case 'cycle-layout':
        return tiled;
      // A way back, so it is offered only while there is something to go back
      // from — otherwise it is a third state pretending to be an action, which
      // is the thing `src/ui/theme.ts` argues against.
      case 'theme-system':
        return theme.pinned;
      case 'view-cycle':
      case 'view-edit':
      case 'view-split':
      case 'view-preview':
        return hasNote;
      case 'copy-note':
      case 'move-note':
      case 'pin-note':
      case 'delete-note':
      case 'export-note':
      case 'share-note':
      case 'note-history':
        return targetNoteId() !== null;
      case 'previous-note':
        return previousNoteId !== null && workspace.metaById(previousNoteId) !== undefined;
      case 'rename-folder':
      case 'delete-folder':
      case 'new-subfolder':
      case 'move-folder':
        return activeFolderId !== null;
      case 'go-to-folder':
        return workspace.folders.length > 0;
      // Nothing to pick from until the index has read the notes, and nothing
      // to pick at all in a collection where nobody has written a tag.
      case 'go-to-tag':
        return workspace.search.tags.length > 0;
      case 'dismiss':
        return noticeShowing;
      default:
        return true;
    }
  }

  /** A short confirmation for commands with nothing else to show, e.g. copy. */
  let flash = $state<{ message: string; action?: FlashAction } | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  interface FlashAction {
    label: string;
    run: () => void;
  }

  /**
   * With an action (Undo) the flash stays long enough to reach for it, and
   * hovering or focusing it holds it there.
   */
  function showFlash(message: string, action?: FlashAction): void {
    flash = action ? { message, action } : { message };
    armFlashTimer();
  }

  function armFlashTimer(): void {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), flash?.action ? 6000 : 1400);
  }

  function openFinder(mode: 'notes' | 'beside' | 'commands'): void {
    finderMode = mode;
    finderOpen = true;
  }

  async function focusTile(index: number): Promise<void> {
    workspace.focusPane(index);
    await tick();
    focusEditor();
  }

  /** Every command, whether from a shortcut or the palette, runs through here. */
  async function run(id: string): Promise<void> {
    const pane = workspace.focusedIndex;
    const fromList = listActiveId !== null;

    switch (id) {
      case 'find':
        return openFinder('notes');
      case 'palette':
        return openFinder('commands');
      case 'beside':
        return openFinder('beside');
      case 'new-note':
        return newNote();
      case 'previous-note':
        if (!previousNoteId) return;
        await workspace.select(previousNoteId);
        return focusEditor();
      // Deliberately ungated in `available()`: whether the caret is in a link is
      // not a Svelte dependency — it lives in the editor's syntax tree — so
      // `paletteCommands` and `leaderGroups`, which derive from an explicit
      // dependency list, would offer or hide this on a stale caret. A command
      // that vanishes on stale information is worse than one that explains
      // itself, which is the argument the sidebar's Shared links icon makes.
      case 'follow-link': {
        const link = linkAtFocusedCursor();
        if (!link) {
          showFlash('The cursor is not on a note link');
          return;
        }
        followLink(link.target);
        return;
      }
      case 'copy-note': {
        const target = targetNoteId();
        if (!target) return;
        copyNoteWithFlash(target);
        return;
      }
      case 'share-note': {
        const target = targetNoteId();
        if (!target) return;
        openShare(target);
        return;
      }
      case 'shared-links':
        openShare(null);
        return;
      case 'move-note': {
        const target = targetNoteId();
        if (!target) return;
        moveReturn = fromList ? 'list' : 'editor';
        moveNoteId = target;
        return;
      }
      case 'pin-note': {
        const target = targetNoteId();
        if (!target) return;
        const meta = workspace.metaById(target);
        await togglePin(target);
        // From the keyboard the row may be off screen, or the note not open at
        // all; say what happened, and offer the way back.
        if (meta) {
          const verb = meta.pinnedAt === null ? 'Pinned' : 'Unpinned';
          showFlash(`${verb} “${meta.title}”`, { label: 'Undo', run: () => void togglePin(target) });
        }
        return;
      }
      case 'delete-note': {
        const target = targetNoteId();
        if (!target) return;
        await deleteNote(target);
        await tick();
        if (fromList) focusNoteList();
        else focusEditor();
        return;
      }
      case 'focus-list':
        if (mobile.matches) workspace.editorOpen = false;
        else revealList();
        await tick();
        focusNoteList();
        return;
      case 'sync':
        // No account panel here: a keyboard save that popped a dialog would be
        // a surprise. The cloud button is the one that offers a way forward.
        showFlash((await syncNow()) ? 'Saved — syncing now' : 'Saved');
        return;
      case 'new-folder':
        return addFolder();
      case 'new-subfolder':
        if (activeFolderId) await addFolder(activeFolderId);
        return;
      case 'move-folder':
        if (activeFolderId) moveFolderId = activeFolderId;
        return;
      case 'go-to-folder':
        goToFolderOpen = true;
        return;
      case 'go-to-tag':
        goToTagOpen = true;
        return;
      case 'rename-folder':
        if (activeFolderId) renameFolder(activeFolderId);
        return;
      case 'delete-folder':
        if (activeFolderId) await deleteFolder(activeFolderId);
        return;
      case 'tile-prev':
        return focusTile((pane - 1 + workspace.panes.length) % workspace.panes.length);
      case 'tile-next':
        return focusTile((pane + 1) % workspace.panes.length);
      case 'close-tile':
        workspace.closePane(pane);
        await tick();
        return focusEditor();
      case 'cycle-layout':
        tiling.cycle();
        return;
      case 'view-cycle': {
        const current = workspace.panes[pane];
        if (current) await setViewMode(pane, nextViewMode(current.mode, { mobile: mobile.matches }));
        return;
      }
      case 'view-edit':
        return setViewMode(pane, 'edit');
      case 'view-split':
        return setViewMode(pane, 'split');
      case 'view-preview':
        return setViewMode(pane, 'preview');
      case 'toggle-sidebar':
        return toggleSidebar();
      case 'toggle-focus':
        return toggleFocus();
      case 'text-bigger':
        return textSize.increase();
      case 'text-smaller':
        return textSize.decrease();
      case 'text-reset':
        return textSize.reset();
      case 'toggle-wrap':
        return lineWrap.toggle();
      case 'toggle-theme':
        return theme.toggle();
      case 'toggle-spellcheck':
        return spellcheck.toggle();
      case 'sort-notes':
        // No anchor: opened from the keyboard or the palette, there is no
        // button to hang it off, so it falls back to the centred sheet.
        sortActions = { anchor: null };
        return;
      case 'theme-system':
        return theme.followSystem();
      case 'appearance':
        appearanceLevel = 'root';
        return;
      case 'account':
        accountOpen = true;
        return;
      case 'export-import':
        return openPortability();
      case 'export-all':
        return exportFromCommand('all');
      case 'export-note':
        return exportFromCommand('note');
      case 'note-history': {
        const target = targetNoteId();
        if (target) openHistory(target);
        return;
      }
      case 'recently-deleted':
        return openRecentlyDeleted();
      case 'dismiss':
        workspace.dismissWarning();
        syncStore.dismissConflicts();
        if (showLocalOnlyNotice) dismissLocalOnly();
        if (showBackupReminder) snoozeBackup();
        return;
      case 'lock':
        return lockNow();
    }
    if (id.startsWith('tile-')) return focusTile(Number(id.slice(5)) - 1);
  }

  const paletteCommands = $derived.by<PaletteCommand[]>(() => {
    // Read so the list re-derives when these change; `available` reads them too.
    void [workspace.panes.length, workspace.selectedId, activeFolderId, previousNoteId, noticeShowing];
    return COMMANDS.filter((c) => c.id !== 'palette' && available(c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      group: c.group,
      keys: keysFor(c),
    }));
  });

  async function runFromPalette(id: string): Promise<void> {
    finderOpen = false;
    await tick();
    await run(id);
    if (!document.activeElement || document.activeElement === document.body) focusEditor();
  }

  async function pickBeside(id: string): Promise<void> {
    finderOpen = false;
    await tileNote(id);
  }

  /**
   * The leader: ⌘J arms it, and the next key either runs a command or cancels.
   * The hint only appears after a pause, so a practised sequence never flashes
   * it on screen.
   */
  let leaderArmed = $state(false);
  let leaderHint = $state(false);
  let leaderTimer: ReturnType<typeof setTimeout> | undefined;

  function armLeader(): void {
    leaderArmed = true;
    clearTimeout(leaderTimer);
    leaderTimer = setTimeout(() => (leaderHint = true), 600);
  }

  function disarmLeader(): void {
    leaderArmed = false;
    leaderHint = false;
    clearTimeout(leaderTimer);
  }

  const leaderGroups = $derived.by(() => {
    void [workspace.panes.length, workspace.selectedId, activeFolderId, previousNoteId, noticeShowing];
    const groups = new Map<string, { key: string; label: string }[]>();
    for (const c of COMMANDS) {
      if (!c.leader || !available(c.id)) continue;
      const rows = groups.get(c.group) ?? [];
      rows.push({ key: formatLeader(c.leader).split(' ')[1]!, label: c.label });
      groups.set(c.group, rows);
    }
    const order = ['Notes', 'Folders', 'Tiles and view', 'App'];
    return [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  });

  /**
   * One capture-phase listener for every app shortcut.
   *
   * Capture, because it has to run before CodeMirror's own keydown handler on
   * the content element: the key after ⌘J is a plain letter, and the editor
   * would otherwise type it into the note. It only swallows keys it acts on,
   * and returns at the first line for an ordinary keystroke — this runs on the
   * typing path (§7).
   */
  function onKeydownCapture(event: KeyboardEvent): void {
    if (leaderArmed) {
      if (isModifierKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      disarmLeader();
      const id = matchLeader(event);
      if (id && available(id)) void run(id);
      return;
    }

    if (!event.metaKey && !event.ctrlKey && event.key !== 'F1') return;
    // Dialogs own the keyboard while they are open; the vault gates the rest.
    if (
      !vaultReady ||
      finderOpen ||
      accountOpen ||
      quickCaptureOpen ||
      removeDataOpen ||
      startOverOpen ||
      vaultSecretsOpen ||
      portabilityOpen ||
      historyNoteId ||
      deletedOpen ||
      moveTarget ||
      goToFolderOpen ||
      goToTagOpen ||
      shareOpen ||
      appearanceLevel ||
      noteActionsTarget ||
      folderActionsTarget ||
      sortActions ||
      wrapActions ||
      moveFolderTarget ||
      moreSheetOpen
    ) {
      return;
    }

    const id = matchChord(event);
    if (!id) return;
    if (id === 'leader') {
      event.preventDefault();
      event.stopPropagation();
      armLeader();
      return;
    }
    if (!available(id)) return;
    event.preventDefault();
    event.stopPropagation();
    void run(id);
  }

  onMount(() => {
    window.addEventListener('keydown', onKeydownCapture, { capture: true });
    // A click means the user has moved on; a leader left armed would eat
    // whatever they type next.
    window.addEventListener('pointerdown', disarmLeader, { capture: true });
    window.addEventListener('blur', disarmLeader);
    // Every drag ends on the window, never on the row it started from: above
    // `VIRTUALIZE_ABOVE` the source `<li>` is destroyed the moment it scrolls
    // out of the window, and `dragend` never reaches a detached node. Bound
    // here, an abandoned drag cannot leave a folder row lit up forever.
    window.addEventListener('dragend', endInternalDrag);
    window.addEventListener('drop', endInternalDrag);
    window.addEventListener('dragenter', onDragEnterCapture, { capture: true });
    window.addEventListener('dragover', onDragOverCapture, { capture: true });
    window.addEventListener('dragleave', onDragLeaveCapture, { capture: true });
    window.addEventListener('drop', onDropCapture, { capture: true });
    window.addEventListener('paste', onPasteCapture, { capture: true });
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('dragend', endInternalDrag);
      window.removeEventListener('drop', endInternalDrag);
      window.removeEventListener('dragenter', onDragEnterCapture, { capture: true });
      window.removeEventListener('dragover', onDragOverCapture, { capture: true });
      window.removeEventListener('dragleave', onDragLeaveCapture, { capture: true });
      window.removeEventListener('drop', onDropCapture, { capture: true });
      window.removeEventListener('paste', onPasteCapture, { capture: true });
      window.removeEventListener('keydown', onKeydownCapture, { capture: true });
      window.removeEventListener('pointerdown', disarmLeader, { capture: true });
      window.removeEventListener('blur', disarmLeader);
    };
  });
</script>

{#if vaultStore.state === 'loading'}
  <!-- Deliberately blank: the vault check is a few milliseconds of IndexedDB,
       and a spinner that flashes for one frame is worse than nothing. -->
  <div class="booting"></div>
{:else if !vaultReady}
  <!-- The update banner is repeated here, above the lock screen, and that is
       not cosmetic. A build swapped in to read someone's notes wants the
       passphrase, so the unlock screen is the one place it is certain to be
       typed — the moment a user most deserves to know the code changed. The
       banner rendered inside `.app` below is invisible here, and a user who
       never gets past this screen would never have seen it at all. -->
  {#if updateStore.available}
    <div class="banner locked-update" role="status">
      <span>A new version of HushJot is ready. It will not run until you apply it.</span>
      <button
        type="button"
        class="banner-action"
        onclick={() => updateStore.apply()}
        disabled={updateStore.applying}
      >
        {updateStore.applying ? 'Applying…' : 'Apply and reload'}
      </button>
      <button type="button" onclick={() => updateStore.dismiss()} aria-label="Dismiss">×</button>
    </div>
  {/if}
  <Unlock
    mode={vaultStore.state === 'empty' ? 'create' : 'unlock'}
    onReady={() => void startWorkspace()}
    onSignedIn={() => void startSync()}
    signedIn={syncStore.signedIn}
    syncAvailable={syncStore.available}
    onRemoveData={openRemoveData}
    onStartOver={openStartOver}
    onResetPassphrase={() => openVaultSecrets('reset-passphrase')}
    resetSeq={passphraseResetSeq}
    {accountVault}
  />
{:else}
<div class="app" class:mobile={mobile.matches}>
  {#if workspace.warning?.kind === 'not-persistent'}
    <!-- Storage-durability honesty: local-only
         text can be evicted, so say so and offer the two fixes a user can
         apply themselves. Hidden once sync makes eviction a cache loss. -->
    <div class="banner durability" role="status">
      <span>
        {workspace.warning.detail}
        {#if installStepsShown && install.hint !== null && install.hint !== 'prompt'}
          <strong class="banner-steps">{INSTALL_STEPS[install.hint]}</strong>
        {/if}
      </span>
      {#if install.hint}
        <!-- Firefox's button does a different thing, so it says a different
             thing: naming an action the browser cannot take is how this
             banner used to tell a Firefox user to install an app. -->
        <button type="button" class="banner-action" onclick={() => void installApp()}>
          {install.hint === 'firefox' ? 'Keep on this device' : 'Install app'}
        </button>
      {/if}
      <button type="button" class="banner-action" onclick={() => void exportFromCommand('all')}>
        Export
      </button>
      <button type="button" onclick={() => workspace.dismissWarning()} aria-label="Dismiss">×</button>
    </div>
  {:else if workspace.warning}
    <div class="banner" role="status">
      <span>{workspace.warning.detail}</span>
      <button type="button" onclick={() => workspace.dismissWarning()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  {#if updateStore.available}
    <!-- The update gate (docs/security.md § "A malicious or coerced host").
         A web app's server hands over its own code on every load, so the one
         thing a browser can offer against a targeted build is that the swap
         is not silent. This banner is that. It is why the wording names a
         version rather than promising an improvement — the user is being
         asked to consent to running different code, not sold a feature. -->
    <div class="banner" role="status">
      <span>
        A new version of HushJot is ready. This device keeps running the
        current one until you apply it.
      </span>
      <button
        type="button"
        class="banner-action"
        onclick={() => updateStore.apply()}
        disabled={updateStore.applying}
      >
        {updateStore.applying ? 'Applying…' : 'Apply and reload'}
      </button>
      <button type="button" onclick={() => updateStore.dismiss()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  {#if showLocalOnlyNotice}
    <div class="banner" role="status">
      <span>
        Your notes are saved on this device only. An account syncs them to your
        other devices.
      </span>
      <button type="button" class="banner-action" onclick={() => (accountOpen = true)}>
        Set up syncing
      </button>
      <button type="button" onclick={dismissLocalOnly} aria-label="Dismiss">×</button>
    </div>
  {/if}

  {#if showBackupReminder}
    <div class="banner" role="status">
      <span>
        {#if syncStore.signedIn && !syncStore.notApproved}
          Sync keeps your devices in step, but it is not a backup. Export a
          copy of your notes to keep somewhere safe?
        {:else}
          Your notes are only in this browser, and clearing browser data deletes
          them. Export a backup?
        {/if}
      </span>
      <button type="button" class="banner-action" onclick={() => void exportFromCommand('all')}>
        Export
      </button>
      <button type="button" onclick={snoozeBackup} aria-label="Remind me later">×</button>
    </div>
  {/if}

  {#if syncStore.planLapsed}
    <!-- The session was ended, so unlike the banner below this one does ask
         for a sign-in — after the renewal, which is the step that fixes it. -->
    <div class="banner warn" role="status">
      <span>
        Your sync plan has ended, so you have been signed out. Your notes are
        still on this device. Renew at hushjot.com/account, then sign in again.
      </span>
      <button type="button" class="banner-action" onclick={() => (accountOpen = true)}>
        Sign in
      </button>
      <button type="button" onclick={() => syncStore.dismissPlanLapsed()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  {#if syncStore.paused && syncStore.signedIn}
    <!-- A cost lockdown (core/sync/pause.ts), not anything about this
         account: no action, no sign-in, no plan link — the plan is fine, and
         a "buy" here is how a paying user ends up with two subscriptions. -->
    <div class="banner" role="status">
      <span>
        Sync is paused for maintenance. Your notes are safe on this device and
        will sync when it resumes.
      </span>
    </div>
  {/if}

  {#if syncStore.notApproved}
    <!-- Deliberately not the "session expired" copy: the credential is fine,
         so telling this user to sign in again would send them round a loop
         that cannot succeed. -->
    <div class="banner warn" role="status">
      <span>
        This account has no active sync plan, so your notes are saved on this
        device only. They are still there — syncing resumes by itself once a
        plan is active (hushjot.com/account).
      </span>
    </div>
  {/if}

  {#if syncStore.vaultOwnsAccount === false}
    <!-- This device holds its own vault and the account already had a
         different one. Neither side can read the other, so nothing is
         uploaded from here — see `core/sync/backfill.ts`. A banner rather than
         a line in the account panel: sync is not working, and a device that
         quietly does not sync is the failure this whole area exists to stop.

         Says "vault", not "passphrase". The two records cannot be shown to be
         one, which is not the same as knowing the passphrase is wrong — and
         this copy used to assert the passphrase every time the app forgot an
         answer it had never written down. Only a settled `false` reaches here;
         every way of failing to find out is `null`. -->
    <div class="banner warn" role="status">
      <span>
        This device's vault is not the one this account was set up with, so its
        notes stay on this device and the account's notes cannot be read here.
        Nothing has been lost on either side. Signing out and back in on a
        device that can already read this account is the way to reconcile them.
      </span>
    </div>
  {/if}

  {#if syncStore.vaultRetired}
    <!-- The account was reset from another device by someone who had lost
         both secrets, and now holds (or is about to hold) a different vault.
         This device can still read its own copy — it is the one place those
         notes survive — so the action is the export-first removal dialog,
         which says that the notes exist nowhere else. Sync stays off here:
         see `retireVault`. -->
    <div class="banner warn" role="status">
      <span>
        This account was reset on another device, so this device no longer
        syncs. Its notes are still here and still open with your old
        passphrase — they exist nowhere else now. Export them if you want to
        keep them, then remove this device's data to start using the account's
        new vault.
      </span>
      <button type="button" class="banner-action" onclick={openRemoveData}>
        Export or remove…
      </button>
    </div>
  {/if}

  {#if syncStore.keyRecordStale}
    <!-- The residue of `Vault.adoptRecord` refusing to replace a record that
         already exists: the account has a newer wrap, this device has its own,
         and nothing can swap them silently — that refusal is what stops a
         hostile or stale server doing exactly that. So it is said out loud
         instead, and the action is the one place the refusal is lifted, on
         proof that both records wrap the same key (`Vault.replaceRecord`).

         Not a warning about data. Nothing is at risk and nothing is
         unreadable; what is wrong is that a passphrase the user was trying to
         retire still opens this device. -->
    <div class="banner warn" role="status">
      <span>
        Your passphrase was changed on another device. This one still opens
        with the old passphrase, and nothing has been lost.
      </span>
      <button
        type="button"
        class="banner-action"
        onclick={() => openVaultSecrets('adopt-record')}
      >
        Use the new passphrase
      </button>
    </div>
  {/if}

  {#if syncStore.foreignOwner}
    <div class="banner warn" role="status">
      <span>
        The notes on this device were made under a different account, so they
        are not being uploaded to this one. They are still here and still
        readable.
      </span>
    </div>
  {/if}

  {#if syncStore.sessionExpired}
    <!-- Sync stopped, editing did not. §17 is explicit that the editor must
         not be disabled because the backend is unavailable. -->
    <div class="banner warn" role="status">
      <span>
        Your sync session expired. Notes are still saved on this device — sign
        in again to resume syncing.
      </span>
      <button type="button" class="banner-action" onclick={() => (accountOpen = true)}>
        Sign in
      </button>
    </div>
  {/if}

  {#if syncStore.conflicts.length > 0}
    <!-- A conflict copy the user never notices is a note they have lost, so
         this says plainly what happened and where the other version went. -->
    <div class="banner warn" role="status">
      <span>
        {syncStore.conflicts.length === 1
          ? 'A note was edited on two devices at once. Both versions were kept — look for “(conflict copy …)” in your notes.'
          : `${syncStore.conflicts.length} notes were edited on two devices at once. Every version was kept — look for “(conflict copy …)” in your notes.`}
      </span>
      <button
        type="button"
        class="banner-action"
        onclick={() => {
          const first = syncStore.conflicts[0];
          if (first) void workspace.select(first.copyId);
          syncStore.dismissConflicts();
        }}
      >
        Show me
      </button>
      <button type="button" onclick={() => syncStore.dismissConflicts()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  {#if mobile.matches}
    <!-- The phone's chrome. The desktop header below is unchanged and simply
         does not render here; the two never style each other. While the chunk
         is still in flight a placeholder holds the height so nothing jumps. -->
    {#if PhoneChrome}
      <PhoneChrome.PhoneHeader
        mode={workspace.editorOpen ? 'editor' : 'list'}
        filterLabel={phoneFilterLabel}
        onFilter={() => (goToFolderOpen = true)}
        onBack={() => {
          workspace.editorOpen = false;
          void tick().then(focusNoteList);
        }}
        viewMode={focusedMode === 'preview' ? 'preview' : 'edit'}
        onViewMode={(next) => void setViewMode(workspace.focusedIndex, next)}
        onNoteMenu={openNoteMenuForOpenNote}
        wrap={typeof lineWrap.mode === 'number' ? 'cols' : lineWrap.mode}
        wrapLabel={lineWrap.label}
        onWrap={() => lineWrap.toggle()}
      >
        {#snippet sync()}
          <SyncIndicator onclick={() => void onCloudClick()} />
        {/snippet}
      </PhoneChrome.PhoneHeader>
    {:else}
      <div class="phone-head-placeholder"></div>
    {/if}
  {:else if !focusMode.on}
  <!-- Focus mode takes the whole topbar. Everything on it is reachable without
       it: the sidebar toggle and the layout cycler are what the mode itself
       just did, Lock is ⌘J Q, Account ⌘J A, the theme ⌘J I and the text size
       ⌘+/−. The one thing it carries that has no chord is `SyncIndicator`, and
       that is why the status bar below stays for `Offline` and `Not synced`. -->
  <header class="topbar">
    {#if mobile.matches && workspace.editorOpen}
      <button type="button" class="back" onclick={() => (workspace.editorOpen = false)}>
        ‹ Notes
      </button>
    {:else}
      <!-- The only way to the sidebar that is not a shortcut, and it sits at
           the far left because that is the column it controls. The guard is
           not the same one as the ‹ Notes button above: this branch also runs
           on a phone showing the list, and there `showListPane` ignores
           `sidebarHidden` entirely — the list and the editor swap places
           instead — so the button would be a control that does nothing. Hence
           `desktopOnly` on the command, and the same test here. The icon draws
           the current state rather than the action, like the layout cycler:
           the left column is filled while the pane is showing. -->
      {#if !mobile.matches}
        <button
          type="button"
          class="icon-btn sidebar-btn"
          onclick={toggleSidebar}
          title="{tiling.sidebarHidden ? 'Show' : 'Hide'} sidebar{hint('toggle-sidebar')}"
          aria-label="{tiling.sidebarHidden ? 'Show' : 'Hide'} sidebar"
          aria-expanded={!tiling.sidebarHidden}
          aria-controls="sidebar-nav"
        >
          <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <rect x="3.5" y="5" width="17" height="14" rx="2" />
            <path d="M9.5 5v14" />
            {#if !tiling.sidebarHidden}
              <path class="panel-fill" d="M5.5 5h4v14h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
            {/if}
          </svg>
        </button>
      {/if}
      <span class="brand">HushJot</span>
    {/if}

    <div class="spacer"></div>

    <!-- One button cycling the three layouts, its icon drawing the current
         one: one pane box, split the way the tiles are. Only while tiles are
         open: with a single note there is nothing for it to arrange, and on a
         phone only one note is ever shown. -->
    {#if tiled}
      <button
        type="button"
        class="layout"
        onclick={() => tiling.cycle()}
        title="Layout: {LAYOUT_LABEL[tiling.layout]} — click to change{hint('cycle-layout')}"
        aria-label="Tile layout: {LAYOUT_LABEL[tiling.layout]}. Change layout"
      >
        <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          {#if tiling.layout === 'vertical'}
            <path d="M12 5v14" />
          {:else if tiling.layout === 'horizontal'}
            <path d="M3.5 12h17" />
          {:else}
            <path d="M12 5v14M3.5 12h17" />
          {/if}
        </svg>
      </button>
    {/if}

    <!-- The icon shows what a click gives you, not what is showing now — and
         because that leaves "what is showing now, and who chose it" unsaid,
         the tooltip's second line and the aria-label say it, and the dot
         marks an override. `src/ui/theme.ts` has the reasoning. -->
    <button
      type="button"
      class="icon-btn theme-btn"
      class:pinned={theme.status.pinned}
      onclick={() => theme.toggle()}
      title={`${theme.status.action}${hint('toggle-theme')}\n${theme.status.state}`}
      aria-label={theme.status.ariaLabel}
    >
      {#if theme.effective === 'dark'}
        <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path
            d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M6.9 6.9 4.8 4.8M17.1 17.1l2.1 2.1M17.1 6.9l2.1-2.1M6.9 17.1l-2.1 2.1"
          />
        </svg>
      {:else}
        <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      {/if}
    </button>

    <!-- Editor text size only: the note list and this bar keep their own sizes,
         which is the whole point of not using browser zoom. -->
    <div class="textsize" role="group" aria-label="Editor text size">
      <button
        type="button"
        class="ts-step"
        onclick={() => textSize.decrease()}
        disabled={!textSize.canDecrease}
        title="Smaller text{hint('text-smaller')}"
        aria-label="Smaller editor text"
      >
        <span aria-hidden="true">−</span>
      </button>
      {#if !mobile.matches}
        <button
          type="button"
          class="ts-value"
          onclick={() => textSize.reset()}
          disabled={textSize.isDefault}
          title="Reset text size{hint('text-reset')}"
          aria-label="Editor text size {textSize.px} pixels — reset"
        >
          {textSize.px}
        </button>
      {/if}
      <button
        type="button"
        class="ts-step"
        onclick={() => textSize.increase()}
        disabled={!textSize.canIncrease}
        title="Larger text{hint('text-bigger')}"
        aria-label="Larger editor text"
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>

    <!-- Line wrap. The icon flips between the window edge and the last measure
         chosen — the one-press route for a table — and the value opens the
         picker. Two cells for two jobs, like the text size beside it. -->
    <div class="textsize wrapsize" role="group" aria-label="Line wrap">
      <button
        type="button"
        class="ts-step wrap-toggle"
        class:active={!lineWrap.isDefault}
        onclick={() => lineWrap.toggle()}
        aria-pressed={!lineWrap.isDefault}
        title="Line wrap: {lineWrap.label} — click to toggle{hint('toggle-wrap')}"
        aria-label="Line wrap: {lineWrap.label}. Toggle"
      >
        {#if lineWrap.mode === 'off'}
          <svg class="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M3.5 7h17M3.5 12h17M16.5 15l3.5 3-3.5 3M3.5 18h16.5" />
          </svg>
        {:else}
          <svg class="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M3.5 6h17M3.5 12h14a3 3 0 0 1 0 6H13M15 16l-2 2 2 2M3.5 18h5" />
          </svg>
        {/if}
      </button>
      <button
        type="button"
        class="ts-value"
        onclick={(event) => (wrapActions = { anchor: event.currentTarget.getBoundingClientRect() })}
        aria-haspopup="menu"
        title="Choose where lines wrap"
        aria-label="Choose line wrap, currently {lineWrap.label}"
      >
        {lineWrap.shortLabel}
      </button>
    </div>

    <button type="button" class="finder" onclick={() => openFinder('notes')} title="Find a note{hint('find')}">
      {#if mobile.matches}
        <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="10.8" cy="10.8" r="6.3" />
          <path d="m15.4 15.4 4.3 4.3" />
        </svg>
        <span class="sr-only">Search notes</span>
      {:else}
        <span>Search</span>
        <kbd>{formatChord('Mod-p')}</kbd>
      {/if}
    </button>

    <button type="button" class="primary" onclick={newNote} title="New note{hint('new-note')}">+ Note</button>

    <!-- Three controls, each doing what its glyph says: the cloud syncs, the
         power glyph opens the account (whose action is signing out), and the
         padlock drops the key for someone walking past the desk. -->
    <SyncIndicator onclick={() => void onCloudClick()} />

    <button
      type="button"
      class="icon-btn acct-btn"
      onclick={() => (accountOpen = true)}
      title="Account and sync{hint('account')}"
      aria-label="Account"
    >
      <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M17.7 6.3a8 8 0 1 1-11.4 0" />
        <path d="M12 2.8v8.6" />
      </svg>
    </button>

    <button
      type="button"
      class="icon-btn lock-btn"
      onclick={lockNow}
      title="Lock{hint('lock')}"
      aria-label="Lock"
    >
      <svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
        <circle class="keyhole" cx="12" cy="15" r="1.1" />
      </svg>
    </button>
  </header>
  {/if}

  <div class="body">
    {#if showListPane}
      <div class="pane list-pane">
        {#if mobile.matches}
          <!-- The phone gets the note list on its own. The desktop Sidebar's
               folder tree and Tags section are two more scrollers competing
               for a 412px column; on a phone they live behind the header's
               filter button instead (§21). Keeping <Sidebar> for desktop
               untouched is also what preserves `#sidebar-tags`, `.folders`
               and `.folder-wrap`, which several benches select into. -->
          <NoteList
            bind:this={phoneListRef}
            notes={visibleNotes}
            selectedId={workspace.selectedId}
            variant="phone"
            rowHeight={PHONE_ROW_HEIGHT}
            {folderNames}
            pinnedCount={visiblePinnedCount}
            dateField={noteSort.dateField}
            onSelect={(id) => void workspace.select(id)}
            onMore={(id, anchor) => {
              menuRow = { kind: 'note', id };
              noteActions = { id, anchor };
            }}
            menuOpenId={noteActionsTarget?.id ?? null}
            onTogglePin={togglePin}
            onDelete={deleteNote}
            onExit={() => {
              workspace.editorOpen = true;
              void tick().then(focusEditor);
            }}
            onActiveChange={(id) => (listActiveId = id)}
          />
        {:else}

        <Sidebar
          bind:this={sidebarRef}
          notes={workspace.metas}
          folders={workspace.folderRoots}
          collapsed={folderTree.collapsed}
          selectedId={workspace.selectedId}
          tiledIds={tiled ? tiledIds : undefined}
          {activeFolderId}
          tags={workspace.search.tags}
          {activeTag}
          {tagNoteIds}
          onSelectTag={showTag}
          countByFolder={workspace.noteCountByFolder}
          onSelect={(id) => void workspace.select(id)}
          onMore={(id, anchor) => {
            menuRow = { kind: 'note', id };
            noteActions = { id, anchor };
          }}
          menuOpenId={noteActionsTarget?.id ?? null}
          folderMenuOpenId={folderActionsTarget?.id ?? null}
          onTile={mobile.matches ? undefined : (id) => void tileNote(id)}
          onTogglePin={togglePin}
          onDelete={deleteNote}
          onSelectFolder={showFolder}
          onAddFolder={() => void addFolder()}
          onAddSubfolder={(id) => void addFolder(id)}
          onFolderActions={(id, anchor) => {
            menuRow = { kind: 'folder', id };
            folderActions = { id, anchor };
          }}
          onPortability={() => openPortability()}
          onRecentlyDeleted={openRecentlyDeleted}
          onSharedLinks={() => openShare(null)}
          onSortNotes={(anchor) => (sortActions = { anchor })}
          onToggleFolder={(id, collapse) =>
            collapse
              ? folderTree.collapse(id, workspace.folders)
              : folderTree.expand(id, workspace.folders)}
          onExitList={() => {
            if (mobile.matches) workspace.editorOpen = true;
            void tick().then(focusEditor);
          }}
          onActiveNoteChange={(id) => (listActiveId = id)}
          onDropNote={(id, folderId) => void moveNoteTo(id, folderId)}
          onDropFolder={(id, parentId) => void moveFolderTo(id, parentId)}
          canMoveFolder={(id, parentId) => canMoveFolder(workspace.folders, id, parentId)}
          folderOfNote={(id) => workspace.metaById(id)?.folderId ?? null}
          parentOfFolder={(id) => workspace.folders.find((f) => f.id === id)?.parentId ?? null}
        />
        {/if}
      </div>
    {/if}

    {#if showEditorPane}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="pane editor-pane"
        onfocusin={mobile.matches ? (event) => {
          // Only the text itself counts. The view switch and the `⋯` are
          // focusable too, and the keyboard is not up for those.
          if ((event.target as HTMLElement | null)?.closest('.cm-content')) editorFocused = true;
        } : undefined}
        onfocusout={mobile.matches ? (event) => {
          if (!(event.target as HTMLElement | null)?.closest('.cm-content')) return;
          // The key bar's buttons preventDefault on pointerdown, so focus never
          // really leaves — but a tap on one still arrives here first. Let the
          // next focusin win before believing the keyboard has gone.
          const next = event.relatedTarget as HTMLElement | null;
          if (next?.closest('.keybar')) return;
          editorFocused = false;
        } : undefined}
      >
        <!-- Tiles. Keyed by pane, so an editor keeps its CodeMirror view and
             undo history when a neighbour closes or the layout changes; the
             layout itself is only a class on this grid. A phone shows the
             focused tile alone. -->
        {#if selected}
          <div class="tiles layout-{tiling.layout}" class:single={!tiled}>
            {#each workspace.panes as pane, i (pane)}
              {#if !mobile.matches || i === workspace.focusedIndex}
                {@const meta = pane.id ? workspace.metaById(pane.id) : undefined}
                {@const mode = modeOf(pane)}
                <section
                  class="tile"
                  class:focused={tiled && i === workspace.focusedIndex}
                  aria-label={meta?.title ?? 'Note'}
                  onfocusin={() => workspace.focusPane(i)}
                  onpointerdown={() => workspace.focusPane(i)}
                >
                  {#if tiled}
                    <header class="tile-head">
                      <span class="tile-title">{meta?.title ?? ''}</span>
                      <button
                        type="button"
                        class="tile-close"
                        title="Close tile{hint('close-tile')}"
                        aria-label="Close {meta?.title ?? 'note'}"
                        onpointerdown={(event) => event.stopPropagation()}
                        onclick={(event) => {
                          event.stopPropagation();
                          workspace.closePane(i);
                        }}
                      >
                        ×
                      </button>
                    </header>
                  {/if}
                  <div class="tile-body mode-{mode}">
                    <!-- Only mount once the body is resident. An editor mounted
                         against a still-loading note would show an empty document
                         and persist it over the real text on the first keystroke. -->
                    {#if pane.ready && EditorComponent}
                      <!-- Hidden, not unmounted, in preview mode: the view keeps
                           each note's undo history and scroll position, and a
                           display:none editor does no work. -->
                      <div class="tile-editor">
                        <EditorComponent
                          bind:this={
                            () => editorRefs.get(pane),
                            (ref) => {
                              if (ref) editorRefs.set(pane, ref);
                              else editorRefs.delete(pane);
                            }
                          }
                          noteId={pane.id}
                          content={pane.content}
                          showGutter={!mobile.matches}
                          autofocus={i === workspace.focusedIndex && mode !== 'preview'}
                          onChange={handleChange}
                          tagSource={tagSource}
                          titleSource={titleSource}
                          onOpenLink={followLink}
                          onCreateNote={(title: string) => void createTitled(title)}
                          onScrollTop={mode === 'split'
                            ? (pos: number) => previewRefs.get(pane)?.scrollToSource(pos)
                            : undefined}
                        />
                      </div>
                      {#if mode !== 'edit' && PreviewComponent}
                        <div class="tile-preview">
                          <PreviewComponent
                            bind:this={
                              () => previewRefs.get(pane),
                              (ref) => {
                                if (ref) previewRefs.set(pane, ref);
                                else previewRefs.delete(pane);
                              }
                            }
                            content={pane.content}
                            onTag={(key: string) => {
                              showTag(key);
                              revealList();
                            }}
                            onToggleTask={(at: number) =>
                              editorRefs.get(pane)?.toggleTaskAt(at) ?? false}
                            onNoteLink={followLink}
                          />
                        </div>
                      {/if}
                    {:else}
                      <div class="empty" aria-busy="true"></div>
                    {/if}
                    <!-- One absolutely placed strip: history beside the view switch.
                         History is its own button, not a fourth mode, because it
                         opens a dialog rather than changing what the tile shows. -->
                    <!-- Desktop only. On a phone this strip is a 26x22px
                         target at 55% opacity floating over the text; the
                         phone header carries the same two modes at 44px. -->
                    {#if !mobile.matches}
                    <div class="tile-tools">
                      <!-- The way out of focus mode for a mouse, and the only
                           one: the topbar is gone, and Escape is not available
                           to take — the shortcut dispatcher returns on its
                           first line for a key with no modifier because it sits
                           on the typing path (§7), and CodeMirror needs
                           Escape for its search panel and for Escape-then-Tab.
                           On the focused tile only, so four tiles do not carry
                           four of these, and at full opacity unlike its
                           neighbours, because an exit nobody can see is the
                           thing `ui/theme.ts` argues against. -->
                      {#if focusMode.on && (!tiled || i === workspace.focusedIndex)}
                        <button
                          type="button"
                          class="tile-history focus-exit"
                          title="Leave focus mode{hint('toggle-focus')}"
                          aria-label="Leave focus mode"
                          onpointerdown={(event) => event.stopPropagation()}
                          onclick={(event) => {
                            event.stopPropagation();
                            toggleFocus();
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                            <path d="M6.5 2.5v4h-4" /><path d="M2 2l4.5 4.5" />
                            <path d="M9.5 13.5v-4h4" /><path d="M14 14L9.5 9.5" />
                          </svg>
                        </button>
                      {/if}
                      {#if pane.id}
                        {@const historyId = pane.id}
                        <button
                          type="button"
                          class="tile-history"
                          title="Note history{hint('note-history')}"
                          aria-label="Show history of {meta?.title ?? 'this note'}"
                          onpointerdown={(event) => event.stopPropagation()}
                          onclick={(event) => {
                            event.stopPropagation();
                            workspace.focusPane(i);
                            openHistory(historyId);
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.2 2.2v2.6h2.6" /><path d="M8 5v3.2l2.2 1.4" />
                          </svg>
                        </button>
                      {/if}
                      <div class="view-switch" role="group" aria-label="View">
                        {#each mobile.matches ? PHONE_SWITCH_MODES : SWITCH_MODES as option (option)}
                          <button
                            type="button"
                            class:active={mode === option}
                            aria-pressed={mode === option}
                            title="{VIEW_MODE_LABEL[option]}{hint(`view-${option}`)}"
                            aria-label={VIEW_MODE_LABEL[option]}
                            onpointerdown={(event) => event.stopPropagation()}
                            onclick={(event) => {
                              event.stopPropagation();
                              void setViewMode(i, option);
                            }}
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                              {#if option === 'edit'}
                                <path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z M9.5 4l2.5 2.5" />
                              {:else if option === 'split'}
                                <rect x="2" y="3" width="12" height="10" rx="1" /><path d="M8 3v10" />
                              {:else}
                                <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" />
                              {/if}
                            </svg>
                          </button>
                        {/each}
                      </div>
                    </div>
                    {/if}
                  </div>
                </section>
              {/if}
            {/each}
          </div>
        {:else if workspace.firstRunPending && syncStore.signedIn}
          <!-- A fresh device that has an account: its notes are on their way,
               and offering "create a note" here invites a stray empty one
               alongside the library about to arrive. -->
          <div class="empty">
            <p>Looking for your notes…</p>
          </div>
        {:else if workspace.initialized}
          <div class="empty">
            <p>No note selected</p>
            <p class="hint-line">
              {formatChord('Mod-p')} to find a note · {formatLeader('?')} for every shortcut
            </p>
            <button type="button" class="primary" onclick={newNote}>Create a note</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if mobile.matches}
    <!-- The tab bar replaces the status bar rather than joining it: 44 + 56 is
         already 13% of a Pixel 7, and the save state it carried is now in the
         phone header, where a thumb can actually reach it. Word and character
         counts go with it — a hand covers that corner anyway. -->
    {#if PhoneChrome && keyBarUp}
      <!-- Replaces the tab bar rather than stacking on it: two bars plus a
           keyboard leaves almost no note on screen, and while the keyboard is
           up the four destinations are not what the thumb is reaching for. -->
      <PhoneChrome.KeyBar
        onAction={(id) => editorRefs.get(workspace.panes[workspace.focusedIndex]!)?.runAccessory(id)}
        onDismiss={() => editorRefs.get(workspace.panes[workspace.focusedIndex]!)?.blurEditor()}
      />
    {:else if PhoneChrome}
      <PhoneChrome.TabBar
        screen={workspace.editorOpen ? 'editor' : 'list'}
        onNotes={() => {
          if (workspace.editorOpen) {
            workspace.editorOpen = false;
            void tick().then(focusNoteList);
          } else {
            showFolder(null);
          }
        }}
        onSearch={() => openFinder('notes')}
        onNew={newNote}
        onMore={() => (moreSheetOpen = true)}
      />
    {/if}
  {:else if showStatusBar(focusMode.on, saveState)}
    <!-- Focus mode hides this bar, with two exceptions: `Offline` and
         `Not synced`. On desktop this is the only place either is said — there
         is no banner for a failing sync, and focus mode has already taken the
         topbar's cloud — so a mode that hid it unconditionally would stop
         honouring "local storage is a cache, sync is the durability
         guarantee". `ui/focusMode.ts` holds the rule. -->
    <StatusBar state={saveState} words={counts.words} chars={counts.chars} />
  {/if}
</div>
{/if}

{#if moveTarget}
  <FolderPicker
    noteTitle={moveTarget.title}
    folders={workspace.folderTree}
    currentFolderId={moveTarget.folderId}
    countByFolder={workspace.noteCountByFolder}
    onPick={(folderId) => void moveNote(folderId)}
    onClose={() => {
      const id = moveNoteId;
      moveNoteId = null;
      void restoreMoveFocus(id).finally(() => (moveReturn = 'row'));
    }}
  />
{/if}

<!-- Both menus read their row through `menuRow`, never through the reactive
     target: `onClosed` runs after the menu has gone, and every item's `run`
     runs after `act()` has closed it, so anything derived from the target is
     null by the time either of them looks. -->
{#if noteActionsTarget && noteActions}
  <!-- `onClosed` only fires when the menu went away without acting: an action
       decides where the keyboard belongs itself (Move hands it back from the
       picker, Delete moves it on), so restoring focus here would fight it. -->
  <RowActions
    heading={noteActionsTarget.title}
    ariaLabel="Note {noteActionsTarget.title}"
    items={noteMenuItems}
    anchor={noteActions.anchor}
    anchored={!mobile.matches}
    onClose={() => (noteActions = null)}
    onClosed={focusMenuRow}
  />
{/if}

{#if folderActionsTarget && folderActions}
  <RowActions
    heading={folderPath(workspace.folders, folderActionsTarget.id)}
    ariaLabel="Folder {folderPath(workspace.folders, folderActionsTarget.id)}"
    items={folderMenuItems}
    anchor={folderActions.anchor}
    anchored={!mobile.matches}
    onClose={() => (folderActions = null)}
    onClosed={focusMenuRow}
  />
{/if}

<!-- The same menu from three places: the sidebar header button, ⌘J z, and the
     palette. Only the first has anything to anchor to. -->
{#if sortActions}
  <RowActions
    heading="Sort notes"
    ariaLabel="Sort the note list"
    items={sortMenuItems}
    anchor={sortActions.anchor}
    anchored={!mobile.matches && sortActions.anchor !== null}
    onClose={() => (sortActions = null)}
  />
{/if}

{#if wrapActions}
  <RowActions
    heading="Line wrap"
    ariaLabel="Line wrap"
    items={wrapMenuItems}
    anchor={wrapActions.anchor}
    anchored={!mobile.matches}
    onClose={() => (wrapActions = null)}
  />
{/if}

<!-- Appearance. Never anchored: there is no button for it on either surface —
     it is reached from ⌘J , the palette, or the phone's More sheet — so the
     centred panel is the only honest placement. A root row closes the menu
     and reopens it on its panel in the same tick (`act()` runs `onClose`
     first), which Svelte batches into one update, so the sheet changes
     contents rather than blinking. -->
{#if appearanceLevel}
  <RowActions
    heading={appearanceMenu.heading}
    ariaLabel={appearanceMenu.heading}
    items={appearanceMenu.items}
    anchor={null}
    anchored={false}
    onClose={() => (appearanceLevel = null)}
  />
{/if}

<!-- The phone's More sheet. Deliberately `RowActions` rather than a new
     component: below 720px it is already a centred, scrimmed sheet of 44px
     rows with arrow-key navigation and the `act()`-closes-before-`run()`
     discipline these menus depend on. A second component would be a second
     copy of all of that. -->
{#if moreSheetOpen && PhoneChrome}
  <RowActions
    heading={workspace.editorOpen ? (selected?.title ?? 'Note') : 'More'}
    ariaLabel="More actions"
    items={moreSheetItems}
    anchored={false}
    onClose={() => (moreSheetOpen = false)}
  />
{/if}

{#if moveFolderTarget}
  <FolderPicker
    heading={`Move “${moveFolderTarget.name}” into`}
    noneLabel="Top level"
    noneCount={workspace.noteCountByFolder.get(null) ?? 0}
    disabledIds={new Set(subtreeIds(workspace.folders, moveFolderTarget.id))}
    folders={workspace.folderTree}
    currentFolderId={moveFolderTarget.parentId}
    countByFolder={workspace.noteCountByFolder}
    onPick={(parentId) => {
      const id = moveFolderId;
      moveFolderId = null;
      if (!id) return;
      void moveFolderTo(id, parentId);
    }}
    onClose={() => (moveFolderId = null)}
  />
{/if}

{#if goToFolderOpen && vaultReady}
  <FolderPicker
    heading="Go to folder"
    noneLabel="All notes"
    noneCount={workspace.metas.length}
    folders={workspace.folderTree}
    currentFolderId={activeFolderId}
    countByFolder={workspace.noteCountByFolder}
    onPick={(folderId) => {
      showFolder(folderId);
      goToFolderOpen = false;
      if (mobile.matches) workspace.editorOpen = false;
      else revealList();
      void tick().then(focusNoteList);
    }}
    onClose={() => {
      goToFolderOpen = false;
      void tick().then(focusEditor);
    }}
  />
{/if}

{#if goToTagOpen && vaultReady}
  <!-- The same dialog as Go to folder: a tag filters the list the way a folder
       does, so picking one should not be a different kind of act. -->
  <FolderPicker
    heading="Go to tag"
    noneLabel="All notes"
    noneCount={workspace.metas.length}
    folders={tagPickerRows}
    currentFolderId={activeTag}
    countByFolder={tagPickerCounts}
    onPick={(key) => {
      goToTagOpen = false;
      if (key === null) showFolder(null);
      else showTag(key);
      revealList();
      void tick().then(focusNoteList);
    }}
    onClose={() => {
      goToTagOpen = false;
      void tick().then(focusEditor);
    }}
  />
{/if}

{#if leaderArmed && leaderHint}
  <div class="leader-hint" role="status" aria-live="polite">
    <div class="leader-head">{formatChord('Mod-j')} then…</div>
    <div class="leader-groups">
      {#each leaderGroups as [group, rows] (group)}
        <section>
          <h3>{group}</h3>
          <ul>
            {#each rows as row (row.key)}
              <li><kbd>{row.key}</kbd><span>{row.label}</span></li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </div>
{:else if flash}
  <div
    class="flash"
    role="status"
    aria-live="polite"
    onpointerenter={() => clearTimeout(flashTimer)}
    onpointerleave={armFlashTimer}
    onfocusin={() => clearTimeout(flashTimer)}
    onfocusout={armFlashTimer}
  >
    <span>{flash.message}</span>
    {#if flash.action}
      <button
        type="button"
        class="flash-action"
        onclick={() => {
          const run = flash?.action?.run;
          flash = null;
          run?.();
        }}
      >
        {flash.action.label}
      </button>
    {/if}
  </div>
{/if}

{#if incomingShare && IncomingShareComponent && vaultReady}
  <!-- Someone followed a share link into the app. Nothing is written until
       this is accepted: an arriving link must not be able to add notes on its
       own, any more than a dropped file can. -->
  <IncomingShareComponent
    title={incomingShare.title}
    body={incomingShare.body}
    busy={incomingBusy}
    onSave={() => void acceptIncomingShare()}
    onDismiss={() => {
      dismissIncomingShare();
      void tick().then(focusEditor);
    }}
  />
{/if}

{#if historyNoteId && HistoryComponent && vaultReady}
  <HistoryComponent
    noteId={historyNoteId}
    onRestore={(text, version, replaced) => {
      const id = historyNoteId;
      if (id) void restoreVersion(id, text, version.at, replaced);
    }}
    onRestoreAsNew={(text, folderId) => void restoreAsNewNote(text, folderId)}
    onClose={() => {
      historyNoteId = null;
      void tick().then(focusEditor);
    }}
  />
{/if}

{#if deletedOpen && DeletedComponent && vaultReady}
  <DeletedComponent
    onRestore={(id) => void undelete(id)}
    onRestoreAsNew={(text, folderId) => void restoreAsNewNote(text, folderId)}
    onClose={() => {
      deletedOpen = false;
      void tick().then(focusEditor);
    }}
  />
{/if}

{#if portabilityOpen && PortabilityComponent && vaultReady}
  <PortabilityComponent
    {activeFolderId}
    noteId={targetNoteId()}
    source={stagedImport}
    dragging={fileDragging}
    onOpenNote={(id) => {
      void workspace.select(id).then(() => tick()).then(focusEditor);
    }}
    onShowFolder={(id) => {
      showFolder(id);
      if (mobile.matches) workspace.editorOpen = false;
    }}
    onClose={() => {
      portabilityOpen = false;
      stagedImport = null;
      backupDue = backupReminderDue();
    }}
  />
{:else if fileDragging && vaultReady}
  <div class="drop-overlay" aria-hidden="true">
    <div class="drop-card">
      <span class="drop-icon">⇩</span>
      <span>Drop to import Markdown, text or .zip files</span>
    </div>
  </div>
{/if}

{#if shareOpen && ShareComponent && vaultReady}
  <ShareComponent
    noteId={shareNoteId}
    onOpenNote={(id) => {
      shareOpen = false;
      void workspace.select(id).then(() => tick()).then(focusEditor);
    }}
    onAccount={() => {
      shareOpen = false;
      accountOpen = true;
    }}
    onClose={() => {
      shareOpen = false;
      shareNoteId = null;
    }}
    onClosed={focusMenuRow}
  />
{/if}

{#if quickCaptureOpen && QuickCaptureComponent}
  <QuickCaptureComponent onClose={() => (quickCaptureOpen = false)} />
{/if}

{#if accountOpen}
  <Account
    vaultUnlocked={vaultReady}
    onChangePassphrase={() => {
      accountOpen = false;
      openVaultSecrets('change-passphrase');
    }}
    onReissueRecoveryCode={() => {
      accountOpen = false;
      openVaultSecrets('reissue-code');
    }}
    onExportImport={() => {
      accountOpen = false;
      openPortability();
    }}
    onSharedLinks={() => {
      accountOpen = false;
      openShare(null);
    }}
    onQuickCapture={() => {
      accountOpen = false;
      openQuickCapture();
    }}
    onSignOut={() => {
      // Closed first: the panel is mounted outside the `vaultReady` gate, so
      // leaving it open would float it over the unlock screen `signOutNow`
      // is about to reveal — which is the bug this whole change is about.
      accountOpen = false;
      void signOutNow();
    }}
    onRemoveData={() => {
      accountOpen = false;
      openRemoveData();
    }}
    onClose={() => {
      accountOpen = false;
      // Signing in on a device with no vault is how it acquires one — but the
      // adoption effect is what does that, on `authSettled`, so this only has
      // to bring sync up for a device that already has its vault.
      void startSync();
    }}
  />
{/if}

<!-- Outside the `vaultReady` gate, deliberately: this is the only exit from
     the unlock screen for someone who has lost both secrets, so it has to be
     able to render over it as well as over the app. -->
<!-- Outside the `vaultReady` gate, like the remove-data dialog and for the
     same reason: `reset-passphrase` is reached from the unlock screen and has
     to render over it. -->
{#if vaultSecretsOpen && VaultSecretsComponent}
  <VaultSecretsComponent
    mode={vaultSecretsMode}
    signedIn={syncStore.signedIn}
    run={runVaultSecretAction}
    republish={republishKeyRecord}
    onClose={() => (vaultSecretsOpen = false)}
  />
{/if}

{#if removeDataOpen && RemoveDataComponent}
  <RemoveDataComponent
    unlocked={vaultReady}
    onClose={() => (removeDataOpen = false)}
    onConfirm={removeLocalData}
  />
{/if}

<!-- Outside the `vaultReady` gate for the same reason as the dialog above:
     it is reached from the unlock screen. -->
{#if startOverOpen && StartOverComponent}
  <StartOverComponent
    email={syncStore.user?.email ?? null}
    run={eraseAccountVault}
    onErased={removeLocalData}
    onRemoveDeviceOnly={() => {
      startOverOpen = false;
      openRemoveData();
    }}
    onClose={() => (startOverOpen = false)}
  />
{/if}

<QuickFinder
  open={finderOpen && vaultReady}
  metas={workspace.metas}
  search={(q: string) => {
    // A sibling tab's writes defer the index rebuild rather than paying for one
    // per second; this is the moment it starts to matter.
    workspace.settleSearchIndex();
    // Folders come along because `in:` names one by name, and the names are
    // sealed — this is the only side that holds them decrypted.
    return workspace.search.query(q, workspace.metas, workspace.folders);
  }}
  mode={finderMode}
  commands={paletteCommands}
  onPick={pickFromFinder}
  onPickBeside={mobile.matches ? undefined : (id) => void pickBeside(id)}
  onRunCommand={(id) => void runFromPalette(id)}
  onClose={() => {
    finderOpen = false;
    // Put the keyboard back rather than leaving it on <body>.
    void tick().then(focusEditor);
  }}
/>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    /* Tracks the visible area when the virtual keyboard opens, so the status
       bar and editor stay on screen instead of being pushed under it (§19). */
    height: 100dvh;
    min-height: 0;
    /* Respect the notch and home indicator on iOS (§19). */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
      env(safe-area-inset-left);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 13px;
  }

  .banner span {
    flex: 1;
  }

  /* On the lock screen there is no `.app` wrapper to sit inside, so this one
     pins itself to the top of the viewport above the centred card. */
  .banner.locked-update {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 5;
    flex-wrap: wrap;
  }

  /* Three buttons do not fit beside the text on a phone. */
  .app.mobile .banner.durability {
    flex-wrap: wrap;
  }

  .app.mobile .banner.durability span {
    flex-basis: 100%;
  }

  .banner-steps {
    display: block;
    margin-top: 2px;
    font-weight: 600;
  }

  .banner.warn {
    background: var(--danger-soft, var(--accent-soft));
    color: var(--text);
  }

  .banner-action {
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    border-radius: 5px;
    padding: 3px 9px;
    cursor: pointer;
    white-space: nowrap;
  }

  .banner > button:last-child {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--header-h);
    flex: 0 0 var(--header-h);
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  /* The bar carries eight controls, and on a phone it was already one short
     of fitting: at 390px the text-size group was the flex child that lost,
     rendering as a − with the + squeezed off the end. The padlock costs
     another 36px, so the name gives way instead — it is the only thing up
     here that is not a control, it is already replaced by ‘‹ Notes’ the
     moment a note is open, and an installed app carries its name on the
     icon. That and the tighter gaps buy back more than the new button
     spends, with every tap target still the size it was; shrinking those is
     what a thumb would notice. Measured: the group wants 71px and had 38. */
  @media (max-width: 420px) {
    .topbar {
      gap: 5px;
      padding: 0 8px;
    }

    .brand {
      display: none;
    }
  }

  .brand {
    font-weight: 600;
    letter-spacing: -0.01em;
    padding: 0 4px;
  }

  .spacer {
    flex: 1;
  }

  .back {
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    padding: 6px 8px;
    margin-left: -4px;
    cursor: pointer;
    min-height: 36px;
  }

  .finder {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-dim);
    font: inherit;
    border-radius: 6px;
    padding: 4px 8px;
    min-height: 30px;
    cursor: pointer;
  }

  .finder:hover {
    background: var(--bg-raised);
    color: var(--text);
  }

  /* One pill, three cells, sharing the .finder treatment so it reads as part of
     the same row of controls rather than a new kind of thing. */
  .textsize {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    border-radius: 6px;
    min-height: 30px;
    overflow: hidden;
  }

  .textsize button {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    padding: 0 9px;
  }

  .textsize button + button {
    border-left: 1px solid var(--border);
  }

  .textsize button:hover:not(:disabled) {
    background: var(--bg-raised);
    color: var(--text);
  }

  .textsize button:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .ts-step span {
    font-size: 15px;
  }

  .ts-value {
    /* Fixed width and tabular figures: the pill must not shift under the cursor
       between one press and the next. */
    min-width: 30px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .wrap-toggle {
    display: grid;
    place-items: center;
  }

  /* Accent while lines are not following the window, so a note that scrolls
     sideways always shows why. */
  .textsize .wrap-toggle.active {
    color: var(--accent);
  }

  @media (hover: none) {
    /* A finger needs more than 9px of padding, but the bar is only 44px tall,
       so the target grows sideways rather than down. */
    .textsize button {
      padding: 0 13px;
    }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    background: var(--bg);
  }

  .primary {
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    border-radius: 6px;
    padding: 4px 10px;
    min-height: 30px;
    cursor: pointer;
    white-space: nowrap;
  }

  .primary:hover {
    background: var(--bg-raised);
    border-color: var(--text-faint);
  }

  .icon-btn {
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-faint);
    font: inherit;
    border-radius: 6px;
    padding: 4px 8px;
    min-height: 30px;
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--bg-sunken);
    color: var(--text);
  }

  /* Every icon in this bar is drawn, not typed, and this is why: the Unicode
     symbols they replaced draw a fraction of their em box, so they cannot be
     sized to match. Measured ink height against this 20px box — ☀ 11px at the
     15px it was set in, ⏻ 11px, ▥ 11px, ⊞ 9px, ⌕ 7px — and reaching parity by
     font-size alone would have wanted 21px type for ⏻ and around 36px for ⌕
     and ⊞, which no 44px bar can hold. One viewBox, one box, one stroke
     weight, matched to SyncIndicator's cloud, is the only thing that makes the
     row read as one set. */
  .ico {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* An icon has no baseline to sit on, so each button centres its box rather
     than letting line-height place it. */
  .sidebar-btn,
  .theme-btn,
  .acct-btn,
  .lock-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* The filled column is state, not ink: at full strength it reads as a
     selected button rather than as a panel that is open. */
  .sidebar-btn .panel-fill {
    fill: currentColor;
    stroke: none;
    opacity: 0.45;
  }

  .theme-btn {
    color: var(--text-dim);
    /* For the dot below; `.icon-btn` is static. */
    position: relative;
  }

  /* The palette follows the OS until it is told not to, and nothing on screen
     used to say which of those you were in. This is that, in the smallest
     mark that can carry it: the tooltip and the aria-label say it in words,
     and a dot is what you can read without hovering. Positioned against the
     button's own padding rather than the icon, so it does not move with the
     sun/moon swap. */
  .theme-btn.pinned::after {
    content: '';
    position: absolute;
    top: 4px;
    right: 4px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .lock-btn .keyhole {
    fill: currentColor;
    stroke: none;
  }

  .booting {
    height: 100%;
    background: var(--bg);
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .pane {
    min-height: 0;
    min-width: 0;
  }

  .list-pane {
    width: var(--sidebar-w);
    flex: 0 0 var(--sidebar-w);
  }

  .editor-pane {
    flex: 1;
  }

  /* The layouts. Equal shares, no splitters: four tiles is a 2×2 at most, and
     a resize handle is a lot of machinery for what a layout switch already
     gives. Borders come from the grid gap showing the background through. */
  .tiles {
    display: grid;
    height: 100%;
    gap: 1px;
    background: var(--border);
  }

  .tiles.single,
  .layout-vertical {
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .layout-horizontal:not(.single) {
    grid-auto-flow: row;
    grid-auto-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
  }

  .layout-grid:not(.single) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(0, 1fr);
  }

  /* Three tiles in a 2×2: the odd one out takes the whole bottom row rather
     than leaving a hole. */
  .layout-grid:not(.single) .tile:nth-child(3):last-child {
    grid-column: span 2;
  }

  .tile {
    /* The container for the split view's narrow-tile query below; a container
       cannot query itself, so it sits here rather than on .tile-body. */
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }

  .tile-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .tile-editor,
  .tile-preview {
    min-width: 0;
    min-height: 0;
  }

  .tile-body.mode-preview .tile-editor {
    display: none;
  }

  .tile-body.mode-split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .tile-body.mode-split .tile-preview {
    border-left: 1px solid var(--border);
  }

  /* A split tile too narrow for two columns of prose stacks them instead. */
  @container (max-width: 480px) {
    .tile-body.mode-split {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: repeat(2, minmax(0, 1fr));
    }

    .tile-body.mode-split .tile-preview {
      border-left: 0;
      border-top: 1px solid var(--border);
    }
  }

  /* The switch floats over the top-right corner, IntelliJ-style, so it costs
     no vertical space and exists in every layout, a single tile included. */
  .tile-tools {
    position: absolute;
    top: 6px;
    right: 14px;
    z-index: 2;
    display: flex;
    gap: 6px;
  }

  .tile-history {
    display: grid;
    place-items: center;
    width: 26px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-raised);
    color: var(--text-dim);
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 120ms;
  }

  .tile-history svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .tile-history:hover,
  .tile-history:focus-visible,
  .tile.focused .tile-history {
    opacity: 1;
  }

  .tile-history:hover {
    color: var(--text);
  }

  /* Not 0.55 like its neighbours: this is the only way out of focus mode for a
     mouse, so it does not wait to be hovered before it can be seen. */
  .tile-history.focus-exit {
    opacity: 1;
    color: var(--text);
  }

  .view-switch {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
    background: var(--bg-raised);
    opacity: 0.55;
    transition: opacity 120ms;
  }

  .view-switch:hover,
  .view-switch:focus-within,
  .tile.focused .view-switch {
    opacity: 1;
  }

  .view-switch button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }

  .view-switch svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }

  .view-switch button + button {
    border-left: 1px solid var(--border);
  }

  .view-switch button:hover {
    color: var(--text);
  }

  .view-switch button.active {
    background: var(--accent-soft);
    color: var(--text);
  }

  .tile-head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    flex: 0 0 24px;
    padding: 0 2px 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-faint);
    font-size: 12px;
  }

  .tile.focused .tile-head {
    color: var(--text);
    background: var(--accent-soft);
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .tile-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile-close {
    width: 22px;
    height: 20px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }

  .tile-close:hover {
    background: var(--bg-raised);
    color: var(--text);
  }

  .layout {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-dim);
    font: inherit;
    line-height: 1;
    border-radius: 6px;
    padding: 0 9px;
    min-height: 30px;
    cursor: pointer;
  }

  .layout:hover {
    background: var(--bg-raised);
    color: var(--text);
  }

  .app.mobile .list-pane,
  .app.mobile .editor-pane {
    flex: 1 1 auto;
    width: 100%;
  }

  /* ---- The phone shell ------------------------------------------------- */

  /* CodeMirror keeps the caret inside the layout viewport, and on iOS that
     viewport does not shrink for the keyboard — so typing near the end of a
     note parks the caret behind the keyboard and the key bar. Growing the
     scrollable content by both is what gives the caret somewhere to be.
     Android measures `--kb-inset` as 0 and only pays the bar's height. */
  .app.mobile .tile-editor :global(.cm-content) {
    padding-bottom: calc(var(--kb-inset, 0px) + var(--keybar-h) + 24px);
  }


  /* The tab bar draws its own safe-area strip so its background runs under the
     home indicator. Leaving `.app`'s bottom inset on as well would push the
     bar up and show a band of page beneath it. The other three sides stay. */
  .app.mobile {
    padding-bottom: 0;
  }

  /* Holds the header's height for the frame or two before the phone chunk
     arrives, so the list does not jump up and back down. */
  .phone-head-placeholder {
    flex: 0 0 auto;
    min-height: 52px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  /* One note, no tiles: the grid's 1px gap draws a stray line down the screen
     when there is nothing to separate. */
  .app.mobile .tiles {
    gap: 0;
    background: var(--bg);
  }

  /* Banners are siblings of the panes, not a group, so there is nothing to cap
     the stack's height on without wrapping them — which would change desktop's
     markup. Compacting each one is what is safe to do here: seven can render
     at once, and at desktop's 13px with 30px buttons that buries a phone. The
     dismiss `×` was ~21x23 and is the one control in the stack a thumb needs. */
  .app.mobile .banner {
    font-size: 12.5px;
    padding: 8px 12px;
  }

  .app.mobile .banner-action {
    min-height: 34px;
    padding: 6px 11px;
  }

  .app.mobile .banner > button:last-child {
    min-width: 40px;
    min-height: 40px;
    font-size: 20px;
  }

  .app.mobile .empty .hint-line {
    display: none;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    color: var(--text-faint);
  }

  .empty p {
    margin: 0;
  }

  .hint-line {
    font-size: 12px;
  }

  /* The leader hint and the flash share a spot: bottom centre, above the
     status bar, never taking focus. */
  .leader-hint,
  .flash {
    position: fixed;
    left: 50%;
    bottom: calc(40px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 70;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
    color: var(--text);
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 3px dashed var(--accent);
    pointer-events: none;
  }

  .drop-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-radius: 10px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    font-size: 15px;
    color: var(--text);
  }

  .drop-icon {
    font-size: 20px;
    color: var(--accent);
  }

  .flash {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
    font-size: 13px;
    white-space: nowrap;
  }

  .flash:has(.flash-action) {
    padding: 4px 6px 4px 14px;
  }

  .flash-action {
    border: 0;
    border-radius: 6px;
    padding: 4px 10px;
    min-height: 28px;
    background: var(--accent-soft);
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .flash-action:hover {
    filter: brightness(0.97);
  }

  .leader-hint {
    width: min(760px, calc(100vw - 32px));
    max-height: 70vh;
    overflow-y: auto;
    padding: 10px 14px 12px;
    font-size: 13px;
  }

  .leader-head {
    color: var(--text-faint);
    font-size: 12px;
    margin-bottom: 6px;
  }

  .leader-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 4px 18px;
  }

  .leader-groups h3 {
    margin: 4px 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .leader-groups ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .leader-groups li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }

  .leader-groups kbd {
    min-width: 18px;
    text-align: center;
  }
</style>
