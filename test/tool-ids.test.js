'use strict';
// Tool-call ids unique in a chat (src/turn.js uniqueCallIds): a server that reuses one id in every response (or within
// one) gets a derived id stored for the call, its result and the provider's replay items, so the call/result pairs
// stay matched in the next request and in the copied chat log.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { ev, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, oaText, muTool, muText } = require('./lib/context');

let env, T, state, doc;
const DOC = ['# Doc', '', 'Alpha.', '', 'Beta.', '', 'Gamma.'].join('\n');

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = DOC;
  await T.refreshContext({ force: true });
});

const freshChat = async () => { await T.createChat(); T.el.chat.children.length = 0; };
const read = (n) => ({ scope: { start: n, end: n }, include: ['text'], doc: null });
const calls = () => state.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((tc) => tc.id));
const results = () => state.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);

test('a server that reuses one call id in every turn: the later calls get derived ids, results and replay match', async () => {
  useProvider(env, 'munin');
  state.applyMode = 'manual';
  await freshChat();
  recordFetch(env, [muTool('call_0', 'read_document', read(3)), muText('One.')]);
  await send(env, 'first');
  const b2 = recordFetch(env, [muTool('call_0', 'read_document', read(5)), muText('Two.')]);
  await send(env, 'second');
  recordFetch(env, [muTool('call_0', 'read_document', read(7)), muText('Three.')]);
  await send(env, 'third');
  deq(calls(), ['call_0', 'call_0_2', 'call_0_3']);
  deq(results(), ['call_0', 'call_0_2', 'call_0_3']);
  // the replayed history (the second turn's second request): every call has its own result
  const sent = b2[1].messages;
  deq(sent.filter((m) => m.role === 'assistant' && m.tool_calls).map((m) => m.tool_calls[0].id), ['call_0', 'call_0_2']);
  deq(sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['call_0', 'call_0_2']);
  // the copied log shows each call with its own result
  const log = T.buildChatLog(state.messages, {});
  for (const [n, word] of [[3, 'Alpha'], [5, 'Beta'], [7, 'Gamma']]) {
    assert.ok(log.includes(`> read_document({"scope":{"start":${n},"end":${n}},"include":["text"]}) → ok\n  Lines ${n}-${n} of 7:\n  ${n}: ${word}.`), log);
  }
});

test('a duplicate id within one response; OpenAI and Anthropic replay items follow the new id', async () => {
  // two calls with one id in one Munin response
  useProvider(env, 'munin');
  state.applyMode = 'manual';
  await freshChat();
  const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const fn = (args) => ({ name: 'read_document', arguments: JSON.stringify(args) });
  const twice = cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: fn(read(3)) }, { index: 1, id: 'x', type: 'function', function: fn(read(5)) }] } }] }) +
    cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const mb = recordFetch(env, [twice, muText('Done.')]);
  await send(env, 'read twice');
  deq(calls(), ['x', 'x_2']);
  deq(results(), ['x', 'x_2']);
  deq(mb[1].messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['x', 'x_2']);

  // OpenAI: the function_call item replayed within the turn carries the new call_id
  useProvider(env, 'openai');
  state.applyMode = 'manual';
  await freshChat();
  const item = (n) => ({ type: 'function_call', id: 'fc_' + n, call_id: 'same', name: 'read_document', arguments: JSON.stringify(read(n)), status: 'completed' });
  const oaRound = (n) => ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [item(n)], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  const ob = recordFetch(env, [oaRound(3), oaRound(5), oaText('Done.')]);
  await send(env, 'read');
  const input = ob[2].input;
  deq(input.filter((i) => i.type === 'function_call').map((i) => i.call_id), ['same', 'same_2']);
  deq(input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id), ['same', 'same_2']);

  // Anthropic: the tool_use block replayed within the turn carries the new id
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  state.applyMode = 'manual';
  await freshChat();
  const tuRound = (n) => msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_same', name: 'read_document', input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(read(n)) } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + stopTool;
  const ab = recordFetch(env, [tuRound(3), tuRound(5), textRound('Done.')]);
  await send(env, 'read');
  const msgs = ab[2].messages;
  deq(msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => b.id)), ['toolu_same', 'toolu_same_2']);
  deq(msgs.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)), ['toolu_same', 'toolu_same_2']);
  for (const id of ['openai', 'anthropic']) state.settings.providers[id].apiKey = '';
});

test('uniqueCallIds: an empty id becomes call_<n>; a fresh id stays', () => {
  const result = { toolCalls: [{ id: '', function: { name: 'a' } }, { id: 'fresh', function: { name: 'b' } }], raw: null };
  T.uniqueCallIds(result, [{ role: 'assistant', tool_calls: [{ id: 'call_2' }] }, { role: 'tool', tool_call_id: 'call_2' }]);
  deq(result.toolCalls.map((c) => c.id), ['call_3', 'fresh']);
});
