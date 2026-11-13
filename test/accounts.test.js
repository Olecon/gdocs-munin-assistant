'use strict';
// Accounts in use (src/settings.js, src/accounts.js): the model per chat (a document's first chat, a new chat, the merge
// of two copies), two accounts of one type in a turn (their keys, the OpenAI cache key), the line that names the model
// in the turn context, a removed account, the health marks, the models tool, agents named "<account>/<model>", the
// self-test on the chat's account, going back to the last model that answered after a failed change.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, turnRowTexts } = require('./lib/sandbox');
const { docBench, providerRouter, oaTool, oaText, muText, send } = require('./lib/context');
const { ev, textRound } = require('./lib/streams');
const { sharedStorage, tick } = require('./lib/shared-storage');

let env, T, state, storage, doc;
const DOC = ['# Report', '', 'Intro text.', '', '## Methods', '', 'Alpha beta gamma.'].join('\n');
const ACCOUNTS = [
  { id: 'mu', type: 'munin', name: 'Munin', apiKey: 'k-mu-1234' },
  { id: 'o1', type: 'openai', name: 'OpenAI', apiKey: 'sk-one-5678', model: 'gpt-6.1-sol' },
  { id: 'o2', type: 'openai', name: 'Work', apiKey: 'sk-two-9012', model: 'gpt-6-mini' },
];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const modelList = (ids) => json({ data: ids.map((id) => ({ id })) });
// The account is named only when its name is not the type's default one.
const runAs = (model, label, name) => `You run as ${model} (${label}${['Munin', 'OpenAI', 'Anthropic'].includes(name) ? '' : `, account ${name}`}).`;
const userText = (body) => body.input.filter((i) => i.role === 'user').pop().content;

async function freshChat() {
  state.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]; // a used chat is left, not reused
  await T.createChat();
  T.el.chat.children.length = 0;
}

before(async () => {
  env = await load({ legacySettings: false });
  ({ T, state, storage } = env);
  ({ doc } = docBench(env));
  doc.text = DOC;
  storage.muninAccounts = JSON.parse(JSON.stringify(ACCOUNTS));
  await T.loadSettings();
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.applyMode = 'manual';
});

test('the model per chat: a document\'s first chat takes the last choice, a new chat inherits the open one\'s, each keeps its own', async () => {
  await T.setChatModel('o2', 'gpt-6-mini');
  deq(storage.muninLastModel, { accountId: 'o2', model: 'gpt-6-mini' });
  // another document's first chat starts with the last choice made anywhere
  const other = await T.loadChatStore('DOC_OTHER');
  deq([other.chats[0].model.accountId, other.chats[0].model.model], ['o2', 'gpt-6-mini']);
  // a new chat inherits the open chat's choice; a change there stays there
  await T.setChatModel('o1', 'gpt-6.1-sol');
  const first = state.chatId;
  await freshChat();
  deq(T.chatChoice(), { accountId: 'o1', model: 'gpt-6.1-sol' });
  await T.setChatModel('mu', 'qwen3.8-27b');
  await T.switchChat(first);
  deq(T.chatChoice(), { accountId: 'o1', model: 'gpt-6.1-sol' });
  assert.strictEqual(T.el.chatModel.textContent, 'gpt-6.1-sol');
  // a chat without a model of its own (made before accounts) runs on the last choice
  const meta = state.chats.find((c) => c.id === first);
  delete meta.model;
  deq(T.chatChoice(), { accountId: 'mu', model: 'qwen3.8-27b' });
  // two copies of a meta: the later choice wins, whichever copy is newer otherwise
  const merged = T.mergeMeta({ id: 'c', updatedAt: 9, model: { accountId: 'o1', model: 'a', at: 5 } }, { id: 'c', updatedAt: 1, model: { accountId: 'o2', model: 'b', at: 7 } });
  deq(merged.model, { accountId: 'o2', model: 'b', at: 7 });
  assert.strictEqual(merged.updatedAt, 9);
  // the last choice that answered likewise: the later one wins
  const good = T.mergeMeta({ id: 'c', updatedAt: 9, lastGood: { accountId: 'o1', model: 'a', at: 5 } }, { id: 'c', updatedAt: 1, lastGood: { accountId: 'o2', model: 'b', at: 7 } });
  deq(good.lastGood, { accountId: 'o2', model: 'b', at: 7 });
});

test('two accounts of one type: the chat\'s account sends with its key; the cache key names it; the model is named on the first turn and after a change', async () => {
  await freshChat();
  state.applyMode = 'manual';
  await T.setChatModel('o2', 'gpt-6-mini');
  const auth = [];
  const { bodies, fetch } = providerRouter({ openai: [(b, init) => { auth.push(init.headers.Authorization); return oaText('One.'); }] });
  env.ctx.fetch = fetch;
  await send(env, 'first');
  deq(auth, ['Bearer sk-two-9012']);
  assert.strictEqual(bodies.openai[0].model, 'gpt-6-mini');
  assert.strictEqual(bodies.openai[0].prompt_cache_key, `o2:DOC123:${state.chatId}`);
  assert.ok(userText(bodies.openai[0]).includes('</selection>\n' + runAs('gpt-6-mini', 'OpenAI (ChatGPT)', 'Work') + '\nAgents: '), userText(bodies.openai[0])); // before the Agents line
  assert.ok(!bodies.openai[0].instructions.includes('You run as')); // never in the static head
  deq(state.messages[0]._model, 'o2/gpt-6-mini');
  // the same model again: the line again while another model is usable (the models tool's gate)
  await send(env, 'second');
  assert.ok(userText(bodies.openai[1]).includes(runAs('gpt-6-mini', 'OpenAI (ChatGPT)', 'Work')), userText(bodies.openai[1]));
  // with only one model usable, the same model again: no line
  const keys = state.settings.accounts.map((a) => a.apiKey);
  const lists = state.modelLists;
  state.settings.accounts.forEach((a) => { if (a.id !== 'o2') a.apiKey = ''; });
  state.modelLists = {};
  await send(env, 'second again');
  state.settings.accounts.forEach((a, i) => { a.apiKey = keys[i]; });
  state.modelLists = lists;
  assert.ok(!userText(bodies.openai[2]).includes('You run as'), userText(bodies.openai[2]));
  // another account of the type: its key, its cache key, the line again
  await T.setChatModel('o1', 'gpt-6.1-sol');
  await send(env, 'third');
  assert.strictEqual(auth[3], 'Bearer sk-one-5678');
  assert.strictEqual(bodies.openai[3].prompt_cache_key, `o1:DOC123:${state.chatId}`);
  assert.ok(userText(bodies.openai[3]).includes(runAs('gpt-6.1-sol', 'OpenAI (ChatGPT)', 'OpenAI')));
  // the earlier messages keep what they said
  assert.ok(T.userContent(state.messages[0]).includes(runAs('gpt-6-mini', 'OpenAI (ChatGPT)', 'Work')));
});

test('a removed account: the chat shows "Choose a model"; sending asks for one with the menu open, no request', async () => {
  await freshChat();
  state.settings.accounts.push({ id: 'gone', type: 'anthropic', name: 'Temp', apiKey: 'sk-ant-x' });
  await T.setChatModel('gone', 'claude-opus-5-5');
  await T.removeAccount('gone');
  assert.strictEqual(T.el.chatModel.textContent, 'Choose a model');
  assert.ok(T.el.chatModel.classList.contains('none'));
  assert.strictEqual(T.activeConfig().accountId, null);
  let asked = 0;
  env.ctx.fetch = async () => { asked++; return modelList(['x']); };
  T.el.chat.children.length = 0;
  T.el.input.value = 'hello';
  await T.sendMessage();
  assert.strictEqual(T.el.input.value, 'hello'); // the message stays
  assert.ok(T.el.chat.children.some((c) => /Choose a model for this chat first\./.test(c.innerHTML)));
  assert.ok(!T.el.modelMenu.classList.contains('hidden'));
  T.closeModelMenu();
  assert.strictEqual(state.busy, false);
  // a pick heals the chat (the menu's fetches aside, nothing was sent)
  assert.ok(!(await T.chooseModel('gone', 'x')));
  await T.chooseModel('mu', 'qwen3.8-27b');
  assert.strictEqual(T.el.chatModel.textContent, 'qwen3.8-27b');
  assert.ok(asked <= 3);
  T.el.input.value = '';
});

test('health: no answer or HTTP 5xx marks the account down (stored, with the reason); any other answer clears it; Check provider asks /models', async () => {
  const snap = { prov: T.PROVIDERS.openai, cfg: { apiKey: 'sk-one-5678', model: 'gpt-6.1-sol', accountId: 'o1', name: 'OpenAI' } };
  const req = { url: 'https://api.openai.com/v1/responses', headers: {}, body: {} };
  const signal = new AbortController().signal;
  const o1 = () => state.settings.accounts.find((a) => a.id === 'o1');
  const stored = () => storage.muninAccounts.find((a) => a.id === 'o1');
  env.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => T.postJson(req, signal, snap), /Could not reach/);
  assert.strictEqual(o1().health.down, true);
  assert.strictEqual(o1().health.error, 'Failed to fetch');
  assert.ok(Date.now() - o1().health.at < 5000);
  deq(stored().health, o1().health);
  assert.match(T.healthTitle(o1()), /^Not reachable: Failed to fetch \(checked \d/);
  env.ctx.fetch = async () => json({ error: { message: 'Service unavailable' } }, 503);
  await assert.rejects(() => T.postJson(req, signal, snap), /503/);
  assert.strictEqual(o1().health.error, 'HTTP 503: Service unavailable');
  // a refused request reached the server: the mark goes
  env.ctx.fetch = async () => json({ error: { message: 'bad' } }, 401);
  await assert.rejects(() => T.postJson(req, signal, snap), /401/);
  assert.strictEqual(o1().health, undefined);
  assert.strictEqual(stored().health, undefined);
  // Stop is no outage
  env.ctx.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(() => T.postJson(req, signal, snap));
  assert.strictEqual(o1().health, undefined);
  // Check provider: the model list request marks and clears too
  env.ctx.fetch = async () => { throw new TypeError('connection refused'); };
  let r = await T.checkModels('o1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(o1().health.error, 'connection refused');
  env.ctx.fetch = async () => modelList(['gpt-6.1-sol', 'gpt-6-mini']);
  r = await T.checkModels('o1');
  deq([r.ok, r.ids], [true, ['gpt-6.1-sol', 'gpt-6-mini']]);
  // a list that arrived: verified (green), with the number of models, stored
  deq([o1().health.ok, o1().health.models], [true, 2]);
  deq(stored().health, o1().health);
  assert.match(T.healthTitle(o1()), /^Reachable: 2 models \(checked \d/);
  assert.strictEqual(T.healthState(o1()), 'ok');
  // a request that gets through keeps it (nothing stored); a 400 or 429 reached the server too
  const at = o1().health.at;
  env.ctx.fetch = async () => ({ ok: true, status: 200, body: {}, json: async () => ({}), text: async () => '' });
  await T.postJson(req, signal, snap);
  assert.strictEqual(o1().health.at, at);
  env.ctx.fetch = async () => json({ error: { message: 'too long' } }, 400);
  await assert.rejects(() => T.postJson(req, signal, snap), /400/);
  assert.strictEqual(o1().health.ok, true);
  // a rejected key: unknown (grey); a later answer with the list cached: verified again
  env.ctx.fetch = async () => json({ error: { message: 'bad' } }, 401);
  await assert.rejects(() => T.postJson(req, signal, snap), /401/);
  assert.strictEqual(o1().health, undefined);
  assert.strictEqual(T.healthTitle(o1()), 'Not checked yet');
  assert.strictEqual(T.healthState(o1()), '');
  env.ctx.fetch = async () => ({ ok: true, status: 200, body: {}, json: async () => ({}), text: async () => '' });
  await T.postJson(req, signal, snap);
  deq([o1().health.ok, o1().health.models], [true, 2]);
  // a down account that answers again without a cached list: unknown, not green
  const lists = state.modelLists.o1;
  state.modelLists.o1 = [];
  T.markAccountHealth('o1', Object.assign(new Error('x'), { status: 502 }));
  T.markAccountHealth('o1', null);
  assert.strictEqual(o1().health, undefined);
  state.modelLists.o1 = lists;
  // an empty list is no verification
  env.ctx.fetch = async () => modelList([]);
  r = await T.checkModels('o1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(o1().health, undefined);
  assert.match(T.healthTitle({ health: { ok: true, models: 1, at: Date.now() } }), /^Reachable: 1 model \(checked/);
});

test('health: the stored shapes (down, ok) are kept, anything else is dropped silently', () => {
  const list = T.sanitizeAccounts([
    { id: 'a', type: 'munin', name: 'A', apiKey: 'k', health: { down: true, error: 'HTTP 502', at: 5 } },
    { id: 'b', type: 'munin', name: 'B', apiKey: 'k', health: { ok: true, models: 3, at: 6, extra: 1 } },
    { id: 'c', type: 'munin', name: 'C', apiKey: 'k', health: { ok: 'yes' } },
    { id: 'd', type: 'munin', name: 'D', apiKey: 'k', health: 'down' },
  ]);
  deq(list.map((a) => a.health), [{ down: true, error: 'HTTP 502', at: 5 }, { ok: true, models: 3, at: 6 }, undefined, undefined]);
});

const modelsCall = (id, action, model = null) => ({ id, type: 'function', function: { name: 'models', arguments: JSON.stringify({ action, model }) } });
async function chatSnap() {
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };
  return snap;
}
const clearHealth = () => { for (const a of state.settings.accounts) delete a.health; };
// A fresh ok mark: a switch does not ask the account again.
const markFresh = (...ids) => { for (const id of ids) state.settings.accounts.find((a) => a.id === id).health = { ok: true, models: 1, at: Date.now() }; };

test('models list: every account with its health and model count, the chat\'s model named once; an empty list or a mark that is not a fresh ok is asked again', async () => {
  await freshChat();
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.settings.accounts.push({ id: 'an', type: 'anthropic', name: 'Anthropic', apiKey: '' });
  state.modelLists = { mu: ['qwen3.8-27b'], o1: ['gpt-6.1-sol', 'gpt-6-mini', 'o3'] };
  const acc = (id) => state.settings.accounts.find((a) => a.id === id);
  acc('mu').health = { down: true, error: 'HTTP 503', at: Date.now() - 60000 };
  acc('o1').health = { ok: true, models: 3, at: Date.now() - 60000 }; // fresh: not asked
  const asked = [];
  env.ctx.fetch = async (url, init) => {
    asked.push(init.headers.Authorization);
    assert.ok(init.signal, 'a time limit'); // a hung server must not stall the turn
    if (url.startsWith('https://api.muninai.org/')) throw new TypeError('connection refused');
    return modelList(['gpt-6-mini', 'gpt-6-nano']);
  };
  const snap = await chatSnap();
  const out = await T.executeTool(modelsCall('ml1', 'list'), 'manual', snap, {});
  deq(out.content.split('\n'), [
    'Providers (this chat: OpenAI / gpt-6.1-sol):',
    'Munin (down: no answer)', // a down mark is retried: still down (its reason in plain words)
    'OpenAI (ok, 3 models)',
    'Work (OpenAI, ok, 2 models)', // no mark and no list: asked
    'Anthropic (no API key)',
    'List a provider\'s models with provider and from/to.',
  ]);
  deq(asked.sort(), ['Bearer k-mu-1234', 'Bearer sk-two-9012']);
  assert.strictEqual(out._ok, true);
  assert.strictEqual(out._reading, true); // a quiet row
  assert.strictEqual(acc('o2').health.models, 2); // the fetch marks it
  assert.strictEqual(acc('mu').health.error, 'connection refused');
  // a down server that came back is seen; a stale ok mark (11 min) is asked again
  asked.length = 0;
  acc('o1').health.at = Date.now() - 11 * 60000;
  env.ctx.fetch = async (url, init) => { asked.push(init.headers.Authorization); return modelList(url.startsWith('https://api.muninai.org/') ? ['qwen3.8-27b'] : ['gpt-6.1-sol']); };
  const again = (await T.modelsTool({ action: 'list', model: null }, snap, 'manual')).split('\n');
  deq(again.slice(1, 4), ['Munin (ok, 1 model)', 'OpenAI (ok, 1 model)', 'Work (OpenAI, ok, 2 models)']);
  deq(asked.sort(), ['Bearer k-mu-1234', 'Bearer sk-one-5678']); // Work's mark is fresh
  assert.ok(Date.now() - acc('o1').health.at < 5000);
  // no mark with a cached list: asked; a rejected key is reported (and the mark stays absent)
  delete acc('o1').health;
  env.ctx.fetch = async () => json({ error: { message: 'bad' } }, 401);
  assert.strictEqual((await T.modelsTool({ action: 'list', model: null }, snap, 'manual')).split('\n')[2], 'OpenAI (key rejected)');
  // a request that does not answer in time: down with the reason, the tool still answers
  delete acc('o1').health;
  env.ctx.fetch = async (url) => { if (url.startsWith('https://api.openai.com/')) throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); return modelList(['x']); };
  assert.strictEqual((await T.modelsTool({ action: 'list', model: null }, snap, 'manual')).split('\n')[2], 'OpenAI (down: no answer)');
  state.settings.accounts = state.settings.accounts.filter((a) => a.id !== 'an');
  clearHealth();
});

test('models list with provider: the provider\'s mark is refreshed by the same rule; a down provider\'s cached list says so', async () => {
  await freshChat();
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.modelLists = { mu: ['qwen3.8-27b'], o1: ['gpt-6.1-sol', 'o3'] };
  const acc = (id) => state.settings.accounts.find((a) => a.id === id);
  acc('o1').health = { ok: true, models: 2, at: Date.now() - 60000 };
  let asked = 0;
  env.ctx.fetch = async () => { asked++; throw new TypeError('connection refused'); };
  const snap = await chatSnap();
  const list = (provider) => T.modelsTool({ action: 'list', provider, model: null }, snap, 'manual');
  assert.strictEqual((await list('OpenAI')).split('\n')[0], 'OpenAI: models 1–2 of 2:');
  assert.strictEqual(asked, 0); // a fresh ok mark
  acc('o1').health.at = Date.now() - 11 * 60000;
  assert.strictEqual((await list('OpenAI')).split('\n')[0], 'OpenAI (down: no answer): models 1–2 of 2:');
  assert.strictEqual(asked, 1);
  assert.strictEqual((await list('Munin')).split('\n')[0], 'Munin (down: no answer): model 1 of 1:'); // no mark: asked
  assert.strictEqual(asked, 2);
  clearHealth();
});

test('models check: every account is asked again; the lines carry the result and the health marks follow', async () => {
  await freshChat();
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.modelLists = { mu: ['qwen3.8-27b'], o1: ['gpt-6.1-sol'] };
  env.ctx.fetch = async (url, init) => {
    const a = init.headers.Authorization || '';
    if (url.startsWith('https://api.muninai.org/')) throw new TypeError('connection refused');
    if (a.endsWith('5678')) return modelList(['gpt-6.1-sol', 'gpt-6-mini', 'o3']);
    return json({ error: { message: 'Incorrect API key' } }, 401);
  };
  const out = await T.executeTool(modelsCall('mc1', 'check'), 'edit', await chatSnap(), {});
  const lines = out.content.split('\n');
  assert.strictEqual(lines[1], 'Munin (down: no answer)');
  assert.strictEqual(lines[2], 'OpenAI (reachable, 3 models)');
  assert.match(lines[3], /^Work \(OpenAI, key rejected\)/);
  assert.strictEqual(out._reading, true);
  const acc = (id) => state.settings.accounts.find((a) => a.id === id);
  assert.strictEqual(acc('mu').health.error, 'connection refused');
  deq([acc('o1').health.ok, acc('o1').health.models], [true, 3]);
  assert.strictEqual(acc('o2').health, undefined); // a rejected key: unknown
  // no account at all
  const saved = state.settings.accounts;
  state.settings.accounts = [];
  assert.strictEqual(await T.modelsTool({ action: 'check', model: null }, null, 'manual'), 'No provider is configured: the user adds one in the settings.');
  state.settings.accounts = saved;
  clearHealth();
});

test('models switch: the chat\'s meta, the label and the last choice change; refused for a down account, an unknown model, an agent, the self-test', async () => {
  await freshChat();
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.modelLists = { o2: ['gpt-6-mini', 'gpt-6-nano'] };
  markFresh('mu', 'o1', 'o2');
  const snap = await chatSnap();
  const out = await T.executeTool(modelsCall('ms1', 'switch', 'work/gpt-6-nano'), 'manual', snap, {});
  assert.strictEqual(out.content, 'Switched this chat to Work/gpt-6-nano; it answers from the next request.');
  assert.strictEqual(out._ok, true);
  assert.ok(!out._reading); // a one-line card, not a quiet row
  const meta = state.chats.find((c) => c.id === state.chatId);
  deq([meta.model.accountId, meta.model.model], ['o2', 'gpt-6-nano']);
  deq(storage.muninLastModel, { accountId: 'o2', model: 'gpt-6-nano' });
  assert.strictEqual(state.settings.accounts.find((a) => a.id === 'o2').model, 'gpt-6-nano');
  assert.strictEqual(T.el.chatModel.textContent, 'gpt-6-nano'); // the label follows at once
  deq([snap.cfg.accountId, snap.cfg.model, snap.cfg.apiKey, snap.prov.id, snap.switched], ['o2', 'gpt-6-nano', 'sk-two-9012', 'openai', true]);
  // the account by its id; the type only when one account has it
  assert.match((await T.executeTool(modelsCall('ms2', 'switch', 'munin/qwen3.8-27b'), 'manual', await chatSnap(), {})).content, /^Switched this chat to Munin\/qwen3\.8-27b/);
  assert.match((await T.executeTool(modelsCall('ms3', 'switch', 'openai/gpt-6-mini'), 'manual', await chatSnap(), {})).content, /^Switched this chat to OpenAI\/gpt-6-mini/); // a name before a type
  state.settings.accounts.push({ id: 'c1', type: 'anthropic', name: 'Claude A', apiKey: 'k1' }, { id: 'c2', type: 'anthropic', name: 'Claude B', apiKey: 'k2' });
  assert.match((await T.executeTool(modelsCall('ms3b', 'switch', 'anthropic/claude-opus-5-5'), 'manual', await chatSnap(), {})).content, /^Error: Several Anthropic.* accounts: name one of Claude A, Claude B\.$/);
  state.settings.accounts = state.settings.accounts.filter((a) => a.type !== 'anthropic');
  assert.match((await T.executeTool(modelsCall('ms4', 'switch', 'o2/gpt-6-mini'), 'manual', await chatSnap(), {})).content, /^Switched this chat to Work\/gpt-6-mini/);
  // refusals: the chat keeps its model
  const keep = JSON.stringify(state.chats.find((c) => c.id === state.chatId).model);
  assert.strictEqual((await T.executeTool(modelsCall('ms5', 'switch', 'Work/gpt-9'), 'manual', await chatSnap(), {})).content, 'Error: Work has no model "gpt-9". Its models: gpt-6-mini, gpt-6-nano.');
  assert.strictEqual((await T.executeTool(modelsCall('ms6', 'switch', 'Nobody/x'), 'manual', await chatSnap(), {})).content, 'Error: No account "Nobody". Accounts: Munin, OpenAI, Work.');
  assert.match((await T.executeTool(modelsCall('ms7', 'switch', 'gpt-6-mini'), 'manual', await chatSnap(), {})).content, /^Error: give model as "<account name>\/<model id>"/);
  // a down mark is asked again first: still down, the switch is refused; a server that came back is switched to
  state.settings.accounts.find((a) => a.id === 'mu').health = { down: true, error: 'HTTP 503', at: Date.now() };
  let asked = 0;
  env.ctx.fetch = async (url) => { asked++; if (String(url).startsWith('https://api.muninai.org/')) throw new TypeError('connection refused'); return modelList(['x']); };
  const down = await T.executeTool(modelsCall('ms8', 'switch', 'Munin/qwen3.8-27b'), 'manual', await chatSnap(), {});
  assert.strictEqual(down.content, 'Munin is not reachable; this chat stays on Work/gpt-6-mini.');
  deq([down._ok, down._message, asked], [false, 'Munin is not reachable', 1]);
  // an ok mark older than ten minutes is asked again too
  state.settings.accounts.find((a) => a.id === 'mu').health = { ok: true, models: 1, at: Date.now() - 11 * 60 * 1000 };
  assert.strictEqual((await T.executeTool(modelsCall('ms8b', 'switch', 'Munin/qwen3.8-27b'), 'manual', await chatSnap(), {})).content,
    'Munin is not reachable; this chat stays on Work/gpt-6-mini.');
  assert.strictEqual(asked, 2);
  const agentSnap = Object.assign(await chatSnap(), { agent: { task: 'x' } });
  assert.match((await T.executeTool(modelsCall('ms9', 'switch', 'OpenAI/gpt-6.1-sol'), 'edit', agentSnap, {})).content, /^Error: models is not offered now; use the tools you were given\.$/); // not offered
  assert.strictEqual(await T.modelsTool({ action: 'switch', model: 'OpenAI/gpt-6.1-sol' }, agentSnap, 'edit'), 'Error: an agent cannot switch the chat\'s model.');
  const quiet = Object.assign(await chatSnap(), { quiet: true }); // the self-test's loops
  assert.strictEqual((await T.executeTool(modelsCall('ms10', 'switch', 'OpenAI/gpt-6.1-sol'), 'manual', quiet, {})).content, 'Error: the model cannot be switched here.');
  const side = Object.assign(await chatSnap(), { side: true, chatCtx: { docId: state.docId, chatId: null, messages: [] } });
  assert.match((await T.executeTool(modelsCall('ms11', 'switch', 'OpenAI/gpt-6.1-sol'), 'manual', side, {})).content, /^Error: the model cannot be switched in a side question/);
  assert.strictEqual(JSON.stringify(state.chats.find((c) => c.id === state.chatId).model), keep);
  clearHealth();
});

test('models: the definition (strict, short), reading for list and check, offered in chat turns with client tools, not to agents or Munin personas; check_providers calls of stored chats stay quiet rows', async () => {
  await T.setChatModel('o1', 'gpt-6.1-sol');
  const def = T.MODELS_TOOL.function;
  assert.ok(def.description.length <= 180, def.description); // about 30 tokens
  deq(def.parameters.required, ['action', 'provider', 'from', 'to', 'model', 'max_tokens', 'temperature']);
  deq(def.parameters.properties.action.enum, ['list', 'check', 'switch', 'settings']);
  assert.strictEqual(T.isExtraReading('models', { action: 'list' }), true);
  assert.strictEqual(T.isExtraReading('models', { action: 'check' }), true);
  assert.strictEqual(T.isExtraReading('models', { action: 'switch', model: 'a/b' }), false);
  const snap = await chatSnap();
  const names = (mode, s) => T.toolsFor(mode, s).map((t) => t.function.name);
  for (const mode of ['manual', 'edit', 'plan']) assert.ok(names(mode, snap).includes('models'), mode);
  assert.ok(!names('edit', { ...snap, agent: { task: 'x' } }).includes('models'));
  await T.setChatModel('mu', 'qwen3.8-27b');
  const mu = await chatSnap();
  deq(T.toolsFor('research', mu), []); // a Munin persona turn has no client tools
  // Munin (no prompt cache): on demand, only when the message is about models, providers or switching; a call still runs
  const ask = (text) => ({ ...mu, chatCtx: { ...mu.chatCtx, messages: [{ role: 'user', content: text }] } });
  assert.ok(!names('edit', ask('Tighten the Methods section a bit, please, keeping every number and citation as written.')).includes('models'));
  for (const t of ['Switch this chat to gpt-6.1-sol', 'Which provider answers fastest?', 'Переключи модель на Claude']) assert.ok(names('edit', ask(t)).includes('models'), t);
  assert.ok(T.extraRuns(T.extraTool('models'), 'edit', ask('Tighten the Methods section a bit, please, keeping every number.')));
  // offered only while two or more models are usable: one account with one model has nothing to list or switch to
  const saved = state.settings.accounts.map((a) => ({ ...a }));
  const savedLists = { ...state.modelLists };
  try {
    for (const a of state.settings.accounts) if (a.id !== 'o1') a.apiKey = '';
    state.modelLists = { ...state.modelLists, o1: [] };
    assert.ok(!names('edit', snap).includes('models'), 'one usable model');
    state.modelLists.o1 = ['gpt-6.1-sol', 'gpt-6.1-mini'];
    assert.ok(names('edit', snap).includes('models'), 'one account, two models');
  } finally {
    state.settings.accounts.forEach((a, i) => Object.assign(a, saved[i]));
    state.modelLists = savedLists;
  }
  // the old tool: never offered, its stored calls render as quiet reading rows
  assert.ok(!names('edit', snap).includes('check_providers'));
  const old = { id: 'c', type: 'function', function: { name: 'check_providers', arguments: '{}' } };
  assert.ok(T.isReadingTool(old));
  const row = T.logEntry(old, { content: 'OpenAI: ok, 3 models', _ok: true });
  deq([row.name, row.status, row.write], ['check_providers', 'ok', undefined]);
});

test('models switch inside a tool loop: the next round goes to the new account, with the earlier rounds as plain messages', async () => {
  await freshChat();
  state.applyMode = 'manual';
  state.settings.accounts.push({ id: 'an', type: 'anthropic', name: 'Claude', apiKey: 'sk-ant-3456' });
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.modelLists = {};
  markFresh('an', 'o1', 'o2');
  // the OpenAI round carries a reasoning item: replayed within one provider's rounds, never to another account
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-OPENAI', summary: [] };
  const call = (id, model) => ({ type: 'function_call', id: 'fc_' + id, call_id: id, name: 'models', arguments: JSON.stringify({ action: 'switch', model }), status: 'completed' });
  const oaRound = (id, model) => ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [reasoning, call(id, model)], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  const { bodies, fetch } = providerRouter({ openai: [oaRound('sw1', 'Claude/claude-opus-5-5')], anthropic: [textRound('Done.')] });
  env.ctx.fetch = fetch;
  await send(env, 'switch to Claude');
  deq([bodies.openai.length, bodies.anthropic.length], [1, 1]);
  const second = bodies.anthropic[0];
  assert.strictEqual(second.model, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(second).includes('ENC-OPENAI'));
  assert.strictEqual(second.thinking, undefined); // the switched round's call has no thinking to go back with
  const asst = second.messages.filter((m) => m.role === 'assistant').pop();
  deq(asst.content.map((b) => [b.type, b.id, b.name]), [['tool_use', 'sw1', 'models']]);
  const result = second.messages[second.messages.length - 1].content.find((b) => b.type === 'tool_result');
  assert.strictEqual(result.content, 'Switched this chat to Claude/claude-opus-5-5; it answers from the next request.');
  assert.strictEqual(T.el.chatModel.textContent, 'claude-opus-5-5');
  deq(storage.muninLastModel, { accountId: 'an', model: 'claude-opus-5-5' });
  // another account of the same type: the first account's reasoning item does not go along
  await T.setChatModel('o1', 'gpt-6.1-sol');
  const r2 = providerRouter({ openai: [oaRound('sw2', 'Work/gpt-6-mini'), oaText('Ok.')] });
  env.ctx.fetch = r2.fetch;
  await send(env, 'switch to Work');
  assert.strictEqual(r2.bodies.openai.length, 2);
  assert.strictEqual(r2.bodies.openai[1].model, 'gpt-6-mini');
  assert.ok(!JSON.stringify(r2.bodies.openai[1].input).includes('ENC-OPENAI'));
  assert.ok(r2.bodies.openai[1].input.some((i) => i.type === 'function_call' && i.call_id === 'sw2' && !i.id)); // rebuilt from the tool call
  assert.ok(r2.bodies.openai[1].prompt_cache_key.startsWith('o2:')); // the new account's cache key
  // without a switch the reasoning item is replayed within the turn (the control case)
  await T.setChatModel('o1', 'gpt-6.1-sol');
  const r3 = providerRouter({ openai: [oaRound('ls1', null).replace('switch', 'list'), oaText('Ok.')] });
  env.ctx.fetch = async (url, init) => (String(url).endsWith('/models') ? modelList(['gpt-6.1-sol']) : r3.fetch(url, init));
  await send(env, 'list the models');
  assert.ok(JSON.stringify(r3.bodies.openai[1].input).includes('ENC-OPENAI'));
  state.settings.accounts = state.settings.accounts.filter((a) => a.id !== 'an');
  await T.setChatModel('o1', 'gpt-6.1-sol');
  clearHealth();
});

// A changed model whose first request fails: the chat goes back to the last choice that answered (meta.lastGood).
const chatMeta = () => state.chats.find((c) => c.id === state.chatId);
const shown = (re) => T.el.chat.children.filter((c) => re.test(String(c.innerHTML || c.textContent || ''))).length;
const refused = () => { throw new TypeError('connection refused'); };
async function noRetries(fn) {
  const delays = env.run('STREAM_RETRY_DELAYS_MS');
  const saved = delays.splice(0);
  try { await fn(); } finally { delays.push(...saved); }
}

test('a pick in the menu whose first request fails: back on the model that answered last, a stored row of the turn, the request asked again there', async () => {
  await freshChat();
  state.applyMode = 'manual';
  await T.setChatModel('o1', 'gpt-6.1-sol');
  let live = null; // the rows when the request is asked again (the live row, before the turn's re-render)
  const { bodies, fetch } = providerRouter({ openai: [oaText('One.'), () => { live = turnRowTexts(T.el.chat); return oaText('Back.'); }], munin: [refused] });
  env.ctx.fetch = fetch;
  await send(env, 'first');
  deq([chatMeta().lastGood.accountId, chatMeta().lastGood.model], ['o1', 'gpt-6.1-sol']);
  const stored = (await T.loadChatStore(state.docId)).chats.find((c) => c.id === state.chatId);
  deq([stored.lastGood.accountId, stored.lastGood.model], ['o1', 'gpt-6.1-sol']);
  await T.chooseModel('mu', 'qwen3.8-27b');
  assert.strictEqual(chatMeta().lastGood.accountId, 'o1'); // a pick keeps lastGood
  T.el.chat.children.length = 0;
  await noRetries(() => send(env, 'second'));
  deq([bodies.munin.length, bodies.openai.length], [1, 2]);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Back.');
  // the history holds the row: the model's text, the row's fields; the request asked again carries it as a user message
  const row = state.messages.find((m) => m._revert);
  deq(row, { role: 'user', content: 'Munin did not answer. Back on OpenAI/gpt-6.1-sol.', _auto: true,
    _revert: { from: 'Munin', to: 'OpenAI/gpt-6.1-sol', error: 'connection refused' } });
  assert.strictEqual(state.messages[state.messages.length - 2], row); // right before the answer it made possible
  deq(bodies.openai[1].input.filter((i) => i.role === 'user').map((i) => i.content).slice(-1), [row.content]);
  // the row of the turn's bubble, live and drawn by renderHistory (the stub chat keeps both; a real one is cleared first);
  // no bubble of its own
  const revertRows = () => turnRowTexts(T.el.chat).filter((t) => /did not answer/.test(t));
  deq(live, ['Munin did not answer. Back on OpenAI/gpt-6.1-sol.']); // live, in the turn's bubble
  assert.ok(revertRows().length >= 1);
  assert.ok(revertRows().every((t) => t === 'Munin did not answer. Back on OpenAI/gpt-6.1-sol.'));
  assert.strictEqual(shown(/did not answer/), 0);
  assert.strictEqual(shown(/Could not reach/), 0); // no error stays
  // it survives a reload of the chat, in the bubble of the answer it made possible
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(revertRows().length, 1);
  const bubble = T.el.chat.children.find((c) => c._notes && c._notes.length);
  assert.ok(bubble._rounds.some((r) => r.text === 'Back.'));
  deq([chatMeta().model.accountId, chatMeta().model.model], ['o1', 'gpt-6.1-sol']);
  assert.strictEqual(T.el.chatModel.textContent, 'gpt-6.1-sol');
  assert.strictEqual(state.settings.accounts.find((a) => a.id === 'mu').health.down, true); // marked down as before
  clearHealth();
});

test('a switch by the models tool to a server that then fails: the turn goes back and completes on the earlier model', async () => {
  await freshChat();
  state.applyMode = 'manual';
  await T.setChatModel('o2', 'gpt-6-mini');
  markFresh('mu'); // its /models answered: the switch goes through
  const sw = oaTool('sw1', 'models', { action: 'switch', provider: null, from: null, to: null, model: 'Munin/qwen3.8-27b', max_tokens: null, temperature: null });
  const { bodies, fetch } = providerRouter({ openai: [oaText('One.'), sw, oaText('Still here.')], munin: [() => json({ error: { message: 'account disabled' } }, 403)] });
  env.ctx.fetch = fetch;
  await send(env, 'first');
  T.el.chat.children.length = 0;
  await send(env, 'switch to Munin');
  deq([bodies.openai.length, bodies.munin.length], [3, 1]);
  assert.strictEqual(bodies.openai[2].model, 'gpt-6-mini');
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Still here.');
  // the switch result tells the truth; no row and no notice besides it
  const text = 'Switched to Munin/qwen3.8-27b, but it did not answer: this chat is back on Work/gpt-6-mini.';
  const sr = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'sw1');
  deq([sr.content, sr._ok, sr._message], [text, false, 'Munin did not answer']);
  assert.ok(!state.messages.some((m) => m._revert));
  assert.strictEqual(shown(/did not answer/), 0);
  const stored = (await T.loadChatStore(state.docId)).chats.find((c) => c.id === state.chatId);
  assert.ok(stored); // saved with the history
  // the request asked again replays the corrected result
  const out = bodies.openai[2].input.find((i) => i.type === 'function_call_output' && i.call_id === 'sw1');
  assert.strictEqual(out.output, text);
  // its action-log row reads failed (after the turn's re-render)
  const bubble = T.el.chat.children.find((c) => c._rounds && c._rounds.some((r) => r.list.some((a) => a && a.id === 'sw1')));
  const entry = bubble._rounds.flatMap((r) => r.list).find((a) => a && a.id === 'sw1');
  deq([entry.status, entry.result], ['fail', text]);
  deq([chatMeta().model.accountId, chatMeta().model.model], ['o2', 'gpt-6-mini']);
  // the next turn names the model it runs on (two or more models usable)
  const next = providerRouter({ openai: [oaText('Ok.')] });
  env.ctx.fetch = next.fetch;
  await send(env, 'which model?');
  assert.ok(userText(next.bodies.openai[0]).includes(runAs('gpt-6-mini', 'OpenAI (ChatGPT)', 'Work')));
  // a result of an earlier change (another time) is not the one that failed
  const old = { role: 'tool', _ok: true, _switch: { accountId: 'mu', model: 'qwen3.8-27b', at: 1 } };
  assert.strictEqual(T.revertedSwitch([old], { accountId: 'mu', model: 'qwen3.8-27b', at: 2 }), null);
  assert.strictEqual(T.revertedSwitch([old], { accountId: 'mu', model: 'qwen3.8-27b', at: 1 }), old);
  clearHealth();
});

test('no revert without a model that answered in the chat, after an error that is not the model\'s, or a second time in a turn', async () => {
  // a new chat on a failing model: the error stands, the chat stays
  await freshChat();
  state.applyMode = 'manual';
  await T.setChatModel('mu', 'qwen3.8-27b');
  assert.strictEqual(chatMeta().lastGood, undefined);
  let r = providerRouter({ openai: [oaText('never')], munin: [refused] });
  env.ctx.fetch = r.fetch;
  await noRetries(() => send(env, 'hello'));
  deq([r.bodies.munin.length, r.bodies.openai.length], [1, 0]);
  assert.ok(shown(/Could not reach/) >= 1);
  assert.strictEqual(chatMeta().model.accountId, 'mu');
  clearHealth();
  // the context does not fit: not the model's fault, no revert
  await T.setChatModel('o1', 'gpt-6.1-sol');
  r = providerRouter({ openai: [oaText('One.')], munin: [() => json({ error: { message: 'maximum context length exceeded' } }, 400)] });
  env.ctx.fetch = r.fetch;
  await send(env, 'first');
  await T.setChatModel('mu', 'qwen3.8-27b');
  await send(env, 'long');
  deq([r.bodies.munin.length, r.bodies.openai.length], [2, 1]); // the one resend with less context, then the error stands
  assert.strictEqual(chatMeta().model.accountId, 'mu');
  // the model it goes back to fails too: one revert, then the error stands
  await T.setChatModel('o2', 'gpt-6-mini');
  r = providerRouter({ openai: [(b, init) => (init.headers.Authorization.endsWith('9012') && !r.okDone ? (r.okDone = true, oaText('Ok.')) : json({ error: { message: 'Incorrect API key' } }, 401))], munin: [refused] });
  env.ctx.fetch = r.fetch;
  await send(env, 'first');
  await T.setChatModel('mu', 'qwen3.8-27b');
  T.el.chat.children.length = 0;
  await noRetries(() => send(env, 'again'));
  deq([r.bodies.munin.length, r.bodies.openai.length], [1, 2]);
  assert.ok(turnRowTexts(T.el.chat).some((t) => /^Munin did not answer\. Back on Work\/gpt-6-mini\.$/.test(t)));
  assert.ok(shown(/^Invalid OpenAI \(ChatGPT\) API key\. /) >= 1); // no code in the chat (errorWords)
  assert.strictEqual(chatMeta().model.accountId, 'o2');
  clearHealth();
});

test('agents: "<account name>/<model>" picks the account; the Agents line lists the other accounts; the agent\'s first message names its model', async () => {
  await freshChat();
  state.applyMode = 'manual';
  Object.assign(state.settings.accounts.find((a) => a.id === 'o2'), { model: 'gpt-6-mini' });
  Object.assign(state.settings.accounts.find((a) => a.id === 'mu'), { model: 'qwen3.8-27b' });
  await T.setChatModel('o1', 'gpt-6.1-sol');
  state.modelLists = {}; // no lists: any model id is accepted (the API refuses an unknown one)
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  const t1 = T.agentTarget('Work/gpt-6-mini', s);
  deq([t1.prov.id, t1.cfg.accountId, t1.cfg.apiKey, t1.cfg.model, t1.cfg.name], ['openai', 'o2', 'sk-two-9012', 'gpt-6-mini', 'Work']);
  assert.strictEqual(T.agentTarget('work', s).cfg.model, 'gpt-6-mini'); // a name alone: its last model; any case
  assert.strictEqual(T.agentTarget('o2/gpt-6-nano', s).cfg.accountId, 'o2'); // the id stands in for the name
  assert.strictEqual(T.agentTarget('openai/gpt-6-nano', s).cfg.accountId, 'o1'); // a type: the main account when it is of that type
  assert.strictEqual(T.agentTarget('gpt-6-mini', s).cfg.accountId, 'o2'); // a bare model id: the account that runs it
  state.modelLists.o2 = ['gpt-6-mini', 'gpt-6-nano'];
  assert.match(T.agentTarget('Work/gpt-9', s).error, /^Unknown model "Work\/gpt-9"/); // not in the account's list
  assert.match(T.agentTarget('Nobody/x', s).error, /^Unknown model "Nobody\/x"\. Available: OpenAI\/gpt-6\.1-sol, Munin\/qwen3\.8-27b, Work\/gpt-6-mini\./);
  const line = T.agentsLine('manual', s);
  assert.strictEqual(line, "Agents: delegate runs on OpenAI/gpt-6.1-sol by default; also available: Munin/qwen3.8-27b (local, free monthly quota, 64k context; search uses Munin's literature database), Work/gpt-6-mini (fast and cheap: lookups, extraction, summaries).");
  // the search sentence about Munin's database while a Munin account has a key
  const searchDesc = () => T.DELEGATE_TOOL.function.parameters.properties.search.description;
  assert.ok(searchDesc().includes('call search yourself'));
  const mu = state.settings.accounts.find((a) => a.id === 'mu');
  mu.apiKey = '';
  assert.ok(!searchDesc().includes('call search yourself'));
  mu.apiKey = 'k-mu-1234';
  // a whole turn: the agent on the Munin account; its first message names its own model
  const { bodies, fetch } = providerRouter({
    openai: [oaTool('c_del', 'delegate', { label: null, task: 'Find the methods.', context: null, model: 'Munin/qwen3.8-27b', search: false }), oaText('An agent looks.'), oaText('Lines 5-7.')],
    munin: [muText('Line 5.')],
  });
  env.ctx.fetch = fetch;
  await send(env, 'Where are the methods?');
  await T.agentsSettled(); // the agent runs in the background; its report comes with an automatic turn
  assert.strictEqual(bodies.munin.length, 1);
  const agentFirst = bodies.munin[0].messages.find((m) => m.role === 'user').content;
  assert.ok(agentFirst.includes(runAs('qwen3.8-27b', 'Munin', 'Munin')), agentFirst);
  assert.ok(userText(bodies.openai[0]).includes(runAs('gpt-6.1-sol', 'OpenAI (ChatGPT)', 'OpenAI')));
  const report = bodies.openai[2].input.filter((i) => i.role === 'user').pop();
  assert.ok(JSON.stringify(report.content).includes('Munin/qwen3.8-27b'), JSON.stringify(report));
});

test('the self-test runs on the chat\'s account', async () => {
  await T.setChatModel('o2', 'gpt-6-mini');
  const asked = [];
  env.ctx.fetch = async (url, init) => { asked.push([url, init.headers.Authorization]); return modelList(['gpt-6-mini']); };
  const row = await T.stModelList();
  assert.strictEqual(row.status, 'pass');
  deq(asked, [['https://api.openai.com/v1/models', 'Bearer sk-two-9012']]);
  const info = {};
  await T.stEnvironment({ info });
  deq([info.provider, info.model], ['OpenAI (ChatGPT)', 'gpt-6-mini']);
  // a Munin account with its own server: the self-test asks there
  state.settings.accounts.push({ id: 'lab', type: 'munin', name: 'Lab', apiKey: 'k-lab', baseUrl: 'https://lab.example.org/v1' });
  await T.setChatModel('lab', 'lab-model');
  asked.length = 0;
  await T.stModelList();
  deq(asked, [['https://lab.example.org/v1/models', 'Bearer k-lab']]);
  await T.removeAccount('lab');
});

test('two tabs: an account added or marked in one is taken over by the other; a panel\'s own quick writes do not undo each other', async () => {
  const store = sharedStorage();
  store.items.muninAccounts = JSON.parse(JSON.stringify(ACCOUNTS));
  const a = await load({ legacySettings: false });
  const b = await load({ legacySettings: false });
  store.attach(a); store.attach(b);
  await a.T.loadSettings(); await b.T.loadSettings();
  const added = await a.T.addAccount('anthropic');
  await tick(5);
  deq(b.state.settings.accounts.map((x) => x.id), ['mu', 'o1', 'o2', added.id]);
  // two writes in a row in B: the health mark, then a key; A ends with both, B keeps its own newest
  b.T.markAccountHealth('o1', Object.assign(new Error('x'), { status: 502 }));
  b.state.settings.accounts[3].apiKey = 'sk-ant-new';
  await b.T.persistAccounts();
  await tick(5);
  assert.strictEqual(b.state.settings.accounts[3].apiKey, 'sk-ant-new');
  assert.strictEqual(b.state.settings.accounts[1].health.error, 'HTTP 502');
  assert.strictEqual(a.state.settings.accounts[3].apiKey, 'sk-ant-new');
  assert.strictEqual(a.state.settings.accounts[1].health.error, 'HTTP 502');
});
