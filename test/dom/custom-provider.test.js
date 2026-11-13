'use strict';
// Custom (OpenAI-compatible) providers on a real DOM: the type in the new row's dropdown (changeable until a URL), its
// row (the server URL first, the key optional), the URL taken with or without /v1, the model list with and without a key (no Authorization header
// without one), the limits a list names, the requests (Chat Completions at <url>/chat/completions without Munin's
// fields), agents, the model menu and the health dot; the Google account row in the account rows' box.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, click, key } = require('../lib/dom-sandbox');
const { deq, waitFor } = require('../lib/sandbox');

let env, T, state, el, document, storage;
const calls = [];
const listResponse = (data) => ({ ok: true, status: 200, json: async () => ({ object: 'list', data }), text: async () => '' });
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBody = (sel) => {
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((r) => r[1].split(',').map((x) => x.trim()).includes(sel));
  return m ? m[2] : '';
};
const change = (input, value) => { input.value = value; input.dispatchEvent(new env.window.Event('change', { bubbles: true })); };

before(async () => {
  env = await load({ legacySettings: false, storage: { muninAccounts: [
    { id: 'm', type: 'munin', name: 'Munin', apiKey: 'k-m' },
    { id: 'cloud', type: 'custom', name: 'Cloud', apiKey: 'sk-c', baseUrl: 'https://llm.example.com/api/v1', model: 'big' },
  ] } });
  ({ T, state, el, document, storage } = env);
  env.ctx.fetch = async (url, init = {}) => {
    calls.push([url, (init.headers || {}).Authorization || null]);
    if (/\/models$/.test(url)) return listResponse([{ id: 'llama-4-8b', max_model_len: 8192 }, { id: 'qwen-coder', context_length: 131072, max_completion_tokens: 16384 }]);
    throw new Error('unexpected fetch ' + url);
  };
});
after(() => env.close());

let custom; // the account added in the first test

test('Add provider: Custom asks for the server URL first; the URL with or without /v1; the list without a key sends no Authorization', async () => {
  T.openSettings();
  click(el.addProviderBtn);
  change(document.querySelector('#settings .account-draft select.account-type'), 'custom');
  await waitFor(() => document.querySelectorAll('#settings .provider-block').length === 3 && state.settings.accounts.length === 3, 'the custom row');
  custom = state.settings.accounts[2];
  deq([custom.type, custom.name, custom.apiKey], ['custom', 'Custom', '']);
  const row = document.querySelector(`.provider-block[data-account="${custom.id}"]`);
  deq([...row.querySelectorAll('.provider-body input')].map((n) => n.className), ['account-name', 'account-url', 'account-key', 'account-max-tokens', 'account-temperature']);
  const url = row.querySelector('.account-url');
  assert.strictEqual(document.activeElement, url);
  assert.strictEqual(url.placeholder, 'http://localhost:8080/v1');
  assert.match(row.querySelector('.account-key').closest('label').textContent, /^API key \(optional\)/);
  const status = () => row.querySelector('.model-row + .hint').textContent;
  assert.strictEqual(status(), ''); // no prompt text: the empty URL field speaks for itself
  // Check provider without a URL asks for it; nothing is fetched
  click(row.querySelector('.account-check'));
  await waitFor(() => status() === 'Enter the server URL first.', 'the URL hint');
  assert.strictEqual(calls.length, 0);
  // not a URL: refused with an example
  change(url, 'localhost');
  await waitFor(() => status() === 'Enter a URL like http://localhost:8080/v1', 'the URL warning');
  // without /v1: kept with it, then checked on the new server without a key
  change(url, 'http://localhost:8080/');
  await waitFor(() => status() === '' && custom.health && custom.health.ok, 'the check'); // no text: the dot turns green
  assert.strictEqual(url.value, 'http://localhost:8080/v1');
  deq(calls, [['http://localhost:8080/v1/models', null]]);
  const stored = storage.muninAccounts.find((a) => a.id === custom.id);
  assert.strictEqual(stored.baseUrl, 'http://localhost:8080/v1');
  // the first listed model becomes the account's; the limits the list names are kept
  assert.strictEqual(stored.model, 'llama-4-8b');
  deq(stored.limits, { 'llama-4-8b': { context: 8192 }, 'qwen-coder': { context: 131072, reply: 16384 } });
  deq(state.modelLists[custom.id], ['llama-4-8b', 'qwen-coder']);
  // a pasted endpoint is the same server: nothing changes
  change(url, 'http://localhost:8080/v1/chat/completions');
  await waitFor(() => url.value === 'http://localhost:8080/v1', 'the normalized URL');
  assert.strictEqual(calls.length, 1);
  // an account with a key sends it
  calls.length = 0;
  await T.checkModels('cloud');
  deq(calls, [['https://llm.example.com/api/v1/models', 'Bearer sk-c']]);
  T.closeSettings();
});

test('the requests: Chat Completions at <url>/chat/completions without Munin\'s fields; the limits from the list, else 32k and 4,096', async () => {
  await T.setChatModel(custom.id, 'llama-4-8b');
  let snap = T.takeSnapshot(); T.snapshotDocument(snap);
  deq([snap.prov.id, snap.prov.contextTokens, snap.prov.maxTokens, snap.cfg.keyless], ['custom', 8192, 2048, true]); // a quarter of the window
  let req = T.buildRequest('edit', snap);
  deq([req.kind, req.url], ['chat', 'http://localhost:8080/v1/chat/completions']);
  assert.ok(!('Authorization' in req.headers));
  for (const k of ['persona', 'chat_template_kwargs', 'temperature', 'top_k', 'presence_penalty']) assert.ok(!(k in req.body), k);
  deq([req.body.model, req.body.max_tokens, req.body.stream], ['llama-4-8b', 2048, true]);
  assert.ok(req.body.tools.some((t) => t.function.name === 'replace_selection'));
  // the other request builders drop Munin's fields too
  for (const r of [T.buildSummaryRequest(snap, 'x'), T.chatTitleRequest(snap, 'x')]) {
    deq([r.kind, r.url, 'persona' in r.body, 'chat_template_kwargs' in r.body, 'Authorization' in r.headers], ['chat', 'http://localhost:8080/v1/chat/completions', false, false, false]);
  }
  // no personas, no web search, /code not offered
  assert.strictEqual(T.isMuninPersona('research', snap), false);
  assert.strictEqual(T.webSearchTurn('research', snap), false);
  assert.ok(T.commandUnavailable('code'));
  // a model whose limits the list names, and one it does not
  await T.setChatModel(custom.id, 'qwen-coder');
  snap = T.takeSnapshot();
  deq([snap.prov.contextTokens, snap.prov.maxTokens], [131072, 16384]);
  await T.setChatModel(custom.id, 'typed-model');
  snap = T.takeSnapshot();
  deq([snap.prov.contextTokens, snap.prov.maxTokens], [32768, 4096]);
  // with a key: the bearer header
  await T.setChatModel('cloud', 'big');
  snap = T.takeSnapshot(); T.snapshotDocument(snap);
  req = T.buildRequest('manual', snap);
  deq([req.url, req.headers.Authorization], ['https://llm.example.com/api/v1/chat/completions', 'Bearer sk-c']);
  // Munin keeps its own fields
  await T.setChatModel('m', 'qwen3.8-27b');
  snap = T.takeSnapshot(); T.snapshotDocument(snap);
  req = T.buildRequest('edit', snap);
  deq([req.body.persona, !!req.body.chat_template_kwargs], ['raw', true]);
});

test('agents run on a keyless custom server with its limits', () => {
  const main = T.takeSnapshot();
  assert.ok(T.keyedAccounts().some((a) => a.id === custom.id));
  const t = T.agentTarget('Custom/qwen-coder', main);
  deq([t.prov.id, t.prov.contextTokens, t.cfg.baseUrl, t.cfg.keyless, t.cfg.model], ['custom', 131072, 'http://localhost:8080/v1', true, 'qwen-coder']);
});

test('the model menu lists the custom accounts and their models; the health dot', async () => {
  await T.setChatModel(custom.id, 'llama-4-8b');
  click(el.chatModel);
  const menu = el.modelMenu;
  deq([...menu.querySelectorAll('.model-group-name')].map((n) => n.textContent), ['Munin', 'Cloud', 'Custom']);
  deq([...menu.querySelectorAll(`.model-group[data-account="${custom.id}"] .model-pick`)].map((n) => n.dataset.model), ['llama-4-8b', 'qwen-coder']);
  T.markAccountHealth(custom.id, Object.assign(new Error('x'), { network: true, cause: new Error('Failed to fetch') }));
  assert.ok(menu.querySelector(`.model-group[data-account="${custom.id}"] .health-dot`).classList.contains('down'));
  assert.ok(el.chatModel.classList.contains('down'));
  T.markAccountHealth(custom.id, null);
  assert.ok(!el.chatModel.classList.contains('down'));
  // an answer with its list cached: green in the menu and on the model button
  assert.ok(menu.querySelector(`.model-group[data-account="${custom.id}"] .health-dot`).classList.contains('ok'));
  assert.ok(el.chatModel.classList.contains('ok'));
  key(el.chatModel, 'Escape');
  assert.ok(menu.classList.contains('hidden'));
});

test('a row\'s type changes until it has a key or a URL: Munin to Custom brings the URL field first and the Custom key hint', async () => {
  T.openSettings();
  const rowOf = (id) => document.querySelector(`#settings .provider-block[data-account="${id}"]`);
  // the custom account has a URL: its type is text
  T.toggleAccountRow(custom.id, true);
  assert.ok(rowOf(custom.id).querySelector('select.account-type').classList.contains('hidden'));
  assert.strictEqual(rowOf(custom.id).querySelector('.account-type-fixed').textContent, 'Custom (OpenAI-compatible)');
  click(el.addProviderBtn);
  change(document.querySelector('#settings .account-draft select.account-type'), 'munin');
  await waitFor(() => state.settings.accounts.length === 4 && rowOf(state.settings.accounts[3].id), 'the Munin account');
  const id = state.settings.accounts[3].id;
  assert.strictEqual(storage.muninAccounts[3].name, 'Munin 2');
  deq([...rowOf(id).querySelectorAll('.provider-body input')].map((n) => n.className), ['account-name', 'account-key', 'account-max-tokens', 'account-temperature']);
  assert.strictEqual(rowOf(id).querySelector('.provider-body > label:first-child select.account-type').value, 'munin');
  change(rowOf(id).querySelector('select.account-type'), 'custom');
  await waitFor(() => storage.muninAccounts[3].type === 'custom', 'the new type stored');
  deq([storage.muninAccounts[3].name, storage.muninAccounts[3].apiKey], ['Custom 2', '']);
  deq([...rowOf(id).querySelectorAll('.provider-body input')].map((n) => n.className), ['account-name', 'account-url', 'account-key', 'account-max-tokens', 'account-temperature']);
  assert.strictEqual(rowOf(id).querySelector('.hint:not(.warn)').textContent, T.PROVIDERS.custom.keyHint);
  assert.strictEqual(rowOf(id).dataset.provider, 'custom');
  assert.strictEqual(document.activeElement, rowOf(id).querySelector('select.account-type'));
  // the URL fixes it
  change(rowOf(id).querySelector('.account-url'), 'http://localhost:9000');
  await waitFor(() => storage.muninAccounts[3].baseUrl === 'http://localhost:9000/v1', 'the URL stored');
  assert.ok(rowOf(id).querySelector('select.account-type').classList.contains('hidden'));
  // × removes it at once
  click(rowOf(id).querySelector('.account-remove'));
  await waitFor(() => storage.muninAccounts.length === 3 && !rowOf(id), 'the removed row');
  T.closeSettings();
});

test('the Google account row has the account rows\' box', () => {
  assert.ok(document.querySelector('#settings .google-row').classList.contains('settings-box'));
  const box = ruleBody('.settings-box');
  assert.strictEqual(box, ruleBody('.provider-block')); // one rule for both
  assert.match(box, /border: 1px solid var\(--border\)/);
  assert.match(box, /border-radius: var\(--radius\)/);
  assert.match(box, /padding:/);
});
