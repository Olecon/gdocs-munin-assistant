'use strict';
// The round limit of a turn (toolLoop): after MAX_TOOL_ITERATIONS rounds of tool calls the calls of the next response
// are dropped, one more request without tools asks for a wrap-up (WRAP_UP_TEXT, _auto with _autoKind 'wrap-up') and its
// answer ends the turn; a row of the turn (WRAP_UP_NOTICE, stored on the answer) offers Continue while the answer is the
// chat's last message, which sends CONTINUE_TEXT once through the Send path. The wrap-up request carries no tool call,
// result, reasoning item or thinking block; after the turn the request leaves the history and the answer is marked
// _wrapUp (the fold and the summary transcript note it). /side keeps the old row "Stopped after N tool rounds".
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, turnRowTexts } = require('./lib/sandbox');
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
// LIMIT + 1 responses with a reading call each (the last one is not executed), then the wrap-up answer. Calls that
// succeed and differ: a failing one repeated would end the rounds after its 3rd failure (noteRepeatFailure), an identical
// read after its 3rd repeat (readAgain).
const muRounds = (answer) => [...Array.from({ length: LIMIT + 1 }, (_, i) => muTool('c' + i, 'find_in_document', { query: 'q' + i })), muText(answer)];
const FOUND = (i) => `[find_in_document(query="q${i}"): ok]`;
// Anthropic tool rounds with a thinking block (replayed verbatim inside the turn).
const anTool = (i) => msgStart +
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan ' + i } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' + i } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  tu(1, 'toolu_' + i, 'find_in_document', { query: 'q' + i }) + stopTool;
// The wrap-up row with its Continue button (a row of the turn's bubble) and the button.
const continueBtn = (row) => row.children.flatMap((k) => k.children || []).find((b) => b.dataset && b.dataset.act === 'continue-turn');
const continueRow = () => T.el.chat.children.flatMap((c) => c._notes || []).find((n) => continueBtn(n));
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

test('Munin: the wrap-up request has no tools and its answer ends the turn; the Continue row follows', async () => {
  await fresh('munin');
  assert.strictEqual(T.MAX_TOOL_ITERATIONS, LIMIT);
  const bodies = recordFetch(env, muRounds('I read the outline; nothing is left.'));
  await send(env, 'Read a lot');
  assert.strictEqual(bodies.length, LIMIT + 2);
  const wrap = bodies[LIMIT + 1];
  assert.strictEqual(wrap.tools, undefined);
  assert.ok(!wrap.messages.some((m) => m.role === 'tool' || m.tool_calls), 'no tool call or result in the wrap-up request');
  // the calls of the turn as text (the request has no tool messages): one line each, the last four with their result
  const sent = wrap.messages[wrap.messages.length - 1];
  assert.strictEqual(sent.role, 'user');
  const lines = sent.content.split('\n');
  assert.strictEqual(lines[0], T.WRAP_UP_TEXT);
  assert.strictEqual(lines[1], `Your tool calls since the user's last message (${LIMIT}), the last results clipped:`);
  assert.strictEqual(lines.length, LIMIT + 2);
  lines.slice(2, LIMIT - 2).forEach((l, i) => assert.strictEqual(l, FOUND(i)));
  lines.slice(LIMIT - 2).forEach((l, i) => assert.strictEqual(l, `${FOUND(LIMIT - 4 + i)} No line contains "q${LIMIT - 4 + i}".`));
  // a state, not an instruction to narrate ("Without calling tools" came back as "I used no tools in this message")
  assert.strictEqual(T.WRAP_UP_TEXT, 'The tool budget for the user\'s last message is used up. Answer the user now: what was done, what was checked and what is left; say nothing about tools or budgets.');
  // the stored turn: 12 executed rounds, the 13th response without its calls, the answer marked _wrapUp; the request is gone
  const h = state.messages;
  const last = h[h.length - 1];
  assert.strictEqual(last.content, 'I read the outline; nothing is left.');
  assert.strictEqual(last._wrapUp, true);
  assert.ok(!h.some((m) => m._autoKind), 'the wrap-up request left the history');
  assert.strictEqual(h.filter((m) => m.role === 'tool').length, LIMIT);
  const ids = new Set(h.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const m of h) for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id), 'every stored call has its result');
  // the row with its button, stored on the answer and drawn by the final re-render; no "Stopped after N tool rounds" row
  deq(last._notes, [{ text: T.WRAP_UP_NOTICE, act: 'continue' }]);
  const row = continueRow();
  assert.ok(row, 'the Continue row');
  assert.strictEqual(row._text, T.WRAP_UP_NOTICE);
  assert.strictEqual(T.WRAP_UP_NOTICE, 'Tool budget reached.');
  assert.ok(!turnRowTexts(T.el.chat).some((t) => t.includes('tool rounds in a row')));
  // drawn again while the answer is the chat's last message: the button too; after the next message: the text alone
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.ok(continueRow());
  state.messages.push({ role: 'user', content: 'later' });
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.ok(!continueRow());
  assert.ok(turnRowTexts(T.el.chat).includes(T.WRAP_UP_NOTICE));
  state.messages.pop();
});

test('Continue sends "Continue with the remaining steps." once, as a normal message of the chat', async () => {
  await fresh('munin');
  recordFetch(env, muRounds('Summary.'));
  await send(env, 'Do it all');
  const btn = continueBtn(continueRow());
  const bodies = recordFetch(env, [muText('Going on.')]);
  T.el.input.value = 'my draft';
  state.applyMode = 'manual'; // the mode button changed after the wrap-up: Continue keeps the turn's own mode (Auto)
  await T.continueFromButton(btn);
  await T.continueFromButton(btn); // a second click: the button is disabled
  assert.strictEqual(bodies.length, 1);
  const users = state.messages.filter((m) => m.role === 'user' && !m._auto && !m._summary);
  assert.strictEqual(users[users.length - 1].content, T.CONTINUE_TEXT);
  deq([users[users.length - 1]._mode, users[users.length - 1]._asks], ['edit', undefined]);
  assert.strictEqual(users.filter((m) => m.content === T.CONTINUE_TEXT).length, 1);
  assert.ok(users[users.length - 1]._context, 'a normal turn: with its turn context');
  assert.strictEqual(T.el.input.value, 'my draft', 'the draft in the input box is left alone');
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Going on.');
  // while a turn runs, Continue is queued like a typed message
  state.busy = true;
  try {
    await T.continueFromButton({ disabled: false, closest: () => null }); // a fresh button of the row
    deq([state.queued.text, state.queued.mode], [T.CONTINUE_TEXT, 'auto']);
  } finally {
    state.busy = false;
    T.discardQueued();
    state.applyMode = 'auto';
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
  assert.ok(lastMsg.content[lastMsg.content.length - 1].text.startsWith(`${T.WRAP_UP_TEXT}\nYour tool calls since the user's last message (${LIMIT}), the last results clipped:\n${FOUND(0)}`));
  // the next turn: the stored history (12 calls with their results, the answers) replays as a valid request
  const next = recordFetch(env, [textRound('OK.')]);
  await send(env, 'Thanks');
  validAnthropic(next[0]);
  assert.strictEqual(next[0].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').length, LIMIT);
});

test('Stop during the wrap-up: the turn ends stopped, no Continue row, no call without its result', async () => {
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
  assert.ok(T.el.chat.children.some((c) => c._parts && /^Stopped after /.test(c._parts.label.textContent)));
});

test('/side keeps the old behaviour at the round limit: the row of the turn, no wrap-up request', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, muRounds('never'));
  await send(env, '/side what is in it?');
  assert.strictEqual(bodies.length, LIMIT + 1);
  assert.ok(turnRowTexts(T.el.chat).includes(`Stopped after ${LIMIT} tool rounds in a row.`));
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

// The wrap-up text lists the turn's calls: a failure is marked, a long result clipped, an undone edit noted, older calls
// beyond WRAP_UP_CALLS_MAX left out with the count.
test('turnCallsText: one line per call, the last results clipped, failures marked', () => {
  const c = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const msgs = [
    { role: 'assistant', content: null, tool_calls: [c('a', 'read_document', { scope: 'outline', doc: null })] },
    { role: 'tool', tool_call_id: 'a', content: 'Outline:\n1: Intro', _ok: true },
    { role: 'assistant', content: 'Fixing.', tool_calls: [c('b', 'replace_text', { old_text: 'x', new_text: 'y' })] },
    { role: 'tool', tool_call_id: 'b', content: 'Error: old_text not found. Closest match: line 4.', _ok: false },
    { role: 'assistant', content: null, tool_calls: [c('d', 'replace_text', { old_text: 'z', new_text: 'w' })] },
    { role: 'tool', tool_call_id: 'd', content: 'Done: replaced line 4.', _ok: true, _edit: { undone: true, title: 't' } },
    { role: 'assistant', content: null, tool_calls: [c('e', 'find_in_document', { query: 'q' })] },
    { role: 'tool', tool_call_id: 'e', content: 'r'.repeat(1000), _ok: true },
  ];
  const t = T.turnCallsText(msgs).split('\n');
  deq(t.slice(0, 4), [
    'Your tool calls since the user\'s last message (4), the last results clipped:',
    '[read_document(scope="outline"): ok] Outline: 1: Intro',
    '[replace_text(old_text="x", new_text="y"): failed] Error: old_text not found. Closest match: line 4.',
    '[replace_text(old_text="z", new_text="w"): ok, undone later] Done: replaced line 4.',
  ]);
  assert.strictEqual(t[4], `[find_in_document(query="q"): ok] ${'r'.repeat(T.WRAP_UP_RESULT_CHARS - 1)}…`);
  assert.strictEqual(T.turnCallsText([]), '');
  // older calls: the fold line only; beyond the cap, the count says how many there were
  const many = [];
  for (let i = 0; i < T.WRAP_UP_CALLS_MAX + 3; i++) {
    many.push({ role: 'assistant', content: null, tool_calls: [c('m' + i, 'get_selection', {})] }, { role: 'tool', tool_call_id: 'm' + i, content: i === 5 ? 'Error: no selection.' : 'sel', _ok: i !== 5 });
  }
  const m = T.turnCallsText(many).split('\n');
  assert.strictEqual(m[0], `Your tool calls since the user's last message (the last ${T.WRAP_UP_CALLS_MAX} of ${T.WRAP_UP_CALLS_MAX + 3}), the last results clipped:`);
  assert.strictEqual(m.length, T.WRAP_UP_CALLS_MAX + 1);
  assert.strictEqual(m[3], '[get_selection(): Error: no selection.]'); // the 6th call, an older failure: foldCall's line
  assert.strictEqual(m[m.length - 1], '[get_selection(): ok] sel');
  // a repeated read's pointer (_again) is no result to show: the read itself keeps its clipped text
  const loop = [...msgs.slice(0, 2), ...[1, 2, 3].flatMap((n) => [{ role: 'assistant', content: null, tool_calls: [c('r' + n, 'read_document', { scope: 'outline', doc: null })] },
    { role: 'tool', tool_call_id: 'r' + n, content: T.READ_AGAIN_STOP_TEXT, _ok: true, _again: n }])];
  deq(T.turnCallsText(loop).split('\n').slice(1), ['[read_document(scope="outline"): ok] Outline: 1: Intro',
    ...[1, 2, 3].map(() => '[read_document(scope="outline"): ok]')]);
  // the repeated-failure wrap-up asks for the failure in plain words
  assert.strictEqual(T.REPEAT_FAIL_WRAP_UP_TEXT, 'The same tool call failed three times. Answer the user now: what was done, what failed (in plain words) and what is left; say nothing about tools.');
});

// The saved chat's loop: five rounds with the same sentence and the same read. The third identical repeat ends the rounds
// with the wrap-up (no Continue row: the budget was not the reason); its request carries the repeated sentence once.
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const muSayCall = (id, text, name, args) => sse({ choices: [{ index: 0, delta: { content: text } }] }) +
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
test('a read loop: the third identical repeat ends the rounds with the wrap-up; the repeated interim text is sent once', async () => {
  await fresh('munin');
  const read = { scope: 'outline', doc: null };
  // the model's script (it would read five times), and its answer to the request without tools
  const rounds = [muSayCall('a0', 'Let me check the headings.', 'find_in_document', { query: 'First' }),
    ...[1, 2, 3, 4, 5].map((i) => muSayCall('r' + i, 'Structure ready. Checking the final state.', 'read_document', read))];
  const bodies = [];
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    return sseResponse(b.tools ? rounds[Math.min(bodies.length - 1, rounds.length - 1)] : muText('The headings are in place.'));
  };
  await send(env, 'Check the headings');
  assert.strictEqual(bodies.length, 6); // the find, the read, three repeats, the wrap-up
  const tools = state.messages.filter((m) => m.role === 'tool');
  deq(tools.map((m) => m._again || 0), [0, 0, 1, 2, 3]);
  deq(tools.slice(3).map((m) => m.content), [T.READ_AGAIN_STOP_TEXT, T.READ_AGAIN_STOP_TEXT]);
  const wrap = bodies[5];
  assert.strictEqual(wrap.tools, undefined);
  const sent = wrap.messages[wrap.messages.length - 1].content;
  assert.ok(sent.startsWith(`${T.READ_LOOP_WRAP_UP_TEXT}\nYour tool calls since the user's last message (5), the last results clipped:\n`), sent);
  assert.strictEqual(T.READ_LOOP_WRAP_UP_TEXT, 'The same read was made four times; the document did not change. Answer the user now: what was done, what was checked and what is left; say nothing about tools.');
  // the read's own result is among the clipped ones, the pointers are not
  assert.match(sent, /\n\[read_document\(scope="outline"\): ok\] \S/);
  assert.strictEqual(sent.split('\n').filter((l) => l === '[read_document(scope="outline"): ok]').length, 3);
  const said = wrap.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  deq(said, ['Let me check the headings.', 'Structure ready. Checking the final state.']);
  // the stored turn keeps every round's text; the answer ends the turn without the Continue row
  assert.strictEqual(state.messages.filter((m) => m.role === 'assistant' && m.content === 'Structure ready. Checking the final state.').length, 4);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'The headings are in place.');
  assert.ok(!continueRow(), 'no Continue after a read loop');
});
