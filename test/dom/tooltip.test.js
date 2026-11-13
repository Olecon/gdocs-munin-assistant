'use strict';
// The panel's own hover texts (src/tooltip.js): one .tip element for every data-tip, shown after a short hover or at
// once on keyboard focus, hidden on leave, blur, Escape, scroll and a click; placed below its element, above it near
// the bottom. No native title is left in the panel's chrome (sidepanel.html, the rendered panel, the sources).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, click, mouse, key, tick } = require('../lib/dom-sandbox');

let env, T, state, el, document, window;
before(async () => {
  env = await load();
  ({ T, state, el, document, window } = env);
});
after(() => env.close());

const ROOT = path.join(__dirname, '..', '..');
const tips = () => [...document.querySelectorAll('.tip')];
const shown = () => tips().length === 1 && tips()[0].classList.contains('show');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (node, r) => { node.getBoundingClientRect = () => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height }); };
const size = (node, w, h) => {
  Object.defineProperty(node, 'offsetWidth', { configurable: true, get: () => w });
  Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => h });
};
const over = (node) => mouse(node, 'mouseover');
const out = (node, to) => mouse(node, 'mouseout', { relatedTarget: to || null });

test('hover: the tip shows after the delay with the element\'s text; leaving hides it; one tip element only', async () => {
  const btn = document.getElementById('actionBtn');
  over(btn);
  assert.ok(!shown(), 'not at once on hover');
  await wait(T.TIP_DELAY + 50);
  assert.ok(shown());
  assert.strictEqual(tips()[0].textContent, 'Send (Enter)');
  assert.strictEqual(tips()[0].getAttribute('role'), 'tooltip');
  assert.strictEqual(tips()[0].parentNode, document.body);
  // moving onto a child of the same element keeps it
  out(btn, btn.querySelector('svg'));
  over(btn.querySelector('svg'));
  assert.ok(shown());
  out(btn);
  assert.ok(!shown());
  // a hover that ends before the delay shows nothing
  over(btn);
  out(btn);
  await wait(T.TIP_DELAY + 50);
  assert.ok(!shown());
  // another element reuses the same tip
  const cmd = document.getElementById('cmdBtn');
  over(cmd);
  await wait(T.TIP_DELAY + 50);
  assert.strictEqual(tips().length, 1);
  assert.strictEqual(tips()[0].textContent, 'Commands');
  click(cmd);
  assert.ok(!shown(), 'a click hides it');
  click(cmd); // close the command list again
  out(cmd);
});

test('keyboard focus shows the tip at once; blur, Escape and a scroll hide it; an empty data-tip shows nothing', async () => {
  const btn = document.getElementById('attachBtn');
  key(document.body, 'Tab'); // the last input is the keyboard
  btn.focus();
  assert.ok(shown());
  assert.strictEqual(tips()[0].textContent, 'Attach a file');
  btn.blur();
  assert.ok(!shown());
  btn.focus();
  assert.ok(shown());
  key(btn, 'Escape');
  assert.ok(!shown());
  btn.blur();
  btn.focus();
  assert.ok(shown());
  el.chat.dispatchEvent(new window.Event('scroll'));
  assert.ok(!shown(), 'a scroll anywhere hides it');
  btn.blur();
  // a focus caused by the mouse shows no tip
  mouse(btn, 'mousedown');
  btn.focus();
  assert.ok(!shown());
  btn.blur();
  key(document.body, 'Tab');
  const q = document.getElementById('queueText');
  q.dataset.tip = '';
  q.focus();
  assert.ok(!shown());
  q.blur();
});

test('position: below the element, left-aligned; above it near the bottom; inside the panel horizontally', () => {
  const btn = document.getElementById('cmdBtn');
  key(document.body, 'Tab');
  btn.focus(); // makes the tip element
  const tip = tips()[0];
  size(tip, 120, 24);
  btn.blur();
  rect(btn, { left: 30, top: 100, width: 24, height: 20 });
  btn.focus();
  assert.deepStrictEqual([tip.style.left, tip.style.top, tip.classList.contains('above')], ['30px', '126px', false]);
  btn.blur();
  rect(btn, { left: 30, top: window.innerHeight - 30, width: 24, height: 20 });
  btn.focus();
  assert.deepStrictEqual([tip.style.left, tip.style.top, tip.classList.contains('above')], ['30px', `${window.innerHeight - 30 - 6 - 24}px`, true]);
  btn.blur();
  rect(btn, { left: window.innerWidth - 20, top: 100, width: 16, height: 20 });
  btn.focus();
  assert.strictEqual(tip.style.left, `${window.innerWidth - 120 - 4}px`);
  btn.blur();
  delete btn.getBoundingClientRect;
  assert.strictEqual(tips().length, 1);
});

test('CSS: the tip uses the theme tokens, the row size, 6 px radius, no pointer events, unselectable', () => {
  const css = fs.readFileSync(path.join(ROOT, 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = ([...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === '.tip') || [])[2] || '';
  for (const re of [/background:\s*var\(--surface-2\)/, /color:\s*var\(--fg\)/, /border:\s*1px solid var\(--border-strong\)/, /border-radius:\s*var\(--radius-sm\)/,
    /font-size:\s*var\(--row-size\)/, /max-width:\s*260px/, /pointer-events:\s*none/, /user-select:\s*none/, /position:\s*fixed/]) assert.match(body, re);
  assert.ok(!/#[0-9a-f]{3,6}\b|rgba?\(/i.test(body), 'colours only through the tokens');
});

// title stays only on links to external pages (the URL) and on inputs (validation messages).
const TITLE_ALLOWED = ['a[href^="http"]', 'input'];
const strayTitles = (root) => [...root.querySelectorAll('[title]')].filter((n) => !TITLE_ALLOWED.some((s) => n.matches(s)));
const both = (root) => [...root.querySelectorAll('[title][data-tip]')];

test('no native title in sidepanel.html', () => {
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8')).window.document;
  assert.deepStrictEqual(strayTitles(doc.body).map((n) => n.outerHTML.slice(0, 80)), []);
  assert.ok(doc.querySelectorAll('[data-tip]').length > 10);
  // the header's icon buttons carry no tooltip that repeats their name; their aria-label stays
  for (const id of ['chatSwitchBtn', 'newChatBtn', 'filesBtn', 'themeBtn', 'settingsBtn', 'collapseBtn', 'agentsBtn']) {
    assert.ok(!doc.getElementById(id).hasAttribute('data-tip'), id);
  }
  for (const id of ['chatSwitchBtn', 'newChatBtn', 'filesBtn', 'themeBtn', 'settingsBtn']) assert.ok(doc.getElementById(id).getAttribute('aria-label'), id);
});

test('no native title in the rendered panel: a turn with edits, settings, files, the menus, the agent map', async () => {
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  state.googleConnected = true;
  state.messages = [
    { role: 'user', content: 'Edit.' },
    { role: 'assistant', content: null, tool_calls: [call('t_r', 'read_lines', { start: 1, end: 2 }), call('t_a', 'replace_text', { old_text: 'A', new_text: 'O' }), call('t_b', 'delete_lines', { start: 2, end: 2 })] },
    { role: 'tool', tool_call_id: 't_r', content: 'Lines 1-2 of 2:\n1: A\n2: B', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 't_a', content: 'Done: replaced line 1.', _ok: true, _message: 'Replaced line 1', _edit: { id: 't_a', kind: 'replace', index: 1, text: 'O', restore: 'A', paras: [], undone: false } },
    { role: 'tool', tool_call_id: 't_b', content: 'Done: deleted line 2.', _ok: true, _message: 'Deleted line 2', _cardText: 'B', _cardLabel: 'Deleted text', _edit: { id: 't_b', kind: 'delete', index: 3, text: '', restore: 'B\n', paras: [], undone: false } },
    { role: 'assistant', content: 'Done. See [a page](https://example.org/p).\n\n```\ncode\n```' },
  ];
  T.renderHistory();
  assert.ok(el.chat.querySelector('[data-act="undo-all"]'), 'the rows carry Undo and Undo all');
  const opened = [];
  for (const id of ['settingsBtn', 'filesBtn', 'chatSwitchBtn', 'modeCycle', 'chatModel', 'agentsBtn']) {
    click(document.getElementById(id));
    await tick();
    opened.push([id, strayTitles(document.body).map((n) => n.outerHTML.slice(0, 80))]);
    click(document.getElementById(id));
    await tick();
  }
  for (const [id, stray] of opened) assert.deepStrictEqual(stray, [], id);
  assert.deepStrictEqual(both(document.body).map((n) => n.outerHTML.slice(0, 80)), []);
  state.messages = [];
  T.renderHistory();
});

test('the sources: no title set on an element or written into the panel\'s markup', () => {
  const dir = path.join(ROOT, 'src');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
  const bad = [];
  // data objects that have a title field (chats, files, edits, headings), not elements
  const DATA = new Set(['m', 'meta', 'first', 'err', 'entry', 'r']);
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(\w+)\.title = /g)) if (!DATA.has(m[1])) bad.push(`${path.basename(f)}:${i + 1}: ${m[0]}`);
      // markup: a title attribute on any tag except the model's own <document>/<section> blocks and external links
      for (const m of line.matchAll(/<(\w+)\b[^<>]*\stitle="/g)) if (!['document', 'section', 'a'].includes(m[1])) bad.push(`${path.basename(f)}:${i + 1}: <${m[1]} title=`);
      if (/setAttribute\(['"]title['"]/.test(line)) bad.push(`${path.basename(f)}:${i + 1}: setAttribute title`);
    });
  }
  assert.deepStrictEqual(bad, []);
});
