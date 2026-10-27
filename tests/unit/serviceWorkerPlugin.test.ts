/**
 * The service-worker manifest must cover *both* shells.
 *
 * Neither HTML document is content-hashed, so `BUILD_VERSION` is the only
 * thing that can notice one of them changing. When there was one shell that
 * was a single line; with two it is a loop, and a loop that quietly covered
 * only the first would look exactly like a working build — the viewer would
 * simply stay stale forever for everyone who has the app installed, which is
 * the failure `tools/vite-plugin-sw.mjs` already throws loudly about for the
 * case it can detect.
 *
 * The same trap runs one door along, through `extraAssets`: those files live
 * in `public/` and are copied through unhashed, so a manifest-only edit used
 * to produce a byte-identical `sw.js` too. `share_target` lives in that file
 * now, which is a behaviour change nobody would ever receive.
 *
 * This is the pure part of the plugin, so it is a unit test rather than
 * another pass of `bench:phase6`: it runs `generateBundle` against a fake
 * bundle and reads what came out.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain JS build plugin, no types needed
import { serviceWorkerPlugin } from '../../tools/vite-plugin-sw.mjs';

type Bundle = Record<string, unknown>;

function bundleWith(appShell: string, viewerShell: string | null): Bundle {
  const bundle: Bundle = {
    'index.html': { type: 'asset', fileName: 'index.html', source: appShell },
    'assets/index-aaaa.js': {
      type: 'chunk',
      fileName: 'assets/index-aaaa.js',
      isEntry: true,
      imports: [],
      dynamicImports: [],
      moduleIds: ['/src/main.ts'],
    },
  };
  if (viewerShell !== null) {
    bundle['s/index.html'] = { type: 'asset', fileName: 's/index.html', source: viewerShell };
    bundle['assets/share-bbbb.js'] = {
      type: 'chunk',
      fileName: 'assets/share-bbbb.js',
      isEntry: true,
      imports: [],
      dynamicImports: [],
      moduleIds: ['/src/viewer/main.ts'],
    };
  }
  return bundle;
}

function emit(bundle: Bundle, options: { extraAssets?: string[]; publicDir?: string } = {}): string {
  const plugin = serviceWorkerPlugin({ extraAssets: options.extraAssets ?? [] });
  plugin.configResolved({ publicDir: options.publicDir ?? '' });
  let source = '';
  plugin.generateBundle.call({ emitFile: (file: { source: string }) => (source = file.source) }, {}, bundle);
  return source;
}

/** A throwaway `public/` holding one file, so its bytes can be changed. */
function publicDirWith(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushjot-sw-'));
  writeFileSync(join(dir, name), contents);
  return dir;
}

const read = (sw: string, name: string) => sw.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`))![1]!;

describe('the service-worker manifest', () => {
  it('names both shells, longest prefix first', () => {
    const shells = JSON.parse(read(emit(bundleWith('<app/>', '<viewer/>')), 'BUILD_SHELLS'));
    expect(shells).toEqual([
      ['/s/', '/s/index.html'],
      ['/', '/index.html'],
    ]);
  });

  it('precaches both documents, by directory and by file', () => {
    const assets = JSON.parse(read(emit(bundleWith('<app/>', '<viewer/>')), 'BUILD_ASSETS'));
    expect(assets).toEqual(expect.arrayContaining(['/', '/index.html', '/s/', '/s/index.html']));
  });

  it('changes BUILD_VERSION when either shell changes', () => {
    const version = (app: string, viewer: string) => read(emit(bundleWith(app, viewer)), 'BUILD_VERSION');
    const base = version('<app/>', '<viewer/>');

    expect(version('<app/>', '<viewer/>')).toBe(base);
    expect(version('<app v=2/>', '<viewer/>')).not.toBe(base);
    // The one this test exists for.
    expect(version('<app/>', '<viewer v=2/>')).not.toBe(base);
  });

  it('changes BUILD_VERSION when an unhashed extra asset changes', () => {
    const bundle = bundleWith('<app/>', '<viewer/>');
    const version = (contents: string) =>
      read(
        emit(bundle, {
          extraAssets: ['/manifest.webmanifest'],
          publicDir: publicDirWith('manifest.webmanifest', contents),
        }),
        'BUILD_VERSION',
      );

    // The filename never changes, so only the bytes can tell these apart.
    expect(version('{"name":"HushJot"}')).not.toBe(version('{"name":"HushJot","share_target":{}}'));
  });

  it('refuses to emit a worker when an extra asset is not in public/', () => {
    expect(() =>
      emit(bundleWith('<app/>', '<viewer/>'), {
        extraAssets: ['/icons/missing.png'],
        publicDir: publicDirWith('manifest.webmanifest', '{}'),
      }),
    ).toThrow(/not in the public directory/);
  });

  it('refuses to emit a worker when an HTML entry is missing', () => {
    expect(() => emit(bundleWith('<app/>', null))).not.toThrow();
    expect(() => emit({ 'assets/x.js': { type: 'chunk', fileName: 'assets/x.js', isEntry: true, imports: [] } })).toThrow(
      /HTML entry is missing/,
    );
  });
});
