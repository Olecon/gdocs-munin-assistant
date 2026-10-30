'use strict';
// The chat store across tabs: Web Lock and its fallback, merging lists by chat id, tombstones, onChanged
// (switcher refresh, reload of the open chat, never while busy), history normalization (orphan tool calls,
// 2.6 chats), removal of stale settings keys and the daily storage cleanup.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, makeSnapFor } = require('./lib/sandbox');
const { sharedStorage, webLocks, tick } = require('./lib/shared-storage');

const DOC = 'DOC123';
const listKey = 'muninChats:' + DOC;
const histKey = (id) => `muninChatHistory:${DOC}:${id}`;
const DAY = 24 * 3600 * 1000;

// A panel ("tab") on the shared storage, showing document DOC123.
async function panel(store, locks) {
  const env = await load();
  env.handle = store.attach(env);
  if (locks) env.ctx.navigator.locks = locks;
  installDocTab(env);
  await env.T.refreshContext({ force: true });
  return env;
}
const notices = (env) => env.T.el.chat.children.map((c) => c.innerHTML);
const storedIds = (store) => store.items[listKey].map((c) => c.id).sort();
const user = (content) => ({ role: 'user', content });
// Polls cond until it holds, failing after ms: a fixed short tick was flaky on a loaded machine (the change
// event and the reload are a chain of timers). The default stays below the 250 ms poll an immediate reload
// must not wait for.
async function soon(cond, what, ms = 200) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms: ${what}`);
    await tick(2);
  }
}

test('Web Lock path: list writes take munin:<docId>; two tabs creating chats at once keep both', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  assert.ok(locks.log.includes('munin:' + DOC));
  assert.strictEqual(B.state.chatId, A.state.chatId); // B found the chat A created (no second "first chat")
  assert.strictEqual(store.items[listKey].length, 1);
  const first = A.state.chatId;
  A.state.messages.push(user('from A'));
  B.state.messages.push(user('from B'));
  const before = locks.log.length;
  await Promise.all([A.T.createChat(), B.T.createChat()]);
  assert.ok(locks.log.length - before >= 4); // each tab: the save of its old chat and the creation
  assert.strictEqual(store.items[listKey].length, 3);
  deq(storedIds(store), [first, A.state.chatId, B.state.chatId].sort());
  await tick(5);
  deq(A.state.chats.map((c) => c.id).sort(), storedIds(store)); // the switcher followed the other tab
  deq(B.state.chats.map((c) => c.id).sort(), storedIds(store));
});

test('without navigator.locks: the operations run unlocked (queued inside the panel) and still merge', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  assert.strictEqual(A.ctx.navigator.locks, undefined);
  A.state.messages.push(user('hello'));
  const stale = A.state.chats.map((c) => ({ ...c }));
  // a save and a list write of another module (open_document's docs on the meta) at the same time
  stale[0].docs = [{ alias: 'doc2', id: 'OTHER', title: 'Other', lines: 3 }];
  await Promise.all([A.T.saveHistory(), A.T.storageSet({ [listKey]: stale })]);
  const meta = store.items[listKey][0];
  assert.strictEqual(meta.title, 'hello');
  deq(store.items[histKey(meta.id)], [user('hello')]);
  deq(meta.docs, [{ alias: 'doc2', id: 'OTHER', title: 'Other', lines: 3 }]);
});

test('two writers: a chat created in tab B survives a save from tab A; chat X saved in A leaves chat Y of B alone', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  const B = await panel(store);
  const x = A.state.chatId;
  A.handle.detached = true; // A does not hear B's changes: its list stays stale
  B.state.messages.push(user('B on X'));
  await B.T.saveHistory();
  await B.T.createChat();
  const y = B.state.chatId;
  B.state.messages.push(user('Y message'));
  await B.T.saveHistory();
  const yMeta = store.items[listKey].find((c) => c.id === y);
  // A knows an older copy of Y (as if it had seen it before B's save) and saves X
  A.state.chats.push({ id: y, title: '', createdAt: yMeta.createdAt, updatedAt: yMeta.createdAt });
  A.state.messages = [user('A on X')];
  await A.T.saveHistory();
  deq(storedIds(store), [x, y].sort());
  deq(store.items[histKey(x)], [user('A on X')]); // the same chat in two tabs: the last save wins
  deq(store.items[histKey(y)], [user('Y message')]); // never written by A
  deq(store.items[listKey].find((c) => c.id === y), yMeta); // B's newer meta kept
  deq(A.state.chats.map((c) => c.id).sort(), [x, y].sort()); // A's list now includes Y
});

test('a chat deleted in another tab is never brought back (tombstone)', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  const B = await panel(store);
  const x = A.state.chatId;
  B.state.messages.push(user('first'));
  await B.T.createChat();
  const z = B.state.chatId;
  B.state.messages.push(user('in Z'));
  await B.T.saveHistory();
  await soon(() => A.state.chats.some((c) => c.id === z), 'A\'s list to show Z', 2000);
  A.handle.detached = true;
  store.items['muninDraft:' + DOC + ':' + z] = { sections: [{ heading: 'Intro', intent: 'x' }] }; // the chat's draft plan
  await B.T.deleteChat(z);
  assert.ok(Number.isFinite(store.items['muninChatTombstones:' + DOC][z]));
  assert.ok(!(histKey(z) in store.items));
  assert.ok(!(('muninDraft:' + DOC + ':' + z) in store.items), 'the draft plan is deleted with the chat');
  const staleList = A.state.chats.map((c) => ({ ...c, updatedAt: c.updatedAt + 1000 }));
  await A.T.saveHistory(); // A's list still has Z
  await A.T.storageSet({ [listKey]: staleList }); // and so does a list write of another module
  await A.T.saveHistory({ docId: DOC, chatId: z, messages: [user('late answer')] }); // a turn still running in Z
  deq(storedIds(store), [x]);
  assert.ok(!(histKey(z) in store.items));
  deq(A.state.chats.map((c) => c.id), [x]);
});

test('onChanged: the switcher follows, the open chat is reloaded at once without a notice, own writes are ignored', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  const B = await panel(store);
  const x = A.state.chatId;
  B.state.messages.push(user('B starts'));
  await B.T.createChat();
  const w = B.state.chatId;
  await soon(() => A.state.chats.some((c) => c.id === w), 'the switcher to follow');
  assert.strictEqual(A.state.chatId, x); // A stays in its chat
  await B.T.switchChat(x);
  B.state.messages.push({ role: 'assistant', content: 'Answer from B' });
  await B.T.saveHistory();
  await soon(() => A.state.messages.length === 2, 'A reloads B\'s change'); // at once, not after the 250 ms poll
  deq(A.state.messages, [user('B starts'), { role: 'assistant', content: 'Answer from B' }]);
  assert.ok(!notices(A).some((n) => /another tab/.test(n))); // a status line text instead of a notice
  assert.strictEqual(A.T.el.docStatus.textContent, 'Chat updated from another tab');
  assert.notStrictEqual(B.T.el.docStatus.textContent, 'Chat updated from another tab'); // B's own writes
  // A's own saves never look like another tab's
  A.T.el.chat.children.length = 0;
  A.state.messages.push(user('A continues'));
  await A.T.saveHistory();
  await A.T.saveHistory();
  A.T.setStatus('Ready');
  await soon(() => B.state.messages.length === 3, 'B reloads A\'s change');
  await tick(20); // A's own change events have been handled by now (they were delivered before B's)
  assert.strictEqual(A.T.el.docStatus.textContent, 'Ready');
  deq(B.state.messages, A.state.messages); // B reloaded A's change in turn
  assert.strictEqual(B.T.el.docStatus.textContent, 'Chat updated from another tab');
  assert.ok(!notices(B).some((n) => /another tab/.test(n)));
});

test('no reload while a turn runs (no notice either), the reload once the panel is idle', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  const B = await panel(store);
  A.state.messages.push(user('mine'));
  await A.T.saveHistory();
  await tick(5);
  A.state.busy = true;
  const mine = A.state.messages;
  B.state.messages = [user('mine'), { role: 'assistant', content: 'B answered' }];
  await B.T.saveHistory();
  await tick(600);
  assert.strictEqual(A.state.messages, mine); // untouched while busy
  deq(mine, [user('mine')]);
  assert.ok(!notices(A).some((n) => /another tab/.test(n)));
  A.state.busy = false;
  await soon(() => A.state.messages.length === 2, 'the reload once idle (the 250 ms poll)', 2000);
  deq(A.state.messages, [user('mine'), { role: 'assistant', content: 'B answered' }]);
  // the open chat deleted in another tab: switch (when idle) to the remaining one
  B.state.messages.push(user('more'));
  await B.T.createChat();
  await soon(() => A.state.chats.some((c) => c.id === B.state.chatId), 'A\'s list to show B\'s new chat', 2000);
  const gone = A.state.chatId;
  await B.T.deleteChat(gone);
  await soon(() => A.state.chatId !== gone, 'A to leave the deleted chat', 2000);
  assert.notStrictEqual(A.state.chatId, gone);
  assert.strictEqual(A.state.chatId, B.state.chatId);
  assert.ok(notices(A).some((n) => /This chat was deleted in another tab/.test(n)));
});

test('normalization: tool calls without results and results without calls are dropped', async () => {
  const env = await load();
  const call = (id, name = 'read_lines') => ({ id, type: 'function', function: { name, arguments: '{}' } });
  const res = (id) => ({ role: 'tool', tool_call_id: id, content: 'ok' });
  const raw = [
    user('q'),
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')], _anthropicBlocks: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] },
    res('a'), // b has no result
    res('zz'), // no call
    { role: 'assistant', content: 'x', tool_calls: [call('c')] }, // cut off: no result at all
    user('next'),
    res('c'), // too late: after a user message
    { role: 'assistant', content: null, tool_calls: [call('d'), call('d'), { id: 'e' }] }, // duplicate and malformed calls
    res('d'),
    { role: 'system', content: 'ignored' },
    'junk',
    { role: 'assistant', content: 'done' },
  ];
  const out = env.T.normalizeHistory(raw);
  deq(out, [
    user('q'),
    { role: 'assistant', content: null, tool_calls: [call('a')] }, // the replay blocks went with the orphan
    res('a'),
    { role: 'assistant', content: 'x' },
    user('next'),
    { role: 'assistant', content: null, tool_calls: [call('d')] },
    res('d'),
    { role: 'assistant', content: 'done' },
  ]);
  deq(env.T.normalizeHistory(undefined), []);
  // loading a chat normalizes it
  const store = sharedStorage();
  const A = await panel(store);
  store.items[histKey(A.state.chatId)] = raw;
  await A.T.refreshContext({ force: true });
  deq(A.state.messages, out);
});

test('a 2.6 chat (add_comment, _decision, _preview, undo_last_edit) renders and converts to valid request bodies', async () => {
  const env = await load();
  const { T, state } = env;
  installDocTab(env);
  await T.refreshContext({ force: true });
  const v26 = [
    user('Review the intro'),
    { role: 'assistant', content: 'I will comment.', _reasoning: 'thinking', tool_calls: [{ id: 'call_c1', type: 'function', function: { name: 'add_comment', arguments: '{"anchor_text":"Intro","comment":"Shorten"}' } }] },
    { role: 'tool', tool_call_id: 'call_c1', content: 'Comment added.', _ok: true, _message: 'Comment added on "Intro"' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_e1', type: 'function', function: { name: 'replace_text', arguments: '{"old_text":"a","new_text":"b"}' } }] },
    { role: 'tool', tool_call_id: 'call_e1', content: 'The user rejected this edit.', _ok: false, _message: 'Replace line 3', _decision: 'rejected',
      _preview: { kind: 'diff', tool: 'replace_text', title: 'Replace line 3', rows: [{ t: '-', s: 'a' }, { t: '+', s: 'b' }] } },
    { role: 'assistant', content: 'Done.', _usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    user('Undo it'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_u1', type: 'function', function: { name: 'undo_last_edit', arguments: '{}' } }, { id: 'call_orphan', type: 'function', function: { name: 'add_comment', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_u1', content: 'Undone.', _ok: true, _message: 'Undid the last edit', _decision: 'accepted' },
    { role: 'tool', tool_call_id: 'call_ghost', content: 'stray result' },
    { role: 'assistant', content: 'Undone.' },
  ];
  state.messages = T.normalizeHistory(v26);
  assert.strictEqual(state.messages.length, 10);
  T.renderHistory();
  assert.ok(T.el.chat.children.length > 0);
  Object.assign(state, { docText: 'Intro\nBody a', docFormat: 'text', docModel: null, selection: '', applyMode: 'auto' });
  const snapFor = makeSnapFor(env);
  // Anthropic: every tool_use is answered by a tool_result in the next (user) message, and only then
  const a = T.buildRequest('edit', snapFor('anthropic')).body.messages;
  a.forEach((m, i) => {
    if (i) assert.notStrictEqual(m.role, a[i - 1].role);
    const uses = m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    const results = (a[i + 1] && a[i + 1].role === 'user' ? a[i + 1].content : []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    if (m.role === 'assistant') deq(results, uses);
  });
  assert.strictEqual(a[0].role, 'user');
  assert.ok(!JSON.stringify(a).includes('call_orphan') && !JSON.stringify(a).includes('call_ghost') && !JSON.stringify(a).includes('_preview'));
  // OpenAI Responses: function_call and function_call_output pair up
  const o = T.buildRequest('edit', snapFor('openai')).body.input;
  const calls = o.filter((it) => it.type === 'function_call').map((it) => it.call_id);
  const outs = o.filter((it) => it.type === 'function_call_output').map((it) => it.call_id);
  deq(calls, ['call_c1', 'call_e1', 'call_u1']);
  deq(outs, calls);
  // Munin (Chat Completions): each tool message follows the assistant that called it
  const mm = T.buildRequest('edit', snapFor('munin')).body.messages;
  let pending = new Set();
  for (const m of mm) {
    if (m.role === 'tool') { assert.ok(pending.delete(m.tool_call_id), m.tool_call_id); continue; }
    assert.strictEqual(pending.size, 0);
    pending = new Set((m.tool_calls || []).map((tc) => tc.id));
  }
});

test('stale keys of removed settings are removed at startup', async () => {
  const env = await load();
  Object.assign(env.storage, { muninConfirmEdits: true, muninMotion: 'off', muninDocMode: 'full', openaiBaseUrl: 'https://proxy.example.com/v1', muninBaseUrl: 'https://api.muninai.org/v1', anthropicBaseUrl: '', openaiEffort: 'high', anthropicEffort: 'low', anthropicModel: 'claude-sonnet-5-5' });
  await env.T.loadSettings();
  for (const k of ['muninConfirmEdits', 'muninMotion', 'muninDocMode', 'openaiBaseUrl', 'muninBaseUrl', 'anthropicBaseUrl', 'openaiEffort', 'anthropicEffort']) assert.ok(!(k in env.storage), k);
  assert.strictEqual(env.storage.anthropicModel, 'claude-sonnet-5-5');
  assert.strictEqual(env.state.settings.providers.anthropic.model, 'claude-sonnet-5-5');
  assert.strictEqual(env.state.settings.providers.openai.baseUrl, undefined);
});

test('storage cleanup: orphans and documents unused for 180 days, at most once per day', async () => {
  const store = sharedStorage();
  const now = Date.now();
  const old = now - 181 * DAY;
  Object.assign(store.items, {
    // an old document: removed with all its chat keys (its instructions stay)
    'muninChats:OLD': [{ id: 'o1', title: 't', createdAt: old, updatedAt: old }, { id: 'o2', title: '', createdAt: old, updatedAt: old - DAY }],
    'muninChatHistory:OLD:o1': [user('old')], 'muninChatHistory:OLD:o2': [], 'muninCurrentChat:OLD': 'o1',
    'muninChatTombstones:OLD': { o3: old }, 'muninDocInstructions:OLD': 'Keep me',
    // a recent document with an orphan history
    'muninChats:NEW': [{ id: 'n1', title: '', createdAt: now, updatedAt: now - 10 * DAY }],
    'muninChatHistory:NEW:n1': [user('new')], 'muninChatHistory:NEW:gone': [user('orphan')],
    // keys of a document without a chat list
    'muninChatHistory:GHOST:g1': [], 'muninCurrentChat:GHOST': 'g1', 'muninChatTombstones:GHOST': {},
    // the document this panel shows is never expired, however old
    [listKey]: [{ id: 'mine', title: '', createdAt: old, updatedAt: old }], [histKey('mine')]: [user('mine')],
    muninApiKey: 'k', muninTheme: 'dark',
  });
  const A = await panel(store); // loadChatStore starts the daily cleanup
  await tick(20);
  assert.ok(Number.isFinite(store.items.muninStorageCleanupAt));
  deq(Object.keys(store.items).sort(), [
    histKey('mine'), listKey, 'muninApiKey', 'muninChatHistory:NEW:n1', 'muninChats:NEW', 'muninDocInstructions:OLD', 'muninStorageCleanupAt', 'muninTheme',
  ].sort());
  assert.strictEqual(A.state.chatId, 'mine');
  // once per day: a second run the same day does nothing
  store.items['muninChatHistory:NEW:again'] = [];
  store.items['muninDraft:NEW:again'] = { sections: [] }; // a draft plan of a chat that no longer exists
  assert.strictEqual(await A.T.runStorageCleanup(), null);
  assert.ok('muninChatHistory:NEW:again' in store.items);
  const r = await A.T.runStorageCleanup(Date.now() + DAY + 1000);
  deq([...r.removed].sort(), ['muninChatHistory:NEW:again', 'muninDraft:NEW:again']);
  assert.ok(!('muninChatHistory:NEW:again' in store.items));
  assert.ok(!('muninDraft:NEW:again' in store.items));
  assert.strictEqual(await A.T.runStorageCleanup(Date.now() + DAY + 2000), null);
});
