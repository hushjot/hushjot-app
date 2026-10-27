/**
 * Serve the real-device Argon2id page on the LAN.
 *
 * This is the one harness in `bench/` that cannot gate anything and is not part
 * of `npm run verify`: it needs a physical phone and a person holding it. Every
 * other Argon2id figure in the repo is a laptop, or a laptop with its CPU
 * scheduler slowed, and neither is a measurement of a memory-hard function on
 * mobile memory. See `bench/device/main.ts` for why that distinction is the
 * whole point.
 *
 * Plain http on a LAN address is deliberate. It is not a secure context, so
 * `crypto.subtle` is unavailable — which is exactly why the page posts to the
 * KDF worker directly instead of going through `src/core/crypto/kdf.ts`.
 * WebAssembly and module workers both work on an insecure origin, and they are
 * the only things being timed.
 *
 * If the deployed Content-Security-Policy also needs checking on the device
 * (`'wasm-unsafe-eval'` on `/assets/**`, `firebase.json`), deploy the built
 * directory to a Firebase Hosting preview channel instead — a temporary https
 * URL that inherits the real headers and expires on its own. That is a
 * different question from parameter timing.
 */
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(here, 'vite.device.config.mjs');

console.log('Building the device page…');
await build({ configFile, logLevel: 'error' });

const server = await preview({
  configFile,
  preview: { host: true, port: 5180, strictPort: true },
});

const network = server.resolvedUrls?.network ?? [];
const local = server.resolvedUrls?.local ?? [];

console.log('\n  Type this into the phone, on the same Wi-Fi:\n');
if (network.length) {
  // Without the scheme: phone browsers add it, and it is fewer characters to
  // get right on a soft keyboard.
  for (const url of network) console.log(`      ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`);
} else {
  console.log('      (no LAN address found — see troubleshooting below)');
  for (const url of local) console.log(`      ${url}   [this machine only]`);
}

console.log(
  '\n  On the phone, BEFORE tapping Run:\n' +
    '    - screen timeout to its longest setting\n' +
    '    - battery saver / low-power mode off\n' +
    '    - unplug it from the charger\n' +
    '    - close other apps, and use Chrome\n' +
    '\n  During the run: stay in the tab for the full ~2 minutes and do not let\n' +
    '  the screen sleep. A hidden tab is throttled, and the numbers it reports\n' +
    '  look perfectly reasonable — the page detects this and tells you to\n' +
    '  discard the run, but only after you have waited out the two minutes.\n' +
    '\n  Afterwards: paste the JSON into bench/RESULTS.md and add the phone\n' +
    '  model by hand — Chrome sends a reduced user-agent, so the JSON cannot\n' +
    '  say which device it was. Then settle DEFAULT_ARGON2_PARAMS in\n' +
    '  src/core/crypto/kdf.ts against the decision rule in docs/security.md\n' +
    '  § "Settling it on hardware", quoting the SECOND pass.\n' +
    '\n  If the phone cannot reach it:\n' +
    '    - same SSID? a guest network, or the other band on a split-band\n' +
    '      router, will not route to this machine\n' +
    '    - AP/client isolation on the router blocks phone-to-laptop traffic\n' +
    '    - macOS may have prompted to allow incoming connections for `node`\n' +
    "    - use the IP form above; a `<name>.local` address is refused by Vite's\n" +
    '      host check with a 403, and only raw IPs are allowed by default\n' +
    '\n  Ctrl-C when done.\n',
);
