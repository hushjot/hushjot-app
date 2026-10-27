/**
 * The contract between `App.svelte` and the lazily-loaded `VaultSecrets.svelte`.
 *
 * A module of its own, and types only, so it compiles to nothing. The dialog
 * must not statically import `App.svelte` and `App.svelte` must not statically
 * import the dialog — either one would land the whole thing in the eager graph
 * that `bench/size.mjs` budgets, which is the entire reason it is loaded
 * lazily.
 *
 * The *operation* lives in `App.svelte` rather than inside the dialog because
 * it is two writes in a load-bearing order — arm the durable retry, re-wrap,
 * then publish — and that order belongs beside `bindVaultToAccount`, which is
 * the other half of it. A dialog that can be closed mid-flight is the wrong
 * owner for a sequence whose whole point is surviving being closed mid-flight.
 */
import type { UnlockError } from './state/vault.svelte.ts';

/**
 * Which flow the dialog opened as.
 *
 * Four, and they are not interchangeable: each is reached from a different
 * place, with a different thing already known about the user, and asks for a
 * different secret. `reset-passphrase` is reached from the unlock screen with
 * the vault still shut; `adopt-record` from a banner on a device that has
 * fallen behind another one.
 */
export type VaultSecretsMode =
  | 'change-passphrase'
  | 'reissue-code'
  | 'reset-passphrase'
  | 'adopt-record';

export type VaultSecretAction =
  | { kind: 'change-passphrase'; current: string; next: string }
  | { kind: 'reset-passphrase'; code: string; next: string }
  | { kind: 'reissue-code'; passphrase: string }
  | { kind: 'adopt-record'; passphrase: string };

/**
 * What happened to the account's copy of the record.
 *
 * Four outcomes rather than a boolean, because the sentence the user needs is
 * different in each case and three of them are not failures. A local-only
 * vault owes the account nothing; a device that does not own the account's
 * record must not write to it; and a device that tried and could not confirm
 * has a retry already armed and should say so rather than apologise.
 */
export type RepublishOutcome =
  /** Written and read back. The account holds these bytes. */
  | 'published'
  /** No backend in this build, or nobody signed in. Nothing was owed. */
  | 'no-account'
  /** Signed in, tried, could not confirm. Retried on the next sync. */
  | 'unreachable'
  /** This device's vault is not the account's, so nothing of ours goes on it. */
  | 'not-owner';

export interface VaultSecretResult {
  ok: boolean;
  /**
   * Taken out of the store and carried here, because `vaultStore.error` is
   * global and the unlock screen renders it — and this dialog can be mounted
   * over that screen. Left in place, a mistyped recovery code here would also
   * accuse the passphrase field behind.
   */
  error: UnlockError | null;
  /** The new recovery code, for `reissue-code` and only on success. */
  code: string | null;
  publish: RepublishOutcome;
}
