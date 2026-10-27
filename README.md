# HushJot

An extremely fast, encrypted, local-first Markdown notepad for the browser.
Notes are encrypted on your device before they are stored or synced; the sync
backend (Firebase) holds ciphertext it cannot read.

- Web app: https://hushjot.app
- About, pricing and guides: https://hushjot.com
- Command line and MCP server for AI agents: [hushjot-cli](https://github.com/hushjot/hushjot-cli)

## How it is built

- **Svelte 5** interface (`src/ui/`) and a **CodeMirror 6** editor (`src/editor/`).
- **`src/core/`** holds everything that touches your notes: the encryption
  envelope and key records, the note format, the sync engine and the search
  index. It has no DOM, Svelte or Firebase dependency, and it is published as
  `@hushjot/core` for the CLI.
- **`src/adapters/firebase/`** is the only code that knows Firebase exists.
  Access control lives in `firestore.rules`, which is tested.
- No account is needed: with no Firebase config the app runs entirely
  local-only.

`docs/security.md` is the threat model and describes the cryptography in
detail. `encrypted-cloud-notepad-agentic-ai-spec.md` is the product
specification the code cites by section (`§7`, `§16`…).

## Develop

Node.js 22.18 or newer.

```bash
npm ci
npm run dev          # Vite dev server on :5173
npm run check        # Svelte and TypeScript
npm test             # unit tests
npm run build        # production build in dist/
```

`npm run verify` is the full gate: checks, unit tests, the Firestore rules
tests and the browser benchmarks, which fail when a size or latency budget is
exceeded. The rules tests and the Firebase benchmarks need Java and the
Firebase CLI; the benchmarks need Playwright's Chromium
(`npx playwright install chromium`).

## Run your own

Copy `.env.example` to `.env.production`, create a Firebase project, and
deploy the rules and hosting. `docs/firebase-setup.md` walks through it.

## Verify a release

Each release is tagged, and its notes list the SHA-256 of the built files and
the public `VITE_*` values the build used. Put those values in
`.env.production`, build the tag and compare:

```bash
git checkout v0.1.0 && npm ci && npm run build
shasum -a 256 dist/index.html dist/sw.js dist/assets/*
```

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Licence

Copyright © 2026 Nebulosa d'Ideias Unipessoal Lda.

HushJot is free software under the GNU Affero General Public License v3.0
only. See [LICENSE](LICENSE). If you run a modified version as a service, the
licence requires you to offer your users its source.
