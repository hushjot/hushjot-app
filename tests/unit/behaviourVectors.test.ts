/**
 * The behaviour contract, asserted from this side.
 *
 * `contract/behaviour-vectors.json` pins derivations a second client must
 * reproduce exactly — the query grammar, tags, folder resolution, list order,
 * search ranking, titles and excerpts, the meter. The Rust SDK asserts the
 * same file against its port. This test rebuilds every case from the live
 * core and compares, so a behaviour change cannot land without the committed
 * file changing with it; that diff is what tells the other clients.
 *
 * When this fails: if the change was intended, run `npm run vectors:behaviour`
 * and commit the file. Unlike the format vectors, regenerating is always safe
 * here — nothing in it is random.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as core from '../../src/core/public.ts';
// @ts-expect-error — a plain .mjs module shared with the generator script.
import { build } from '../../tools/behaviour-cases.mjs';

const committed = JSON.parse(readFileSync(resolve(__dirname, '../../contract/behaviour-vectors.json'), 'utf8'));
const live = JSON.parse(JSON.stringify(build(core)));

describe('behaviour vectors', () => {
  for (const section of Object.keys(live)) {
    it(`${section} matches the committed contract`, () => {
      expect(live[section]).toEqual(committed[section]);
    });
  }

  it('covers every committed section', () => {
    expect(Object.keys(live).sort()).toEqual(Object.keys(committed).sort());
  });
});
