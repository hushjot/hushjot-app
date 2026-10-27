# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately, either:

- through GitHub: **Security → Report a vulnerability** on this repository, or
- by email to support@hushjot.com, with "Security" in the subject.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within a few days.

## Scope

In scope:

- this web app (https://hushjot.app), including the share viewer at `/s/`
- `firestore.rules`
- the encryption envelope, key records and note format in `src/core/`
- [hushjot-cli](https://github.com/hushjot/hushjot-cli) (report it there)

Out of scope:

- the Firebase web config in the app and the CLI (API key, project and app
  id). It is public by design: it names the project and grants nothing.
  Access is decided by `firestore.rules`.
- denial of service, or reports from automated scanners with no
  demonstrated impact

## What we promise, and what we do not

`docs/security.md` is the threat model. It states what the encryption
protects against, and its limits. The main one is that a web app is delivered
by its host on every visit, so a compromised host could serve a modified
build. The service worker makes a new build wait for "Apply and reload", and
release hashes let you check a build against this source.
