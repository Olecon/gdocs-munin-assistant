'use strict';
// The line under the document title shows only the document line: setStatus records progress and wait texts
// (state.statusText) without showing them, during a turn, a retry wait and an edit-gate wait, and after the turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, sandbox, chrome, ident, routeDocs;

const DOC_LINE = /^\S+ characters? · \S+ words?$/;
const spec = () => docSpec({ items: [
  { p: 'Big report', style: 'TITLE' },
  ...Array.from({ length: 40 }, (_, k) => ({ p: `Line ${k + 2} end.` })),
] });

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  sandbox = env.ctx;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ routeDocs } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
});

test('setStatus only records its text; the line under the title stays the document line', async () => {
  fake = fakeDocsServer(spec());
  fake.token = ident.token = 'tok-1'; ident.granted = true;
  state.googleConnected = true;
  sandbox.fetch = routeDocs();
  T.useDocModel(await T.fetchDocModel('DOC123', 't.0'));
  T.setStatus(T.docStatusText());
  const line = T.el.docStatus.textContent;
  assert.match(line, DOC_LINE);
  T.setStatus('Reading the document…', true);
  assert.deepStrictEqual({ ...state.statusText }, { text: 'Reading the document…', warn: true });
  assert.strictEqual(T.el.docStatus.textContent, line);
  assert.strictEqual(T.el.docStatus.dataset.tip, line);
  assert.ok(!T.el.docStatus.classList.contains('warn'));
  // a failed read: the document line says so, in red
  state.docText = null; state.docError = 'The document tab was closed';
  T.setStatus('');
  assert.strictEqual(T.el.docStatus.textContent, 'Document text unavailable');
  assert.ok(T.el.docStatus.classList.contains('warn'));
  T.useDocModel(await T.fetchDocModel('DOC123', 't.0'));
  T.setStatus(T.docStatusText());
  assert.strictEqual(T.el.docStatus.textContent, line);
  assert.ok(!T.el.docStatus.classList.contains('warn'));
});

test('a turn with a retry wait and an edit-gate wait: the line under the title reads the document line throughout', async () => {
  fake = fakeDocsServer(spec());
  fake.token = ident.token = 'tok-1'; ident.granted = true;
  state.googleConnected = true; state.applyMode = 'manual'; state.settings.provider = 'anthropic'; // Manual: the write asks
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-X', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  const saved = env.run('STREAM_RETRY_DELAYS_MS.slice()');
  env.run('STREAM_RETRY_DELAYS_MS.splice(0, 2, 20, 20)');
  // Every setStatus call: its text and what the line under the title shows right after it.
  const seen = [];
  const setStatus = sandbox.setStatus;
  sandbox.setStatus = (text, warn) => { const r = setStatus(text, warn); seen.push({ text, line: T.el.docStatus.textContent }); return r; };
  const busy = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
  const rounds = [
    msgStart + tu(0, 'toolu_read', 'read_document', { scope: { start: 2, end: 31 }, include: ['text'], doc: null }) + stopTool,
    'busy', // HTTP 429 once: the retry wait
    msgStart + tu(0, 'toolu_big', 'delete_lines', { start: 2, end: 31 }) + stopTool, // Manual: the gate asks
    textRound('Deleted.'),
  ];
  let n = 0;
  sandbox.fetch = routeDocs(async () => { const r = rounds[n++]; return r === 'busy' ? sseResponse(busy, 429) : sseResponse(r); });
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc', text: '' });
  try {
    await T.createChat();
    T.el.input.value = 'Delete lines 2-31';
    const turn = T.sendMessage();
    await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
    assert.strictEqual(state.statusText.text, 'Waiting for your decision…');
    assert.match(T.el.docStatus.textContent, DOC_LINE, 'during the gate wait');
    const [[id]] = [...T.pendingPreviews.entries()];
    T.decidePreview(id, 'accept');
    await turn;
    assert.strictEqual(n, 4);
    const retry = seen.find((s) => /retrying in/.test(s.text));
    assert.ok(retry, 'the retry text was recorded');
    assert.match(retry.line, DOC_LINE, 'during the retry wait');
    assert.ok(seen.some((s) => s.text === 'Waiting for your decision…'));
    for (const s of seen) assert.match(s.line, DOC_LINE, `after setStatus(${JSON.stringify(s.text)})`);
    assert.strictEqual(T.el.docStatus.textContent, T.docStatusText(), 'after the turn');
    assert.match(T.el.docStatus.textContent, /^\S+ characters · \S+ words$/);
  } finally {
    sandbox.setStatus = setStatus;
    env.run(`STREAM_RETRY_DELAYS_MS.splice(0, 2, ${saved.join(', ')})`);
  }
});

// The warnings that only the line under the title showed now reach the chat.
const bubbles = (cls) => T.el.chat.children.filter((c) => c && (c.className || '').includes(cls)).map((c) => c.innerHTML);

test('a command without a message and a content-script failure reach the chat; the failure once while it repeats', async () => {
  T.el.chat.children.length = 0;
  for (const cmd of ['/research', '/chat']) {
    T.el.input.value = cmd;
    assert.strictEqual(await T.startTurn(false), 'idle');
  }
  assert.ok(bubbles('error').some((h) => h.includes('Type a message after /research.')), bubbles('error').join('\n'));
  assert.ok(bubbles('error').some((h) => h.includes('Type a message after /chat.')));
  T.el.chat.children.length = 0;
  const send = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async () => undefined;
  try {
    await T.refreshContext();
    await T.refreshContext();
    assert.deepStrictEqual(bubbles('error'), ['No response from the document tab. Reload it (F5).']);
    assert.strictEqual(state.statusText.text, 'No response from the document tab. Reload it (F5).');
    assert.ok(!/Reload/.test(T.el.docStatus.textContent));
    chrome.tabs.sendMessage = async () => ({ ok: true, title: 'My Doc' });
    await T.refreshContext(); // a working tab: the next failure is shown again
    chrome.tabs.sendMessage = async () => undefined;
    await T.refreshContext();
    assert.strictEqual(bubbles('error').length, 2);
  } finally { chrome.tabs.sendMessage = send; }
});
