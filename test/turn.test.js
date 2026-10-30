'use strict';
// Full turns through sendMessage: Anthropic and OpenAI tool loops, Manual mode, Auto edits with the action log.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, D, state, sandbox, storage, chrome, ident, routeDocs, bodies, readOut, h, o2, hist;
const EPH = { type: 'ephemeral' };
const pasteOk = () => JSON.stringify({ ok: true, note: T.PASTE_DONE_NOTE }); // the model's result of a paste
// The turn context of the sample document (Markdown export, selection "quick brown").
const CTX1 = '<document title="My Doc" format="markdown" lines="8" characters="66">\nOutline (line: heading):\nL1: # My Doc\nL5: ## Methods\n</document>\n' +
  'Selection: line 7 (11 characters)';

before(async () => {
  env = await load();
  T = D = env.T;
  state = env.state;
  state.applyMode = 'auto'; // these turns exercise the editing tools (Manual is the default)
  sandbox = env.ctx;
  storage = env.storage;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ routeDocs } = docsBench(env, ident, ref));
});

test('end-to-end turn (Anthropic)', async () => {
  // --- end-to-end turn through sendMessage (Anthropic): tool round + final round, raw blocks replayed
  const docTab = { id: 7, url: 'https://docs.google.com/document/d/DOC123/edit', title: 'My Doc - Google Docs' };
  chrome.tabs.query = async () => [docTab];
  chrome.tabs.get = async (id) => { if (id === 7) return docTab; throw new Error('no tab'); };
  const tabMsgs = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg.type);
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nIntro line \\- escaped\\.\n\n## Methods\n\nThe quick brown fox.\n', format: 'markdown', title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: 'quick brown' };
      case 'REPLACE_SELECTION': assert.strictEqual(msg.text, 'fast brown'); return { ok: true };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOC123'); assert.ok(state.chatId); deq(state.messages, []);
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-NEW', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  bodies = [];
  const round0 = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 80 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_read', name: 'read_lines', input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"start":5,"end":7}' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }) + ev('message_stop', { type: 'message_stop' });
  const round1 = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan.' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S1' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_e2e', name: 'replace_selection', input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"fast brown"}' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }) + ev('message_stop', { type: 'message_stop' });
  const round2 = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 130 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Replaced it.' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + ev('message_stop', { type: 'message_stop' });
  sandbox.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse([round0, round1, round2][bodies.length - 1]); };
  T.el.input.value = 'Make it faster and replace';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(bodies.length, 3);
  assert.ok(state.docText.includes('Intro line - escaped.')); // export escapes removed
  // feat/context: the outline and the selection are the turn context at the start of the user message
  // (stored as _context); the system prompt is the static head only, one cached block
  assert.strictEqual(bodies[0].system.length, 1);
  assert.ok(!bodies[0].system[0].text.includes('Outline (line: heading)'));
  assert.ok(!JSON.stringify(bodies[0]).includes('The quick brown fox.')); // the text itself is not in the prompt
  deq(bodies[0].tools.map((t) => t.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'replace_selection', 'ask_user']);
  deq(bodies[0].messages, [{ role: 'user', content: [{ type: 'text', text: `${CTX1}\n\nMake it faster and replace`, cache_control: EPH }] }]);
  readOut = 'Lines 5-7 of 8:\n5: ## Methods\n6: \n7: The quick brown fox.';
  deq(bodies[1].messages, [
    { role: 'user', content: [{ type: 'text', text: `${CTX1}\n\nMake it faster and replace` }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'read_lines', input: { start: 5, end: 7 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: readOut, cache_control: EPH }] },
  ]);
  deq(bodies[2].system, bodies[0].system); // frozen for the turn although the selection was cleared by the replacement
  deq(bodies[2].tools, bodies[0].tools);
  deq(bodies[2].messages.slice(3), [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan.', signature: 'S1' }, { type: 'tool_use', id: 'toolu_e2e', name: 'replace_selection', input: { text: 'fast brown' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e', content: pasteOk(), cache_control: EPH }] },
  ]);
  assert.ok(tabMsgs.includes('REPLACE_SELECTION'));
  h = state.messages;
  assert.strictEqual(h.length, 6);
  assert.strictEqual(h[0].content, 'Make it faster and replace'); assert.strictEqual(h[0]._context, CTX1);
  // the replay payloads are dropped when the turn ends (slimHistory); a short read result stays as it is
  assert.strictEqual(h[1].tool_calls[0].function.name, 'read_lines'); assert.strictEqual(h[1]._anthropicBlocks, undefined);
  assert.ok(h[2]._reading && h[2]._ok && h[2].content === readOut);
  deq(T.actionLogFromToolCalls(h[1].tool_calls, new Map([['toolu_read', h[2]]])), [{ log: true, name: 'read_lines', summary: 'lines 5–7', args: { start: 5, end: 7 }, result: readOut, status: 'ok' }]);
  assert.strictEqual(h[3]._anthropicBlocks, undefined); assert.strictEqual(h[3]._reasoning, 'Plan.'); assert.strictEqual(h[3].tool_calls[0].id, 'toolu_e2e');
  assert.strictEqual(h[4]._ok, true);
  assert.strictEqual(h[5].content, 'Replaced it.'); assert.strictEqual(h[5]._anthropicBlocks, undefined);
  deq(h[5]._usage, { input_tokens: 130, completion_tokens: 5, prompt_tokens: 130, total_tokens: 135 });
  assert.strictEqual(state.busy, false);
  deq(JSON.parse(JSON.stringify(storage['muninChatHistory:DOC123:' + state.chatId])), h); // persisted
});

test('end-to-end turn (OpenAI)', async () => {
  // --- end-to-end turn (OpenAI) continuing the same chat: previous turn rebuilt, current turn's items replayed
  state.settings.provider = 'openai';
  Object.assign(state.settings.providers.openai, { apiKey: 'sk-OPEN', model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1' });
  bodies.length = 0;
  const rsItem = { type: 'reasoning', id: 'rs_e2e', summary: [{ type: 'summary_text', text: 'Thinking it over' }], encrypted_content: 'ENC' };
  const fcItem = { type: 'function_call', id: 'fc_e2e', call_id: 'call_e2e', name: 'replace_selection', arguments: '{"text":"fast brown"}', status: 'completed' };
  const o1 = ev('response.created', { type: 'response.created', response: {} }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_e2e', summary: [] } }) +
    ev('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Thinking it over' }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { ...fcItem, arguments: '', status: 'in_progress' } }) +
    ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"text":"fast brown"}' }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: fcItem }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [rsItem, fcItem], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } });
  o2 = ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: 'Done!' }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done!' }] }], usage: { input_tokens: 70, output_tokens: 3, total_tokens: 73 } } });
  sandbox.fetch = async (url, init) => { assert.strictEqual(url, 'https://api.openai.com/v1/responses'); bodies.push(JSON.parse(init.body)); return sseResponse(bodies.length === 1 ? o1 : o2); };
  T.el.input.value = 'Once more, replace';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(bodies.length, 2);
  deq(bodies[0].reasoning, { summary: 'auto' });
  deq(bodies[0].input, [
    { role: 'user', content: `${CTX1}\n\nMake it faster and replace` },
    { type: 'function_call', call_id: 'toolu_read', name: 'read_lines', arguments: '{"start":5,"end":7}' },
    { type: 'function_call_output', call_id: 'toolu_read', output: readOut },
    { type: 'function_call', call_id: 'toolu_e2e', name: 'replace_selection', arguments: '{"text":"fast brown"}' },
    { type: 'function_call_output', call_id: 'toolu_e2e', output: pasteOk() },
    { role: 'assistant', content: 'Replaced it.' },
    { role: 'user', content: `${CTX1}\n\nOnce more, replace` }, // the same document and selection: the same context, no changes note
  ]);
  assert.strictEqual(bodies[0].prompt_cache_key, 'DOC123:' + state.chatId);
  assert.strictEqual(bodies[0].tools.length, 8); // + open_document (Phase C1), remember, ask_user
  assert.strictEqual(bodies[1].instructions, bodies[0].instructions);
  deq(bodies[1].input.slice(7), [rsItem, fcItem, { type: 'function_call_output', call_id: 'call_e2e', output: pasteOk() }]);
  h = state.messages;
  assert.strictEqual(h.length, 10);
  assert.strictEqual(h[7]._reasoning, 'Thinking it over'); assert.strictEqual(h[7]._openaiItems, undefined); assert.strictEqual(h[7]._anthropicBlocks, undefined); // dropped after the turn
  assert.strictEqual(h[9].content, 'Done!'); deq(h[9]._usage, { prompt_tokens: 70, completion_tokens: 3, total_tokens: 73 });
});

test('manual mode request (reading tools only)', async () => {
  // --- Manual mode on OpenAI: no tools, tool history stripped
  state.applyMode = 'manual';
  bodies.length = 0;
  sandbox.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(o2); };
  T.el.input.value = 'Suggest a synonym';
  await T.sendMessage();
  assert.strictEqual(bodies.length, 1);
  deq(bodies[0].tools.map((t) => t.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user']); // reading, no editing
  assert.ok(bodies[0].instructions.includes('You CANNOT modify the document: there is no replace_selection tool'));
  state.applyMode = 'auto';
});

test('Auto mode: edits applied directly; result to the model; action log live and from the history', async () => {
  // Shared setup for the edit turns: Docs API connected, Anthropic, a fresh fake document per turn.
  let pvBodies = [];
  const startTurn = async (rounds, text) => {
    fake = fakeDocsServer(docSpec());
    fake.token = ident.token = 'tok-1'; ident.granted = true;
    state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
    pvBodies = [];
    sandbox.fetch = routeDocs(async (url, init) => { pvBodies.push(JSON.parse(init.body)); return sseResponse(rounds[pvBodies.length - 1]); });
    chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc', text: '' });
    await D.createChat();
    T.el.chat.children.length = 0;
    T.el.input.value = text;
    return T.sendMessage();
  };
  const toolResult = (body, i) => body.messages[body.messages.length - 1].content[i || 0];
  const bubbles = () => T.el.chat.children.filter((c) => c.className.includes('assistant') && c._rows && c._rows.length);

  // --- Auto mode: the edit is applied directly (no confirmation), its result goes to the model
  let turn = startTurn([
    msgStart + tu(0, 'toolu_pr', 'read_lines', { start: 4, end: 5 }) + stopTool,
    msgStart + tu(0, 'toolu_pw', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }) + stopTool,
    textRound('Done.'),
  ], 'Capitalize gamma');
  await turn;
  assert.strictEqual(pvBodies.length, 3);
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.ok(!T.el.chat.children.some((c) => c.className.includes('preview'))); // no confirmation card
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.'));
  assert.strictEqual(toolResult(pvBodies[2]).content, 'Done: replaced line 4.\nLines 4-4 now:\n4: Alpha beta GAMMA.\nThe document now has 10 lines.');
  hist = state.messages;
  assert.strictEqual(hist[4]._decision, undefined); assert.strictEqual(hist[4]._ok, true); assert.strictEqual(hist[4]._edit.id, 'toolu_pw');
  assert.strictEqual(hist[2]._decision, undefined); // reading calls are never gated
  // action log rows: live, from the history (end of the turn), and after another re-render
  const READ_ROW = '<summary title="read_lines: lines 4–5">📖 <span class="activity-name">read_lines</span>: lines 4–5</summary><div class="log-body">' +
    '<div class="log-label">Arguments</div><pre>start: 4\nend: 5</pre><div class="log-label">Result (58 characters)</div><pre>Lines 4-5 of 10:\n4: Alpha beta gamma.\n5: Alpha beta delta.</pre></div>';
  const WRITE_ROW = '<summary title="replace_text: &quot;beta gamma&quot;">✏️ <span class="activity-name">replace_text</span>: &quot;beta gamma&quot;</summary><div class="log-body">' +
    '<div class="log-label">Arguments</div><pre>old_text: beta gamma\nnew_text: beta GAMMA</pre><div class="log-label">Result (89 characters)</div>' +
    '<pre>Done: replaced line 4.\nLines 4-4 now:\n4: Alpha beta GAMMA.\nThe document now has 10 lines.</pre></div>';
  const rowsOf = (bs) => bs.map((b) => b._rows.map((r) => [r.tagName, r.className, r.innerHTML]));
  const EXPECTED_ROWS = [[['details', 'activity-row log-row ok', READ_ROW]], [['details', 'activity-row log-row ok', WRITE_ROW]]];
  const all = bubbles();
  assert.strictEqual(all.length, 4); // two live bubbles, then the two rendered from the history
  deq(rowsOf(all.slice(0, 2)), EXPECTED_ROWS);
  deq(rowsOf(all.slice(2)), EXPECTED_ROWS);
  T.el.chat.children.length = 0;
  T.renderHistory();
  deq(rowsOf(bubbles()), EXPECTED_ROWS);
  let cardsNow = T.el.chat.children.filter((c) => c.className.includes('tool-card'));
  assert.strictEqual(cardsNow.length, 1);
  assert.ok(cardsNow[0].innerHTML.startsWith('<div>✅ Replaced line 4</div>') && cardsNow[0].innerHTML.includes('data-act="undo-edit" data-edit="toolu_pw"'));
});

test('one paste per turn: a second replace_selection is refused without a paste; the next message may paste again', async () => {
  const docTab = { id: 7, url: 'https://docs.google.com/document/d/DOC123/edit', title: 'My Doc - Google Docs' };
  chrome.tabs.query = async () => [docTab];
  chrome.tabs.get = async (id) => { if (id === 7) return docTab; throw new Error('no tab'); };
  const pastes = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_DOC_TEXT': return { ok: true, text: '', format: 'markdown', title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'REPLACE_SELECTION': pastes.push(msg.text); return { ok: true, method: 'paste', verified: false, attempts: 1, detail: '' };
      default: return { ok: true };
    }
  };
  state.googleConnected = false; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-NEW', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  let rounds = [
    msgStart + tu(0, 'toolu_p1', 'replace_selection', { text: 'Hello.' }) + stopTool,
    msgStart + tu(0, 'toolu_r1', 'read_lines', { start: 1, end: 1 }) + stopTool,
    msgStart + tu(0, 'toolu_p2', 'replace_selection', { text: 'Hello.' }) + stopTool,
    textRound('Done.'),
  ];
  bodies = [];
  sandbox.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); };
  try {
    await D.createChat();
    T.el.chat.children.length = 0;
    T.el.input.value = 'Insert Hello.';
    await T.sendMessage();
    assert.strictEqual(bodies.length, 4);
    deq(pastes, ['Hello.']); // pasted once; the second call sent no REPLACE_SELECTION
    const last = (b) => b.messages[b.messages.length - 1].content[0];
    assert.strictEqual(last(bodies[1]).content, pasteOk());
    assert.strictEqual(last(bodies[3]).content, T.PASTE_AGAIN_TEXT);
    assert.strictEqual(T.PASTE_AGAIN_TEXT, 'Error: replace_selection was already used in this message and the text was pasted; the document snapshot predates the paste, ' +
      'so reading tools cannot show it. Do not paste again; if more changes are needed, say so in the chat and the user will send a new message.');
    const refused = state.messages.find((m) => m.tool_call_id === 'toolu_p2');
    assert.strictEqual(refused._ok, false); assert.strictEqual(refused._message, 'Not pasted again (already pasted once in this message)');
    const cards = T.el.chat.children.filter((c) => c.className.includes('tool-card')).map((c) => c.innerHTML).slice(-2); // as rendered from the history
    assert.ok(cards[0].includes('Pasted'), cards[0]);
    assert.ok(cards[1].startsWith('<div>⚠️ Not pasted again (already pasted once in this message)</div>') && cards[1].includes('<summary>Text (not pasted)</summary>'), cards[1]);
    // a new message is a new turn: it may paste again
    rounds = [msgStart + tu(0, 'toolu_p3', 'replace_selection', { text: 'Again.' }) + stopTool, textRound('Done.')];
    bodies = [];
    T.el.input.value = 'Insert Again.';
    await T.sendMessage();
    deq(pastes, ['Hello.', 'Again.']);
  } finally { state.googleConnected = true; }
});
