'use strict';
// A turn that fails while it prepares (before the first request) still ends: the panel is idle again.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, turnRowTexts } = require('./lib/sandbox');
const { textRound, msgStart, tu, stopTool, sseResponse } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

test('an error while the turn context is built: the panel is not left busy, the error is shown', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  // The turn context fails to build. Registry callbacks (offer, docNote) are guarded and skipped, so the failure is
  // injected into buildTurnContext itself: a global of the panel's shared scope (env.ctx is the vm context; the
  // turn looks the name up at call time).
  const original = env.ctx.buildTurnContext;
  let calls = 0;
  env.ctx.buildTurnContext = (...args) => { if (++calls === 1) throw new Error('context failed'); return original(...args); };
  const bodies = recordFetch(env, [textRound('One.')]);
  try {
    await send(env, 'hello');
  } finally {
    env.ctx.buildTurnContext = original;
  }
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null);
  assert.strictEqual(bodies.length, 0);
  assert.ok(T.el.chat.children.some((n) => /context failed/i.test(n.innerHTML || n.textContent || '')), 'the error is in the chat');
  // the next message works
  await send(env, 'again');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(state.busy, false);
});

test('a registered docNote that throws is left out of the turn context; the turn goes on', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  T.registerTools([{ type: 'function', function: { name: 'note_tool', description: 'x', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
    { offer: () => true, run: () => 'ok', reading: true, docNote: () => { throw new Error('note failed'); } });
  const bodies = recordFetch(env, [textRound('One.')]);
  try {
    await send(env, 'with a note');
  } finally {
    T.EXTRA_TOOLS.pop();
  }
  assert.strictEqual(bodies.length, 1);
  assert.ok(state.messages[state.messages.length - 2]._context.startsWith('<document title='));
  assert.strictEqual(state.busy, false);
});

test('a tool that throws: the call gets an error result (the history stays valid) and the turn goes on', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  const original = env.ctx.rememberTool;
  env.ctx.rememberTool = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  const bodies = recordFetch(env, [msgStart + tu(0, 'toolu_r1', 'remember', { scope: 'document', text: 'Use British spelling.' }) + stopTool, textRound('Could not save it.')]);
  try {
    await send(env, 'remember British spelling');
  } finally {
    env.ctx.rememberTool = original;
  }
  assert.strictEqual(bodies.length, 2);
  const res = bodies[1].messages[bodies[1].messages.length - 1].content[0];
  assert.strictEqual(res.type, 'tool_result');
  assert.strictEqual(res.tool_use_id, 'toolu_r1');
  assert.ok(res.content.startsWith('Error: QUOTA_BYTES quota exceeded. The call was not completed'), res.content);
  const stored = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'toolu_r1');
  assert.strictEqual(stored._ok, false);
  assert.strictEqual(state.busy, false);
});

test('a call that fails again with the same arguments: the note on the 2nd failure, the wrap-up after the 3rd; refusals do not count', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  const bad = (id) => msgStart + tu(0, id, 'no_such_tool', { x: 1 }) + stopTool;
  const bodies = recordFetch(env, [bad('t1'), bad('t2'), bad('t3'), textRound('It kept failing.')]);
  await send(env, 'do it');
  assert.strictEqual(bodies.length, 4);
  const results = state.messages.filter((m) => m.role === 'tool' && ['t1', 't2', 't3'].includes(m.tool_call_id));
  assert.strictEqual(results.length, 3);
  assert.ok(!results[0].content.includes(T.REPEAT_FAIL_NOTE));
  assert.ok(results[1].content.startsWith('Error: unknown tool') && results[1].content.endsWith('\n' + T.REPEAT_FAIL_NOTE), results[1].content);
  assert.strictEqual(T.REPEAT_FAIL_NOTE, 'This exact call already failed in this message: change the arguments or tell the user.');
  // the 4th request is the wrap-up: no tools, the wrap-up text last
  assert.ok(!bodies[3].tools || !bodies[3].tools.length);
  const last = bodies[3].messages[bodies[3].messages.length - 1];
  const lastText = typeof last.content === 'string' ? last.content : last.content.map((c) => c.text || '').join('');
  assert.ok(lastText.includes(T.REPEAT_FAIL_WRAP_UP_TEXT), lastText);
  assert.strictEqual(state.messages.filter((m) => m._autoKind === 'wrap-up').length, 0, 'the wrap-up request is removed after the turn (settleAutoKinds)');
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'It kept failing.');
  assert.strictEqual(state.busy, false);
  // other arguments are another call; a refusal by a check and a cancelled call are not failures
  const snap = {};
  const call = (name, args) => ({ id: 'x', type: 'function', function: { name, arguments: JSON.stringify(args) } });
  assert.strictEqual(T.noteRepeatFailure(snap, call('a', { n: 1 }), { _ok: false, content: 'Error: x' }), 1);
  assert.strictEqual(T.noteRepeatFailure(snap, call('a', { n: 2 }), { _ok: false, content: 'Error: x' }), 1);
  assert.strictEqual(T.noteRepeatFailure(snap, call('b', {}), { _ok: false, content: 'Refused by a check: you have not read line 4' }), 0);
  assert.strictEqual(T.noteRepeatFailure(snap, call('b', {}), { _ok: false, content: 'Error: cancelled by the user.' }), 0);
  const r = { _ok: false, content: 'Error: x' };
  assert.strictEqual(T.noteRepeatFailure(snap, call('a', { n: 1 }), r), 2);
  assert.ok(r.content.endsWith(T.REPEAT_FAIL_NOTE));
});

// A turn that fails before an answer: the chat shows plain words (no code, no server text), the history keeps a note
// for the model (_auto, _failed) drawn as a row of the turn, and the next request carries it before the next message.
test('a turn that fails before an answer: plain words in the chat, the failed-turn note for the next turn', async () => {
  useProvider(env, 'anthropic');
  await T.createChat();
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  const bodies = [];
  let fail = true;
  env.ctx.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (fail) { fail = false; return sseResponse(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1: unexpected field "x"' } }), 400); }
    return sseResponse(textRound('Hello.'));
  };
  T.el.chat.children.length = 0;
  await send(env, 'hello');
  const errors = T.el.chat.children.filter((c) => String(c.className).includes('error')).map((c) => c.textContent || c.innerHTML);
  assert.strictEqual(errors.length, 1);
  assert.ok(!/400|API error|Server:/.test(errors[0]), errors[0]);
  assert.ok(errors[0].startsWith('The request was malformed: messages.1: unexpected field'), errors[0]);
  const h = state.messages;
  assert.strictEqual(h.length, 2);
  deq(h.map((m) => [m.role, !!m._auto, !!m._failed]), [['user', false, false], ['user', true, true]]);
  assert.strictEqual(h[1].content, '[The previous request failed before an answer: the request was malformed: messages.1: unexpected field "x".]');
  assert.ok(turnRowTexts(T.el.chat).includes(T.FAILED_TURN_ROW));
  assert.strictEqual(T.FAILED_TURN_ROW, 'No answer: the request failed.');
  // the next turn: the note is sent before the new message (merged into one user message for Anthropic)
  await send(env, 'again');
  const sent = JSON.stringify(bodies[1].messages);
  assert.ok(sent.includes('[The previous request failed before an answer: the request was malformed'), sent);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Hello.');
  // a turn that answered (even partly) gets no note; a Stop neither
  assert.strictEqual(state.messages.filter((m) => m._failed).length, 1);
});

// The server counts more tokens than chars/3 estimated and refuses the request as too long: the same round is sent once
// more with the turn's reading results stubbed and the budget at 80% for the rest of the turn; a row says so.
const tooLong = () => ({ ok: false, status: 400, json: async () => ({}), headers: { get: () => null },
  text: async () => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) });
const CONTEXT_ROW = 'The request was too long for the model; it was sent again with less context.';

function contextBench(answers) {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\n' + Array.from({ length: 200 }, (_, i) => `Line ${i + 1} ` + 'q'.repeat(60)).join('\n');
  doc.selection = '';
  const bodies = [];
  const sizes = [];
  env.ctx.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    sizes.push(init.body.length);
    const a = answers[Math.min(bodies.length - 1, answers.length - 1)];
    return typeof a === 'function' ? a() : sseResponse(a);
  };
  // the snapshot's budget scale as each request is built
  const original = env.ctx.buildRequest;
  const scales = [];
  env.ctx.buildRequest = (mode, snap, opts) => { scales.push(snap.budgetScale); return original(mode, snap, opts); };
  return { bodies, sizes, scales, restore: () => { env.ctx.buildRequest = original; } };
}
const readCall = (id) => msgStart + tu(0, id, 'read_document', { scope: { start: 1, end: 200 }, include: ['text'], doc: null }) + stopTool;

test('a request refused as too long: resent once with the reading results stubbed and less budget; a row; the turn completes', async () => {
  const b = contextBench([readCall('toolu_c1'), tooLong, readCall('toolu_c2'), textRound('Done.')]);
  try {
    await send(env, 'summarize the document');
  } finally {
    b.restore();
  }
  assert.strictEqual(b.bodies.length, 4);
  // the resend is the same round with the read result stubbed: much smaller
  assert.ok(b.sizes[2] < b.sizes[1] * 0.6, `${b.sizes[2]} < 0.6 x ${b.sizes[1]}`);
  const resultOf = (body, id) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_result' && c.tool_use_id === id);
  assert.ok(resultOf(b.bodies[1], 'toolu_c1').content.length > 10000);
  assert.ok(/content omitted to fit the context window/.test(resultOf(b.bodies[2], 'toolu_c1').content), resultOf(b.bodies[2], 'toolu_c1').content);
  // later rounds keep the reduced budget (the newest result is kept as usual)
  assert.deepStrictEqual(b.scales.map(String), ['undefined', 'undefined', '0.8', '0.8']);
  assert.ok(resultOf(b.bodies[3], 'toolu_c2').content.length > 10000); // a re-read reads again: its earlier result is a stub
  // the row is the turn's, the answer is there, nothing about it went to the model
  // stored once with the turn (on the message that was the last when it arose): drawn again with the chat
  deq(state.messages.flatMap((m) => m._notes || []).filter((n) => n === CONTEXT_ROW), [CONTEXT_ROW]);
  assert.ok(turnRowTexts(T.el.chat).includes(CONTEXT_ROW));
  const last = state.messages[state.messages.length - 1];
  assert.strictEqual(last.role, 'assistant'); assert.strictEqual(last.content, 'Done.');
  assert.ok(!JSON.stringify(b.bodies[3].messages).includes('sent again with less context'));
  assert.strictEqual(state.busy, false);
});

test('a second refusal in the same round keeps the context-window error', async () => {
  const b = contextBench([readCall('toolu_d1'), tooLong, tooLong, textRound('never')]);
  try {
    await send(env, 'summarize again');
  } finally {
    b.restore();
  }
  assert.strictEqual(b.bodies.length, 3);
  assert.ok(turnRowTexts(T.el.chat).includes(CONTEXT_ROW));
  assert.ok(T.el.chat.children.some((n) => /does not fit into the model.{1,6}s context window/.test(n.innerHTML || n.textContent || '')), 'the error is in the chat');
  assert.strictEqual(state.busy, false);
});
