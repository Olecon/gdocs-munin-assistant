'use strict';
// Ctrl+C on a chat selection (onChatCopy in src/dom.js): the clipboard gets plain text and cleaned HTML
// without the panel's colours, fonts, classes or UI rows; copies outside the chat are left to the browser.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

let env, T, el, document, window;
before(async () => { env = await load(); ({ T, el, document, window } = env); });
after(() => env.close());

const ANSWER = 'Intro with **bold words** here.\n\n- first item\n- second [link](https://example.com/a?b=1)\n\n```js\nconst x = 1;\n```\n\nThe end.';

function renderAnswer() {
  el.chat.innerHTML = '';
  const b = T.addAssistantBubble();
  T.updateAssistantBubble(b, { text: ANSWER, usage: { total_tokens: 4321, prompt_tokens: 4000, completion_tokens: 321 },
    activity: [{ name: 'read_document', summary: 'lines 1-40' }] });
  b.querySelector('.md').setAttribute('style', 'color: white; background-color: black');
  return b;
}

// Selects from (startNode, startOffset) to (endNode, endOffset) and dispatches a copy event on target.
function copy(target, start, end) {
  const range = document.createRange();
  range.setStart(...start); range.setEnd(...end);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  const data = {};
  const cd = { setData: (type, v) => { data[type] = v; } };
  const ev = new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: cd });
  target.dispatchEvent(ev);
  return { data, prevented: ev.defaultPrevented, text: sel.toString() };
}
const textIn = (root, needle) => { // first text node containing needle
  const w = document.createTreeWalker(root, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.includes(needle)) return n;
  throw new Error('no text ' + needle);
};

test('copy inside an answer: HTML keeps structure and drops styles, classes, buttons and the code label', () => {
  const b = renderAnswer();
  const md = b.querySelector('.md');
  const from = textIn(md, 'Intro'); const to = textIn(md, 'The end');
  const r = copy(from.parentElement, [from, 0], [to, 3]);
  assert.ok(r.prevented);
  // the code block's language label ("js") is panel UI: left out, so the plain text is rebuilt from the cleaned copy
  assert.match(r.text, /js/);
  assert.strictEqual(r.data['text/plain'], 'Intro with bold words here.\n\nfirst item\nsecond link\n\nconst x = 1;\n\nThe');
  const html = r.data['text/html'];
  assert.match(html, /<strong>bold words<\/strong>/);
  assert.match(html, /<ul><li>first item<\/li>/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1">link<\/a>/);
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
  for (const bad of [/style=/, /class=/, /color/i, /background/i, /<button/, /<svg/, /target=/, /<style/]) assert.doesNotMatch(html, bad);
});

test('without panel UI in the selection the plain text is the browser\'s own selection text', () => {
  const b = renderAnswer();
  const md = b.querySelector('.md');
  const from = textIn(md, 'Intro'); const to = textIn(md, 'second');
  const r = copy(md, [from, 6], [to, 4]);
  assert.ok(r.prevented);
  assert.strictEqual(r.data['text/plain'], r.text);
  assert.match(r.data['text/html'], /<strong>bold words<\/strong>.*<ul><li>first item<\/li><li>seco<\/li><\/ul>/);
});

test('a selection that includes the action log and the token usage line leaves that UI text out', () => {
  const b = renderAnswer();
  const row = b.querySelector('.activity-row');
  const meta = b.querySelector('.msg-meta');
  assert.match(meta.textContent, /tokens/);
  const from = textIn(row, 'lines 1-40'); const to = meta.firstChild;
  const r = copy(b, [from, 0], [to, to.textContent.length]);
  assert.ok(r.prevented);
  assert.match(r.text, /tokens/); // the browser's own text would carry it
  for (const type of ['text/html', 'text/plain']) {
    assert.doesNotMatch(r.data[type], /tokens|lines 1-40|read_document/, type);
    assert.match(r.data[type], /bold words/, type);
  }
  assert.match(r.data['text/plain'], /^Intro with bold words here\.\n\nfirst item\nsecond link\n\nconst x = 1;\n\nThe end\.$/);
});

test('plain text only (no element structure) sets text/plain only', () => {
  const b = renderAnswer();
  const t = textIn(b.querySelector('.md'), 'Intro');
  const r = copy(t.parentElement, [t, 0], [t, 5]);
  assert.ok(r.prevented);
  assert.deepStrictEqual(r.data, { 'text/plain': 'Intro' });
});

test('copies outside the chat, without clipboardData or with an empty selection are left to the browser', () => {
  renderAnswer();
  el.input.value = 'draft text';
  const r = copy(el.input, [el.input.parentNode, 0], [el.input.parentNode, 1]);
  assert.deepStrictEqual(r.data, {}); assert.ok(!r.prevented);
  const t = textIn(el.chat, 'Intro');
  const ev = new window.ClipboardEvent('copy', { bubbles: true, cancelable: true });
  t.parentElement.dispatchEvent(ev);
  assert.ok(!ev.defaultPrevented);
  const empty = copy(t.parentElement, [t, 2], [t, 2]);
  assert.deepStrictEqual(empty.data, {}); assert.ok(!empty.prevented);
  // a selection that starts in the chat but reaches outside it is not cleaned either
  const out = copy(t.parentElement, [t, 0], [el.input.parentNode, 0]);
  assert.deepStrictEqual(out.data, {}); assert.ok(!out.prevented);
});
