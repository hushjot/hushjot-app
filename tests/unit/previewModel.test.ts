import { describe, it, expect } from 'vitest';
import {
  buildModel,
  decodeEntity,
  safeHref,
  safeImageSrc,
  type PNode,
} from '../../src/editor/preview/model.ts';

/** Serialise the model for readable assertions. Test-only: the app never builds HTML strings. */
function html(nodes: PNode[]): string {
  return nodes
    .map((n) => {
      if ('text' in n) return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const attrs = Object.entries(n.attrs ?? {})
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`))
        .join('');
      return `<${n.tag}${attrs}>${html(n.children)}</${n.tag}>`;
    })
    .join('');
}

function render(text: string): string {
  return buildModel(text)
    .blocks.map((b) => html([b.node!]))
    .join('\n');
}

const REPLACEMENT = String.fromCodePoint(0xfffd);

describe('preview model: blocks', () => {
  it('renders headings with anchors, deduplicated', () => {
    expect(render('# Hello *world*\n\n## Hello world\n\nSetext\n---')).toBe(
      [
        '<h1 data-anchor="hello-world">Hello <em>world</em></h1>',
        '<h2 data-anchor="hello-world-1">Hello world</h2>',
        '<h2 data-anchor="setext">Setext</h2>',
      ].join('\n'),
    );
  });

  it('renders tight and loose lists, ordered starts and nesting', () => {
    expect(render('- a\n- b\n  - c')).toBe('<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
    expect(render('3. a\n\n4. b')).toBe('<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>');
  });

  it('renders task lists as checkboxes carrying their marker offset', () => {
    expect(render('- [ ] todo\n- [x] done')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled data-task="2" aria-label="todo"></input> todo</li>' +
        '<li class="task"><input type="checkbox" disabled checked data-task="13" aria-label="done"></input>' +
        ' done</li></ul>',
    );
  });

  it('puts a loose task box inside its paragraph, on the same line as the text', () => {
    // Before the paragraph, a block, the box sat on a line of its own. Agent
    // replies in the Inbox are loose lists, so every one rendered that way.
    expect(render('- [x] commit\n\n- [ ] deploy')).toBe(
      '<ul><li class="task"><p><input type="checkbox" disabled checked data-task="2" aria-label="commit"></input> commit</p></li>' +
        '<li class="task"><p><input type="checkbox" disabled data-task="16" aria-label="deploy"></input> deploy</p></li></ul>',
    );
  });

  it('measures a task marker from its own block, not from the document', () => {
    // The renderer keeps a block's element while the text ahead of it changes
    // length, so an absolute offset baked into the DOM would go stale.
    expect(render('# A heading\n\n- [ ] todo')).toBe(
      [
        '<h1 data-anchor="a-heading">A heading</h1>',
        '<ul><li class="task"><input type="checkbox" disabled data-task="2" aria-label="todo"></input> todo</li></ul>',
      ].join('\n'),
    );
  });

  it('leaves a task without a marker uncheckable', () => {
    expect(render('- [ ] a\n- plain')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled data-task="2" aria-label="a"></input> a</li>' +
        '<li>plain</li></ul>',
    );
  });

  it('renders fenced code with its language, stripping container prefixes', () => {
    expect(render('```ts\nconst a = 1;\n  indented\n```')).toBe(
      '<pre data-lang="ts"><code>const a = 1;\n  indented</code></pre>',
    );
    expect(render('> ```\n> quoted\n>   more\n> ```')).toBe(
      '<blockquote><pre><code>quoted\n  more</code></pre></blockquote>',
    );
    expect(render('- item\n  ```\n  in list\n  ```')).toBe(
      '<ul><li>item<pre><code>in list</code></pre></li></ul>',
    );
    expect(render('    indented\n    code')).toBe('<pre><code>indented\ncode</code></pre>');
    expect(render('```\nunclosed')).toBe('<pre><code>unclosed</code></pre>');
  });

  it('renders tables with alignment and missing cells', () => {
    expect(render('| a | b | c |\n|:--|:-:|--:|\n| 1 | | 3 |')).toBe(
      '<table><thead><tr><th class="align-left">a</th><th class="align-center">b</th><th class="align-right">c</th></tr></thead>' +
        '<tbody><tr><td class="align-left">1</td><td class="align-center"></td><td class="align-right">3</td></tr></tbody></table>',
    );
  });

  it('renders quotes, rules, breaks and inline marks', () => {
    expect(render('> **b** `c` ~~d~~\n\n---\n\nline  \nbreak')).toBe(
      [
        '<blockquote><p><strong>b</strong> <code>c</code> <del>d</del></p></blockquote>',
        '<hr></hr>',
        '<p>line<br></br>break</p>',
      ].join('\n'),
    );
  });

  it('does not render link reference definitions or HTML comments', () => {
    expect(render('[a]\n\n[a]: https://x.test\n\n<!-- hidden -->')).toBe(
      '<p><a href="https://x.test">a</a></p>',
    );
  });
});

describe('preview model: safety', () => {
  it('keeps raw HTML as literal text', () => {
    expect(render('<script>alert(1)</script>')).toBe(
      '<pre class="raw"><code>&lt;script>alert(1)&lt;/script></code></pre>',
    );
    expect(render('a <img src=x onerror=alert(1)> b')).toBe('<p>a &lt;img src=x onerror=alert(1)> b</p>');
  });

  it('turns unsafe link targets into inert text', () => {
    expect(render('[x](javascript:alert(1))')).toBe(
      '<p><span class="unsafe-link" title="javascript:alert(1)">x</span></p>',
    );
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref(' ' + String.fromCharCode(1) + 'javascript:alert(1)')).toBeNull();
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<b>')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('//evil.test/x')).toBeNull();
    expect(safeHref('relative/path')).toBeNull();
    expect(safeHref('https://ok.test/a?b#c')).toBe('https://ok.test/a?b#c');
    expect(safeHref('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(safeHref('#section')).toBe('#section');
  });

  it('never fetches images: remote ones become links, raster data URIs render', () => {
    expect(render('![a cat](https://img.test/cat.png)')).toBe(
      '<p><a href="https://img.test/cat.png" class="image-link" title="https://img.test/cat.png">🖼 a cat</a></p>',
    );
    expect(render('![x](javascript:alert(1))')).toBe('<p><span class="image-link">🖼 x</span></p>');
    expect(render('![dot](data:image/png;base64,iVBORw0KGgo=)')).toBe(
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"></img></p>',
    );
    expect(safeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeImageSrc('https://img.test/cat.png')).toBeNull();
  });

  it('links autolinks and bare URLs', () => {
    expect(render('<https://a.test> www.b.test')).toBe(
      '<p><a href="https://a.test">https://a.test</a> <a href="http://www.b.test">www.b.test</a></p>',
    );
  });

  it('decodes entities to text, never markup', () => {
    expect(render('&lt;b&gt; &amp; &#169; &#x1F600; &bogus;')).toBe('<p>&lt;b> &amp; © 😀 &amp;bogus;</p>');
    expect(decodeEntity('&#0;')).toBe(REPLACEMENT);
    expect(decodeEntity('&#xD800;')).toBe(REPLACEMENT);
  });

  it('leaves unresolved reference links as brackets', () => {
    expect(render('[not a link] and [x][missing]')).toBe('<p>[not a link] and [x][missing]</p>');
  });
});

describe('preview model: reuse', () => {
  it('keys blocks by source and reports offsets', () => {
    const { blocks } = buildModel('# A\n\npara\n\n- x');
    expect(blocks.map((b) => [b.from, b.to])).toEqual([[0, 3], [5, 9], [11, 14]]);
    expect(blocks[1]!.key).toBe('para');
  });

  it('skips building blocks the caller already holds', () => {
    const first = buildModel('one\n\ntwo\n\nthree');
    const held = new Set(first.blocks.map((b) => b.key));
    const next = buildModel('one\n\ntwo!\n\nthree', { epoch: first.epoch, has: (k) => held.has(k) });
    expect(next.blocks.map((b) => b.node === null)).toEqual([true, false, true]);
  });

  it('invalidates everything when reference definitions change', () => {
    const first = buildModel('[a]\n\n[a]: https://one.test');
    const next = buildModel('[a]\n\n[a]: https://two.test', { epoch: first.epoch, has: () => true });
    expect(next.epoch).not.toBe(first.epoch);
    expect(next.blocks.every((b) => b.node !== null)).toBe(true);
  });

  it('gives duplicate headings different keys', () => {
    const keys = buildModel('# X\n\n# X').blocks.map((b) => b.key);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('preview model: tags', () => {
  const tag = (key: string, label = key) => `<button class="tag" type="button" data-tag="${key}">#${label}</button>`;

  it('makes inline tags into buttons', () => {
    expect(render('Plans for #Work and #home/garden.')).toBe(
      `<p>Plans for ${tag('work', 'Work')} and ${tag('home/garden')}.</p>`,
    );
  });

  it('finds a tag at the start, and after an inline node', () => {
    expect(render('#first then **bold** #after')).toBe(`<p>${tag('first')} then <strong>bold</strong> ${tag('after')}</p>`);
  });

  it('leaves code, links, headings marks, anchors and colours alone', () => {
    expect(render('`#code`')).toBe('<p><code>#code</code></p>');
    expect(render('```\n#nope\n```')).not.toContain('button');
    expect(render('[#label](https://example.com)')).not.toContain('button');
    expect(render('[jump](#section)')).not.toContain('button');
    expect(render('**bold**#glued')).not.toContain('button');
    expect(render('colour #ff0000, issue #12')).not.toContain('button');
    expect(render('# Heading #tagged')).toContain(tag('tagged'));
  });

  it('keeps trailing punctuation as text', () => {
    expect(render('done #next-')).toBe(`<p>done ${tag('next')}-</p>`);
  });
});

describe('preview model: note links', () => {
  const link = (target: string, label = target) =>
    `<button class="notelink" type="button" data-note="${target}" disabled>${label}</button>`;

  it('renders a link as a button carrying its target', () => {
    expect(render('See [[Design Review]] first.')).toBe(`<p>See ${link('Design Review')} first.</p>`);
  });

  it('shows the label and keeps the target', () => {
    expect(render('[[Design Review|the review]]')).toBe(`<p>${link('Design Review', 'the review')}</p>`);
  });

  it('collapses whitespace in the target, so one reference has one spelling', () => {
    expect(render('[[  My   Note  ]]')).toBe(`<p>${link('My Note')}</p>`);
  });

  it('renders disabled, so a caller with nowhere to navigate is inert', () => {
    // render.ts removes `disabled` only where the page passed a resolver: the
    // share viewer and the history panel pass none. Same rule as a checkbox.
    expect(render('[[A Note]]')).toContain('disabled');
  });

  it('never gives a link an href, so there is no scheme to judge', () => {
    expect(render('[[A Note]]')).not.toContain('href');
  });

  it('does not make a tag out of a link label', () => {
    // The label is plain text and never goes through `prose()`, so a nested
    // button is unreachable — what `#noTags` buys an ordinary link label.
    const out = render('[[A #work note]]');
    expect(out).not.toContain('class="tag"');
    expect(out).toBe(`<p>${link('A #work note')}</p>`);
  });

  it('leaves what is not a link as the brackets it always was', () => {
    expect(render('[[]] and [[a[b]] and [[open')).toBe('<p>[[]] and [[a[b]] and [[open</p>');
    expect(render('`[[code]]`')).toBe('<p><code>[[code]]</code></p>');
  });

  it('leaves an ordinary Markdown link alone', () => {
    expect(render('[label](https://example.test)')).toBe(
      '<p><a href="https://example.test">label</a></p>',
    );
  });
});
