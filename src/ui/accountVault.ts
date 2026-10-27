/**
 * What this device has been able to learn about the *account's* vault.
 *
 * A type of its own, rather than a union inlined in two components, because it
 * is the answer to a question with a permanent wrong answer. `Vault.create()`
 * mints a fresh random DEK — the passphrase wraps the key, it never derives it
 * — so creating a vault on a device whose account already has one produces the
 * right passphrase and the wrong vault, for good, and `firestore.rules` refuses
 * deletes. Everything here exists to keep the unlock screen from offering that.
 *
 * A plain `.ts` type module so it erases at build: `bench:size` counts every
 * eager byte on the critical path, and this must cost none.
 */
export type AccountVault =
  /** Nothing to find out — no sync in this build, or nobody signed in. */
  | 'idle'
  /**
   * The question is open, and creating a vault now is unsafe. This covers more
   * than a lookup in flight: it also covers the whole window before Firebase
   * has restored a persisted session, because `connect()` resolves before
   * `authReady` does and a device with an account looks exactly like a device
   * without one until it settles.
   */
  | 'checking'
  /** The account was asked and could not answer. Creating is allowed, loudly. */
  | 'failed'
  /** The account holds no key record, so creating one here is exactly right. */
  | 'none'
  /** This device took the account's key record; the passphrase opens it here. */
  | 'adopted'
  /**
   * Sync is paused (a cost lockdown, `core/sync/pause.ts`), so the account
   * cannot be asked. Unlike `'failed'` this holds the create form shut: the
   * refusal is everyone's, the account very likely has a vault, and the wait
   * ends by itself — the lookup runs again when sync resumes.
   */
  | 'paused';
