/**
 * Confirming a `"quoted phrase"`.
 *
 * The index cannot answer this and deliberately never will. Matching a phrase
 * means knowing where each word sits, and storing positions beside the tokens
 * would make the index close enough to the note to rebuild it — which is
 * exactly the property `docs/security.md` claims it does not have. So the split
 * is: the index narrows to notes holding all the phrase's words in any order,
 * and this re-reads those few bodies to see whether the words are adjacent.
 *
 * It lives here, apart from `worker.ts`, because that file is a shell around
 * `self.onmessage` and cannot be imported by a test without running a worker.
 * The body reader is a parameter for the same reason, and because the two
 * callers get their text from different places: the worker decrypts from its
 * own IndexedDB connection, while `@hushjot/cli` already has every note open.
 */
import type { SearchHit } from './index.ts';
import { normalisePhrase, type ParsedQuery } from './query.ts';

/**
 * How many candidate bodies one phrase query may open.
 *
 * Opening a note is ~0.3 ms (read plus decrypt), so this is the difference
 * between a bounded query and one that walks the collection. The loop stops at
 * `limit` verified hits first, so the cap only bites when many notes hold all
 * the words but few hold them adjacently — and then the answer is the best
 * matches rather than every match. A real limit, written down rather than
 * hidden.
 */
export const VERIFY_MAX = 200;

/** Text as a phrase is compared against it: lowercased, whitespace collapsed. */
export type BodyReader = (id: string) => Promise<string | null | undefined>;

/**
 * Keep the candidates whose text really contains the phrases.
 *
 * Candidates arrive score-ordered and this only ever drops them, so the order
 * the caller renders is the order the index chose. Each body is read, tested
 * and dropped; nothing is retained between iterations.
 */
export async function verifyPhrases(
  candidates: readonly SearchHit[],
  { phrases, notPhrases }: ParsedQuery,
  limit: number,
  loadBody: BodyReader,
): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  const examined = Math.min(candidates.length, VERIFY_MAX);

  for (let i = 0; i < examined && out.length < limit; i++) {
    const hit = candidates[i]!;

    let hay: string;
    try {
      hay = normalisePhrase((await loadBody(hit.id)) ?? '');
    } catch {
      // An unreadable body cannot be shown to contain the phrase, so it is not
      // a hit — but it must not take the whole query down with it.
      continue;
    }

    if (phrases.every((p) => hay.includes(p)) && !notPhrases.some((p) => hay.includes(p))) {
      out.push(hit);
    }
    // `hay` is replaced on the next iteration; nothing holds the text.
  }

  return out;
}
