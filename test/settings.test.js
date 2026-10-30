'use strict';
// Settings: defaults and storage keys, loading, the settings form with the model lists, the Auto | Manual switch.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let env, T, C2, state, sandbox, storage, timers;

before(async () => {
  env = await load();
  T = C2 = env.T;
  state = env.state;
  sandbox = env.ctx;
  storage = env.storage;
  timers = env.timers;
});

test('settings defaults + storage keys', async () => {
  // --- settings defaults and storage keys
  assert.strictEqual(state.settings.provider, 'munin');
  assert.strictEqual(state.settings.providers.anthropic.model, 'claude-opus-5-5');
  assert.strictEqual(T.storageKey('munin', 'apiKey'), 'muninApiKey');
  deq([...T.SETTING_FIELDS], ['apiKey', 'model']); // no Base URL (every endpoint is fixed), no Effort (the model's default)
  deq(Object.keys(state.settings.providers.openai), ['apiKey', 'model']);
  assert.ok(Object.values(T.PROVIDERS).every((p) => !('effort' in p)));
  assert.strictEqual(T['typeof EFFORT_LEVELS'], 'undefined'); // removed
});

test('loadSettings keeps the old Munin key and restores the provider', async () => {
  // An old Munin key is picked up; the active provider is restored.
  storage.muninApiKey = 'sk-munin-OLD'; storage.muninProvider = 'anthropic'; storage.anthropicModel = ' claude-sonnet-5-5 '; storage.muninModels = ['qwen3.8-27b', 7, ' x-model '];
  await T.loadSettings();
  assert.strictEqual(state.settings.providers.munin.apiKey, 'sk-munin-OLD');
  assert.strictEqual(state.settings.provider, 'anthropic');
  assert.strictEqual(state.settings.providers.anthropic.model, 'claude-sonnet-5-5');
  deq(state.modelLists.munin, ['qwen3.8-27b', 'x-model']);
  assert.strictEqual(state.settings.providers.openai.baseUrl, undefined);
});

test('settings form flow + model list', async () => {
  // the provider settings as the request checks of the old harness left them (see providers.test.js)
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-anthropic', model: 'claude-opus-5-5' });
  Object.assign(state.settings.providers.openai, { apiKey: 'k-openai', model: 'gpt-6.1-sol' });
  // --- settings form: every change is stored at once (provider, key, model);
  //     Munin: fixed endpoint, model dropdown filled from GET /models
  state.settings.provider = 'munin';
  Object.assign(state.settings.providers.munin, { apiKey: 'sk-munin-OLD' });
  state.modelLists.munin = [];
  let modelCalls = [];
  const modelsResponse = (ids, status = 200) => ({ ok: status < 300, status, json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), text: async () => JSON.stringify({ error: { message: 'Invalid API key.' } }) });
  sandbox.fetch = async (url, init) => { modelCalls.push([url, init.headers.Authorization]); return modelsResponse(['qwen3.8-27b', 'qwen3.8-27b-fast', 'qwen3.8-27b']); };
  T.openSettings(); // key present + no cached list: NO request on opening, just a hint
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(modelCalls.length, 0);
  assert.strictEqual(T.el.modelStatus.textContent, ''); // no hint text
  assert.strictEqual(T.el.modelSelect.value, ''); assert.strictEqual(T.el.modelSelect.disabled, true); // nothing shown before the list is loaded
  deq(T.readSettingsForm ? T.readSettingsForm().model : 'qwen3.8-27b', 'qwen3.8-27b'); // the saved model is kept while the dropdown is empty
  await T.checkModels();
  assert.strictEqual(T.el.modelSelect.disabled, false);
  assert.strictEqual(T.el.provider.value, 'munin');
  assert.strictEqual(T.el.apiKeyLabel.textContent, 'Munin API key');
  deq(modelCalls, [['https://api.muninai.org/v1/models', 'Bearer sk-munin-OLD']]);
  deq(state.modelLists.munin, ['qwen3.8-27b', 'qwen3.8-27b-fast']); // deduplicated
  deq(storage.muninModels, ['qwen3.8-27b', 'qwen3.8-27b-fast']);
  assert.strictEqual(T.el.modelSelect.value, 'qwen3.8-27b');
  assert.ok(/2 models available; qwen3.8-27b is selected/.test(T.el.modelStatus.textContent) && !T.el.modelStatus.classList.contains('warn'));
  T.el.apiKey.value = 'sk-munin-NEW';
  T.el.modelSelect.value = 'qwen3.8-27b-fast';
  T.switchSettingsProvider('anthropic');
  assert.strictEqual(T.el.apiKeyLabel.textContent, 'Anthropic (Claude) API key');
  // Anthropic follows the OpenAI scheme: fixed endpoint, model dropdown from GET /models.
  assert.strictEqual(T.el.modelSelect.value, ''); assert.strictEqual(T.el.modelSelect.disabled, true); // no cached list yet
  T.el.apiKey.value = 'sk-ant-NEW';
  const anthCalls = [];
  sandbox.fetch = async (url, init) => { anthCalls.push([url, init.headers['x-api-key']]); return modelsResponse(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']); };
  await T.checkModels();
  deq(anthCalls, [['https://api.anthropic.com/v1/models?limit=100', 'sk-ant-NEW']]);
  deq(state.modelLists.anthropic, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  deq(storage.anthropicModels, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.strictEqual(T.el.modelSelect.value, 'claude-opus-5-5');
  T.el.modelSelect.value = 'claude-sonnet-5-5';
  T.switchSettingsProvider('munin');
  assert.strictEqual(T.el.apiKey.value, 'sk-munin-NEW'); // stored on the switch
  assert.strictEqual(T.el.modelSelect.value, 'qwen3.8-27b-fast');
  assert.strictEqual(modelCalls.length, 1); // cached list: no second request
  T.switchSettingsProvider('anthropic');
  assert.strictEqual(T.el.apiKey.value, 'sk-ant-NEW');
  assert.strictEqual(T.el.modelSelect.value, 'claude-sonnet-5-5'); // the model too
  // Every change is stored at once: the provider switches stored the provider and each provider's key and model.
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(state.settings.provider, 'anthropic'); assert.strictEqual(storage.muninProvider, 'anthropic');
  deq([storage.muninApiKey, storage.muninModel], ['sk-munin-NEW', 'qwen3.8-27b-fast']);
  deq([storage.anthropicApiKey, storage.anthropicModel], ['sk-ant-NEW', 'claude-sonnet-5-5']);
  // A typed key is stored when the field is left (or after the typing pause) and then checked: the status says
  // the key works, the "fix your settings" errors leave the chat, the default model is selected and stored.
  T.el.chat.children.length = 0;
  T.addError('To get started, add your Munin API key in the settings.', true);
  T.addError('Some other error', false);
  let verifyUrl = null;
  sandbox.fetch = async (url, init) => { verifyUrl = [url, init.headers['x-api-key']]; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }) }; };
  T.el.apiKey.value = ' sk-ant-KEY2 ';
  T.onApiKeyInput();
  assert.strictEqual(storage.anthropicApiKey, 'sk-ant-NEW'); // waits for the pause
  await T.onApiKeyBlur();
  deq(verifyUrl, ['https://api.anthropic.com/v1/models?limit=100', 'sk-ant-KEY2']);
  assert.strictEqual(T.settingsForm.keyTimer, 0); // the pending pause is dropped
  assert.ok(!T.el.chat.children.some((c) => c.classList.contains('settings-error')));
  assert.ok(T.el.chat.children.some((c) => /Some other error/.test(c.innerHTML))); // unrelated errors stay
  assert.ok(!T.el.chat.children.some((c) => /Connected to|Settings saved/.test(c.innerHTML))); // the open settings show it
  assert.strictEqual(T.el.modelStatus.textContent, 'Connected to Anthropic (Claude): the key works. 2 models available; claude-opus-5-5 is selected.');
  deq(state.settings.providers.anthropic, { apiKey: 'sk-ant-KEY2', model: 'claude-opus-5-5' });
  deq(state.settings.providers.munin, { apiKey: 'sk-munin-NEW', model: 'qwen3.8-27b-fast' });
  deq([storage.anthropicApiKey, storage.anthropicModel], ['sk-ant-KEY2', 'claude-opus-5-5']);
  assert.ok(!('anthropicEffort' in storage) && !('muninEffort' in storage)); // no Effort stored
  assert.ok(!('anthropicBaseUrl' in storage) && !('muninBaseUrl' in storage)); // no Base URL stored
  assert.strictEqual(await T.onApiKeyBlur(), null); // nothing waits: leaving the field again does nothing
  // A model picked in the dropdown is stored at once.
  T.el.modelSelect.value = 'claude-sonnet-5-5';
  await T.onModelChange();
  assert.strictEqual(storage.anthropicModel, 'claude-sonnet-5-5'); assert.strictEqual(state.settings.providers.anthropic.model, 'claude-sonnet-5-5');
  // A bad key typed and the settings closed before the pause: stored on closing, the check's error goes to the chat.
  T.el.chat.children.length = 0;
  sandbox.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  T.el.apiKey.value = 'sk-ant-BAD'; T.onApiKeyInput();
  T.closeSettings();
  assert.ok(T.el.settings.classList.contains('hidden'));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(storage.anthropicApiKey, 'sk-ant-BAD'); assert.strictEqual(state.settings.providers.anthropic.apiKey, 'sk-ant-BAD');
  assert.ok(T.el.chat.children.some((c) => c.classList.contains('settings-error') && /HTTP 401/.test(c.innerHTML)));
  assert.ok(/^Could not get the model list/.test(T.el.modelStatus.textContent) && T.el.modelStatus.classList.contains('warn'));
  // An emptied key is stored too, without a request.
  T.openSettings();
  verifyUrl = null;
  T.el.apiKey.value = ''; T.onApiKeyInput(); await T.onApiKeyBlur();
  assert.strictEqual(storage.anthropicApiKey, ''); assert.strictEqual(verifyUrl, null);
  // "Check models" with a stale saved model and with a bad key
  T.switchSettingsProvider('munin');
  state.modelLists.munin = ['qwen3.8-27b'];
  state.settings.providers.munin.model = 'gone-model';
  T.renderModelOptions('munin', 'gone-model');
  assert.strictEqual(T.el.modelSelect.value, 'gone-model');
  modelCalls = [];
  sandbox.fetch = async (url, init) => { modelCalls.push([url, init.headers.Authorization]); return modelsResponse(['qwen3.8-27b', 'qwen3.8-27b-fast']); };
  await T.checkModels();
  deq(modelCalls, [['https://api.muninai.org/v1/models', 'Bearer sk-munin-NEW']]);
  assert.strictEqual(T.el.modelSelect.value, 'qwen3.8-27b');
  assert.ok(/"gone-model" is not offered/.test(T.el.modelStatus.textContent) && /qwen3.8-27b is selected/.test(T.el.modelStatus.textContent) && T.el.modelStatus.classList.contains('warn'));
  sandbox.fetch = async () => modelsResponse([], 401);
  await T.checkModels();
  assert.ok(/HTTP 401/.test(T.el.modelStatus.textContent) && T.el.modelStatus.classList.contains('warn'));
  assert.strictEqual(T.el.modelSelect.value, 'qwen3.8-27b'); // unchanged on error
  T.el.apiKey.value = '';
  await T.checkModels();
  assert.strictEqual(T.el.modelStatus.textContent, 'Enter the API key first.');
  T.el.apiKey.value = 'sk-munin-NEW';
  // Typing a key: debounced check that selects the first model; a check during a check is queued
  T.el.modelSelect.value = 'qwen3.8-27b-fast';
  modelCalls = [];
  let release;
  sandbox.fetch = async (url, init) => { modelCalls.push([url, init.headers.Authorization]); await new Promise((r) => { release = r; }); return modelsResponse(['m-first', 'm-second']); };
  T.el.apiKey.value = 'typed-k';
  T.onApiKeyInput();
  T.el.apiKey.value = 'typed-key';
  T.onApiKeyInput(); // resets the debounce: only one request
  await new Promise((r) => setTimeout(r, 800));
  deq(modelCalls, [['https://api.muninai.org/v1/models', 'Bearer typed-key']]);
  assert.strictEqual(storage.muninApiKey, 'typed-key'); // stored after the pause, before the check answers
  assert.ok(T.settingsForm.checking);
  T.el.apiKey.value = 'typed-key2';
  T.onApiKeyInput();
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(modelCalls.length, 1); // queued behind the running check
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(modelCalls.length, 2); assert.strictEqual(modelCalls[1][1], 'Bearer typed-key2');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(T.el.modelSelect.value, 'm-first'); // first model selected after a key change
  assert.ok(/^Connected to Munin: the key works\. 2 models available; m-first is selected/.test(T.el.modelStatus.textContent) && !T.el.modelStatus.classList.contains('warn'));
  deq([storage.muninApiKey, storage.muninModel], ['typed-key2', 'm-first']);
  assert.ok(T.el.keyWarn.classList.contains('hidden')); // Munin: no prefix warning
  T.el.apiKey.value = 'sk-munin-NEW';
  // Notices fade out after NOTICE_TTL_MS; errors stay
  T.el.chat.children.length = 0;
  timers.length = 0;
  const notice = T.addNotice('Settings saved.');
  const sticky = T.addNotice('Keep me', { sticky: true });
  const err = T.addError('Boom', false);
  const t = timers.find((x) => x.ms === T.NOTICE_TTL_MS);
  assert.ok(t && timers.length === 1);
  t.fn();
  assert.ok(notice.classList.contains('fading'));
  timers.find((x) => x.ms === 600).fn(); // fallback removal
  deq(T.el.chat.children.map((c) => c.innerHTML), ['Keep me', 'Boom']);
  assert.strictEqual(sticky.isConnected && err.isConnected, true);
  // OpenAI: fixed endpoint, dropdown, filtered + sorted list, default model selected after a key change
  state.settings.providers.openai.apiKey = '';
  T.switchSettingsProvider('openai');
  assert.strictEqual(T.el.modelStatus.textContent, '');
  assert.strictEqual(T.el.modelSelect.value, ''); assert.strictEqual(T.el.modelSelect.disabled, true);
  deq(T.openaiChatModels(['whisper-1', 'gpt-4o-realtime-preview', 'o4-mini', 'gpt-6.1-sol', 'gpt-6-astra', 'text-embedding-3-small', 'gpt-4.1-2025-04-14', 'gpt-image-1', 'o3', 'gpt-6-luna', 'dall-e-3', 'gpt-5.5', 'tts-1', 'gpt-5-codex', 'omni-moderation-latest', 'gpt-4-0613']),
    ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.5', 'o4-mini', 'o3']);
  modelCalls = [];
  sandbox.fetch = async (url, init) => { modelCalls.push([url, init.headers.Authorization]); return modelsResponse(['whisper-1', 'o3', 'gpt-6-astra', 'gpt-6.1-sol']); };
  T.el.apiKey.value = 'sk-OPENAI';
  T.onApiKeyInput();
  await new Promise((r) => setTimeout(r, 800));
  deq(modelCalls, [['https://api.openai.com/v1/models', 'Bearer sk-OPENAI']]);
  deq(state.modelLists.openai, ['gpt-6.1-sol', 'gpt-6-astra', 'o3']);
  assert.strictEqual(T.el.modelSelect.value, 'gpt-6.1-sol'); // the default model, offered -> selected
  sandbox.fetch = async () => modelsResponse(['custom-a', 'custom-b']); // a list without GPT models is kept as is
  await T.checkModels({ selectFirst: true });
  deq(state.modelLists.openai, ['custom-a', 'custom-b']); assert.strictEqual(T.el.modelSelect.value, 'custom-a');
  T.switchSettingsProvider('munin');
  // Anthropic model list request shape (provider-aware headers: x-api-key instead of a bearer token)
  sandbox.fetch = async (url, init) => { assert.strictEqual(url, 'https://api.anthropic.com/v1/models?limit=100'); assert.strictEqual(init.headers['x-api-key'], 'sk-ant-NEW'); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }) }; };
  deq(await T.fetchModelList('anthropic', { apiKey: 'sk-ant-NEW' }), ['claude-opus-5-5']);
  T.el.settings.classList.add('hidden');
});

test('the modes: cycleApplyMode goes Manual -> Edit automatically -> Plan -> Manual, persisted, unknown values, disabled while busy', async () => {
  C2.applyApplyMode('manual');
  assert.strictEqual(state.applyMode, 'manual');
  assert.strictEqual(T.el.modeLabel.textContent, 'Manual');
  assert.strictEqual(T.el.modeCycle.title, 'Choose how the assistant works');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await C2.cycleApplyMode();
    seen.push([state.applyMode, storage.muninApplyMode, T.el.modeLabel.textContent, T.el.modeCycle.dataset.mode]);
  }
  deq(seen, [['auto', 'auto', 'Edit automatically', 'auto'], ['plan', 'plan', 'Plan', 'plan'], ['manual', 'manual', 'Manual', 'manual']]);
  deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [false, false, 'manual']);
  await C2.setApplyMode('auto'); deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [true, false, 'edit']);
  await C2.setApplyMode('plan'); deq([C2.isAutoMode(), C2.isPlanMode(), C2.applyTurnMode()], [false, true, 'plan']);
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

test('dead settings UI is gone: no Base URL / Model text inputs, no model hint', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./lib/sandbox');
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
  for (const id of ['baseUrl', 'baseUrlLabel', 'model', 'modelLabel', 'modelHint']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(html.includes('id="modelSelect"'));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'settings.js'), 'utf8');
  assert.ok(!/el\.(baseUrl|baseUrlLabel|modelLabel|modelHint|model)\b/.test(src));
  assert.ok(Object.values(T.PROVIDERS).every((p) => !('modelHint' in p)));
});

test('settings migration: a stored Base URL is ignored and removed silently, the other fields are kept', async () => {
  Object.assign(storage, { openaiBaseUrl: 'https://proxy.example.com/v1', anthropicBaseUrl: 'https://api.anthropic.com/v1', muninBaseUrl: '', muninConfirmEdits: false, muninDocMode: 'outline', openaiModel: 'gpt-6-astra' });
  T.el.chat.children.length = 0;
  await T.loadSettings();
  for (const k of ['openaiBaseUrl', 'anthropicBaseUrl', 'muninBaseUrl', 'muninConfirmEdits', 'muninDocMode']) assert.ok(!(k in storage), k);
  deq(state.settings.providers.openai, { apiKey: state.settings.providers.openai.apiKey, model: 'gpt-6-astra' });
  assert.strictEqual(T.apiUrl({ prov: T.PROVIDERS.openai, cfg: state.settings.providers.openai }, '/responses'), 'https://api.openai.com/v1/responses');
  assert.strictEqual(T.el.chat.children.length, 0); // silently
});

test('settings migration: a stored Effort is ignored and removed silently, the other fields are kept', async () => {
  Object.assign(storage, { muninEffort: '', openaiEffort: 'high', anthropicEffort: 'low', openaiModel: 'gpt-6-astra', anthropicModel: 'claude-sonnet-5-5' });
  T.el.chat.children.length = 0;
  await T.loadSettings();
  for (const k of ['muninEffort', 'openaiEffort', 'anthropicEffort']) assert.ok(!(k in storage), k);
  deq(state.settings.providers.openai, { apiKey: state.settings.providers.openai.apiKey, model: 'gpt-6-astra' });
  deq(state.settings.providers.anthropic, { apiKey: state.settings.providers.anthropic.apiKey, model: 'claude-sonnet-5-5' });
  assert.strictEqual(storage.openaiModel, 'gpt-6-astra'); assert.strictEqual(storage.anthropicModel, 'claude-sonnet-5-5');
  // A settings object of an earlier version that still carries effort is sanitized without it.
  deq(T.sanitizeProviderSettings('anthropic', { apiKey: ' sk-ant-OLD ', model: 'claude-opus-5-5', effort: 'high' }), { apiKey: 'sk-ant-OLD', model: 'claude-opus-5-5' });
  assert.strictEqual(T.el.chat.children.length, 0); // silently
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
