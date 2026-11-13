'use strict';
// A chat history that storage cannot read: the panel shows an empty chat with an error, a turn is refused while the
// read fails, and nothing the panel holds is written over the stored history until a read succeeded (then the turn
// starts from the stored history; a save meanwhile goes after it).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab } = require('./lib/sandbox');
const { sseResponse, textRound } = require('./lib/streams');

const DOC = 'DOC123';
const histKey = (id) => `muninChatHistory:${DOC}:${id}`;
let env, T, state, storage;
let failReads = false;
const pairs = (msgs) => msgs.map((m) => [m.role, m.content]);
const errors = () => T.el.chat.children.filter((c) => c.className && c.className.includes('error')).map((c) => c.innerHTML || c.textContent);
const send = (text) => { T.el.input.value = text; return T.sendMessage(); };
const OLD = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  env.bodies = [];
  env.ctx.fetch = async (url, init) => { env.bodies.push(JSON.parse(init.body)); return sseResponse(textRound('New answer')); };
  const get = env.chrome.storage.local.get;
  env.chrome.storage.local.get = async (keys) => {
    if (failReads && [].concat(keys).some((k) => String(k).startsWith('muninChatHistory:'))) throw new Error('IO error');
    return get(keys);
  };
});

test('a failed read: empty chat with an error; a send is refused while it fails, then starts from the stored history', async () => {
  const other = state.chatId;
  await T.createChat(); // an empty open chat is reused: give the first one a message
  state.messages.push({ role: 'user', content: 'x' }); await T.saveHistory();
  await T.createChat();
  const id = state.chatId;
  assert.notStrictEqual(id, other);
  storage[histKey(id)] = OLD.map((m) => ({ ...m }));
  await T.switchChat(other);
  failReads = true;
  await T.switchChat(id); // the read fails
  assert.strictEqual(state.chatId, id);
  deq(state.messages, []);
  assert.ok(errors().some((e) => /Could not read the chat history/.test(e)));
  // a send while reads still fail: refused, the stored history untouched, no request
  T.el.chat.children.length = 0;
  await send('New question');
  assert.strictEqual(env.bodies.length, 0);
  deq(pairs(storage[histKey(id)]), pairs(OLD));
  assert.ok(errors().some((e) => /Could not read the chat history/.test(e)));
  // reads work again: the turn starts from the stored history and keeps it
  failReads = false;
  await send('New question');
  assert.strictEqual(env.bodies.length, 1);
  deq(pairs(storage[histKey(id)]), [...pairs(OLD), ['user', 'New question'], ['assistant', 'New answer']]);
  deq(pairs(state.messages), pairs(storage[histKey(id)]));
});

test('saveHistory on a chat not read: refused while reads fail, then the panel\'s messages go after the stored ones', async () => {
  await T.createChat();
  const id = state.chatId;
  storage[histKey(id)] = OLD.map((m) => ({ ...m }));
  await T.createChat(); // leaves the chat (empty: reused); switch away through the first chat instead
  await T.switchChat(state.chats.find((c) => c.id !== id).id);
  failReads = true;
  await T.switchChat(id);
  deq(state.messages, []);
  state.messages.push({ role: 'user', content: 'Typed meanwhile' });
  await T.saveHistory();
  deq(pairs(storage[histKey(id)]), pairs(OLD)); // nothing written over it
  failReads = false;
  await T.saveHistory();
  deq(pairs(storage[histKey(id)]), [...pairs(OLD), ['user', 'Typed meanwhile']]);
  deq(pairs(state.messages), pairs(storage[histKey(id)]));
});
