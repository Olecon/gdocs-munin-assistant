'use strict';
// Provider request layer: history conversion per provider, buildRequest for Anthropic, OpenAI and Munin, trimming.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor } = require('./lib/sandbox');

let env, T, state, PROVIDERS, snapFor, rawItems, req;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  snapFor = makeSnapFor(env);
});

test('anthropicAdaptive', async () => {
  // --- anthropicAdaptive
  for (const [m, want] of [['claude-opus-5-5', true], ['claude-fable-5-1', true], ['claude-opus-4-6', true], ['claude-haiku-4-5', false],
    ['claude-sonnet-4-5-20250929', false], ['claude-sonnet-4-20250514', false], ['claude-opus-4-1-20250805', false], ['claude-3-7-sonnet-20250219', false], ['gpt-6', false]]) {
    assert.strictEqual(T.anthropicAdaptive(m), want, m);
  }
});

test('toAnthropicMessages', async () => {
  // --- a sample history: finished turn with a tool call, then a new user message and a current-turn round
  state.docText = 'Hello document text. '.repeat(20); state.docTitle = 'Doc <1>'; state.docError = ''; state.selection = 'Hello';
  const rawBlocks = [{ type: 'thinking', thinking: 'hmm', signature: 'sig==' }, { type: 'tool_use', id: 'toolu_1', name: 'replace_selection', input: { text: 'Hi' } }];
  rawItems = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'replace_selection', arguments: '{"text":"Hi"}' }];
  state.messages = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'replace_selection', arguments: '{"text":"old"}' } }], _reasoning: 'r', _anthropicBlocks: [{ type: 'thinking', thinking: 'old', signature: 'x' }, { type: 'tool_use', id: 'call_old', name: 'replace_selection', input: { text: 'old' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: '{"ok":true}', _ok: true },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'Sure', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'replace_selection', arguments: '{"text":"Hi"}' } }], _anthropicBlocks: rawBlocks, _openaiItems: rawItems },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'Error: automatic paste failed', _ok: false },
  ];
  assert.strictEqual(T.lastUserIndex(state.messages), 4);

  // Anthropic conversion: old turn rebuilt without thinking, current turn replayed verbatim, tool results merged, is_error set.
  const am = T.toAnthropicMessages(true, state.messages);
  assert.strictEqual(am[0].role, 'user');
  deq(am[1].content, [{ type: 'tool_use', id: 'call_old', name: 'replace_selection', input: { text: 'old' } }]);
  deq(am[2].content, [{ type: 'tool_result', tool_use_id: 'call_old', content: '{"ok":true}' }]);
  deq(am[3].content, [{ type: 'text', text: 'Done.' }]);
  assert.strictEqual(am[4].role, 'user');
  deq(am[5].content, rawBlocks);
  deq(am[6].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Error: automatic paste failed', is_error: true }]);
  assert.strictEqual(am.length, 7);
  // Manual mode: no tool blocks at all, roles alternate.
  const amManual = T.toAnthropicMessages(false, state.messages);
  assert.ok(amManual.every((m) => m.content.every((b) => b.type === 'text' || b.type === 'thinking')));
  deq(amManual.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('toResponsesInput', async () => {
  // OpenAI conversion.
  const oi = T.toResponsesInput(true, state.messages);
  deq(oi[0], { role: 'user', content: 'fix it' });
  deq(oi[1], { type: 'function_call', call_id: 'call_old', name: 'replace_selection', arguments: '{"text":"old"}' });
  deq(oi[2], { type: 'function_call_output', call_id: 'call_old', output: '{"ok":true}' });
  deq(oi[3], { role: 'assistant', content: 'Done.' });
  deq(oi[5], rawItems[0]);
  deq(oi[6], rawItems[1]);
  deq(oi[7], { type: 'function_call_output', call_id: 'toolu_1', output: 'Error: automatic paste failed' });
  assert.strictEqual(oi.length, 8);
});

test('buildRequest anthropic', async () => {
  // --- buildRequest per provider (tools document access)
  const aSnap = snapFor('anthropic', { model: 'claude-opus-5-5' });
  req = T.buildRequest('edit', aSnap);
  assert.strictEqual(req.kind, 'anthropic');
  assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(req.headers['x-api-key'], 'k-anthropic');
  assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(req.body.fallbacks, 'default');
  deq(req.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.strictEqual(req.body.output_config, undefined); // the model's default effort
  // A config of an earlier version that still carries effort: the effort is not sent.
  req = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-opus-5-5', effort: 'low' }));
  deq(req.body.thinking, { type: 'adaptive', display: 'summarized' }); assert.strictEqual(req.body.output_config, undefined);
  // feat/context: the system prompt is the static head only (one cached block); the document summary and
  // the selection are the turn context of the user message (buildTurnContext, stored as _context)
  assert.strictEqual(req.body.system.length, 1);
  deq(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(!req.body.system[0].text.includes('<document title=') && !req.body.system[0].text.includes('Selection: line'));
  const ctxA = T.buildTurnContext('edit', aSnap);
  assert.ok(ctxA.includes('<document title="Doc &lt;1&gt;" format="text" lines="1" characters="'));
  assert.ok(ctxA.endsWith('\nSelection: line 1 (5 characters)'));
  deq(req.body.tools.map((t) => t.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'replace_selection', 'ask_user']);
  assert.strictEqual(req.body.tools[0].strict, true);
  assert.strictEqual(req.body.temperature, undefined);
  assert.strictEqual(req.body.max_tokens, 32000);
  assert.strictEqual(req.body.stream, true);
  // Old model: no thinking, no fallbacks.
  req = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-haiku-4-5' }));
  assert.strictEqual(req.body.thinking, undefined); assert.strictEqual(req.body.output_config, undefined);
  assert.strictEqual(req.body.fallbacks, undefined); assert.strictEqual(req.headers['anthropic-beta'], undefined);
  // Fixed endpoint: a stored base URL is ignored (so fallbacks stay on for eligible models).
  req = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-opus-5-5', baseUrl: 'https://proxy.example.com/v1/' }));
  assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(req.body.fallbacks, 'default');
  // Manual: reading tools only; persona on Anthropic: chat-only with persona instructions.
  req = T.buildRequest('manual', snapFor('anthropic', { baseUrl: '' }));
  deq(req.body.tools.map((t) => t.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user']);
  assert.ok(req.body.system[0].text.startsWith('You are an editing assistant') && req.body.system[0].text.includes('You CANNOT modify the document'));
  req = T.buildRequest('research', snapFor('anthropic'));
  // Phase C2: /research on Anthropic adds the server-side web search tool after the reading tools.
  deq(req.body.tools.slice(-1), [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]); assert.strictEqual(req.kind, 'anthropic');
  assert.ok(req.body.system[0].text.includes('Help them with research'));
  // tools mode: the persona text refers to the outline and the reading tools, not to an embedded excerpt
  assert.ok(req.body.system[0].text.includes('Use the document outline (inside <document>)') && !req.body.system[0].text.includes('document excerpt'));
});

test('buildRequest openai', async () => {
  req = T.buildRequest('edit', snapFor('openai', { model: 'gpt-6.1-sol' }));
  assert.strictEqual(req.kind, 'responses');
  assert.strictEqual(req.url, 'https://api.openai.com/v1/responses');
  assert.strictEqual(req.headers.Authorization, 'Bearer k-openai');
  deq(req.body.reasoning, { summary: 'auto' }); // the model's default reasoning effort
  // A config of an earlier version that still carries effort: the effort is not sent.
  deq(T.buildRequest('edit', snapFor('openai', { model: 'gpt-6.1-sol', effort: 'medium' })).body.reasoning, { summary: 'auto' });
  assert.strictEqual(req.body.store, false); assert.strictEqual(req.body.stream, true);
  assert.strictEqual(req.body.max_output_tokens, 32000);
  assert.strictEqual(typeof req.body.instructions, 'string');
  deq(req.body.tools[6], { type: 'function', name: 'replace_selection', description: req.body.tools[6].description, parameters: req.body.tools[6].parameters, strict: true });
  assert.strictEqual(req.body.input.length, 8);
  assert.strictEqual(req.body.temperature, undefined);
  req = T.buildRequest('edit', snapFor('openai', { model: 'gpt-4.1', baseUrl: 'https://evil.example.com' })); // ignored: fixed endpoint
  assert.strictEqual(req.url, 'https://api.openai.com/v1/responses');
  assert.strictEqual(req.body.reasoning, undefined); assert.strictEqual(req.body.temperature, undefined);
  state.settings.providers.openai.baseUrl = 'https://api.openai.com/v1';
  state.openaiNoSummary = true;
  req = T.buildRequest('edit', snapFor('openai', { model: 'gpt-6-astra' }));
  assert.strictEqual(req.body.reasoning, undefined);
  state.openaiNoSummary = false;
});

test('buildRequest munin', async () => {
  req = T.buildRequest('edit', snapFor('munin', { baseUrl: 'https://evil.example.com' })); // ignored: Munin's endpoint is fixed
  assert.strictEqual(req.kind, 'chat');
  assert.strictEqual(req.url, 'https://api.muninai.org/v1/chat/completions');
  assert.strictEqual(req.body.persona, 'raw'); assert.strictEqual(req.body.max_tokens, 8192); assert.strictEqual(req.body.temperature, 0.7); // PROVIDERS.munin.sampling
  deq(req.body.stream_options, { include_usage: true });
  assert.strictEqual(req.body.messages[0].role, 'system');
  assert.strictEqual(req.body.messages.length, 8);
  assert.ok(req.body.messages.every((m) => !Object.keys(m).some((k) => k.startsWith('_'))));
  req = T.buildRequest('code', snapFor('munin'));
  assert.strictEqual(req.kind, 'persona'); assert.strictEqual(req.body.persona, 'code'); assert.strictEqual(req.body.stream, undefined);
  assert.ok(JSON.stringify(req.body.messages).includes('Use the document excerpt (inside <document>)')); // Munin persona: the excerpt is embedded
});

test('fitMessages trimming', async () => {
  // --- trimming: tiny budget drops the old turn (and its tool reply), never the newest user message
  const saved = PROVIDERS.munin.contextTokens;
  PROVIDERS.munin.contextTokens = 100;
  const keep = state.messages;
  state.messages = [{ role: 'user', content: 'x'.repeat(40000) }, { role: 'assistant', content: 'y'.repeat(2000) }, ...keep];
  const fit = T.fitMessages('edit', snapFor('munin'));
  assert.ok(fit.trimmed);
  assert.strictEqual(T.toAnthropicMessages(true, fit.history)[0].role, 'user'); // Anthropic needs a user message first
  assert.ok(!fit.history.some((m) => typeof m.content === 'string' && m.content.length > 10000));
  assert.ok(fit.history.some((m) => m.role === 'user' && m.content === 'again'));
  assert.strictEqual(fit.messages[0].role, 'system');
  const unfit = T.fitMessages('edit', snapFor('munin', { contextTokens: 0 })); // settings cannot lower the floor
  assert.ok(unfit.history.length >= 1);
  state.messages = keep;
  PROVIDERS.munin.contextTokens = saved;
  assert.ok(!T.fitMessages('edit', snapFor('munin')).trimmed);
});

test('maxTokens: 32,000 for OpenAI and Anthropic, 8,192 for Munin; the budget subtracts it', async () => {
  // feat/context
  deq([PROVIDERS.munin.maxTokens, PROVIDERS.openai.maxTokens, PROVIDERS.anthropic.maxTokens], [8192, 32000, 32000]);
  assert.ok(!('docCharLimit' in PROVIDERS.openai) && !('docCharLimit' in PROVIDERS.munin));
  assert.strictEqual(T.tokenBudget('edit', snapFor('anthropic')), 200000 - 32000 - 2000);
  assert.strictEqual(T.tokenBudget('edit', snapFor('openai')), 200000 - 32000 - 2000);
  assert.strictEqual(T.tokenBudget('edit', snapFor('munin')), 65536 - 8192 - 2000);
  assert.strictEqual(T.tokenBudget('research', snapFor('munin')), 65536 - 12000 - 4000);
  assert.strictEqual(T.buildRequest('edit', snapFor('munin')).body.max_tokens, 8192);
});

test('in-turn overflow: older reading results of the turn become stubs (all but the last 2), stored messages and replay blocks untouched', async () => {
  // feat/context
  const keep = state.messages;
  const read = (id, start) => ({ id, type: 'function', function: { name: 'read_lines', arguments: JSON.stringify({ start, end: start + 99, doc: null }) } });
  const blocks = [{ type: 'thinking', thinking: 'plan', signature: 'SIG' }, { type: 'tool_use', id: 'r1', name: 'read_lines', input: { start: 1, end: 100, doc: null } }];
  const big = (n) => `Lines ${n}:\n` + 'z'.repeat(4500); // 4,500: the static head (with the writing rules) is about 4,400 tokens
  state.messages = [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'read a lot' },
    { role: 'assistant', content: null, tool_calls: [read('r1', 1)], _anthropicBlocks: blocks },
    { role: 'tool', tool_call_id: 'r1', content: big(1), _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [read('r2', 101)] }, { role: 'tool', tool_call_id: 'r2', content: big(2), _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [read('r3', 201)] }, { role: 'tool', tool_call_id: 'r3', content: big(3), _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [read('r4', 301)] }, { role: 'tool', tool_call_id: 'r4', content: big(4), _ok: true, _reading: true },
  ];
  const stored = JSON.stringify(state.messages);
  const saved = PROVIDERS.munin.contextTokens;
  PROVIDERS.munin.contextTokens = 100; // the 8,000-token floor: 18,000 characters of results do not fit
  const fit = T.fitMessages('edit', snapFor('munin'));
  assert.ok(fit.stubbed);
  const results = fit.history.filter((m) => m.role === 'tool');
  deq(results.map((m) => m.content.slice(0, 12)), ['[read_lines ', '[read_lines ', 'Lines 3:\nzzz', 'Lines 4:\nzzz']);
  assert.strictEqual(results[0].content, '[read_lines 1–100: content omitted to fit the context window; re-read if needed]');
  assert.strictEqual(results[1]._omittedChars, big(2).length);
  assert.ok(fit.history.some((m) => m.content === 'earlier')); // stubbing came first; the older turn still fits
  assert.strictEqual(JSON.stringify(state.messages), stored); // the stored history is not modified
  // Anthropic: the replay blocks of the current turn are sent unchanged
  PROVIDERS.anthropic.contextTokens = 100;
  const areq = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-opus-5-5' }));
  assert.ok(areq.stubbed);
  deq(T.toAnthropicMessages(true, areq.history).find((m) => m.role === 'assistant' && m.content[0].type === 'thinking').content, blocks);
  PROVIDERS.anthropic.contextTokens = 200000;
  // the notice above the input
  T.noteTrim({ stubbed: true, trimmed: true });
  assert.strictEqual(T.el.trimNote.textContent, 'Earlier reading results of this answer were omitted; older messages were trimmed to fit the context window');
  T.noteTrim({ trimmed: true, docCut: true });
  assert.strictEqual(T.el.trimNote.textContent, 'Older messages were trimmed; the document excerpt was shortened to fit the context window');
  // under budget: nothing is stubbed
  PROVIDERS.munin.contextTokens = saved;
  assert.ok(!T.fitMessages('edit', snapFor('munin')).stubbed);
  state.messages = keep;
});

test('buildRequest with a probe history: no tools, only the given messages, the given reply limit', async () => {
  state.docText = 'Line one\nLine two'; state.docFormat = 'text'; state.docError = ''; state.selection = '';
  state.messages = [{ role: 'user', content: 'chat history that must not be sent' }];
  const probe = [{ role: 'user', content: 'Reply with the single word OK.' }];
  const opts = { history: probe, noTools: true, maxTokens: 16 };
  const a = T.buildRequest('manual', snapFor('anthropic', { model: 'claude-haiku-4-5' }), opts);
  assert.strictEqual(a.kind, 'anthropic');
  assert.strictEqual(a.body.tools, undefined);
  assert.strictEqual(a.body.max_tokens, 16);
  deq(a.body.messages.map((m) => m.role), ['user']);
  assert.ok(JSON.stringify(a.body.messages).includes('single word OK'));
  assert.ok(!JSON.stringify(a.body).includes('must not be sent'));
  const o = T.buildRequest('manual', snapFor('openai', { model: 'gpt-4.1' }), opts);
  assert.strictEqual(o.kind, 'responses');
  assert.strictEqual(o.body.tools, undefined);
  assert.strictEqual(o.body.max_output_tokens, 16);
  assert.ok(!JSON.stringify(o.body).includes('must not be sent'));
  const m = T.buildRequest('manual', snapFor('munin'), opts);
  assert.strictEqual(m.kind, 'chat');
  assert.strictEqual(m.body.tools, undefined);
  assert.strictEqual(m.body.max_tokens, 16);
  deq(m.body.messages.map((x) => x.role), ['system', 'user']);
  // without the options the chat history and the tools are sent as before
  const full = T.buildRequest('manual', snapFor('munin'));
  assert.ok(full.body.tools.length > 0);
  assert.ok(JSON.stringify(full.body).includes('must not be sent'));
  assert.strictEqual(full.body.max_tokens, PROVIDERS.munin.maxTokens);
  state.messages = [];
});
