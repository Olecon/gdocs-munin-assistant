'use strict';
// A custom server's shared model-id prefix (src/settings.js modelPrefixOf, fullModelId, shortModelId, fetchAndCacheModels;
// src/transport.js sentBody): stored once on the account, the ids short everywhere (list, limits, the account's model,
// the chat's meta, the menu, the settings dropdown, the models tool), the request body with the full id; the other
// types' lists share no prefix. The models tool's providers listing and a provider's models by range (src/accounts.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('./lib/dom-sandbox');
const { deq, waitFor } = require('./lib/sandbox');
const { sseResponse } = require('./lib/streams');

let env, T, state, el, document, storage;
const BASE = 'https://ai.api.cloud.yandex.net/v1';
const FOLDER = 'gpt://b1gexamplefolder00000/';
const GPT = ['qwen3.6-35b-a3b/latest', 'yandexgpt/latest', 'yandexgpt/rc', 'yandexgpt-lite/latest', 'llama/latest', 'llama-lite/latest',
  'qwen3-235b-a22b-fp8/latest', 'gpt-oss-120b/latest', 'gpt-oss-20b/latest', 'gemma-3-27b-it/latest', 'deepseek-v3.2/latest',
  'qwen2.5-vl-32b/latest', 'aliceai-llm/latest', 'yandexgpt-5.1/latest', 'qwen3-coder/latest', 'kimi-k2/latest', 'glm-4.6/latest', 'mistral/latest'];
const EMB = ['text-search-doc/latest', 'text-search-query/latest', 'text-embeddings/latest', 'clip/latest', 'bge-m3/latest', 'e5/latest', 'emb-x/latest']
  .map((m) => 'emb://b1gexamplefolder00000/' + m);
const YANDEX = [...GPT.map((m) => FOLDER + m), ...EMB]; // 18 gpt + 7 emb, as Yandex AI Studio lists them
const listResponse = (data) => ({ ok: true, status: 200, json: async () => ({ object: 'list', data }), text: async () => '' });
const chatStream = (text) => sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const ya = () => state.settings.accounts.find((a) => a.id === 'ya');
async function chatSnap() {
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };
  return snap;
}

before(async () => {
  env = await load({ legacySettings: false, storage: { muninAccounts: [
    { id: 'm', type: 'munin', name: 'Munin', apiKey: 'k-m' },
    { id: 'o', type: 'openai', name: 'OpenAI', apiKey: 'sk-o', model: 'gpt-6-astra' },
    // stored before the prefix existed: a full model id and full limit keys
    { id: 'ya', type: 'custom', name: 'Yandex', apiKey: 'AQVN-key', baseUrl: BASE, model: FOLDER + 'qwen3.6-35b-a3b/latest',
      limits: { [FOLDER + 'yandexgpt/latest']: { context: 32768 } } },
  ] } });
  ({ T, state, el, document, storage } = env);
  env.ctx.fetch = async (url) => {
    if (url === BASE + '/models') return listResponse(YANDEX.map((id) => (id === FOLDER + 'qwen3.6-35b-a3b/latest' ? { id, max_model_len: 65536 } : { id })));
    throw new Error('unexpected fetch ' + url);
  };
});
after(() => env.close());

test('the prefix rule: the longest shared prefix ending at "/" or ":", else that of the most common scheme; none for the built-in types', () => {
  assert.strictEqual(T.modelPrefixOf(YANDEX), FOLDER); // the emb ids keep their full ids
  assert.strictEqual(T.modelPrefixOf(GPT.map((m) => FOLDER + m)), FOLDER);
  assert.strictEqual(T.modelPrefixOf(['org/a', 'org/b/c']), 'org/');
  assert.strictEqual(T.modelPrefixOf(['gpt-a', 'gpt-b']), ''); // "gpt-" is no boundary
  // OpenAI, Anthropic and Munin lists share none, alone or together
  const builtIn = [['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-mini', 'o3'], ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'], ['qwen3.8-27b']];
  for (const ids of [...builtIn, builtIn.flat()]) assert.strictEqual(T.modelPrefixOf(ids), '', ids.join());
  // one id, an id the prefix would empty, a short id with "://": no prefix
  assert.strictEqual(T.modelPrefixOf([FOLDER + 'a/latest']), '');
  assert.strictEqual(T.modelPrefixOf(['org/', 'org/a']), '');
  assert.strictEqual(T.modelPrefixOf(['x/a://b', 'x/c']), '');
  // fullModelId: ids with "://" are full; without a prefix nothing changes
  const a = { modelPrefix: FOLDER };
  deq([T.fullModelId(a, 'yandexgpt/latest'), T.fullModelId(a, EMB[0]), T.fullModelId({}, 'gpt-6-astra'), T.fullModelId(a, '')],
    [FOLDER + 'yandexgpt/latest', EMB[0], 'gpt-6-astra', '']);
  deq([T.shortModelId(a, FOLDER + 'yandexgpt/latest'), T.shortModelId(a, EMB[0]), T.shortModelId(a, 'x'), T.shortModelId(null, 'x')],
    ['yandexgpt/latest', EMB[0], 'x', 'x']);
});

test('stored shapes: modelPrefix only on custom accounts (a string up to 200), the model and the limit keys read short', () => {
  const [mu, cu, long] = T.sanitizeAccounts([
    { id: 'a', type: 'munin', name: 'M', apiKey: 'k', modelPrefix: 'x/' },
    { id: 'b', type: 'custom', name: 'C', apiKey: '', baseUrl: BASE, modelPrefix: FOLDER, model: FOLDER + 'llama/latest', limits: { [FOLDER + 'llama/latest']: { context: 8192 } } },
    { id: 'c', type: 'custom', name: 'D', apiKey: '', baseUrl: BASE, modelPrefix: 'p'.repeat(201) + '/' },
  ]);
  assert.ok(!('modelPrefix' in mu) && !('modelPrefix' in long));
  deq([cu.modelPrefix, cu.model, cu.limits], [FOLDER, 'llama/latest', { 'llama/latest': { context: 8192 } }]);
});

test('a fetched list: the prefix stored once, the list, the limits and the account\'s model short; the chat\'s meta read short; the body sends the full id', async () => {
  // the open chat's meta (no document in this panel: no chat store)
  state.chatId = state.chatId || 'c1';
  state.chats = [{ id: state.chatId, title: 'Chat', createdAt: 1, updatedAt: 1 }];
  const r = await T.checkModels('ya');
  assert.ok(r.ok);
  assert.strictEqual(ya().modelPrefix, FOLDER);
  deq(state.modelLists.ya, [...GPT, ...EMB]);
  deq(storage['muninModels:ya'], [...GPT, ...EMB]);
  assert.strictEqual(ya().model, 'qwen3.6-35b-a3b/latest');
  deq(ya().limits, { 'qwen3.6-35b-a3b/latest': { context: 65536 } });
  const stored = storage.muninAccounts.find((a) => a.id === 'ya');
  deq([stored.modelPrefix, stored.model], [FOLDER, 'qwen3.6-35b-a3b/latest']);
  // a chat meta from before the prefix: read short, its limits found
  await T.setChatModel('ya', 'yandexgpt/latest');
  const meta = state.chats.find((c) => c.id === state.chatId);
  meta.model = { accountId: 'ya', model: FOLDER + 'qwen3.6-35b-a3b/latest', at: 1 };
  deq(T.chatChoice(), { accountId: 'ya', model: 'qwen3.6-35b-a3b/latest' });
  assert.strictEqual(T.activeConfig().model, 'qwen3.6-35b-a3b/latest');
  assert.strictEqual(T.activeProvider().contextTokens, 65536);
  // setChatModel with a full id stores the short one
  await T.setChatModel('ya', FOLDER + 'yandexgpt/latest');
  deq([state.chats.find((c) => c.id === state.chatId).model.model, ya().model, state.settings.lastModel.model], ['yandexgpt/latest', 'yandexgpt/latest', 'yandexgpt/latest']);
  // the request is built with the short id; Chat Completions gets the full one
  const bodies = [];
  env.ctx.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return chatStream('Hi.'); };
  let snap = await chatSnap();
  let req = T.buildRequest('edit', snap);
  assert.strictEqual(req.body.model, 'yandexgpt/latest');
  await T.runStream(req, new env.window.AbortController().signal, snap, {});
  assert.strictEqual(bodies[0].model, FOLDER + 'yandexgpt/latest');
  // an id of the other scheme goes as listed
  await T.setChatModel('ya', EMB[2]);
  snap = await chatSnap();
  req = T.buildRequest('edit', snap);
  await T.runStream(req, new env.window.AbortController().signal, snap, {});
  assert.strictEqual(bodies[1].model, EMB[2]);
  // OpenAI is untouched
  await T.setChatModel('o', 'gpt-6-astra');
  snap = await chatSnap();
  assert.ok(!('modelPrefix' in snap.cfg));
  assert.strictEqual(T.buildRequest('edit', snap).body.model, 'gpt-6-astra');
});

test('the model menu and the settings dropdown show the short ids', async () => {
  await T.setChatModel('ya', 'yandexgpt/latest');
  click(el.chatModel);
  const picks = [...el.modelMenu.querySelectorAll('.model-group[data-account="ya"] .model-pick')];
  deq(picks.map((n) => n.dataset.model), [...GPT, ...EMB]);
  deq(picks.slice(0, 2).map((n) => n.textContent.replace('✓', '')), ['qwen3.6-35b-a3b/latest', 'yandexgpt/latest']);
  assert.ok(picks[1].classList.contains('active'));
  T.closeModelMenu();
  assert.strictEqual(el.chatModel.textContent.trim(), 'yandexgpt/latest');
  T.openSettings();
  const options = [...document.querySelectorAll('.provider-block[data-account="ya"] select.account-models option')].map((o) => o.textContent);
  deq(options, [...GPT, ...EMB]);
  T.closeSettings();
});

test('the models tool: providers with counts, a provider\'s models by range, switch by short id, full id or number', async () => {
  state.modelLists.m = ['qwen3.8-27b'];
  state.modelLists.o = ['gpt-6-astra', 'gpt-6.1-sol', 'o3'];
  state.settings.accounts.find((a) => a.id === 'm').health = { ok: true, models: 1, at: Date.now() }; // fresh: list asks nobody
  state.settings.accounts.find((a) => a.id === 'o').health = { ok: true, models: 3, at: Date.now() };
  await T.setChatModel('ya', 'qwen3.6-35b-a3b/latest');
  let snap = await chatSnap();
  const tool = (args) => T.modelsTool({ action: 'list', provider: null, from: null, to: null, model: null, max_tokens: null, temperature: null, ...args }, snap, 'manual');
  assert.strictEqual(await tool({}), [
    'Providers (this chat: Yandex / qwen3.6-35b-a3b/latest):',
    'Munin (ok, 1 model)',
    'OpenAI (ok, 3 models)',
    `Yandex (Custom, ok, 25 models)`,
    'List a provider\'s models with provider and from/to.',
  ].join('\n'));
  let out = (await tool({ provider: 'yandex' })).split('\n');
  assert.strictEqual(out[0], `Yandex: models 1–25 of 25:`);
  deq(out.slice(1, 3), ['1. qwen3.6-35b-a3b/latest*', '2. yandexgpt/latest']);
  assert.strictEqual(out.length, 26); // no trailing "list with from" line: weak models echoed it to the user
  out = (await tool({ provider: 'Yandex', from: 21 })).split('\n');
  deq(out, [`Yandex: models 21–25 of 25:`, ...EMB.slice(2).map((m, i) => `${21 + i}. ${m}`)]);
  assert.strictEqual(await tool({ provider: 'Yandex', from: 3, to: 3 }), `Yandex: model 3 of 25:\n3. yandexgpt/rc`);
  assert.strictEqual(await tool({ provider: 'custom', from: 5, to: 6 }), `Yandex: models 5–6 of 25:\n5. llama/latest\n6. llama-lite/latest`);
  assert.match(await tool({ provider: 'Yandex', from: 2, to: 25 }), /^Yandex: models 2–25 of 25:.*\n25\. emb:\/\/b1gexamplefolder00000\/[^\n]+$/s);
  assert.strictEqual(await tool({ provider: 'OpenAI' }), 'OpenAI: models 1–3 of 3:\n1. gpt-6-astra\n2. gpt-6.1-sol\n3. o3');
  assert.strictEqual(await tool({ provider: 'Nobody' }), 'Error: No provider "Nobody". Providers: Munin, OpenAI, Yandex.');
  assert.strictEqual(await tool({ provider: 'Yandex', from: 30 }), 'Error: Yandex has 25 models; from must be 1 to 25.');
  // the summary names the provider
  assert.strictEqual(T.extraTool('models').summary('models', { action: 'list', provider: 'Yandex' }), 'list Yandex');
  assert.strictEqual(T.extraTool('models').summary('models', { action: 'list', provider: null }), 'list');
  // switch: a short id, a full id, a number
  const sw = async (model) => (await T.modelsTool({ action: 'switch', model }, snap = await chatSnap(), 'manual'));
  assert.strictEqual((await sw('Yandex/yandexgpt/rc')).content, 'Switched this chat to Yandex/yandexgpt/rc; it answers from the next request.');
  assert.strictEqual(state.chats.find((c) => c.id === state.chatId).model.model, 'yandexgpt/rc');
  assert.strictEqual((await sw(`Yandex/${FOLDER}llama/latest`)).content, 'Switched this chat to Yandex/llama/latest; it answers from the next request.');
  assert.strictEqual((await sw('Yandex/2')).content, 'Switched this chat to Yandex/yandexgpt/latest; it answers from the next request.');
  assert.strictEqual(snap.cfg.model, 'yandexgpt/latest');
  assert.strictEqual(await sw('Yandex/99'), 'Error: Yandex has no model "99". List its models with provider "Yandex".');
});

test('a new server URL drops the prefix with the other answers; the account\'s model keeps its full id', async () => {
  await T.setChatModel('ya', 'yandexgpt/latest');
  env.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  T.openSettings();
  const url = document.querySelector('.provider-block[data-account="ya"] .account-url');
  url.value = 'https://other.example.com/v1';
  url.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  const status = document.querySelector('.provider-block[data-account="ya"] .model-row + .hint');
  await waitFor(() => /Could not|Chrome did not/.test(status.textContent), 'the check on the new server');
  assert.ok(!('modelPrefix' in ya()));
  assert.strictEqual(ya().model, FOLDER + 'yandexgpt/latest');
  T.closeSettings();
});
