'use strict';
// content.js on a fake Google Docs page (jsdom): the panel host, the round button (collapsed only), the resize
// grip and the stored width, TOGGLE_PANEL / COLLAPSE_PANEL / PING, the document ID, GET_DOC_TEXT (export URL, Markdown -> plain text fallback,
// forbidden download), the selection reading and its cache, REPLACE_SELECTION through a paste event, SCROLL_TO_LINE,
// and the double-injection guard. Internal DOM structure and exact styles are not asserted.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadContent, textResponse, click, mouse, pointer, tick } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

const HOST = 'munin-panel-host';
const FAB = 'munin-panel-fab';
const shown = (node) => !!node && node.isConnected && node.style.display !== 'none';

// Runs fn with a fresh page and always closes it.
async function withPage(opts, fn) {
  const c = await loadContent(opts);
  try { await fn(c); } finally { c.close(); }
}

test('nothing is added to the page until the panel is opened', () => withPage({}, async (c) => {
  await tick(10);
  assert.strictEqual(c.document.getElementById(HOST), null);
  assert.strictEqual(c.document.getElementById(FAB), null);
  assert.strictEqual(c.chrome.runtime.onMessage.listeners.length, 1);
}));

test('TOGGLE_PANEL opens the panel iframe (with the tab ID), toggles back to the round button, persists', () => withPage({}, async (c) => {
  let r = await c.send({ type: 'TOGGLE_PANEL' });
  assert.deepStrictEqual(r, { ok: true, open: true });
  const host = c.document.getElementById(HOST);
  assert.ok(shown(host));
  const frame = host.querySelector('iframe');
  assert.strictEqual(frame.getAttribute('src'), 'chrome-extension://testextid/sidepanel.html#tabId=7');
  assert.ok(c.sent.some((m) => m.type === 'GET_TAB_ID'));
  assert.strictEqual(c.storage.muninPanelOpen, true);
  assert.ok(!shown(c.document.getElementById(FAB))); // no floating button while the panel is open
  r = await c.send({ type: 'TOGGLE_PANEL' });
  assert.deepStrictEqual(r, { ok: true, open: false });
  assert.ok(!shown(host) && host.isConnected); // hidden, not removed
  const fab = c.document.getElementById(FAB);
  assert.ok(shown(fab));
  assert.strictEqual(fab.title, 'Munin: show the panel');
  assert.strictEqual(fab.style.right, '16px');
  assert.strictEqual(c.storage.muninPanelOpen, false);
  // the round button opens it again (one host, never two)
  click(fab);
  await waitFor(() => shown(host), 'the panel');
  assert.ok(!shown(fab));
  assert.strictEqual(c.document.querySelectorAll('#' + HOST).length, 1);
  assert.strictEqual(c.document.querySelectorAll('#' + FAB).length, 1);
  assert.strictEqual(c.storage.muninPanelOpen, true);
  // COLLAPSE_PANEL (sent by the raven in the panel header)
  r = await c.send({ type: 'COLLAPSE_PANEL' });
  assert.deepStrictEqual(r, { ok: true, open: false });
  assert.ok(!shown(host) && shown(fab));
  assert.strictEqual(fab.style.right, '16px');
  assert.strictEqual(c.storage.muninPanelOpen, false);
}));

test('resize grip: centred on the left edge, drag changes the width within the clamps, stored; double-click resets', () => withPage({}, async (c) => {
  await c.send({ type: 'TOGGLE_PANEL' });
  const host = c.document.getElementById(HOST);
  const frame = host.querySelector('iframe');
  const grip = host.querySelector('.munin-panel-grip');
  assert.ok(grip && grip.parentNode === host); // shown and hidden with the panel
  assert.strictEqual(grip.title, 'Drag to resize; double-click to reset');
  const st = grip.style;
  assert.deepStrictEqual([st.position, st.left, st.top, st.transform, st.width, st.height, st.cursor],
    ['absolute', '0px', '50%', 'translateY(-50%)', '6px', '48px', 'ew-resize']);
  assert.strictEqual(host.style.width, '400px'); // the default
  // drag 100 px to the left: wider; the iframe ignores the pointer while dragging
  pointer(grip, 'pointerdown', { clientX: 600 });
  assert.strictEqual(frame.style.pointerEvents, 'none');
  pointer(grip, 'pointermove', { clientX: 500 });
  assert.strictEqual(host.style.width, '500px');
  pointer(grip, 'pointerup', { clientX: 500 });
  assert.strictEqual(frame.style.pointerEvents, '');
  await waitFor(() => c.storage.muninPanelWidth === 500, 'the stored width');
  // clamps: at most 70% of the viewport, at least 280 px
  const max = Math.round(c.window.innerWidth * 0.7);
  pointer(grip, 'pointerdown', { clientX: 500 });
  pointer(grip, 'pointermove', { clientX: -2000 });
  assert.strictEqual(host.style.width, max + 'px');
  pointer(grip, 'pointermove', { clientX: 3000 });
  assert.strictEqual(host.style.width, '280px');
  pointer(grip, 'pointercancel', { clientX: 3000 });
  assert.strictEqual(frame.style.pointerEvents, '');
  await waitFor(() => c.storage.muninPanelWidth === 280, 'the clamped width');
  // double-click: back to the default, nothing stored
  mouse(grip, 'dblclick');
  assert.strictEqual(host.style.width, '400px');
  await waitFor(() => !('muninPanelWidth' in c.storage), 'the removed width');
}));

test('ATTENTION: a dot and a tooltip on the round button only while the panel is collapsed', () => withPage({}, async (c) => {
  await c.send({ type: 'TOGGLE_PANEL' });
  await c.send({ type: 'ATTENTION', pending: true });
  assert.ok(!shown(c.document.getElementById(FAB))); // the open panel shows the card itself
  await c.send({ type: 'TOGGLE_PANEL' });
  const fab = c.document.getElementById(FAB);
  const dot = fab.querySelector('span');
  assert.ok(shown(fab));
  assert.strictEqual(dot.style.display, 'block');
  assert.strictEqual(fab.title, 'Munin Assistant is waiting for your decision');
  await c.send({ type: 'ATTENTION', pending: false });
  assert.strictEqual(dot.style.display, 'none');
  assert.strictEqual(fab.title, 'Munin: show the panel');
}));

test('the stored width is applied when the panel is created', () => withPage({ storage: { muninPanelOpen: true, muninPanelWidth: 520 } }, async (c) => {
  await waitFor(() => shown(c.document.getElementById(HOST)), 'the restored panel');
  assert.strictEqual(c.document.getElementById(HOST).style.width, '520px');
  assert.ok(!shown(c.document.getElementById(FAB)));
}));

test('two quick toggles create one host; the saved state is restored on load', async () => {
  await withPage({}, async (c) => {
    const [a, b] = await Promise.all([c.send({ type: 'TOGGLE_PANEL' }), c.send({ type: 'TOGGLE_PANEL' })]);
    assert.strictEqual(a.ok && b.ok, true);
    assert.strictEqual(c.document.querySelectorAll('#' + HOST).length, 1);
    assert.strictEqual(c.document.querySelectorAll('iframe[src^="chrome-extension://"]').length, 1);
  });
  await withPage({ storage: { muninPanelOpen: true } }, async (c) => {
    await waitFor(() => shown(c.document.getElementById(HOST)), 'the restored panel');
    assert.ok(!shown(c.document.getElementById(FAB)));
  });
  await withPage({ storage: { muninPanelOpen: false } }, async (c) => {
    await waitFor(() => shown(c.document.getElementById(FAB)), 'the restored button');
    assert.strictEqual(c.document.getElementById(HOST), null); // no iframe until opened
  });
});

test('PING: document ID and the title without the " - Google Docs" suffix (localized too)', async () => {
  await withPage({}, async (c) => {
    assert.deepStrictEqual(await c.send({ type: 'PING' }), { ok: true, docId: 'DOC123', title: 'My Doc' });
  });
  await withPage({ url: 'https://docs.google.com/document/u/1/d/Ab-9_xY/edit?tab=t.0', title: 'Отчёт – Google Документы' }, async (c) => {
    assert.deepStrictEqual(await c.send({ type: 'PING' }), { ok: true, docId: 'Ab-9_xY', title: 'Отчёт' });
  });
  await withPage({ url: 'https://docs.google.com/document/create', title: 'Google Docs' }, async (c) => {
    const r = await c.send({ type: 'PING' });
    assert.strictEqual(r.docId, null);
    const t = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual([t.ok, t.error], [false, 'Could not determine the document ID from the URL']);
  });
  await withPage({}, async (c) => {
    assert.strictEqual(await c.send({ type: 'SOMETHING_ELSE' }), undefined);
    assert.strictEqual(await c.send(null), undefined);
  });
});

test('GET_DOC_TEXT: Markdown export first; the export URL carries authuser from the path or the query', async () => {
  const cases = [
    ['https://docs.google.com/document/d/DOC123/edit', 'https://docs.google.com/document/d/DOC123/export?format=md'],
    ['https://docs.google.com/document/u/2/d/DOC123/edit', 'https://docs.google.com/document/d/DOC123/export?format=md&authuser=2'],
    ['https://docs.google.com/document/d/DOC123/edit?authuser=3', 'https://docs.google.com/document/d/DOC123/export?format=md&authuser=3'],
  ];
  for (const [url, exportUrl] of cases) {
    await withPage({ url }, async (c) => {
      const calls = [];
      c.window.fetch = async (u, init) => { calls.push([u, init && init.credentials]); return textResponse('﻿# Title\r\n\r\nBody \\- text.\r\n', { type: 'text/markdown' }); };
      const r = await c.send({ type: 'GET_DOC_TEXT' });
      assert.deepStrictEqual(calls, [[exportUrl, 'include']]);
      assert.deepStrictEqual(r, { ok: true, text: '# Title\n\nBody \\- text.\n', format: 'markdown', requests: 1, docId: 'DOC123', title: 'My Doc' });
    });
  }
});

test('GET_DOC_TEXT: no Markdown export -> plain text, remembered; a forbidden download is reported', async () => {
  await withPage({}, async (c) => {
    const calls = [];
    c.window.fetch = async (u) => {
      calls.push(u.replace(/^.*format=/, ''));
      return u.includes('format=md') ? textResponse('nope', { status: 500 }) : textResponse('Plain text\n');
    };
    let r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual([r.ok, r.text, r.format], [true, 'Plain text\n', 'text']);
    assert.deepStrictEqual(calls, ['md', 'txt']);
    r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual(calls, ['md', 'txt', 'txt']); // Markdown is not tried again on this page
    assert.strictEqual(r.format, 'text');
  });
  // download forbidden (HTTP 403, e.g. "viewers cannot download"): an error with the status, and the
  // Markdown export is tried again next time (it was an access problem, not a missing format)
  await withPage({}, async (c) => {
    const calls = [];
    c.window.fetch = async (u) => { calls.push(u.replace(/^.*format=/, '')); return textResponse('Forbidden', { status: 403 }); };
    let r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual(r, { ok: false, error: 'Document export: HTTP 403', status: 403, requests: 2, docId: 'DOC123', title: 'My Doc' });
    r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual(calls, ['md', 'txt', 'md', 'txt']);
  });
  // a sign-in page instead of the export
  await withPage({}, async (c) => {
    c.window.fetch = async () => textResponse('<!doctype html><html><body>Sign in</body></html>', { type: 'text/html; charset=utf-8' });
    const r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Export returned HTML (no access or sign-in required)');
  });
});

test('GET_DOC_TEXT: a network error (fetch rejects) or HTTP 429 on Markdown is reported without trying plain text', async () => {
  // a cross-origin redirect the page cannot follow: fetch rejects with a TypeError
  await withPage({}, async (c) => {
    const calls = [];
    c.window.fetch = async (u) => { calls.push(u.replace(/^.*format=/, '')); throw new TypeError('Failed to fetch'); };
    let r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual(r, { ok: false, error: 'Failed to fetch', network: true, requests: 1, docId: 'DOC123', title: 'My Doc' });
    assert.deepStrictEqual(calls, ['md']);
    r = await c.send({ type: 'GET_DOC_TEXT' }); // Markdown is not marked unavailable by a network error
    assert.deepStrictEqual(calls, ['md', 'md']);
    r = await c.send({ type: 'GET_DOC_TEXT', docId: 'OTHER456' });
    assert.deepStrictEqual([r.ok, r.network, r.docId], [false, true, 'OTHER456']);
    assert.deepStrictEqual(calls, ['md', 'md', 'md']);
  });
  // rate-limited: the status and Retry-After go to the panel, which waits and asks again
  await withPage({}, async (c) => {
    const calls = [];
    c.window.fetch = async (u) => { calls.push(u.replace(/^.*format=/, '')); return textResponse('Too many', { status: 429, extra: { 'retry-after': '3' } }); };
    const r = await c.send({ type: 'GET_DOC_TEXT' });
    assert.deepStrictEqual([r.ok, r.error, r.status, r.retryAfter, r.requests], [false, 'Document export: HTTP 429', 429, '3', 1]);
    assert.deepStrictEqual(calls, ['md']);
  });
});

test('GET_DOC_TEXT with another docId: that document, its title from the file name; invalid IDs refused', () => withPage({}, async (c) => {
  const calls = [];
  c.window.fetch = async (u) => {
    calls.push(u);
    return textResponse('# Other', { type: 'text/markdown', disposition: 'attachment; filename="x.md"; filename*=UTF-8\'\'Other%20%C3%BC.md' });
  };
  let r = await c.send({ type: 'GET_DOC_TEXT', docId: 'OTHER456', authuser: '1' });
  assert.deepStrictEqual(r, { ok: true, text: '# Other', format: 'markdown', title: 'Other ü', docId: 'OTHER456' });
  assert.deepStrictEqual(calls, ['https://docs.google.com/document/d/OTHER456/export?format=md&authuser=1']);
  r = await c.send({ type: 'GET_DOC_TEXT', docId: 'bad/id' });
  assert.deepStrictEqual(r, { ok: false, error: 'Invalid document ID', docId: 'bad/id' });
  // a non-numeric authuser is ignored
  calls.length = 0;
  await c.send({ type: 'GET_DOC_TEXT', docId: 'OTHER456', authuser: '1&x=y' });
  assert.deepStrictEqual(calls, ['https://docs.google.com/document/d/OTHER456/export?format=md']);
}));

test('GET_SELECTION: the editor selection, the copy-event fallback, the cache and its clearing', () => withPage({}, async (c) => {
  const { editorDoc, iframe } = c;
  assert.deepStrictEqual(await c.send({ type: 'GET_SELECTION' }), { ok: true, text: '' });
  // 1) a selection inside the hidden editor (zero-width characters and NBSP cleaned)
  editorDoc.body.textContent = 'Sel​ected text ';
  editorDoc.getSelection().selectAllChildren(editorDoc.body);
  assert.deepStrictEqual(await c.send({ type: 'GET_SELECTION' }), { ok: true, text: 'Selected text' });
  // 2) no live selection: Docs fills the clipboardData of a synthetic copy event
  editorDoc.getSelection().removeAllRanges();
  editorDoc.body.textContent = '';
  let copies = 0;
  const onCopy = (e) => { copies++; e.clipboardData.setData('text/plain', ' From copy '); e.preventDefault(); };
  editorDoc.body.addEventListener('copy', onCopy);
  assert.deepStrictEqual(await c.send({ type: 'GET_SELECTION' }), { ok: true, text: 'From copy' });
  assert.strictEqual(copies, 1);
  editorDoc.body.removeEventListener('copy', onCopy);
  // 3) nothing live: the last read selection comes from the cache
  assert.deepStrictEqual(await c.send({ type: 'GET_SELECTION' }), { ok: true, text: 'From copy', cached: true });
  // once the panel exists, typing in the editor clears the cache and the panel is told
  await c.send({ type: 'TOGGLE_PANEL' });
  iframe.focus();
  editorDoc.body.dispatchEvent(new c.window.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  assert.deepStrictEqual(await c.send({ type: 'GET_SELECTION' }), { ok: true, text: '' });
  await waitFor(() => c.sent.some((m) => m.type === 'SELECTION_UPDATE' && m.text === ''), 'the cleared selection push');
  // a mouse-up in the document captures the selection after a short delay and pushes it to the panel
  editorDoc.body.textContent = 'Picked words';
  editorDoc.getSelection().selectAllChildren(editorDoc.body);
  c.document.body.dispatchEvent(new c.window.MouseEvent('mouseup', { bubbles: true }));
  await waitFor(() => c.sent.some((m) => m.type === 'SELECTION_UPDATE' && m.text === 'Picked words'), 'the selection push');
  const push = c.sent.find((m) => m.type === 'SELECTION_UPDATE' && m.text === 'Picked words');
  assert.deepStrictEqual(push, { type: 'SELECTION_UPDATE', tabId: 7, docId: 'DOC123', text: 'Picked words' });
}));

const UNVERIFIED = '';

// Counts every paste dispatch (any target: a capturing listener on the editor document), every execCommand
// call and every textInput event: the paste must go out exactly once and nothing else may follow it.
function countAttempts(c) {
  const n = { paste: 0, targets: [], exec: 0, textInput: 0 };
  c.editorDoc.addEventListener('paste', (e) => { n.paste++; n.targets.push(e.target === c.editorDoc ? 'document' : e.target.nodeName); }, true);
  c.editorDoc.addEventListener('textInput', () => { n.textInput++; }, true);
  c.editorDoc.execCommand = () => { n.exec++; return false; };
  c.editorDoc.queryCommandSupported = () => true;
  return n;
}

test('REPLACE_SELECTION: one paste event with the text on the editable body; verified when Docs calls preventDefault', () => withPage({}, async (c) => {
  const { editorDoc } = c;
  const n = countAttempts(c);
  const pasted = [];
  const handler = (e) => { pasted.push(e.clipboardData.getData('text/plain')); e.preventDefault(); };
  editorDoc.body.addEventListener('paste', handler);
  let r = await c.send({ type: 'REPLACE_SELECTION', text: 'New text' });
  assert.deepStrictEqual(r, { ok: true, method: 'paste', verified: true, attempts: 1, detail: 'inserted via paste event' });
  assert.deepStrictEqual(pasted, ['New text']);
  assert.deepStrictEqual([n.paste, n.targets, n.exec, n.textInput], [1, ['BODY'], 0, 0]);
  assert.strictEqual(c.document.activeElement, c.iframe); // the focus was moved to the editor
  // calls are serialized: two at once paste in order
  const both = await Promise.all([c.send({ type: 'REPLACE_SELECTION', text: 'one' }), c.send({ type: 'REPLACE_SELECTION', text: 'two' })]);
  assert.ok(both.every((x) => x.ok && x.attempts === 1));
  assert.deepStrictEqual(pasted, ['New text', 'one', 'two']);
  assert.strictEqual(n.paste, 3);
  editorDoc.body.removeEventListener('paste', handler);
  r = await c.send({ type: 'REPLACE_SELECTION' });
  assert.deepStrictEqual(r, { ok: false, error: 'No text to paste' });
}));

test('REPLACE_SELECTION: the active element of the editor iframe is the target when it is not the body', () => withPage({}, async (c) => {
  const n = countAttempts(c);
  const box = c.editorDoc.createElement('div');
  box.setAttribute('contenteditable', 'true');
  box.tabIndex = 0;
  c.editorDoc.body.appendChild(box);
  box.focus();
  const r = await c.send({ type: 'REPLACE_SELECTION', text: 'x' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([n.paste, n.targets, n.exec, n.textInput], [1, ['DIV'], 0, 0]);
}));

test('REPLACE_SELECTION: Docs inserts without preventDefault: one dispatch, verified by the editor change or the read', async () => {
  // inserting right away (the iframe changes)
  await withPage({}, async (c) => {
    const n = countAttempts(c);
    c.editorDoc.body.addEventListener('paste', () => { c.editorDoc.body.appendChild(c.editorDoc.createTextNode('Para')); });
    const r = await c.send({ type: 'REPLACE_SELECTION', text: 'Para' });
    assert.deepStrictEqual(r, { ok: true, method: 'paste', verified: true, attempts: 1, detail: 'inserted via paste event' });
    assert.deepStrictEqual([n.paste, n.exec, n.textInput], [1, 0, 0]);
    assert.strictEqual(c.editorDoc.body.textContent, 'Para');
  });
  // inserting a moment later (a timer): seen after the settle time
  await withPage({}, async (c) => {
    const n = countAttempts(c);
    c.editorDoc.body.addEventListener('paste', () => { c.window.setTimeout(() => { c.editorDoc.body.textContent = 'Late'; }, 0); });
    const r = await c.send({ type: 'REPLACE_SELECTION', text: 'Late' });
    assert.deepStrictEqual([r.ok, r.verified, r.attempts, n.paste, n.exec, n.textInput], [true, true, 1, 1, 0, 0]);
  });
  // the handler reads the pasted text without preventDefault and without touching the iframe
  await withPage({}, async (c) => {
    const n = countAttempts(c);
    const reads = [];
    c.editorDoc.body.addEventListener('paste', (e) => { reads.push(e.clipboardData.getData('text/plain')); });
    const r = await c.send({ type: 'REPLACE_SELECTION', text: 'Read' });
    assert.deepStrictEqual([r.ok, r.verified, r.attempts], [true, true, 1]);
    assert.deepStrictEqual([reads, n.paste, n.exec, n.textInput], [['Read'], 1, 0, 0]);
  });
});

test('REPLACE_SELECTION: nothing confirms the paste (as in Chrome): still one dispatch, ok but not verified, no fallbacks', () => withPage({}, async (c) => {
  const n = countAttempts(c);
  const r = await c.send({ type: 'REPLACE_SELECTION', text: 'Ignored' });
  assert.deepStrictEqual(r, { ok: true, method: 'paste', verified: false, attempts: 1, detail: UNVERIFIED });
  assert.deepStrictEqual([n.paste, n.targets, n.exec, n.textInput], [1, ['BODY'], 0, 0]);
  assert.strictEqual(c.editorDoc.body.textContent, '');
}));

test('REPLACE_SELECTION: a dispatch that throws is the only failure after the focus step; nothing else is tried', () => withPage({}, async (c) => {
  const n = countAttempts(c);
  c.editorDoc.body.dispatchEvent = () => { throw new Error('boom'); };
  const r = await c.send({ type: 'REPLACE_SELECTION', text: 'x' });
  assert.deepStrictEqual(r, { ok: false, error: 'paste event failed (boom)', attempts: 1 });
  assert.deepStrictEqual([n.exec, n.textInput], [0, 0]);
}));

test('REPLACE_SELECTION: no editor iframe', () => withPage({}, async (c) => {
  c.iframe.remove();
  const r = await c.send({ type: 'REPLACE_SELECTION', text: 'x' });
  assert.strictEqual(r.ok, false);
  assert.ok(/editor not found/.test(r.error), r.error);
}));

test('double injection: a live instance makes the second run exit; after an extension reload it takes over', () => withPage({}, async (c) => {
  await c.send({ type: 'TOGGLE_PANEL' });
  c.inject();
  await tick(10);
  assert.strictEqual(c.chrome.runtime.onMessage.listeners.length, 1);
  assert.strictEqual(c.document.querySelectorAll('#' + HOST).length, 1);
  // the old instance is orphaned (chrome.runtime.id is gone): the new one registers and removes the leftovers
  const oldHost = c.document.getElementById(HOST);
  c.chrome.runtime.id = undefined;
  c.inject();
  await tick(10);
  assert.strictEqual(c.chrome.runtime.onMessage.listeners.length, 2);
  assert.ok(!oldHost.isConnected);
  // the new instance restores the saved state (open) with a host of its own
  await waitFor(() => shown(c.document.getElementById(HOST)), 'the new host');
  assert.notStrictEqual(c.document.getElementById(HOST), oldHost);
  assert.strictEqual(c.document.querySelectorAll('#' + HOST).length, 1);
}));

test('re-injection after an extension reload: one panel host and no raven button, the saved width kept', () => withPage({ storage: { muninPanelOpen: true, muninPanelWidth: 500 } }, async (c) => {
  await waitFor(() => shown(c.document.getElementById(HOST)), 'the restored host');
  const oldHost = c.document.getElementById(HOST);
  c.chrome.runtime.id = undefined; // the old instance is orphaned
  c.inject();
  await waitFor(() => shown(c.document.getElementById(HOST)) && c.document.getElementById(HOST) !== oldHost, 'the new host');
  assert.ok(!oldHost.isConnected);
  assert.strictEqual(c.document.querySelectorAll('#' + HOST).length, 1);
  assert.ok(!shown(c.document.getElementById(FAB))); // the panel is open: no floating button
  assert.strictEqual(c.document.querySelectorAll('#' + HOST + ' iframe').length, 1);
  assert.strictEqual(c.document.getElementById(HOST).style.width, '500px');
}));

test('re-injection with the panel collapsed: the old raven button is replaced, no panel is created', () => withPage({ storage: { muninPanelOpen: false } }, async (c) => {
  await waitFor(() => shown(c.document.getElementById(FAB)), 'the raven button');
  const oldFab = c.document.getElementById(FAB);
  c.chrome.runtime.id = undefined;
  c.inject();
  await waitFor(() => shown(c.document.getElementById(FAB)) && c.document.getElementById(FAB) !== oldFab, 'the new button');
  assert.ok(!oldFab.isConnected);
  assert.strictEqual(c.document.querySelectorAll('#' + FAB).length, 1);
  assert.strictEqual(c.document.getElementById(HOST), null);
}));

test('an orphaned copy (extension reloaded) drops its listeners: no selection reads on mouse-up or keys', () => withPage({}, async (c) => {
  const { editorDoc, iframe } = c;
  await c.send({ type: 'TOGGLE_PANEL' }); // the selection tracking is on
  let copies = 0;
  editorDoc.body.addEventListener('copy', () => { copies++; });
  iframe.focus();
  c.document.body.dispatchEvent(new c.window.MouseEvent('mouseup', { bubbles: true }));
  await waitFor(() => copies === 1, 'the selection read of the live copy');
  c.chrome.runtime.id = undefined; // the extension was reloaded: this copy is orphaned
  const sent = c.sent.length;
  c.document.body.dispatchEvent(new c.window.MouseEvent('mouseup', { bubbles: true }));
  editorDoc.body.dispatchEvent(new c.window.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  c.document.body.dispatchEvent(new c.window.MouseEvent('mouseup', { bubbles: true }));
  await tick(400); // past the capture delay
  assert.strictEqual(copies, 1);
  assert.strictEqual(c.sent.length, sent);
}));

test('a page where the panel was never opened observes nothing on resize', async () => {
  const c = await loadContent({ run: false });
  try {
    let observers = 0;
    c.window.ResizeObserver = class { constructor() { observers++; } observe() {} unobserve() {} disconnect() {} };
    c.inject();
    await tick(10);
    c.window.dispatchEvent(new c.window.Event('resize'));
    assert.strictEqual(observers, 0);
    await c.send({ type: 'TOGGLE_PANEL' }); // with the panel the header is watched (it can change height)
    assert.strictEqual(observers, 1);
  } finally { c.close(); }
});

// SCROLL_TO_LINE: the line found by its text in what the editor draws (the HTML line views, or the canvas rendering's
// aria-label layer), scrolled to the middle and outlined; a first jump to about the right place when the page is not
// drawn yet; a miss restores the scroll position.
function scrollStub(window) {
  const calls = [];
  window.Element.prototype.scrollIntoView = function (opts) { calls.push({ node: this, opts }); };
  return calls;
}
test('SCROLL_TO_LINE: a line view whose text starts the line is scrolled into view and outlined', () => withPage({}, async (c) => {
  const calls = scrollStub(c.window);
  const editor = c.document.querySelector('.kix-appview-editor');
  editor.insertAdjacentHTML('beforeend', '<div class="kix-page"><div class="kix-lineview">Introduction</div>' +
    '<div class="kix-lineview">Activity towards​ PNPB was measured in</div><div class="kix-lineview">every experiment.</div></div>');
  const r = await c.send({ type: 'SCROLL_TO_LINE', line: 3, text: 'Activity towards PNPB was measured in every experiment.', of: 20 });
  assert.deepStrictEqual(r, { ok: true, how: 'lineview', selected: false });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].node.textContent, 'Activity towards​ PNPB was measured in');
  assert.deepStrictEqual({ ...calls[0].opts }, { block: 'center' });
}));

test('SCROLL_TO_LINE: the canvas rendering\'s aria-label paragraphs; typographic quotes and case do not matter', () => withPage({}, async (c) => {
  const calls = scrollStub(c.window);
  const editor = c.document.querySelector('.kix-appview-editor');
  editor.insertAdjacentHTML('beforeend', '<div class="kix-canvas-tile-content"><svg><g role="paragraph"><rect aria-label="Other text"></rect></g>' +
    '<g role="paragraph"><rect aria-label="The “lid” domain covers"></rect><rect aria-label="the active site in water."></rect></g></svg></div>');
  const r = await c.send({ type: 'SCROLL_TO_LINE', line: 7, text: 'the "LID" domain covers the active site in water and opens', of: 9 });
  assert.deepStrictEqual(r, { ok: true, how: 'aria-paragraph', selected: false });
  assert.strictEqual(calls[0].node.getAttribute('role'), 'paragraph');
}));

test('SCROLL_TO_LINE: not drawn yet: a jump to about line / of, then the search again; a miss restores the scroll', () => withPage({}, async (c) => {
  const calls = scrollStub(c.window);
  const editor = c.document.querySelector('.kix-appview-editor');
  let top = 120;
  const sets = [];
  Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => 10000 });
  Object.defineProperty(editor, 'clientHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(editor, 'scrollTop', { configurable: true, get: () => top, set: (v) => {
    top = v; sets.push(v);
    // the tiles of the new position draw the line
    if (v > 4000 && !editor.querySelector('.late')) editor.insertAdjacentHTML('beforeend', '<div class="kix-lineview late">Results of the late section here</div>');
  } });
  let r = await c.send({ type: 'SCROLL_TO_LINE', line: 51, text: 'Results of the late section here', of: 100 });
  assert.deepStrictEqual(r, { ok: true, how: 'lineview', selected: false });
  assert.deepStrictEqual(sets, [4500]); // (51 − 1) / 100 of the scrollable height
  assert.strictEqual(calls.length, 1);
  top = 120; sets.length = 0;
  r = await c.send({ type: 'SCROLL_TO_LINE', line: 10, text: 'A line that is nowhere', of: 100 });
  assert.deepStrictEqual(r, { ok: false, reason: 'not-found' });
  assert.deepStrictEqual(sets, [810, 120]); // jumped to 9 / 100 of 9,000, then back
  r = await c.send({ type: 'SCROLL_TO_LINE', line: 10, text: ' ' });
  assert.deepStrictEqual(r, { ok: false, reason: 'no-text' });
}));
