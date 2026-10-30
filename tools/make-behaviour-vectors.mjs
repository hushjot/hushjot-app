/**
 * Write `contract/behaviour-vectors.json` from the built core.
 *
 * Unlike `make-format-vectors.mjs` this is safe to run at any time: every case
 * is deterministic, so regenerating changes the file only when behaviour did.
 * See `tools/behaviour-cases.mjs` for what is pinned and why.
 *
 *   npm run vectors:behaviour
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './behaviour-cases.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(resolve(repoRoot, 'dist-core/public.js'));

const out = resolve(repoRoot, 'contract/behaviour-vectors.json');
writeFileSync(out, `${JSON.stringify(build(core), null, 2)}\n`);
console.log(`wrote ${out}`);
