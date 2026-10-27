/**
 * Mermaid diagrams for a ```` ```mermaid ```` fence, reached only by dynamic
 * import.
 *
 * ## Why it is an upgrade, like the highlighter
 *
 * Mermaid is the largest thing the preview can load — a few hundred KB gzipped
 * for the core and one diagram type, more per further type — so it must cost
 * nothing to a note without a diagram, and nothing at all to either page's
 * first load (`bench/size.mjs`). A mermaid fence renders as its source first,
 * exactly like any other fence, and is redrawn as a diagram when this module
 * and the diagram's own chunk have arrived. Offline before first use, or on a
 * diagram mermaid cannot parse, the source simply stays — with mermaid's
 * message under it in the second case, so a typo is findable.
 *
 * ## The one place the preview takes markup it did not build
 *
 * `render.ts` builds every node itself and never parses markup. Mermaid's only
 * output is an SVG **string**, so this file is the deliberate exception, and it
 * is fenced in three layers:
 *
 * 1. Mermaid runs with `securityLevel: 'strict'` — labels go through its own
 *    DOMPurify, and `click` callbacks and links are switched off — and with
 *    HTML labels off, so diagrams are drawn in SVG `<text>` rather than in
 *    `<foreignObject>` HTML.
 * 2. The string is parsed with `DOMParser` into an inert document, which runs
 *    no script and fetches nothing.
 * 3. `sanitizeSvg` (`mermaidSvg.ts`) then keeps SVG-namespace elements only, minus anything that
 *    can run, embed or animate an attribute (`<script>`, `<foreignObject>`,
 *    `<image>`, `<animate>`, `<set>` …); drops every `on*` attribute and every
 *    `href` that is not an in-diagram `#fragment`; and prefixes every id with
 *    this render's own id. Some diagram types use note text as element ids (a
 *    gantt task's id is whatever was typed), and an unprefixed one could
 *    clobber a named global or collide across tiles — the reason headings use
 *    `data-anchor` (docs/security.md, "The Markdown preview").
 *
 * Only then is the tree adopted into the page. The CSP needs nothing new:
 * mermaid's `<style>` inside the SVG is covered by `style-src 'unsafe-inline'`,
 * which CodeMirror already needs, and mermaid uses no `eval`.
 *
 * ## Colours come from the page's tokens
 *
 * Mermaid's `base` theme is fed from the live CSS variables (`index.html`,
 * `tokens:begin`), read when each diagram is drawn, so a diagram matches the
 * light or dark palette without a second copy of it here. A change of theme —
 * the `data-theme` attribute, or the system preference while that is followed —
 * redraws every diagram on the page.
 *
 * Mermaid keeps global state and is not re-entrant, so diagrams are drawn one
 * at a time through a queue. Its styles travel with it, as `copyCode.ts`'s do,
 * because `markdown.css` is charged to the share viewer's first load in full.
 */
import mermaid from 'mermaid';
import { sanitizeSvg } from './mermaidSvg.ts';

// Shown under a diagram mermaid refused, and on the diagram itself. `pre`'s
// whitespace rule would otherwise reach the SVG's text.
const STYLES = `
.markdown pre.mermaid.drawn > code { display: none; }
.markdown pre.mermaid > .mermaid-diagram { white-space: normal; text-align: center; font-family: var(--sans); }
.markdown pre.mermaid > .mermaid-diagram svg { max-width: 100%; height: auto; }
.markdown pre.mermaid > .mermaid-error {
  display: block; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border);
  color: var(--danger); font-size: 0.85em; white-space: pre-wrap;
}`;

let styled = false;

function addStyles(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
}

/** Mermaid's theme variables, from the page's current tokens. */
function themeVariables(): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  const text = token('--text');
  const border = token('--border');
  const raised = token('--bg-raised');
  const sunken = token('--bg-sunken');
  const accent = token('--accent');
  const accentSoft = token('--accent-soft');
  const dim = token('--text-dim');
  const palette = ['--accent', '--syn-function', '--syn-string', '--syn-keyword', '--syn-number', '--syn-property', '--syn-type'].map(token);
  const vars: Record<string, string | boolean> = {
    darkMode: isDark(),
    fontFamily: token('--sans'),
    fontSize: '14px',
    background: sunken,
    textColor: text,
    primaryColor: raised,
    primaryTextColor: text,
    primaryBorderColor: dim,
    secondaryColor: accentSoft,
    secondaryTextColor: text,
    secondaryBorderColor: accent,
    tertiaryColor: sunken,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    lineColor: dim,
    mainBkg: raised,
    nodeBorder: dim,
    clusterBkg: sunken,
    clusterBorder: border,
    edgeLabelBackground: sunken,
    titleColor: text,
    noteBkgColor: accentSoft,
    noteTextColor: text,
    noteBorderColor: accent,
    actorBkg: raised,
    actorBorder: dim,
    actorTextColor: text,
    actorLineColor: border,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: dim,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: accentSoft,
    activationBorderColor: accent,
    sectionBkgColor: accentSoft,
    altSectionBkgColor: sunken,
    taskBkgColor: raised,
    taskBorderColor: accent,
    taskTextColor: text,
    taskTextDarkColor: text,
    taskTextOutsideColor: text,
    activeTaskBkgColor: accentSoft,
    activeTaskBorderColor: accent,
    doneTaskBkgColor: border,
    doneTaskBorderColor: dim,
    critBorderColor: token('--danger'),
    critBkgColor: token('--danger-soft'),
    todayLineColor: accent,
    gridColor: border,
    pieStrokeColor: sunken,
    pieOuterStrokeColor: border,
    pieTitleTextColor: text,
    pieSectionTextColor: sunken,
    pieLegendTextColor: text,
  };
  palette.forEach((colour, i) => {
    vars[`pie${i + 1}`] = colour;
    vars[`cScale${i}`] = colour;
    vars[`cScaleLabel${i}`] = sunken;
  });
  return vars;
}

function isDark(): boolean {
  const chosen = document.documentElement.dataset.theme;
  if (chosen) return chosen === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

let configured = '';

function configure(): void {
  const variables = themeVariables();
  const key = JSON.stringify(variables);
  if (key === configured) return;
  configured = key;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: 'base',
    themeVariables: variables,
    fontFamily: variables.fontFamily as string,
  });
}

/** Every fence this module has been handed, for redrawing on a theme change. */
const fences = new Map<HTMLElement, string>();
let queue: Promise<void> = Promise.resolve();
let renders = 0;

export function diagramInto(pre: HTMLElement, text: string): void {
  addStyles();
  watchTheme();
  fences.set(pre, text);
  pre.classList.add('mermaid');
  enqueue(pre, text);
}

function enqueue(pre: HTMLElement, text: string): void {
  queue = queue.then(() => draw(pre, text)).catch(() => {});
}

async function draw(pre: HTMLElement, text: string): Promise<void> {
  configure();
  const id = `hj-mermaid-${++renders}`;
  let svg: SVGSVGElement | null = null;
  let error: string | null = null;
  try {
    const result = await mermaid.render(id, text);
    svg = sanitizeSvg(parse(result.svg), id);
    if (!svg) error = 'This diagram could not be drawn.';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // Mermaid can leave its scratch element behind when a diagram fails.
  document.getElementById(`d${id}`)?.remove();

  pre.querySelector(':scope > .mermaid-diagram')?.remove();
  pre.querySelector(':scope > .mermaid-error')?.remove();
  if (svg) {
    const holder = document.createElement('div');
    holder.className = 'mermaid-diagram';
    holder.append(document.importNode(svg, true));
    pre.append(holder);
    pre.classList.add('drawn');
  } else {
    pre.classList.remove('drawn');
    const note = document.createElement('span');
    note.className = 'mermaid-error';
    note.textContent = error ?? '';
    pre.append(note);
  }
}

/**
 * Mermaid's output is meant to be XML, so it is parsed as XML. Should a diagram
 * type ever emit something only HTML accepts — an `&nbsp;` is the usual one —
 * the HTML parser, which is just as inert in a `DOMParser`, gets a second try.
 */
function parse(svg: string): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length === 0) return doc;
  return parser.parseFromString(svg, 'text/html');
}

let watching = false;

function watchTheme(): void {
  if (watching) return;
  watching = true;
  const redraw = (): void => {
    for (const [pre, text] of fences) {
      // A fence that has left the page has been dropped by its renderer: it
      // keeps only the blocks it is showing.
      if (pre.isConnected) enqueue(pre, text);
      else fences.delete(pre);
    }
  };
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
}
