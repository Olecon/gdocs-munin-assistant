'use strict';
// Stream parsers (Anthropic, OpenAI Responses, Munin Chat Completions), SSE parsing and the retries of runStream.
const { test, before } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { deq, load, makeSnapFor } = require('./lib/sandbox');
const { sseResponse, ev } = require('./lib/streams');

let env, T, state, sandbox, snapFor, anthropicSse, snapA, reqA, res;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  sandbox = env.ctx;
  snapFor = makeSnapFor(env);
});

test('streamAnthropic', async () => {
  // --- Anthropic stream
  anthropicSse =
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Replacing ' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now — ünïcode.' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'replace_selection', input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"text": "Hel' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'lo!"}' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 2 }) +
    ev('ping', { type: 'ping' }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 57 } }) +
    ev('message_stop', { type: 'message_stop' });
  sandbox.fetch = async (url, init) => { assert.strictEqual(url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(JSON.parse(init.body).model, 'claude-opus-5-5'); return sseResponse(anthropicSse); };
  snapA = snapFor('anthropic', { model: 'claude-opus-5-5', baseUrl: '' });
  reqA = T.buildRequest('edit', snapA);
  const seen = { reasoning: [], content: [], tools: [] };
  res = await T.streamAnthropic(reqA, new AbortController().signal, snapA, { onReasoning: (r) => seen.reasoning.push(r), onContent: (c) => seen.content.push(c), onToolCall: (i) => seen.tools.push(i) });
  assert.strictEqual(res.content, 'Replacing now — ünïcode.');
  assert.strictEqual(res.reasoning, 'Let me think.');
  assert.strictEqual(res.finishReason, 'tool_calls');
  deq(res.toolCalls, [{ id: 'toolu_9', type: 'function', function: { name: 'replace_selection', arguments: '{"text": "Hello!"}' } }]);
  deq(res.usage, { input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, completion_tokens: 57, prompt_tokens: 1400, total_tokens: 1457 });
  assert.strictEqual(res.servedBy, 'claude-opus-5-5');
  assert.strictEqual(res.raw.key, '_anthropicBlocks');
  deq(res.raw.items, [
    { type: 'thinking', thinking: 'Let me think.', signature: 'SIG' },
    { type: 'text', text: 'Replacing now — ünïcode.' },
    { type: 'tool_use', id: 'toolu_9', name: 'replace_selection', input: { text: 'Hello!' } },
  ]);
  deq(seen.tools, [0]);
  assert.strictEqual(seen.content[seen.content.length - 1], res.content);
  const entry = T.assistantEntry(res, true);
  deq(entry._anthropicBlocks, res.raw.items); assert.strictEqual(entry._reasoning, 'Let me think.');
  assert.strictEqual(T.assistantEntry(res, false)._anthropicBlocks, undefined);
});

test('streamAnthropic refusal / errors', async () => {
  // Refusal + fallback model + mid-stream error
  sandbox.fetch = async () => sseResponse(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } } }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } }, usage: { output_tokens: 0 } }) + ev('message_stop', { type: 'message_stop' }));
  res = await T.streamAnthropic(reqA, new AbortController().signal, snapA, {});
  assert.strictEqual(res.finishReason, 'refusal'); assert.strictEqual(res.stopDetails.category, 'bio'); assert.strictEqual(res.servedBy, 'claude-opus-4-8');
  sandbox.fetch = async () => sseResponse(ev('message_start', { type: 'message_start', message: {} }) + ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  await assert.rejects(() => T.streamAnthropic(reqA, new AbortController().signal, snapA, {}), /Overloaded/);
  sandbox.fetch = async () => sseResponse(ev('message_start', { type: 'message_start', message: {} }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }));
  await assert.rejects(() => T.streamAnthropic(reqA, new AbortController().signal, snapA, {}), (e) => e.message.includes('cut off') && e.partial.content === 'partial');
  sandbox.fetch = async () => sseResponse(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 401);
  await assert.rejects(() => T.streamAnthropic(reqA, new AbortController().signal, snapA, {}), (e) => /HTTP 401/.test(e.message) && e.showSettings === true && e.status === 401);
  sandbox.fetch = async () => sseResponse(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } }), 404);
  await assert.rejects(() => T.streamAnthropic(reqA, new AbortController().signal, snapA, {}), (e) => /HTTP 404/.test(e.message) && /claude-x/.test(e.message) && e.showSettings === true);
});

test('runStream retries 429/5xx and failed connections twice before the stream starts; not 400, a started stream or a Stop', async () => {
  // --- runStream: transient failures before the stream are retried with a backoff
  const R = vm.runInContext('({ runStream, STREAM_RETRY_DELAYS_MS, STREAM_RETRY_STATUS })', sandbox);
  deq([...R.STREAM_RETRY_DELAYS_MS], [2000, 5000]); deq([...R.STREAM_RETRY_STATUS], [429, 500, 502, 503, 504, 529]);
  const savedDelays = R.STREAM_RETRY_DELAYS_MS.slice();
  R.STREAM_RETRY_DELAYS_MS.splice(0, 2, 20, 20);
  const statusSeen = [];
  let statusText = 'Document: 5 characters';
  Object.defineProperty(T.el.docStatus, 'textContent', { configurable: true, get: () => statusText, set: (v) => { statusText = v; statusSeen.push(v); } });
  let rCalls = 0;
  const errBody = (status) => sseResponse(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), status);
  sandbox.fetch = async () => (++rCalls === 1 ? errBody(429) : sseResponse(anthropicSse));
  res = await R.runStream(reqA, new AbortController().signal, snapA, {});
  assert.strictEqual(rCalls, 2); assert.strictEqual(res.content, 'Replacing now — ünïcode.');
  deq(statusSeen, ['Anthropic (Claude) is busy (HTTP 429); retrying in 0 s…', 'Document: 5 characters']); // restored after the wait
  // a failed fetch (no response) is retried too; the status names the connection
  rCalls = 0; statusSeen.length = 0;
  sandbox.fetch = async () => { if (++rCalls === 1) throw new TypeError('Failed to fetch'); return sseResponse(anthropicSse); };
  res = await R.runStream(reqA, new AbortController().signal, snapA, {});
  assert.strictEqual(rCalls, 2); assert.strictEqual(statusSeen[0], 'Anthropic (Claude) connection failed; retrying in 0 s…');
  // two retries at most: the third failure is shown
  rCalls = 0;
  sandbox.fetch = async () => { rCalls++; return errBody(529); };
  await assert.rejects(() => R.runStream(reqA, new AbortController().signal, snapA, {}), (e) => e.status === 529);
  assert.strictEqual(rCalls, 3);
  // not retried: other 4xx, a stream that already started
  rCalls = 0;
  sandbox.fetch = async () => { rCalls++; return sseResponse(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), 400); };
  await assert.rejects(() => R.runStream(reqA, new AbortController().signal, snapA, {}), (e) => e.status === 400);
  assert.strictEqual(rCalls, 1);
  rCalls = 0;
  sandbox.fetch = async () => { rCalls++; return sseResponse(ev('message_start', { type: 'message_start', message: {} }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })); };
  await assert.rejects(() => R.runStream(reqA, new AbortController().signal, snapA, {}), (e) => e.message.includes('cut off') && e.partial.content === 'partial');
  assert.strictEqual(rCalls, 1);
  // a Stop during the wait (the real 2 s delay) ends it at once, without another request
  R.STREAM_RETRY_DELAYS_MS.splice(0, 2, ...savedDelays);
  rCalls = 0;
  const acR = new AbortController();
  sandbox.fetch = async () => { rCalls++; setTimeout(() => acR.abort(), 20); return errBody(503); };
  const t0 = Date.now();
  await assert.rejects(() => R.runStream(reqA, acR.signal, snapA, {}), (e) => e.status === 503);
  assert.ok(Date.now() - t0 < 1000); assert.strictEqual(rCalls, 1);
  assert.strictEqual(statusText, 'Document: 5 characters');
  delete T.el.docStatus.textContent; T.el.docStatus.textContent = '';
});

test('streamResponses', async () => {
  // --- OpenAI Responses stream
  const finalItems = [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan A' }, { type: 'summary_text', text: 'Plan B' }], encrypted_content: 'ENC' },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Replacing.', annotations: [] }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_77', name: 'replace_selection', arguments: '{"text":"Hi there"}', status: 'completed' },
  ];
  const openaiSse =
    ev('response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }) +
    ev('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }) +
    ev('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan A' }) +
    ev('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1, part: { type: 'summary_text', text: '' } }) +
    ev('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'Plan B' }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: finalItems[0] }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }) +
    ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Replac' }) +
    ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'ing.' }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: finalItems[1] }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_77', name: 'replace_selection', arguments: '' } }) +
    ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"text":"Hi ' }) +
    ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 2, delta: 'there"}' }) +
    ev('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"text":"Hi there"}' }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 2, item: finalItems[2] }) +
    ev('response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: finalItems, usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 }, total_tokens: 2300 } } });
  sandbox.fetch = async (url, init) => { assert.strictEqual(url, 'https://api.openai.com/v1/responses'); const b = JSON.parse(init.body); assert.strictEqual(b.store, false); return sseResponse(openaiSse); };
  const snapO = snapFor('openai', { model: 'gpt-6.1-sol', baseUrl: '' });
  const reqO = T.buildRequest('edit', snapO);
  const seenO = { tools: [] };
  res = await T.streamResponses(reqO, new AbortController().signal, snapO, { onToolCall: (i) => seenO.tools.push(i) });
  assert.strictEqual(res.content, 'Replacing.');
  assert.strictEqual(res.reasoning, 'Plan A\n\nPlan B');
  assert.strictEqual(res.finishReason, 'tool_calls');
  deq(res.toolCalls, [{ id: 'call_77', type: 'function', function: { name: 'replace_selection', arguments: '{"text":"Hi there"}' } }]);
  deq(res.usage, { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, cache_read_input_tokens: 1500, reasoning_tokens: 250 });
  deq(res.raw, { key: '_openaiItems', items: finalItems });
  deq([...new Set(seenO.tools)], [0]);
  // incomplete (max_output_tokens) -> 'length'; failed -> error; summary not allowed -> retried without summary
  sandbox.fetch = async () => sseResponse(ev('response.incomplete', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }));
  res = await T.streamResponses(reqO, new AbortController().signal, snapO, {});
  assert.strictEqual(res.finishReason, 'length'); assert.strictEqual(res.content, 'cut');
  sandbox.fetch = async () => sseResponse(ev('response.failed', { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }));
  await assert.rejects(() => T.streamResponses(reqO, new AbortController().signal, snapO, {}), /boom/);
  let calls = 0;
  sandbox.fetch = async (url, init) => {
    calls++;
    const b = JSON.parse(init.body);
    if (b.reasoning && b.reasoning.summary) return sseResponse(JSON.stringify({ error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error' } }), 400);
    assert.strictEqual(b.reasoning, undefined);
    return sseResponse(ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'fine' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
  };
  res = await T.streamResponses(reqO, new AbortController().signal, snapO, {});
  assert.strictEqual(calls, 2); assert.strictEqual(res.content, 'fine'); assert.strictEqual(res.finishReason, 'stop'); assert.strictEqual(state.openaiNoSummary, true);
  state.openaiNoSummary = false;
});

test('streamChat (Munin)', async () => {
  // --- Munin chat stream (unchanged behavior) incl. multi-line data and [DONE]
  const chatSse = 'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning":"think"}}]}\n\n' +
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"id":"1","choices":[{"index":0,\ndata: "delta":{"content":"lo"}}]}\n\n' +
    'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"replace_selection","arguments":"{\\"te"}}]}}]}\n\n' +
    'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":null,"arguments":"xt\\":\\"X\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
    'data: [DONE]\n\n';
  sandbox.fetch = async (url, init) => { assert.strictEqual(init.headers.Authorization, 'Bearer k-munin'); return sseResponse(chatSse); };
  const snapM = snapFor('munin');
  const reqM = T.buildRequest('edit', snapM);
  res = await T.streamChat(reqM, new AbortController().signal, snapM, {});
  assert.strictEqual(res.content, 'Hello'); assert.strictEqual(res.reasoning, 'think'); assert.strictEqual(res.finishReason, 'tool_calls');
  deq(res.toolCalls, [{ id: 'call_a', type: 'function', function: { name: 'replace_selection', arguments: '{"text":"X"}' } }]);
  deq(res.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.strictEqual(res.raw, undefined);
  sandbox.fetch = async () => sseResponse(JSON.stringify({ error: { message: 'quota' } }), 429);
  await assert.rejects(() => T.streamChat(reqM, new AbortController().signal, snapM, {}), /monthly token quota of this Munin API key is used up/);
});

test('readSseEvents CRLF', async () => {
  // CRLF stream and 'event:' without data.type fallback
  const crlf = anthropicSse.replace(/\n/g, '\r\n');
  const got = [];
  await T.readSseEvents(sseResponse(crlf), (e, d) => got.push([e, d.type]));
  assert.strictEqual(got.length, 17); assert.ok(got.every(([e, t]) => e === t));
});

test('runStream does not retry an exhausted quota: Munin HTTP 429, OpenAI 429 insufficient_quota (a plain OpenAI 429 is retried)', async () => {
  const R = vm.runInContext('({ runStream, STREAM_RETRY_DELAYS_MS })', sandbox);
  const savedDelays = R.STREAM_RETRY_DELAYS_MS.slice();
  R.STREAM_RETRY_DELAYS_MS.splice(0, 2, 20, 20);
  try {
    let calls = 0;
    const snapM = snapFor('munin');
    const reqM = T.buildRequest('edit', snapM);
    sandbox.fetch = async () => { calls++; return sseResponse(JSON.stringify({ error: { message: 'quota' } }), 429); };
    await assert.rejects(() => R.runStream(reqM, new AbortController().signal, snapM, {}), (e) => e.quota === true && /monthly token quota of this Munin API key is used up/.test(e.message));
    assert.strictEqual(calls, 1);
    const snapO = snapFor('openai', { model: 'gpt-6.1-sol' });
    const reqO = T.buildRequest('edit', snapO);
    calls = 0;
    const quotaBody = { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } };
    sandbox.fetch = async () => { calls++; return sseResponse(JSON.stringify(quotaBody), 429); };
    await assert.rejects(() => R.runStream(reqO, new AbortController().signal, snapO, {}),
      (e) => e.quota === true && e.serverCode === 'insufficient_quota' && /OpenAI quota exhausted \(HTTP 429\)/.test(e.message));
    assert.strictEqual(calls, 1);
    calls = 0;
    const rateBody = { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } };
    sandbox.fetch = async () => { calls++; return sseResponse(JSON.stringify(rateBody), 429); };
    await assert.rejects(() => R.runStream(reqO, new AbortController().signal, snapO, {}), (e) => !e.quota && /Rate limit or quota exceeded/.test(e.message));
    assert.strictEqual(calls, 3); // transient: two retries
  } finally {
    R.STREAM_RETRY_DELAYS_MS.splice(0, 2, ...savedDelays);
    T.el.docStatus.textContent = '';
  }
});
