'use strict';
// The content script's typing estimate (DOC_TYPED) on a fake Docs page (jsdom): input events in the editor's hidden
// event-target iframe become character and word deltas, coalesced to at most one message per 250 ms (50 ms under test); typed text,
// a typed space ending a word, Enter, Backspace, a paste (the paste event or insertFromPaste), a drop, a deleted
// selection, undo (0 / 0), an input event after its beforeinput counted once, nothing before the panel exists. The page
// runs on a manual clock (loadContent({ clock: true })): the waits are c.clock.advance(ms) on the page's own time.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadContent } = require('../lib/dom-sandbox');

const typedMsgs = (c) => c.sent.filter((m) => m.type === 'DOC_TYPED');
// The content script's coalescing window (TYPED_COALESCE, 250 ms in the shipped file), shorter under test.
const COALESCE = 50;

// The page with the panel open. c.at: the clock time of each DOC_TYPED.
async function open() {
  const c = await loadContent({ consts: { TYPED_COALESCE: COALESCE }, clock: true });
  const sendMessage = c.chrome.runtime.sendMessage;
  c.at = [];
  c.chrome.runtime.sendMessage = (msg) => { if (msg.type === 'DOC_TYPED') c.at.push(c.clock.now()); return sendMessage(msg); };
  await c.send({ type: 'TOGGLE_PANEL' }); // the panel exists: the editor listeners are attached
  const W = c.editorDoc.defaultView;
  const target = c.editorDoc.body;
  const before = (inputType, data = null, extra = {}) => {
    const e = new W.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data });
    for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  const input = (inputType, data = null) => target.dispatchEvent(new W.InputEvent('input', { bubbles: true, inputType, data }));
  const typeText = (s) => { for (const ch of s) { before('insertText', ch); input('insertText', ch); } };
  const dt = (text) => ({ getData: (t) => (t === 'text/plain' ? text : '') });
  return { c, W, target, before, input, typeText, dt };
}

// The sum of the deltas sent so far.
const total = (c) => typedMsgs(c).reduce((a, m) => ({ dChars: a.dChars + m.dChars, dWords: a.dWords + m.dWords }), { dChars: 0, dWords: 0 });

test('typing five characters and a space: one DOC_TYPED with +6 characters and +1 word', async () => {
  const { c, typeText } = await open();
  try {
    typeText('hello ');
    await c.clock.advance(COALESCE - 1);
    assert.strictEqual(typedMsgs(c).length, 0); // coalesced: not before TYPED_COALESCE
    await c.clock.advance(1);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(typedMsgs(c)[0], { type: 'DOC_TYPED', tabId: 7, docId: 'DOC123', dChars: 6, dWords: 1 });
    await c.clock.advance(COALESCE * 2);
    assert.strictEqual(typedMsgs(c).length, 1);
  } finally { c.close(); }
});

test('steady typing sends at most one DOC_TYPED per TYPED_COALESCE; the deltas add up', async () => {
  const { c, typeText } = await open();
  try {
    const t0 = c.clock.now();
    // a character every COALESCE / 5 (at 0 … 2.2 COALESCE): the first starts a window, the first one after each message
    // the next; every message comes COALESCE after the character that started its window
    for (let i = 0; i < 12; i++) { typeText(i % 4 === 3 ? ' ' : 'a'); await c.clock.advance(COALESCE / 5); }
    await c.clock.advance(COALESCE * 2);
    assert.deepStrictEqual(c.at.map((t) => t - t0), [COALESCE, 2 * COALESCE, 3 * COALESCE]);
    assert.deepStrictEqual(typedMsgs(c).map((m) => [m.dChars, m.dWords]), [[5, 1], [5, 1], [2, 1]]); // aaa a | aa aa | a(space)
    assert.deepStrictEqual(total(c), { dChars: 12, dWords: 3 });
  } finally { c.close(); }
});

test('Enter ends a word, Backspace takes one character, a space after a space is no word, undo counts 0', async () => {
  const { c, before, typeText } = await open();
  try {
    typeText('ab');
    before('insertParagraph');
    typeText('  ');
    before('deleteContentBackward');
    before('deleteWordBackward');
    before('historyUndo');
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    // a, b, the paragraph (+1 word), two spaces (no word: after the paragraph break), two deletions, the undo
    assert.deepStrictEqual(total(c), { dChars: 3, dWords: 1 });
  } finally { c.close(); }
});

test('an undo alone still sends DOC_TYPED (0 / 0): the panel reads soon', async () => {
  const { c, before } = await open();
  try {
    before('historyUndo');
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 0, dWords: 0 });
  } finally { c.close(); }
});

test('a paste: the paste event counts the text and its words once; a drop counts its dataTransfer', async () => {
  const { c, W, target, before, dt } = await open();
  try {
    const paste = new W.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: dt('Pasted four short words') });
    target.dispatchEvent(paste);
    before('insertFromPaste', null, { dataTransfer: dt('Pasted four short words') }); // the same paste: not again
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 23, dWords: 4 });
    before('insertFromDrop', null, { dataTransfer: dt('two words') });
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 2, 'the drop');
    assert.deepStrictEqual(typedMsgs(c)[1], { type: 'DOC_TYPED', tabId: 7, docId: 'DOC123', dChars: 9, dWords: 2 });
    // a beforeinput insertFromPaste without a paste event counts by itself
    before('insertFromPaste', null, { dataTransfer: dt('one') });
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 3, 'the second paste');
    assert.deepStrictEqual(total(c), { dChars: 35, dWords: 7 });
  } finally { c.close(); }
});

test('an input event after its beforeinput is counted once; an input event alone counts', async () => {
  const { c, before, input } = await open();
  try {
    before('insertText', 'x');
    input('insertText', 'x');
    input('insertText', 'y'); // no beforeinput for this one
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: 2, dWords: 0 });
  } finally { c.close(); }
});

test('Delete on a selection subtracts the selection\'s characters and words', async () => {
  const { c, W, target, before } = await open();
  try {
    target.textContent = 'two words';
    const range = c.editorDoc.createRange();
    range.selectNodeContents(target);
    const sel = c.editorDoc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const r = await c.send({ type: 'GET_SELECTION' }); // the live read fills the selection cache
    assert.strictEqual(r.text, 'two words');
    target.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    before('deleteContentForward');
    await c.clock.advance(COALESCE);
    assert.strictEqual(typedMsgs(c).length, 1, 'DOC_TYPED');
    assert.deepStrictEqual(total(c), { dChars: -9, dWords: -2 });
  } finally { c.close(); }
});

test('no DOC_TYPED before the panel was opened on the page', async () => {
  const c = await loadContent({ consts: { TYPED_COALESCE: COALESCE }, clock: true });
  try {
    const W = c.editorDoc.defaultView;
    c.editorDoc.body.dispatchEvent(new W.InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'a' }));
    await c.clock.advance(COALESCE * 2);
    assert.strictEqual(typedMsgs(c).length, 0);
    assert.deepStrictEqual(c.clock.pending().filter((ms) => ms <= COALESCE * 2), []); // nothing waiting to send either
  } finally { c.close(); }
});
