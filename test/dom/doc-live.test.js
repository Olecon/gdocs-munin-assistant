'use strict';
// The live document line in a real DOM (jsdom): the content script's DOC_CHANGED signal (input events in the
// editor's hidden iframe, one message after 2 s of quiet; the tests shorten the timers), the plain document line in the panel header (no ↻
// control, nothing clickable) and the visibilitychange wake-up of the poll.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, loadContent, manualClock, textResponse } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');

// The content script's quiet time before DOC_CHANGED { source: 'input' } (CHANGE_QUIET, 2000 ms in the shipped
// file) and the panel's export read after a signal (DOC_LIVE_EXPORT_SIGNAL_MS, 3000 ms), 20 times shorter.
const QUIET = 100;
const EXPORT_SIGNAL = 150;

test('content script: typing in the editor iframe sends one DOC_CHANGED after CHANGE_QUIET of quiet', async () => {
  const c = await loadContent({ consts: { CHANGE_QUIET: QUIET }, clock: true }); // the page's timers on a manual clock
  try {
    await c.send({ type: 'TOGGLE_PANEL' }); // the panel exists: the editor listeners are attached
    const W = c.editorDoc.defaultView;
    const changes = () => c.sent.filter((m) => m.type === 'DOC_CHANGED');
    c.editorDoc.body.dispatchEvent(new W.Event('beforeinput', { bubbles: true }));
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true }));
    await c.clock.advance(QUIET / 2);
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true })); // still typing: the wait starts again
    await c.clock.advance(QUIET - 1); // past the first input's CHANGE_QUIET, not past the second one's
    assert.strictEqual(changes().length, 0);
    await c.clock.advance(1); // CHANGE_QUIET after the second input
    assert.strictEqual(changes().length, 1, 'DOC_CHANGED');
    assert.deepStrictEqual(changes()[0], { type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
    await c.clock.advance(QUIET * 2);
    assert.strictEqual(changes().length, 1); // one message per burst
  } finally { c.close(); }
});

test('content script: no DOC_CHANGED before the panel was opened on the page', async () => {
  const c = await loadContent({ consts: { CHANGE_QUIET: QUIET }, clock: true });
  try {
    const W = c.editorDoc.defaultView;
    c.editorDoc.body.dispatchEvent(new W.Event('input', { bubbles: true }));
    await c.clock.advance(QUIET * 2);
    assert.strictEqual(c.sent.filter((m) => m.type === 'DOC_CHANGED').length, 0);
  } finally { c.close(); }
});

test('panel: the document line has no ↻ control and nothing clickable; a shown panel wakes the poll', async () => {
  const p = await load({ hash: '#tabId=7', consts: { DOC_LIVE_EXPORT_SIGNAL_MS: EXPORT_SIGNAL } });
  try {
    installDocTab(p);
    const clock = manualClock(); // the poll's timers (docLiveClock) on a manual clock
    Object.assign(p.T.docLiveClock, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
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
    // the page becomes visible: the poll wakes up and reads; a DOC_CHANGED is read DOC_LIVE_EXPORT_SIGNAL_MS later
    Object.defineProperty(p.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    p.document.dispatchEvent(new p.window.Event('visibilitychange'));
    assert.deepStrictEqual(clock.pending(), [0]); // the poll's next step right away
    await clock.advance(0);
    await waitFor(() => p.state.docText === 'First text', 'the first read');
    assert.strictEqual(line.textContent, '10 characters · 2 words');
    assert.ok(p.T.docLive.timer, 'a poll timer');
    body = 'Second text!';
    p.T.docLive.readAt = -Infinity; // the floor is tested on the fake clock (test/doc-live.test.js)
    p.T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source: 'input' });
    await clock.advance(EXPORT_SIGNAL - 1);
    assert.strictEqual(exportsSeen.length, 1); // not before DOC_LIVE_EXPORT_SIGNAL_MS
    await clock.advance(1);
    await waitFor(() => p.state.docText === 'Second text!', 'the re-read');
    assert.strictEqual(exportsSeen.length, 2);
    assert.strictEqual(line.textContent, '12 characters · 2 words');
  } finally { p.close(); }
});
