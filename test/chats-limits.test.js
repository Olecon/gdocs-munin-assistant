'use strict';
// Chats per document through the public surface only (createChat, saveHistory, loadChatStore,
// refreshContext, the chat switcher menu): the 31st chat evicts the least recently used one, deleting
// the open chat switches to another, documents do not share chats. Storage keys are not inspected.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('./lib/dom-sandbox');
const { deq, waitFor } = require('./lib/sandbox');

let env, T, state, el, chrome;
const tabs = {
  A: { id: 7, url: 'https://docs.google.com/document/d/DOCAAA/edit', title: 'Doc A - Google Docs' },
  B: { id: 7, url: 'https://docs.google.com/document/d/DOCBBB/edit', title: 'Doc B - Google Docs' },
};
let current = tabs.A;
const menuRows = () => [...el.chatMenu.querySelectorAll('.chat-row')];
// Adds a user message to the open chat and saves it (this also marks the chat as used now).
const say = async (text) => { state.messages.push({ role: 'user', content: text }); await T.saveHistory(); };
// Opens the switcher and clicks the row of chatId (or its delete button).
async function pick(chatId, del) {
  if (el.chatMenu.classList.contains('hidden')) click(el.chatSwitchBtn);
  const row = menuRows().find((r) => r.dataset.id === chatId);
  assert.ok(row, 'row of ' + chatId);
  click(del ? row.querySelector('button[data-del]') : row.querySelector('.chat-row-title'));
  await tick(10);
}

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  // a clock that moves 1 s per call: "least recently used" is well defined
  env.run('(() => { let t = Date.UTC(2026, 0, 1); Date.now = () => (t += 1000); })()');
  chrome.tabs.query = async () => [current];
  chrome.tabs.get = async () => current;
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: current.title.replace(/ - Google Docs$/, '') });
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOCAAA');
});
after(() => env.close());

test('the 31st chat evicts the least recently used one', async () => {
  const first = state.chatId;
  await say('chat 1');
  const ids = [first];
  for (let i = 2; i <= 30; i++) {
    await T.createChat();
    await say('chat ' + i);
    ids.push(state.chatId);
  }
  assert.strictEqual(new Set(ids).size, 30);
  assert.strictEqual(state.chats.length, 30);
  // the first chat is used again: the second one is now the least recently used
  await pick(first);
  assert.strictEqual(state.chatId, first);
  await say('chat 1 again');
  await T.createChat();
  const newest = state.chatId;
  assert.strictEqual(state.chats.length, 30);
  assert.ok(!state.chats.some((c) => c.id === ids[1]), 'chat 2 was evicted');
  assert.ok(state.chats.some((c) => c.id === first), 'chat 1 was kept');
  // the stored store agrees (a reload sees the same 30 chats, the new one active)
  const store = await T.loadChatStore('DOCAAA');
  assert.strictEqual(store.chats.length, 30);
  assert.ok(!store.chats.some((c) => c.id === ids[1]));
  assert.strictEqual(store.chatId, newest);
  assert.strictEqual(store.messages.length, 0);
  // the "+" of an empty chat reuses it instead of adding another
  await T.createChat();
  assert.strictEqual(state.chatId, newest);
  assert.strictEqual(state.chats.length, 30);
  // the evicted chat's history is gone with it: chat 1 still has its messages
  await pick(first);
  deq(state.messages.map((m) => m.content), ['chat 1', 'chat 1 again']);
});

test('deleting the open chat switches to the most recent other chat; the last one is replaced by a new chat', async () => {
  await say('to be deleted');
  const doomed = state.chatId;
  const before = state.chats.length;
  // the most recently used other chat
  const next = state.chats.filter((c) => c.id !== doomed).sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  await pick(doomed, true);
  await waitFor(() => state.chatId !== doomed, 'the switch');
  assert.strictEqual(state.chatId, next);
  assert.strictEqual(state.chats.length, before - 1);
  assert.ok(!(await T.loadChatStore('DOCAAA')).chats.some((c) => c.id === doomed));
  click(el.chatSwitchBtn); // close the menu
  // deleting a chat that is not open keeps the open one
  const open = state.chatId;
  const other = state.chats.find((c) => c.id !== open).id;
  await pick(other, true);
  assert.strictEqual(state.chatId, open);
  assert.ok(!state.chats.some((c) => c.id === other));
  // delete everything: a fresh empty chat remains
  while (state.chats.length > 1 || state.messages.length) {
    const id = state.chatId;
    await pick(id, true);
    await waitFor(() => state.chatId !== id, 'the deletion');
  }
  assert.strictEqual(state.chats.length, 1);
  assert.strictEqual(state.messages.length, 0);
  assert.strictEqual(el.chatSwitchTitle.textContent, 'New chat');
  if (!el.chatMenu.classList.contains('hidden')) click(el.chatSwitchBtn);
});

test('documents keep separate chats; switching back restores the open chat', async () => {
  await say('question about A');
  const chatA = state.chatId;
  const chatsA = state.chats.map((c) => c.id);
  current = tabs.B;
  await T.refreshContext();
  assert.strictEqual(state.docId, 'DOCBBB');
  assert.strictEqual(state.messages.length, 0);
  assert.ok(!state.chats.some((c) => chatsA.includes(c.id)));
  assert.strictEqual(el.docTitle.textContent, 'Doc B');
  await say('question about B');
  await T.createChat();
  await say('second B chat');
  assert.strictEqual(state.chats.length, 2);
  current = tabs.A;
  await T.refreshContext();
  assert.strictEqual(state.docId, 'DOCAAA');
  assert.strictEqual(state.chatId, chatA);
  deq(state.messages.map((m) => m.content), ['question about A']);
  deq(state.chats.map((c) => c.id).sort(), chatsA.sort());
  // the menu lists only this document's chats
  click(el.chatSwitchBtn);
  deq(menuRows().map((r) => r.dataset.id).sort(), chatsA.sort());
  click(el.chatSwitchBtn);
  const storeB = await T.loadChatStore('DOCBBB');
  assert.strictEqual(storeB.chats.length, 2);
  deq(storeB.messages.map((m) => m.content), ['second B chat']);
});
