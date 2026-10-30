'use strict';
// The one-slot queue on a real DOM (jsdom): Enter while a turn runs queues the message (a second Enter
// appends to it), Edit / a click on the text puts it back into the input box, ✕ discards it; a normal
// finish sends it as the next turn (once), Stop or an error puts it back into the input box, and a chat
// switch never carries it into another chat.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

// A panel on DOC123 with Anthropic set up; every request streams from its own live stream.
async function panel() {
  const env = await load();
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await env.T.refreshContext({ force: true });
  const { state } = env;
  state.googleConnected = false;
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  env.bodies = [];
  env.streams = [];
  env.ctx.fetch = async (url, init) => {
    env.bodies.push(JSON.parse(init.body));
    const s = liveStream();
    init.signal.addEventListener('abort', () => s.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    env.streams.push(s);
    return s.response;
  };
  return env;
}

// Ends request i with a plain text answer.
function finish(env, i, text) {
  env.streams[i].push(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' }));
  env.streams[i].end();
}

const enter = (env, text) => { typeInto(env.el.input, text); return key(env.el.input, 'Enter'); };
const row = (env) => env.document.getElementById('queueRow');
const rowText = (env) => env.document.getElementById('queueText');
const userTexts = (env) => JSON.parse(JSON.stringify(env.state.messages.filter((m) => m.role === 'user').map((m) => m.content)));
const lastUserText = (body) => {
  const c = body.messages[body.messages.length - 1].content;
  return (Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : c).split('\n\n').pop();
};

// Starts a turn with "First" and waits until its request is streaming.
async function running(env) {
  enter(env, 'First');
  await waitFor(() => env.state.busy && env.streams.length === 1 && env.streams[0].reads > 0, 'the first request');
}

test('Enter while a turn runs queues the message; a second Enter appends after a blank line; the row shows a preview', async () => {
  const env = await panel();
  try {
    const { el, state } = env;
    const idle = el.input.placeholder;
    assert.ok(row(env).classList.contains('hidden'));
    await running(env);
    assert.match(el.input.placeholder, /Enter queues it/);
    assert.strictEqual(el.chat.getAttribute('aria-busy'), 'true'); // screen readers wait instead of reading every repaint
    const e = enter(env, 'Second');
    assert.ok(e.defaultPrevented);
    assert.strictEqual(el.input.value, '');
    assert.strictEqual(state.queued.text, 'Second');
    assert.ok(!row(env).classList.contains('hidden'));
    assert.strictEqual(rowText(env).textContent, 'Second');
    assert.ok(el.action.classList.contains('stopping')); // the button stays Stop
    const long = 'x'.repeat(100);
    enter(env, long);
    assert.strictEqual(state.queued.text, 'Second\n\n' + long);
    assert.strictEqual(rowText(env).textContent, ('Second ' + long).slice(0, 80) + '…');
    assert.strictEqual(rowText(env).title, 'Second\n\n' + long);
    enter(env, '   '); // blank: nothing queued
    assert.strictEqual(state.queued.text, 'Second\n\n' + long);
    assert.strictEqual(env.bodies.length, 1); // nothing sent while busy
    finish(env, 0, 'One.');
    await waitFor(() => env.streams.length === 2 && env.streams[1].reads > 0, 'the queued request');
    finish(env, 1, 'Two.');
    await waitFor(() => !state.busy, 'the end');
    assert.strictEqual(el.input.placeholder, idle);
    assert.strictEqual(el.chat.getAttribute('aria-busy'), 'false');
  } finally { env.close(); }
});

test('Edit (or a click on the text) puts the queued message back into the input box; ✕ discards it', async () => {
  const env = await panel();
  try {
    const { el, state, document } = env;
    await running(env);
    enter(env, 'Queued one');
    typeInto(el.input, 'draft');
    click(document.getElementById('queueEdit'));
    assert.strictEqual(el.input.value, 'Queued one\n\ndraft'); // the draft is kept after it
    assert.strictEqual(state.queued, null);
    assert.ok(row(env).classList.contains('hidden'));
    enter(env, 'Queued two');
    click(rowText(env));
    assert.strictEqual(el.input.value, 'Queued two');
    assert.strictEqual(state.queued, null);
    enter(env, 'Queued three');
    click(document.getElementById('queueDiscard'));
    assert.strictEqual(state.queued, null);
    assert.ok(row(env).classList.contains('hidden'));
    assert.strictEqual(el.input.value, '');
    finish(env, 0, 'One.');
    await waitFor(() => !state.busy, 'the end');
    await tick(20);
    assert.strictEqual(env.bodies.length, 1); // nothing was left to send
  } finally { env.close(); }
});

test('a normal finish sends the queued message as the next turn, exactly once, through sendMessage (slash commands work)', async () => {
  const env = await panel();
  try {
    const { el, state } = env;
    await running(env);
    enter(env, '/research the topic');
    typeInto(el.input, 'unsent draft'); // typed but not queued: stays in the input box
    finish(env, 0, 'One.');
    await waitFor(() => env.streams.length === 2 && env.streams[1].reads > 0, 'the queued request');
    assert.ok(state.busy);
    assert.strictEqual(state.queued, null);
    assert.ok(row(env).classList.contains('hidden'));
    assert.strictEqual(el.input.value, 'unsent draft');
    const user = state.messages.filter((m) => m.role === 'user').pop();
    assert.strictEqual(user.content, 'the topic');
    assert.strictEqual(user._persona, 'research');
    assert.strictEqual(lastUserText(env.bodies[1]), 'the topic');
    finish(env, 1, 'Two.');
    await waitFor(() => !state.busy, 'the end');
    await tick(30);
    assert.strictEqual(env.bodies.length, 2);
    assert.deepStrictEqual(userTexts(env), ['First', 'the topic']);
    assert.strictEqual(el.input.value, 'unsent draft');
  } finally { env.close(); }
});

test('a message queued during the queued turn is sent after it (chained)', async () => {
  const env = await panel();
  try {
    await running(env);
    enter(env, 'Second');
    finish(env, 0, 'One.');
    await waitFor(() => env.streams.length === 2 && env.streams[1].reads > 0, 'the second request');
    enter(env, 'Third');
    finish(env, 1, 'Two.');
    await waitFor(() => env.streams.length === 3 && env.streams[2].reads > 0, 'the third request');
    finish(env, 2, 'Three.');
    await waitFor(() => !env.state.busy, 'the end');
    await tick(20);
    assert.deepStrictEqual(userTexts(env), ['First', 'Second', 'Third']);
    assert.strictEqual(env.bodies.length, 3);
  } finally { env.close(); }
});

test('Stop: the queued message is not sent and goes back into the input box', async () => {
  const env = await panel();
  try {
    const { el, state } = env;
    await running(env);
    enter(env, 'Second');
    click(el.action); // Stop
    await waitFor(() => !state.busy, 'the stop');
    await tick(20);
    assert.strictEqual(env.bodies.length, 1);
    assert.strictEqual(el.input.value, 'Second');
    assert.strictEqual(state.queued, null);
    assert.ok(row(env).classList.contains('hidden'));
    assert.deepStrictEqual(userTexts(env), ['First']);
  } finally { env.close(); }
});

test('Stop with a draft in the input box: the draft stays, the message stays queued; a chat switch then returns it to the input', async () => {
  const env = await panel();
  try {
    const { el, state, T } = env;
    await running(env);
    enter(env, 'Second');
    typeInto(el.input, 'my draft');
    click(el.action); // Stop
    await waitFor(() => !state.busy, 'the stop');
    await tick(20);
    assert.strictEqual(env.bodies.length, 1);
    assert.strictEqual(el.input.value, 'my draft');
    assert.strictEqual(state.queued.text, 'Second');
    assert.ok(!row(env).classList.contains('hidden'));
    const before = state.chatId;
    await T.createChat(); // "+": another chat
    await tick(5);
    assert.notStrictEqual(state.chatId, before);
    assert.strictEqual(state.queued, null);
    assert.strictEqual(el.input.value, 'Second\n\nmy draft');
    assert.ok(row(env).classList.contains('hidden'));
    assert.strictEqual(env.bodies.length, 1);
  } finally { env.close(); }
});

test('an error ends the turn: the queued message is not sent and goes back into the input box', async () => {
  const env = await panel();
  try {
    const { el, state, document } = env;
    await running(env);
    enter(env, 'Second');
    env.streams[0].fail(new TypeError('network error'));
    await waitFor(() => !state.busy, 'the error');
    await tick(20);
    assert.ok([...document.querySelectorAll('#chat .msg.error')].length >= 1);
    assert.strictEqual(env.bodies.length, 1);
    assert.strictEqual(el.input.value, 'Second');
    assert.strictEqual(state.queued, null);
  } finally { env.close(); }
});

test('Enter while idle sends as before (no queue)', async () => {
  const env = await panel();
  try {
    enter(env, 'Hello');
    await waitFor(() => env.streams.length === 1, 'the request');
    assert.strictEqual(env.state.queued, null);
    assert.strictEqual(env.el.input.value, '');
    finish(env, 0, 'Hi.');
    await waitFor(() => !env.state.busy, 'the end');
  } finally { env.close(); }
});
