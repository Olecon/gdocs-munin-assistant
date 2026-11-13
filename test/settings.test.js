'use strict';
// Settings: the accounts (defaults and storage keys, the one-time migration of the per-type settings, several accounts
// of one type, names, the Munin server URL, removal), the settings form with its key check and model lists, the modes,
// the Anthropic model list, the References grant.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let env, T, C2, state, sandbox, storage, timers;
const modelsResponse = (ids, status = 200) => ({ ok: status < 300, status, json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), text: async () => JSON.stringify({ error: { message: 'Invalid API key.' } }) });
const pause = (ms = 10) => new Promise((r) => setTimeout(r, ms));
// A panel without the emulated per-type settings (test/lib/legacy-settings.js): the accounts as they are.
const fresh = async (storageItems = {}) => {
  const e = await load({ legacySettings: false });
  Object.assign(e.storage, storageItems);
  await e.T.loadSettings();
  return e;
};

before(async () => {
  env = await load({ legacySettings: false });
  T = C2 = env.T;
  state = env.state;
  sandbox = env.ctx;
  storage = env.storage;
  timers = env.timers;
});

test('settings defaults + storage keys', () => {
  deq(state.settings, { accounts: [], lastModel: null, references: false });
  deq([T.ACCOUNTS_KEY, T.LAST_MODEL_KEY, T.modelsKey('a1')], ['muninAccounts', 'muninLastModel', 'muninModels:a1']);
  for (const k of ['muninApiKey', 'muninModel', 'openaiApiKey', 'openaiModel', 'anthropicApiKey', 'anthropicModel', 'muninProvider', 'muninModels', 'openaiModels', 'anthropicModels', 'openaiBaseUrl', 'anthropicEffort']) {
    assert.ok(T.STALE_SETTING_KEYS.includes(k), k);
  }
  assert.ok(Object.values(T.PROVIDERS).every((p) => !('effort' in p)));
  deq(Object.values(T.PROVIDERS).map((p) => p.name), ['Munin', 'OpenAI', 'Anthropic', 'Custom']);
  // no account: no chat choice, the default type, an empty config
  assert.strictEqual(T.chatChoice(), null);
  assert.strictEqual(T.activeProvider().id, 'munin');
  deq(T.activeConfig(), { apiKey: '', model: '', accountId: null, name: '' });
});

test('migration: the per-type keys become accounts once, the chat provider and its model the last choice; the old keys go', async () => {
  const e = await fresh({
    muninApiKey: 'k-munin-OLD', muninModel: 'qwen3.8-27b', muninProvider: 'anthropic', anthropicApiKey: ' sk-ant-1 ',
    anthropicModel: ' claude-sonnet-5-5 ', muninModels: ['qwen3.8-27b', 7, ' x-model '], openaiModel: 'gpt-6-astra', openaiModels: ['gpt-6-astra'],
  });
  const st = e.state;
  deq(st.settings.accounts, [
    { id: 'munin', type: 'munin', name: 'Munin', apiKey: 'k-munin-OLD', model: 'qwen3.8-27b' },
    { id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-1', model: 'claude-sonnet-5-5' },
  ]); // OpenAI had a model but no key: no account
  deq(st.settings.lastModel, { accountId: 'anthropic', model: 'claude-sonnet-5-5' });
  deq(e.T.chatChoice(), { accountId: 'anthropic', model: 'claude-sonnet-5-5' }); // the chats without a model of their own
  assert.strictEqual(e.T.activeProvider().id, 'anthropic');
  deq(e.T.activeConfig(), { apiKey: 'sk-ant-1', model: 'claude-sonnet-5-5', accountId: 'anthropic', name: 'Anthropic' });
  deq(st.modelLists.munin, ['qwen3.8-27b', 'x-model']); // the cached list moved to the account
  deq(e.storage['muninModels:munin'], ['qwen3.8-27b', 'x-model']);
  for (const k of ['muninApiKey', 'muninModel', 'muninProvider', 'anthropicApiKey', 'anthropicModel', 'muninModels', 'openaiModel', 'openaiModels']) assert.ok(!(k in e.storage), k);
  deq(e.storage.muninAccounts.map((a) => a.id), ['munin', 'anthropic']);
  // once: old keys written again by an older panel are dropped, the accounts stay
  e.storage.openaiApiKey = 'sk-late';
  await e.T.loadSettings();
  deq(st.settings.accounts.map((a) => a.id), ['munin', 'anthropic']);
  assert.ok(!('openaiApiKey' in e.storage));
  // a chat provider without a key: the first type with one (PROVIDER_IDS order) is the last choice
  const e2 = await fresh({ muninProvider: 'munin', openaiApiKey: 'sk-o', anthropicApiKey: 'sk-ant-x' });
  deq(e2.state.settings.lastModel, { accountId: 'openai', model: 'gpt-6.1-sol' });
  // a fresh install stores nothing
  const e3 = await fresh();
  assert.ok(!('muninAccounts' in e3.storage) && !('muninLastModel' in e3.storage));
  deq(e3.state.settings.accounts, []);
});

test('a failed migration keeps the old keys for the next load (the other stale keys go)', async () => {
  const e = await load({ legacySettings: false });
  Object.assign(e.storage, { muninApiKey: 'k-old', muninModel: 'qwen3.8-27b', muninProvider: 'munin', muninModels: ['qwen3.8-27b'], muninConfirmEdits: true });
  const set = e.chrome.storage.local.set;
  e.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await e.T.loadSettings();
  deq(e.state.settings.accounts, []);
  for (const k of ['muninApiKey', 'muninModel', 'muninProvider', 'muninModels']) assert.ok(k in e.storage, k);
  assert.ok(!('muninConfirmEdits' in e.storage)); // not a migration input
  // storage works again: the next load migrates them and only then they go
  e.chrome.storage.local.set = set;
  await e.T.loadSettings();
  deq(e.state.settings.accounts.map((a) => [a.id, a.apiKey]), [['munin', 'k-old']]);
  for (const k of ['muninApiKey', 'muninModel', 'muninProvider', 'muninModels']) assert.ok(!(k in e.storage), k);
});

test('stored accounts are sanitized: unknown types dropped, ids and names unique, the URL only for Custom', async () => {
  const e = await fresh({ muninAccounts: [
    { id: 'a1', type: 'openai', name: 'Work', apiKey: ' sk-1 ', baseUrl: 'https://proxy.example.org/v1' },
    { id: 'a2', type: 'openai', name: 'work', apiKey: 'sk-2' },
    { id: 'a1', type: 'anthropic', name: 'dup id', apiKey: 'x' },
    { id: 'a3', type: 'gemini', name: 'G', apiKey: 'g' },
    { id: 'a4', type: 'munin', name: 'Lab/server', apiKey: 'k', baseUrl: 'https://lab.example.org/v1/', health: { down: true, error: 'HTTP 502', at: 5 } },
    { id: 'a5', type: 'munin', name: '', apiKey: 'k2', baseUrl: 'https://api.muninai.org/v1' },
    { id: 'a6', type: 'munin', name: 'Bad URL', apiKey: 'k3', baseUrl: 'not a url' },
  ] });
  deq(e.state.settings.accounts, [
    { id: 'a1', type: 'openai', name: 'Work', apiKey: 'sk-1' },
    { id: 'a2', type: 'openai', name: 'work 2', apiKey: 'sk-2' },
    { id: 'a4', type: 'munin', name: 'Lab server', apiKey: 'k', health: { down: true, error: 'HTTP 502', at: 5 } }, // Munin's server is fixed: its URL is dropped
    { id: 'a5', type: 'munin', name: 'Munin', apiKey: 'k2' },
    { id: 'a6', type: 'munin', name: 'Bad URL', apiKey: 'k3' },
  ]);
});

test('settings form: Add provider, two accounts of one type, keys checked after the pause, names unique, Remove at once', async () => {
  const e = await fresh();
  const { T: X, state: st, storage: store } = e;
  const calls = [];
  e.ctx.fetch = async (url, init) => { calls.push([url, init.headers.Authorization || init.headers['x-api-key']]); return modelsResponse(['gpt-6.1-sol', 'gpt-6-mini']); };
  X.openSettings();
  assert.strictEqual(X.settingsForm.rows.size, 0);
  assert.strictEqual(X.el.accountList.children[0].textContent, 'No provider yet: add one below and paste its API key.');
  const a = await X.addAccount('openai');
  const b = await X.addAccount('openai');
  deq([a.name, b.name], ['OpenAI', 'OpenAI 2']);
  assert.notStrictEqual(a.id, b.id);
  deq(store.muninAccounts.map((x) => [x.type, x.name, x.apiKey]), [['openai', 'OpenAI', ''], ['openai', 'OpenAI 2', '']]); // stored at once
  const row = (id) => X.formRow(id);
  assert.strictEqual(row(a.id).apiKey.placeholder, 'sk-...');
  assert.ok(!row(a.id).keyHint.classList.contains('hidden')); // where to get a key, while there is none
  assert.strictEqual(row(a.id).url, undefined); // the server URL is Munin's only
  assert.strictEqual(row(a.id).modelSelect.disabled, true); // no list yet
  // a key is stored after the typing pause, then checked with that key
  row(a.id).apiKey.value = ' sk-ONE ';
  X.onApiKeyInput(a.id);
  assert.strictEqual(st.settings.accounts[0].apiKey, '');
  await pause(800);
  deq(calls, [['https://api.openai.com/v1/models', 'Bearer sk-ONE']]);
  assert.strictEqual(st.settings.accounts[0].apiKey, 'sk-ONE');
  assert.strictEqual(row(a.id).modelStatus.textContent, ''); // no text: the dot turns green
  deq(st.modelLists[a.id], ['gpt-6.1-sol', 'gpt-6-mini']);
  deq(store[`muninModels:${a.id}`], ['gpt-6.1-sol', 'gpt-6-mini']);
  assert.strictEqual(row(a.id).modelSelect.disabled, false); // a pick there is the open chat's (test/dom/model-pick.test.js)
  deq(st.settings.lastModel, { accountId: a.id, model: 'gpt-6.1-sol' }); // no account could answer before: the chat took this one
  // the second account: its own key, left with blur
  row(b.id).apiKey.value = 'sk-TWO';
  X.onApiKeyInput(b.id);
  await X.onApiKeyBlur(b.id);
  deq(calls[1], ['https://api.openai.com/v1/models', 'Bearer sk-TWO']);
  assert.strictEqual(await X.onApiKeyBlur(b.id), null); // nothing waits any more
  // a name: cleaned, unique, stored
  row(b.id).name.value = '  openai ';
  await X.onNameChange(b.id);
  assert.strictEqual(st.settings.accounts[1].name, 'openai 2');
  row(b.id).name.value = 'Team/Lab';
  await X.onNameChange(b.id);
  assert.strictEqual(st.settings.accounts[1].name, 'Team Lab');
  assert.strictEqual(row(b.id).name.value, 'Team Lab');
  assert.strictEqual(store.muninAccounts[1].name, 'Team Lab');
  // a wrong prefix warns
  row(b.id).apiKey.value = 'wrong';
  X.onApiKeyInput(b.id);
  assert.ok(!row(b.id).keyWarn.classList.contains('hidden'));
  await X.onApiKeyBlur(b.id);
  // Remove removes the account at once: its key, its list and its row
  assert.strictEqual(row(b.id).confirm, undefined); // no confirmation step
  store[`muninModels:${b.id}`] = ['x'];
  await X.removeAccount(b.id);
  deq(st.settings.accounts.map((x) => x.id), [a.id]);
  deq(store.muninAccounts.map((x) => x.id), [a.id]);
  assert.ok(!(`muninModels:${b.id}` in store) && !(b.id in st.modelLists));
  assert.strictEqual(X.settingsForm.rows.size, 1);
  X.closeSettings();
});

test('settings form: closing stores the keys still waiting, their checks report in the chat; an emptied key is not checked', async () => {
  const e = await fresh({ muninAccounts: [{ id: 'm1', type: 'munin', name: 'Munin', apiKey: '' }, { id: 'n1', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-OLD' }] });
  const { T: X, state: st, storage: store } = e;
  X.openSettings();
  X.el.chat.children.length = 0;
  e.ctx.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  X.formRow('n1').apiKey.value = 'sk-ant-BAD';
  X.onApiKeyInput('n1');
  X.closeSettings();
  assert.ok(X.el.settings.classList.contains('hidden'));
  await pause();
  assert.strictEqual(store.muninAccounts[1].apiKey, 'sk-ant-BAD');
  assert.strictEqual(X.el.chat.children.filter((c) => c.classList.contains('settings-error') && /HTTP 401/.test(c.innerHTML)).length, 1);
  assert.ok(/^Could not get the model list/.test(X.formRow('n1').modelStatus.textContent));
  assert.strictEqual(st.settings.accounts[1].health, undefined); // a refused key is no outage
  // a working key of the chat's account removes the "fix your settings" errors
  X.openSettings();
  e.ctx.fetch = async () => modelsResponse(['claude-opus-5-5']);
  X.formRow('n1').apiKey.value = 'sk-ant-GOOD';
  X.onApiKeyInput('n1');
  await X.onApiKeyBlur('n1');
  assert.ok(!X.el.chat.children.some((c) => c.classList.contains('settings-error')));
  // an emptied key: stored, no request
  let asked = false;
  e.ctx.fetch = async () => { asked = true; return modelsResponse([]); };
  X.formRow('m1').apiKey.value = '';
  X.onApiKeyInput('m1');
  await X.onApiKeyBlur('m1');
  assert.strictEqual(asked, false);
  assert.strictEqual(await X.checkModels('m1').then((r) => r.noKey), true);
  assert.strictEqual(X.formRow('m1').modelStatus.textContent, 'Enter the API key first.');
  // saveSettings (the panel goes away) stores a waiting key without a check
  X.formRow('m1').apiKey.value = 'k-late';
  X.onApiKeyInput('m1');
  await X.saveSettings();
  assert.strictEqual(store.muninAccounts[0].apiKey, 'k-late');
  assert.strictEqual(asked, false);
  X.closeSettings();
});

test('a check asked for during a check runs after it with the newest key', async () => {
  const e = await fresh({ muninAccounts: [{ id: 'm1', type: 'munin', name: 'Munin', apiKey: 'k1' }] });
  const { T: X } = e;
  X.openSettings();
  const calls = [];
  let release;
  e.ctx.fetch = async (url, init) => { calls.push(init.headers.Authorization); await new Promise((r) => { release = r; }); return modelsResponse(['m-a', 'm-b']); };
  const first = X.checkModels('m1');
  X.formRow('m1').apiKey.value = 'k2';
  const second = X.commitApiKey('m1'); // stores k2, then checks: queued behind the running check
  await pause();
  deq(calls, ['Bearer k1']);
  release();
  await first;
  await pause();
  deq(calls, ['Bearer k1', 'Bearer k2']);
  release();
  await second;
  assert.strictEqual(X.formRow('m1').modelStatus.textContent, '');
  X.closeSettings();
});

test('the type of an account changes until it has a key or a URL; a name of the old type follows, a name of its own stays', async () => {
  const e = await fresh({ muninAccounts: [{ id: 'o1', type: 'openai', name: 'OpenAI', apiKey: 'sk-x' }] });
  const { T: X, state: st, storage: store } = e;
  X.openSettings();
  const a = await X.addAccount('openai');
  assert.strictEqual(a.name, 'OpenAI 2');
  assert.ok(!X.formRow(a.id).typeSelect.classList.contains('hidden') && X.formRow(a.id).typeFixed.classList.contains('hidden'));
  assert.ok(X.formRow('o1').typeSelect.classList.contains('hidden')); // keyed: the type is text
  assert.strictEqual(X.formRow('o1').typeFixed.textContent, 'OpenAI');
  assert.strictEqual(await X.changeAccountType('o1', 'munin'), false);
  // no key, no URL: the type changes; the old type's leftovers go; the name follows
  a.model = 'gpt-6-mini';
  st.modelLists[a.id] = ['gpt-6-mini'];
  store[`muninModels:${a.id}`] = ['gpt-6-mini'];
  assert.strictEqual(await X.changeAccountType(a.id, 'custom'), true);
  const stored = () => store.muninAccounts.find((x) => x.id === a.id);
  deq([stored().type, stored().name, stored().model], ['custom', 'Custom', undefined]);
  assert.ok(!(`muninModels:${a.id}` in store));
  deq(st.modelLists[a.id], []);
  const r = X.formRow(a.id);
  assert.ok(r.url && r.block.dataset.provider === 'custom'); // the row follows the type: the URL field, the key hint
  assert.strictEqual(r.keyHint.textContent, X.PROVIDERS.custom.keyHint);
  assert.strictEqual(r.typeSelect.value, 'custom');
  // a name of its own stays
  r.name.value = 'Lab';
  await X.onNameChange(a.id);
  await X.changeAccountType(a.id, 'anthropic');
  deq([stored().type, stored().name], ['anthropic', 'Lab']);
  // a typed key fixes it at once (before the pause), the stored key too
  X.formRow(a.id).apiKey.value = 'sk-ant-k';
  X.onApiKeyInput(a.id);
  assert.ok(X.formRow(a.id).typeSelect.classList.contains('hidden'));
  assert.strictEqual(await X.changeAccountType(a.id, 'munin'), false);
  assert.strictEqual(stored().type, 'anthropic');
  await X.saveSettings();
  X.closeSettings();
});

test('the modes: cycleApplyMode goes Manual -> Auto -> Plan -> Manual, persisted, unknown values, disabled while busy', async () => {
  C2.applyApplyMode('manual');
  assert.strictEqual(state.applyMode, 'manual');
  assert.strictEqual(T.el.modeLabel.textContent, 'Manual');
  assert.strictEqual(T.el.modeCycle.dataset.tip, 'Choose the mode');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await C2.cycleApplyMode();
    seen.push([state.applyMode, storage.muninApplyMode, T.el.modeLabel.textContent, T.el.modeCycle.dataset.mode]);
  }
  deq(seen, [['auto', 'auto', 'Auto', 'auto'], ['plan', 'plan', 'Plan', 'plan'], ['manual', 'manual', 'Manual', 'manual']]);
  // Manual and Auto both run editing turns (Manual asks before each write: turn.js snap.askEdits)
  deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [false, false, 'edit']);
  await C2.setApplyMode('auto'); deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [true, false, 'edit']);
  await C2.setApplyMode('plan'); deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [false, true, 'plan']);
  deq(['manual', 'auto', 'plan', 'x'].map((m) => C2.applyTurnMode(m)), ['edit', 'edit', 'plan', 'edit']);
  // the mode a stored message was sent with (Continue, the chat export)
  deq([{ role: 'user', _mode: 'edit', _asks: true }, { role: 'user', _mode: 'edit' }, { role: 'user', _mode: 'plan' }, { role: 'user', _mode: 'manual' },
    { role: 'user', _persona: 'research' }, { role: 'assistant', _mode: 'edit' }, null].map((m) => C2.sentApplyMode(m)), ['manual', 'auto', 'plan', 'manual', null, null, null]);
  storage.muninApplyMode = 'plan'; await C2.loadApplyMode(); assert.strictEqual(state.applyMode, 'plan');
  await C2.setApplyMode('manual');
  assert.strictEqual(storage.muninApplyMode, 'manual'); assert.strictEqual(C2.APPLY_MODE_KEY, 'muninApplyMode');
  delete storage.muninApplyMode; await C2.loadApplyMode(); assert.strictEqual(state.applyMode, 'manual'); // nothing stored: Manual
  storage.muninApplyMode = 'auto'; await C2.loadApplyMode(); assert.strictEqual(state.applyMode, 'auto');
  storage.muninApplyMode = 'review'; await C2.loadApplyMode(); assert.strictEqual(state.applyMode, 'manual'); // removed mode: the default
  storage.muninApplyMode = 'bogus'; await C2.loadApplyMode(); assert.strictEqual(state.applyMode, 'manual'); // unknown: the default
  C2.setBusy(true);
  assert.strictEqual(T.el.modeCycle.disabled, true);
  await C2.setApplyMode('auto'); assert.strictEqual(state.applyMode, 'manual'); // ignored while busy
  await C2.cycleApplyMode(); assert.strictEqual(state.applyMode, 'manual');
  C2.setBusy(false);
  assert.strictEqual(T.el.modeCycle.disabled, false);
});


test('no fading notices: addNotice, dismissLater and NOTICE_TTL_MS are gone; an error stays, with no timer', () => {
  T.el.chat.children.length = 0;
  timers.length = 0;
  const err = T.addError('Boom', false);
  assert.strictEqual(timers.length, 0);
  deq(T.el.chat.children.map((c) => c.innerHTML), ['Boom']);
  assert.strictEqual(err.isConnected, true);
  for (const name of ['addNotice', 'dismissLater', 'NOTICE_TTL_MS']) assert.strictEqual(env.run(`typeof ${name}`), 'undefined', name);
  // nowhere in the panel's sources or styles either
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./lib/sandbox');
  const files = ['sidepanel.css', 'sidepanel.html', ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter((f) => f.endsWith('.js')).map((f) => path.join('src', f))];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\baddNotice\b|\bdismissLater\b|\bNOTICE_TTL_MS\b|\.fading\b|msg\.notice|'notice'/.test(text), f);
  }
});

test('dead settings UI is gone: no Chat provider dropdown, no fixed per-type blocks, no Base URL / Model text inputs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./lib/sandbox');
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
  for (const id of ['provider', 'baseUrl', 'baseUrlLabel', 'model', 'modelLabel', 'modelHint', 'modelSelect-munin', 'apiKey-openai', 'block-anthropic']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(html.includes('id="accountList"'));
  assert.ok(html.includes('id="addProviderBtn"') && !html.includes('id="addProviderMenu"')); // one Add provider button, no menu of types
  assert.ok(!/id="addProvider-/.test(html)); // no per-type buttons
  const src = fs.readFileSync(path.join(ROOT, 'src', 'settings.js'), 'utf8');
  assert.ok(!/el\.(provider|providerForms|baseUrl|modelLabel|modelHint|model)\b/.test(src));
  assert.ok(!/setChatProvider|keyedProvider/.test(src));
  assert.ok(Object.values(T.PROVIDERS).every((p) => !('modelHint' in p)));
});

test('Anthropic model list: limit=100, pages followed with after_id (at most 5)', async () => {
  const urls = [];
  const pages = {
    '': { data: [{ id: 'claude-a' }, { id: 'claude-b' }], has_more: true, first_id: 'claude-a', last_id: 'claude-b' },
    'claude-b': { data: [{ id: 'claude-c' }], has_more: true, last_id: 'claude-c' },
    'claude-c': { data: [{ id: 'claude-d' }, { id: 'claude-a' }], has_more: false, last_id: 'claude-a' },
  };
  sandbox.fetch = async (url, init) => {
    urls.push(url);
    assert.strictEqual(init.headers['x-api-key'], 'sk-ant-P');
    const after = (/[?&]after_id=([^&]+)/.exec(url) || [])[1] || '';
    return { ok: true, status: 200, json: async () => pages[decodeURIComponent(after)] };
  };
  deq(await T.fetchModelList('anthropic', { apiKey: 'sk-ant-P' }), ['claude-a', 'claude-b', 'claude-c', 'claude-d']);
  deq(urls, [
    'https://api.anthropic.com/v1/models?limit=100',
    'https://api.anthropic.com/v1/models?limit=100&after_id=claude-b',
    'https://api.anthropic.com/v1/models?limit=100&after_id=claude-c',
  ]);
  // a server that always says has_more: capped at 5 requests
  urls.length = 0;
  let n = 0;
  sandbox.fetch = async (url) => { urls.push(url); n++; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' + n }], has_more: true, last_id: 'm' + n }) }; };
  deq(await T.fetchModelList('anthropic', { apiKey: 'sk-ant-P' }), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.strictEqual(urls.length, 5);
  // an error on a later page fails the whole list (readable)
  n = 0;
  sandbox.fetch = async () => (++n === 1
    ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'x' }], has_more: true, last_id: 'x' }) }
    : { ok: false, status: 401, text: async () => JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  await assert.rejects(() => T.fetchModelList('anthropic', { apiKey: 'sk-ant-P' }), /HTTP 401/);
  // other providers: one plain request
  urls.length = 0;
  sandbox.fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen3.8-27b' }] }) }; };
  deq(await T.fetchModelList('munin', { apiKey: 'k' }), ['qwen3.8-27b']);
  deq(urls, ['https://api.muninai.org/v1/models']);
});

test('References: no switch in the settings; a stored grant loads only while Chrome grants every origin', async () => {
  const e = await load();
  const { T: Tx, state: st, storage: store, chrome } = e;
  const ORIGINS = ['http://localhost:23119/*', 'https://api.crossref.org/*', 'https://api.openalex.org/*'];
  assert.strictEqual(st.settings.references, false);
  deq([...Tx.REFERENCES_ORIGINS], ORIGINS);
  deq([e.run('typeof REFERENCES_REQUIRED'), e.run('typeof setReferences')], ['undefined', 'undefined']);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sidepanel.html'), 'utf8');
  assert.ok(!/referencesSwitch|referencesHint|References \(Zotero/.test(html));
  const granted = new Set();
  chrome.permissions = { contains: async (p) => p.origins.every((o) => granted.has(o)) };
  // the flag without the permissions: off
  store.muninReferences = true;
  await Tx.loadSettings();
  assert.strictEqual(st.settings.references, false);
  // the permissions without the flag: off
  ORIGINS.forEach((o) => granted.add(o));
  delete store.muninReferences;
  await Tx.loadSettings();
  assert.strictEqual(st.settings.references, false);
  // both: on; Save keeps it
  store.muninReferences = true;
  await Tx.loadSettings();
  assert.strictEqual(st.settings.references, true);
  Tx.openSettings();
  await Tx.saveSettings();
  assert.strictEqual(st.settings.references, true);
  // an earlier grant of Zotero and Crossref only (before OpenAlex): off, so the card asks for all three
  granted.delete('https://api.openalex.org/*');
  await Tx.loadSettings();
  assert.strictEqual(st.settings.references, false);
});
