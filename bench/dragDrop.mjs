/**
 * Dragging a note into a folder, and a folder into a folder.
 *
 * A gate rather than a report, and a browser one rather than a unit test, for
 * the reason `rowMenu.mjs` gives about itself: the rule table is unit-tested in
 * `tests/unit/dragDrop.test.ts`, but everything around it — whether a drag
 * starts at all, whether the drop target sees it, whether the highlight is
 * cleared — is platform behaviour that has no meaning outside a real browser
 * and fails invisibly in development.
 *
 * **Two kinds of drag are used here, on purpose.**
 *
 * Playwright drives a native drag by intercepting the mouse and replaying it
 * through CDP, which delivers `dragstart` and `drop` but *not* the stream of
 * `dragover` events in between — so it can prove a drag completes and cannot
 * observe anything while one is in flight. Every check that is about
 * mid-flight state (the highlight, spring-loading, a refused target) therefore
 * dispatches real `DragEvent`s over one shared `DataTransfer`, which is what a
 * browser does and what the handlers actually read. One native drag is kept as
 * the end-to-end case, because only it proves the row is draggable at all.
 *
 * Three checks exist because of a specific hazard:
 *
 * - The list is seeded past `VIRTUALIZE_ABOVE` so the drag source is the
 *   **destroyed-on-scroll** kind. A drag whose `<li>` is torn out mid-flight
 *   never delivers `dragend` to that node, which is why the teardown lives on
 *   the window.
 *
 * - `.list .row` is counted **during** a drag. `bench/scale.mjs` budgets 60 at
 *   10,000 notes, and an implementation that added a placeholder row or a
 *   per-row node would blow it at the one moment nothing else is looking.
 *
 * - A file drag is dispatched **over a folder row** and must still reach the
 *   import dialog. The two drags coexist only because their `dataTransfer`
 *   formats do not overlap, and nothing else in the suite covers that seam.
 *
 * Note the selectors say `.folders:not(.tags)`: the Tags section is a second
 * `ul.folders` and reuses `.folder-wrap`, so an unscoped selector matches
 * every tag in the sidebar.
 */
import { chromium } from 'playwright';
import { enterApp, seedEncryptedNotes, chooseStart, BENCH_PASSPHRASE } from './lib/app.mjs';
import { build, preview } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(here, 'dist-dragdrop');

const NOTES = 150; // past VIRTUALIZE_ABOVE (100)
const ROW_BUDGET = 60; // bench/scale.mjs
const SPRING_MS = 500; // src/ui/state/drag.svelte.ts
const FOLDERS = 'ul.folders:not(.tags)';

console.log('Building app…');
await build({ root: repoRoot, logLevel: 'error', build: { outDir } });
const server = await preview({ root: repoRoot, build: { outDir }, preview: { port: 5193, strictPort: true } });
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch();
const results = [];
const failures = [];
const pageErrors = [];

function check(name, passed, detail = '') {
  results.push({ check: name, verdict: passed ? 'pass' : 'FAIL', detail });
  if (!passed) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err).split('\n')[0].slice(0, 160));
  }
}

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));

await enterApp(page, base);
await page.waitForTimeout(300);

/** Folders go through the real write path; the name comes from a prompt. */
async function addFolder(name) {
  await page.evaluate((n) => {
    window.prompt = () => n;
  }, name);
  await page.click('button[aria-label="New folder"]');
  await page.waitForSelector(`${FOLDERS} .folder-name:text-is("${name}")`, { timeout: 10_000 });
  await page.waitForTimeout(250);
}

async function addSubfolder(parentName, name) {
  await page.evaluate((n) => {
    window.prompt = () => n;
  }, name);
  // The per-row `+` is revealed on hover; force past that rather than
  // depending on the pointer staying where it was left.
  await page.click(`button[aria-label="New subfolder in ${parentName}"]`, { force: true });
  await page.waitForSelector(`${FOLDERS} .folder-name:text-is("${name}")`, { timeout: 10_000 });
  await page.waitForTimeout(250);
}

await addFolder('Work');
await addFolder('Code');
await addSubfolder('Code', 'Rust');

await seedEncryptedNotes(page, NOTES);
await page.reload({ waitUntil: 'load' });
await chooseStart(page, 'device');
if (await page.locator('#pass').count()) {
  await page.fill('#pass', BENCH_PASSPHRASE);
  await page.click('button[type="submit"]');
}
await page.waitForSelector('.list .row', { timeout: 30_000 });
await page.waitForTimeout(500);

const rowCount = () => page.locator('.list .row').count();

check(
  'the list is virtualized, so the drag source is the destroyable kind',
  (await rowCount()) < NOTES,
  `${await rowCount()} of ${NOTES} rows in the DOM`,
);

function folderRow(name) {
  return name === null
    ? page.locator(`${FOLDERS} .folder-wrap`).first()
    : page
        .locator(`${FOLDERS} .folder-wrap`)
        .filter({ has: page.locator(`.folder-name:text-is("${name}")`) });
}

const countIn = async (name) => Number((await folderRow(name).locator('.count').textContent())?.trim() ?? '0');
const highlighted = () => page.locator(`${FOLDERS} .drop-over, ${FOLDERS} .drop-invalid`).count();

/**
 * Begin a drag in the page and keep its `DataTransfer` alive, the way a real
 * drag does. `what` is 'note' or a folder name.
 */
function beginDrag(what) {
  return page.evaluate((w) => {
    const dt = new DataTransfer();
    window.__drag = dt;
    const source =
      w === 'note'
        ? document.querySelector('.list li[data-note-id]')
        : [...document.querySelectorAll('ul.folders:not(.tags) .folder-wrap')].find((el) =>
            el.querySelector(`.folder-name`)?.textContent?.trim() === w,
          );
    if (!source) throw new Error(`no drag source for ${w}`);
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { types: [...dt.types], data: dt.getData('application/x-hushjot-move') };
  }, what);
}

/** Move the drag over a folder row (null is "All notes"). */
function dragOver(name) {
  return page.evaluate((n) => {
    const rows = [...document.querySelectorAll('ul.folders:not(.tags) .folder-wrap')];
    const wrap =
      n === null ? rows[0] : rows.find((el) => el.querySelector('.folder-name')?.textContent?.trim() === n);
    if (!wrap) throw new Error(`no folder row for ${n}`);
    const box = wrap.getBoundingClientRect();
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    const fire = (type) =>
      wrap.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__drag, ...at }),
      );
    fire('dragenter');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__drag, ...at });
    wrap.dispatchEvent(over);
    // `defaultPrevented` is exactly how the browser decides whether the drop
    // may happen at all, so it is the honest read of "would this be accepted".
    return { accepted: over.defaultPrevented, dropEffect: window.__drag.dropEffect };
  }, name);
}

function dropOn(name) {
  return page.evaluate((n) => {
    const rows = [...document.querySelectorAll('ul.folders:not(.tags) .folder-wrap')];
    const wrap =
      n === null ? rows[0] : rows.find((el) => el.querySelector('.folder-name')?.textContent?.trim() === n);
    wrap.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__drag }),
    );
    window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__drag }));
  }, name);
}

const endDrag = () =>
  page.evaluate(() => window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__drag })));

// --- the drag really starts from a row ------------------------------------

await scenario('the note row offers a drag with our formats and no text/plain', async () => {
  const started = await beginDrag('note');
  check(
    'dragstart carries both hushjot formats',
    started.types.includes('application/x-hushjot-move') && started.types.includes('application/x-hushjot-note'),
    JSON.stringify(started.types),
  );
  check('and nothing the editor would insert', !started.types.includes('text/plain'), JSON.stringify(started.types));
  check('the payload names the note', /^note:.+/.test(started.data), started.data);
  await endDrag();
});

// --- mid-flight state ------------------------------------------------------

await scenario('a folder row lights up under a note drag', async () => {
  await beginDrag('note');
  const over = await dragOver('Work');
  const rowsDuringDrag = await rowCount();
  check('the drop is accepted', over.accepted === true);
  check('the row is highlighted', (await page.locator(`${FOLDERS} .drop-over`).count()) === 1);
  check(
    'the list gained no DOM rows during the drag',
    rowsDuringDrag > 0 && rowsDuringDrag <= ROW_BUDGET,
    `${rowsDuringDrag} rows, budget ${ROW_BUDGET}`,
  );
  await endDrag();
  check('the highlight is cleared when the drag ends', (await highlighted()) === 0);
});

await scenario('dropping a note where it already is offers nothing', async () => {
  await beginDrag('note');
  // Every seeded note starts at the top level, which "All notes" is.
  const over = await dragOver(null);
  check('the top-level row declines a note already there', over.accepted === false);
  await endDrag();
});

await scenario('a note dropped on a folder lands in it, announced and undoable', async () => {
  const before = await countIn('Work');
  const title = (await page.locator('.list .row .title').first().textContent())?.trim() ?? '';
  await beginDrag('note');
  await dragOver('Work');
  await dropOn('Work');
  await page.waitForTimeout(400);
  check('the note is in the folder', (await countIn('Work')) === before + 1, `${before} → ${await countIn('Work')}`);
  const flash = (await page.locator('.flash[role="status"]').textContent()) ?? '';
  check('the move is announced in the live region', flash.includes(title) && flash.includes('Work'), flash.slice(0, 80));
  check('with an undo', (await page.locator('.flash .flash-action', { hasText: 'Undo' }).count()) === 1);
});

await scenario('undo puts the note back', async () => {
  const before = await countIn('Work');
  await page.locator('.flash .flash-action', { hasText: 'Undo' }).click();
  await page.waitForTimeout(400);
  check('the note left the folder again', (await countIn('Work')) === before - 1, `${before} → ${await countIn('Work')}`);
});

// --- folders ---------------------------------------------------------------

await scenario('a folder cannot be dropped inside its own subtree', async () => {
  const rows = await page.locator(`${FOLDERS} .folder-wrap`).count();
  await beginDrag('Code');
  const over = await dragOver('Rust');
  check('the drop is refused', over.accepted === false);
  check('and the row says so', (await page.locator(`${FOLDERS} .drop-invalid`).count()) === 1);
  await dropOn('Rust');
  await page.waitForTimeout(300);
  check(
    'the tree is unchanged',
    (await page.locator(`${FOLDERS} .folder-wrap`).count()) === rows,
    `${rows} rows before, ${await page.locator(`${FOLDERS} .folder-wrap`).count()} after`,
  );
});

await scenario('a folder dropped on its current parent offers nothing', async () => {
  await beginDrag('Rust');
  const over = await dragOver('Code');
  check('the parent it already has declines it', over.accepted === false);
  await endDrag();
});

await scenario('a folder dropped elsewhere is re-parented', async () => {
  await beginDrag('Rust');
  const over = await dragOver('Work');
  check('the drop is accepted', over.accepted === true);
  await dropOn('Work');
  await page.waitForTimeout(400);
  const indent = await folderRow('Rust').evaluate((el) => el.style.paddingLeft);
  check('Rust is now indented under Work', indent === '14px', `padding-left ${indent || 'none'}`);
  check(
    'the move is announced',
    ((await page.locator('.flash[role="status"]').textContent()) ?? '').includes('Work'),
  );
});

await scenario('hovering a collapsed folder springs it open', async () => {
  await page.click('button[aria-label="Collapse Work"]');
  await page.waitForTimeout(250);
  check('Rust is hidden while Work is collapsed', (await folderRow('Rust').count()) === 0);

  await beginDrag('note');
  await dragOver('Work');
  await page.waitForTimeout(SPRING_MS + 350);
  const sprung = (await folderRow('Rust').count()) === 1;
  await endDrag();
  check('the collapsed folder opened under the drag', sprung);
});

// --- teardown --------------------------------------------------------------

await scenario('an abandoned drag leaves no row lit up', async () => {
  await beginDrag('note');
  await dragOver('Work');
  check('a row is lit while the drag is over it', (await highlighted()) === 1);
  // Let go over nothing at all: only `dragend` arrives.
  await endDrag();
  await page.waitForTimeout(200);
  check('no folder row is still highlighted', (await highlighted()) === 0);
});

await scenario('a drag survives its source row being destroyed', async () => {
  const before = await countIn('Work');
  const started = await beginDrag('note');
  // Scroll far past the source row: virtualization destroys the <li> the drag
  // began on while it is still in flight.
  await page.locator('.list').evaluate((el) => {
    const scroller = el.parentElement ?? el;
    scroller.scrollTop = 4000;
  });
  await page.waitForTimeout(200);
  check('the source row is gone', (await page.locator(`.list li[data-note-id="${started.data.slice(5)}"]`).count()) === 0);
  await dragOver('Work');
  await dropOn('Work');
  await page.waitForTimeout(400);
  check('the drop still landed', (await countIn('Work')) === before + 1, `${before} → ${await countIn('Work')}`);
});

// --- the seam with file import --------------------------------------------

await scenario('a file dragged over a folder row still reaches import', async () => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# hello'], 'note.md', { type: 'text/markdown' }));
    const wrap = [...document.querySelectorAll('ul.folders:not(.tags) .folder-wrap')][1];
    const box = wrap.getBoundingClientRect();
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    for (const type of ['dragenter', 'dragover', 'drop']) {
      wrap.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    }
  });
  await page.waitForTimeout(700);
  check(
    'the import dialog opened',
    (await page.locator('[role="dialog"]', { hasText: 'Import' }).count()) > 0,
    (await page.locator('[role="dialog"]').first().textContent())?.slice(0, 60) ?? 'no dialog',
  );
  check('and no folder row took the file', (await highlighted()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
});

// --- the native gesture, end to end ---------------------------------------

/*
 * The one check that proves the row is draggable to a real pointer. Playwright
 * replays this through CDP and delivers no `dragover` in between, so it can
 * only be asked whether the note arrived — which is exactly the thing the
 * synthetic sequences above cannot prove.
 */
await scenario('a real pointer drag moves a note into a folder', async () => {
  const before = await countIn('Code');
  await page.locator('.list').evaluate((el) => {
    const scroller = el.parentElement ?? el;
    scroller.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await page.locator('.list li[data-note-id]').first().dragTo(folderRow('Code'));
  await page.waitForTimeout(500);
  check('the note arrived', (await countIn('Code')) === before + 1, `${before} → ${await countIn('Code')}`);
});

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
await server.close();

console.table(results);
if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length} checks):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nDrag and drop: all checks passed.');
