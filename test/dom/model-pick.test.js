'use strict';
// A model picked in an account's settings row (src/settings.js onModelPick) on a real DOM: it is the open chat's pick, as
// in the model menu under the input (accounts.js chooseModel): the chat's meta, the last choice and the account's model;
// the label at once (Settings still open) and the next request; a running turn ends on its model; other chats and
// documents keep theirs, a new chat inherits it, another tab of the document follows. A key (or a Custom URL) changes the
// open chat only when it had no account to run on (takeForChat). The row shows the chat's model on the chat's account,
// "—" on the others, and follows every change of it (syncRowModels).
const { test } = require('node:test');
const assert = require('node:assert');
const { load, click, typeInto, tick } = require('../lib/dom-sandbox');
const { deq, installDocTab, waitFor } = require('../lib/sandbox');
const { sseResponse, textRound } = require('../lib/streams');
const { muText } = require('../lib/context');
const { sharedStorage } = require('../lib/shared-storage');

const LIST = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const LISTS = { anthropic: LIST, munin: ['qwen3.8-27b', 'qwen3.8-9b'], custom: ['llama-4-8b', 'qwen-coder'] };
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const TWO = [{ id: 'mu', type: 'munin', name: 'Munin', apiKey: 'k-mu' }, { id: 'an', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-k' }];
const TWO_STORED = { muninAccounts: TWO, 'muninModels:an': LIST, 'muninModels:mu': LISTS.munin };

// A panel on the Docs tab DOC123 (export path, Manual mode). env.sent: [type, model] per chat request; env.gate: a
// promise the next Munin answer waits for. store: a shared storage (another tab), attached before the settings load.
async function panel({ storage = {}, store = null } = {}) {
  const env = await load({ legacySettings: false, storage });
  if (store) { store.attach(env); await env.T.loadSettings(); }
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nAlpha.', format: 'markdown', title: 'Doc' };
    return { ok: true, title: 'Doc' };
  };
  env.sent = [];
  env.gate = null;
  env.ctx.fetch = async (url, init = {}) => {
    const u = String(url);
    const type = u.startsWith('https://api.anthropic.com/') ? 'anthropic' : u.startsWith('https://api.muninai.org/') ? 'munin' : u.startsWith('http://localhost:8080/') ? 'custom' : '';
    if (!type) return { ok: false, status: 404, text: async () => '' };
    if (/\/models(\?|$)/.test(u)) return json({ data: LISTS[type].map((id) => ({ id })) });
    env.sent.push([type, JSON.parse(init.body).model]);
    if (type === 'munin' && env.gate) await env.gate;
    return sseResponse(type === 'anthropic' ? textRound('Hi.') : muText('Hi.'));
  };
  await env.T.refreshContext({ force: true });
  env.state.googleConnected = false;
  env.state.applyMode = 'manual';
  return env;
}
const change = (env, node, value) => { node.value = value; node.dispatchEvent(new env.window.Event('change', { bubbles: true })); };
const label = (env) => env.el.chatModel.querySelector('.mode-label').textContent;
const rowOf = (env, id) => env.document.querySelector(`#settings .provider-block[data-account="${id}"]`);
const select = (env, id) => rowOf(env, id).querySelector('select.account-models');
const options = (env, id) => [...select(env, id).options].map((o) => o.textContent);
const openMeta = (env) => env.state.chats.find((c) => c.id === env.state.chatId);
const chosen = (env) => { const m = openMeta(env).model; return m ? [m.accountId, m.model] : null; };
const pick = async (env, id, model) => { change(env, select(env, id), model); await waitFor(() => String(chosen(env)) === `${id},${model}`, `the pick ${model}`); };
// Add provider in the form: the draft row's type, then (key) the key typed and the field left.
async function addViaForm(env, type) {
  const { state, el, document } = env;
  const before = state.settings.accounts.length;
  click(el.addProviderBtn);
  change(env, document.querySelector('#settings .account-draft select.account-type'), type);
  await waitFor(() => state.settings.accounts.length === before + 1 && rowOf(env, state.settings.accounts[before].id), 'the new row');
  return state.settings.accounts[before];
}
async function enterKey(env, id, key) {
  const input = rowOf(env, id).querySelector('.account-key');
  typeInto(input, key);
  input.dispatchEvent(new env.window.Event('blur'));
  await waitFor(() => !env.T.settingsForm.keyTimer[id] && !env.T.settingsForm.checking[id], 'the key stored and checked');
  await tick(5);
}
async function say(env, text) {
  typeInto(env.el.input, text);
  await env.T.sendMessage();
  await waitFor(() => !env.state.busy, 'the end of the turn');
  await tick(5);
}

test('the owner\'s path: a fresh panel, an Anthropic key, a model picked in its row: the chat runs on it, the label shows it at once; a new chat inherits it', async () => {
  const env = await panel();
  const { T, state, el, storage } = env;
  T.openSettings();
  const a = await addViaForm(env, 'anthropic');
  await enterKey(env, a.id, 'sk-ant-KEY');
  // the chat had no account to run on: it took the new one on its default model, stored (the label showed it unstored before)
  deq([chosen(env), state.settings.lastModel], [[a.id, 'claude-opus-5-5'], { accountId: a.id, model: 'claude-opus-5-5' }]);
  deq([options(env, a.id), select(env, a.id).value, select(env, a.id).disabled], [LIST, 'claude-opus-5-5', false]);
  // the pick in the row: the chat's, the label at once while Settings are open
  await pick(env, a.id, 'claude-sonnet-5-5');
  assert.ok(!el.settings.classList.contains('hidden'));
  assert.strictEqual(label(env), 'claude-sonnet-5-5');
  T.closeSettings();
  assert.strictEqual(label(env), 'claude-sonnet-5-5');
  await say(env, 'hello');
  deq(env.sent, [['anthropic', 'claude-sonnet-5-5']]);
  deq(storage.muninLastModel, { accountId: a.id, model: 'claude-sonnet-5-5' });
  assert.strictEqual(storage.muninAccounts[0].model, 'claude-sonnet-5-5');
  assert.strictEqual(storage['muninChats:DOC123'].find((c) => c.id === state.chatId).model.model, 'claude-sonnet-5-5');
  deq(state.messages.map((m) => m.role), ['user', 'assistant']); // no row for the pick (none for a menu pick either)
  // + right after: the new chat takes the open chat's choice
  await T.createChat();
  deq(chosen(env), [a.id, 'claude-sonnet-5-5']);
  assert.strictEqual(label(env), 'claude-sonnet-5-5');
  env.close();
});

test('a chat on a working Munin account: an Anthropic key alone changes nothing ("—" in its row); a model picked there moves the chat', async () => {
  const env = await panel({ storage: { muninAccounts: [TWO[0]] } });
  const { T, state } = env;
  await say(env, 'first');
  deq(env.sent, [['munin', 'qwen3.8-27b']]);
  T.openSettings();
  const a = await addViaForm(env, 'anthropic');
  await enterKey(env, a.id, 'sk-ant-KEY');
  // the key only: the chat stays as it was (no choice of its own, no last choice: the first account with a key)
  deq([chosen(env), state.settings.lastModel, label(env)], [null, null, 'qwen3.8-27b']);
  deq([options(env, a.id), select(env, a.id).value, select(env, a.id).disabled], [['—', ...LIST], '', false]);
  // a model picked in the new row: the chat runs on it; the Munin row shows "—" now
  await pick(env, a.id, 'claude-sonnet-5-5');
  assert.strictEqual(label(env), 'claude-sonnet-5-5');
  deq([select(env, 'mu').value, options(env, 'mu')[0]], ['', '—']);
  T.closeSettings();
  await say(env, 'second');
  deq(env.sent, [['munin', 'qwen3.8-27b'], ['anthropic', 'claude-sonnet-5-5']]);
  env.close();
});

test('a pick in the row of the chat\'s account or of another one: the open chat only; other chats and documents keep theirs, a document\'s first chat takes it', async () => {
  const env = await panel({ storage: TWO_STORED });
  const { T, state, storage } = env;
  await T.chooseModel('mu', 'qwen3.8-27b');
  await say(env, 'on munin');
  const munChat = state.chatId;
  await T.createChat();
  await T.chooseModel('an', 'claude-opus-5-5');
  await say(env, 'on opus');
  const other = (await T.loadChatStore('DOC_OTHER')).chats[0]; // another document's chat, on Anthropic opus
  // the chat runs on Anthropic: its row shows the chat's model, the Munin row "—"
  T.openSettings();
  deq([select(env, 'an').value, select(env, 'mu').value], ['claude-opus-5-5', '']);
  await pick(env, 'an', 'claude-haiku-5-5');
  assert.strictEqual(label(env), 'claude-haiku-5-5');
  T.closeSettings();
  await say(env, 'on haiku');
  // the Munin chat: the Anthropic row shows "—"; a model there moves this chat only
  await T.switchChat(munChat);
  assert.strictEqual(label(env), 'qwen3.8-27b');
  T.openSettings();
  deq([select(env, 'an').value, select(env, 'mu').value], ['', 'qwen3.8-27b']);
  await pick(env, 'an', 'claude-sonnet-5-5');
  T.closeSettings();
  await say(env, 'on sonnet');
  deq(env.sent, [['munin', 'qwen3.8-27b'], ['anthropic', 'claude-opus-5-5'], ['anthropic', 'claude-haiku-5-5'], ['anthropic', 'claude-sonnet-5-5']]);
  const stored = storage['muninChats:DOC123'];
  deq(stored.map((c) => [c.id === munChat, c.model.model]).sort(), [[false, 'claude-haiku-5-5'], [true, 'claude-sonnet-5-5']]);
  deq(storage['muninChats:DOC_OTHER'].find((c) => c.id === other.id).model, other.model);
  assert.strictEqual(other.model.model, 'claude-opus-5-5');
  deq(storage.muninLastModel, { accountId: 'an', model: 'claude-sonnet-5-5' });
  const fresh = (await T.loadChatStore('DOC_NEW')).chats[0];
  deq([fresh.model.accountId, fresh.model.model], ['an', 'claude-sonnet-5-5']);
  env.close();
});

test('a pick in a row while a turn runs: the turn ends on its model, the label shows the pick at once, the next message runs on it', async () => {
  const env = await panel({ storage: TWO_STORED });
  const { T, state } = env;
  await T.chooseModel('mu', 'qwen3.8-27b');
  let release;
  env.gate = new Promise((r) => { release = r; });
  typeInto(env.el.input, 'long one');
  const turn = T.sendMessage();
  await waitFor(() => env.sent.length === 1, 'the request');
  assert.ok(state.busy);
  T.openSettings();
  await pick(env, 'an', 'claude-haiku-5-5');
  assert.strictEqual(label(env), 'claude-haiku-5-5');
  T.closeSettings();
  env.gate = null;
  release();
  await turn;
  await waitFor(() => !state.busy, 'the end of the turn');
  deq(state.messages.map((m) => m.role), ['user', 'assistant']);
  await say(env, 'next');
  deq(env.sent, [['munin', 'qwen3.8-27b'], ['anthropic', 'claude-haiku-5-5']]);
  env.close();
});

test('a key or a Custom URL moves a chat that had no account to run on (none usable, a removed one); a chat with one keeps it', async () => {
  const env = await panel({ storage: { muninAccounts: [{ id: 'an', type: 'anthropic', name: 'Anthropic', apiKey: '' }] } });
  const { T, state } = env;
  T.openSettings();
  // a Custom server's URL: the chat (on the keyless Anthropic account) takes it on the first listed model
  const c = await addViaForm(env, 'custom');
  change(env, rowOf(env, c.id).querySelector('.account-url'), 'http://localhost:8080');
  await waitFor(() => String(chosen(env)) === `${c.id},llama-4-8b`, 'the Custom account taken');
  assert.strictEqual(label(env), 'llama-4-8b');
  deq([select(env, c.id).value, select(env, 'an').value], ['llama-4-8b', '']);
  // a key for the Anthropic account now: the chat has one, it stays
  T.toggleAccountRow('an', true);
  await enterKey(env, 'an', 'sk-ant-KEY');
  deq(chosen(env), [c.id, 'llama-4-8b']);
  // the chat's account removed and Anthropic's key emptied: "Choose a model"; a key then moves the chat to Anthropic
  await enterKey(env, 'an', '');
  await T.removeAccount(c.id);
  assert.strictEqual(label(env), 'Choose a model');
  await enterKey(env, 'an', 'sk-ant-AGAIN');
  deq([chosen(env), label(env), state.settings.lastModel], [['an', 'claude-opus-5-5'], 'claude-opus-5-5', { accountId: 'an', model: 'claude-opus-5-5' }]);
  // a second Custom server: the chat has an account, it stays; nor does a check that ends after another usable account
  // was picked (keep read before as false) move it
  const c2 = await addViaForm(env, 'custom');
  change(env, rowOf(env, c2.id).querySelector('.account-url'), 'http://localhost:8080');
  await waitFor(() => (state.modelLists[c2.id] || []).length === 2 && !T.settingsForm.checking[c2.id], 'the second list');
  await tick(5);
  deq(chosen(env), ['an', 'claude-opus-5-5']);
  await T.takeForChat(c2.id, false);
  deq(chosen(env), ['an', 'claude-opus-5-5']);
  T.closeSettings();
  env.close();
});

test('the rows follow every change of the chat\'s model while Settings are open (a models switch, a model outside the list), so the shown model can be picked again', async () => {
  const env = await panel({ storage: TWO_STORED });
  const { T } = env;
  await T.chooseModel('an', 'claude-opus-5-5');
  T.openSettings();
  assert.strictEqual(select(env, 'an').value, 'claude-opus-5-5');
  await T.setChatModel('an', 'claude-haiku-5-5'); // as the models tool's switch or a revert does
  assert.strictEqual(select(env, 'an').value, 'claude-haiku-5-5');
  await pick(env, 'an', 'claude-opus-5-5'); // the model shown before the switch is a pick again
  assert.strictEqual(label(env), 'claude-opus-5-5');
  // a chat model the list lacks is listed first, as in the model menu
  await T.setChatModel('an', 'claude-old-4');
  deq([options(env, 'an'), select(env, 'an').value], [['claude-old-4', ...LIST], 'claude-old-4']);
  // "—" picked: nothing happens
  change(env, select(env, 'mu'), '');
  await tick(5);
  deq(chosen(env), ['an', 'claude-old-4']);
  T.closeSettings();
  env.close();
});

test('two tabs of a document: a model picked in one tab\'s row is the chat\'s in the other (its label, its open row, its next request)', async () => {
  const store = sharedStorage();
  Object.assign(store.items, JSON.parse(JSON.stringify(TWO_STORED)));
  const A = await panel({ store });
  const B = await panel({ store });
  assert.strictEqual(B.state.chatId, A.state.chatId);
  await A.T.chooseModel('mu', 'qwen3.8-27b');
  await waitFor(() => label(B) === 'qwen3.8-27b', 'B on Munin');
  B.T.openSettings();
  assert.strictEqual(select(B, 'mu').value, 'qwen3.8-27b');
  A.T.openSettings();
  await pick(A, 'an', 'claude-sonnet-5-5');
  await waitFor(() => label(B) === 'claude-sonnet-5-5', 'B\'s label');
  deq([select(B, 'an').value, select(B, 'mu').value], ['claude-sonnet-5-5', '']);
  A.T.closeSettings();
  B.T.closeSettings();
  await say(B, 'from B');
  deq(B.sent, [['anthropic', 'claude-sonnet-5-5']]);
  A.close();
  B.close();
});
