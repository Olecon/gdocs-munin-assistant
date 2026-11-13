'use strict';
// The footer status's state words (render.js KIND_WORDS, kindText, bubbleStatus; turn.js streamHooks live.calling): "Working…"
// before anything arrives; while the stream writes a tool call (its name arrived, its arguments not complete) the
// call's kind word ("Reading…", "Editing…", "Searching…"); when the call runs, its location line; a running call
// without a location shows its kind word or its pending text, so the orb never floats without a word.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev, sseResponse, textRound } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

let env, T, state, el;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.\n\nDelta line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  state.applyMode = 'auto'; T.applyApplyMode('auto');
});
after(() => env.close());

const msgStart = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } });
const callStart = (id, name) => ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
const argsPart = (json) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } });
const callEnd = ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }) + ev('message_stop', { type: 'message_stop' });
const liveBubble = () => $$('.msg.assistant').pop();
const placeShown = () => { const b = liveBubble(); return !b || b.querySelector('.thinking').classList.contains('hidden') ? '' : b.querySelector('.msg-foot > .thinking .thinking-label').textContent; };

// Every text the status line of the live bubble shows, in order (the call's own run is too quick to wait for).
function recordPlace() {
  const seen = [];
  const note = () => { const t = placeShown(); if (t && seen[seen.length - 1] !== t) seen.push(t); };
  const obs = new env.window.MutationObserver(note);
  obs.observe(el.chat, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  return { seen, stop: () => { note(); obs.disconnect(); } };
}

// One turn: the tool call streams (its name, then its arguments in two parts), runs, and a text round ends the turn.
async function callTurn(name, args, wordWhileStreaming) {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' }; // the export: paste fallback
    return n++ === 0 ? stream.response : sseResponse(textRound('Done.'));
  };
  await T.createChat();
  typeInto(el.input, 'Go');
  key(el.input, 'Enter');
  await waitFor(() => stream.reads > 0 && placeShown() === 'Working…', '"Working…" before anything arrives');
  const rec = recordPlace();
  stream.push(msgStart + callStart('toolu_' + name, name));
  await waitFor(() => placeShown() === wordWhileStreaming, `${wordWhileStreaming} once the name arrived`);
  const json = JSON.stringify(args);
  stream.push(argsPart(json.slice(0, 5)));
  await tick(30);
  assert.strictEqual(placeShown(), wordWhileStreaming, 'the word stays while the arguments stream');
  assert.ok(!liveBubble().querySelector('canvas.orb').classList.contains('hidden'), 'the orb on its line');
  assert.strictEqual(liveBubble().querySelector('canvas.orb').parentElement, liveBubble().querySelector('.msg-foot > .thinking > summary'));
  stream.push(argsPart(json.slice(5)) + callEnd);
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  rec.stop();
  return rec.seen;
}

test('a read: "Working…", then "Reading…" while its arguments stream, then its location line', async () => {
  const seen = await callTurn('read_document', { scope: { start: 3, end: 3 }, include: null, doc: null }, 'Reading…');
  assert.deepStrictEqual(seen.slice(0, 2), ['Reading…', 'Reading line 3 in My Doc']);
});

test('a search: "Searching…" while its arguments stream, then what it searches for', async () => {
  const seen = await callTurn('find_in_document', { query: 'Delta', doc: null }, 'Searching…');
  assert.deepStrictEqual(seen.slice(0, 2), ['Searching…', 'Searching the document for "Delta"']);
});

test('an edit: "Editing…" while its arguments stream', async () => {
  const seen = await callTurn('replace_selection', { text: 'New.' }, 'Editing…');
  assert.strictEqual(seen[0], 'Editing…');
});

test('the kind words: one table; a running call without a location shows its word or its pending text', () => {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = true; // liveAnswer's ensureBubble
  const word = (upd) => { T.updateAssistantBubble(b, upd); return b.querySelector('.thinking').classList.contains('hidden') ? '' : b.querySelector('.msg-foot > .thinking .thinking-label').textContent; };
  // while the stream writes a call
  const streaming = (name) => word({ streaming: true, last: 'call', reasoning: 'Hm.', thoughtMs: 1000, calling: name });
  assert.deepStrictEqual(['read_document', 'get_selection', 'document_changes', 'insert_after_line', 'edit_document', 'format_lines', 'replace_text',
    'table', 'search', 'find_in_document', 'find_reference', 'find_relevant_sections', 'ask_user', 'delegate', 'models', 'check_references',
    'remember', 'no_such_tool'].map(streaming),
  ['Reading…', 'Reading…', 'Reading…', 'Editing…', 'Editing…', 'Editing…', 'Editing…',
    'Editing…', 'Searching…', 'Searching…', 'Searching…', 'Searching…', 'Asking…', 'Delegating…', 'Checking…', 'Checking…',
    'Editing…', 'Working…']);
  assert.strictEqual(word({ streaming: true }), 'Working…', 'nothing arrived yet');
  // a running call without a location of its own
  const pending = (name, args = {}) => word({ activity: [{ log: true, name, summary: '', args, result: null, status: 'pending' }] });
  assert.strictEqual(pending('ask_user', { question: 'Which?' }), 'Asking…');
  assert.strictEqual(pending('get_selection'), 'Reading…');
  assert.strictEqual(pending('search', { query: 'EPR' }), 'Searching…');
  assert.strictEqual(pending('models', { action: 'check' }), 'Checking…');
  assert.strictEqual(pending('models', { action: 'switch', model: 'x' }), 'Switching the model…', 'its pending text');
  assert.strictEqual(pending('remember', { action: 'add', text: 'x' }), 'Updating DOC.md…', 'remember: its file');
  assert.strictEqual(pending('remember', { scope: 'main', action: 'add', text: 'x' }), 'Updating MAIN.md…');
  assert.strictEqual(pending('edit_document', {}), 'Editing the document…', 'a write without a location keeps its pending text');
  assert.strictEqual(pending('table', { action: 'delete_row' }), 'Changing a table…');
  // a call that has a location keeps it (a location is selectable text)
  Object.assign(state, { docText: '# T\n\nx', docFormat: 'markdown', docModel: null });
  assert.strictEqual(pending('find_in_document', { query: 'x' }), 'Searching the document for "x"');
  // the verifying re-read after a write keeps its text
  assert.strictEqual(word({ activity: [{ log: true, name: 'insert_after_line', summary: '', args: { line: 0, text: 'y' }, result: null, status: 'pending', phase: 'verifying' }] }), 'Verifying the edit');
});
