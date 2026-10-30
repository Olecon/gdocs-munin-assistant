'use strict';
// A reply cut by the length limit gets one automatic continuation per turn (toolLoop): the partial reply is kept,
// a user-role message marked _auto (AUTO_CONTINUE_TEXT, no turn context) is appended and saved, one more round
// runs; the request prefix stays byte-identical (appended, never rewritten); a second cut only gets the sticky
// notice; a cut tool call is not executed; Munin persona turns keep today's notice; the queue settles normally.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { ev, msgStart, sseResponse } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, muText, stripCache } = require('./lib/context');

let env, T, state, doc;
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
// Munin (Chat Completions) round cut by the length limit: some text, or an unfinished tool call.
const muCut = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n';
const muCutTool = () => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_cut', type: 'function', function: { name: 'insert_after_line', arguments: '{"line":3,"text":"A very long' } }] } }] }) +
  cc({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n';
// Anthropic round cut by max_tokens.
const anCut = (t) => msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }) + ev('message_stop', { type: 'message_stop' });
const anText = (t) => anCut(t).replace('"stop_reason":"max_tokens"', '"stop_reason":"end_turn"');
const notices = () => T.el.chat.children.filter((c) => c.className && c.className.includes('notice')).map((c) => c.innerHTML);
const CUT_NOTICE = 'The reply was cut off by the length limit.';

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

test('Munin: a cut reply gets exactly one continuation round; the _auto message is appended, saved and sent as plain user text', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, [muCut('Item 1, item 2, it'), muText('em 3.')]);
  await send(env, 'List the items');
  assert.strictEqual(bodies.length, 2);
  const h = state.messages;
  deq(h.map((m) => [m.role, m.content]), [['user', 'List the items'], ['assistant', 'Item 1, item 2, it'], ['user', T.AUTO_CONTINUE_TEXT], ['assistant', 'em 3.']]);
  deq(Object.keys(h[2]).sort(), ['_auto', 'content', 'role']); // no turn context, no document facts
  assert.strictEqual(h[2]._auto, true);
  assert.strictEqual(T.AUTO_CONTINUE_TEXT, '[Your reply was cut off at the length limit. Continue exactly where it stopped, in smaller steps: shorter edits, fewer items per reply.]');
  // stored with the chat
  deq(env.storage['muninChatHistory:DOC123:' + state.chatId].map((m) => m.content), h.map((m) => m.content));
  // the second request: the first request's messages byte for byte (the _auto message is part of its turn,
  // lastUserIndex skips it, so the turn's own context stays full), then the partial reply and the continuation.
  const [b0, b1] = bodies;
  deq(b1.messages.slice(0, b0.messages.length), b0.messages);
  deq(b1.messages.slice(b0.messages.length), [{ role: 'assistant', content: 'Item 1, item 2, it' }, { role: 'user', content: T.AUTO_CONTINUE_TEXT }]);
  deq(b1.tools, b0.tools);
  // the transient notice, no sticky cut notice
  assert.ok(T.el.chat.children.some((c) => c.className.includes('auto-continue')), 'the stored row after renderHistory');
  assert.ok(!notices().includes(CUT_NOTICE));
  // renderHistory: one user bubble, the row in place of the continuation request
  T.el.chat.children.length = 0;
  T.renderHistory();
  deq(T.el.chat.children.map((c) => c.className), ['msg user', 'msg assistant', 'msg notice auto-continue', 'msg assistant']);
});

test('Anthropic: the request prefix is unchanged by the continuation (cache stays valid)', async () => {
  await fresh('anthropic');
  const bodies = recordFetch(env, [anCut('Part one, part'), anText(' two.')]);
  await send(env, 'Write it');
  assert.strictEqual(bodies.length, 2);
  const [b0, b1] = bodies.map(stripCache);
  deq(b1.system, b0.system);
  deq(b1.tools, b0.tools);
  deq(b1.messages.slice(0, b0.messages.length), b0.messages);
  deq(b1.messages.slice(b0.messages.length), [
    { role: 'assistant', content: [{ type: 'text', text: 'Part one, part' }] },
    { role: 'user', content: [{ type: 'text', text: T.AUTO_CONTINUE_TEXT }] },
  ]);
  deq(state.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('a second cut in the same turn: no further continuation; the next turn may continue once again', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, [muCut('One'), muCut('Two'), muText('never')]);
  await send(env, 'Go');
  assert.strictEqual(bodies.length, 2);
  deq(state.messages.map((m) => m.content), ['Go', 'One', T.AUTO_CONTINUE_TEXT, 'Two']);
  assert.strictEqual(state.messages.filter((m) => m._auto).length, 1);
  // the next turn may continue once again
  const more = recordFetch(env, [muCut('Three'), muText('Four.')]);
  await send(env, 'Again');
  assert.strictEqual(more.length, 2);
  assert.strictEqual(state.messages.filter((m) => m._auto).length, 2);
});

test('notices: AUTO_CONTINUE_NOTICE on the first cut, the sticky cut notice on the second', async () => {
  await fresh('munin');
  const calls = [];
  const original = env.ctx.addNotice;
  env.ctx.addNotice = (t, o) => { calls.push([t, !!(o && o.sticky)]); return original(t, o); };
  try {
    recordFetch(env, [muCut('One'), muCut('Two')]);
    await send(env, 'Go');
  } finally {
    env.ctx.addNotice = original;
  }
  deq(calls.filter(([t]) => t !== 'Stopped.'), [[T.AUTO_CONTINUE_NOTICE, false], [CUT_NOTICE, true]]);
  assert.strictEqual(T.AUTO_CONTINUE_NOTICE, 'Reply cut by the length limit: asked the model to continue'); // the same text as the stored row
});

test('a tool call cut by the length limit is not executed; the continuation round runs', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, [muCutTool(), muText('Done in smaller steps.')]);
  await send(env, 'Insert a long text');
  assert.strictEqual(bodies.length, 2);
  assert.ok(!state.messages.some((m) => m.role === 'tool' || m.tool_calls));
  deq(state.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(state.messages[2]._auto);
  // the empty partial reply is not sent; the continuation request follows the user message
  const last2 = bodies[1].messages.slice(-2);
  deq(last2.map((m) => m.role), ['user', 'user']);
  assert.strictEqual(last2[1].content, T.AUTO_CONTINUE_TEXT);
});

test('Munin persona turns are unchanged: one request and the sticky notice', async () => {
  await fresh('munin');
  const calls = [];
  const original = env.ctx.addNotice;
  env.ctx.addNotice = (t, o) => { calls.push([t, !!(o && o.sticky)]); return original(t, o); };
  const pev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const bodies = [];
  env.ctx.fetch = async (url, init) => { bodies.push(init.body); return sseResponse(pev('token', { content: 'Cut' }) + pev('done', { finish_reason: 'length' })); };
  try {
    await send(env, '/chat tell me more');
  } finally {
    env.ctx.addNotice = original;
  }
  assert.strictEqual(bodies.length, 1);
  assert.ok(!state.messages.some((m) => m._auto));
  deq(calls, [[CUT_NOTICE, true]]);
});

test('the queue settles normally after a turn that continued: the queued message is sent next', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, [muCut('Half'), muText('Whole.'), muText('Second answer.')]);
  state.queued = { text: 'Queued question', docId: state.docId, chatId: state.chatId };
  await send(env, 'First question');
  assert.strictEqual(bodies.length, 3);
  assert.strictEqual(state.queued, null);
  deq(state.messages.map((m) => m.content), ['First question', 'Half', T.AUTO_CONTINUE_TEXT, 'Whole.', 'Queued question', 'Second answer.']);
  assert.strictEqual(state.busy, false);
});

test('the self-test\'s quiet loop continues too, without notices', async () => {
  await fresh('munin');
  const history = [{ role: 'user', content: 'Go' }];
  const bodies = recordFetch(env, [muCut('A'), muText('B')]);
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  const before = T.el.chat.children.length;
  const out = await T.toolLoop('edit', s, new AbortController().signal, { messages: history, quiet: true, request: { history } });
  assert.strictEqual(bodies.length, 2);
  deq([out.rounds, out.continued], [2, 1]);
  assert.strictEqual(T.el.chat.children.length, before);
  deq(history.map((m) => m.content), ['Go', 'A', T.AUTO_CONTINUE_TEXT, 'B']);
});
