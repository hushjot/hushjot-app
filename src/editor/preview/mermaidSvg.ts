/**
 * The allow-list pass over mermaid's parsed SVG, before `mermaid.ts` adopts it
 * into the page. Its own module so the unit tests can reach it without loading
 * mermaid; `mermaid.ts` explains why the pass exists and what precedes it.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG elements that can run, embed, fetch or rewrite attributes over time. */
const DROPPED = new Set([
  'script',
  'foreignObject',
  'image',
  'feImage',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'discard',
]);

/** Attributes whose value is a space-separated list of ids. */
const ID_LISTS = ['aria-labelledby', 'aria-describedby'];

/**
 * Make mermaid's parsed output safe to adopt. Returns the `<svg>` to insert, or
 * `null` when the document is not one. `prefix` must be an id this page made;
 * every id not already under it is moved under it, references included.
 */
export function sanitizeSvg(doc: Document, prefix: string): SVGSVGElement | null {
  const svg = doc.querySelector('svg');
  if (!svg || svg.namespaceURI !== SVG_NS) return null;

  for (const el of [...svg.querySelectorAll('*')]) {
    if (el.namespaceURI !== SVG_NS || DROPPED.has(el.localName)) el.remove();
  }

  const ids = new Map<string, string>();
  const all = [svg, ...svg.querySelectorAll('*')];
  for (const el of all) {
    const id = el.getAttribute('id');
    if (id === null || id.startsWith(prefix)) continue;
    const renamed = `${prefix}-${id}`;
    ids.set(id, renamed);
    el.setAttribute('id', renamed);
  }
  const rename = (id: string): string => ids.get(id) ?? id;

  for (const el of all) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on')) {
        el.removeAttributeNode(attr);
      } else if (attr.localName === 'href') {
        const target = value.trim();
        if (target.startsWith('#')) attr.value = `#${rename(target.slice(1))}`;
        else el.removeAttributeNode(attr);
      } else if (ID_LISTS.includes(name)) {
        attr.value = value.split(/\s+/).map(rename).join(' ');
      } else if (value.includes('url(')) {
        attr.value = value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_, q: string, id: string) => `url(${q}#${rename(id)}${q})`);
      }
    }
  }
  return svg;
}
