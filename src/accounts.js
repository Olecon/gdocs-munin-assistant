'use strict';
// Module accounts.js: the chat's model menu (the model label under the input box is its button: openModelMenu,
// closeModelMenu, refreshModelMenu, chooseModel, bindModelMenu) and the models tool (modelsTool: list, check, switch, settings). The
// accounts themselves, their model lists and health marks live in settings.js. Loaded after chat-title.js, so the tool
// comes after chat_title and before delegate in the request's tool list.
/* global onDemandOffer, onDemandProvider, accountById, accountConfig, chatProbeOn, healthError, isOutage, setChatModelMeta, accountModel, accounts, canRequest, chatAsked, chatChoice, PROVIDERS, checkModels, defaultReplyTokens, el, HEALTH_FRESH_MS, healthState, healthTime, healthTitle,
   addAutoRow, isMuninPersona, lastSentText, accountParams, MODELS_FETCH_TIMEOUT_MS, openSettings, providerFor, registerTools, setChatModel, setAccountParams, shortModelId, state, temperatureRefused, TEMPERATURE_MAX, typeName */
/* exported openModelMenu, closeModelMenu, refreshModelMenu, chooseModel, bindModelMenu, modelsTool, MODELS_TOOL, paramsMentioned,
   noteChatAnswered, revertChatModel, usableModels */

// ---- The model menu: a popover above the model label, grouped by account ------------------------------------------
// Each account: its name and type and the health dot (red with the reason while it is marked down), then its cached
// models (fetched on opening while the cache is empty), the chat's model checked. Nothing else ("Check provider" is in
// Settings), so the menu stays a plain list. A pick applies at once to the open chat (settings.js setChatModel).
const modelMenu = { open: false, fetched: new Set() };

function menuNode(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderModelMenu() {
  const box = el.modelMenu;
  if (!box) return;
  box.textContent = '';
  const list = accounts();
  if (!list.length) {
    box.appendChild(menuNode('div', 'model-menu-hint', 'No provider yet.'));
    const open = menuNode('button', 'btn small model-settings', 'Open settings');
    open.type = 'button';
    box.appendChild(open);
    positionModelMenu();
    return;
  }
  const choice = chatChoice();
  for (const a of list) {
    const group = menuNode('div', 'model-group');
    group.dataset.account = a.id;
    const head = menuNode('div', 'model-group-head');
    const dot = menuNode('span', ('health-dot ' + healthState(a)).trim());
    dot.dataset.tip = healthTitle(a);
    const name = menuNode('span', 'model-group-name', a.name);
    const type = menuNode('span', 'model-group-type', typeName(a.type));
    head.append(dot, name, type);
    group.appendChild(head);
    if (!canRequest(a)) {
      const noUrl = PROVIDERS[a.type].needsUrl && !a.baseUrl;
      group.appendChild(menuNode('div', 'model-menu-hint', noUrl ? 'No server URL: add it in the settings.' : 'No API key: add it in the settings.'));
    } else {
      const models = (state.modelLists[a.id] || []).slice();
      const mine = choice && choice.accountId === a.id ? choice.model || accountModel(a) : '';
      if (mine && !models.includes(mine)) models.unshift(mine);
      if (!models.length) group.appendChild(menuNode('div', 'model-menu-hint', modelMenu.fetched.has(a.id) ? 'Loading the models…' : 'No model list yet.'));
      for (const m of models) {
        const on = m === mine;
        const row = menuNode('button', 'mode-row model-pick' + (on ? ' active' : ''));
        row.type = 'button';
        row.setAttribute('role', 'menuitemradio');
        row.setAttribute('aria-checked', String(on));
        row.dataset.account = a.id;
        row.dataset.model = m;
        const mark = menuNode('span', 'mode-check', on ? '✓' : '');
        mark.setAttribute('aria-hidden', 'true');
        row.append(mark, menuNode('span', 'model-pick-name', m));
        group.appendChild(row);
      }
    }
    box.appendChild(group);
  }
  positionModelMenu();
}

// Fixed above the label (the composer clips overflow), its right edge at the label's, kept inside the panel.
function positionModelMenu() {
  if (!modelMenu.open || !el.chatModel) return;
  const r = el.chatModel.getBoundingClientRect();
  const width = Math.min(300, Math.max(200, window.innerWidth - 16));
  el.modelMenu.style.left = Math.round(Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))) + 'px';
  el.modelMenu.style.width = width + 'px';
  el.modelMenu.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
}

// Opens the menu; an account with a key and no cached list is asked for its models once per opening.
function openModelMenu() {
  if (!el.modelMenu || !el.chatModel) return;
  modelMenu.open = true;
  modelMenu.fetched = new Set();
  el.modelMenu.classList.remove('hidden');
  el.chatModel.setAttribute('aria-expanded', 'true');
  for (const a of accounts()) {
    if (!canRequest(a) || (state.modelLists[a.id] || []).length) continue;
    modelMenu.fetched.add(a.id);
    checkModels(a.id).then((r) => { if (!r.ok) modelMenu.fetched.delete(a.id); refreshModelMenu(); });
  }
  renderModelMenu();
}

function closeModelMenu() {
  if (!modelMenu.open) return;
  modelMenu.open = false;
  el.modelMenu.classList.add('hidden');
  el.modelMenu.textContent = '';
  el.chatModel.setAttribute('aria-expanded', 'false');
}

// Re-renders the open menu (a list arrived, a health mark changed); nothing while it is closed.
function refreshModelMenu() {
  if (modelMenu.open) renderModelMenu();
}

// A pick (here or in a settings row: settings.js onModelPick): the open chat runs on it from the next message on.
// Returns false for an unknown account or an empty id.
async function chooseModel(accountId, model) {
  const a = accountById(accountId);
  const m = String(model || '').trim();
  if (!a || !m) return false;
  closeModelMenu();
  return setChatModel(accountId, m);
}

function bindModelMenu() {
  if (!el.chatModel || !el.modelMenu) return;
  el.chatModel.addEventListener('click', () => { if (modelMenu.open) closeModelMenu(); else openModelMenu(); });
  el.modelMenu.addEventListener('click', (e) => {
    const t = e.target;
    const pick = t.closest('.model-pick');
    if (pick) { chooseModel(pick.dataset.account, pick.dataset.model); return; }
    if (t.closest('.model-settings')) { closeModelMenu(); openSettings(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!modelMenu.open) return;
    if (el.modelMenu.contains(e.target) || el.chatModel.contains(e.target)) return;
    closeModelMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (modelMenu.open && e.key === 'Escape') { e.preventDefault(); closeModelMenu(); el.chatModel.focus(); }
  });
  window.addEventListener('resize', positionModelMenu);
}

// ---- The models tool ---------------------------------------------------------------------------------------------
// list: every account with its health and model count, the chat's account and model named once; an account is asked
// for /models first when its list is empty or its health mark is absent, down or older than HEALTH_FRESH_MS (the model
// says "available" from this line, so a stale mark must not answer); with provider: that account's models numbered in
// the cached order (refreshed by the same rule), a range of at most MODELS_LIST_MAX per call (from / to), the chat's
// model marked; check: every account's /models asked again (the health marks follow); switch: the chat runs on
// "<account>/<model>" (a short id, a full one or a number of the list) from the next request on (setChatModel, as a
// pick in the menu; an account that does not answer, asked again by the rule of list, is refused); settings: an account's reply length and temperature for all its
// models reported or stored (as Advanced in the settings row). It replaces check_providers, whose calls in stored chats
// still render as quiet rows (tools.js LEGACY_READING_TOOLS).
const MODELS_TOOL = { type: 'function', function: {
  name: 'models',
  description: 'The providers: list them or one provider\'s models (the chat\'s marked *); check asks each now (do it before saying one works); switch this chat\'s model when asked; settings.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'check', 'switch', 'settings'] },
      provider: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'list: an account name to list its models; else null.' },
      from: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'first model number' },
      to: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'last model number' },
      model: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'switch: "<account name>/<model id or number>"; settings: "<account name>" (null = this chat\'s provider); else null.' },
      max_tokens: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'settings: max output tokens; 0 = default; null = unchanged (both null: report).' },
      temperature: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'settings: 0-2; -1 = default; null = unchanged.' },
    },
    required: ['action', 'provider', 'from', 'to', 'model', 'max_tokens', 'temperature'],
    additionalProperties: false,
  },
} };
const MODELS_LIST_MAX = 50; // models listed per call

const modelCount = (k) => `${k} model${k === 1 ? '' : 's'}`;
// " [max 2048, temp 0.3]" after an account with the user's settings, else ''.
function paramsTag(a) {
  const own = accountParams(a);
  const parts = [...(own.maxTokens ? ['max ' + own.maxTokens] : []), ...(own.temperature != null ? ['temp ' + own.temperature] : [])];
  return parts.length ? ` [${parts.join(', ')}]` : '';
}
// The state of an account: r is the answer of the /models request just made ({ok, ids} or {ok: false, ...}), or null.
// A list that arrived for an account whose chat was refused (a down mark kept) is still down. Plain words only: the
// model relays them, and the owner wants no HTTP codes or server texts in the chat (the settings dot's tooltip has them).
function modelsState(a, r, check) {
  if (!canRequest(a)) return PROVIDERS[a.type].needsUrl && !a.baseUrl ? 'no server URL' : 'no API key';
  const n = (state.modelLists[a.id] || []).length;
  const st = healthState(a);
  if (r && r.ok && st !== 'down') return `${check ? 'reachable' : 'ok'}, ${modelCount(r.ids.length)}${r.chat ? ', chat works' : ''}`;
  if (st === 'down') return `${downWords(a)}${r ? '' : ` (checked ${healthTime(a.health.at)})`}`;
  if (r) return r.status === 401 || r.status === 403 ? 'key rejected' : 'no answer';
  if (st === 'ok') return `ok, ${modelCount(n || a.health.models)}`;
  return n ? `unknown, ${modelCount(n)}` : 'unknown';
}
// "down: no chat answer" (the server lists its models but refused the chat probe), "down: no answer" (no connection or
// a timeout), else "down" (the server answered with an error).
function downWords(a) {
  const h = a.health || {};
  if (h.chat === false) return 'down: no chat answer';
  return /^HTTP /.test(String(h.error || '')) ? 'down' : 'down: no answer';
}
// "Yandex (Custom, ok, 25 models) [max 2048, temp 0.3]" (the type when the name is not the type's; the brackets only
// with the user's settings; a model-id prefix is never shown: the model works with the short ids and users saw it echoed).
function modelsLine(a, r, check) {
  const now = accountById(a.id) || a;
  const tags = [...(now.name !== typeName(now.type) ? [typeName(now.type)] : []), modelsState(now, r, check)];
  return `${now.name} (${tags.join(', ')})${paramsTag(now)}`;
}
// The chat's choice in this turn: the turn's account and model.
const turnChoice = (snap) => (snap && snap.cfg && snap.cfg.accountId ? { accountId: snap.cfg.accountId, model: snap.cfg.model } : chatChoice());
// The model the choice runs on when it is the account's ('' otherwise).
const mineOn = (a, choice) => (choice && choice.accountId === a.id ? choice.model || accountModel(a) : '');
// Whether list asks the account again: no fresh ok mark (absent, down: a server that came back is seen, or stale).
const healthStale = (a) => healthState(a) !== 'ok' || !(Date.now() - (Number(a.health.at) || 0) < HEALTH_FRESH_MS);
// An account's list as cached, asked for first when empty or force: { list, r } (r: the answer of that request, or
// null). Never throws: a failed request is an answer with ok false (a timeout included: MODELS_FETCH_TIMEOUT_MS).
// probe (check and switch, not list's refresh): the account must also answer a chat probe (settings.js checkModels).
async function cachedList(a, force, probe = false) {
  let r = null;
  if (canRequest(a) && (force || !(state.modelLists[a.id] || []).length)) {
    try { r = await checkModels(a.id, { timeoutMs: MODELS_FETCH_TIMEOUT_MS, ...(probe ? { probe: true } : {}) }); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  }
  return { list: state.modelLists[a.id] || [], r };
}

// list (check false: only the accounts without a cached list or a fresh ok mark are asked) or check (every account is
// asked): one line per account, the models themselves only with provider (providerModels).
async function listModels(args, snap, check) {
  const list = accounts();
  if (!list.length) return 'No provider is configured: the user adds one in the settings.';
  if (!check && args && typeof args.provider === 'string' && args.provider.trim()) return providerModels(args, snap);
  const asked = await Promise.all(list.map((a) => cachedList(a, check || healthStale(a), check).then((x) => x.r)));
  refreshModelMenu();
  const choice = turnChoice(snap);
  const chatAcc = choice && accountById(choice.accountId);
  const head = chatAcc ? `Providers (this chat: ${chatAcc.name} / ${mineOn(chatAcc, choice)}):` : 'Providers:';
  const any = list.some((a) => (state.modelLists[a.id] || []).length);
  return [head, ...list.map((a, i) => modelsLine(a, asked[i], check)), ...(any ? ['List a provider\'s models with provider and from/to.'] : [])].join('\n');
}

// list with provider: "Yandex: models 1–25 of 25:", then "1. qwen3.6-35b-a3b/latest*" per model; the
// header's "of N" is the only hint that more remain (a trailing "list with from" line was echoed to users by weak models).
async function providerModels(args, snap) {
  const named = namedAccount(providerPart(args.provider), 'provider');
  if (named.error) return 'Error: ' + named.error;
  const a = named.account;
  if (!canRequest(a)) return `Error: ${a.name} has ${PROVIDERS[a.type].needsUrl && !a.baseUrl ? 'no server URL' : 'no API key'} in the settings.`;
  const { list, r } = await cachedList(a, healthStale(a));
  if (r) refreshModelMenu();
  if (!list.length) return `${a.name} (${modelsState(a, r, false)}): no model list.`;
  const down = healthState(a) === 'down' ? ` (${downWords(a)})` : ''; // the cached list of a server that did not answer
  const n = list.length;
  const from = args.from == null ? 1 : args.from;
  if (!Number.isInteger(from) || from < 1 || from > n) return `Error: ${a.name} has ${modelCount(n)}; from must be 1 to ${n}.`;
  const asked = args.to == null ? n : args.to;
  if (!Number.isInteger(asked) || asked < from) return 'Error: to must be at least from, or null.';
  const to = Math.min(asked, n, from + MODELS_LIST_MAX - 1);
  const mine = mineOn(a, turnChoice(snap));
  const range = from === to ? `model ${from}` : `models ${from}–${to}`;
  const lines = [`${a.name}${down}: ${range} of ${n}:`];
  for (let i = from; i <= to; i++) lines.push(`${i}. ${list[i - 1]}${list[i - 1] === mine ? '*' : ''}`);
  if (mine && !list.includes(mine)) lines.push(`This chat runs on ${mine} (not in the list).`);
  return lines.join('\n');
}
// "<account>" or "<account>/<anything>": the account part.
const providerPart = (v) => { const raw = String(v || '').trim(); const cut = raw.indexOf('/'); return (cut < 0 ? raw : raw.slice(0, cut)).trim(); };

// The account a name, an id or a type names (a type only when one account has it); { account } or { error }.
// noun: what the refusal calls it ("account": switch and settings; "provider": list).
function namedAccount(part, noun = 'account') {
  const p = part.toLowerCase();
  const list = accounts();
  const hit = list.find((a) => a.name.toLowerCase() === p) || list.find((a) => a.id.toLowerCase() === p);
  if (hit) return { account: hit };
  const ofType = PROVIDERS[p] ? list.filter((a) => a.type === p) : [];
  if (ofType.length === 1) return { account: ofType[0] };
  if (ofType.length > 1) return { error: `Several ${typeName(p)} accounts: name one of ${ofType.map((a) => a.name).join(', ')}.` };
  const names = list.map((a) => a.name).join(', ') || 'none';
  return { error: noun === 'provider' ? `No provider "${part}". Providers: ${names}.` : `No account "${part}". Accounts: ${names}.` };
}

// The model a switch names on the account: a listed id, a full id (shortened), or a number of the list; '' for none.
function pickedModel(a, model) {
  const list = state.modelLists[a.id] || [];
  const short = shortModelId(a, model);
  if (!list.length || list.includes(short) || short === accountModel(a)) return short;
  const n = /^\d+$/.test(short) ? Number(short) : 0;
  return n >= 1 && n <= list.length ? list[n - 1] : '';
}

async function switchModel(spec, snap, mode) {
  if (snap.agent) return 'Error: an agent cannot switch the chat\'s model.';
  if (snap.quiet) return 'Error: the model cannot be switched here.';
  const c = snap.chatCtx;
  if (snap.side || !c || !c.chatId) return 'Error: the model cannot be switched in a side question. Tell the user to ask in the main chat.';
  const raw = typeof spec === 'string' ? spec.trim() : '';
  const cut = raw.indexOf('/');
  const asked = cut < 0 ? '' : raw.slice(cut + 1).trim();
  if (cut <= 0 || !asked) return 'Error: give model as "<account name>/<model id>" (see models list).';
  const { account: a, error } = namedAccount(raw.slice(0, cut).trim());
  if (error) return 'Error: ' + error;
  if (!canRequest(a)) return `Error: ${a.name} has ${PROVIDERS[a.type].needsUrl && !a.baseUrl ? 'no server URL' : 'no API key'} in the settings.`;
  // A stale or down mark, or one without a chat answer, is asked again first with the chat probe: a switch to a server
  // that lists its models but does not answer a chat request is refused.
  let r = null;
  if (healthStale(a) || (chatProbeOn() && !a.health.chat)) { r = (await cachedList(a, true, true)).r; refreshModelMenu(); }
  const refused = r && r.chatRefused && !r.ok;
  if (healthState(a) === 'down' || refused) {
    const now = turnChoice(snap);
    const cur = now && accountById(now.accountId);
    // The reason stays in the health mark (the settings dot's tooltip): the model would relay a code to the user.
    return { content: `${a.name} is not reachable; this chat stays on ${cur ? `${cur.name}/${mineOn(cur, now)}` : 'its model'}.`,
      _ok: false, _message: `${a.name} is not reachable` };
  }
  const model = pickedModel(a, asked);
  if (!model) {
    const list = state.modelLists[a.id] || [];
    const which = list.length <= 20 ? `Its models: ${list.join(', ')}.` : `List its models with provider "${a.name}".`; // a short list inline, a long one by the tool
    return `Error: ${a.name} has no model "${asked}". ${which}`;
  }
  const label = `${a.name}/${model}`;
  if (snap.cfg && snap.cfg.accountId === a.id && snap.cfg.model === model) return { content: `This chat already runs on ${label}.`, _ok: true, _message: `Model: ${label}` };
  if (!(await setChatModel(a.id, model, { docId: c.docId, chatId: c.chatId }))) return `Error: ${a.name} was removed.`;
  refreshModelMenu();
  // The turn's following rounds go to the new account (toolLoop drops the old provider's replay payloads), except
  // when that would make this turn a Munin persona turn (no client tools): the switch then waits for the next message.
  // _switch: the change this result made (its time is the chat meta's model.at), so a revert finds the result to correct.
  const meta = chatMetaOf(snap);
  const done = { _ok: true, _message: `Switched to ${label}`, _switch: { accountId: a.id, model, at: (meta && meta.model && meta.model.at) || 0 } };
  const prov = providerFor(a, model);
  if (isMuninPersona(mode, { ...snap, prov }) && !isMuninPersona(mode, snap)) {
    return { content: `Switched this chat to ${label}; it answers from the user's next message.`, ...done };
  }
  snap.prov = prov;
  snap.cfg = accountConfig(a, model);
  snap.switched = true;
  return { content: `Switched this chat to ${label}; it answers from the next request.`, ...done };
}

// ---- Going back after a failed switch ----------------------------------------------------------------------------
// The chat's meta remembers the last choice that answered (lastGood); a request that fails before anything streamed,
// on a choice other than that one, sends the turn back to it once (toolLoop). Main-chat turns only: not an agent, the
// self-test, a side question or a background pass, which do not run on the chat's choice or cannot change it.
const chatTurn = (snap) => !!snap && !!snap.chatCtx && !!snap.chatCtx.chatId && !snap.agent && !snap.quiet && !snap.side && !snap.background &&
  !!snap.cfg && !!snap.cfg.accountId;
function chatMetaOf(snap) {
  const c = snap.chatCtx;
  return c.docId === state.docId ? (state.chats || []).find((m) => m.id === c.chatId) || null : null;
}
// A request of the turn got an answer: its choice becomes the chat's lastGood (stored only when it changed).
async function noteChatAnswered(snap) {
  if (!chatTurn(snap)) return;
  const meta = chatMetaOf(snap);
  const { accountId, model } = snap.cfg;
  if (!meta || (meta.lastGood && meta.lastGood.accountId === accountId && meta.lastGood.model === model)) return;
  meta.lastGood = { accountId, model, at: Date.now() };
  await setChatModelMeta(snap.chatCtx.docId, snap.chatCtx.chatId, meta.lastGood, 'lastGood');
}
// A server that refuses the model ("model not found" and the like in a 400).
const MODEL_MISSING_RE = /model[^.]{0,40}\b(not found|not exist|does not exist|unknown|invalid|not available|not supported)|\b(unknown|invalid|no such) model/i;
// Failures that say the choice cannot answer: no answer or 5xx, Chrome's block, a rejected key, a missing model.
const choiceFailed = (e) => !!e && !e.partial && e.name !== 'AbortError' &&
  (isOutage(e) || !!e.noAccess || [401, 403, 404].includes(e.status) || (e.status === 400 && MODEL_MISSING_RE.test(e.serverMessage || '')));
// After such a failure on a choice other than the chat's lastGood: the chat goes back to lastGood (its meta, the menu,
// snap.prov and snap.cfg for the rest of the turn) and the history says so, so the model learns it (it would otherwise
// go on saying it runs on the failed model): the models switch result that made the change is rewritten as failed
// (revertedSwitch), else (a pick in the model menu) a stored row is appended (_auto, _revert), drawn as a row of the turn's
// bubble (addAutoRow). The row or the failed switch row is the trace. Returns false, or { call } (call: the rewritten result's id, null for a row); the
// caller asks again. Once per turn (snap.reverted); never into a Munin persona turn (it has no client tools).
async function revertChatModel(e, mode, snap, messages = []) {
  if (snap.reverted || !chatTurn(snap) || !choiceFailed(e)) return false;
  const meta = chatMetaOf(snap);
  const good = meta && meta.lastGood;
  const a = good && accountById(good.accountId);
  if (!a || !canRequest(a) || (good.accountId === snap.cfg.accountId && good.model === snap.cfg.model)) return false;
  const prov = providerFor(a, good.model);
  if (isMuninPersona(mode, { ...snap, prov })) return false;
  const failed = { accountId: snap.cfg.accountId, model: snap.cfg.model, name: snap.cfg.name || snap.prov.label, at: meta.model && meta.model.at };
  snap.reverted = true;
  if (!(await setChatModel(a.id, good.model, { docId: snap.chatCtx.docId, chatId: snap.chatCtx.chatId }))) return false;
  refreshModelMenu();
  snap.prov = prov;
  snap.cfg = accountConfig(a, good.model);
  const back = `${a.name}/${snap.cfg.model}`;
  const error = healthError(e); // for the log only: the texts the model reads carry no code (it would relay it)
  const sw = revertedSwitch(messages, failed);
  if (sw) {
    Object.assign(sw, { content: `Switched to ${failed.name}/${failed.model}, but it did not answer: this chat is back on ${back}.`,
      _ok: false, _message: `${failed.name} did not answer` });
    return { call: sw.tool_call_id };
  }
  const row = { role: 'user', content: `${failed.name} did not answer. Back on ${back}.`, _auto: true,
    _revert: { from: failed.name, to: back, error } };
  messages.push(row);
  addAutoRow(row);
  return { call: null };
}
// The stored models switch result that made the failed change (its _switch is the chat's current choice, the same
// time included: a later pick in the menu is another change), or null.
function revertedSwitch(messages, failed) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const s = messages[i] && messages[i].role === 'tool' && messages[i]._ok !== false ? messages[i]._switch : null;
    if (s && s.accountId === failed.accountId && s.model === failed.model && s.at === failed.at) return messages[i];
  }
  return null;
}

// "max output tokens 4096 (default), temperature server default" for the account on model m (the values in force; a
// capped reply length or a refused temperature names the model).
function paramsText(a, m) {
  const own = accountParams(a);
  const used = providerFor(a, m).maxTokens;
  const max = own.maxTokens ? `${used}${used !== own.maxTokens ? ` for ${m} (${own.maxTokens} asked; kept between 256 and half the context window)` : ''}` : `${defaultReplyTokens(a, m)} (default)`;
  const temp = own.temperature != null ? String(own.temperature) : PROVIDERS[a.type].sampling ? 'default' : 'server default';
  return `max output tokens ${max}, temperature ${temp}${temperatureRefused(a.type, m) ? ` (not sent to ${m}: it refuses a temperature)` : ''}`;
}
// settings: the account ("<account>", "<account>/<anything>" read as the account, or null for the turn's) and its values
// reported (both null) or stored. The values are shown for the turn's model on the turn's account, else the account's.
async function modelSettings(args, snap) {
  const raw = typeof args.model === 'string' ? args.model.trim() : '';
  const choice = turnChoice(snap);
  let a;
  if (!raw) {
    a = choice && accountById(choice.accountId);
    if (!a) return 'Error: this chat has no provider; give model as "<account name>".';
  } else {
    const cut = raw.indexOf('/');
    const named = namedAccount((cut < 0 ? raw : raw.slice(0, cut)).trim());
    if (named.error) return 'Error: ' + named.error;
    a = named.account;
  }
  const model = (choice && choice.accountId === a.id && choice.model) || accountModel(a);
  const patch = {};
  const max = args.max_tokens;
  if (max != null) {
    if (!Number.isInteger(max) || max < 0) return 'Error: max_tokens must be a whole number above 0, 0 for the default, or null.';
    patch.maxTokens = max === 0 ? null : max;
  }
  const t = args.temperature;
  if (t != null) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t > TEMPERATURE_MAX || (t < 0 && t !== -1)) return `Error: temperature must be from 0 to ${TEMPERATURE_MAX}, -1 for the default, or null.`;
    patch.temperature = t === -1 ? null : t;
  }
  if (!Object.keys(patch).length) return `${a.name}: ${paramsText(a, model)}.`;
  await setAccountParams(a.id, patch);
  // The chat's own account: the turn's next round already uses the new values (as switchModel replaces snap.prov).
  if (snap && !snap.agent && snap.cfg && snap.cfg.accountId === a.id) snap.prov = providerFor(a, snap.cfg.model);
  return { content: `Set for ${a.name}: ${paramsText(a, model)}; applies to all its models from the next request.`, _ok: true, _message: `Settings of ${a.name}` };
}

async function modelsTool(args, snap, mode) {
  const action = args && args.action;
  if (action === 'list' || action === 'check') return listModels(args, snap, action === 'check');
  if (action === 'switch') return switchModel(args.model, snap, mode);
  if (action === 'settings') return modelSettings(args, snap);
  return 'Error: action must be list, check, switch or settings.';
}

// list, check and a settings call that only reports read; a switch and a settings call with a value write.
const changesSettings = (args) => !!args && args.action === 'settings' && (args.max_tokens != null || args.temperature != null);
const isModelsReading = (args) => !args || (args.action !== 'switch' && !changesSettings(args));
// The user's message is about the reply length or the temperature (English and Russian).
const PARAMS_WORDS_RE = /\b(tokens?|temperature|max[ _-]?output)\b|токен|температур/i;
const paramsMentioned = (text) => PARAMS_WORDS_RE.test(String(text || ''));
// Whether there is anything to list or switch to: two or more accounts that can be asked, or one with two or more
// models in its cached list.
const usableModels = () => accounts().filter(canRequest).reduce((n, a) => n + Math.max(1, (state.modelLists[a.id] || []).length), 0);
// "list", "check" or "list <provider>".
const listSummary = (args) => {
  const action = String((args && args.action) || 'list');
  const p = action === 'list' && typeof args.provider === 'string' ? args.provider.trim() : '';
  return p ? `list ${p}` : action;
};
// The user's message is about models, providers or switching (English and Russian).
const MODELS_WORDS_RE = /\b(?:models?|providers?|accounts?|switch\w*|gpt\S*|claude|qwen\S*|munin|llm)\b|модел|провайдер|аккаунт|переключ|нейросет/i;
const modelsBase = (mode, snap) => !!snap && !!snap.prov && !snap.agent && !isMuninPersona(mode, snap);
registerTools(MODELS_TOOL, {
  // Not inside an agent, not in Munin persona turns (no client tools there). With a prompt cache (OpenAI, Anthropic):
  // every turn while two or more models are usable, and with one model when the user's message is about tokens or the
  // temperature (the settings action). On Munin and custom servers (no cache) only when the message is about models,
  // providers, switching, tokens or the temperature (request.js onDemandOffer); a call made unoffered still runs.
  offer: (mode, snap) => modelsBase(mode, snap) && (onDemandProvider(snap)
    ? accounts().some(canRequest) && onDemandOffer(snap, (t) => MODELS_WORDS_RE.test(t) || paramsMentioned(t))
    : usableModels() >= 2 || (accounts().some(canRequest) && chatAsked(snap, paramsMentioned, lastSentText()))),
  runs: (mode, snap) => modelsBase(mode, snap) && accounts().some(canRequest),
  // list, check and a settings report only read; a switch or a settings change is a write without the edit gate
  // (anyMode: it runs outside an editing turn too).
  reading: (name, args) => isModelsReading(args),
  anyMode: true,
  pending: (args) => (args && args.action === 'settings' ? 'Changing the provider settings…' : 'Switching the model…'),
  run: (name, args, snap, ui, call) => modelsTool(args, snap, call && call.mode),
  summary: (name, args) => (args && args.action === 'settings' ? `settings ${args.model || 'this provider'}`
    : isModelsReading(args) ? listSummary(args) : String((args && args.model) || '')),
});
