'use strict';
// The content script's change signal on a fake Docs page (jsdom): the observer of the editor container sends at most
// one DOC_CHANGED { source: 'page' } per second while the drawn document changes (cursor overlays and the drawing
// right after a scroll do not count); the keydown estimate of the hidden iframe's document and of the page's own
// document (DOC_TYPED deltas: printable keys, a space after a word, Enter, Backspace, Ctrl+V); the listeners attached
// again after Docs replaced the iframe node; a beforeinput in the same 250 ms window wins over the keydown estimate;
// GET_SIGNAL_STATE.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadContent, tick } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

const changes = (c, source) => c.sent.filter((m) => m.type === 'DOC_CHANGED' && (!source || m.source === source));
const typedMsgs = (c) => c.sent.filter((m) => m.type === 'DOC_TYPED');
const total = (c) => typedMsgs(c).reduce((a, m) => ({ dChars: a.dChars + m.dChars, dWords: a.dWords + m.dWords }), { dChars: 0, dWords: 0 });

async function open() {
  const c = await loadContent();
  await c.send({ type: 'TOGGLE_PANEL' }); // the panel exists: the listeners and the observer start
  const editor = c.document.querySelector('.kix-appview-editor');
  editor.insertAdjacentHTML('beforeend', '<div class="kix-page"><div class="kix-lineview">First line</div></div>');
  await tick(1200); // the page's own setup mutations are out of the way
  c.sent.length = 0;
  return { c, editor, page: editor.querySelector('.kix-page') };
}

const keyIn = (doc, key, init = {}, target = doc.body) => {
  const W = doc.defaultView;
  target.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
};

test('the page observer: one DOC_CHANGED per second while the drawn document changes, remote without local keys', async () => {
  const { c, page } = await open();
  try {
    const start = Date.now();
    for (let i = 0; i < 25; i++) { page.insertAdjacentHTML('beforeend', `<div class="kix-lineview">line ${i}</div>`); await tick(100); }
    const elapsed = Date.now() - start;
    await tick(1200);
    const n = changes(c, 'page').length;
    assert.ok(n >= 2 && n <= Math.ceil(elapsed / 1000) + 1, `${n} messages in ${elapsed + 1200} ms`);
    assert.deepStrictEqual(changes(c, 'page')[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'page', remote: true });
    await tick(1300);
    assert.strictEqual(changes(c, 'page').length, n); // quiet: nothing more
  } finally { c.close(); }
});

test('the page observer: an aria-label or text change counts; cursors and the drawing after a scroll do not', async () => {
  const { c, editor, page } = await open();
  try {
    page.insertAdjacentHTML('beforeend', '<div class="kix-cursor"><div class="kix-cursor-caret"></div></div>');
    const caret = page.querySelector('.kix-cursor-caret');
    caret.setAttribute('aria-label', 'Ann');
    caret.appendChild(c.document.createElement('span'));
    await tick(1300);
    assert.strictEqual(changes(c).length, 0);
    editor.dispatchEvent(new c.window.Event('scroll'));
    page.insertAdjacentHTML('beforeend', '<div class="kix-lineview">drawn after the scroll</div>');
    await tick(1300);
    assert.strictEqual(changes(c).length, 0);
    page.querySelector('.kix-lineview').setAttribute('aria-label', 'First line edited');
    await waitFor(() => changes(c, 'page').length === 1, 'DOC_CHANGED after the aria-label');
    page.querySelector('.kix-lineview').firstChild.data = 'First line, typed';
    await waitFor(() => changes(c, 'page').length === 2, 'DOC_CHANGED after the text');
  } finally { c.close(); }
});

test('the page observer: a change right after local keys is not remote; the input source follows 2 s after the keys', async () => {
  const { c, page } = await open();
  try {
    keyIn(c.editorDoc, 'a');
    page.querySelector('.kix-lineview').firstChild.data = 'First linea';
    await waitFor(() => changes(c, 'page').length === 1, 'the page DOC_CHANGED');
    assert.strictEqual(changes(c, 'page')[0].remote, false);
    await waitFor(() => changes(c, 'input').length === 1, 'the input DOC_CHANGED');
    assert.deepStrictEqual(changes(c, 'input')[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
  } finally { c.close(); }
});

test('keydown in the hidden iframe: printable keys, a space after a word, Enter, Backspace, Ctrl+V (0)', async () => {
  const { c } = await open();
  try {
    for (const k of ['h', 'i', ' ', ' ']) keyIn(c.editorDoc, k);
    await waitFor(() => typedMsgs(c).length === 1, 'DOC_TYPED');
    assert.deepStrictEqual(typedMsgs(c)[0], { type: 'DOC_TYPED', tabId: 7, docId: 'DOC123', dChars: 4, dWords: 1 });
    keyIn(c.editorDoc, 'x');
    keyIn(c.editorDoc, 'Enter');
    keyIn(c.editorDoc, 'Backspace');
    keyIn(c.editorDoc, 'v', { ctrlKey: true });
    keyIn(c.editorDoc, 'z', { metaKey: true });
    keyIn(c.editorDoc, 'Shift'); // no text: not counted
    keyIn(c.editorDoc, 'b', { ctrlKey: true }); // formatting: not counted
    await waitFor(() => typedMsgs(c).length === 2, 'the second DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 5, dWords: 2 }); // x, Enter (+1 word after x), -1
    const st = await c.send({ type: 'GET_SIGNAL_STATE' });
    assert.strictEqual(st.stats.keydownFrame, 9);
    assert.strictEqual(st.stats.keydownPage, 0);
  } finally { c.close(); }
});

test('keydown on the page: counted in the editor area, not in a text field; the same key in both documents once', async () => {
  const { c, page } = await open();
  try {
    keyIn(c.document, 'a', {}, page);
    keyIn(c.document, 'b', {}, c.document.body);
    const field = c.document.createElement('input');
    c.document.body.appendChild(field);
    keyIn(c.document, 'c', {}, field); // the title or a comment box: not the document
    keyIn(c.editorDoc, 'd');
    keyIn(c.document, 'd', {}, page); // Docs forwarding the same key: counted once
    await waitFor(() => typedMsgs(c).length === 1, 'DOC_TYPED');
    await tick(300);
    assert.deepStrictEqual(total(c), { dChars: 3, dWords: 0 });
  } finally { c.close(); }
});

test('the iframe node replaced: the new document is listened to (body observer)', async () => {
  const { c, editor } = await open();
  try {
    c.iframe.remove();
    const f = c.document.createElement('iframe');
    f.className = 'docs-texteventtarget-iframe';
    editor.appendChild(f);
    await tick(20);
    keyIn(f.contentDocument, 'q');
    keyIn(f.contentDocument, 'r');
    await waitFor(() => typedMsgs(c).length === 1, 'DOC_TYPED from the new iframe');
    assert.deepStrictEqual(total(c), { dChars: 2, dWords: 0 });
    const st = await c.send({ type: 'GET_SIGNAL_STATE' });
    assert.strictEqual(st.listening, true);
    assert.strictEqual(st.stats.iframeSwaps, 1);
    await tick(1300);
    assert.strictEqual(changes(c, 'page').length, 0); // the iframe node itself is not a document change
  } finally { c.close(); }
});

test('a beforeinput in the same window wins: its exact lengths, the keydown estimate dropped', async () => {
  const { c } = await open();
  try {
    const W = c.editorDoc.defaultView;
    const before = (inputType, data) => c.editorDoc.body.dispatchEvent(new W.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }));
    keyIn(c.editorDoc, 'a');
    before('insertText', 'a');
    keyIn(c.editorDoc, 'e');
    before('insertText', 'é!'); // the input event knows better than the key
    await waitFor(() => typedMsgs(c).length === 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 3, dWords: 0 });
    keyIn(c.editorDoc, 'b'); // a window without input events: the keydown estimate
    await waitFor(() => typedMsgs(c).length === 2, 'the second DOC_TYPED');
    assert.deepStrictEqual(typedMsgs(c)[1].dChars, 1);
  } finally { c.close(); }
});

test('GET_SIGNAL_STATE: the observed container and the hidden iframe', async () => {
  const c = await loadContent();
  try {
    const off = await c.send({ type: 'GET_SIGNAL_STATE' });
    assert.strictEqual(off.tracking, false); // no panel yet: nothing attached
    await c.send({ type: 'TOGGLE_PANEL' });
    const st = await c.send({ type: 'GET_SIGNAL_STATE' });
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.editor, true);
    assert.strictEqual(st.observing, true);
    assert.strictEqual(st.editorSelector, '.kix-appview-editor');
    assert.strictEqual(st.iframe, true);
    assert.strictEqual(st.listening, true);
    assert.strictEqual(typeof st.stats.mutations, 'number');
  } finally { c.close(); }
});
