# Creating and deploying HushJot on Firebase

Everything here is command line except **one step**: enabling the
Email/Password sign-in provider. That has no Firebase CLI command, so it is
either two clicks in the console or one REST call — both are written out in
[Step 4](#step-4--enable-emailpassword-sign-in-the-one-non-cli-step).

Total time from nothing to a live URL: about ten minutes, most of it waiting
for project provisioning.

> **You do not need a paid plan.** Firestore and Hosting both work on the free
> Spark plan. See [Costs](#costs) for when that changes.

---

## Contents

- [Before you start](#before-you-start)
- [Step 1 — Log in](#step-1--log-in)
- [Step 2 — Create the project](#step-2--create-the-project)
- [Step 3 — Create the Firestore database](#step-3--create-the-firestore-database)
- [Step 4 — Enable Email/Password sign-in](#step-4--enable-emailpassword-sign-in-the-one-non-cli-step)
- [Step 4a — Close self-signup and manage the allowlist](#step-4a--close-self-signup-and-manage-the-allowlist)
- [Step 5 — Register the web app and capture its config](#step-5--register-the-web-app-and-capture-its-config)
- [Step 6 — Deploy](#step-6--deploy)
- [Step 7 — Verify the deploy](#step-7--verify-the-deploy)
- [Day-to-day commands](#day-to-day-commands)
- [Working locally against emulators](#working-locally-against-emulators)
- [What is deployed, and what is not](#what-is-deployed-and-what-is-not)
- [Costs](#costs)
- [Troubleshooting](#troubleshooting)

---

## Before you start

```bash
firebase --version    # 15.x or newer
node --version        # 20 or newer
java -version         # only needed for the local emulators
```

If the CLI is missing:

```bash
npm install -g firebase-tools
```

Pick a project id now. It must be globally unique across all of Google Cloud,
lowercase, 6–30 characters. `hushjot-<something>` works well:

```bash
export HUSHJOT_PROJECT="hushjot-$(whoami)-$(date +%y%m)"
echo "$HUSHJOT_PROJECT"
```

Everything below uses `$HUSHJOT_PROJECT`, so set it in each shell you use.

---

## Step 1 — Log in

```bash
firebase login
```

This opens a browser once. On a headless machine use `firebase login --no-localhost`
and paste the code back.

Confirm it worked:

```bash
firebase projects:list
```

---

## Step 2 — Create the project

```bash
firebase projects:create "$HUSHJOT_PROJECT" --display-name "HushJot"
```

Provisioning takes 30–60 seconds. If the id is taken you will be told; pick
another and re-run.

Point this repository at it:

```bash
firebase use "$HUSHJOT_PROJECT" --alias default
```

(`firebase use --add` is the interactive equivalent, if you would rather pick
from a list.)

That rewrites `.firebaserc`, which ships with a placeholder id. Committing your
real project id there is fine — a project id is not a secret.

> **Already have a Google Cloud project?** Use
> `firebase projects:addfirebase "$HUSHJOT_PROJECT"` instead, which adds Firebase
> to an existing GCP project rather than creating a new one.

---

## Step 3 — Create the Firestore database

Pick a location first. **This cannot be changed later**, so choose the region
closest to your users:

```bash
firebase firestore:locations --project "$HUSHJOT_PROJECT"
```

Common choices: `europe-southwest1` (Madrid), `europe-west2` (London),
`us-central1` (Iowa), `australia-southeast1` (Sydney).

**Pick a single region, not a multi-region** (`eur3`, `nam5`). A multi-region
database charges roughly twice as much per operation, and HushJot's bill is
operations, not storage. What the extra buys is a 99.999% availability SLA
instead of 99.99%, and surviving the loss of a whole region. For HushJot that is
poor value: every device holds the full library locally, so a regional outage
means sync pauses and resumes, not that anyone loses access to a note.

```bash
firebase firestore:databases:create "(default)" \
  --location us-central1 \
  --project "$HUSHJOT_PROJECT"
```

`(default)` is the literal database name the app uses — quote it exactly.

Verify:

```bash
firebase firestore:databases:list --project "$HUSHJOT_PROJECT"
```

> The database is created in **locked mode** — nothing can read or write until
> rules are deployed in [Step 6](#step-6--deploy). That is the correct order:
> the database is never briefly open to the world.

---

## Step 4 — Enable Email/Password sign-in (the one non-CLI step)

The Firebase CLI's `auth` commands only import and export user accounts. There
is no command to turn a sign-in provider on, so this is done in the console or
through the Identity Toolkit Admin API.

### Option A — console (recommended, two clicks)

Open the providers page:

```bash
open "https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/authentication/providers"
# Linux: xdg-open   Windows: start
```

(`firebase open` with no argument also lists console links interactively.)

Then:

1. Click **Get started** if this is the first visit.
2. Select **Email/Password** from the provider list.
3. Toggle **Enable** on. Leave *Email link (passwordless sign-in)* **off** —
   HushJot does not use it.
4. **Save**.

Do **not** enable any other provider unless you have a product reason
(spec §18); each one is more surface area.

### Option B — REST, for scripting

Needs a Google OAuth access token, most easily obtained from the `gcloud` CLI:

```bash
# One-time, if you do not have gcloud: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project "$HUSHJOT_PROJECT"

curl -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${HUSHJOT_PROJECT}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: ${HUSHJOT_PROJECT}" \
  -H "Content-Type: application/json" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}'
```

A successful response echoes the updated config with
`"signIn": { "email": { "enabled": true, ... } }`.

> **`X-Goog-User-Project` is not optional.** `gcloud auth print-access-token`
> mints its token against Google's *shared* Cloud SDK OAuth client, so without
> that header the call is billed to Google's own project (number
> `32555940559`) rather than yours. Identity Toolkit is not enabled there, and
> the call fails with a misleading `403 SERVICE_DISABLED` naming a project id
> you have never seen. The header redirects quota attribution to your project;
> it needs `serviceusage.services.use`, which Owner has. Setting
> `gcloud auth application-default set-quota-project` does **not** fix this —
> that configures ADC, which `print-access-token` does not use.

> **Why HushJot still needs an account at all.** The account moves *encrypted
> bytes* between devices. It never gives Google — or us — the ability to read a
> note: that requires the passphrase, which is a separate secret and is never
> transmitted. See `docs/security.md`.

---

## Step 4a — Close self-signup and manage the allowlist

On your own deployment, syncing is invite-only. Local-only use is open to
anyone — that is the point of a local-first app — but an account, and every
byte that reaches Firestore, needs `approved()` in the rules: either an
`entitlements/{uid}` document or an allowlist entry. Entitlements are written
by a billing service that is not part of this repository, so on a
self-hosted project the allowlist is how you let an account sync.

Two independent controls, and **both** are needed. The first stops accounts
being created; the second stops an account that exists from reading or writing
anything. Neither substitutes for the other.

### Turn off self-signup

Same console section as Step 4:

```bash
open "https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/authentication/settings"
```

Under **User actions**, uncheck **Enable create (sign-up)**.

The scriptable equivalent, if you would rather not click — same
`X-Goog-User-Project` caveat as Step 4 Option B:

```bash
curl -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${HUSHJOT_PROJECT}/config?updateMask=client.permissions.disabledUserSignup" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: ${HUSHJOT_PROJECT}" \
  -H "Content-Type: application/json" \
  -d '{"client":{"permissions":{"disabledUserSignup":true}}}'
```

This matters more than it looks. `VITE_FIREBASE_API_KEY` is public by design,
so anyone can `POST` to `identitytoolkit.googleapis.com/v1/accounts:signUp`
with it and never touch the app's UI. Removing the registration form from the
app — which has been done — hides the door; this locks it. With the toggle off,
that endpoint returns `ADMIN_ONLY_OPERATION` to everyone, and accounts can only
be created by you as an admin.

While on that page, also enable **Email enumeration protection**. It stops a
sign-in failure from distinguishing "no such account" from "wrong password".
The app already handles the merged error code, so nothing needs changing.

### Invite someone

Two steps, both yours. Adding the account without the allowlist entry produces
an account that can sign in and sync nothing; adding the allowlist entry
without the account is harmless and can be done first.

**1. Create the account.** Authentication → **Users** → **Add user**, with an
email and a temporary password.

```bash
open "https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/authentication/users"
```

**2. Add them to the allowlist.** Firestore → **Data** → collection
`allowlist` → document ID is the **lowercased email address**:

```bash
open "https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/firestore/data"
```

| Field | Type | Value |
| --- | --- | --- |
| `active` | boolean | `true` |
| `note` | string | who they are, for your own records |
| `addedAt` | number | epoch milliseconds |

Only `active` is read by the rules; the other two are for you, six months from
now, wondering who `k.patel@…` was.

Note that `firebase firestore:*` cannot write documents — the CLI can delete
and manage indexes, but not create data. The console is the supported path.

### Revoke someone

Set `active` to `false` on their allowlist document. It takes effect on their
next request; no deploy, no sign-out required. Their notes stay where they are,
and their device keeps working offline — it simply stops syncing, and the app
says so rather than failing silently.

Prefer this to deleting the document: it keeps the record of who had access and
when. To go further, Authentication → Users → **Disable account**, which kills
the session outright.

### How it is enforced

`firestore.rules` gates every path under `users/{uid}` on `approved()`, which
looks up `allowlist/{lowercased email from the ID token}` and requires
`active == true`. The client checks the same document after sign-in, but only
to produce a readable error message — a client check that the server did not
also make would be decoration. The rules tests in
`tests/rules/firestore.rules.test.ts` cover the approved, uninvited,
deactivated, wrong-casing and enumeration cases.

The lookup costs one document read per sync request, which is noise at this
scale. If HushJot ever has enough users for that to matter, `approved()` can
become `request.auth.token.approved == true` backed by a custom claim, with no
client change — but a custom claim cannot be revoked until the user's ID token
expires, up to an hour later, so the Firestore document is the better trade
while the user count is small.

---

## Step 5 — Register the web app and capture its config

```bash
firebase apps:create WEB "HushJot web" --project "$HUSHJOT_PROJECT"
```

Note the App ID it prints (looks like `1:123456789:web:abc123`). Then write the
config into `.env.production`, which is what the build reads:

```bash
firebase apps:sdkconfig WEB --project "$HUSHJOT_PROJECT" --json \
  | jq -r '.result.sdkConfig
      | "VITE_FIREBASE_API_KEY=\(.apiKey)",
        "VITE_FIREBASE_AUTH_DOMAIN=\(.authDomain)",
        "VITE_FIREBASE_PROJECT_ID=\(.projectId)",
        "VITE_FIREBASE_APP_ID=\(.appId)"' \
  > .env.production

cat .env.production
```

If your CLI version nests the JSON differently, run it without `--json`, read
the four values off the printed snippet, and copy `.env.example` by hand. Only
those four are needed — HushJot does not use Storage, Messaging or Analytics.

`.env.production` is gitignored. **These values are public anyway**: Firebase
config identifies a project, it does not authorise anything. Access control
lives entirely in `firestore.rules`, which is why those have 30 tests. They are
kept out of git only so different environments do not fight over one file.

> **If you skip this step** the app still builds and runs — entirely
> local-only, with the account panel saying sync is not configured. That is a
> legitimate way to use HushJot, not a broken state.

---

## Step 6 — Deploy

```bash
firebase deploy --project "$HUSHJOT_PROJECT"
```

That single command does everything:

| Target | What it does |
|---|---|
| `firestore:rules` | Uploads `firestore.rules` — per-user isolation and the revision compare-and-swap |
| `firestore:indexes` | Uploads `firestore.indexes.blaze.json`: no composite indexes, no indexing of note-version ciphertext, and the version and share **TTL policies** (Blaze only; see below) |
| `hosting` | Runs `npm run build`, then uploads `dist/` |

The build runs automatically because `firebase.json` declares
`"predeploy": ["npm run build"]`, so it is impossible to ship a stale `dist/`.

**Deploy the rules first if you are nervous** — they are the security boundary,
and the app is useless without them anyway:

```bash
firebase deploy --only firestore:rules --project "$HUSHJOT_PROJECT"
firebase deploy --only hosting --project "$HUSHJOT_PROJECT"
```

Deploy the indexes with the rules, before hosting:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project "$HUSHJOT_PROJECT"
```

### Version and share expiry (Blaze only — switched on)

Two things expire, and both wait on the same policy.

Note versions are stored under `users/{uid}/notes/{id}/versions`, and no client
can delete one — not even its owner — so a stolen session cannot erase history.
They are meant to be removed by a Firestore **time-to-live policy** on their
`expireAt` field (at most 31 days out; the rules enforce that).

**Shared links** (`shares/{id}`, and each owner's record at
`users/{uid}/shares/{id}`) carry the same field, bounded the same way. Unlike a
version, a share *can* be deleted by its owner — that is what "Revoke" does, and
a link that cannot be withdrawn would be a poor feature — so the TTL is cleanup
rather than the enforcement. Enforcement is the read rule:
`allow get: if resource.data.expireAt > request.time`, so an expired link stops
working the moment it expires whether or not anything has deleted it.

**TTL policies need the Blaze plan.** On Spark, deploying one fails with
`HTTP Error: 403, Project … has billing disabled`. So the policy is kept in a
second file. `firebase.json` deploys the Blaze one, so on a Spark project point
it at `firestore.indexes.json` first:

| File | Deployed | Contents |
|---|---|---|
| `firestore.indexes.json` | only on a Spark project | everything except the TTL policies |
| `firestore.indexes.blaze.json` | by default | the same, plus the `versions.expireAt` and `shares.expireAt` TTLs |

Both files also exempt every ciphertext field — `notes.meta`, `notes.body`,
`folders.data`, `versions.meta`, `versions.body`, `shares.payload` — from
indexing. No query can use them, and each indexed field is billed index
storage and an index write on every note save.

`tests/unit/firestoreIndexes.test.ts` fails if the two differ by anything other
than those entries, so an index added to one cannot go missing from the other.
(`shares` names both the public collection and each owner's private record of
their links; a collection-group override covers both, which is what you want —
an expired link's record should go the same day its blob does.)

**On a project where it is off, nothing breaks.** The app ignores any version whose `expireAt`
has passed — on this device and when reading the account — so the history panel
and Recently deleted behave exactly as with TTL, and the rules refuse to serve an
expired share at all. What differs is only the backend: expired version
documents and revoked or expired share documents stay in Firestore, still
encrypted, and storage grows by every version ever uploaded (roughly one per
editing session per note, each the size of the note) plus every link ever
published.

**To switch it on after upgrading to Blaze** (skip this if `firebase.json` still
names the Blaze file):

1. In `firebase.json`, change `"indexes": "firestore.indexes.json"` to
   `"indexes": "firestore.indexes.blaze.json"`, and update the last assertion in
   `tests/unit/firestoreIndexes.test.ts` to match.
2. Deploy it:

   ```bash
   firebase deploy --only firestore:indexes --project "$HUSHJOT_PROJECT"
   ```

3. Confirm the policy — it takes a while to become active on Google's side:

   ```bash
   gcloud firestore fields ttls list --project "$HUSHJOT_PROJECT"
   ```

Once active, Firestore also sweeps up the versions that expired while it was
parked, typically within a day or two. Each removal is billed as one delete.

Check what would happen without doing it:

```bash
firebase deploy --dry-run --project "$HUSHJOT_PROJECT"
```

Your app is now at `https://YOUR_PROJECT_ID.web.app`.

---

## Step 7 — Verify the deploy

> **A deploy does not reach anyone who already has the app open.**
>
> This catches everybody once, so it is first. `firebase deploy` *does* compile
> — `npm run build` is a predeploy hook on the hosting target — and the new
> files really are uploaded. But `src/sw.js` deliberately never calls
> `skipWaiting()`, and it answers navigations from its **own** precache, so an
> installed client keeps running the build it started with until the user
> accepts the update notice the app shows. **Reloading does not help**, and it
> is not supposed to: `docs/security.md` § "A malicious or coerced host"
> explains why a new build must never be able to swap itself in silently, and
> `bench:phase6` fails if that stops being true.
>
> So: deploy, open the app, and **click the update notice**. If you are testing
> something and want it now, DevTools → Application → Service Workers →
> *Unregister*, then reload — or just use a private window, which has no worker
> registered.

Do these in order. Each one checks something the previous cannot.

**1. The app loads and works offline.**

```bash
open "https://${HUSHJOT_PROJECT}.web.app"
```

Create a vault, write a note, then turn off your network and reload. The app
should still open and your note should still be there — that is the service
worker doing its job.

**2. Sign-in works.** Create an account and allowlist it
([Step 4a](#invite-someone)), then open the ☁ button and sign in. If it fails with
"could not reach the sync service", Step 4 was not completed.

**3. Firestore holds no plaintext.** The important one. Write a note containing
a distinctive word, wait a couple of seconds for it to sync, then:

```bash
open "https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/firestore/data"
```

In the console, open `users/{your-uid}/notes/{id}`. The `meta` and `body`
fields must show as **Bytes** (blobs), not readable text. If you can read your
note there, stop and open an issue — that would mean encryption is not running.

**4. Another user cannot read your data.** Already covered by 30 automated
rules tests:

```bash
npm run test:rules
```

**5. The whole suite still passes against the built app:**

```bash
npm run verify
```

---

## Day-to-day commands

```bash
# Deploy just the security rules, after editing firestore.rules
firebase deploy --only firestore:rules

# Deploy just the site
firebase deploy --only hosting

# Preview a change on a temporary URL without touching production.
# Expires in 7 days; great for sharing a build.
firebase hosting:channel:deploy preview-my-change --expires 7d

# List and clean up preview channels
firebase hosting:channel:list
firebase hosting:channel:delete preview-my-change

# Export every user account (not their notes — those are ciphertext in Firestore)
firebase auth:export users.json --project "$HUSHJOT_PROJECT"

# Take the site offline
firebase hosting:disable --project "$HUSHJOT_PROJECT"
```

### Rolling back

There is no `firebase hosting:rollback` command. Two options:

- **Console:** Hosting → *Release history* → the ⋮ menu on a previous release →
  **Rollback**. Instant, and the reliable choice in an emergency.
- **CLI:** check out the previous commit and redeploy.

```bash
git checkout <previous-good-commit>
firebase deploy --only hosting
git checkout -   # return to where you were
```

---

## Working locally against emulators

You do not need a real Firebase project to develop. The emulator suite covers
Auth and Firestore.

```bash
npm run emulators        # starts Auth on 9098, Firestore on 8085
```

In a second terminal, point a dev build at them:

```bash
cp .env.example .env.local
# set VITE_FIREBASE_EMULATORS=true in .env.local
npm run dev
```

> **Why 8085 and 9098** rather than Firebase's defaults of 8080 and 9099?
> Port 8080 is extremely commonly occupied. Change them in `firebase.json` and
> `.env.local` if these clash on your machine — they are only used locally.

The automated suites start and stop their own emulators, so you do not need one
running for `npm run verify`.

**Emulator data is thrown away on exit.** To keep it between runs:

```bash
firebase emulators:start --only firestore,auth --import ./.emulator-data --export-on-exit
```

---

## What is deployed, and what is not

| Thing | Deployed by | Notes |
|---|---|---|
| Security rules | `firebase deploy --only firestore:rules` | The security boundary. Never edit these in the console — the file in git is the source of truth. |
| Firestore indexes | `firebase deploy --only firestore:indexes` | No composite indexes (every query orders by one field and the document id); switches off indexing of version and share ciphertext. The TTL policies on `versions.expireAt` and `shares.expireAt` are in `firestore.indexes.blaze.json`, deployed and active — [Version and share expiry](#version-and-share-expiry-blaze-only--switched-on) |
| The web app | `firebase deploy --only hosting` | Built from `dist/` by the predeploy hook |
| **Auth providers** | **nothing** | Console/API only — [Step 4](#step-4--enable-emailpassword-sign-in-the-one-non-cli-step). Not stored in this repo. |
| **Firestore location** | **nothing** | Set once at creation, permanent |
| **Custom domain** | **nothing** | Console only — see below |
| **Budget alerts** | **nothing** | Console only — see [Costs](#costs) |

### Custom domain

Console only: Hosting → **Add custom domain**. Firebase gives you DNS records
to add at your registrar and provisions a TLS certificate automatically
(usually within an hour, occasionally 24). Once live, add the domain to
`authDomain` handling only if you later add an OAuth provider — email/password
does not redirect, so nothing else changes.

---

## Costs

The free **Spark** plan covers a handful of users — reads run out at about seven
daily-active users — so the project is on **Blaze**. The figures that matter
(measured by `npm run bench:phase5`, see `bench/RESULTS.md` § "Firestore
operations per session"; a daily user types for 30 minutes with the tab open
8 hours):

| Resource | Free daily allowance | What HushJot does |
|---|---|---|
| Firestore document reads | 50,000 | ~7,300 per daily user, plus ~2 per note whose history is opened. One per share a recipient opens, plus the rules' lookups on every write (the plan or invitation, and the meter) |
| Firestore writes | 20,000 | ~1,080 per daily user: every push is two writes, the note or folder and the storage meter in the same commit, at most one push every 3 s while typing. A note version is two more (its own commit), roughly once per editing session per note. A publish is three (record, public copy, meter), a revoke two deletes. Never more than 20,000 pushes — 40,000 writes — per account per day: the rules refuse the rest |
| Firestore deletes | 20,000 | Two per revoked link. One per expired version and per expired share, by TTL |
| Firestore storage | 1 GiB | Note ciphertext is ~0.5% larger than plaintext, and the meter charges every note and folder at least 1 KiB. Versions on top: 30 days' worth, at most 500 MB uploaded per account per month. A shared link is one more copy of one note, for at most 30 days |
| Hosting transfer | 10 GB/month | ~200 KB per first visit, near zero after (service worker) |

At list prices for `us-central1` — reads $0.03 per 100,000, writes $0.09 per
100,000, deletes $0.01 per 100,000, storage $0.15 per GiB-month, point-in-time
recovery another $0.15 per GiB-month, backups $0.03 per GiB-month each, and
egress $0.12 per GiB after the first 10 GiB a month — a daily user costs about
**$0.07 a month in reads and $0.03 in writes**, before the free allowance and
before storage, which at a few MB per account is cents per hundred users.

| Daily-active users | Reads | Writes | Firestore per month |
|---|---|---|---|
| 200 | $13 | $5 | about $18 |
| 800 | $52 | $23 | about $75 |
| 2,000 | $131 | $58 | about $190 |

**What one account can cost at most**, because the rules enforce it: 20,000
pushes a day is about 40,000 writes, about **$1.10 a month**, plus the rules'
lookups (a few reads per push, under $1 a month); storage up to its allowance
(1 GiB without add-ons, about $0.35 a month with PITR and backups) and 500 MB of
history a month. What the rules cannot bound is **reads** — a client can query
as often as it likes — and the egress that comes with them. See
`docs/security.md`, open item 5.

The design keeps these low deliberately: an idle tab checks once a minute, and
once every 15 minutes while hidden; and the app pulls
deltas against a cursor instead of listening to the whole collection — which at
10,000 notes would otherwise cost 10,000 reads on every cold start. Fields no
query uses are exempt from indexing (`firestore.indexes.json`), so a write pays
for the index entries of `syncedAt` and `createdAt` and nothing else.

**Set budget alerts**: console only, `https://console.cloud.google.com/billing`
→ *Budgets & alerts*. They are the backstop for what the rules cannot see.

---

## Troubleshooting

**"Could not reach the sync service" when signing in.**
Email/Password is not enabled — [Step 4](#step-4--enable-emailpassword-sign-in-the-one-non-cli-step).
Also check the browser console for a Content-Security-Policy error: a
production build only allows the real Firebase endpoints, so a build pointed at
emulators must be built in development mode.

**`Error: … collectionGroups/versions/fields/expireAt had HTTP Error: 403, Project … has billing disabled`.**
The index file being deployed contains the version TTL policy, which needs
Blaze. Point `firebase.json` back at `firestore.indexes.json` — see
[Version and share expiry](#version-and-share-expiry-blaze-only--switched-on). Rules deployed in the same
command may not have been released; re-run
`firebase deploy --only firestore:rules,firestore:indexes`.

**`PERMISSION_DENIED` on every write.**
Rules were never deployed, or the database is still in locked mode:

```bash
firebase deploy --only firestore:rules --project "$HUSHJOT_PROJECT"
```

**Notes sync but appear as "Unreadable note" on another device.**
That device unlocked a *different* vault. Sign in **first** on a new device, so
it pulls the existing wrapped key record, and only then unlock with your
existing passphrase. If you created a second vault by mistake, the notes
encrypted under it are not recoverable with the other passphrase.

**The deployed site shows an old version.**
`index.html` and `sw.js` are served with `no-cache`, and hashed assets are
immutable, so this should self-correct on reload. If it does not, the service
worker is serving a cached shell — close every tab for the site and reopen, or
clear site data in DevTools → Application → Storage.

**`firebase deploy` fails with "HTTP Error: 403".**
The Firebase Management or Firestore API is not enabled on a project that was
created outside Firebase. Run `firebase projects:addfirebase "$HUSHJOT_PROJECT"`,
or enable the APIs in the Cloud console.

**Emulators will not start: "port taken".**
Change the ports in `firebase.json` under `emulators`, and match them in
`.env.local` and `tests/rules/firestore.rules.test.ts`.

---

## One-shot script

Everything except Step 4, for reference:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${HUSHJOT_PROJECT:?set HUSHJOT_PROJECT first}"
LOCATION="${LOCATION:-us-central1}"

firebase login
firebase projects:create "$HUSHJOT_PROJECT" --display-name "HushJot"
firebase use "$HUSHJOT_PROJECT" --alias default
firebase firestore:databases:create "(default)" --location "$LOCATION" --project "$HUSHJOT_PROJECT"
firebase apps:create WEB "HushJot web" --project "$HUSHJOT_PROJECT"

firebase apps:sdkconfig WEB --project "$HUSHJOT_PROJECT" --json \
  | jq -r '.result.sdkConfig
      | "VITE_FIREBASE_API_KEY=\(.apiKey)",
        "VITE_FIREBASE_AUTH_DOMAIN=\(.authDomain)",
        "VITE_FIREBASE_PROJECT_ID=\(.projectId)",
        "VITE_FIREBASE_APP_ID=\(.appId)"' \
  > .env.production

echo
echo "Now enable Email/Password sign-in — the one step with no CLI command:"
echo "  https://console.firebase.google.com/project/${HUSHJOT_PROJECT}/authentication/providers"
echo
read -rp "Press enter once that is done… "

firebase deploy --project "$HUSHJOT_PROJECT"

echo "Live at https://${HUSHJOT_PROJECT}.web.app"
```
