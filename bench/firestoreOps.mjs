/**
 * Billed Firestore operations, counted from inside the app.
 *
 * `src/adapters/firebase/opCount.ts` forwards every billed operation to
 * `window.__hushjotOpsSink` in emulator builds. This installs that sink on a
 * browser context with `exposeBinding`, so the count lives in Node and
 * survives what a page-side tally does not: reloads, closed tabs, and a device
 * that signs out and back in.
 *
 * Tallies are kept per context — one context is one device — so a scenario can
 * price a single device while others are still open, and also summed, so a
 * scenario can report its total.
 *
 * The numbers are the app's own accounting of Firestore's pricing rules, not a
 * bill; `opCount.ts` says where they can differ.
 */

const zero = () => ({ reads: 0, writes: 0, rulesReads: 0, byCause: {} });

function add(tally, op) {
  tally.reads += op.reads;
  tally.writes += op.writes;
  tally.rulesReads += op.rulesReads;
  const entry = (tally.byCause[op.cause] ??= { reads: 0, writes: 0, rulesReads: 0 });
  entry.reads += op.reads;
  entry.writes += op.writes;
  entry.rulesReads += op.rulesReads;
}

/** Billed reads, counting the allowlist lookups the rules make. */
export const billedReads = (tally) => tally.reads + tally.rulesReads;

export const formatOps = (tally) =>
  `${billedReads(tally)} reads (${tally.rulesReads} in rules), ${tally.writes} writes`;

/**
 * Count operations on every context the browser opens from now on.
 *
 * Patches `browser.newContext` rather than asking every scenario to opt in:
 * a context that was forgotten would count nothing and report a session as
 * cheaper than it is.
 */
export function meterBrowser(browser) {
  const perContext = new Map();
  let total = zero();

  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    perContext.set(context, zero());
    await context.exposeBinding('__hushjotOpsSink', (_source, op) => {
      // Looked up per call, because `take` swaps the tally out.
      add(perContext.get(context), op);
      add(total, op);
    });
    return context;
  };

  return {
    /** Operations since the last `take`, across every context. Resets. */
    takeTotal() {
      const taken = total;
      total = zero();
      return taken;
    },
    /** Operations on one context since its last `take`. Resets that context. */
    take(context) {
      const taken = perContext.get(context) ?? zero();
      perContext.set(context, zero());
      return taken;
    },
  };
}
