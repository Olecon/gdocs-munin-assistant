'use strict';
// The Send/Stop button holds no orb (jsdom): while a turn runs it is the Stop button (class "stopping", the stop square)
// and the orb is only at the message; after the turn the arrow is back; a click while running stops the turn.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev, sseResponse, textRound } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

let env, T, state, el;
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
});
after(() => env.close());

const msgStart = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } });
const block = (index, type) => ev('content_block_start', { type: 'content_block_start', index, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' } });
const delta = (index, d) => ev('content_block_delta', { type: 'content_block_delta', index, delta: d });
const idle = () => !state.busy && !el.action.classList.contains('stopping');

async function send(text) {
  await T.createChat();
  typeInto(el.input, text);
  key(el.input, 'Enter');
}

test('while a turn runs the button is Stop without an orb; the orb is at the message', async () => {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    return n++ === 0 ? stream.response : sseResponse(textRound('Done.'));
  };
  await send('Hello');
  await waitFor(() => el.action.classList.contains('stopping') && el.chat.querySelector('.msg.assistant canvas.orb'), 'the orb at the message');
  assert.strictEqual(el.action.querySelector('canvas'), null);
  assert.strictEqual(el.action.getAttribute('aria-label'), 'Stop generating');
  assert.ok(el.action.querySelector('.icon-stop'));
  stream.push(msgStart + block(0, 'text') + delta(0, { type: 'text_delta', text: 'Writing' }));
  await waitFor(() => el.chat.querySelector('.msg.assistant canvas.orb').dataset.orb === 'ribbon', 'the ribbon at the message');
  assert.strictEqual(el.action.querySelector('canvas'), null);
  stream.end();
  await waitFor(idle, 'idle');
  await tick(5);
  assert.ok(el.action.querySelector('.icon-send'));
  assert.strictEqual(el.action.querySelector('canvas'), null);
});

test('a click while running stops the turn', async () => {
  const stream = liveStream();
  env.ctx.fetch = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  await send('Think');
  await waitFor(() => stream.reads > 0 && el.action.classList.contains('stopping'), 'running');
  click(el.action);
  await waitFor(idle, 'stopped');
  await tick(5);
  assert.strictEqual(el.action.querySelector('canvas'), null);
  assert.ok([...el.chat.querySelectorAll('.msg.notice')].some((m) => m.textContent.includes('Stopped.')));
});
