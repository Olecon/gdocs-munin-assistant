'use strict';
// The copy button of a chat row in the chat list (src/chat-log.js copyChatLog): a click copies that chat's log from
// its stored history, shows the check mark for a moment and leaves the open chat as it was; Shift+click copies the fuller
// log (test/chat-log-requests.test.js); Alt+click saves the bug bundle file (test/bug-bundle.test.js); when the clipboard
// API refuses, a hidden textarea and execCommand copy it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { waitFor, deq } = require('../lib/sandbox');

let env, T, state, el, chrome;
const tab = { id: 7, url: 'https://docs.google.com/document/d/DOCLOG/edit', title: 'Log paper - Google Docs' };
const rowOf = (id) => [...el.chatMenu.querySelectorAll('.chat-row')].find((r) => r.dataset.id === id);

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  chrome.tabs.query = async () => [tab];
  chrome.tabs.get = async () => tab;
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Log paper' });
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOCLOG');
});
after(() => env.close());

test('the copy button copies a chat log without opening the chat; the check mark shows for a moment', async () => {
  state.messages.push(
    { role: 'user', content: 'Summarize section 2.', _context: '[Document: 12 lines]' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_lines', arguments: '{"start":5,"end":9}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '5: Methods', _ok: true },
    { role: 'assistant', content: 'Section 2 describes the methods.' },
  );
  await T.saveHistory();
  const first = state.chatId;
  await T.createChat();
  const open = state.chatId;
  assert.notStrictEqual(open, first);
  click(el.chatSwitchBtn);
  const btn = rowOf(first).querySelector('button[data-copy]');
  assert.ok(btn && btn.classList.contains('btn') && btn.classList.contains('icon'));
  assert.strictEqual(btn.dataset.tip, 'Copy the chat log');
  assert.ok(btn.querySelector('.icon-copy') && btn.querySelector('.icon-check'));
  // the copy button sits before the ✕
  assert.strictEqual(btn.nextElementSibling, rowOf(first).querySelector('button[data-del]'));
  click(btn);
  await waitFor(() => env.clipboard.writes.length === 1, 'the copy');
  const log = env.clipboard.writes[0];
  assert.ok(log.startsWith('Chat: Summarize section 2. · Log paper · '), log);
  assert.ok(log.includes('\n\nUser:\nSummarize section 2.\n\nAssistant:\n> read_lines({"start":5,"end":9}) → ok\n  5: Methods\nSection 2 describes the methods.\n'), log);
  assert.ok(!log.includes('Document: 12 lines'));
  assert.ok(btn.classList.contains('done'));
  assert.strictEqual(state.chatId, open); // the chat was not opened
  assert.ok(!el.chatMenu.classList.contains('hidden')); // the list stays open
  await tick(1300);
  assert.ok(!btn.classList.contains('done'));
});

test('Shift+click copies the fuller log: the turn context and what the request sent (not kept for a chat answered before the panel opened)', async () => {
  const first = state.chats[state.chats.length - 1].id;
  if (el.chatMenu.classList.contains('hidden')) click(el.chatSwitchBtn);
  const btn = rowOf(first).querySelector('button[data-copy]');
  const before = env.clipboard.writes.length;
  btn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  await waitFor(() => env.clipboard.writes.length === before + 1, 'the fuller copy');
  const log = env.clipboard.writes[before];
  assert.ok(log.includes('\n\nSystem prompt: not available (the panel keeps the requests of the last 30 turns of a chat since it was opened).\n\n' +
    'User:\nSummarize section 2.\nContext:\n  [Document: 12 lines]\nRequest: not available (the panel keeps the requests of the last 30 turns of a chat since it was opened).\n\nAssistant:\n'), log);
  // a plain click: the plain log
  click(btn);
  await waitFor(() => env.clipboard.writes.length === before + 2, 'the plain copy');
  assert.ok(!/System prompt|Context:|Request:/.test(env.clipboard.writes[before + 1]));
  await tick(1300);
});

test('Alt+click (Shift+Alt too) saves the bug bundle as a download through a Blob link; no clipboard write, no new control', async () => {
  const first = state.chats[state.chats.length - 1].id;
  if (el.chatMenu.classList.contains('hidden')) click(el.chatSwitchBtn);
  const W = env.window;
  const blobs = [];
  const revoked = [];
  const origCreate = W.URL.createObjectURL;
  const origRevoke = W.URL.revokeObjectURL;
  W.URL.createObjectURL = (b) => { blobs.push(b); return `blob:chrome-extension://testextid/${blobs.length}`; };
  W.URL.revokeObjectURL = (u) => revoked.push(u);
  const links = [];
  // the link's click: recorded, its navigation (not implemented in jsdom) prevented
  const onClick = (e) => { if (e.target.tagName === 'A') { links.push({ href: e.target.href, download: e.target.download, attached: e.target.isConnected }); e.preventDefault(); } };
  env.document.addEventListener('click', onClick, true);
  try {
    const row = rowOf(first);
    deq([...row.querySelectorAll('button')].map((b) => [...b.attributes].filter((a) => /^data-(copy|del)$/.test(a.name)).map((a) => a.name)), [['data-copy'], ['data-del']]);
    const btn = row.querySelector('button[data-copy]');
    const writes = env.clipboard.writes.length;
    btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true }));
    await waitFor(() => links.length === 1, 'the download link click');
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.strictEqual(links[0].download, `munin-bug-summarize-section-2-${date}.json`);
    assert.strictEqual(links[0].href, 'blob:chrome-extension://testextid/1');
    assert.ok(links[0].attached);
    assert.ok(!env.document.querySelector('a[download]')); // the link is gone again
    assert.strictEqual(blobs[0].type, 'application/json');
    const bundle = JSON.parse(await blobs[0].text());
    deq([bundle.kind, bundle.version, bundle.app, bundle.chat.title], ['munin-bug-bundle', 1, '9.8.7', 'Summarize section 2.']);
    deq(bundle.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    deq(bundle.turns, [{ message: 0, kept: false, note: 'Not kept: the panel keeps the last 30 turns of a chat since it was opened.' }]);
    await waitFor(() => btn.classList.contains('done'), 'the check mark');
    assert.strictEqual(env.clipboard.writes.length, writes); // nothing copied
    // Shift+Alt: the bundle as well
    btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true, shiftKey: true }));
    await waitFor(() => links.length === 2, 'the second download');
    assert.strictEqual(env.clipboard.writes.length, writes);
    assert.deepStrictEqual(revoked, []); // released a minute later, not at once
  } finally {
    env.document.removeEventListener('click', onClick, true);
    W.URL.createObjectURL = origCreate;
    W.URL.revokeObjectURL = origRevoke;
  }
  await tick(1300);
});

test('when the clipboard API refuses, the hidden textarea copies the log', async () => {
  const first = state.chats[state.chats.length - 1].id;
  if (el.chatMenu.classList.contains('hidden')) click(el.chatSwitchBtn);
  env.clipboard.fail = 'Document is not focused.';
  let copied = null;
  env.document.execCommand = (cmd) => { const ta = env.document.querySelector('textarea[readonly]'); copied = cmd === 'copy' && ta ? ta.value : null; return true; };
  const before = env.clipboard.writes.length;
  const btn = rowOf(first).querySelector('button[data-copy]');
  click(btn);
  await waitFor(() => btn.classList.contains('done'), 'the fallback copy');
  assert.ok(copied && copied.includes('Section 2 describes the methods.'), String(copied));
  assert.strictEqual(env.clipboard.writes.length, before);
  assert.ok(!env.document.querySelector('textarea[readonly]')); // the helper textarea is gone
  env.clipboard.fail = null;
  delete env.document.execCommand;
});
