/**
 * Spike 1 — CodeMirror 6 typing latency on a large Markdown note, plus a
 * correctness check on the lean Markdown support built in Spike 5.
 *
 * Budget: keystroke p95 < 16 ms (one frame at 60 Hz).
 *
 * The number that matters is how long the main thread is *blocked* by a
 * keystroke, because that is what the user feels. We measure the synchronous
 * cost of dispatching the transaction plus the forced layout that follows it.
 *
 * Correctness matters just as much here: the lean variant only earns its 67 KB
 * saving if it highlights everything §10 requires and still lazy-loads fenced
 * code grammars.
 */
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { codeLanguages } from '../../src/editor/languages.ts';
import { generateLargeNote } from '../fixtures/notes.ts';
import { summarize, roundSummary, round } from '../lib/stats.ts';

const parent = document.getElementById('editor')!;

function extensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdownLean({ codeLanguages }),
  ];
}

/** Every construct spec §10 requires, in one document. */
const SYNTAX_PROBE = `# Heading one
## Heading two

**bold** and _italic_ and ~~strike~~ and \`inline code\`.

[a link](https://example.com)

- bullet item
- another

1. numbered
2. items

- [ ] unchecked task
- [x] done task

> a blockquote

| col a | col b |
| --- | --- |
| 1 | 2 |

---

\`\`\`rust
fn main() { println!("hi"); }
\`\`\`

\`\`\`sql
SELECT 1 FROM t WHERE x = 2;
\`\`\`
`;

/** Count the ranges the highlighter assigns — proves tags are wired up. */
function countHighlightRanges(state: EditorState): number {
  let count = 0;
  highlightTree(syntaxTree(state), defaultHighlightStyle, () => {
    count++;
  });
  return count;
}

/** Walk the syntax tree and collect the node type names present. */
function nodeTypes(state: EditorState): Set<string> {
  const seen = new Set<string>();
  syntaxTree(state).iterate({
    enter: (n) => {
      seen.add(n.name);
    },
  });
  return seen;
}

async function checkSyntaxCoverage() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({ doc: SYNTAX_PROBE, extensions: extensions() }),
    parent: host,
  });

  const required = [
    'ATXHeading1', 'ATXHeading2', 'StrongEmphasis', 'Emphasis', 'Strikethrough',
    'InlineCode', 'Link', 'BulletList', 'OrderedList', 'ListItem', 'Task',
    'Blockquote', 'Table', 'HorizontalRule', 'FencedCode',
  ];

  const present = nodeTypes(view.state);
  const missing = required.filter((r) => !present.has(r));

  // Markdown highlighting: count the ranges the highlighter actually assigns.
  const mdHighlightRanges = countHighlightRanges(view.state);

  // Fenced-code highlighting has to be checked in the DOM: Tree.iterate does
  // not descend into the mounted overlay trees that nested grammars produce.
  const codeSpans = (): number => {
    let n = 0;
    for (const line of view.dom.querySelectorAll('.cm-line')) {
      if (/fn main|println|SELECT 1/.test(line.textContent ?? '')) {
        n += line.querySelectorAll('span[class]').length;
      }
    }
    return n;
  };

  const spansBefore = codeSpans();
  const started = performance.now();
  let lazyMs = -1;
  while (performance.now() - started < 8000) {
    await new Promise((r) => setTimeout(r, 100));
    if (codeSpans() > spansBefore) {
      lazyMs = Math.round(performance.now() - started);
      break;
    }
  }

  const result = {
    requiredNodeTypesMissing: missing,
    markdownHighlightRanges: mdHighlightRanges,
    fencedCodeSpansBefore: spansBefore,
    fencedCodeSpansAfter: codeSpans(),
    lazyGrammarLoadMs: lazyMs,
  };

  view.destroy();
  host.remove();
  return result;
}

async function run() {
  const syntax = await checkSyntaxCoverage();

  const doc = generateLargeNote(200_000);

  // --- initial parse / mount cost -----------------------------------------
  const t0 = performance.now();
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: extensions() }),
    parent,
  });
  view.dom.offsetHeight; // force layout so the measurement includes it
  const initialParseMs = performance.now() - t0;

  // Let lazy grammars settle before measuring steady-state typing.
  await new Promise((r) => setTimeout(r, 2000));

  const measureAt = async (pos: number, samples: number): Promise<number[]> => {
    const out: number[] = [];
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    await new Promise(requestAnimationFrame);

    for (let i = 0; i < samples; i++) {
      const at = view.state.selection.main.head;
      const ch = 'the quick brown fox jumps '[i % 25]!;
      const start = performance.now();
      view.dispatch({
        changes: { from: at, insert: ch },
        selection: { anchor: at + 1 },
        scrollIntoView: true,
      });
      // Forced reflow: makes the browser complete the work we just queued, so
      // the sample reflects real blocking cost rather than deferred work.
      view.dom.offsetHeight;
      out.push(performance.now() - start);
      await new Promise(requestAnimationFrame);
    }
    return out;
  };

  const longTaskEntries: PerformanceEntry[] = [];
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => longTaskEntries.push(...list.getEntries()));
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask is unsupported in some engines; the sync samples still stand.
  }

  const endSamples = await measureAt(view.state.doc.length, 120);
  const midSamples = await measureAt(Math.floor(view.state.doc.length / 2), 120);
  observer?.disconnect();

  const result = {
    syntaxCoverage: syntax,
    docBytes: doc.length,
    docLines: view.state.doc.lines,
    initialMountMs: round(initialParseMs),
    keystrokeBlockMs_endOfDoc: roundSummary(summarize(endSamples), 3),
    keystrokeBlockMs_midDoc: roundSummary(summarize(midSamples), 3),
    longTasks: {
      count: longTaskEntries.length,
      totalMs: round(longTaskEntries.reduce((a, e) => a + e.duration, 0)),
      maxMs: round(longTaskEntries.reduce((a, e) => Math.max(a, e.duration), 0)),
    },
  };

  view.destroy();
  return result;
}

declare global {
  interface Window {
    __spike: () => Promise<unknown>;
  }
}

window.__spike = run;
