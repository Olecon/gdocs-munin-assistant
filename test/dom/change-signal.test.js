'use strict';
// The content script's change signal on a fake Docs page (jsdom): the observer of the editor container sends at most
// one DOC_CHANGED { source: 'page' } per second while the drawn document changes (cursor overlays and the drawing
// right after a scroll do not count); the keydown estimate of the hidden iframe's document and of the page's own
// document (DOC_TYPED deltas: printable keys, a space after a word, Enter, Backspace, Ctrl+V); the listeners attached
// again after Docs replaced the iframe node; a beforeinput in the same 250 ms window wins over the keydown estimate;
// GET_SIGNAL_STATE. The page runs on a manual clock (loadContent({ clock: true })): every wait is c.clock.advance(ms)
// on the page's own time, so the windows below (RENDER_QUIET after a scroll, REMOTE_QUIET after a key, KEY_TWIN_MS
// between the two documents) hold however slowly the machine runs the test.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadContent } = require('../lib/dom-sandbox');

const changes = (c, source) => c.sent.filter((m) => m.type === 'DOC_CHANGED' && (!source || m.source === source));
const typedMsgs = (c) => c.sent.filter((m) => m.type === 'DOC_TYPED');
// The content script's timers, 20 times shorter (their ratios kept): PAGE_CHANGE_GAP 1000, RENDER_QUIET 500,
// PASTE_TAIL 1000, REMOTE_QUIET 2000, CHANGE_QUIET 2000, TYPED_COALESCE 250 ms in the shipped file; KEY_TWIN_MS 15 ms
// as shipped.
const FAST = { PAGE_CHANGE_GAP: 50, RENDER_QUIET: 25, PASTE_TAIL: 50, REMOTE_QUIET: 100, CHANGE_QUIET: 100, TYPED_COALESCE: 13 };
const GAP = FAST.PAGE_CHANGE_GAP;
const KEY_TWIN_MS = 15;
const total = (c) => typedMsgs(c).reduce((a, m) => ({ dChars: a.dChars + m.dChars, dWords: a.dWords + m.dWords }), { dChars: 0, dWords: 0 });

// The page with the panel open and one drawn line, its setup messages cleared. at(source): the clock times (from the
// end of the setup) of the DOC_CHANGED messages of that source.
async function open() {
  const c = await loadContent({ consts: FAST, clock: true });
  const sendMessage = c.chrome.runtime.sendMessage;
  let times = [];
  c.chrome.runtime.sendMessage = (msg) => { times.push({ msg, t: c.clock.now() }); return sendMessage(msg); };
  await c.send({ type: 'TOGGLE_PANEL' }); // the panel exists: the listeners and the observer start
  const editor = c.document.querySelector('.kix-appview-editor');
  editor.insertAdjacentHTML('beforeend', '<div class="kix-page"><div class="kix-lineview">First line</div></div>');
  await c.clock.advance(GAP * 2); // the page's own setup mutations are out of the way
  c.sent.length = 0;
  times = [];
  const t0 = c.clock.now();
  const at = (source) => times.filter((e) => e.msg.type === 'DOC_CHANGED' && e.msg.source === source).map((e) => e.t - t0);
  return { c, editor, page: editor.querySelector('.kix-page'), at };
}

const keyIn = (doc, key, init = {}, target = doc.body) => {
  const W = doc.defaultView;
  target.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
};

test('the page observer: one DOC_CHANGED per PAGE_CHANGE_GAP while the drawn document changes, remote without local keys', async () => {
  const { c, page, at } = await open();
  try {
    // 25 changes GAP / 10 apart (at 0 … 2.4 GAP): the first starts a gap, the first change after each message the
    // next one; the last message comes GAP after the change that started its gap, less than GAP after the last change
    for (let i = 0; i < 25; i++) { page.insertAdjacentHTML('beforeend', `<div class="kix-lineview">line ${i}</div>`); await c.clock.advance(GAP / 10); }
    await c.clock.advance(GAP * 1.2);
    assert.deepStrictEqual(at('page'), [GAP, 2 * GAP, 3 * GAP]);
    assert.deepStrictEqual(changes(c, 'page')[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'page', remote: true });
    await c.clock.advance(GAP * 3);
    assert.strictEqual(changes(c, 'page').length, 3); // quiet: nothing more
    assert.strictEqual(changes(c).length, 3); // no key or input event: no input message
  } finally { c.close(); }
});

test('the page observer: an aria-label or text change counts; cursors and the drawing after a scroll do not', async () => {
  const { c, editor, page } = await open();
  try {
    page.insertAdjacentHTML('beforeend', '<div class="kix-cursor"><div class="kix-cursor-caret"></div></div>');
    const caret = page.querySelector('.kix-cursor-caret');
    caret.setAttribute('aria-label', 'Ann');
    caret.appendChild(c.document.createElement('span'));
    await c.clock.advance(GAP * 2);
    assert.strictEqual(changes(c).length, 0);
    editor.dispatchEvent(new c.window.Event('scroll'));
    page.insertAdjacentHTML('beforeend', '<div class="kix-lineview">drawn after the scroll</div>');
    await c.clock.advance(FAST.RENDER_QUIET - 1);
    page.insertAdjacentHTML('beforeend', '<div class="kix-lineview">still drawn after the scroll</div>'); // within RENDER_QUIET
    await c.clock.advance(GAP * 2);
    assert.strictEqual(changes(c).length, 0);
    page.querySelector('.kix-lineview').setAttribute('aria-label', 'First line edited');
    await c.clock.advance(GAP - 1);
    assert.strictEqual(changes(c, 'page').length, 0); // the message comes one gap after the change
    await c.clock.advance(1);
    assert.strictEqual(changes(c, 'page').length, 1, 'DOC_CHANGED after the aria-label');
    page.querySelector('.kix-lineview').firstChild.data = 'First line, typed';
    await c.clock.advance(GAP);
    assert.strictEqual(changes(c, 'page').length, 2, 'DOC_CHANGED after the text');
    assert.strictEqual(changes(c).length, 2);
  } finally { c.close(); }
});

test('the page observer: a change right after local keys is not remote; the input source follows 2 s after the keys', async () => {
  const { c, page, at } = await open();
  try {
    keyIn(c.editorDoc, 'a');
    page.querySelector('.kix-lineview').firstChild.data = 'First linea';
    await c.clock.advance(FAST.CHANGE_QUIET - 1);
    assert.deepStrictEqual(at('page'), [GAP]); // GAP after the key: within REMOTE_QUIET
    assert.strictEqual(changes(c, 'page')[0].remote, false);
    assert.strictEqual(changes(c, 'input').length, 0); // CHANGE_QUIET after the key, not before
    await c.clock.advance(1);
    assert.deepStrictEqual(at('input'), [FAST.CHANGE_QUIET]);
    assert.deepStrictEqual(changes(c, 'input')[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
    // a change whose message comes more than REMOTE_QUIET after the last key is remote
    page.querySelector('.kix-lineview').firstChild.data = 'First lineab';
    await c.clock.advance(GAP);
    assert.deepStrictEqual(at('page'), [GAP, FAST.CHANGE_QUIET + GAP]);
    assert.ok(FAST.CHANGE_QUIET + GAP > FAST.REMOTE_QUIET);
    assert.deepStrictEqual(changes(c, 'page').map((m) => m.remote), [false, true]);
  } finally { c.close(); }
});

test('keydown in the hidden iframe: printable keys, a space after a word, Enter, Backspace, Ctrl+V (0)', async () => {
  const { c } = await open();
  try {
    for (const k of ['h', 'i', ' ', ' ']) keyIn(c.editorDoc, k);
    await c.clock.advance(FAST.TYPED_COALESCE - 1);
    assert.strictEqual(typedMsgs(c).length, 0); // one message per TYPED_COALESCE window, at its end
    await c.clock.advance(1);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(typedMsgs(c)[0], { type: 'DOC_TYPED', tabId: 7, docId: 'DOC123', dChars: 4, dWords: 1 });
    keyIn(c.editorDoc, 'x');
    keyIn(c.editorDoc, 'Enter');
    keyIn(c.editorDoc, 'Backspace');
    keyIn(c.editorDoc, 'v', { ctrlKey: true });
    keyIn(c.editorDoc, 'z', { metaKey: true });
    keyIn(c.editorDoc, 'Shift'); // no text: not counted
    keyIn(c.editorDoc, 'b', { ctrlKey: true }); // formatting: not counted
    await c.clock.advance(FAST.TYPED_COALESCE);
    assert.strictEqual(typedMsgs(c).length, 2, 'the second DOC_TYPED');
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
    keyIn(c.document, 'd', {}, page); // Docs forwarding the same key at once: counted once
    await c.clock.advance(FAST.TYPED_COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    await c.clock.advance(FAST.TYPED_COALESCE * 2);
    assert.strictEqual(typedMsgs(c).length, 1);
    assert.deepStrictEqual(total(c), { dChars: 3, dWords: 0 });
    // within KEY_TWIN_MS the same key in the other document is the same key; from KEY_TWIN_MS on it is another one
    keyIn(c.editorDoc, 'e');
    await c.clock.advance(KEY_TWIN_MS - 1);
    keyIn(c.document, 'e', {}, page);
    keyIn(c.editorDoc, 'f');
    await c.clock.advance(KEY_TWIN_MS);
    keyIn(c.document, 'f', {}, page);
    await c.clock.advance(FAST.TYPED_COALESCE * 2);
    assert.deepStrictEqual(total(c), { dChars: 3 + 1 + 2, dWords: 0 });
  } finally { c.close(); }
});

test('the iframe node replaced: the new document is listened to (body observer)', async () => {
  const { c, editor } = await open();
  try {
    c.iframe.remove();
    const f = c.document.createElement('iframe');
    f.className = 'docs-texteventtarget-iframe';
    editor.appendChild(f);
    await c.clock.advance(0); // the body observer's records
    keyIn(f.contentDocument, 'q');
    keyIn(f.contentDocument, 'r');
    await c.clock.advance(FAST.TYPED_COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED from the new iframe');
    assert.deepStrictEqual(total(c), { dChars: 2, dWords: 0 });
    const st = await c.send({ type: 'GET_SIGNAL_STATE' });
    assert.strictEqual(st.listening, true);
    assert.strictEqual(st.stats.iframeSwaps, 1);
    await c.clock.advance(GAP * 2);
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
    await c.clock.advance(FAST.TYPED_COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 3, dWords: 0 });
    keyIn(c.editorDoc, 'b'); // a window without input events: the keydown estimate
    await c.clock.advance(FAST.TYPED_COALESCE);
    assert.strictEqual(typedMsgs(c).length, 2, 'the second DOC_TYPED');
    assert.deepStrictEqual(typedMsgs(c)[1].dChars, 1);
  } finally { c.close(); }
});

test('GET_SIGNAL_STATE: the observed container and the hidden iframe', async () => {
  const c = await loadContent({ consts: FAST });
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
