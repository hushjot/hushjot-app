/**
 * Diagnostic for the lean Markdown support: does it actually assign highlight
 * tags, and do fenced-code grammars really load lazily and re-parse?
 *
 * Uses highlightTree() rather than guessing at DOM class names, so the check
 * is about the tags the parser assigns, not about CodeMirror's generated CSS.
 */
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { markdownLean } from '../../src/editor/markdownLean.ts';
import { codeLanguages } from '../../src/editor/languages.ts';

const DOC = `# Heading one

**bold** _italic_ ~~strike~~ \`code\`

[link](https://example.com)

\`\`\`rust
fn main() {
    let greeting = "hello";
    println!("{}", greeting);
}
\`\`\`

\`\`\`sql
SELECT id, name FROM customers WHERE active = true;
\`\`\`

\`\`\`python
def add(a, b):
    return a + b
\`\`\`
`;

function collectNodes(state: EditorState): string[] {
  const seen: string[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      seen.push(`${n.name}@${n.from}-${n.to}`);
    },
  });
  return seen;
}

function collectHighlightTags(state: EditorState): { count: number; classes: string[] } {
  const classes = new Set<string>();
  let count = 0;
  highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to, cls) => {
    void from;
    void to;
    count++;
    classes.add(cls);
  });
  return { count, classes: [...classes] };
}

async function probe(label: string, langExtension: Extension) {
  const host = document.createElement('div');
  host.style.height = '600px';
  document.getElementById('editor')!.appendChild(host);

  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        lineNumbers(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langExtension,
      ],
    }),
    parent: host,
  });

  const before = {
    nodes: collectNodes(view.state).length,
    highlight: collectHighlightTags(view.state),
  };

  // Ground truth for "did the fenced code actually highlight": count the
  // coloured spans the editor renders inside the code block. Tree.iterate does
  // not descend into mounted overlay trees, so inspecting node names cannot
  // see nested grammars — the DOM can.
  const codeSpansIn = (): number => {
    let n = 0;
    for (const line of view.dom.querySelectorAll('.cm-line')) {
      const text = line.textContent ?? '';
      if (/fn main|let greeting|println|SELECT id|def add|return a/.test(text)) {
        n += line.querySelectorAll('span[class]').length;
      }
    }
    return n;
  };

  const spansBefore = codeSpansIn();

  // Poll until the lazily-imported grammars land (or give up).
  const started = performance.now();
  const deadline = started + 8000;
  let rustLoaded = false;
  let elapsed = 0;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (codeSpansIn() > spansBefore) {
      rustLoaded = true;
      elapsed = performance.now() - started;
      break;
    }
  }
  const spansAfter = codeSpansIn();

  const after = {
    nodes: collectNodes(view.state),
    highlight: collectHighlightTags(view.state),
  };

  // What did the network actually fetch? Proves the grammars were separate.
  const fetched = performance
    .getEntriesByType('resource')
    .map((e) => e.name.split('/').pop()!)
    .filter((n) => n.endsWith('.js'));

  const result = {
    label,
    beforeLoad: { nodeCount: before.nodes, highlightRanges: before.highlight.count },
    afterLoad: {
      nodeCount: after.nodes.length,
      highlightRanges: after.highlight.count,
    },
    codeSpansBefore: spansBefore,
    codeSpansAfter: spansAfter,
    lazyGrammarLoaded: rustLoaded,
    lazyLoadMs: Math.round(elapsed),
    nestedNodeSample: after.nodes
      .filter((n) => !/^(Document|Paragraph|Text|HeaderMark|EmphasisMark|LinkMark|CodeMark)@/.test(n))
      .slice(0, 40),
    jsChunksFetched: fetched.length,
  };

  view.destroy();
  host.remove();
  return result;
}

async function run() {
  // Decisive A/B: if the official package nests fenced code and ours does not,
  // the bug is in markdownLean. If neither nests, the test is wrong.
  const lean = await probe('markdownLean', markdownLean({ codeLanguages }));
  const { markdown } = await import('@codemirror/lang-markdown');
  const official = await probe('lang-markdown', markdown({ codeLanguages }));
  return { lean, official };
}

declare global {
  interface Window {
    __spike: () => Promise<unknown>;
  }
}

window.__spike = run;
