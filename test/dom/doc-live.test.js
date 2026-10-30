'use strict';
// The live document line in a real DOM (jsdom): the content script's DOC_CHANGED signal (input events in the
// editor's hidden iframe, one message after 2 s of quiet), the plain document line in the panel header (no ↻
// control, nothing clickable) and the visibilitychange wake-up of the poll.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, loadContent, textResponse, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');

test('content script: typing in the editor iframe sends one DOC_CHANGED after 2 s of quiet', async () => {
  const c = await loadContent();
  try {
    await c.send({ type: 'TOGGLE_PANEL' }); // the panel exists: the editor listeners are attached
    const W = c.editorDoc.defaultView;
    const changes = () => c.sent.filter((m) => m.type === 'DOC_CHANGED');
    c.editorDoc.body.dispatchEvent(new W.Event('beforeinput', { bubbles: true }));
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true }));
    await tick(1000);
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true })); // still typing: the wait starts again
    await tick(1500);
    assert.strictEqual(changes().length, 0);
    await waitFor(() => changes().length === 1, 'DOC_CHANGED');
    assert.deepStrictEqual(changes()[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
    await tick(2200);
    assert.strictEqual(changes().length, 1); // one message per burst
  } finally { c.close(); }
});

test('content script: no DOC_CHANGED before the panel was opened on the page', async () => {
  const c = await loadContent();
  try {
    const W = c.editorDoc.defaultView;
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true }));
    await tick(2200);
    assert.strictEqual(c.sent.filter((m) => m.type === 'DOC_CHANGED').length, 0);
  } finally { c.close(); }
});

test('panel: the document line has no ↻ control and nothing clickable; a shown panel wakes the poll', async () => {
  const p = await load({ hash: '#tabId=7' });
  try {
    installDocTab(p);
    const exportsSeen = [];
    let body = 'First text';
    p.ctx.fetch = async (url) => {
      if (/\/export\?format=md/.test(url)) { exportsSeen.push(url); return textResponse(body); }
      throw new Error('unexpected fetch ' + url);
    };
    assert.strictEqual(p.document.getElementById('docRefresh'), null);
    assert.ok(!/Re-read the document|↻/.test(p.document.querySelector('.title-wrap').innerHTML));
    const line = p.document.getElementById('docStatus');
    assert.strictEqual(line.parentElement.className, 'title-wrap');
    assert.strictEqual(line.querySelector('button, a, [role="button"]'), null);
    await p.T.refreshContext({ force: true });
    // the page becomes visible: the poll wakes up and reads; a DOC_CHANGED is read 3 s later
    Object.defineProperty(p.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.document.dispatchEvent(new p.window.Event('visibilitychange'));
    await waitFor(() => p.state.docText === 'First text', 'the first read');
    assert.strictEqual(line.textContent, '10 characters · 2 words');
    assert.ok(p.T.docLive.timer, 'a poll timer');
    body = 'Second text!';
    p.T.docLive.readAt = -Infinity; // the floor is tested on the fake clock (test/doc-live.test.js)
    p.T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
    await tick(3000); // the export is read 3 s after the signal
    await waitFor(() => p.state.docText === 'Second text!', 'the re-read');
    assert.strictEqual(exportsSeen.length, 2);
    assert.strictEqual(line.textContent, '12 characters · 2 words');
  } finally { p.close(); }
});
