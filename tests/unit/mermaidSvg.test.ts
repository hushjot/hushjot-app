// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../../src/editor/preview/mermaidSvg.ts';

const PREFIX = 'hj-mermaid-1';

function clean(svg: string): SVGSVGElement | null {
  // XML, as `mermaid.ts` parses it first.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return sanitizeSvg(doc, PREFIX);
}

const wrap = (inner: string): string =>
  `<svg id="${PREFIX}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${inner}</svg>`;

describe('sanitizeSvg', () => {
  it('returns null when there is no svg', () => {
    expect(clean('<p xmlns="http://www.w3.org/1999/xhtml">no diagram</p>')).toBeNull();
  });

  it('keeps ordinary drawing', () => {
    const svg = clean(wrap('<style>#hj-mermaid-1 .node{fill:red}</style><g class="node"><rect width="4" height="4"/><text>A</text></g>'))!;
    expect(svg.querySelector('rect')).not.toBeNull();
    expect(svg.querySelector('style')?.textContent).toContain('.node');
    expect(svg.querySelector('text')?.textContent).toBe('A');
  });

  it('drops elements that can run, embed or animate', () => {
    const svg = clean(
      wrap(
        '<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><p xmlns="http://www.w3.org/1999/xhtml">html</p>' +
          '<image href="https://example.com/a.png"/><a href="#x"><set attributeName="href" to="javascript:alert(1)"/></a>' +
          '<animate attributeName="href" values="javascript:alert(1)"/>',
      ),
    )!;
    for (const tag of ['script', 'foreignObject', 'image', 'set', 'animate', 'div', 'p']) {
      expect(svg.getElementsByTagName(tag)).toHaveLength(0);
    }
  });

  it('drops event handlers', () => {
    const svg = clean(wrap('<rect onclick="alert(1)" onload="alert(2)" width="1"/>'))!;
    const rect = svg.querySelector('rect')!;
    expect(rect.getAttribute('onclick')).toBeNull();
    expect(rect.getAttribute('onload')).toBeNull();
    expect(rect.getAttribute('width')).toBe('1');
    expect(svg.getAttribute('onload')).toBeNull();
  });

  it('keeps fragment hrefs and drops every other href', () => {
    const svg = clean(
      wrap('<a id="a" href="javascript:alert(1)"/><a id="b" xlink:href=" javascript:x"/><use id="c" href="#hj-mermaid-1-m"/>'),
    )!;
    expect(svg.querySelector(`[id="${PREFIX}-a"]`)!.getAttribute('href')).toBeNull();
    expect(svg.querySelector(`[id="${PREFIX}-b"]`)!.attributes.length).toBe(1);
    expect(svg.querySelector(`[id="${PREFIX}-c"]`)!.getAttribute('href')).toBe('#hj-mermaid-1-m');
  });

  it('moves note-derived ids under the prefix, references included', () => {
    const svg = clean(
      wrap(
        '<marker id="sync"/><path marker-end="url(#sync)"/><use href="#sync"/>' +
          '<title id="t">x</title><g aria-labelledby="t"/><g id="hj-mermaid-1_own"/>',
      ),
    )!;
    expect(svg.querySelector('[id="sync"]')).toBeNull();
    expect(svg.querySelector('marker')!.id).toBe(`${PREFIX}-sync`);
    expect(svg.querySelector('path')!.getAttribute('marker-end')).toBe(`url(#${PREFIX}-sync)`);
    expect(svg.querySelector('use')!.getAttribute('href')).toBe(`#${PREFIX}-sync`);
    expect(svg.querySelector('g[aria-labelledby]')!.getAttribute('aria-labelledby')).toBe(`${PREFIX}-t`);
    expect(svg.querySelector('[id="hj-mermaid-1_own"]')).not.toBeNull();
    expect(svg.id).toBe(PREFIX);
  });
});
