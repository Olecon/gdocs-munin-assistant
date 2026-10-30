'use strict';
// The Markdown-lite renderer (renderInline / renderMarkdown in src/dom.js) on a real DOM: links (balanced
// parentheses, underscores and asterisks in URLs, unsafe schemes), escaping, code, headings, lists, fences.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');
const { deq } = require('../lib/sandbox');

let env, T, document;
// Renders Markdown into a detached container and returns it (real HTML parsing of the output).
const md = (src) => { const d = document.createElement('div'); d.innerHTML = T.renderMarkdown(src).html; return d; };
const inline = (src) => { const d = document.createElement('div'); d.innerHTML = T.renderInline(src); return d; };

before(async () => {
  env = await load();
  T = env.T;
  document = env.document;
});
after(() => env.close());

test('links: balanced parentheses in the URL, no stray ")"', () => {
  const d = inline('See [w](https://en.wikipedia.org/wiki/Lipid_raft_(biology)) for details.');
  const a = d.querySelectorAll('a');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].getAttribute('href'), 'https://en.wikipedia.org/wiki/Lipid_raft_(biology)');
  assert.strictEqual(a[0].textContent, 'w');
  assert.strictEqual(a[0].getAttribute('target'), '_blank');
  assert.strictEqual(a[0].getAttribute('rel'), 'noopener noreferrer');
  assert.strictEqual(d.textContent, 'See w for details.');
  // a link followed by a parenthesis outside it; two links on a line; a link inside parentheses
  let x = inline('[a](https://x.org/p) (note) and [b](https://y.org/q_(r)_s)');
  assert.deepStrictEqual([...x.querySelectorAll('a')].map((n) => n.getAttribute('href')), ['https://x.org/p', 'https://y.org/q_(r)_s']);
  assert.strictEqual(x.textContent, 'a (note) and b');
  x = inline('(see [docs](https://example.com/a))');
  assert.strictEqual(x.querySelector('a').getAttribute('href'), 'https://example.com/a');
  assert.strictEqual(x.textContent, '(see docs)');
});

test('links: underscores and asterisks inside the URL are not emphasis', () => {
  let d = inline('[x](https://example.com/_private_/file) and _real em_');
  assert.strictEqual(d.querySelector('a').getAttribute('href'), 'https://example.com/_private_/file');
  assert.strictEqual(d.querySelector('a em'), null);
  assert.deepStrictEqual([...d.querySelectorAll('em')].map((e) => e.textContent), ['real em']);
  d = inline('[y](https://example.com/a*b*c) **bold**');
  assert.strictEqual(d.querySelector('a').getAttribute('href'), 'https://example.com/a*b*c');
  assert.strictEqual(d.querySelectorAll('em').length, 0);
  assert.strictEqual(d.querySelector('strong').textContent, 'bold');
  d = inline('[z](https://example.com/__init__.py)');
  assert.strictEqual(d.querySelector('a').getAttribute('href'), 'https://example.com/__init__.py');
  assert.strictEqual(d.querySelector('strong'), null);
  // emphasis inside the label still works
  d = inline('[**Bold** label](https://example.com/x)');
  assert.strictEqual(d.querySelector('a strong').textContent, 'Bold');
  assert.strictEqual(d.querySelector('a').textContent, 'Bold label');
});

test('links: only http(s); javascript: and data: are never linkified', () => {
  for (const src of ['[x](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox)', '[x](//evil.example)']) {
    const d = inline(src);
    assert.strictEqual(d.querySelectorAll('a').length, 0, src);
    assert.strictEqual(d.querySelectorAll('script').length, 0, src);
    assert.strictEqual(d.textContent, src, src); // shown as typed
  }
  assert.strictEqual(inline('[ok](http://example.com)').querySelector('a').getAttribute('href'), 'http://example.com');
});

test('escaping: quotes, <, & in text and in attributes', () => {
  const d = inline('a < b & "c" \'d\' <img src=x onerror=alert(1)>');
  assert.strictEqual(d.textContent, 'a < b & "c" \'d\' <img src=x onerror=alert(1)>');
  assert.strictEqual(d.querySelectorAll('img').length, 0);
  // an attribute-breaking URL stays inside href
  const l = inline('[q](https://example.com/?a=1&b="x"onmouseover=alert(1))');
  const a = l.querySelector('a');
  assert.ok(a, 'linkified');
  assert.strictEqual(a.getAttribute('href'), 'https://example.com/?a=1&b="x"onmouseover=alert(1)');
  assert.strictEqual(a.getAttribute('onmouseover'), null);
  assert.deepStrictEqual(a.getAttributeNames().sort(), ['href', 'rel', 'target']);
  // the label is escaped too
  const lb = inline('[<b>x</b> & y](https://example.com)');
  assert.strictEqual(lb.querySelector('a').textContent, '<b>x</b> & y');
  assert.strictEqual(lb.querySelectorAll('b').length, 0);
  // code blocks and the language label
  const c = md('```html\n<script>alert("x")</script> & more\n```');
  assert.strictEqual(md('```<x>\ny').querySelectorAll('x, pre').length, 0); // not a fence: escaped paragraph text
  assert.strictEqual(c.querySelectorAll('script').length, 0);
  assert.strictEqual(c.querySelector('pre code').textContent, '<script>alert("x")</script> & more');
});

test('inline code keeps asterisks, underscores and brackets literally', () => {
  const d = inline('Use `a*b*c` and `__x__` or `[l](https://e.com)`; *em* here');
  assert.deepStrictEqual([...d.querySelectorAll('code')].map((c) => c.textContent), ['a*b*c', '__x__', '[l](https://e.com)']);
  assert.strictEqual(d.querySelectorAll('code em, code strong, code a').length, 0);
  assert.deepStrictEqual([...d.querySelectorAll('em')].map((e) => e.textContent), ['em']);
  assert.strictEqual(inline('`<b>&amp;</b>`').querySelector('code').textContent, '<b>&amp;</b>');
});

test('bold, italic, strike; snake_case and 2*3*4 stay plain', () => {
  const d = inline('**b1** __b2__ *i1* _i2_ ~~s~~');
  assert.deepStrictEqual([...d.querySelectorAll('strong')].map((e) => e.textContent), ['b1', 'b2']);
  assert.deepStrictEqual([...d.querySelectorAll('em')].map((e) => e.textContent), ['i1', 'i2']);
  assert.strictEqual(d.querySelector('del').textContent, 's');
  const p = inline('snake_case_name and 2*3*4 and a * b * c');
  assert.strictEqual(p.querySelectorAll('em, strong').length, 0);
  assert.strictEqual(p.textContent, 'snake_case_name and 2*3*4 and a * b * c');
  assert.strictEqual(inline('***both***').querySelector('strong em, em strong') != null || inline('***both***').querySelector('strong') != null, true);
});

test('block structure: headings, lists, quotes, rules, paragraphs, fenced code with buttons', () => {
  const src = [
    '# Title', '## Sub', '###### Deep', '', 'Para line 1', 'para line 2', '', '- one', '* two', '+ three', '  continued',
    '', '1. first', '2) second', '', '> quoted *em*', '', '---', '', '```js', 'const a = 1 * 2;', '', '**not bold**', '```', 'after',
  ].join('\n');
  const { html, codes } = T.renderMarkdown(src);
  const d = document.createElement('div'); d.innerHTML = html;
  assert.deepStrictEqual([...d.children].map((c) => c.tagName.toLowerCase()), ['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'blockquote', 'hr', 'div', 'p']);
  assert.deepStrictEqual([...d.querySelectorAll('h2, h3, h4')].map((h) => h.textContent), ['Title', 'Sub', 'Deep']);
  assert.strictEqual(d.querySelector('p').innerHTML, 'Para line 1<br>para line 2');
  assert.deepStrictEqual([...d.querySelectorAll('ul li')].map((li) => li.textContent), ['one', 'two', 'three continued']);
  assert.deepStrictEqual([...d.querySelectorAll('ol li')].map((li) => li.textContent), ['first', 'second']);
  assert.strictEqual(d.querySelector('blockquote em').textContent, 'em');
  const wrap = d.querySelector('div.code-wrap');
  assert.strictEqual(wrap.querySelector('.code-lang').textContent, 'js');
  assert.strictEqual(wrap.querySelector('pre code').textContent, 'const a = 1 * 2;\n\n**not bold**');
  assert.strictEqual(wrap.querySelectorAll('strong').length, 0);
  assert.deepStrictEqual([...wrap.querySelectorAll('button[data-act]')].map((b) => [b.dataset.act, b.dataset.idx]), [['apply-code', '0'], ['copy-code', '0']]);
  deq(codes, ['const a = 1 * 2;\n\n**not bold**']);
  assert.strictEqual(d.lastElementChild.textContent, 'after');
  // an unterminated fence runs to the end; ~~~ fences; CRLF input
  const u = T.renderMarkdown('~~~\nx\r\ny');
  deq(u.codes,['x\ny']);
  assert.strictEqual(T.renderMarkdown('').html, '');
});
