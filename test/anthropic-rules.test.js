'use strict';
// Anthropic requests against the API's rules: no disable_parallel_tool_use next to the filtering web search (it runs code
// execution: programmatic tool calling) and the turn loop's one edit per response instead; the 400 that names programmatic
// tool calling sent again with the basic search, remembered for the account's model; a 400 about strict tools or their
// schemas sent again with no strict tool, remembered likewise, and the two fallbacks together; the nudge's forced tool choice only
// where the model and the tools take it; the model lines read from the id; server-side fallbacks; the history-editing
// check (a request that changes what came before leaves out the turn's thinking blocks); refusals and mid-output fallbacks.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor, installDocTab, installIdentity, turnRowTexts } = require('./lib/sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docsBench, ORIGINAL } = require('./lib/fake-docs');

let env, T, state, snapFor, fresh;
let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };

before(async () => {
  env = await load();
  ({ T, state } = env);
  snapFor = makeSnapFor(env);
  const ident = installIdentity(env);
  ({ fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
});

// A new chat on the fake Docs document, Auto, the Anthropic account on model.
async function onDoc(model) {
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'PING' ? { ok: true, title: 'My Doc' } : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true });
  await T.createChat(); // a chat of its own: no earlier turns in the requests or the rows
  await fresh();
  state.applyMode = 'auto'; state.googleConnected = true;
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-anthropic', model });
  T.el.chat.children.length = 0;
}
// One turn; rounds: the SSE text of each model response, or a function returning a response (an HTTP error). Returns the
// request bodies.
async function runTurn(rounds, text = 'Edit it') {
  const bodies = [];
  const docs = env.ctx.fetch;
  env.ctx.fetch = async (url, init) => {
    if (url.startsWith('https://docs.googleapis.com/')) return docs(url, init);
    bodies.push(JSON.parse(init.body));
    const r = rounds[Math.min(bodies.length - 1, rounds.length - 1)];
    return typeof r === 'function' ? r() : sseResponse(r);
  };
  T.el.input.value = text;
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  env.ctx.fetch = docs;
  return bodies;
}
const READ = (n) => ({ scope: { start: n, end: n }, include: ['text'], doc: null });
const srvSearch = (index, id, query) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_search' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }) +
  ev('content_block_stop', { type: 'content_block_stop', index });
const srvResult = (index, id) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: id, content: [] } }) +
  ev('content_block_stop', { type: 'content_block_stop', index });
const thinkBlock = (index, sig) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: sig } }) +
  ev('content_block_stop', { type: 'content_block_stop', index });
const errors = () => T.el.chat.children.filter((c) => c.className && c.className.includes('error')).map((c) => c.innerHTML || c.textContent);
const http400 = (message) => () => sseResponse(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), 400);
const PTC_400 = 'tool_choice.disable_parallel_tool_use: true cannot be used with programmatic tool calling.';
// The last message of a request (the user message after the response before it): its tool results as
// [tool_use_id, is_error, content]; that response is the message before it (lastRound). The chat's earlier turns come first.
const results = (body) => body.messages[body.messages.length - 1].content.filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id, !!b.is_error, b.content]);
const lastRound = (body) => body.messages[body.messages.length - 2];

test('Auto next to the filtering search: no tool_choice (the API refuses disable_parallel_tool_use with programmatic tool calling); edits one at a time elsewhere', async () => {
  await onDoc('claude-opus-5-5');
  for (const model of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-6']) {
    const req = T.buildRequest('edit', snapFor('anthropic', { model }));
    deq(req.body.tools[req.body.tools.length - 1], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    assert.strictEqual(req.body.tool_choice, undefined, model);
    assert.ok(T.anthropicRunsCode(req.body), model);
  }
  // no search (a quiet loop), or the basic search of an older model: edits one at a time, as before
  deq(T.buildRequest('edit', { ...snapFor('anthropic', { model: 'claude-opus-5-5' }), quiet: true }).body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  const old = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-sonnet-4-5' }));
  deq(old.body.tools[old.body.tools.length - 1], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  deq(old.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  // what runs code: the filtering versions and code execution; not the basic search, nor one called directly
  const runs = (type, extra = {}) => T.anthropicRunsCode({ tools: [{ name: 'x' }, { type, name: 'web_search', ...extra }] });
  deq(['web_search_20260209', 'web_fetch_20260209', 'web_search_20260318', 'code_execution_20260120', 'web_search_20250305', 'web_fetch_20250910']
    .map((t) => runs(t)), [true, true, true, true, false, false]);
  assert.strictEqual(runs('web_search_20260209', { allowed_callers: ['direct'] }), false);
});

test('one Anthropic response with two reads: both run, both results in the one user message that follows', async () => {
  await onDoc('claude-opus-5-5');
  const bodies = await runTurn([msgStart + tu(0, 'toolu_r1', 'read_document', READ(2)) + tu(1, 'toolu_r2', 'read_document', READ(4)) + stopTool, textRound('Read.')]);
  assert.strictEqual(bodies.length, 2);
  const r = results(bodies[1]);
  deq(r.map(([id, err]) => [id, err]), [['toolu_r1', false], ['toolu_r2', false]]);
  deq(lastRound(bodies[1]).content.map((b) => b.type), ['tool_use', 'tool_use']);
  assert.ok(r[0][2].includes('2: Intro') && r[1][2].includes('4: Alpha beta gamma.'), JSON.stringify(r));
});

test('one Anthropic response with a read and a write: both run', async () => {
  await onDoc('claude-opus-5-5');
  const bodies = await runTurn([msgStart + tu(0, 'toolu_r', 'read_document', READ(10)) + tu(1, 'toolu_w', 'replace_text', { old_text: 'Last line', new_text: 'Final line' }) + stopTool,
    textRound('Done.')]);
  deq(results(bodies[1]).map(([id, err]) => [id, err]), [['toolu_r', false], ['toolu_w', false]]);
  assert.ok(fake.text('t.0').endsWith('\nFinal line'));
});

test('one Anthropic response with two writes: the first runs, the second is answered with ONE_EDIT_TEXT and has no row', async () => {
  await onDoc('claude-opus-5-5');
  const bodies = await runTurn([
    msgStart + tu(0, 'toolu_w1', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + tu(1, 'toolu_w2', 'replace_text', { old_text: 'Last line', new_text: 'Final line' }) + stopTool,
    msgStart + tu(0, 'toolu_w3', 'replace_text', { old_text: 'Last line', new_text: 'Final line' }) + stopTool,
    textRound('Done.'),
  ]);
  assert.strictEqual(bodies.length, 3);
  const r = results(bodies[1]);
  deq(r.map(([id, err]) => [id, err]), [['toolu_w1', false], ['toolu_w2', true]]);
  assert.strictEqual(r[1][2], T.ONE_EDIT_TEXT);
  assert.strictEqual(r[1][2], 'Not run: only one edit runs per response (an edit can shift line numbers). Send this call again in your next response, with current line numbers if it uses any.');
  const text = fake.text('t.0');
  assert.ok(text.includes('Preface') && text.endsWith('\nFinal line'), text); // the second edit came with the next response
  // the rows: the two edits that ran, nothing for the one that waited (live and after a reload)
  const rowNames = () => T.el.chat.children.flatMap((c) => c._rows || []).map((x) => x.innerHTML).filter((h) => h.includes('replace_text'));
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(rowNames().length, 2);
  assert.ok(!T.el.chat.children.flatMap((c) => c._rows || []).some((x) => /\blog-row fail\b/.test(x.className)));
});

test('a hosted search between two writes: the search blocks go back, the second write waits, every tool_use answered in one message', async () => {
  await onDoc('claude-opus-5-5');
  const turn = runTurn([
    msgStart + tu(0, 'toolu_a', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + srvSearch(1, 'srvtoolu_s', 'lipid rafts') + srvResult(2, 'srvtoolu_s') +
      tu(3, 'toolu_b', 'delete_lines', { start: 9, end: 9 }) + stopTool,
    textRound('Done.'),
  ]);
  // the search taints the turn; in Auto the first write still asks nothing; the second does not get that far
  const bodies = await turn;
  assert.strictEqual(T.pendingPreviews.size, 0);
  deq(lastRound(bodies[1]).content.map((b) => b.type), ['tool_use', 'server_tool_use', 'web_search_tool_result', 'tool_use']);
  deq(results(bodies[1]).map(([id, err, c]) => [id, err, err ? c : 'ok']), [['toolu_a', false, 'ok'], ['toolu_b', true, T.ONE_EDIT_TEXT]]);
  deq(fake.text('t.0').split('\n').length, ORIGINAL.length); // the delete did not run
});

test('a 400 that names programmatic tool calling: sent again once with the basic search (thinking of the turn left out), remembered for the account\'s model', async () => {
  await onDoc('claude-sonnet-5-5');
  const bodies = await runTurn([
    msgStart + thinkBlock(0, 'sigA') + tu(1, 'toolu_r', 'read_document', READ(2)) + stopTool,
    http400(PTC_400),
    textRound('Done.'),
  ], 'Check it');
  assert.strictEqual(bodies.length, 3);
  assert.strictEqual(bodies[1].tools[bodies[1].tools.length - 1].type, 'web_search_20260209');
  assert.strictEqual(lastRound(bodies[1]).content[0].type, 'thinking'); // the refused request replayed the round as it came
  deq(bodies[2].tools[bodies[2].tools.length - 1], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  deq(bodies[2].tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  deq(lastRound(bodies[2]).content.map((b) => b.type), ['tool_use']); // the tools changed: the earlier thinking would fail the check
  assert.ok(turnRowTexts(T.el.chat).includes(T.BASIC_SEARCH_ROW));
  assert.strictEqual(T.BASIC_SEARCH_ROW, 'The API refused web search with filtering for this model; the request was sent again with the basic web search.');
  deq(errors(), []);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Done.');
  // the next turn starts with the basic search; another model of the account still gets the filtering one
  const next = await runTurn([textRound('Ok.')], 'Again');
  assert.strictEqual(next[0].tools[next[0].tools.length - 1].type, 'web_search_20250305');
  assert.strictEqual(T.buildRequest('edit', snapFor('anthropic', { model: 'claude-opus-5-5' })).body.tools.slice(-1)[0].type, 'web_search_20260209');
});

test('a 400 that names programmatic tool calling without a tool that runs code is the plain error (sent once)', async () => {
  await onDoc('claude-sonnet-4-5');
  const bodies = await runTurn([http400(PTC_400), textRound('never')]);
  assert.strictEqual(bodies.length, 1);
  deq(errors(), ['The request was malformed: tool_choice.disable_parallel_tool_use: true cannot be used with programmatic tool calling.']);
});

// The 400s about strict tools or their schemas: the documented ones and the owner's ("Too many strict tools"), a schema
// feature, a model or organization without structured outputs, strict next to programmatic tool calling. Each on a model
// of its own: the choice is remembered per account and model.
const STRICT_400S = [
  ['claude-sonnet-4-6', 'Too many strict tools (31). The maximum number of strict tools supported is 20. Try reducing the number of tools marked as strict.'],
  ['claude-opus-4-8', 'Schema is too complex for compilation.'],
  ['claude-opus-4-7', "tools.4.custom.input_schema: For 'number' type, property 'minimum' is not supported"],
  ['claude-mythos-5-2', 'Structured outputs are not available for this model in your organization.'],
  ['claude-sonnet-5', 'Tools with strict: true are not supported with programmatic calling.'],
];
const hasStrict = (body) => body.tools.some((t) => 'strict' in t);
const allCompact = (body) => body.tools.filter((t) => t.input_schema).every((t) => !('strict' in t) && deqOk(t.input_schema, T.compactSchema(T.TOOL_DEFS[t.name] ? T.TOOL_DEFS[t.name].function.parameters : t.input_schema)));
const deqOk = (a, b) => { try { deq(a, b); return true; } catch (e) { return false; } };
// How often the chat's stored turn rows (a message's _notes) say text.
const storedRows = (text) => state.messages.flatMap((m) => m._notes || []).filter((n) => (typeof n === 'string' ? n : n.text) === text).length;

test('a 400 about strict tools or their schemas: sent again once with no strict tool, remembered for the account\'s model, one row', async () => {
  for (const [model, message] of STRICT_400S) {
    await onDoc(model);
    const bodies = await runTurn([msgStart + thinkBlock(0, 'sigS') + tu(1, 'toolu_r', 'read_document', READ(2)) + stopTool, http400(message), textRound('Done.')], 'Check it');
    assert.strictEqual(bodies.length, 3, model);
    assert.ok(bodies[1].tools.some((t) => t.strict === true), model);
    assert.ok(!hasStrict(bodies[2]) && allCompact(bodies[2]), model);
    deq(bodies[2].tools.slice(-1), bodies[1].tools.slice(-1)); // the search tool as before
    // the tools changed: a model with the history-editing check gets the turn's thinking left out
    deq(lastRound(bodies[2]).content.map((b) => b.type), T.anthropicChecksHistory(model) ? ['tool_use'] : ['thinking', 'tool_use'], model);
    assert.ok(turnRowTexts(T.el.chat).includes(T.STRICT_TOOLS_ROW), model);
    assert.strictEqual(storedRows(T.STRICT_TOOLS_ROW), 1, model);
    deq(errors(), [], model);
    assert.strictEqual(state.messages[state.messages.length - 1].content, 'Done.');
    // the next turn starts without strict tools, and without another row; another model of the account keeps them
    const next = await runTurn([textRound('Ok.')], 'Again');
    assert.strictEqual(next.length, 1);
    assert.ok(!hasStrict(next[0]) && allCompact(next[0]), model);
    assert.strictEqual(storedRows(T.STRICT_TOOLS_ROW), 1, model);
  }
  assert.ok(hasStrict(T.buildRequest('edit', snapFor('anthropic', { model: 'claude-opus-5-5' })).body));
  assert.strictEqual(T.STRICT_TOOLS_ROW, 'The API refused the strict tool schemas for this model; the request was sent again with plain ones.');
});

test('the two fallbacks compose: a strict 400, then a 400 of programmatic tool calling (and the other way round), each once', async () => {
  // models no later test sends a request with (the choices last for the session)
  for (const [model, order] of [['claude-mythos-5-1', ['strict', 'ptc']], ['claude-fable-5', ['ptc', 'strict']]]) {
    await onDoc(model);
    const refusal = { strict: http400('Schema is too complex for compilation.'), ptc: http400(PTC_400) };
    const bodies = await runTurn([refusal[order[0]], refusal[order[1]], textRound('Done.')]);
    assert.strictEqual(bodies.length, 3, model);
    assert.ok(hasStrict(bodies[0]) && bodies[0].tools.slice(-1)[0].type === 'web_search_20260209', model);
    const last = bodies[2];
    assert.ok(!hasStrict(last) && allCompact(last), model);
    deq(last.tools.slice(-1)[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    deq(last.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    deq([T.STRICT_TOOLS_ROW, T.BASIC_SEARCH_ROW].map(storedRows), [1, 1], model);
    deq(errors(), [], model);
  }
});

test('a 400 of another kind, or a second strict 400, reaches the user unchanged', async () => {
  await onDoc('claude-haiku-4-5');
  const other = 'messages.1.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_x.';
  let bodies = await runTurn([http400(other), textRound('never')]);
  assert.strictEqual(bodies.length, 1);
  assert.ok(hasStrict(bodies[0]));
  deq(errors(), [`The request was malformed: ${other}`]);
  assert.ok(!turnRowTexts(T.el.chat).includes(T.STRICT_TOOLS_ROW));
  // the strict refusal again on the request already sent without strict tools: the error, sent once more only
  await onDoc('claude-haiku-4-5');
  const again = 'Schema is too complex for compilation.';
  bodies = await runTurn([http400(again), http400(again), textRound('never')]);
  assert.strictEqual(bodies.length, 2);
  assert.ok(hasStrict(bodies[0]) && !hasStrict(bodies[1]));
  deq(errors(), [`The request was malformed: ${again}`]);
  // OpenAI's 400 that names strict is not Anthropic's case
  assert.strictEqual(T.anthropicStrictRefused({ status: 400, serverMessage: again }, { kind: 'openai', body: { tools: [{ strict: true }] } }, {}), false);
});

test('the model lines from the id: adaptive thinking, forced tool choice, the history-editing check', () => {
  // [id, adaptive, forced tool choice accepted, history-editing check]
  const rows = [
    ['claude-fable-5-2', true, false, true], ['claude-mythos-5-2', true, false, true], ['claude-fable-5-1', true, false, true],
    ['claude-mythos-5-1', true, false, true], ['claude-fable-5', true, true, false], ['claude-mythos-5', true, true, false],
    ['claude-opus-5-5', true, false, true], ['claude-opus-5', true, true, false], ['claude-opus-4-8', true, true, false],
    ['claude-opus-4-7', true, true, false], ['claude-opus-4-6', true, true, false], ['claude-sonnet-5-5', true, false, true],
    ['claude-sonnet-5', true, true, false], ['claude-sonnet-4-6', true, true, false], ['claude-haiku-5-5', true, true, true],
    ['claude-haiku-4-5', false, true, false], ['claude-haiku-4-5-20251001', false, true, false], ['claude-sonnet-4-20250514', false, true, false],
    ['claude-sonnet-4-5', false, true, false], ['claude-opus-5-5-20261101', true, false, true], ['claude-fable-5-20260601', true, true, false],
    ['claude-opus-6', true, false, true], ['claude-mythos-preview', false, true, false], ['claude-3-7-sonnet-20250219', false, true, false], ['', false, true, false],
  ];
  deq(rows.map(([id]) => [id, T.anthropicAdaptive(id), T.anthropicForcedToolOk(id), T.anthropicChecksHistory(id)]), rows);
});

test('the nudge forces a tool call only where the model and the tools take it; elsewhere the message alone asks', async () => {
  await onDoc('claude-opus-5-5');
  // a tool round of this turn from another provider (no thinking to go back with): the request has no thinking field
  const foreign = [{ role: 'user', content: 'Fix it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_document', arguments: JSON.stringify(READ(2)) } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '2: Intro', _ok: true }];
  const nudged = (model, extra = {}) => {
    const req = T.requireToolCall(T.buildRequest('edit', { ...snapFor('anthropic', { model }), ...extra }, { history: foreign }));
    assert.strictEqual(req.body.thinking, undefined, model);
    return req.body.tool_choice;
  };
  assert.strictEqual(nudged('claude-opus-5-5'), undefined); // forced tool choice is a 400 on Opus 5.5
  deq(nudged('claude-fable-5-2', { quiet: true }), { type: 'auto', disable_parallel_tool_use: true }); // the request's own: no "any"
  assert.strictEqual(nudged('claude-opus-5'), undefined); // the filtering search runs code: the 400 of programmatic tool calling
  deq(nudged('claude-opus-5', { quiet: true }), { type: 'any', disable_parallel_tool_use: true }); // no search: as before
  deq(nudged('claude-haiku-5-5', { quiet: true }), { type: 'any', disable_parallel_tool_use: true });
  deq(nudged('claude-sonnet-4-5'), { type: 'any', disable_parallel_tool_use: true }); // the basic search
});

test('server-side fallbacks: claude-fable-5-2 and the other models that take "default"; not Haiku 5.5', async () => {
  await onDoc('claude-opus-5-5');
  for (const model of ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']) {
    const req = T.buildRequest('edit', snapFor('anthropic', { model }));
    assert.strictEqual(req.body.fallbacks, 'default', model);
    assert.strictEqual(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', model);
  }
  const haiku = T.buildRequest('edit', snapFor('anthropic', { model: 'claude-haiku-5-5' }));
  assert.strictEqual(haiku.body.fallbacks, undefined); assert.strictEqual(haiku.headers['anthropic-beta'], undefined);
});

test('the history-editing check: a request that changes what came before leaves out the turn\'s thinking blocks for the rest of the turn', async () => {
  await onDoc('claude-fable-5-2');
  const long = 'Line text. '.repeat(40); // a reading result long enough to become a stub
  const round = (n) => ({ role: 'assistant', content: '', tool_calls: [{ id: `toolu_${n}`, type: 'function', function: { name: 'read_document', arguments: JSON.stringify(READ(n)) } }],
    _anthropicBlocks: [{ type: 'thinking', thinking: '', signature: `sig${n}` }, { type: 'tool_use', id: `toolu_${n}`, name: 'read_document', input: READ(n) }] });
  const result = (n) => ({ role: 'tool', tool_call_id: `toolu_${n}`, content: long + n, _ok: true });
  const h2 = [{ role: 'user', content: 'Check it' }, round(1), result(1), round(2), result(2)];
  const h3 = [...h2, round(3), result(3)];
  const h4 = [...h3, round(4), result(4)];
  const sigs = (body) => body.messages.flatMap((m) => m.content).filter((b) => b.type === 'thinking').map((b) => b.signature);
  const snap = snapFor('anthropic', { model: 'claude-fable-5-2' });
  deq(sigs(T.buildRequest('edit', snap, { history: h2 }).body), ['sig1', 'sig2']); // appended rounds: every block goes back
  deq(sigs(T.buildRequest('edit', snap, { history: h3 }).body), ['sig1', 'sig2', 'sig3']);
  // the resend after "too long": the turn's reading results become stubs, under sig2 and sig3: no thinking block goes back
  const stubbed = T.buildRequest('edit', snap, { history: h3, stubAll: true }).body;
  deq(sigs(stubbed), []);
  assert.ok(stubbed.messages[2].content[0].content.includes('content omitted'));
  deq(stubbed.messages[1].content.map((b) => b.type), ['tool_use']); // the rest of the round stays
  // the next round: the earlier blocks stay out, its own goes back
  deq(sigs(T.buildRequest('edit', snap, { history: h4, stubAll: true }).body), ['sig4']);
  // a model without the check keeps its blocks
  const opus5 = snapFor('anthropic', { model: 'claude-opus-5' });
  T.buildRequest('edit', opus5, { history: h3 });
  deq(sigs(T.buildRequest('edit', opus5, { history: h3, stubAll: true }).body), ['sig1', 'sig2', 'sig3']);
});

test('a refusal with a tool call in it: the call is not run, the decline is the error', async () => {
  await onDoc('claude-opus-5-5');
  const refusal = ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 2 } }) +
    ev('message_stop', { type: 'message_stop' });
  const bodies = await runTurn([msgStart + tu(0, 'toolu_x', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + refusal, textRound('never')]);
  assert.strictEqual(bodies.length, 1);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  assert.ok(!state.messages.some((m) => m.role === 'tool'));
  deq(errors(), ['Anthropic (Claude) declined this request (safety classifier: cyber). Nothing was changed.']);
});

test('a fallback in the middle of the output: the declined model\'s calls are not run, and its thinking and calls do not go back', async () => {
  await onDoc('claude-opus-5-5');
  const block = (index, content_block) => ev('content_block_start', { type: 'content_block_start', index, content_block }) + ev('content_block_stop', { type: 'content_block_stop', index });
  const text = (index, t) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }) + ev('content_block_stop', { type: 'content_block_stop', index });
  const sse = msgStart + text(0, 'Partial. ') + thinkBlock(1, 'sigOld') + tu(2, 'toolu_old', 'replace_text', { old_text: 'Intro', new_text: 'X' }) +
    srvSearch(3, 'srvtoolu_open', 'q') + srvSearch(4, 'srvtoolu_done', 'q2') + srvResult(5, 'srvtoolu_done') +
    block(6, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }) + text(7, 'Continued.') +
    tu(8, 'toolu_new', 'read_document', READ(2)) + stopTool;
  env.ctx.fetch = async () => sseResponse(sse);
  const snap = snapFor('anthropic', { model: 'claude-opus-5-5' });
  const r = await T.streamAnthropic(T.buildRequest('edit', snap), new AbortController().signal, snap, {});
  deq(r.toolCalls.map((c) => c.id), ['toolu_new']);
  assert.strictEqual(r.finishReason, 'tool_calls');
  deq(r.raw.items.map((b) => b.type + (b.id ? ':' + b.id : '')), ['text', 'server_tool_use:srvtoolu_done', 'web_search_tool_result', 'fallback', 'text', 'tool_use:toolu_new']);
});
