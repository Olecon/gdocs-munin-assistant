'use strict';
// The chat probe in the settings row, on a real DOM (src/probe.js, settings.js runModelCheck): a key whose model list
// arrives but whose chat is refused gets the red status, the red dot and the tooltip "Not reachable: chat refused: …";
// the model label under the input says the same; Check provider with a chat that answers turns both green
// ("Reachable: N models, chat works").
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, typeInto } = require('../lib/dom-sandbox');
const { deq, waitFor } = require('../lib/sandbox');
const { sseResponse } = require('../lib/streams');

let env, T, state, document, el;
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const chatOk = () => sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: 'p' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
const row = (id) => document.querySelector(`#settings .provider-block[data-account="${id}"]`);
const statusOf = (id) => row(id).querySelector('.model-row + .hint');
const dotOf = (id) => row(id).querySelector('.health-dot');

before(async () => {
  env = await load({ legacySettings: false, chatProbe: true, storage: {
    muninAccounts: [{ id: 'mu', type: 'munin', name: 'Munin', apiKey: '' }],
    muninLastModel: { accountId: 'mu', model: 'qwen3.8-27b' },
  } });
  ({ T, state, document } = env);
  el = T.el;
});
after(() => env && env.close());

test('a key whose list arrives but whose chat is refused: red status, red dot and tooltips; Check provider with a chat that answers: green', async () => {
  let chat = () => json({ error: { message: 'account disabled' } }, 400);
  const sent = [];
  env.ctx.fetch = async (url, init = {}) => {
    sent.push([init.method || 'GET', url]);
    if (init.method === 'POST') return chat();
    return json({ data: [{ id: 'qwen3.8-27b' }] });
  };
  T.openSettings();
  typeInto(row('mu').querySelector('.account-key'), 'k-new');
  await waitFor(() => statusOf('mu').textContent.startsWith('Chat refused'), 'the refused chat');
  assert.strictEqual(statusOf('mu').textContent, 'Chat refused: HTTP 400: account disabled. The key works, but the server did not answer a chat request.');
  assert.ok(statusOf('mu').classList.contains('warn'));
  deq(sent, [['GET', 'https://api.muninai.org/v1/models'], ['POST', 'https://api.muninai.org/v1/chat/completions']]);
  deq([dotOf('mu').classList.contains('down'), dotOf('mu').classList.contains('ok')], [true, false]);
  assert.match(dotOf('mu').dataset.tip, /^Not reachable: chat refused: HTTP 400: account disabled \(checked /);
  assert.ok(el.chatModel.classList.contains('down'));
  assert.match(el.chatModel.dataset.tip, /\nNot reachable: chat refused: HTTP 400: account disabled \(checked /);
  assert.strictEqual(state.messages.length, 0); // nothing in the chat
  // Check provider: the list and the probe again; the chat answers
  chat = () => chatOk();
  click(row('mu').querySelector('.account-check'));
  await waitFor(() => dotOf('mu').classList.contains('ok') && !T.settingsForm.checking.mu, 'the green dot');
  deq([statusOf('mu').textContent, sent.length], ['', 4]);
  assert.match(dotOf('mu').dataset.tip, /^Reachable: 1 model, chat works \(checked /);
  assert.match(el.chatModel.dataset.tip, /\nReachable: 1 model, chat works \(checked /);
  T.closeSettings();
});
