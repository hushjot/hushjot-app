/**
 * Search worker.
 *
 * Spike 3 measured the full index sweep over 10,000 notes at 443 ms — read
 * 54 ms, decode 36 ms, build 353 ms. That is the one operation in the app large
 * enough to be worth a thread of its own, and it is why the encryption worker
 * was dropped while this one was kept (bench/RESULTS.md, design change 3).
 *
 * The worker opens its **own** IndexedDB connection rather than having the main
 * thread ship note bodies across. That avoids copying tens of megabytes through
 * a message channel, and it keeps plaintext off the main thread entirely.
 *
 * Plaintext is discarded as soon as each note is indexed (design change 4):
 * only tokens are retained, so the resident set stays small and the window in
 * which readable text exists stays short (§13).
 *
 * That retention rule is also why a `"quoted phrase"` is answered here rather
 * than by the index. Matching a phrase needs word *positions*, and storing
 * those alongside the tokens would make the index close enough to the note to
 * reconstruct it — which `docs/security.md` says it cannot. So the index
 * narrows to notes holding all the phrase's words, and this file re-reads those
 * few bodies to check they are adjacent, discarding each as the build does. It
 * is the one place that can: it already holds the key and its own connection.
 */
/// <reference lib="webworker" />
import { SearchIndex } from './index.ts';
import { verifyPhrases, VERIFY_MAX } from './phrase.ts';
import { openRepository, type NoteRepository } from '../repo/noteRepository.ts';
import { encryptedCodec } from '../repo/encryptedCodec.ts';
import type { SearchRequest, SearchResponse } from './protocol.ts';

const index = new SearchIndex();
let repo: NoteRepository | undefined;
/**
 * The vault key, sent once by the main thread. `CryptoKey` is
 * structured-cloneable and non-extractable, so the worker can decrypt with it
 * but can no more read its bytes than the main thread can.
 */
let key: CryptoKey | undefined;

function post(message: SearchResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

/** The tag version the page last heard about. */
let sentTagVersion = -1;
let tagTimer: ReturnType<typeof setTimeout> | undefined;
/** False while a build runs, so the page never sees a half-counted list. */
let built = false;

/**
 * Tell the page about tags, if they changed. Coalesced: a save touches one
 * note, but a sync landing or an import upserts many in a burst, and one
 * message after the burst is all the sidebar needs.
 */
function scheduleTags(delay = 50): void {
  if (!built || index.tagVersion === sentTagVersion || tagTimer !== undefined) return;
  tagTimer = setTimeout(() => {
    tagTimer = undefined;
    if (!built || index.tagVersion === sentTagVersion) return;
    sentTagVersion = index.tagVersion;
    post({ type: 'tags', version: sentTagVersion, tags: index.tagSummary() });
  }, delay);
}

async function build(): Promise<void> {
  const started = performance.now();

  // Without the key the repository would fall back to the plaintext codec and
  // silently index decrypted-as-text ciphertext — noise that produces an index
  // with no matches and no error. Refuse instead.
  if (!key) throw new Error('search worker has no key');
  built = false;

  const vaultKey = key;
  repo ??= await openRepository({ codec: encryptedCodec(() => vaultKey) });
  const metas = await repo.loadAllMeta();

  index.clear();

  // Read bodies one at a time rather than with a single getAll(): a getAll over
  // 10,000 notes materialises every body at once, and we only need each one
  // long enough to tokenize it.
  for (const meta of metas) {
    let content = '';
    try {
      content = (await repo.loadBody(meta.id)) ?? '';
    } catch {
      // An unreadable body still leaves the note findable by title.
    }
    index.add({
      id: meta.id,
      title: meta.title,
      content,
      updatedAt: meta.updatedAt,
      folderId: meta.folderId,
    });
    // `content` goes out of scope here; nothing retains it.
  }

  post({
    type: 'ready',
    documents: index.size,
    tokens: index.tokenCount,
    buildMs: Math.round(performance.now() - started),
  });

  built = true;
  scheduleTags(0);
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'build':
        if (message.key) key = message.key;
        await build();
        break;

      case 'upsert':
        index.add(message.doc);
        scheduleTags();
        break;

      case 'remove':
        index.remove(message.id);
        scheduleTags();
        break;

      case 'setFolder':
        // Not an upsert: see `SetFolderRequest`. Tags cannot have changed.
        index.setFolder(message.id, message.folderId);
        break;

      case 'tagIds':
        post({ type: 'tagIds', seq: message.seq, ids: index.idsForTag(message.tag) });
        break;

      case 'query': {
        const limit = message.limit ?? 50;
        const options = {
          folderIds: message.folderIds ? new Set(message.folderIds) : undefined,
          notFolderIds: message.notFolderIds ? new Set(message.notFolderIds) : undefined,
        };
        const { phrases, notPhrases } = message.parsed;
        const store = repo;

        // No repository means `build` has not run, so the index is empty too and
        // there is nothing a phrase could be verified against. Say so by
        // matching nothing rather than by returning unverified candidates,
        // which would be words-in-any-order claiming to be a phrase.
        const hits =
          phrases.length === 0 && notPhrases.length === 0
            ? index.searchParsed(message.parsed, { ...options, limit })
            : !store
              ? []
              : await verifyPhrases(
                  // Candidates, not results: the index has matched the words
                  // and cannot know whether they are adjacent. Ask for more
                  // than the caller wants; most of these will be rejected.
                  index.searchParsed(message.parsed, { ...options, limit: VERIFY_MAX }),
                  message.parsed,
                  limit,
                  (id) => store.loadBody(id),
                );

        post({ type: 'results', seq: message.seq, hits });
        break;
      }
    }
  } catch (error) {
    // Report the shape of the failure, never its data (§29).
    post({
      type: 'error',
      message: error instanceof Error ? error.name : 'search worker failure',
    });
  }
};
