/**
 * The two HTML shells must declare the same design tokens.
 *
 * `index.html` paints the app and `s/index.html` paints the share viewer, and
 * both do it from an inline `<style>` so the first paint needs no round trip
 * (§7). That is why the palette exists twice rather than in a shared
 * stylesheet, and duplication that nothing checks is duplication that drifts:
 * a token added for the app and forgotten here renders as `unset` on the
 * viewer, which for a colour means black text on black.
 *
 * Same device as `firestoreIndexes.test.ts` — two files kept in step by a test
 * rather than by everyone remembering.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BEGIN = '/* tokens:begin */';
const END = '/* tokens:end */';

function tokens(file: string): string {
  const html = readFileSync(resolve(process.cwd(), file), 'utf8');
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  expect(start, `${file} has no ${BEGIN} marker`).toBeGreaterThan(-1);
  expect(end, `${file} has no ${END} marker`).toBeGreaterThan(start);
  return html.slice(start + BEGIN.length, end);
}

describe('shell design tokens', () => {
  it('are byte-identical in both shells', () => {
    expect(tokens('s/index.html')).toBe(tokens('index.html'));
  });

  it('actually declare a palette, so an empty match cannot pass', () => {
    const block = tokens('index.html');
    for (const name of ['--bg', '--text', '--border', '--accent', '--danger', '--sans', '--mono']) {
      expect(block).toContain(`${name}:`);
    }
    expect(block).toContain('prefers-color-scheme: dark');
    expect(block).toContain('[data-theme="dark"]');
  });
});
