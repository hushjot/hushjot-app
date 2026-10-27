/**
 * Whether this device may upload the notes it already has.
 *
 * ## Why there is a decision to make at all
 *
 * `Workspace.#queue` used to skip the queue entirely with no account, so
 * everything written during local-only use was invisible to sync forever —
 * signing in after a month of work left that month on the device, behind a
 * green "Saved" indicator. The fix is to sweep what is already stored into the
 * outbound queue on the first sync with an account. But "this note has never
 * been pushed" is not the same claim as "this note is mine to push", and the
 * two were indistinguishable:
 *
 * **Ownership.** `clearSyncState()` wipes the cursor, the per-note anchors and
 * the queue on sign-out, precisely so one user's notes are not pushed into
 * another user's account. It is reached only through `signOut()`, which does
 * nothing when the engine never started, and the session-expiry path did not
 * call it at all. So a sweep keyed on "no anchor" would select the *previous*
 * account's entire library — and a create cannot be taken back: the rules
 * refuse deletes outright. Hence `app:owner`, recorded outside the `sync:`
 * namespace so that sign-out cannot erase the binding it exists to remember.
 *
 * **The vault.** Notes are sealed with this device's data key. If the account
 * already has a *different* key record, everything uploaded is ciphertext no
 * other device on that account can open — and undeletable. Comparison settles
 * this in one direction only: a record carries no identifier, `changePassphrase`
 * re-randomises the salts for the same underlying key, and a successful unwrap
 * proves the passphrase matched rather than that the key did — so *difference*
 * is never demonstrable, while *sameness* is, because identical bytes are one
 * record held in two places. `classifyVault` uses `sameKeyRecord` for exactly
 * that much and no more.
 *
 * The question it is really asking is who owns the account's record — this
 * device published it, adopted it, or neither — and that answer used to live in
 * a variable in a Svelte component, which meant it was re-derived from nothing
 * on every page load. A device that had published the account's own record read
 * back "someone else's record is already there", raised a banner telling the
 * user their passphrase was wrong, and retired its own backfill. Hence
 * `VAULT_ACCOUNT_KEY`: the answer is written down, next to `app:owner` and for
 * the same reason, and it names the account so that signing into a different
 * one still answers no.
 *
 * Pure, so the whole truth table can be tested without a browser or a backend.
 */
import { differentVaults, sameKeyRecord } from '../crypto/keyRecord.ts';

/**
 * Which account's key record this device's vault is.
 *
 * `app:`-namespaced like `app:owner`, and deliberately not `sync:`:
 * `clearSyncState()` deletes every `sync:*` key on sign-out, and a vault does
 * not stop being the account's because the credential was dropped. Signing into
 * a *different* account is handled by the value being a uid rather than a flag.
 */
export const VAULT_ACCOUNT_KEY = 'app:vaultAccount';

/**
 * The account's copy of this device's key record is out of date.
 *
 * Set the moment a re-wrap lands locally — a passphrase changed, a recovery
 * code re-issued — and cleared only once a publish has been written *and read
 * back*. Without it a re-wrap was a purely local event: `classifyVault` below
 * answers the common case from `VAULT_ACCOUNT_KEY` alone and asks the backend
 * nothing, which is exactly right for ownership and was silently wrong for
 * freshness. A bound device never uploaded a key record again, so a passphrase
 * changed here reached the account never, and the CLI and every device signing
 * in later went on being handed the old wrap.
 *
 * `app:`-namespaced for the same reason as `VAULT_ACCOUNT_KEY` and pointedly
 * not `sync:`: `clearSyncState()` deletes every `sync:*` key on sign-out, and a
 * re-wrap does not stop needing to be published because a credential was
 * dropped.
 *
 * A flag, not a copy of the record. The record is already on disk in the
 * vault's own store, and two copies of a key record is two things that can
 * disagree about which one the account should be holding.
 */
export const KEY_RECORD_DIRTY_KEY = 'app:keyRecordDirty';

/**
 * The account this device's vault *used to be*: it was reset elsewhere and
 * now holds a different vault, or a tombstone waiting for one. The value is
 * the uid, like `VAULT_ACCOUNT_KEY`, so signing into another account is
 * unaffected.
 *
 * Written down rather than re-derived because the derivation does not survive
 * a reload. `VAULT_ACCOUNT_KEY` is cleared in the same act (a retired vault
 * must not answer "mine" to `republishKeyRecord`), and an unbound device that
 * finds a tombstone looks exactly like a device furnishing an empty account —
 * which would put the old vault straight back. While this is set for the
 * signed-in account, sync does not start at all on this device.
 *
 * `app:` for the same reason as the other two: a sign-out must not erase it.
 */
export const VAULT_RETIRED_KEY = 'app:vaultRetired';

export type OwnerVerdict =
  /** No account has ever claimed this database. Bind it and sweep. */
  | 'adopt'
  /** Already bound to this account. Normal operation. */
  | 'same'
  /** Bound to a different account: its bookkeeping must go, and nothing is swept. */
  | 'foreign';

/**
 * Compare the database's recorded owner against the account now signed in.
 *
 * Deliberately not a boolean. "Never bound" and "bound to someone else" both
 * mean "do not trust the sync state you find", but only the second one means
 * "throw it away", and collapsing them would either skip a needed wipe or wipe
 * a first-time user's queue out from under them.
 */
export function classifyOwner(
  recorded: string | undefined,
  current: string,
): OwnerVerdict {
  if (recorded === undefined) return 'adopt';
  return recorded === current ? 'same' : 'foreign';
}

export interface BackfillGate {
  owner: OwnerVerdict;
  /**
   * True when this device's vault is demonstrably the account's: it published
   * the key record, or adopted the account's. False when both sides already
   * had one, which cannot be shown to be the same vault and is assumed not to
   * be. Null while the answer is still unknown.
   */
  vaultOwnsAccount: boolean | null;
  /** The durable marker, cleared with the rest of the sync state on sign-out. */
  alreadySwept: boolean;
}

/**
 * Should the sweep run on this sync?
 *
 * Every condition is a refusal to upload rather than a permission to: an
 * unswept backlog is recoverable at any later sync, and notes written into the
 * wrong account, or sealed under a key that account cannot open, are not.
 */
export function shouldSweep(gate: BackfillGate): boolean {
  if (gate.alreadySwept) return false;
  if (gate.owner === 'foreign') return false;
  return gate.vaultOwnsAccount === true;
}

/**
 * A record this device may upload.
 *
 * Tombstones are included: a deletion that never reaches the backend comes
 * back on the next pull, bringing its notes with it (§16). Pre-vault plaintext
 * records are not — `toRemote` refuses to upload them and the push breaker
 * parks them, which would hold the pending count above zero for good.
 */
export function isSweepable(record: { encoded: unknown }): boolean {
  return record.encoded !== undefined && typeof record.encoded !== 'string';
}

/** What `classifyVault` was told. Every field is a value already fetched. */
export interface VaultBindingInput {
  /** `VAULT_ACCOUNT_KEY`, or undefined if this device has never bound one. */
  boundAccount: string | undefined;
  /** The account signed in now. */
  uid: string;
  /**
   * The account's key record: `null` when the account has none, `undefined`
   * when nobody has successfully looked. The two are not the same claim, and
   * collapsing them is what turns an offline device into a foreign one.
   */
  remoteRecord: unknown | null | undefined;
  /** This device's own record, `null` when it has no vault yet. */
  localRecord: unknown | null;
  /** True only when `adoptRecord` actually reported success this session. */
  adoptedThisSession: boolean;
  /**
   * `KEY_RECORD_DIRTY_KEY`: this device has re-wrapped its record and the
   * account has not been told. Read by exactly one branch below — a device
   * that cannot show the account's record is its own has nothing it may
   * publish, dirty or not, and letting the flag reach any other branch would
   * turn the one refusal this module exists for into a permission.
   */
  keyRecordDirty: boolean;
}

export interface VaultBinding {
  /**
   * The answer `shouldSweep` and the banner want. `null` means the question is
   * still open and the next cycle should ask again — never a refusal in
   * disguise.
   */
  owns: boolean | null;
  /** Write `VAULT_ACCOUNT_KEY = uid`, once any `publish` has succeeded. */
  bind: boolean;
  /** Send this device's record to an account that has none. */
  publish: boolean;
}

/**
 * Is this device's vault the account's vault?
 *
 * The order of the cases is the point. A written-down answer comes first, so
 * the common path needs no network at all and an offline device is not told its
 * passphrase is wrong; only then does anything depend on what the backend said.
 *
 * `false` is returned from exactly one branch — both sides hold a record and
 * the two are not the same bytes — because `false` is expensive: it stops the
 * backfill for good and puts a banner on the screen. Everything else that falls
 * short of a `true` returns `null` and gets asked again.
 */
export function classifyVault(input: VaultBindingInput): VaultBinding {
  const { boundAccount, uid, remoteRecord, localRecord, adoptedThisSession, keyRecordDirty } =
    input;

  // Already settled, on a previous run of this very function. Nothing about a
  // reload, a sign-out or a dropped network makes it less true — and this
  // branch still asks the backend nothing, which is the whole point of it.
  //
  // One thing can be outstanding here, and ownership is not it: a passphrase
  // change or a re-issued recovery code re-wraps this device's record, and the
  // account goes on serving the old bytes until somebody sends the new ones.
  // `bind` stays false because the marker is already written and rewriting it
  // would look like a fresh claim.
  if (boundAccount === uid) return { owns: true, bind: false, publish: keyRecordDirty };

  // This device took the account's record, so the two are the same vault by
  // construction. Only reachable when `adoptRecord` succeeded — the earlier
  // version of this set it after an `adoptRecord` whose result it discarded,
  // which claimed a vault it had failed to adopt.
  if (adoptedThisSession) return { owns: true, bind: true, publish: false };

  // Nobody has managed to read the account's record. Offline, or the read
  // threw. The sweep waits rather than guessing.
  if (remoteRecord === undefined) return { owns: null, bind: false, publish: false };

  if (remoteRecord === null) {
    // No vault of our own to offer yet — `startSync` only runs unlocked, so
    // this is defensive. An absence here is not evidence of a foreign vault.
    if (localRecord === null) return { owns: null, bind: false, publish: false };
    // The account is ours to furnish (§31): a second device can then unlock
    // with the same passphrase.
    return { owns: true, bind: true, publish: true };
  }

  // The account has a record and this device has no vault at all. That is not a
  // different vault, it is an adoption that has not happened yet — a malformed
  // record, or a read that landed after the unlock screen. Answering `false`
  // here would put "your passphrase is wrong" in front of a user who has not
  // yet been given a passphrase to get wrong.
  if (localRecord === null) return { owns: null, bind: false, publish: false };

  // Both sides hold one. Identical bytes are one record in two places, which is
  // the only thing comparison can establish — and the thing that heals every
  // device that published or adopted before there was anywhere to write the
  // answer down. See `sameKeyRecord`.
  if (sameKeyRecord(localRecord, remoteRecord)) {
    return { owns: true, bind: true, publish: false };
  }

  // Two records that cannot be shown to be one. Assumed not to be, because the
  // alternative is uploading ciphertext this account can never open into a
  // store whose rules refuse deletes.
  return { owns: false, bind: false, publish: false };
}

/**
 * Is this device's key record older than the account's?
 *
 * The mirror image of the question above, and answerable in one direction only
 * for the same reason. If this device owes the account a publish, a difference
 * proves nothing — we are the newer one. If it owes nothing and the bytes still
 * differ, the account has moved and this device has not: somebody changed the
 * passphrase elsewhere, and this device goes on opening with the old one.
 *
 * Only ever asked on a device that already owns the account's record, so the
 * `sameKeyRecord` caveat does not bite: inequality here is not "a different
 * vault", it is "the same vault, re-wrapped somewhere else". `Vault.adoptRecord`
 * refuses to replace a record that already exists, on purpose, so nothing about
 * this can be repaired automatically — but saying nothing is how the user finds
 * out on the day they need the other device.
 */
export function keyRecordIsStale(input: {
  ownsAccount: boolean;
  keyRecordDirty: boolean;
  localRecord: unknown | null;
  remoteRecord: unknown | null | undefined;
}): boolean {
  if (!input.ownsAccount || input.keyRecordDirty) return false;
  if (!input.localRecord || !input.remoteRecord) return false;
  return !sameKeyRecord(input.localRecord, input.remoteRecord);
}

/**
 * Has the account been emptied since this device last furnished it?
 *
 * Synced data is deleted from the backend when a plan has been lapsed for six
 * months (private/billing.md, "Retention"). The login survives, and so does
 * everything on this device — including `VAULT_ACCOUNT_KEY`, which goes on
 * saying the account's key record is this device's. It was. `classifyVault`
 * answers a bound device from that marker alone, so nothing would ever put the
 * record back: the notes would upload again under a key the account no longer
 * holds, and the next new device would find no vault and create a second one.
 *
 * A bound device finding *no* record is the one thing that can only mean the
 * account was emptied — the rules refuse a delete of the key record to every
 * client, so nothing else removes one. `undefined` is not `null`: nobody
 * having managed to look is not evidence of anything.
 */
export function accountWasReset(input: {
  ownsAccount: boolean;
  localRecord: unknown | null;
  remoteRecord: unknown | null | undefined;
}): boolean {
  return input.ownsAccount && input.localRecord !== null && input.remoteRecord === null;
}

/**
 * Has the account been reset — on purpose, by its owner — since this device
 * bound its vault to it?
 *
 * The sibling of `accountWasReset`, and the answer has to come first, because
 * the two call for opposite repairs. A retention purge leaves *no* key
 * document, and the right response is to put this device's record back. A
 * user who lost both secrets and chose "start over" (`POST /hushjot/vault/
 * reset`, in the billing API) leaves a **tombstone** — `resetAt` and no
 * `record` — and afterwards, once some device creates the new vault, a record
 * with a different `createdAt`. Either way this device's vault is no longer
 * the account's, and the right response is to stop: republishing it would
 * undo the reset, and pushing would seal notes into the new vault under a key
 * it cannot open, where the rules forbid deleting them.
 *
 * Only asked of a bound device. An unbound one finding a tombstone is in the
 * same position as one finding an empty account — `classifyVault` handles
 * it — unless it was bound once and retired, which `VAULT_RETIRED_KEY` says.
 */
export function accountResetElsewhere(input: {
  ownsAccount: boolean;
  localRecord: unknown | null;
  remoteRecord: unknown | null | undefined;
  /** The tombstone's stamp, or null when the key document has none. */
  remoteResetAt: number | null | undefined;
}): boolean {
  if (!input.ownsAccount || input.localRecord === null) return false;
  if (input.remoteRecord === null || input.remoteRecord === undefined) {
    return typeof input.remoteResetAt === 'number';
  }
  return differentVaults(input.localRecord, input.remoteRecord);
}
