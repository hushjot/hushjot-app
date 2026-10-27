/**
 * Publishing a note behind a link, as the app does it.
 *
 * Reached only by dynamic import — from the dialog, and from the handler that
 * opens a link someone sent — so none of it is on the critical path (§28). The
 * decisions about what a link *is* live in `core/share/`; this module is the
 * part that knows about the workspace and the sync adapter.
 *
 * ## Why this is not the contradiction it looks like
 *
 * `portability.ts` opens by saying an export is a download and never a share
 * or an upload. That still holds, and this does not weaken it: an export is
 * **plaintext**, which is the whole point of it (§24 is about lock-in), so the
 * only safe destination is the disk the user pointed at. A share is
 * **ciphertext under a key the network never receives** — the key is in the URL
 * fragment, which browsers do not transmit — so the thing that reaches the
 * backend is no more readable than a synced note is. Different object,
 * different rule. `docs/security.md` § "Sharing a note by link" is the long
 * version.
 *
 * ## Snapshots
 *
 * Publishing seals the note as it stands. Editing it afterwards changes
 * nothing a recipient sees until "Update link", which re-seals under the *same
 * id and the same key*, so a link that has been sent keeps working.
 *
 * ## Where the link's own key lives
 *
 * In two places and no others: the URL the user copied, and — sealed under the
 * vault — the owner's private record of the share. The second is what makes
 * "Shared links" more than a list of things to destroy: without it a link
 * could never be copied again or updated, and not from another device at all.
 * Sealing it costs one envelope and gives the backend nothing, exactly as a
 * note's does. The public document, which anyone holding the id can read,
 * never carries it.
 */
import { workspace } from './state/workspace.svelte.ts';
import { syncStore } from './state/sync.svelte.ts';
import { vaultStore } from './state/vault.svelte.ts';
import { sealText, openText } from '../core/crypto/envelope.ts';
import { recordContext } from '../core/crypto/binding.ts';
import { newShareId, buildShareUrl, type ShareRef } from '../core/share/link.ts';
import { newShareKey, importShareKey, sealShare, openShare, type SharePayload } from '../core/share/payload.ts';
import { expiryAt, type ExpiryTier } from '../core/share/expiry.ts';
import { fetchShare } from '../adapters/firebase/shareRest.ts';
import type { ShareIndexEntry } from '../core/sync/adapter.ts';

export type { ShareIndexEntry };

export interface PublishedShare {
  ref: ShareRef;
  url: string;
  expireAt: number;
}

/** Why sharing is not available right now, or null when it is. */
export function unavailableReason(): string | null {
  if (!syncStore.available) {
    return 'This build has no sync service configured, so there is nowhere to publish a link.';
  }
  if (!syncStore.signedIn) {
    return 'Sharing a link needs an account, because the encrypted note has to be stored somewhere the recipient can reach.';
  }
  return null;
}

async function adapter() {
  const found = syncStore.adapter ?? (await syncStore.connect());
  if (!found) throw new Error('Could not reach the sync service.');
  return found;
}

function payloadFor(id: string, body: string): SharePayload {
  const meta = workspace.metaById(id);
  return { title: meta?.title ?? '', body, updatedAt: meta?.updatedAt ?? Date.now() };
}

/**
 * Publish a note. `ref` re-publishes an existing link in place; omit it for a
 * new one.
 *
 * The body comes from `workspace.bodyOf`, which answers an open note from
 * memory and flushes before reading any other. Either way what is published is
 * what is on screen — reading the database directly would publish a note up to
 * one write-scheduler window stale, and the seconds of typing that a share was
 * made to send are exactly the seconds that would be missing from it.
 */
export async function publish(
  noteId: string,
  tier: ExpiryTier['id'],
  ref?: ShareRef,
): Promise<PublishedShare> {
  const body = await workspace.bodyOf(noteId);
  const target: ShareRef = ref ?? { id: newShareId(), key: (await newShareKey()).encoded };
  const key = await importShareKey(target.key);
  const payload = await sealShare(key, payloadFor(noteId, body));
  const expireAt = expiryAt(tier);
  const sealedKey = await sealText(vaultStore.key(), target.key, recordContext('share-key', target.id));

  await (await adapter()).publishShare(
    { id: target.id, payload, expireAt },
    { id: target.id, noteId, key: sealedKey },
  );

  return { ref: target, url: buildShareUrl(window.location.origin, target), expireAt };
}

/** The link for a share the user already published, rebuilt from their record. */
export async function linkFor(entry: ShareIndexEntry): Promise<PublishedShare> {
  const key = await openText(vaultStore.key(), entry.key, recordContext('share-key', entry.id));
  const ref: ShareRef = { id: entry.id, key };
  return { ref, url: buildShareUrl(window.location.origin, ref), expireAt: entry.expireAt };
}

export async function revoke(id: string): Promise<void> {
  await (await adapter()).revokeShare(id);
}

export async function list(): Promise<readonly ShareIndexEntry[]> {
  return (await adapter()).listShares();
}

/**
 * Open a link someone sent, for "Save to my notes".
 *
 * Deliberately the same two modules the standalone viewer uses, and the same
 * SDK-free fetch: the app has an account and a vault, and neither is any use
 * here — a share is sealed under a key that is not this vault's, and the
 * document is world-readable to whoever holds the id.
 */
export async function openLink(ref: ShareRef): Promise<SharePayload | null> {
  const fetched = await fetchShare(ref.id);
  if (!fetched) return null;
  return openShare(await importShareKey(ref.key), fetched.payload);
}

/** Save an opened share as a new note, and return its id. */
export async function saveToNotes(payload: SharePayload, folderId: string | null): Promise<string> {
  const note = await workspace.create(folderId);
  workspace.update(note.id, payload.body);
  return note.id;
}
