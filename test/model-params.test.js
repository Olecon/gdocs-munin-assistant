'use strict';
// The user's settings per account, for all its models (src/settings.js params, providerFor; src/accounts.js models
// settings): the stored shape, the reply length (at least 256, at most half the window) and the temperature in every sampling profile, the
// request bodies of Munin, a custom server, OpenAI and Anthropic, the models tool's settings action (report, set, clear,
// unknown account) and its offer when the user's message is about tokens or the temperature.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { docBench } = require('./lib/context');

let env, T, state, storage;
const ACCOUNTS = [
  { id: 'mu', type: 'munin', name: 'Munin', apiKey: 'k-mu' },
  { id: 'oa', type: 'openai', name: 'OpenAI', apiKey: 'sk-oa', model: 'gpt-6.1-sol' },
  { id: 'an', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-an', model: 'claude-opus-5-5' },
  { id: 'cu', type: 'custom', name: 'Lab', apiKey: '', baseUrl: 'http://localhost:8080/v1', model: 'qwen', limits: { qwen: { context: 16384, reply: 2048 } } },
];
const acc = (id) => state.settings.accounts.find((a) => a.id === id);
const call = (id, args) => ({ id, type: 'function', function: { name: 'models', arguments: JSON.stringify({ action: 'settings', model: null, max_tokens: null, temperature: null, ...args }) } });
async function snapOn(accountId, model) {
  await T.setChatModel(accountId, model);
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };
  return snap;
}
const body = (snap) => T.buildRequest('edit', snap).body;

before(async () => {
  env = await load({ legacySettings: false });
  ({ T, state, storage } = env);
  const { doc } = docBench(env);
  doc.text = '# Report\n\nIntro text.';
  storage.muninAccounts = JSON.parse(JSON.stringify(ACCOUNTS));
  await T.loadSettings();
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.applyMode = 'manual';
  state.messages = [{ role: 'user', content: 'hello' }];
});

test('params: sanitized on load (whole positive tokens, temperature 0-2 rounded); the old per-model shape dropped; a type change drops them', async () => {
  const [a, b, c, d] = T.sanitizeAccounts([
    { id: 'x', type: 'openai', name: 'X', apiKey: 'k', params: { maxTokens: 2048, temperature: 0.333 } },
    { id: 'y', type: 'munin', name: 'Y', apiKey: 'k', params: { maxTokens: 1.5, temperature: 0 } },
    { id: 'z', type: 'munin', name: 'Z', apiKey: 'k', params: { maxTokens: -4, temperature: 3 } },
    { id: 'w', type: 'openai', name: 'W', apiKey: 'k', params: { 'gpt-4.1': { maxTokens: 2048, temperature: 0.3 } } },
  ]);
  deq(a.params, { maxTokens: 2048, temperature: 0.33 });
  deq(b.params, { temperature: 0 });
  assert.ok(!('params' in c));
  assert.ok(!('params' in d), 'the per-model shape goes silently');
  // a type change (no key, no URL yet) drops what belonged to the old type, the params too
  state.settings.accounts.push({ id: 'tmp', type: 'openai', name: 'OpenAI 2', apiKey: '', params: { maxTokens: 100 } });
  assert.strictEqual(await T.changeAccountType('tmp', 'anthropic'), true);
  assert.ok(!('params' in acc('tmp')));
  await T.removeAccount('tmp');
});

test('providerFor: the account\'s settings for every model; the reply length at least 256 and at most half the model\'s window; the temperature in every sampling profile; refused models get none', async () => {
  const mu = acc('mu');
  mu.params = { maxTokens: 50000, temperature: 0.2 };
  let p = T.providerFor(mu, 'qwen3.8-27b');
  assert.strictEqual(p.maxTokens, 32768); // half of 64k
  for (const profile of ['prose', 'tools', 'summary']) {
    const s = T.samplingFields(p, profile);
    assert.strictEqual(s.temperature, 0.2, profile);
    assert.strictEqual(s.top_k, 20, profile); // Munin's other fields stay
  }
  assert.strictEqual(T.samplingFields(p, 'tools').presence_penalty, 0);
  assert.strictEqual(T.PROVIDERS.munin.sampling.temperature, 0.7, 'the type table is untouched');
  assert.strictEqual(T.samplingFields(T.providerFor(mu, 'other-model')).temperature, 0.2, 'every model of the account');
  mu.params = { maxTokens: 10 };
  p = T.providerFor(mu, 'qwen3.8-27b');
  deq([p.maxTokens, T.samplingFields(p).temperature], [256, 0.7]);
  delete mu.params;
  assert.strictEqual(T.providerFor(mu, 'qwen3.8-27b'), T.PROVIDERS.munin, 'no settings: the type\'s entry');
  // a custom server: its own limits are the default, the user's value is capped by the model's window
  const cu = acc('cu');
  assert.strictEqual(T.defaultReplyTokens(cu, 'qwen'), 2048);
  cu.params = { maxTokens: 12000, temperature: 0.5 };
  p = T.providerFor(cu, 'qwen');
  deq([p.contextTokens, p.maxTokens, T.samplingFields(p, 'summary')], [16384, 8192, { temperature: 0.5 }]);
  delete cu.params;
  // OpenAI reasoning models and Claude models with adaptive thinking refuse a temperature: it is left out for them only
  const oa = acc('oa');
  oa.params = { temperature: 0.4 };
  deq(T.samplingFields(T.providerFor(oa, 'gpt-6.1-sol')), {});
  deq(T.samplingFields(T.providerFor(oa, 'gpt-4.1')), { temperature: 0.4 });
  delete oa.params;
  const an = acc('an');
  an.params = { temperature: 0.4 };
  deq(T.samplingFields(T.providerFor(an, 'claude-opus-5-5')), {});
  deq(T.samplingFields(T.providerFor(an, 'claude-haiku-4-5')), { temperature: 0.4 });
  delete an.params;
});

test('the request bodies: Chat Completions max_tokens and temperature (Munin, custom), Responses max_output_tokens and temperature, Messages max_tokens and temperature', async () => {
  acc('mu').params = { maxTokens: 3000, temperature: 0.25 };
  let b = body(await snapOn('mu', 'qwen3.8-27b'));
  deq([b.max_tokens, b.temperature, b.top_k], [3000, 0.25, 20]);
  delete acc('mu').params;
  b = body(await snapOn('mu', 'qwen3.8-27b'));
  deq([b.max_tokens, b.temperature], [8192, 0.6]); // the defaults (the writing profile in Auto, the prose one in Manual)
  acc('cu').params = { maxTokens: 1000, temperature: 1.1 };
  b = body(await snapOn('cu', 'qwen'));
  deq([b.max_tokens, b.temperature, 'top_k' in b], [1000, 1.1, false]);
  delete acc('cu').params;
  b = body(await snapOn('cu', 'qwen'));
  deq([b.max_tokens, 'temperature' in b], [2048, false]);
  // OpenAI: no temperature unless the user set one, and none for a reasoning model
  acc('oa').params = { maxTokens: 4000, temperature: 0.3 };
  b = body(await snapOn('oa', 'gpt-4.1'));
  deq([b.max_output_tokens, b.temperature], [4000, 0.3]);
  b = body(await snapOn('oa', 'gpt-6.1-sol'));
  deq([b.max_output_tokens, 'temperature' in b], [4000, false]);
  delete acc('oa').params;
  b = body(await snapOn('oa', 'gpt-6.1-sol'));
  deq([b.max_output_tokens, 'temperature' in b], [32000, false]);
  // Anthropic: the same; adaptive-thinking models get no temperature
  acc('an').params = { maxTokens: 6000, temperature: 0.9 };
  b = body(await snapOn('an', 'claude-haiku-4-5'));
  deq([b.max_tokens, b.temperature], [6000, 0.9]);
  b = body(await snapOn('an', 'claude-opus-5-5'));
  deq([b.max_tokens, 'temperature' in b], [6000, false]);
  delete acc('an').params;
  b = body(await snapOn('an', 'claude-opus-5-5'));
  deq([b.max_tokens, 'temperature' in b], [32000, false]);
});

test('models settings: report, set (stored on the account, this turn\'s provider updated), clear, refusals and an unknown account', async () => {
  state.modelLists = { oa: ['gpt-6.1-sol', 'gpt-4.1'] };
  let snap = await snapOn('oa', 'gpt-4.1');
  // report: both values null, the chat's provider
  let out = await T.executeTool(call('s1', {}), 'manual', snap, {});
  assert.strictEqual(out.content, 'OpenAI: max output tokens 32000 (default), temperature server default.');
  assert.ok(out._reading);
  // set: stored on the account, the snapshot's provider follows
  out = await T.executeTool(call('s2', { max_tokens: 2048, temperature: 0.3 }), 'manual', snap, {});
  assert.strictEqual(out.content, 'Set for OpenAI: max output tokens 2048, temperature 0.3; applies to all its models from the next request.');
  assert.ok(!out._reading);
  deq(storage.muninAccounts.find((a) => a.id === 'oa').params, { maxTokens: 2048, temperature: 0.3 });
  deq([snap.prov.maxTokens, T.samplingFields(snap.prov).temperature], [2048, 0.3]);
  // list tags the account, not its models
  for (const a of state.settings.accounts) a.health = { ok: true, models: 2, at: Date.now() }; // fresh marks: list asks nobody
  const listed = await T.modelsTool({ action: 'list', model: null }, snap, 'manual');
  for (const a of state.settings.accounts) delete a.health;
  assert.match(listed, /^OpenAI \(ok, 2 models\) \[max 2048, temp 0\.3\]$/m);
  assert.doesNotMatch(listed, /^Munin \(.*\[max/m);
  // another account by name (a "<account>/<model>" works too: the account part counts): stored there, this turn's provider unchanged
  out = await T.executeTool(call('s3', { model: 'Munin/qwen3.8-27b', temperature: 0.9 }), 'manual', snap, {});
  assert.strictEqual(out.content, 'Set for Munin: max output tokens 8192 (default), temperature 0.9; applies to all its models from the next request.');
  deq(acc('mu').params, { temperature: 0.9 });
  assert.strictEqual(snap.prov.maxTokens, 2048);
  // clear: 0 and -1 restore the defaults; the account's params go when empty
  out = await T.executeTool(call('s4', { max_tokens: 0, temperature: -1 }), 'manual', snap, {});
  assert.strictEqual(out.content, 'Set for OpenAI: max output tokens 32000 (default), temperature server default; applies to all its models from the next request.');
  assert.ok(!('params' in acc('oa')));
  assert.strictEqual(snap.prov.maxTokens, 32000);
  await T.executeTool(call('s5', { model: 'Munin', temperature: -1 }), 'manual', snap, {});
  assert.ok(!('params' in acc('mu')));
  // capped values and refused temperatures name the model they are shown for
  out = await T.executeTool(call('s6', { model: 'Munin', max_tokens: 100 }), 'manual', snap, {});
  assert.strictEqual(out.content, 'Set for Munin: max output tokens 256 for qwen3.8-27b (100 asked; kept between 256 and half the context window), temperature default; applies to all its models from the next request.');
  await T.executeTool(call('s7', { model: 'Munin', max_tokens: 0 }), 'manual', snap, {});
  snap = await snapOn('oa', 'gpt-6.1-sol');
  out = await T.executeTool(call('s8', { model: 'OpenAI' }), 'manual', snap, {});
  assert.strictEqual(out.content, 'OpenAI: max output tokens 32000 (default), temperature server default (not sent to gpt-6.1-sol: it refuses a temperature).');
  // refusals: an unknown account, values out of range
  assert.match((await T.executeTool(call('s10', { model: 'Nobody/x' }), 'manual', snap, {})).content, /^Error: No account "Nobody"/);
  assert.match((await T.executeTool(call('s11', { temperature: 2.5 }), 'manual', snap, {})).content, /^Error: temperature must be from 0 to 2/);
  assert.match((await T.executeTool(call('s12', { max_tokens: -5 }), 'manual', snap, {})).content, /^Error: max_tokens must be a whole number/);
  assert.ok(!('params' in acc('oa')));
  // the reading flag, the pending text and the summary follow the arguments
  assert.strictEqual(T.isExtraReading('models', { action: 'settings', model: null, max_tokens: null, temperature: null }), true);
  assert.strictEqual(T.isExtraReading('models', { action: 'settings', model: null, max_tokens: 0, temperature: null }), false);
  assert.strictEqual(T.pendingCardText('models', { action: 'settings', max_tokens: 1 }), 'Changing the provider settings…');
  assert.strictEqual(T.pendingCardText('models', '{"action":"switch","model":"a/b"}'), 'Switching the model…');
  assert.strictEqual(T.extraTool('models').summary('models', { action: 'settings', model: 'OpenAI' }), 'settings OpenAI');
  assert.strictEqual(T.extraTool('models').summary('models', { action: 'settings', model: null }), 'settings this provider');
});

test('models: the schema keeps every field required (strict) and compacts for Munin; offered with one model when the message is about tokens or the temperature', async () => {
  const params = T.MODELS_TOOL.function.parameters;
  deq(params.required, ['action', 'provider', 'from', 'to', 'model', 'max_tokens', 'temperature']);
  const compact = T.compactSchema(params);
  deq(compact.required, ['action']);
  deq([compact.properties.max_tokens.type, compact.properties.temperature.type], ['integer', 'number']);
  for (const w of ['Set max tokens to 2000', 'lower the temperature', 'max output please', 'увеличь лимит токенов', 'Температуру поменьше']) assert.ok(T.paramsMentioned(w), w);
  for (const w of ['Fix the intro', 'tokenize the text']) assert.ok(!T.paramsMentioned(w), w);
  // one usable model: offered only when the message asks
  const saved = state.settings.accounts.map((a) => ({ ...a }));
  const savedLists = state.modelLists;
  try {
    for (const a of state.settings.accounts) if (a.id !== 'mu') { a.apiKey = ''; delete a.baseUrl; }
    state.modelLists = { mu: [] };
    const snap = await snapOn('mu', 'qwen3.8-27b');
    // the newest user message of the chat decides (Munin: per message, on demand)
    const offered = (text) => {
      env.run(`sentText = ${JSON.stringify(text)}`);
      snap.chatCtx = { ...snap.chatCtx, messages: [{ role: 'user', content: text }] };
      return T.toolsFor('edit', snap).some((t) => t.function.name === 'models');
    };
    assert.strictEqual(offered('Fix the intro'), false);
    assert.strictEqual(offered('Use temperature 0.3 from now on'), true);
    assert.strictEqual(offered('поставь 4000 токенов'), true);
    assert.ok(!T.toolsFor('edit', { ...snap, agent: { task: 'x' } }).some((t) => t.function.name === 'models'), 'never to agents');
  } finally {
    state.settings.accounts.forEach((a, i) => { for (const k of Object.keys(a)) delete a[k]; Object.assign(a, saved[i]); });
    state.modelLists = savedLists;
    env.run('sentText = \'\'');
  }
});
