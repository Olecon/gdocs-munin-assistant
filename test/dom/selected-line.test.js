'use strict';
// The Selected line (jsdom): no Refresh or ✕ control; it shows the selection the document pushes on mouse-up
// (SELECTION_UPDATE from content.js) and "(nothing selected)" when the selection is gone.
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
