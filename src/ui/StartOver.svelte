<script lang="ts">
  /**
   * "Start over" — for a signed-in user who has lost both the passphrase and
   * the recovery code.
   *
   * "Remove all data from this device" alone does not get this user anywhere.
   * The account still holds the old key record, the rules refuse any client a
   * delete of it, and the next sign-in adopts it again: the same unlock screen,
   * forever. So this dialog asks the billing API to erase the account's synced
   * data and leave a tombstone (`src/adapters/firebase/vaultReset.ts`), and only
   * then runs the ordinary device removal. After the reload and a sign-in the
   * account has no vault, and the create form is open.
   *
   * ## What the copy has to get across
   *
   * - **Another device might still open the notes.** "Remember this device"
   *   keeps a usable key without the passphrase, and a device left unlocked is
   *   the one place these notes are still readable. That is the better way out
   *   (export, or change the passphrase there), so it comes first.
   * - **This destroys the account's copy**, not just this device's — but that
   *   copy is ciphertext nobody can open, which is the honest reason it is safe
   *   to offer at all.
   * - **The plan and the sign-in survive.** Otherwise "erase" reads as
   *   "delete my account".
   *
   * ## Two guards, both deliberate
   *
   * The account password, because the API refuses a stale sign-in: a session
   * token from a device left signed in must not be enough to empty an account.
   * And typing the word, because the action is irreversible and a checkbox is a
   * click a hurried user makes without reading.
   *
   * Nothing local is touched until the API has said yes. A failure leaves the
   * device exactly as it was, so the retry is the same button.
   *
   * Lazy-loaded (`App.svelte`), like `RemoveData.svelte`, for the same reason:
   * it is reachable from the unlock screen, which `bench:size` budgets.
   */
  import type { VaultResetFailure } from '../core/sync/adapter.ts';

  interface Props {
    /** The signed-in address, shown so it is clear which account goes. */
    email: string | null;
    /** Ask the backend to erase the account. Resolves null on success. */
    run: (password: string) => Promise<VaultResetFailure | null>;
    /** The account is erased; remove this device's data and reload. */
    onErased: () => void;
    /** Only clean this device, as before. */
    onRemoveDeviceOnly: () => void;
    onClose: () => void;
  }

  let { email, run, onErased, onRemoveDeviceOnly, onClose }: Props = $props();

  const CONFIRM_WORD = 'erase';

  let password = $state('');
  let typed = $state('');
  let working = $state(false);
  let failure = $state<VaultResetFailure | null>(null);

  const ready = $derived(
    password.length > 0 && typed.trim().toLowerCase() === CONFIRM_WORD && !working,
  );

  const MESSAGES: Record<VaultResetFailure, string> = {
    'wrong-password': 'That password is not right for this account.',
    'rate-limited': 'Too many attempts. Wait a few minutes and try again.',
    'reauth-required': 'Your sign-in could not be confirmed in time. Try again.',
    'signed-out': 'You have been signed out. Sign in again, then come back here.',
    unreachable:
      'HushJot could not be reached, so nothing was erased — or not all of it. Check your connection and try again; trying again finishes the job.',
    failed:
      'The account could not be erased. Nothing on this device has changed. Try again, or contact support.',
  };

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented && !working) {
      event.preventDefault();
      onClose();
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    working = true;
    failure = null;
    const result = await run(password);
    if (result === null) {
      // Stays `working`: the removal that follows reloads the page.
      onErased();
      return;
    }
    failure = result;
    working = false;
    if (result === 'wrong-password') password = '';
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && !working && onClose()}
>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="start-over-title" tabindex="-1">
    <h2 id="start-over-title">Start over with a new vault?</h2>

    <p class="lede">
      Without your passphrase or recovery code, nobody can read the notes in
      this account — not you, and not us. Starting over erases them so you can
      set up a new vault with a new passphrase.
    </p>

    <p class="outcome kept">
      <strong>First, check your other devices.</strong>
      If HushJot still opens on another device (one where you chose to remember
      the passphrase), your notes are readable there. Export them, or change
      your passphrase, on that device instead.
    </p>

    <ul class="what">
      <li>All synced notes and folders{email ? ` in ${email}` : ''}</li>
      <li>Their history, and every shared link</li>
      <li>Everything HushJot has stored on this device</li>
    </ul>

    <p class="outcome danger">
      This cannot be undone. Your sign-in and your plan are kept. Any other
      device will stop syncing until you remove its data and unlock it with the
      new passphrase.
    </p>

    <form onsubmit={(e) => void submit(e)}>
      <label for="start-over-password">Account password</label>
      <input
        id="start-over-password"
        type="password"
        bind:value={password}
        autocomplete="current-password"
        disabled={working}
      />

      <label for="start-over-confirm">Type <strong>{CONFIRM_WORD}</strong> to confirm</label>
      <input
        id="start-over-confirm"
        type="text"
        bind:value={typed}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        disabled={working}
      />

      {#if failure}
        <p class="error" role="alert">{MESSAGES[failure]}</p>
      {/if}

      <button type="submit" class="destructive" disabled={!ready}>
        {working ? 'Erasing…' : 'Erase and start over'}
      </button>
    </form>

    <button type="button" class="link" onclick={onRemoveDeviceOnly} disabled={working}>
      Only remove data from this device
    </button>
    <button type="button" class="link" onclick={onClose} disabled={working}>Cancel</button>
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
    z-index: 70;
  }

  .panel {
    width: min(440px, 100%);
    max-height: 84vh;
    overflow-y: auto;
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
    margin: 0 0 12px;
    color: var(--text-dim);
    line-height: 1.5;
    font-size: 13px;
  }

  .what {
    margin: 0 0 14px;
    padding: 10px 12px 10px 28px;
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.7;
  }

  .outcome {
    margin: 0 0 14px;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
  }

  .outcome.kept {
    background: var(--bg-sunken);
    color: var(--text-dim);
  }

  .outcome.kept strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text);
  }

  .outcome.danger {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--text);
  }

  form {
    display: flex;
    flex-direction: column;
  }

  label {
    font-size: 13px;
    margin-bottom: 4px;
  }

  input {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    /* 16px avoids iOS Safari zooming the page on focus (§19). */
    font-size: 16px;
    padding: 9px 10px;
    margin-bottom: 14px;
  }

  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  .error {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--danger);
  }

  .destructive {
    width: 100%;
    border: 1px solid var(--danger);
    background: var(--danger);
    color: #fff;
    font: inherit;
    font-weight: 600;
    border-radius: 6px;
    padding: 9px 14px;
    min-height: 40px;
    cursor: pointer;
  }

  .destructive:disabled {
    opacity: 0.5;
    cursor: default;
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

  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
      overflow-y: auto;
    }

    .panel {
      width: 100%;
      max-width: none;
      max-height: none;
      min-height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: calc(22px + env(safe-area-inset-top));
      padding-bottom: calc(22px + env(safe-area-inset-bottom));
    }
  }
</style>
