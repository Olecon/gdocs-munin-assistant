'use strict';
// History compaction: the summary request, compacted messages, repeated compaction, the fallback to trimming.
const { test, before } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { deq, load, installDocTab } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let env, T, D, C, state, PROVIDERS, sandbox, storage, chrome, A6, B6, C6, E6, oldHistory, savedCtx, SUMMARY, cBodies,
    ch;
const statusLog = [];

before(async () => {
  env = await load();
  T = D = C = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  sandbox = env.ctx;
  storage = env.storage;
  chrome = env.chrome;
  installDocTab(env);
  await T.refreshContext({ force: true });
});

test('history compaction: one summary request, summary inserted, compacted messages left out, divider; none between tool rounds', async () => {
  // --- history compaction: one summary request, summary inserted, replaced messages flagged and left out
  state.googleConnected = false; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-NEW', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  const bigDoc = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} ` + 'z'.repeat(70)).join('\n');
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: bigDoc, format: 'text', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await D.createChat();
  A6 = 'a'.repeat(9000); B6 = 'b'.repeat(9000); C6 = 'c'.repeat(9000); E6 = 'e'.repeat(9000);
  oldHistory = () => [
    { role: 'user', content: 'First: ' + A6 }, { role: 'assistant', content: B6 },
    { role: 'user', content: 'Second: ' + C6 }, { role: 'assistant', content: E6 },
    { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
  ];
  state.messages.push(...oldHistory());
  await T.saveHistory(); // a turn starts from the stored history
  savedCtx = PROVIDERS.anthropic.contextTokens;
  PROVIDERS.anthropic.contextTokens = 100; // budget: the 8,000-token floor
  SUMMARY = 'The user wants a shorter paper.';
  cBodies = [];
  const cRounds = [textRound(SUMMARY), msgStart + tu(0, 'toolu_big', 'read_lines', { start: 1, end: 300, doc: null }) + stopTool, textRound('Done.')];
  sandbox.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    cBodies.push(b);
    if (b.system === C.COMPACT_PROMPT) statusLog.push(T.el.docStatus.textContent);
    return sseResponse(cRounds[cBodies.length - 1]);
  };
  T.el.input.value = 'new question';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(cBodies.length, 3);
  assert.strictEqual(cBodies.filter((b) => b.system === C.COMPACT_PROMPT).length, 1); // exactly one summary request
  const clip6 = (s) => s.slice(0, 4000) + ` [... ${(s.length - 4000).toLocaleString('en-US')} more characters]`;
  deq(cBodies[0], {
    model: 'claude-opus-5-5', max_tokens: 32000, system: C.COMPACT_PROMPT, stream: true,
    messages: [{ role: 'user', content: `<conversation>\nUser: ${clip6('First: ' + A6)}\n\nAssistant: ${clip6(B6)}\n\nUser: ${clip6('Second: ' + C6)}\n\nAssistant: ${clip6(E6)}\n</conversation>\n\nSummarize the conversation above as instructed.` }],
  });
  deq(statusLog, ['Summarizing the earlier conversation…']);
  assert.ok(C.COMPACT_PROMPT.includes('at most 400 words') && C.COMPACT_PROMPT.includes('Do not copy document text'));
  // the turn's first request: the summary instead of the old turns
  // feat/context: the new message carries its turn context; cache breakpoints on the previous turn's user
  // message and on the last block
  const ctxC = `<document title="My Doc" format="text" lines="300" characters="${bigDoc.length}">\n` +
    '[Outline unavailable: the document could only be exported as plain text. Use find_in_document and read_lines.]\n</document>\n' +
    'Current selection in the document:\n<selection>[Nothing is selected. replace_selection would insert text at the cursor position.]</selection>';
  deq(cBodies[1].messages, [
    { role: 'user', content: [{ type: 'text', text: `[Summary of the earlier conversation]\n${SUMMARY}` }, { type: 'text', text: 'third question', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'third answer' }] },
    { role: 'user', content: [{ type: 'text', text: `${ctxC}\n\nnew question`, cache_control: { type: 'ephemeral' } }] },
  ]);
  // no compaction between tool rounds: the big read makes round 2 over budget, it is trimmed instead
  assert.notStrictEqual(cBodies[2].system, C.COMPACT_PROMPT);
  assert.ok(!cBodies[2].messages.some((m) => m.content.some((c) => c.type === 'text' && c.text.startsWith('[Summary'))));
  assert.ok(cBodies[2].messages[cBodies[2].messages.length - 1].content[0].type === 'tool_result');
  ch = state.messages;
  // not compacted (no compaction cut); feat/context: replaced by a stub when the turn ended (slimHistory)
  assert.ok(ch[9].role === 'tool' && !ch[9]._compacted && ch[9]._omittedChars > 20000 && !ch[9].content.includes('[shortened after compaction]'));
  assert.strictEqual(ch[9].content, '[read_lines 1–300: content omitted after the turn; re-read if needed]');
  deq(ch.map((m) => [m.role, !!m._compacted, !!m._summary]), [
    ['user', true, false], ['assistant', true, false], ['user', true, false], ['assistant', true, false],
    ['user', false, true], ['user', false, false], ['assistant', false, false], ['user', false, false], ['assistant', false, false], ['tool', false, false], ['assistant', false, false],
  ]);
  assert.strictEqual(ch[4].content, `[Summary of the earlier conversation]\n${SUMMARY}`); assert.strictEqual(ch[4]._covers, 4);
  deq(JSON.parse(JSON.stringify(storage['muninChatHistory:DOC123:' + state.chatId])).map((m) => [!!m._compacted, !!m._summary]), ch.map((m) => [!!m._compacted, !!m._summary])); // persisted
  // the chat: a divider row for the summary, the replaced messages dimmed
  T.el.chat.children.length = 0;
  T.renderHistory();
  const divider = T.el.chat.children.find((c) => c.className === 'summary-divider');
  assert.strictEqual(divider.innerHTML, `<summary>Earlier conversation summarized · 4 messages</summary><div class="summary-text">${SUMMARY}</div>`);
  assert.strictEqual(T.el.chat.children.indexOf(divider), 4);
  assert.strictEqual(T.el.chat.children.filter((c) => c.className.includes('compacted')).length, 4);
  assert.ok(T.el.chat.children[5].className.includes('user') && !T.el.chat.children[5].className.includes('compacted'));
});

test('after compaction the next turn fits without another summary', async () => {
  // --- the next turn: no new summary (the request fits); a second compaction covers the first summary
  cBodies = [];
  sandbox.fetch = async (url, init) => { cBodies.push(JSON.parse(init.body)); return sseResponse(textRound('Fine.')); };
  state.messages.splice(0, state.messages.length, ...state.messages.filter((m) => m.role !== 'tool' && !m.tool_calls)); // drop the big read
  T.el.input.value = 'short follow-up';
  await T.sendMessage();
  assert.strictEqual(cBodies.length, 1); assert.notStrictEqual(cBodies[0].system, C.COMPACT_PROMPT);
  assert.ok(cBodies[0].messages[0].content[0].text.startsWith('[Summary of the earlier conversation]'));
});

test('second compaction: covers the first summary and a tool call, the large content stays out, notices kept', async () => {
  // --- a second compaction covers the first summary; tool calls in the dropped part; notices kept
  const toolTurn = [
    { role: 'user', content: 'Fourth: ' + A6 },
    // an edit result: a stored reading result this long would be slimmed when the turn re-reads the chat
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_t4', type: 'function', function: { name: 'insert_after_line', arguments: '{"line":1,"text":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_t4', content: 'Lines 1-2 of 300:\n' + 'q'.repeat(9000), _ok: true },
    { role: 'assistant', content: E6 },
    { role: 'user', content: 'Fifth: ' + C6 }, { role: 'assistant', content: B6 },
  ];
  state.messages.push(...toolTurn);
  await T.saveHistory(); // a turn starts from the stored history
  cBodies = [];
  let noticeSeen = null;
  sandbox.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    cBodies.push(b);
    if (cBodies.length === 2) noticeSeen = T.el.chat.children.some((c) => c.innerHTML === 'Sticky before compaction');
    return sseResponse(textRound(cBodies.length === 1 ? 'Second summary.' : 'OK.'));
  };
  T.el.chat.children.length = 0;
  // like the DOM, innerHTML = '' drops the children during this turn (the stub keeps them otherwise)
  Object.defineProperty(T.el.chat, 'innerHTML', { configurable: true, get() { return ''; }, set(v) { if (v === '') T.el.chat.children.length = 0; } });
  T.addNotice('Sticky before compaction', { sticky: true });
  T.el.input.value = 'sixth question';
  await T.sendMessage();
  delete T.el.chat.innerHTML; T.el.chat.innerHTML = '';
  assert.strictEqual(cBodies.length, 2); assert.strictEqual(cBodies[0].system, C.COMPACT_PROMPT);
  const tr2 = cBodies[0].messages[0].content;
  assert.ok(tr2.startsWith('<conversation>\nSummary of an even earlier part:\nThe user wants a shorter paper.\n\nUser: third question\n\nAssistant: third answer\n\n'));
  assert.ok(tr2.includes('\n\nAssistant called insert_after_line({"line":1,"text":"x"})\n\nTool result: Lines 1-2 of 300:\n' + 'q'.repeat(582) + ' [... 8,418 more characters]\n\n'));
  assert.strictEqual(noticeSeen, true); // the re-render after the compaction kept the notice
  ch = state.messages;
  const s1 = ch.find((m) => m._summary && m.content.endsWith(SUMMARY));
  const s2 = ch.find((m) => m._summary && m.content.endsWith('Second summary.'));
  assert.ok(s1._compacted && !s2._compacted);
  assert.ok(ch.filter((m) => m.tool_call_id === 'call_t4' || (m.tool_calls && m.tool_calls[0].id === 'call_t4')).every((m) => m._compacted));
  deq(cBodies[1].messages[0].content[0].text, '[Summary of the earlier conversation]\nSecond summary.'); // only the newest summary is sent
  assert.ok(!JSON.stringify(cBodies[1].messages).includes('qqqq') && !JSON.stringify(cBodies[1].messages).includes('aaaa'));
});

test('a compacted tool result is shortened in memory and storage after the summary saw it in full', async () => {
  // the compacted tool result is shortened after the summary request (which counted all 9,018 characters
  // above), in memory and in storage; the dimmed display shows the shortened text
  const shortQ = 'Lines 1-2 of 300:\n' + 'q'.repeat(1000 - 18) + '… [shortened after compaction]';
  const qMsg = ch.find((m) => m.tool_call_id === 'call_t4');
  assert.strictEqual(qMsg.content, shortQ); assert.ok(qMsg._compacted && qMsg._ok);
  const storedQ = storage['muninChatHistory:DOC123:' + state.chatId].find((m) => m.tool_call_id === 'call_t4');
  assert.strictEqual(storedQ.content, shortQ);
  deq(vm.runInContext('[COMPACTED_TOOL_KEEP_CHARS, COMPACTED_TOOL_MARKER]', sandbox), [1000, '… [shortened after compaction]']);
});

test('no compaction when the dropped part is small', async () => {
  // --- too little to summarize: trimming only
  await D.createChat();
  state.messages = [{ role: 'user', content: 'x' }];
  let probe = T.takeSnapshot(); T.snapshotDocument(probe);
  const fitProbe = T.fitMessages('edit', probe);
  const baseChars = T.estimateTokens(fitProbe.messages, JSON.stringify(fitProbe.tools).length) * 3; // prompt + tools
  const SMALL_CUR = 24000 - baseChars - 6000 + 1500; // over the 8,000-token budget by ~1,500 characters
  state.messages = [{ role: 'user', content: 'p'.repeat(1500) }, { role: 'assistant', content: 'p'.repeat(1500) },
    { role: 'user', content: 'p'.repeat(1500) }, { role: 'assistant', content: 'p'.repeat(1500) }, { role: 'user', content: 'p'.repeat(SMALL_CUR) }];
  let cs2 = T.takeSnapshot(); T.snapshotDocument(cs2);
  assert.ok(T.fitMessages('edit', cs2).trimmed);
  assert.strictEqual(C.compactionPlan('edit', cs2), null);
});

test('a failed summary request falls back to trimming with a notice, once per chat session', async () => {
  // --- failure: the summary request fails -> old trimming with a notice, nothing flagged
  await D.createChat();
  state.messages.push(...oldHistory());
  await T.saveHistory(); // a turn starts from the stored history
  cBodies = [];
  const retryDelays = vm.runInContext('STREAM_RETRY_DELAYS_MS', sandbox);
  const savedRetryDelays = retryDelays.slice();
  retryDelays.splice(0, retryDelays.length, 5, 5);
  sandbox.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    cBodies.push(b);
    if (b.system === C.COMPACT_PROMPT) return sseResponse(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal error' } }), 500);
    return sseResponse(textRound('Answer.'));
  };
  T.el.chat.children.length = 0;
  T.el.input.value = 'new question';
  await T.sendMessage();
  retryDelays.splice(0, retryDelays.length, ...savedRetryDelays);
  assert.strictEqual(cBodies.length, 4); // the summary request and its two retries, then the turn
  assert.ok(cBodies.slice(0, 3).every((b) => b.system === C.COMPACT_PROMPT));
  cBodies.shift(); cBodies.shift();
  assert.ok(T.el.chat.children.some((c) => c.innerHTML === 'Could not summarize the earlier conversation (API error 500: Internal error); older messages are left out of the request instead for the rest of this chat session.'));
  assert.ok(!state.messages.some((m) => m._compacted || m._summary));
  assert.strictEqual(cBodies[1].messages[0].content[0].text, 'third question'); // trimmed as before
  assert.strictEqual(T.el.trimNote.textContent, 'Older messages were trimmed to fit the context window');
  // back-off: no new attempt (and no new notice) in this chat; a chat switch re-enables compaction
  cBodies = [];
  T.el.chat.children.length = 0;
  state.messages.push(...oldHistory());
  await T.saveHistory(); // a turn starts from the stored history
  T.el.input.value = 'again';
  await T.sendMessage();
  assert.strictEqual(cBodies.length, 1); assert.notStrictEqual(cBodies[0].system, C.COMPACT_PROMPT);
  assert.ok(!T.el.chat.children.some((c) => /Could not summarize/.test(c.innerHTML)));
  assert.strictEqual(state.compactionFailedChat, state.chatId);
  await D.createChat();
  assert.strictEqual(state.compactionFailedChat, null);
});

test('compaction needs two older turns; summary requests for OpenAI and Munin', async () => {
  // --- the plan needs two older turns; summary requests for OpenAI and Munin
  state.messages = [{ role: 'user', content: 'only: ' + A6 + A6 + A6 }, { role: 'assistant', content: B6 + B6 }, { role: 'user', content: 'now' }];
  let cs = T.takeSnapshot(); T.snapshotDocument(cs);
  assert.ok(T.fitMessages('edit', cs).trimmed); assert.strictEqual(C.compactionPlan('edit', cs), null); // one older turn: trimming only
  // an automatic continuation (_auto) inside the older turn does not make it two turns
  state.messages = [{ role: 'user', content: 'only: ' + A6 + A6 + A6 }, { role: 'assistant', content: B6 + B6 },
    { role: 'user', content: T.AUTO_CONTINUE_TEXT, _auto: true }, { role: 'assistant', content: B6 + B6 }, { role: 'user', content: 'now' }];
  cs = T.takeSnapshot(); T.snapshotDocument(cs);
  assert.ok(T.fitMessages('edit', cs).trimmed); assert.strictEqual(C.compactionPlan('edit', cs), null);
  PROVIDERS.anthropic.contextTokens = savedCtx;
  state.settings.provider = 'openai';
  Object.assign(state.settings.providers.openai, { apiKey: 'sk-OPEN', model: 'gpt-6.1-sol' });
  cs = T.takeSnapshot();
  deq(C.buildSummaryRequest(cs, 'User: hi'), {
    kind: 'responses', url: 'https://api.openai.com/v1/responses', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-OPEN' }, tools: [],
    body: { model: 'gpt-6.1-sol', instructions: C.COMPACT_PROMPT, input: [{ role: 'user', content: '<conversation>\nUser: hi\n</conversation>\n\nSummarize the conversation above as instructed.' }],
      max_output_tokens: 32000, stream: true, store: false },
  });
  state.settings.provider = 'munin';
  cs = T.takeSnapshot();
  deq(C.buildSummaryRequest(cs, 'User: hi').body, {
    model: state.settings.providers.munin.model, persona: 'raw', max_tokens: 8192, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: C.COMPACT_PROMPT }, { role: 'user', content: '<conversation>\nUser: hi\n</conversation>\n\nSummarize the conversation above as instructed.' }],
  });
  state.settings.provider = 'anthropic';
});

test('compaction trigger: COMPACT_AT_TOKENS for OpenAI and Anthropic, the context budget for Munin; trimming keeps the full budget', async () => {
  // feat/context
  const snapOf = (prov) => { state.settings.provider = prov; const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
  assert.strictEqual(vm.runInContext('COMPACT_AT_TOKENS', sandbox), 80000);
  assert.strictEqual(C.compactionBudget('edit', snapOf('anthropic')), 80000);
  assert.strictEqual(C.compactionBudget('edit', snapOf('openai')), 80000);
  assert.strictEqual(C.compactionBudget('edit', snapOf('munin')), 65536 - 8192 - 2000);
  assert.strictEqual(T.tokenBudget('edit', snapOf('anthropic')), 200000 - 32000 - 2000); // the hard budget (trimming)
  // a ~100k-token history on Anthropic: compacted, although it fits the context window (no trimming)
  const big = 'w'.repeat(90000);
  state.messages = [
    { role: 'user', content: 'One: ' + big }, { role: 'assistant', content: big },
    { role: 'user', content: 'Two: ' + big }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'three' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'now' },
  ];
  const as = snapOf('anthropic');
  assert.ok(!T.fitMessages('edit', as).trimmed);
  assert.ok(T.fitMessages('edit', as, { budget: C.compactionBudget('edit', as) }).trimmed);
  const plan = C.compactionPlan('edit', as);
  assert.ok(plan && plan.length >= 2 && plan[0].content.startsWith('One: '));
  // the same history on Munin is over its context budget anyway; under 80k tokens on Anthropic: no compaction
  state.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }, { role: 'user', content: 'e'.repeat(60000) }];
  assert.strictEqual(C.compactionPlan('edit', snapOf('anthropic')), null);
  state.settings.provider = 'anthropic';
});

test('estimateTokens counts replay payloads; the request estimate counts those of the current turn', async () => {
  // feat/context
  const blocksOf = (n) => [{ type: 'thinking', thinking: 't'.repeat(n), signature: 'sig' }];
  assert.ok(T.estimateTokens([{ role: 'assistant', content: 'x', _anthropicBlocks: blocksOf(6000) }]) > 2000);
  assert.strictEqual(T.estimateTokens([{ role: 'assistant', content: 'x' }]), 1);
  state.settings.provider = 'anthropic';
  const saved = PROVIDERS.anthropic.contextTokens;
  PROVIDERS.anthropic.contextTokens = 100; // the 8,000-token floor
  const tc = [{ id: 'r1', type: 'function', function: { name: 'read_lines', arguments: '{"start":1,"end":2,"doc":null}' } }];
  const history = (blocks) => [
    { role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: tc, _anthropicBlocks: blocks }, { role: 'tool', tool_call_id: 'r1', content: 'ok' },
  ];
  state.messages = history([]);
  let s = T.takeSnapshot(); T.snapshotDocument(s);
  const fit0 = T.fitMessages('edit', s);
  assert.ok(!fit0.trimmed);
  const baseChars = T.estimateTokens(fit0.messages, JSON.stringify(fit0.tools).length) * 3;
  // a thinking payload that alone pushes the request over the budget: the old turn is trimmed, the payload stays
  const blocks = blocksOf(8000 * 3 - baseChars + 3000);
  state.messages = history(blocks);
  s = T.takeSnapshot(); T.snapshotDocument(s);
  const fit1 = T.fitMessages('edit', s);
  assert.ok(fit1.trimmed);
  deq(fit1.history.map((m) => m.content), ['go', null, 'ok']);
  assert.strictEqual(fit1.history[1]._anthropicBlocks, blocks); // replay blocks are never altered
  PROVIDERS.anthropic.contextTokens = saved;
});
