'use strict';
// The orb before the first chunk (turn.js liveAnswer().start()): the live answer bubble is made when the request
// starts, empty and streaming, so its orb shows while the first token is awaited; the first chunks stream into that
// same bubble. A failure or Stop before any chunk leaves no empty bubble behind, also in a /side turn (which has no
// final re-render; the ring that showed stays as one frozen frame in the Stopped notice or the error row), and a
// Munin persona turn's waiting bubble is replaced by the stored reply.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

let env, T, state, el;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];
const bubbles = () => $$('.msg.assistant');

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  state.applyMode = 'auto'; T.applyApplyMode('auto');
});
after(() => env.close());

const msgStart = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } });
const textStart = ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const textDelta = (t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const textEnd = ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' });
const abortable = (stream) => async (url, init) => {
  if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' }; // the export: the tab's copy
  if (init && init.signal) init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
  return stream.response;
};
async function send(text) {
  await T.createChat();
  typeInto(el.input, text);
  key(el.input, 'Enter');
}

test('the bubble and its orb exist before the first chunk; the text then streams into the same bubble', async () => {
  const stream = liveStream();
  env.ctx.fetch = abortable(stream);
  await send('Hello');
  await waitFor(() => stream.reads > 0, 'the request');
  await waitFor(() => bubbles().length === 1 && bubbles()[0].querySelector('canvas.orb'), 'the waiting bubble');
  const bubble = bubbles()[0];
  const orb = bubble.querySelector('canvas.orb');
  assert.ok(orb.dataset.orb, 'the orb runs');
  assert.ok(!orb.classList.contains('hidden'));
  assert.ok(bubble.classList.contains('typing'));
  assert.strictEqual(bubble.querySelector('.md').textContent, '', 'no text yet');
  stream.push(msgStart + textStart + textDelta('Hi there.'));
  await waitFor(() => bubble.querySelector('.md').textContent === 'Hi there.', 'the text');
  assert.strictEqual(bubbles().length, 1, 'the same bubble');
  stream.push(textEnd);
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  assert.strictEqual($$('canvas.orb').length, 0);
});

test('Stop before the first chunk in a /side turn: the waiting bubble goes', async () => {
  const stream = liveStream();
  env.ctx.fetch = abortable(stream);
  await send('/side what is this?');
  await waitFor(() => stream.reads > 0, 'the request');
  await waitFor(() => bubbles().length === 1, 'the waiting bubble');
  click(el.action); // Stop
  await waitFor(() => !state.busy, 'the stop');
  await tick(10);
  assert.strictEqual(bubbles().length, 0, 'no empty bubble left');
  // the ring that was showing stays as the turn's one frozen frame, in the Stopped notice (render.js freezeTurnOrb)
  const left = $$('canvas.orb');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].dataset.orbFrozen, 'true');
  assert.ok(left[0].parentElement.classList.contains('notice'));
});

test('a failure before the first chunk: no empty bubble, the error is shown', async () => {
  const stream = liveStream();
  env.ctx.fetch = abortable(stream);
  await send('/side and this?');
  await waitFor(() => stream.reads > 0, 'the request');
  await waitFor(() => bubbles().length === 1, 'the waiting bubble');
  stream.fail(new TypeError('Failed to fetch'));
  await waitFor(() => !state.busy, 'the failure');
  await tick(10);
  assert.strictEqual(bubbles().length, 0);
  assert.ok($$('.msg.error').length >= 1);
  // an error before any reply: the frozen frame goes into the error row
  const orbs = $$('.msg.error').pop().querySelectorAll('canvas.orb');
  assert.strictEqual(orbs.length, 1);
  assert.strictEqual(orbs[0].dataset.orbFrozen, 'true');
});

test('a Munin persona turn: the waiting bubble shows, then the stored reply replaces it', async () => {
  state.settings.provider = 'munin';
  Object.assign(state.settings.providers.munin, { apiKey: 'k-test' });
  try {
    const stream = liveStream();
    env.ctx.fetch = async (url, init) => {
      if (!String(url).includes('muninai')) return { ok: false, status: 404, text: async () => '' };
      init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      return stream.response;
    };
    await send('/chat tell me');
    await waitFor(() => stream.reads > 0, 'the request');
    await waitFor(() => bubbles().length === 1 && bubbles()[0].querySelector('canvas.orb'), 'the waiting bubble');
    const pev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    stream.push(pev('token', { content: 'Persona answer.' }) + pev('done', { finish_reason: 'stop' }));
    stream.end();
    await waitFor(() => !state.busy, 'the end of the turn');
    await tick(10);
    assert.strictEqual(bubbles().length, 1);
    assert.strictEqual(bubbles()[0].querySelector('.md').textContent.trim(), 'Persona answer.');
    assert.strictEqual($$('canvas.orb').length, 0);
  } finally {
    state.settings.provider = 'anthropic';
  }
});

