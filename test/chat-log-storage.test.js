'use strict';
// The full text of a tool result for the chat log copy (_log): kept when slimHistory stubs a reading result or the
// compaction cuts a result, capped at LOG_KEEP_CHARS, kept for the last LOG_KEEP_TURNS turns only, never sent to a
// provider, not counted by estimateTokens, and stable across tabs (a stored history reads back unchanged).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { msgStart, stopTool, textRound, tu } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, oaText, muText } = require('./lib/context');

let env, T, state, doc;
const BIG = ['# Big', '', ...Array.from({ length: 60 }, (_, i) => `Line ${i + 3} with some words in it.`)].join('\n');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

// A finished turn: a user message, one reading call and its result, the answer.
const turn = (i, result, extra = {}) => [
  { role: 'user', content: `question ${i}` },
  { role: 'assistant', content: null, tool_calls: [call(`c${i}`, 'read_lines', { start: 1, end: 40 })] },
  { role: 'tool', tool_call_id: `c${i}`, content: result, _ok: true, _reading: true, ...extra },
  { role: 'assistant', content: `answer ${i}` },
];

test('after a turn: the stubbed reading result keeps its full text in _log, the copy prints it, the next request does not send it', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  doc.text = BIG; doc.selection = '';
  const bodies = recordFetch(env, [
    msgStart + tu(0, 'toolu_l1', 'read_document', { scope: { start: 1, end: 62 }, include: ['text'], doc: null }) + stopTool,
    textRound('Read.'),
  ]);
  await send(env, 'read everything');
  const full = bodies[1].messages[2].content[0].content;
  assert.ok(full.length > 1500);
  const r = state.messages[2];
  assert.strictEqual(r.content, '[read_document lines 1–62: content omitted after the turn; re-read if needed]');
  assert.strictEqual(r._log, full);
  assert.strictEqual(env.storage['muninChatHistory:DOC123:' + state.chatId][2]._log, full); // stored
  const log = T.buildChatLog(state.messages);
  assert.ok(log.includes(`> read_document({"scope":{"start":1,"end":62},"include":["text"]}) → ok\n  ${full.split('\n')[0]}\n`), log);
  assert.ok(log.includes('  62: Line 62 with some words in it.'));
  // token estimation is the same with and without _log
  const without = state.messages.map(({ _log, ...m }) => m);
  assert.strictEqual(T.estimateTokens(state.messages), T.estimateTokens(without));
  // the next request sends the stub, never the kept text
  const next = recordFetch(env, [textRound('OK.')]);
  await send(env, 'and now?');
  const sent = JSON.stringify(next[0]);
  assert.ok(sent.includes('content omitted after the turn') && !sent.includes('Line 40 with some words') && !sent.includes('_log'));
});

for (const [prov, round] of [['openai', oaText('OK.')], ['munin', muText('OK.')], ['anthropic', textRound('OK.')]]) {
  test(`_log never reaches a ${prov} request body`, async () => {
    useProvider(env, prov);
    await T.createChat();
    doc.text = 'Short doc.'; doc.selection = '';
    state.messages.push(...turn(1, 'Lines 1-40 of 40:\n' + 'q'.repeat(3000)));
    state.messages.push(...turn(2, 'C'.repeat(1000) + '… [shortened after compaction]', { _log: 'SECRETLOG' + 'C'.repeat(5000) }));
    T.slimHistory(state.messages);
    assert.ok(state.messages[2]._log.startsWith('Lines 1-40'));
    await T.saveHistory(); // the turn starts from the stored history
    const bodies = recordFetch(env, [round]);
    await send(env, 'next');
    assert.strictEqual(bodies.length, 1);
    const sent = JSON.stringify(bodies[0]);
    assert.ok(sent.includes('[read_lines 1–40: content omitted after the turn; re-read if needed]'), sent.slice(0, 400));
    assert.ok(!sent.includes('qqqqqqqqqq') && !sent.includes('SECRETLOG') && !sent.includes('_log'));
  });
}

test('the kept text is capped at 60,000 characters; the first replacement wins', () => {
  const huge = 'Lines 1-40 of 40:\n' + 'z'.repeat(70000);
  const msgs = turn(1, huge);
  T.slimHistory(msgs);
  assert.strictEqual(msgs[2]._log, huge.slice(0, 60000) + '\n[… cut at 60,000 characters]');
  assert.strictEqual(msgs[2]._omittedChars, huge.length);
  const before = JSON.stringify(msgs);
  assert.strictEqual(T.slimHistory(msgs), 0); // idempotent
  assert.strictEqual(JSON.stringify(msgs), before);
});

test('the compaction cut keeps the full text in _log', () => {
  state.messages = [...turn(1, 'Lines 1-40 of 40:\n' + 'w'.repeat(5000)), { role: 'user', content: 'go on' }];
  state.messages[2]._reading = false; // as an edit result: not stubbed by slimming, cut by the compaction
  const full = state.messages[2].content;
  T.replaceWithSummary(state.messages.slice(0, 4), { role: 'user', content: '[Summary of the earlier conversation]\nS', _summary: true });
  assert.ok(state.messages[2]._compacted && state.messages[2].content.endsWith('[shortened after compaction]'));
  assert.strictEqual(state.messages[2]._log, full);
  assert.ok(T.buildChatLog(state.messages).includes('w'.repeat(5000)));
});

test('_log is kept for the last 20 turns only; panel continuations belong to their turn', () => {
  const msgs = [];
  for (let i = 1; i <= 25; i++) msgs.push(...turn(i, `Lines 1-40 of 40:\n${String(i).repeat(300)}`));
  msgs.splice(msgs.length - 1, 0, { role: 'user', content: 'Continue.', _auto: true, _autoKind: 'continue' });
  T.slimHistory(msgs);
  const kept = msgs.filter((m) => m.role === 'tool').map((m) => typeof m._log === 'string');
  deq(kept, [...Array(5).fill(false), ...Array(20).fill(true)]);
  assert.ok(msgs.filter((m) => m.role === 'tool').every((m) => m._omittedChars > 300)); // the stubs themselves stay
  // the next turn drops the oldest kept one
  msgs.push(...turn(26, 'Lines 1-40 of 40:\n' + 'k'.repeat(300)));
  assert.ok(T.slimHistory(msgs) >= 2);
  deq(msgs.filter((m) => m.role === 'tool').map((m) => typeof m._log === 'string'), [...Array(6).fill(false), ...Array(20).fill(true)]);
});

test('cross-tab: a stored history with _log reads back unchanged, so the panel does not take it for another tab\'s', async () => {
  useProvider(env, 'anthropic');
  await T.createChat();
  const msgs = [];
  for (let i = 1; i <= 22; i++) msgs.push(...turn(i, `Lines 1-40 of 40:\n${'r'.repeat(400)}`));
  T.slimHistory(msgs);
  state.messages.push(...msgs);
  await T.saveHistory();
  const shown = state.messages;
  assert.ok(await T.readChatForTurn('DOC123', state.chatId));
  assert.strictEqual(state.messages, shown); // the same hash: not replaced, not re-rendered
  const a = await T.readStoredHistory('DOC123', state.chatId);
  const b = await T.readStoredHistory('DOC123', state.chatId);
  assert.strictEqual(T.hashValue(a), T.hashValue(shown));
  assert.strictEqual(T.hashValue(a), T.hashValue(b));
  // a history stored before the retention (every turn with _log) is pruned the same way on every read
  const legacy = JSON.parse(JSON.stringify(msgs));
  legacy.forEach((m) => { if (m.role === 'tool') m._log = 'old full text'; });
  env.storage['muninChatHistory:DOC123:' + state.chatId] = legacy;
  const c = await T.readStoredHistory('DOC123', state.chatId);
  const d = await T.readStoredHistory('DOC123', state.chatId);
  assert.strictEqual(T.hashValue(c), T.hashValue(d));
  assert.strictEqual(c.filter((m) => typeof m._log === 'string').length, 20);
});
