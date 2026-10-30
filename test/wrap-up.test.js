'use strict';
// The round limit of a turn (toolLoop): after MAX_TOOL_ITERATIONS rounds of tool calls the calls of the next response
// are dropped, one more request without tools asks for a wrap-up (WRAP_UP_TEXT, _auto with _autoKind 'wrap-up') and its
// answer ends the turn; a notice offers Continue, which sends CONTINUE_TEXT once through the Send path. The wrap-up
// request carries no tool call, result, reasoning item or thinking block; after the turn the request leaves the history
// and the answer is marked _wrapUp (the fold and the summary transcript note it). /side keeps the old notice.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { ev, msgStart, tu, stopTool, textRound, sseResponse } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');
const { docBench, recordFetch, useProvider, send, muTool, muText } = require('./lib/context');

let env, T, state, doc;
const LIMIT = 12;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nFirst.\n\nSecond.';
  await T.refreshContext({ force: true });
});

async function fresh(prov) {
  useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
  await T.createChat();
  T.el.chat.children.length = 0;
}
// LIMIT + 1 responses with a reading call each (the last one is not executed), then the wrap-up answer.
const muRounds = (answer) => [...Array.from({ length: LIMIT + 1 }, (_, i) => muTool('c' + i, 'get_outline', {})), muText(answer)];
// Anthropic tool rounds with a thinking block (replayed verbatim inside the turn).
const anTool = (i) => msgStart +
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan ' + i } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' + i } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  tu(1, 'toolu_' + i, 'get_outline', {}) + stopTool;
const continueRow = () => T.el.chat.children.find((c) => c.className.includes('notice') && c.children.some((b) => b.dataset && b.dataset.act === 'continue-turn'));
// Every tool_use of an Anthropic body is answered by a tool_result in the next (user) message, and the tools are defined.
function validAnthropic(body) {
  const msgs = body.messages;
  assert.strictEqual(msgs[0].role, 'user');
  msgs.forEach((m, i) => {
    if (i) assert.notStrictEqual(m.role, msgs[i - 1].role, 'roles alternate');
    const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!uses.length) return;
    assert.ok(body.tools && body.tools.length, 'tools defined for a tool_use');
    const next = msgs[i + 1];
    assert.ok(next && next.role === 'user', 'a user message follows the tool_use');
    const results = next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    for (const id of uses) assert.ok(results.includes(id), 'tool_result for ' + id);
  });
}

test('Munin: the wrap-up request has no tools and its answer ends the turn; the Continue notice follows', async () => {
  await fresh('munin');
  assert.strictEqual(T.MAX_TOOL_ITERATIONS, LIMIT);
  const bodies = recordFetch(env, muRounds('I read the outline; nothing is left.'));
  await send(env, 'Read a lot');
  assert.strictEqual(bodies.length, LIMIT + 2);
  const wrap = bodies[LIMIT + 1];
  assert.strictEqual(wrap.tools, undefined);
  assert.ok(!wrap.messages.some((m) => m.role === 'tool' || m.tool_calls), 'no tool call or result in the wrap-up request');
  assert.deepStrictEqual(wrap.messages[wrap.messages.length - 1], { role: 'user', content: T.WRAP_UP_TEXT });
  assert.strictEqual(T.WRAP_UP_TEXT, 'You have used the tool budget of this message. Without calling tools, say in a few sentences what you did, what you verified and what is left to do.');
  // the stored turn: 12 executed rounds, the 13th response without its calls, the answer marked _wrapUp; the request is gone
  const h = state.messages;
  const last = h[h.length - 1];
  assert.strictEqual(last.content, 'I read the outline; nothing is left.');
  assert.strictEqual(last._wrapUp, true);
  assert.ok(!h.some((m) => m._autoKind), 'the wrap-up request left the history');
  assert.strictEqual(h.filter((m) => m.role === 'tool').length, LIMIT);
  const ids = new Set(h.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const m of h) for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id), 'every stored call has its result');
  // the notice with its button, after the final re-render; no old "Stopped after" notice
  const row = continueRow();
  assert.ok(row, 'the Continue notice');
  assert.ok(row.innerHTML.includes(T.WRAP_UP_NOTICE));
  assert.ok(!T.el.chat.children.some((c) => String(c.innerHTML).includes('tool rounds in a row')));
});

test('Continue sends "Continue with the remaining steps." once, as a normal message of the chat', async () => {
  await fresh('munin');
  recordFetch(env, muRounds('Summary.'));
  await send(env, 'Do it all');
  const btn = continueRow().children.find((b) => b.dataset.act === 'continue-turn');
  const bodies = recordFetch(env, [muText('Going on.')]);
  T.el.input.value = 'my draft';
  await T.continueFromButton(btn);
  await T.continueFromButton(btn); // a second click: the button is disabled
  assert.strictEqual(bodies.length, 1);
  const users = state.messages.filter((m) => m.role === 'user' && !m._auto && !m._summary);
  assert.strictEqual(users[users.length - 1].content, T.CONTINUE_TEXT);
  assert.strictEqual(users.filter((m) => m.content === T.CONTINUE_TEXT).length, 1);
  assert.ok(users[users.length - 1]._context, 'a normal turn: with its turn context');
  assert.strictEqual(T.el.input.value, 'my draft', 'the draft in the input box is left alone');
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Going on.');
  // while a turn runs, Continue is queued like a typed message
  state.busy = true;
  try {
    const row = T.addContinueNotice();
    await T.continueFromButton(row.children[0]);
    assert.strictEqual(state.queued.text, T.CONTINUE_TEXT);
  } finally {
    state.busy = false;
    T.discardQueued();
  }
});

test('Anthropic: the wrap-up request has no tools, no tool blocks and no thinking; the next turn replays a valid history', async () => {
  await fresh('anthropic');
  const bodies = recordFetch(env, [...Array.from({ length: LIMIT + 1 }, (_, i) => anTool(i)), textRound('Done reading.')]);
  await send(env, 'Look around');
  assert.strictEqual(bodies.length, LIMIT + 2);
  for (const b of bodies.slice(0, LIMIT + 1)) validAnthropic(b);
  const wrap = bodies[LIMIT + 1];
  assert.strictEqual(wrap.tools, undefined);
  assert.strictEqual(wrap.tool_choice, undefined);
  const blocks = wrap.messages.flatMap((m) => m.content);
  assert.ok(!blocks.some((b) => ['tool_use', 'tool_result', 'thinking'].includes(b.type)), JSON.stringify(blocks.map((b) => b.type)));
  validAnthropic(wrap);
  const lastMsg = wrap.messages[wrap.messages.length - 1];
  assert.strictEqual(lastMsg.content[lastMsg.content.length - 1].text, T.WRAP_UP_TEXT);
  // the next turn: the stored history (12 calls with their results, the answers) replays as a valid request
  const next = recordFetch(env, [textRound('OK.')]);
  await send(env, 'Thanks');
  validAnthropic(next[0]);
  assert.strictEqual(next[0].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').length, LIMIT);
});

test('Stop during the wrap-up: the turn ends stopped, no Continue notice, no call without its result', async () => {
  await fresh('munin');
  const stream = liveStream();
  let n = 0;
  const rounds = muRounds('never');
  env.ctx.fetch = async (url, init) => {
    JSON.parse(init.body);
    if (n++ < LIMIT + 1) return sseResponse(rounds[n - 1]);
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  T.el.input.value = 'Read on';
  const turn = T.sendMessage();
  for (let i = 0; i < 400 && stream.reads === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(stream.reads > 0, 'the wrap-up request started');
  state.abort.abort();
  await turn;
  assert.ok(!continueRow(), 'no Continue after Stop');
  assert.ok(!state.messages.some((m) => m._autoKind), 'the wrap-up request left the history');
  const ids = new Set(state.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const m of state.messages) for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id));
  assert.ok(T.el.chat.children.some((c) => String(c.innerHTML).includes('Stopped.')));
});

test('/side keeps the old behaviour at the round limit: the sticky notice, no wrap-up request', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, muRounds('never'));
  await send(env, '/side what is in it?');
  assert.strictEqual(bodies.length, LIMIT + 1);
  assert.ok(T.el.chat.children.some((c) => String(c.innerHTML).includes(`Stopped after ${LIMIT} tool rounds in a row.`)));
  assert.ok(!continueRow());
});

test('fold and summary transcript: the wrap-up shows as a note, never as a user line', async () => {
  const msgs = [
    { role: 'user', content: 'Check all sections' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'get_outline', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a1', content: '3 headings', _ok: true },
    { role: 'assistant', content: 'Checked two of three sections; the third is left.', _wrapUp: true },
  ];
  const fold = T.foldText(msgs);
  assert.ok(fold.includes('[The tool budget of this message ran out; the assistant summarized what was done and what is left.]'), fold);
  assert.ok(!fold.includes(T.WRAP_UP_TEXT));
  assert.strictEqual(fold.split('\n').filter((l) => l.startsWith('User:')).length, 1);
  const transcript = T.compactionTranscript(msgs, 'edit', T.takeSnapshot());
  assert.ok(transcript.includes('[The tool budget of this message ran out;'), transcript);
  assert.strictEqual(transcript.split('\n').filter((l) => l.startsWith('User:')).length, 1);
  // while its turn runs (not settled yet), the request itself shows as the same note
  const running = [msgs[0], msgs[1], msgs[2], { role: 'user', content: T.WRAP_UP_TEXT, _auto: true, _autoKind: 'wrap-up' }, { ...msgs[3], _wrapUp: undefined }];
  const fold2 = T.foldText(running);
  assert.ok(fold2.includes('[The tool budget of this message ran out;'));
  assert.ok(!fold2.includes(T.WRAP_UP_TEXT));
});
