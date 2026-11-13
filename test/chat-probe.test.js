'use strict';
// The chat probe of explicit provider checks (src/probe.js; settings.js runModelCheck and markAccountHealth;
// accounts.js models check and switch): one "ping" with a one-token reply cap per type; a refused chat marks the
// account down ("chat refused: …") although its model list arrived, a 401 removes the mark (a 403 is a refusal: the list accepted the key), a time-out says so;
// a model list alone never clears a refused mark, the probe or a chat request that got through does; list's refresh
// and the model menu send no probe.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { docBench } = require('./lib/context');
const { sseResponse, ev } = require('./lib/streams');

let env, T, state, storage, doc;
const ACCOUNTS = [
  { id: 'mu', type: 'munin', name: 'Munin', apiKey: 'k-mu-1234' },
  { id: 'o1', type: 'openai', name: 'OpenAI', apiKey: 'sk-one-5678', model: 'gpt-6.1-sol' },
  { id: 'an', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-9', model: 'claude-opus-5-5' },
  { id: 'cu', type: 'custom', name: 'Lab', apiKey: '', baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen' },
];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const modelList = (ids) => json({ data: ids.map((id) => ({ id })) });
const refusal = (status, message) => json({ error: { message } }, status);
const chatOk = () => sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: 'p' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
const responsesOk = () => sseResponse(ev('response.completed', { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }));
const modelsCall = (id, action, model = null) => ({ id, type: 'function', function: { name: 'models', arguments: JSON.stringify({ action, model }) } });
const acc = (id) => state.settings.accounts.find((a) => a.id === id);
const clearHealth = () => { for (const a of state.settings.accounts) delete a.health; };
async function chatSnap() {
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };
  return snap;
}
// A server per account: GET /models answers the list; a POST (the probe) answers chat(account id, url, body).
function servers(chat) {
  const sent = [];
  env.ctx.fetch = async (url, init = {}) => {
    const id = url.startsWith('https://api.muninai.org/') ? 'mu' : url.startsWith('https://api.openai.com/') ? 'o1'
      : url.startsWith('https://api.anthropic.com/') ? 'an' : 'cu';
    if (init.method !== 'POST') return modelList({ mu: ['qwen3.8-27b'], o1: ['gpt-6.1-sol', 'gpt-6-mini'], an: ['claude-opus-5-5'], cu: ['qwen'] }[id]);
    const body = JSON.parse(init.body);
    sent.push([id, url, body]);
    return chat(id, url, body, init);
  };
  return sent;
}

before(async () => {
  env = await load({ legacySettings: false, chatProbe: true });
  ({ T, state, storage } = env);
  ({ doc } = docBench(env));
  doc.text = 'Intro text.';
  storage.muninAccounts = JSON.parse(JSON.stringify(ACCOUNTS));
  await T.loadSettings();
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  await T.setChatModel('o1', 'gpt-6.1-sol');
});

test('the probe request per type: "ping", a one-token cap (OpenAI 16), no system prompt and no tools; Munin on the raw path', () => {
  const req = (id) => T.probeRequest({ prov: T.providerFor(acc(id)), cfg: T.accountConfig(acc(id)) });
  const mu = req('mu');
  deq([mu.kind, mu.url], ['chat', 'https://api.muninai.org/v1/chat/completions']);
  deq(mu.body, { model: 'qwen3.8-27b', persona: 'raw', max_tokens: 1, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'ping' }], chat_template_kwargs: { reasoning_effort: 'low' } });
  const cu = req('cu');
  deq([cu.url, cu.body], ['http://10.0.0.5:8000/v1/chat/completions', { model: 'qwen', max_tokens: 1, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'ping' }] }]);
  assert.ok(!('Authorization' in cu.headers)); // a keyless server
  const oa = req('o1');
  deq([oa.kind, oa.url, oa.body.input, oa.body.max_output_tokens, oa.body.store, 'instructions' in oa.body, 'tools' in oa.body],
    ['responses', 'https://api.openai.com/v1/responses', [{ role: 'user', content: 'ping' }], 16, false, false, false]);
  const an = req('an');
  deq([an.kind, an.url, an.body], ['anthropic', 'https://api.anthropic.com/v1/messages', { model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }], stream: true }]);
  assert.strictEqual(an.headers['x-api-key'], 'sk-ant-9');
});

test('models check: the list and then the probe; a refused chat is down although the list arrived, a 401 is a rejected key and a 403 a refusal, a chat that answers says so', async () => {
  clearHealth();
  const sent = servers((id) => (id === 'mu' ? refusal(400, 'account disabled') : id === 'an' ? refusal(401, 'bad key')
    : id === 'o1' ? responsesOk() : chatOk()));
  const before = state.messages.length;
  const out = await T.executeTool(modelsCall('pc1', 'check'), 'edit', await chatSnap(), {});
  const lines = out.content.split('\n');
  assert.strictEqual(lines[1], 'Munin (down: no chat answer)'); // the reason in plain words: the model relays it
  assert.strictEqual(lines[2], 'OpenAI (reachable, 2 models, chat works)');
  assert.strictEqual(lines[3], 'Anthropic (key rejected)');
  assert.strictEqual(lines[4], 'Lab (Custom, reachable, 1 model, chat works)');
  deq(sent.map(([id, , body]) => [id, body.model]).sort(), [['an', 'claude-opus-5-5'], ['cu', 'qwen'], ['mu', 'qwen3.8-27b'], ['o1', 'gpt-6.1-sol']]);
  deq([acc('mu').health.down, acc('mu').health.chat, acc('mu').health.error], [true, false, 'chat refused: HTTP 400: account disabled']);
  deq([acc('o1').health.ok, acc('o1').health.models, acc('o1').health.chat], [true, 2, true]);
  assert.strictEqual(acc('an').health, undefined); // a rejected key: unknown, as for the model list
  assert.match(T.healthTitle(acc('mu')), /^Not reachable: chat refused: HTTP 400: account disabled \(checked /);
  assert.match(T.healthTitle(acc('o1')), /^Reachable: 2 models, chat works \(checked /);
  deq(storage.muninAccounts.find((a) => a.id === 'mu').health.chat, false); // stored
  assert.strictEqual(state.messages.length, before); // nothing in the history
});

test('a refused mark: list\'s refresh asks /models only and keeps it; a probe or a chat request that got through clears it', async () => {
  const sent = servers(() => chatOk());
  const out = await T.executeTool(modelsCall('pc2', 'list'), 'edit', await chatSnap(), {});
  assert.match(out.content, /\nMunin \(down: no chat answer\)/);
  deq([sent.length, acc('mu').health.down], [0, true]); // no probe, and the arrived list does not turn it green
  T.markAccountHealth('mu', 1);
  T.markAccountHealth('mu', Object.assign(new Error('x'), { status: 429 }));
  deq([acc('mu').health.down, acc('mu').health.chat], [true, false]);
  T.markAccountHealth('mu', null); // a chat request of the user's turn that got through (transport.js postJson)
  deq([acc('mu').health.ok, acc('mu').health.models, acc('mu').health.chat], [true, 1, true]);
  // a list refresh keeps the chat flag of an ok mark
  T.markAccountHealth('mu', 1);
  deq([acc('mu').health.ok, acc('mu').health.chat], [true, true]);
  clearHealth();
});

test('models switch: the target answers the probe first; a refused or rejected chat refuses the switch, a fresh mark with a chat answer is not asked again', async () => {
  await T.setChatModel('o1', 'gpt-6.1-sol');
  let answer = () => refusal(400, 'account disabled');
  const sent = servers((id) => answer(id));
  const keep = JSON.stringify(state.chats.find((c) => c.id === state.chatId).model);
  let out = await T.executeTool(modelsCall('ps1', 'switch', 'Munin/qwen3.8-27b'), 'manual', await chatSnap(), {});
  assert.strictEqual(out.content, 'Munin is not reachable; this chat stays on OpenAI/gpt-6.1-sol.');
  deq([out._ok, sent.length], [false, 1]);
  answer = () => refusal(403, 'account disabled');
  out = await T.executeTool(modelsCall('ps2', 'switch', 'Munin/qwen3.8-27b'), 'manual', await chatSnap(), {});
  assert.strictEqual(out.content, 'Munin is not reachable; this chat stays on OpenAI/gpt-6.1-sol.');
  assert.match(state.settings.accounts.find((x) => x.id === 'mu').health.error, /^chat refused: HTTP 403: account disabled$/); // the reason: in the mark only
  assert.strictEqual(JSON.stringify(state.chats.find((c) => c.id === state.chatId).model), keep);
  // a fresh ok mark from a model list alone (no chat answer yet) is probed as well; the chat answers: switched
  acc('mu').health = { ok: true, models: 1, at: Date.now() };
  answer = () => chatOk();
  out = await T.executeTool(modelsCall('ps3', 'switch', 'Munin/qwen3.8-27b'), 'manual', await chatSnap(), {});
  assert.match(out.content, /^Switched this chat to Munin\/qwen3\.8-27b/);
  deq([sent.length, acc('mu').health.chat], [3, true]);
  // back and forth: a fresh mark with a chat answer is not asked again
  acc('o1').health = { ok: true, models: 2, chat: true, at: Date.now() };
  out = await T.executeTool(modelsCall('ps4', 'switch', 'OpenAI/gpt-6.1-sol'), 'manual', await chatSnap(), {});
  assert.match(out.content, /^Switched this chat to OpenAI\/gpt-6\.1-sol/);
  assert.strictEqual(sent.length, 3);
  clearHealth();
});

test('a probe that gets no answer in time: chat refused with "no answer in N s", the row says the chat was refused', async () => {
  const sent = servers((id, url, body, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const alive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer does not keep Node's event loop alive
  const r = await T.checkModels('cu', { probe: true, timeoutMs: 1000 });
  clearTimeout(alive);
  deq([r.ok, r.chatRefused, sent.length], [false, 'no answer in 1 s', 1]);
  deq([acc('cu').health.down, acc('cu').health.error], [true, 'chat refused: no answer in 1 s']);
  assert.strictEqual(r.error, 'Chat refused: no answer in 1 s. The key works, but the server did not answer a chat request.');
  // the model menu's check (no probe) leaves it
  const before = sent.length;
  await T.checkModels('cu', {});
  deq([sent.length, acc('cu').health.down], [before, true]);
  clearHealth();
});
