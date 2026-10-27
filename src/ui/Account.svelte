<script lang="ts">
  /**
   * Account panel: sign in and sign out (§18 — email/password only, and kept
   * deliberately lightweight).
   *
   * The form itself lives in `SignInForm.svelte`, shared with the unlock
   * screen. Money is never handled here: the plan is bought and managed on
   * hushjot.com (`billingLinks.ts`), and this panel only says which plan the
   * account has and where to change that.
   *
   * The copy has one job beyond the obvious: make clear that the account and
   * the passphrase are different things. An account moves encrypted bytes
   * between devices; the passphrase is what makes them readable, and we never
   * receive it. Users who assume "sign in" means "recover my notes" are the
   * ones who will be hurt by the recovery design, so it is said here too.
   */
  import { syncStore } from './state/sync.svelte.ts';
  import { syncIndicatorState } from './syncIndicator.ts';
  import { meterView } from './storageMeter.ts';
  import { DAILY_PUSH_LIMIT } from '../core/sync/usage.ts';
  import SignInForm from './SignInForm.svelte';
  import { ACCOUNT_URL, DELETE_ACCOUNT_URL, PADDLE_PORTAL_URL, STORAGE_URL } from './billingLinks.ts';

  interface Props {
    onClose: () => void;
    /** Export and import live in their own dialog; this is a way to it. */
    onExportImport: () => void;
    /**
     * The list of published share links, in its own dialog.
     *
     * It is here rather than on the topbar because it is a rare action, and it
     * is here at all because on a desktop it was previously reachable only
     * from the keyboard — the phone's More sheet is forced to carry every
     * command by `moreItems.test.ts`, and nothing imposes the same on a wide
     * screen. `shortcuts.test.ts` now names where each App command lives.
     */
    onSharedLinks: () => void;
    /**
     * How to send text to HushJot from another app, in its own dialog.
     *
     * Beside the export and share links because it answers the neighbouring
     * question — how do notes get *in* — and here rather than on a command,
     * because it is read once when somebody sets their phone up and never
     * again. A command would owe a home on both the palette and the phone's
     * More sheet for something nobody looks for twice.
     */
    onQuickCapture: () => void;
    /**
     * Signing out is the caller's job, not `syncStore.signOut()`'s. It has to
     * lock the vault too — this panel used to call the store directly, which
     * severed the account and left the notes on screen behind a dialog that
     * did not even close. The caller also owns the ordering, because the
     * teardown has to flush and shut down the workspace in between.
     */
    onSignOut: () => void;
    /** The destructive one, in its own confirmation dialog. */
    onRemoveData: () => void;
    /**
     * The vault's two secrets, each in the shared `VaultSecrets` dialog.
     *
     * Two sentences rather than one line carrying two links: they are two
     * different secrets with two different reasons to be here, and two accent
     * links in one clause read as one link with a break in it — the same
     * reason Shared links got a line of its own above rather than joining the
     * export sentence.
     *
     * They lead the `.data` family rather than following it, because they are
     * about the vault, which is what the panel above them has just finished
     * explaining. "Take your notes anywhere" introduces the export and nothing
     * else, and the danger zone stays last.
     *
     * No command for either, for the reason given above about quick capture: a
     * command owes a home in `shortcuts.ts`, the palette and
     * `mobile/moreItems.ts`, all enforced by tests, for something nobody looks
     * for twice a year. Both belong in this panel.
     */
    onChangePassphrase: () => void;
    onReissueRecoveryCode: () => void;
    /**
     * This panel is mounted outside `App.svelte`'s `vaultReady` gate so it can
     * survive a sign-out, which means it can be on screen over a locked vault.
     * A re-wrap needs only the record and not the key, so it would technically
     * work — but offering it there is offering something the user has no way
     * to verify afterwards, because they cannot see their notes to check.
     */
    vaultUnlocked: boolean;
  }

  let {
    onClose,
    onExportImport,
    onSharedLinks,
    onQuickCapture,
    onSignOut,
    onRemoveData,
    onChangePassphrase,
    onReissueRecoveryCode,
    vaultUnlocked,
  }: Props = $props();

  /** Escape closes the panel, matching the quick finder. */
  function onWindowKeydown(event: KeyboardEvent): void {
    // `defaultPrevented`: a dialog stacked inside the panel closes first.
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  }

  // The plan is a label, re-read each time the panel opens on a signed-in
  // account — cheap (one document), and the only way "renews on" is current
  // after a purchase made in another tab.
  $effect(() => {
    // Not while paused: both reads are refused for everyone, and a refused
    // plan read comes back as "no plan".
    if (syncStore.signedIn && !syncStore.paused) {
      void syncStore.refreshPlan();
      // Two more reads, on opening the panel only: the meter and the allowance.
      void syncStore.refreshUsage();
    }
  });

  const meter = $derived(syncStore.usage ? meterView(syncStore.usage) : null);

  const renewalDate = (until: number): string =>
    new Date(until).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  /**
   * What the account holds, in one phrase. `notApproved` wins over a stale
   * plan because the backend has just refused a write; "Invited" is approved
   * with no plan document, which is what a comped account looks like.
   */
  const planLabel = $derived.by(() => {
    // The plan cannot be read during a pause, and "None" would tell a paying
    // user theirs had lapsed.
    if (syncStore.paused) return 'Unavailable while sync is paused';
    const plan = syncStore.plan;
    if (plan) {
      const kind = plan.plan === 'yearly' ? 'Yearly' : 'Monthly';
      if (plan.active && plan.until > Date.now()) {
        // `until` carries the grace; `periodEnd` is when the plan is really
        // due. Past it and still active means the grace is what is running.
        const due = plan.periodEnd ?? plan.until;
        if (due < Date.now()) return `${kind}, payment overdue — sync stops ${renewalDate(plan.until)}`;
        return `${kind}, renews ${renewalDate(due)}`;
      }
      return `Lapsed on ${renewalDate(plan.until)}`;
    }
    if (syncStore.notApproved) return 'None';
    return 'Invited';
  });

  const hasPlan = $derived(syncStore.plan !== null && syncStore.plan.active && syncStore.plan.until > Date.now());

  let resent = $state(false);
  async function resendVerification(): Promise<void> {
    await syncStore.adapter?.sendVerification().catch(() => {});
    resent = true;
  }

  /** Same words as the top-bar indicator, rather than the engine's raw status. */
  const statusLabel = $derived(
    syncIndicatorState({
      available: syncStore.available,
      signedIn: syncStore.signedIn,
      status: syncStore.status,
      pending: syncStore.pending,
      sessionExpired: syncStore.sessionExpired,
      notApproved: syncStore.notApproved,
      paused: syncStore.paused,
      storageFull: syncStore.storageFull,
      pushLimited: syncStore.pushLimited,
    }).label,
  );
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="panel" role="dialog" aria-modal="true" aria-label="Account" tabindex="-1">
    {#if syncStore.signedIn}
      <h2>Account</h2>
      <p class="lede">Signed in as <strong>{syncStore.user?.email}</strong></p>
      <p class="note">
        Your notes sync as encrypted bytes. The passphrase that makes them
        readable stays on your devices and is never sent to the server.
      </p>

      <dl class="stats">
        <div><dt>Status</dt><dd>{statusLabel}</dd></div>
        <div><dt>Waiting to sync</dt><dd>{syncStore.pending}</dd></div>
        <div><dt>Plan</dt><dd>{planLabel}</dd></div>
        {#if meter}
          <div><dt>Storage</dt><dd>{meter.label}</dd></div>
          <div
            class="meter {meter.level}"
            role="meter"
            aria-label="Synced storage used"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={meter.percent}
          >
            <span style:width="{meter.percent}%"></span>
          </div>
        {/if}
      </dl>

      {#if syncStore.storageFull > 0 || (meter && meter.level !== 'ok')}
        <p class="note storage {syncStore.storageFull > 0 || meter?.level === 'full' ? 'full' : ''}">
          {#if syncStore.storageFull > 0}
            Sync storage is full, so {syncStore.storageFull === 1 ? '1 change is' : `${syncStore.storageFull} changes are`}
            waiting on this device. They are safe here and stay editable; they sync as
            soon as there is room.
          {:else}
            Synced storage is {meter?.percent}% full.
          {/if}
          Deleting notes you no longer need frees space, or
          <a href={STORAGE_URL} target="_blank" rel="noopener">add storage…</a>
        </p>
      {/if}

      {#if syncStore.pushLimited > 0}
        <p class="note storage full">
          Daily sync limit reached, so {syncStore.pushLimited === 1 ? '1 change is' : `${syncStore.pushLimited} changes are`}
          waiting on this device. They are safe here and stay editable. An account may sync
          {DAILY_PUSH_LIMIT.toLocaleString('en-US')} changes a day, and these go once the day rolls over{#if syncStore.pushLimitRetryAt}, after
          {new Date(syncStore.pushLimitRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{/if}.
        </p>
      {/if}

      {#if syncStore.user?.emailVerified === false}
        <p class="note verify">
          Your email address is not verified yet.
          {#if resent}
            Sent — check your inbox.
          {:else}
            <button type="button" class="inline-link" onclick={resendVerification}>Resend the email</button>
          {/if}
        </p>
      {/if}

      {#if syncStore.paused}
        <!-- No "Get sync…" during a pause: the plan cannot be read, so the
             link would be offered to paying users, which is how a second
             subscription gets bought (core/sync/pause.ts). -->
        <p class="note">
          Sync is paused for maintenance. Your notes are safe on this device and
          will sync when it resumes. Your plan is unaffected.
        </p>
      {:else}
      <p class="note billing">
        {#if hasPlan}
          <a href={PADDLE_PORTAL_URL} target="_blank" rel="noopener">Manage subscription…</a>
        {:else}
          <a href={ACCOUNT_URL} target="_blank" rel="noopener">Get sync…</a>
        {/if}
      </p>
      {/if}

      <button type="button" class="secondary" onclick={onSignOut}>
        Sign out
      </button>
      <button type="button" class="link" onclick={onClose}>Close</button>
    {:else if !syncStore.available}
      <h2>Sync is not configured</h2>
      <p class="lede">
        This build has no sync backend, so HushJot is running entirely on this
        device. Everything works; nothing leaves the browser.
      </p>
      <button type="button" class="secondary" onclick={onClose}>Close</button>
    {:else}
      <h2>Sign in</h2>
      <p class="lede">
        An account syncs your encrypted notes between devices. It is not the
        same as your passphrase — signing in alone cannot read your notes.
      </p>

      <SignInForm onSignedIn={onClose} />

      <button type="button" class="link" onclick={onClose}>Continue without an account</button>
    {/if}

    {#if vaultUnlocked}
      <p class="data">
        Your passphrase is what opens your notes.
        <button type="button" class="inline-link" onclick={onChangePassphrase}>
          Change passphrase…
        </button>
      </p>

      <p class="data continued">
        Your recovery code is the other way in.
        <button type="button" class="inline-link" onclick={onReissueRecoveryCode}>
          Re-issue recovery code…
        </button>
      </p>
    {/if}

    <p class="data" class:continued={vaultUnlocked}>
      Your notes are yours to take anywhere.
      <button type="button" class="inline-link" onclick={onExportImport}>Export or import…</button>
    </p>

    <!-- Its own line, under the same divider, because it is the same family —
         where your notes can go — but a different sentence: "take them
         anywhere" introduces the export and nothing else, and two accent links
         sharing one clause read as one link with a line break in it.

         Signed in only, and not merely as tidiness: the share dialog's own
         blocked state offers "Account and sync…", which comes straight back
         here. Offering this on the sign-in screen would be a loop between two
         panels, each telling you to visit the other. -->
    {#if syncStore.signedIn}
      <p class="data continued">
        Notes you have shared by link.
        <button type="button" class="inline-link" onclick={onSharedLinks}>Shared links…</button>
      </p>
    {/if}

    <!-- Ungated, unlike Shared links above: quick capture needs no account and
         works on a local-only vault, so hiding it behind a sign-in would hide
         it from exactly the users it was built for. -->
    <p class="data continued">
      Getting text in from other apps.
      <button type="button" class="inline-link" onclick={onQuickCapture}>Quick capture…</button>
    </p>

    <!-- Last, quiet, and outside the flow of the panel's normal business.
         It belongs here rather than in a settings screen because there is no
         settings screen, and because the sentence above it — take your notes
         anywhere — is the one a user should read first. -->
    <p class="data danger-zone">
      <button type="button" class="inline-link danger" onclick={onRemoveData}>
        Remove all data from this device…
      </button>
      {#if syncStore.signedIn}
        <a class="inline-link danger" href={DELETE_ACCOUNT_URL} target="_blank" rel="noopener">
          Delete account…
        </a>
      {/if}
    </p>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8vh 16px 16px;
    z-index: 60;
  }

  .panel {
    width: min(400px, 100%);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 22px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }

  .lede {
    margin: 0 0 16px;
    color: var(--text-dim);
    line-height: 1.5;
    font-size: 13px;
  }

  .note {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  .stats {
    margin: 0 0 16px;
    display: grid;
    gap: 4px;
    font-size: 13px;
  }

  .stats div {
    display: flex;
    justify-content: space-between;
  }

  .billing {
    margin: 0 0 14px;
  }

  .stats div.meter {
    display: block;
    height: 4px;
    margin: 2px 0 0;
    border-radius: 2px;
    background: var(--bg-sunken);
    overflow: hidden;
  }

  .meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .meter.full span,
  .note.storage.full {
    color: var(--danger);
  }

  .meter.full span {
    background: var(--danger);
  }

  .note.storage a {
    color: var(--accent);
  }

  .billing a {
    color: var(--accent);
    text-decoration: none;
  }

  .billing a:hover,
  .verify .inline-link:hover {
    text-decoration: underline;
  }

  .verify {
    margin-top: -6px;
  }

  a.inline-link {
    display: inline-block;
    margin-left: 8px;
    text-decoration: none;
  }

  dt {
    color: var(--text-dim);
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .secondary {
    width: 100%;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    border-radius: 6px;
    padding: 9px 14px;
    min-height: 40px;
    cursor: pointer;
  }

  .data {
    margin: 14px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
    text-align: center;
  }

  .inline-link {
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    padding: 2px;
    cursor: pointer;
  }

  /* A second line under the first one's divider, rather than a rule of its own. */
  .continued {
    margin-top: 0;
    padding-top: 6px;
    border-top: 0;
  }

  .danger-zone {
    margin-top: 0;
    padding-top: 8px;
    border-top: 0;
  }

  .inline-link.danger {
    color: var(--danger);
  }

  .link {
    display: block;
    width: 100%;
    margin-top: 10px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 6px;
  }
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
      overflow-y: auto;
    }

    .panel {
      width: 100%;
      max-width: none;
      min-height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: calc(22px + env(safe-area-inset-top));
      padding-bottom: calc(22px + env(safe-area-inset-bottom));
    }
  }
</style>
