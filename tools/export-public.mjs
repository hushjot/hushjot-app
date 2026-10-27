#!/usr/bin/env node
/**
 * Write the public copy of this repository into a new directory.
 *
 * The working repository stays private and keeps everything, including the
 * operator's runbooks and business notes. Those live under `private/`, and
 * this is the one place that knows the folder is withheld: a path is public
 * unless it is under `private/`, so a new runbook dropped in there can never
 * be published by forgetting to list it.
 *
 * It exports the **committed** tree (`git archive HEAD`), never the working
 * directory, so an untracked `.env.production`, a build output or a file that
 * was never added cannot ride along. Uncommitted edits are therefore left out
 * too, and the script says so rather than exporting a tree you did not mean.
 *
 * `firebase.json` names the backup function's source, `private/backup`. A
 * self-hoster's `firebase deploy` would fail on a source that is not there, so
 * the public copy drops the `functions` block; hosting and the rules are
 * untouched. `.firebaserc` names the production project, so the public copy
 * gets a placeholder instead: a self-hoster's first `firebase deploy` should
 * ask for their project, not fail on someone else's.
 *
 * Last, it scans every exported file for names that must never appear in the
 * public copy: the operator's personal accounts and the closed-source company
 * behind the billing API. A comment is the easy way for one to slip back in,
 * and the history of the public repository is forever, so a hit deletes the
 * export and fails rather than warning. The names are read from
 * `private/export-forbidden.txt`, since writing them here would publish the
 * very words the check exists to keep out (and fail the check on this file).
 *
 * Usage: npm run export:public -- <empty or new directory>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PRIVATE_DIR = 'private';
const FORBIDDEN_LIST = join(PRIVATE_DIR, 'export-forbidden.txt');

if (!existsSync(FORBIDDEN_LIST)) {
  console.error(`${FORBIDDEN_LIST} is missing: refusing to export without the leak check.`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run export:public -- <empty or new directory>');
  process.exit(1);
}
const out = resolve(target);
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} is not empty. Export into a new directory and copy from there.`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

if (git('status', '--porcelain', '--untracked-files=no').trim()) {
  console.warn('Uncommitted changes are not exported: this is the tree at HEAD.');
}

mkdirSync(out, { recursive: true });
execFileSync('tar', ['-x', '-C', out], {
  input: execFileSync('git', ['archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 }),
});
rmSync(join(out, PRIVATE_DIR), { recursive: true, force: true });

const firebaseJson = join(out, 'firebase.json');
const config = JSON.parse(readFileSync(firebaseJson, 'utf8'));
delete config.functions;
writeFileSync(firebaseJson, `${JSON.stringify(config, null, 2)}\n`);

const firebaserc = join(out, '.firebaserc');
const rc = JSON.parse(readFileSync(firebaserc, 'utf8'));
rc.projects = { default: 'your-project-id' };
writeFileSync(firebaserc, `${JSON.stringify(rc, null, 2)}\n`);

const FORBIDDEN = new RegExp(
  readFileSync(FORBIDDEN_LIST, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'i',
);
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
const hits = [];
for (const file of files(out)) {
  const name = relative(out, file);
  if (FORBIDDEN.test(name)) hits.push(name);
  readFileSync(file, 'latin1').split('\n').forEach((line, i) => {
    if (FORBIDDEN.test(line)) hits.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
if (hits.length > 0) {
  rmSync(out, { recursive: true, force: true });
  console.error('Refusing to export: forbidden names in the public copy.');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log(`Exported ${git('rev-parse', '--short', 'HEAD').trim()} to ${out}, without ${PRIVATE_DIR}/.`);
