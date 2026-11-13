'use strict';
// The Thinking label's time (liveAnswer's thinking clock in turn.js, the label in render.js): from the first reasoning
// chunk to the first answer chunk or tool call of a round, summed over the rounds of the turn's one bubble, stored on the
// assistant message as _thoughtMs, so the label "Thought for Ns" survives a reload. The clock is replaced (thinkNow).
// At the end of a turn that made a tool call the label reads "Worked for Ns" instead: the turn's time (runTurn) without
// the waits on the user (the decision cards of gate.js), stored as _workedMs on its last answer; its clocks (workNow,
// waitNow) are replaced too. A turn the user stops reads "Stopped after Ns" by the same clock (_stopped with _workedMs;
// on the user message when no reply was stored); a turn that fails keeps its label. While the turn runs the line is
// present tense ("Working…", "Thinking…"); the past-tense labels come with the end of the turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, waitFor } = require('./lib/sandbox');
const { ev, msgStart, tu, stopTool, sseResponse } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nFirst.\n\nSecond.';
  await T.refreshContext({ force: true });
});

// A fake clock: each reading returns the next time (the last one repeats).
function clock(times) {
  const left = times.slice();
  env.ctx.__clock = () => (left.length > 1 ? left.shift() : left[0]);
  env.run('thinkNow = () => __clock()');
}
// The turn's clock and the gate's: both read now() (the test moves it).
function workClock(now) {
  env.ctx.__work = now;
  env.run('workNow = () => __work(); waitNow = () => __work()');
}
// An Anthropic thinking block (one chunk) at index 0.
const think = (t) => ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S' } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
const text = (i, t) => ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: i });
const end = ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' });
const bubbles = () => T.el.chat.children.filter((c) => c._parts && c.className.includes('assistant'));

async function fresh() {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  T.el.chat.children.length = 0;
}

test('reasoning, a pause of 2 s, then text: "Thought for 2s", stored as _thoughtMs and drawn again after a reload', async () => {
  await fresh();
  clock([10000, 12000]); // the first reasoning chunk, the first answer chunk
  recordFetch(env, [msgStart + think('Plan.') + text(1, 'Answer.') + end]);
  await send(env, 'Explain');
  const last = state.messages[state.messages.length - 1];
  assert.strictEqual(last.content, 'Answer.');
  assert.strictEqual(last._thoughtMs, 2000);
  assert.strictEqual(last._workedMs, undefined, 'no tool call: no working time');
  const b = bubbles()[bubbles().length - 1];
  assert.strictEqual(b._parts.label.textContent, 'Thought for 2s');
  // the time is in the footer, the bubble's last line, its summary over the reasoning; the tokens beside it
  assert.strictEqual(b._parts.foot, b.children[b.children.length - 1]);
  assert.deepStrictEqual([b._parts.foot.children[0], b._parts.foot.children[1]], [b._parts.think, b._parts.meta]);
  assert.ok(!b._parts.foot.classList.contains('hidden'));
  T.el.chat.children.length = 0;
  T.renderHistory(); // a reload: from the stored history
  assert.strictEqual(bubbles()[0]._parts.label.textContent, 'Thought for 2s');
});

test('a two-round turn sums the rounds\' reasoning time in its one bubble (a tool call ends a round\'s reasoning)', async () => {
  await fresh();
  clock([0, 1500, 10000, 12600]); // round 1: 1.5 s up to its tool call; round 2: 2.6 s up to its text
  const times = [50000, 57400]; // the turn's start and end: 7.4 s
  workClock(() => (times.length > 1 ? times.shift() : times[0]));
  recordFetch(env, [
    msgStart + think('Read first.') + tu(1, 'toolu_r', 'read_lines', { start: 1, end: 2 }) + stopTool,
    msgStart + think('Now answer.') + text(1, 'Two lines.') + end,
  ]);
  await send(env, 'Read the start');
  const rounds = state.messages.filter((m) => m.role === 'assistant');
  assert.deepStrictEqual([...rounds.map((m) => m._thoughtMs)], [1500, 2600]);
  assert.deepStrictEqual([...rounds.map((m) => m._workedMs)], [undefined, 7400], 'on the turn\'s last answer');
  assert.strictEqual(bubbles().length, 2, 'one live bubble for the turn, then the one drawn from the history (the stub chat keeps both)');
  // while the turn ran the label was present tense (the live bubble, never redrawn in the stub chat, still says so); at
  // its end (the bubble drawn from the history): the working time
  assert.strictEqual(bubbles()[0]._parts.label.textContent, 'Working…');
  assert.ok(bubbles()[0]._parts.think.classList.contains('live'));
  assert.strictEqual(bubbles()[1]._parts.label.textContent, 'Worked for 7s');
  assert.strictEqual(bubbles()[1]._parts.body.textContent, 'Read first.\n\nNow answer.'); // the reasoning of both rounds, still in the fold
  T.el.chat.children.length = 0;
  T.renderHistory(); // a reload
  assert.strictEqual(bubbles()[0]._parts.label.textContent, 'Worked for 7s');
});

test('a tool call without reasoning: "Worked for Ns" with nothing to open; a wait on the user is left out', async () => {
  await fresh();
  let now = 0;
  workClock(() => now);
  const ask = msgStart + tu(0, 'toolu_ask', 'ask_user', { question: 'Which part?', options: ['Start', 'End'] }) + stopTool;
  const rounds = [() => { now = 2000; return ask; }, () => { now = 65000; return msgStart + text(0, 'The start, then.') + end; }];
  let n = 0;
  env.ctx.fetch = async () => sseResponse(rounds[Math.min(n++, rounds.length - 1)]());
  T.el.input.value = 'Shorten it';
  const turn = T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  now = 62000; // the card waited 60 s
  T.decidePreview([...T.pendingPreviews.keys()][0], 'option:0');
  await turn;
  const last = state.messages[state.messages.length - 1];
  assert.strictEqual(last.content, 'The start, then.');
  assert.strictEqual(last._workedMs, 5000); // 65 s from the start, 60 s of them waiting on the answer
  const b = bubbles()[bubbles().length - 1];
  assert.strictEqual(b._parts.label.textContent, 'Worked for 5s');
  assert.ok(!b._parts.think.classList.contains('hidden') && b._parts.think.classList.contains('no-body'), 'shown, without a fold of reasoning');
});

test('an earlier build\'s turn with tools and _thoughtMs but no _workedMs keeps "Thought for Ns"; no reasoning, no tools: no section', () => {
  state.messages = [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: null, _reasoning: 'Read.', _thoughtMs: 2200, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_lines', arguments: '{"start":1,"end":2}' } }] },
    { role: 'tool', tool_call_id: 'r1', content: '1: # Notes', _ok: true },
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'B' },
  ];
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(bubbles()[0]._parts.label.textContent, 'Thought for 2s');
  assert.ok(bubbles()[1]._parts.think.classList.contains('hidden'));
});

test('under a second reads "Thought for 1s"; a message without _thoughtMs (an earlier build) keeps "Thinking"', () => {
  state.messages = [
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: 'A', _reasoning: 'Hmm.', _thoughtMs: 300 },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'B', _reasoning: 'Hmm again.' },
  ];
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.deepStrictEqual(bubbles().map((b) => b._parts.label.textContent), ['Thought for 1s', 'Thinking']);
});

test('from 60 s on the label reads minutes, from an hour on hours and minutes: 59s, 1m, 2m 5s, 1h, 1h 2m; "Worked for" the same', () => {
  const turn = (ms, worked) => [
    { role: 'user', content: 'Q' },
    worked
      ? { role: 'assistant', content: 'A', _reasoning: 'Hmm.', _thoughtMs: 1000, _workedMs: ms, tool_calls: [{ id: `w${ms}`, type: 'function', function: { name: 'read_lines', arguments: '{"start":1,"end":2}' } }] }
      : { role: 'assistant', content: 'A', _reasoning: 'Hmm.', _thoughtMs: ms },
    ...(worked ? [{ role: 'tool', tool_call_id: `w${ms}`, content: '1: # Notes', _ok: true }] : []),
  ];
  state.messages = [59000, 60000, 125000, 3600000, 3725000].flatMap((ms) => turn(ms, false)).concat(turn(125000, true), turn(59400, true), turn(120000, true));
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.deepStrictEqual(bubbles().map((b) => b._parts.label.textContent),
    ['Thought for 59s', 'Thought for 1m', 'Thought for 2m 5s', 'Thought for 1h', 'Thought for 1h 2m', 'Worked for 2m 5s', 'Worked for 59s', 'Worked for 2m']);
});

// Round 1 is a read (a tool call), round 2 never arrives: the test stops it (state.abort) or fails it.
function stalledSecondRound(first) {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url, init) => {
    if (first && n++ === 0) return sseResponse(first);
    if (init && init.signal) init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  return stream;
}
const readRound = () => msgStart + think('Read first.') + tu(1, 'toolu_sr', 'read_lines', { start: 1, end: 2 }) + stopTool;

test('Stop after a tool round: "Stopped after Ns" by the working clock, live and after a reload (_stopped on the last answer)', async () => {
  await fresh();
  let now = 50000;
  workClock(() => now);
  const stream = stalledSecondRound(readRound());
  T.el.input.value = 'Read and stop';
  const turn = T.sendMessage();
  await waitFor(() => stream.reads > 0, 'the second request');
  now = 58200;
  state.abort.abort(); // Stop
  await turn;
  const last = state.messages.filter((m) => m.role === 'assistant').pop();
  assert.strictEqual(last._workedMs, 8200);
  assert.strictEqual(last._stopped, true);
  const b = bubbles()[bubbles().length - 1];
  assert.strictEqual(b._parts.label.textContent, 'Stopped after 8s', 'right after Stop (the final re-render)');
  assert.ok(!b._parts.think.classList.contains('live'), 'past tense: nothing live');
  T.el.chat.children.length = 0;
  T.renderHistory(); // a reload
  assert.strictEqual(bubbles()[0]._parts.label.textContent, 'Stopped after 8s');
});

test('Stop before anything arrived (no reasoning, no tool call): a bubble with "Stopped after Ns" only', async () => {
  await fresh();
  let now = 1000;
  workClock(() => now);
  const stream = stalledSecondRound(null);
  T.el.input.value = 'Hello';
  const turn = T.sendMessage();
  await waitFor(() => stream.reads > 0, 'the request');
  now = 4000;
  state.abort.abort();
  await turn;
  assert.strictEqual(state.messages.filter((m) => m.role === 'assistant').length, 0, 'no reply stored');
  const user = state.messages[state.messages.length - 1];
  assert.strictEqual(user.role, 'user');
  assert.strictEqual(user._stopped, true);
  assert.strictEqual(user._workedMs, 3000);
  const check = () => {
    const b = bubbles()[bubbles().length - 1];
    assert.strictEqual(b._parts.label.textContent, 'Stopped after 3s');
    assert.ok(!b._parts.think.classList.contains('hidden') && b._parts.think.classList.contains('no-body'), 'the label alone, nothing to open');
    assert.strictEqual(b._parts.md.textContent, '');
  };
  check();
  T.el.chat.children.length = 0;
  T.renderHistory(); // a reload
  assert.strictEqual(bubbles().length, 1);
  check();
  // the stored flag is display-only: the next request sends the stopped message as before, without it
  const bodies = recordFetch(env, [msgStart + text(0, 'Hi.') + end]);
  await send(env, 'Again');
  assert.ok(JSON.stringify(bodies[0].messages).includes('Hello'));
  assert.ok(!JSON.stringify(bodies[0]).includes('_stopped'));
});

test('a turn that fails (not a Stop) keeps "Worked for Ns"; nothing is marked stopped', async () => {
  await fresh();
  let now = 0;
  workClock(() => now);
  const stream = stalledSecondRound(readRound());
  T.el.input.value = 'Read and fail';
  const turn = T.sendMessage();
  await waitFor(() => stream.reads > 0, 'the second request');
  now = 6000;
  stream.fail(new TypeError('Failed to fetch'));
  await turn;
  const last = state.messages.filter((m) => m.role === 'assistant').pop();
  assert.strictEqual(last._workedMs, 6000);
  assert.strictEqual(last._stopped, undefined);
  assert.ok(!state.messages.some((m) => m._stopped));
  assert.strictEqual(bubbles()[bubbles().length - 1]._parts.label.textContent, 'Worked for 6s');
});
