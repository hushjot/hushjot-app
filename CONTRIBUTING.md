# Contributing

Bug reports and pull requests are welcome. For anything larger than a fix,
open an issue first, so we can agree the approach before you spend time on it.

## Before you open a pull request

```bash
npm run check
npm test
npm run verify   # the full gate, if you have Java, the Firebase CLI and Playwright
```

- **Keep the critical path small.** The app's eager JavaScript is budgeted at
  160 KB gzipped (`bench/size.mjs`). New dependencies need a strong reason.
- **`src/core/` stays platform-free**: no DOM, Svelte or Firebase.
- **Never send plaintext to the backend**, and do not invent cryptography.
  Changes to stored bytes are format changes: they need a case in
  `contract/format-vectors.json` and a `FORMAT_VERSION` bump.
- **Explain the why.** Modules open with a comment that gives the reasons for
  their design. Update that comment when you change what it describes.
- Two-space indentation, single quotes, semicolons. Svelte 5 runes only.

`CLAUDE.md` is the detailed architecture guide, written for humans and coding
agents alike. Read its "Invariants that are easy to break" section before
touching sync, the vault or the service worker.

## Licence

By contributing, you agree that your contribution is licensed under the
AGPL-3.0-only licence of this project.
