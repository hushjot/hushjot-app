/**
 * Shared browser helpers for the benchmark harnesses.
 *
 * Since Phase 3 the app opens on a vault screen, so every harness needs to
 * create or unlock a vault before it can measure anything. Since the vault
 * screen became a wizard it opens on a *question* instead, and the first step
 * of every journey is answering it — see `chooseStart`.
 */

export const BENCH_PASSPHRASE = 'benchmark passphrase 12345';

/**
 * Get past the wizard's opening question.
 *
 * It is only asked when the build has sync configured *and* nobody is signed in
 * yet, and that is not a constant: `.env.production` is gitignored, so a
 * developer's build carries a Firebase key and a clean checkout's does not, and
 * the same harness has to pass in both. Hence a probe rather than a wait —
 * waiting on `#choose-device` alone would burn its whole timeout, once per
 * call, on every local-only run.
 *
 * The combined selector is what makes the probe honest: it resolves on
 * whichever screen actually rendered, so the `count()` below is asked after the
 * app has decided rather than before it.
 *
 * Note that nothing here needs to wait for the create form to become
 * *enabled* — it is held shut until auth has settled, and Playwright's
 * `fill()` and `click()` already auto-wait for that. Do not add sleeps.
 *
 * `which` is 'device' or 'account'. Returns true when a click happened.
 */
export async function chooseStart(page, which = 'device') {
  await page.waitForSelector('#choose-device, #new-pass, #pass, .cm-content, .list .row', {
    timeout: 20_000,
  });

  const button = page.locator(`#choose-${which}`);
  if (!(await button.count())) return false;

  await button.click();
  // Gone before the caller's next probe, so `#new-pass` cannot race the step.
  await button.waitFor({ state: 'detached', timeout: 5_000 });
  return true;
}

/**
 * Walk past whichever vault screen is showing and wait for the editor.
 * Returns the recovery code when this call created the vault.
 */
export async function enterApp(page, base, passphrase = BENCH_PASSPHRASE) {
  await page.goto(base, { waitUntil: 'load' });
  // Does the screen-has-rendered wait this line used to do, then answers the
  // wizard's opening question if this build asks it.
  await chooseStart(page, 'device');

  if (await page.locator('#new-pass').count()) {
    await page.fill('#new-pass', passphrase);
    await page.fill('#confirm-pass', passphrase);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.code', { timeout: 30_000 });
    const code = (await page.locator('.code').textContent())?.trim() ?? '';
    await page.check('.check input');
    await page.click('button.primary');
    await page.waitForSelector('.cm-content', { timeout: 20_000 });
    return code;
  }

  if (await page.locator('#pass').count()) {
    await page.fill('#pass', passphrase);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.cm-content', { timeout: 30_000 });
    return null;
  }

  await page.waitForSelector('.cm-content', { timeout: 20_000 });
  return null;
}

/**
 * Seed N encrypted notes straight into IndexedDB.
 *
 * Uses the device key the app stored during unlock, and reproduces the envelope
 * format from `src/core/crypto/envelope.ts`. Duplicating the format here is
 * deliberate: if the format changes without this being updated, the seeded data
 * fails to decrypt and the benchmark fails loudly rather than measuring
 * something that is not the real thing.
 *
 * Every twentieth note is pinned (at most 50), and three in ten carry one to
 * three `#tags` from a pool of 200 — the shape of a collection someone actually
 * organises, so the pin ordering and the tag index are measured under load.
 * Unpinned metas are written without `pinnedAt`, as the app writes them.
 *
 * It also plants two literal phrases in disjoint sets of notes, for the phrase
 * search bench: that measurement is only honest if most candidates hold the
 * words *without* being a match, or the verification loop exits on its first
 * read and measures nothing. That costs nothing but body text, so it is always
 * on.
 *
 * Records are sealed bound (envelope version 2: the AAD is the header plus
 * `hushjot:<kind>:<id>`). `{ legacy: true }` seals them as version 1 instead —
 * the format a vault written before binding holds — for the gate that proves
 * the one-time re-seal (`bench:phase3`).
 *
 * `{ folders: true }` additionally files the notes across a small nested tree,
 * for the `in:` bench. It is **opt-in** because folders are not free to other
 * callers: a populated sidebar is taller, which moves the note list down the
 * viewport, and `bench:rowMenu` asserts against where the first row lands.
 */
export function seedEncryptedNotes(page, count, { folders = false, legacy = false } = {}) {
  return page.evaluate(async ({ n, withFolders, unbound }) => {
    const openDb = () =>
      new Promise((res, rej) => {
        const r = indexedDB.open('teksto');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await openDb();

    const deviceKey = await new Promise((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').get('vault:deviceKey');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!deviceKey) throw new Error('no device key: the vault must be unlocked first');

    const enc = new TextEncoder();
    // Version 2 (bound) or 1 (legacy), AES-256-GCM.
    const header = new Uint8Array([unbound ? 1 : 2, 1]);

    const seal = async (text, kind, id) => {
      const ctx = unbound ? new Uint8Array(0) : enc.encode(`hushjot:${kind}:${id}`);
      const aad = new Uint8Array(header.length + ctx.length);
      aad.set(header, 0);
      aad.set(ctx, header.length);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
          deviceKey,
          enc.encode(text),
        ),
      );
      const out = new Uint8Array(14 + ct.length);
      out.set(header, 0);
      out.set(nonce, 2);
      out.set(ct, 14);
      return out;
    };

    const TOPICS = ['postgres', 'docker', 'rust', 'kubernetes', 'terraform', 'redis', 'nginx'];
    const SNIPPET = 'SELECT id, name FROM customers WHERE active = true;';

    // A nested folder tree, so `in:` has a subtree to scope to and the sidebar
    // renders a real hierarchy. Two levels, because `in:Work` has to mean
    // "Work and everything under it" and a flat list cannot show that.
    const FOLDERS = [
      { id: 'bench_f_work', name: 'Work', parentId: null },
      { id: 'bench_f_infra', name: 'Infra', parentId: 'bench_f_work' },
      { id: 'bench_f_data', name: 'Data', parentId: 'bench_f_work' },
      { id: 'bench_f_personal', name: 'Personal', parentId: null },
    ];
    // Leaves and the root get notes; `Work` itself stays empty so a scoped
    // search there can only succeed by recursing.
    const FILED = withFolders
      ? ['bench_f_infra', 'bench_f_data', 'bench_f_personal', null]
      : [null];

    if (withFolders) {
      // Seal first, write second. An IndexedDB transaction goes inactive the
      // moment the microtask queue yields, so an `await` between opening one
      // and calling `put` silently loses the write — the same reason the note
      // loop below builds all its rows before it opens a transaction.
      const folderRows = [];
      for (const f of FOLDERS) {
        folderRows.push({
          id: f.id,
          data: await seal(JSON.stringify({ name: f.name, parentId: f.parentId }), 'folder', f.id),
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          deleted: false,
        });
      }
      await new Promise((res, rej) => {
        const tx = db.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        for (const row of folderRows) store.put(row);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }

    // Two phrases, planted in disjoint sets of notes. Every note contains all
    // four words, so the index alone can never answer either query — only the
    // worker's adjacency check can. Disjoint matters: a bench that alternates
    // between two queries returning the *same* notes renders nothing new, and
    // anything waiting on the result to change waits forever.
    const PHRASE_EVERY = 50;

    const CHUNK = 250;
    for (let i = 0; i < n; i += CHUNK) {
      const upper = Math.min(n, i + CHUNK);
      const rows = [];
      for (let j = i; j < upper; j++) {
        const topic = TOPICS[j % TOPICS.length];
        const title = `${topic} note ${j}`;
        const tagCount = j % 10 < 3 ? 1 + (j % 3) : 0;
        const tags = Array.from({ length: tagCount }, (_, k) => `#t${(j * 7 + k * 31) % 200}`).join(' ');
        const content =
          `# ${title}\n\nhostname-${j}.internal.example.com token_${j.toString(36)}\n\n` +
          '```sql\n' + SNIPPET + '\n```\n\n' +
          `Notes about ${topic} number ${j}. `.repeat(12) +
          // Every note holds all four words; which pair is adjacent differs.
          (j % PHRASE_EVERY === 0
            ? '\n\nThe connection pool is saturated, and the cache is warm.\n'
            : j % PHRASE_EVERY === PHRASE_EVERY / 2
              ? '\n\nThe cache warms slowly, so the pool holds every connection.\n'
              : '\n\nA pool of spare cache, and one warm connection to it.\n') +
          (tags ? `\n\n${tags}\n` : '');
        const pinned = j % 20 === 0 && j / 20 < 50;
        // Mirrors what the app seals (`excerptOf` in core/notes/model.ts): the
        // text after the title line, capped. Without it every seeded row shows
        // a blank second line and the phone list benches measure the wrong
        // thing.
        const excerpt = `hostname-${j}.internal.example.com token_${j.toString(36)}`.slice(0, 100);
        const meta = {
          title,
          folderId: FILED[j % FILED.length],
          ...(pinned ? { pinnedAt: 1_700_000_000_000 + j } : {}),
          excerpt,
        };
        const id = `bench_${String(j).padStart(6, '0')}`;
        rows.push({
          id,
          meta: await seal(JSON.stringify(meta), 'note-meta', id),
          body: await seal(content, 'note-body', id),
          updatedAt: 1_700_000_000_000 + j,
        });
      }

      await new Promise((res, rej) => {
        const tx = db.transaction(['noteMeta', 'noteBody'], 'readwrite');
        const meta = tx.objectStore('noteMeta');
        const body = tx.objectStore('noteBody');
        for (const row of rows) {
          meta.put({
            id: row.id,
            meta: row.meta,
            updatedAt: row.updatedAt,
            revision: 1,
            deleted: false,
          });
          body.put({ id: row.id, body: row.body });
        }
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }

    db.close();
    return n;
  }, { n: count, withFolders: folders, unbound: legacy });
}
