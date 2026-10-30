'use strict';
// The one-slot queue with a shared chat: a message queued in tab A while A waits for the chat lock that
// tab B holds is not sent until A's own turn has run (the queue reuses sendMessage, so it waits for the
// lock like a typed message), and a queued message never goes to a chat other than the one it was
// queued in. Two panels on one chrome.storage.local (test/lib/shared-storage.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, waitFor } = require('./lib/sandbox');
const { sharedStorage, webLocks, tick } = require('./lib/shared-storage');
const { sseResponse, ev, textRound } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');

const DOC = 'DOC123';
const histKey = (id) => `muninChatHistory:${DOC}:${id}`;
const WAIT = 'Another tab is answering in this chat…';

async function panel(store, locks) {
  const env = await load();
  if (store) env.handle = store.attach(env);
  if (locks) env.ctx.navigator.locks = locks;
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await env.T.refreshContext({ force: true });
  env.state.googleConnected = false;
  env.state.settings.provider = 'anthropic';
  Object.assign(env.state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  env.bodies = [];
  return env;
}
function answers(env, ...replies) {
  env.ctx.fetch = async (url, init) => {
    env.bodies.push(JSON.parse(init.body));
    return sseResponse(textRound(replies[Math.min(env.bodies.length - 1, replies.length - 1)]));
  };
}
function held(env) {
  const s = liveStream();
  s.finish = (text) => {
    s.push(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' }));
    s.end();
  };
  env.ctx.fetch = async (url, init) => { env.bodies.push(JSON.parse(init.body)); return s.response; };
  return s;
}
const send = (env, text) => { env.T.el.input.value = text; return env.T.sendMessage(); };
const queue = (env, text) => { env.T.el.input.value = text; return env.T.queueInput(); };
const pairs = (msgs) => msgs.map((m) => [m.role, m.content]);

test('shared chat: a message queued in A while B holds the chat lock waits for A\'s own turn, then follows it', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  const s = held(B);
  answers(A, 'Answer 1.', 'Answer 2.');
  const turnB = send(B, 'From B');
  await waitFor(() => B.bodies.length === 1, 'the request of B');
  const turnA = send(A, 'A first');
  await waitFor(() => A.T.el.docStatus.textContent === WAIT, 'A to wait for the lock');
  assert.strictEqual(A.state.busy, true);
  assert.strictEqual(queue(A, 'A second'), true);
  assert.strictEqual(A.state.queued.text, 'A second');
  await tick(30);
  assert.strictEqual(A.bodies.length, 0); // neither the typed nor the queued message goes out while B answers
  assert.ok(A.state.queued);
  s.finish('Answer B.');
  await Promise.all([turnA, turnB]); // sendMessage of A resolves after the queued turn too
  assert.strictEqual(A.bodies.length, 2);
  assert.strictEqual(A.state.queued, null);
  const final = [['user', 'From B'], ['assistant', 'Answer B.'], ['user', 'A first'], ['assistant', 'Answer 1.'], ['user', 'A second'], ['assistant', 'Answer 2.']];
  deq(pairs(store.items[histKey(x)]), final);
  assert.ok(!locks.held(`munin:chat:${DOC}:${x}`));
  await tick(30);
  assert.strictEqual(A.bodies.length, 2); // exactly once
});

test('waiting for the lock: Enter queues only what was typed after the waiting message; Stop keeps both', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const s = held(B);
  answers(A, 'Never.');
  const turnB = send(B, 'From B');
  await waitFor(() => B.bodies.length === 1, 'the request of B');
  const turnA = send(A, 'A first');
  await waitFor(() => A.T.el.docStatus.textContent === WAIT, 'A to wait for the lock');
  assert.strictEqual(A.T.el.input.value, 'A first'); // the waiting message is still in the input box
  assert.strictEqual(A.T.queueInput(), false); // Enter again: it is already on its way, nothing queued
  assert.strictEqual(A.state.queued, null);
  A.T.el.input.value = 'A first\nA second'; // typed after it
  assert.strictEqual(A.T.queueInput(), true);
  assert.strictEqual(A.state.queued.text, 'A second'); // only the new text, no duplicate
  assert.strictEqual(A.T.el.input.value, 'A first');
  A.state.abort.abort(); // Stop
  await turnA;
  assert.strictEqual(A.bodies.length, 0);
  assert.strictEqual(A.state.busy, false);
  // the stopped message stays in the input box (existing behavior); the queued one stays queued next to it
  assert.strictEqual(A.T.el.input.value, 'A first');
  assert.strictEqual(A.state.queued.text, 'A second');
  s.finish('Answer B.');
  await turnB;
  await tick(30);
  assert.strictEqual(A.bodies.length, 0);
});

test('the queued message is sent only to the chat it was queued in; otherwise it goes back into the input box', async () => {
  const A = await panel();
  answers(A, 'Never.');
  const q = { text: 'For the old chat', docId: A.state.docId, chatId: 'gone-chat' };
  A.T.el.input.value = '';
  await A.T.sendMessage(q); // as the finish hook calls it (the slot already emptied)
  assert.strictEqual(A.bodies.length, 0);
  assert.strictEqual(A.state.busy, false);
  assert.strictEqual(A.T.el.input.value, 'For the old chat');
  assert.strictEqual(A.state.queued, null);
  // a slot of another chat is returned by syncQueueChat (called on a chat or document switch)
  A.state.queued = { ...q, text: 'Other' };
  A.T.el.input.value = 'draft';
  A.T.syncQueueChat();
  assert.strictEqual(A.T.el.input.value, 'Other\n\ndraft');
  assert.strictEqual(A.state.queued, null);
});

test('a normal turn without a queued message leaves the input box alone and sends nothing more', async () => {
  const A = await panel();
  answers(A, 'Hi.');
  await send(A, 'Hello');
  assert.strictEqual(A.bodies.length, 1);
  assert.strictEqual(A.state.queued, null);
  assert.strictEqual(A.T.el.input.value, '');
  assert.strictEqual(A.T.queueInput(), false); // empty input: nothing queued
  assert.strictEqual(A.state.queued, null);
});
