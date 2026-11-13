'use strict';
// The Selected line (jsdom): no Refresh or ✕ control; it shows the selection the document pushes on mouse-up
// (SELECTION_UPDATE from content.js) and "(nothing selected)" when the selection is gone; it has no disclosure
// arrow and opens the full text only while something is selected.
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

test('the Selected line has no controls and follows the pushed selection', async () => {
  const env = await load({ hash: '#tabId=7' });
  try {
    const { document, chrome, state } = env;
    assert.strictEqual(document.getElementById('refreshSel'), null);
    assert.strictEqual(document.getElementById('clearSel'), null);
    assert.strictEqual(document.querySelector('.sel-actions'), null);
    const push = (text) => { for (const fn of chrome.runtime.onMessage.listeners) fn({ type: 'SELECTION_UPDATE', tabId: 7, docId: state.docId, text }, {}, () => {}); };
    push('Picked words');
    assert.strictEqual(state.selection, 'Picked words');
    assert.match(document.getElementById('selPreview').textContent, /Picked words/);
    push('');
    assert.strictEqual(state.selection, '');
    assert.match(document.getElementById('selPreview').textContent, /nothing selected/);
    await new Promise((r) => setTimeout(r, 20)); // the composer's resize observer runs before the window closes
  } finally { env.close(); }
});

test('the Selected line opens the full text only when something is selected; no disclosure arrow', async () => {
  const env = await load({ hash: '#tabId=7' });
  try {
    const { document, chrome, state } = env;
    const click = (n) => n.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const box = document.getElementById('selBox');
    const summary = box.querySelector('summary');
    const push = (text) => { for (const fn of chrome.runtime.onMessage.listeners) fn({ type: 'SELECTION_UPDATE', tabId: 7, docId: state.docId, text }, {}, () => {}); };
    assert.ok(box.classList.contains('empty'));
    click(summary);
    assert.strictEqual(box.open, false, 'nothing selected: no toggle');
    push('Picked words');
    assert.ok(!box.classList.contains('empty'));
    click(summary);
    assert.strictEqual(box.open, true, 'a selection: the full text opens');
    assert.strictEqual(document.getElementById('selFull').textContent, 'Picked words');
    push(''); // the selection disappears: the box closes and stays closed
    assert.strictEqual(box.open, false);
    assert.ok(box.classList.contains('empty'));
    click(summary);
    assert.strictEqual(box.open, false);
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'sidepanel.css'), 'utf8');
    assert.match(css, /\.sel-box summary \{[^}]*list-style: none;/);
    assert.match(css, /\.sel-box summary::-webkit-details-marker \{ display: none; \}/);
    assert.match(css, /\.sel-box\.empty summary \{ cursor: default; \}/);
    await new Promise((r) => setTimeout(r, 20)); // the composer's resize observer runs before the window closes
  } finally { env.close(); }
});
