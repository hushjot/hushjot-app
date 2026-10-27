/**
 * Subresource Integrity on the shell's own script and stylesheet.
 *
 * ## What this is honestly worth
 *
 * Less than it looks, and the reason matters enough to write down here rather
 * than let a reader assume otherwise.
 *
 * SRI's threat model is two origins: the HTML comes from you, the script comes
 * from a CDN, and your `integrity` attribute catches the CDN if it is
 * compromised. HushJot serves both from one origin. A host willing to hand a
 * user a backdoored bundle rewrites `index.html` in the same breath, attribute
 * and all — so against the attack in `docs/security.md` § "A malicious or
 * coerced host", this stops nothing. The service-worker update gate is the
 * mechanism that does real work there; this is not a second lock on the same
 * door.
 *
 * It is also **partial by construction**. `integrity` covers the files named
 * in the HTML and nothing they in turn import: the entry chunk and the
 * stylesheet, not the ~130 lazily imported chunks behind them. Import-level
 * integrity is still a proposal.
 *
 * Every HTML document in the build is processed, not just the app's — the
 * share viewer at `/s/` is a second one — because a shell nobody stamps is a
 * shell nobody can compare against a published hash, and it is served from the
 * same origin to people who did not choose to install anything.
 *
 * ## So why have it
 *
 * Because it is the machine-readable form of "this is the build I published".
 * The hashes it emits are the same ones a release would list (viability
 * assessment §5.1, Tier 0 item 5), which is what lets someone — or WEBCAT
 * later — compare what their browser was served against what the tag says
 * should have been served. The verification comes from publishing the hashes;
 * this puts them where a tool can find them, and costs one build step.
 *
 * Emitting a *wrong* hash breaks the app for everyone and looks exactly like a
 * plugin that works — this one did, on its first attempt — so `bench/phase6.mjs`
 * asserts both that the attributes are present and that an untampered build
 * still loads.
 *
 * ## Ordering
 *
 * This runs in `writeBundle`, which is after the service-worker plugin has
 * computed BUILD_VERSION from the shell. That is deliberate and safe: these
 * attributes are a pure function of the asset files, whose content hashes are
 * already in their filenames, and that filename list is what BUILD_VERSION is
 * built from. An integrity attribute cannot change unless a filename does.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** sha384: the middle option, and what every SRI example uses. */
function integrityFor(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

export function sriPlugin() {
  return {
    name: 'hushjot-sri',
    apply: 'build',
    enforce: 'post',

    /**
     * `writeBundle`, reading the files back off disk, and not the tidier-looking
     * `transformIndexHtml` with `ctx.bundle`.
     *
     * The first attempt did it the tidy way and shipped hashes that matched
     * nothing: a chunk's `code` at HTML-transform time is not the bytes Vite
     * eventually writes, so every integrity attribute was wrong and the browser
     * refused the entry script on a completely untampered build. An SRI plugin
     * that is subtly wrong is worse than none — it breaks the app for everyone
     * while looking like a security feature — so this hashes the actual file,
     * after it is written, and there is nothing left to be out of date with.
     */
    writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) return;

      const shells = Object.keys(bundle).filter((fileName) => fileName.endsWith('.html'));
      for (const shell of shells) stamp(resolve(dir, shell), dir, shell);
    },
  };
}

function stamp(htmlPath, dir, label) {
  if (!existsSync(htmlPath)) return;

  const html = readFileSync(htmlPath, 'utf8');
  let applied = 0;

  // Only same-origin, root-relative references are touched. A cross-origin
  // URL would need CORS on the far end, and there are deliberately none
  // here — the CSP allows no third-party script origin at all.
  const withIntegrity = html.replace(
    /<(script|link)\b([^>]*?)\s(src|href)="\/([^"]+)"([^>]*?)>/g,
    (match, tag, before, attr, path, after) => {
      if (match.includes('integrity=')) return match;
      if (tag === 'link' && !/rel="(stylesheet|modulepreload)"/.test(match)) return match;

      const assetPath = resolve(dir, path);
      if (!existsSync(assetPath)) return match;

      applied++;
      const digest = integrityFor(readFileSync(assetPath));
      return `<${tag}${before} ${attr}="/${path}" integrity="${digest}"${after}>`;
    },
  );

  // A silent no-op is the other failure mode to fear: the build succeeds,
  // the app works, and the attribute everyone assumes is there is not.
  if (applied === 0) {
    throw new Error(
      `SRI plugin matched no script or stylesheet in ${label}. The shell markup ` +
        'or Vite output layout has changed; fix the pattern rather than shipping ' +
        'a build whose integrity attributes silently vanished.',
    );
  }

  writeFileSync(htmlPath, withIntegrity);
}
