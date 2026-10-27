<script lang="ts">
  /**
   * Email/password sign-in and password reset, shared by the unlock screen and
   * the account panel (§18 — email/password only, and kept deliberately
   * lightweight).
   *
   * One form, two modes, the same two inputs. There is no sign-up here:
   * accounts are created on hushjot.com/account, which is also where the plan
   * is bought, so the two steps a new user needs are on one page and the
   * vault origin loads no third-party script (docs/security.md). Signing in
   * needs a plan or an invitation — `firestore.rules` refuses every byte to
   * an account with neither, and the store signs such an account back out.
   *
   * The ids `account-email` / `account-password` are what the benches drive.
   * They are safe to share because the two hosts never render at once: the
   * unlock screen no longer opens the account panel, and it renders this form
   * only on the sign-in *step* of its wizard.
   *
   * `data-autofocus` is the unlock screen's hook for moving focus into
   * whichever step has just appeared. It is inert in the account panel, which
   * focuses itself.
   */
  import { syncStore } from './state/sync.svelte.ts';
  import { ACCOUNT_URL } from './billingLinks.ts';

  interface Props {
    onSignedIn: () => void;
  }

  let { onSignedIn }: Props = $props();

  type Mode = 'signin' | 'reset';

  let email = $state('');
  let password = $state('');
  let mode = $state<Mode>('signin');
  let localError = $state<string | null>(null);
  /** A sentence that is not an error: the reset mail is on its way. */
  let notice = $state<string | null>(null);

  const errorText = $derived.by(() => {
    if (localError) return localError;
    switch (syncStore.error) {
      case 'invalid-credentials':
        return 'That email and password do not match an account.';
      case 'too-many-requests':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'network':
        return 'Could not reach the sync service. Your notes are still on this device.';
      case 'unknown':
        return 'Something went wrong. Please try again.';
      default:
        return null;
    }
  });

  /**
   * "No plan" is not an error the form can fix, so it is rendered apart from
   * `errorText` with the one link that can.
   */
  const needsPlan = $derived(syncStore.error === 'no-plan');

  const submitLabel = $derived.by(() => {
    if (syncStore.busy) return mode === 'reset' ? 'Sending…' : 'Signing in…';
    return mode === 'reset' ? 'Send reset link' : 'Sign in';
  });

  function switchTo(next: Mode): void {
    mode = next;
    localError = null;
    notice = null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    localError = null;
    notice = null;

    if (!email.includes('@')) {
      localError = 'Enter a valid email address.';
      return;
    }

    if (mode === 'reset') {
      // The same sentence whatever the backend knows about the address.
      if (await syncStore.resetPassword(email)) {
        notice = 'If there is an account for that address, a reset link is on its way.';
        mode = 'signin';
      }
      return;
    }

    if (password.length < 6) {
      localError = 'Passwords must be at least 6 characters.';
      return;
    }

    const ok = await syncStore.signIn(email, password);

    if (ok) {
      password = '';
      onSignedIn();
    }
  }
</script>

<form onsubmit={submit}>
  <label for="account-email">Email</label>
  <input
    id="account-email"
    type="email"
    data-autofocus
    bind:value={email}
    autocomplete="email"
    disabled={syncStore.busy}
  />

  <label for="account-password" class:hidden={mode === 'reset'}>Password</label>
  <input
    id="account-password"
    type="password"
    class:hidden={mode === 'reset'}
    bind:value={password}
    autocomplete="current-password"
    disabled={syncStore.busy}
    tabindex={mode === 'reset' ? -1 : undefined}
  />

  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}
  {#if needsPlan}
    <p class="error" role="alert">
      Sync needs a plan. Get one at
      <a href={ACCOUNT_URL} target="_blank" rel="noopener">hushjot.com/account</a>, then sign in
      here. Your notes are still on this device.
    </p>
  {/if}

  <button type="submit" class="primary" disabled={syncStore.busy}>{submitLabel}</button>
</form>

<div class="switch">
  {#if mode === 'signin'}
    <a class="link" href={ACCOUNT_URL} target="_blank" rel="noopener">Create an account at hushjot.com</a>
    <button type="button" class="link" onclick={() => switchTo('reset')}>Forgot password?</button>
  {:else}
    <button type="button" class="link" onclick={() => switchTo('signin')}>Have an account? Sign in</button>
  {/if}
</div>

<style>
  form {
    display: flex;
    flex-direction: column;
  }

  label {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 5px;
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

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-weight: 600;
    border-radius: 6px;
    padding: 10px 14px;
    min-height: 42px;
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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

  a.link {
    box-sizing: border-box;
    text-align: center;
    text-decoration: none;
  }

  .error {
    margin: 0 0 12px;
    color: var(--danger);
    font-size: 13px;
  }

  .notice {
    margin: 0 0 12px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }

  .error a {
    color: inherit;
    text-decoration: underline;
  }

  .hidden {
    display: none;
  }

  .switch {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .switch .link {
    width: auto;
    flex: 1 1 auto;
  }
</style>
