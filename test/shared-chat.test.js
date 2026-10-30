'use strict';
// One chat open in two tabs: a turn (and an undo) owns the chat through the Web Lock
// "munin:chat:<docId>:<chatId>", starts from the stored history, and idle tabs follow the chat at once.
// Two panels ("tabs") run on one shared chrome.storage.local with a Web Locks stand-in that really
// serializes (test/lib/shared-storage.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, waitFor } = require('./lib/sandbox');
const { sharedStorage, webLocks, tick } = require('./lib/shared-storage');
const { sseResponse, ev, textRound } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');

const DOC = 'DOC123';
const histKey = (id) => `muninChatHistory:${DOC}:${id}`;
const WAIT = 'Another tab is answering in this chat…';
const FOLLOW = 'Chat updated from another tab';

// A panel on the shared storage, showing DOC123, with Anthropic set up and the export path for the text.
async function panel(store, locks) {
  const env = await load();
  env.handle = store.attach(env);
  if (locks) env.ctx.navigator.locks = locks;
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await env.T.refreshContext({ force: true });
  env.state.googleConnected = false;
  env.state.settings.provider = 'anthropic';
  Object.assign(env.state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  env.bodies = [];
  return env;
}

// Every request of the panel answers with the next text of replies (the last one repeats).
function answers(env, ...replies) {
  env.ctx.fetch = async (url, init) => {
    env.bodies.push(JSON.parse(init.body));
    return sseResponse(textRound(replies[Math.min(env.bodies.length - 1, replies.length - 1)]));
  };
}
// The next request of the panel streams from a live stream the test ends (s.finish(text)).
function held(env) {
  const s = liveStream();
  s.finish = (text) => {
    s.push(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' }));
    s.end();
  };
  env.ctx.fetch = async (url, init) => { env.bodies.push(JSON.parse(init.body)); return s.response; };
  return s;
}
const send = (env, text) => { env.T.el.input.value = text; return env.T.sendMessage(); };
const pairs = (msgs) => msgs.map((m) => [m.role, m.content]);
const notices = (env) => env.T.el.chat.children.filter((c) => c.className && c.className.includes('notice')).map((c) => c.innerHTML);
// The text of the messages of a request body (Anthropic): what the model saw of the chat.
const sentTexts = (body) => body.messages.map((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' '));

test('a turn in tab A appears in tab B as it is saved, without a notice; the lock is taken per chat', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  assert.strictEqual(B.state.chatId, x);
  const s = held(A);
  const turn = send(A, 'Hello from A');
  await waitFor(() => A.bodies.length === 1, 'the request of A');
  assert.ok(locks.log.includes(`munin:chat:${DOC}:${x}`));
  assert.ok(locks.held(`munin:chat:${DOC}:${x}`));
  await waitFor(() => B.state.messages.length === 1, 'B to show the user message');
  deq(pairs(B.state.messages), [['user', 'Hello from A']]);
  s.finish('Hi, A.');
  await turn;
  await waitFor(() => B.state.messages.length === 2, 'B to show the answer');
  deq(pairs(B.state.messages), [['user', 'Hello from A'], ['assistant', 'Hi, A.']]);
  deq(B.state.messages, A.state.messages);
  assert.ok(!notices(B).some((n) => /another tab/.test(n))); // followed silently
  assert.strictEqual(B.T.el.docStatus.textContent, FOLLOW);
  assert.ok(!locks.held(`munin:chat:${DOC}:${x}`));
  assert.ok(!notices(A).some((n) => /another tab/.test(n)));
});

test('A and B send at once: B waits for A, then starts from the history with A\'s turn; both turns kept in order', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  const s = held(A);
  answers(B, 'Answer to B.');
  const turnA = send(A, 'Question A');
  const turnB = send(B, 'Question B');
  await waitFor(() => A.bodies.length === 1, 'the request of A');
  await tick(20);
  // B follows A's saved question through a chain of timers, which can take longer than 20 ms on a busy machine
  await waitFor(() => B.state.messages.length === 1, 'B to follow A\'s question');
  assert.strictEqual(B.T.el.docStatus.textContent, WAIT);
  assert.strictEqual(B.bodies.length, 0); // nothing sent while A answers
  assert.strictEqual(B.T.el.input.value, 'Question B'); // not taken from the input yet
  assert.strictEqual(B.state.busy, true); // Stop is shown
  deq(pairs(B.state.messages), [['user', 'Question A']]); // B follows A while it waits
  s.finish('Answer to A.');
  await Promise.all([turnA, turnB]);
  assert.strictEqual(B.bodies.length, 1);
  deq(sentTexts(B.bodies[0]).map((t) => t.split('\n\n').pop()), ['Question A', 'Answer to A.', 'Question B']);
  const final = [['user', 'Question A'], ['assistant', 'Answer to A.'], ['user', 'Question B'], ['assistant', 'Answer to B.']];
  deq(pairs(store.items[histKey(x)]), final);
  deq(pairs(B.state.messages), final);
  await waitFor(() => A.state.messages.length === 4, 'A to follow B\'s turn');
  deq(A.state.messages, B.state.messages);
  assert.strictEqual(B.T.el.input.value, '');
});

test('Stop while waiting for the lock: no request, the message stays in the input box', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  const s = held(A);
  answers(B, 'Later answer.');
  const turnA = send(A, 'Long question');
  await waitFor(() => A.bodies.length === 1, 'the request of A');
  const turnB = send(B, 'My draft');
  await waitFor(() => B.T.el.docStatus.textContent === WAIT, 'B to wait');
  B.state.abort.abort(); // the Stop button
  await turnB;
  assert.strictEqual(B.bodies.length, 0);
  assert.strictEqual(B.T.el.input.value, 'My draft');
  assert.strictEqual(B.state.busy, false);
  assert.strictEqual(B.state.chatWait, false);
  assert.ok(notices(B).includes('Stopped. Your message is still in the input box.'));
  assert.notStrictEqual(B.T.el.docStatus.textContent, WAIT);
  s.finish('Done.');
  await turnA;
  await tick(); // the lock is released after the turn's promise settles
  assert.ok(!locks.held(`munin:chat:${DOC}:${x}`)); // B left the queue: nothing holds the lock
  await waitFor(() => B.state.messages.length === 2, 'B to follow');
  await send(B, 'My draft'); // and B can send it now
  deq(pairs(store.items[histKey(x)]), [['user', 'Long question'], ['assistant', 'Done.'], ['user', 'My draft'], ['assistant', 'Later answer.']]);
});

test('Undo in B while A answers in the chat is refused and leaves the journal alone; afterwards it works', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  // a journaled edit of an earlier turn, stored and shown in both tabs
  const edit = { id: 'toolu_e1', kind: 'replace', title: 'Replace line 3', index: 10, text: 'b', restore: 'a' };
  A.state.messages.push(
    { role: 'user', content: 'Edit it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_e1', type: 'function', function: { name: 'replace_text', arguments: '{"old_text":"a","new_text":"b"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_e1', content: 'Done.', _ok: true, _edit: edit },
    { role: 'assistant', content: 'Edited.' },
  );
  await A.T.saveHistory();
  await waitFor(() => B.state.messages.length === 4, 'B to follow');
  let undoCalls = 0;
  B.run('useDocModel = () => {};');
  B.ctx.fakeUndo = async () => { undoCalls++; return { model: null, lostObjects: false }; };
  B.run('undoEdit = (e) => fakeUndo(e);');
  const s = held(A);
  const turnA = send(A, 'One more thing');
  await waitFor(() => A.bodies.length === 1, 'the request of A');
  assert.strictEqual(await B.T.undoFromButton('toolu_e1', null), false);
  assert.strictEqual(await B.T.undoAllFromButton('toolu_e1', null), false);
  assert.strictEqual(undoCalls, 0);
  assert.ok(notices(B).includes('Another tab is answering in this chat. Click Undo again when that answer is finished.'));
  assert.ok(notices(B).includes('Another tab is answering in this chat. Click Undo all again when that answer is finished.'));
  assert.strictEqual(B.state.undoing, false);
  s.finish('Sure.');
  await turnA;
  await tick(); // the lock is released after the turn's promise settles
  const stored = store.items[histKey(x)];
  assert.strictEqual(stored.length, 6);
  assert.ok(!stored[2]._edit.undone);
  // now B owns the chat for the undo; it works on the stored history (A's turn included)
  assert.strictEqual(await B.T.undoFromButton('toolu_e1', null), true);
  assert.strictEqual(undoCalls, 1);
  const after = store.items[histKey(x)];
  deq(pairs(after).slice(4), [['user', 'One more thing'], ['assistant', 'Sure.']]);
  assert.strictEqual(after[2]._edit.undone, true);
  assert.ok(after[2].content.endsWith('[Later the user undid this edit with the Undo button.]'));
  await waitFor(() => A.state.messages[2]._edit.undone === true, 'A to follow the undo');
  deq(A.state.messages, after);
  // deleting a chat another tab answers in is refused too
  const s2 = held(A);
  const turn2 = send(A, 'Again');
  await waitFor(() => A.bodies.length === 2, 'the second request of A');
  await B.T.deleteChat(x);
  assert.ok(notices(B).includes('Another tab is answering in this chat. Delete it when that answer is finished.'));
  assert.ok(B.state.chats.some((c) => c.id === x) && histKey(x) in store.items);
  s2.finish('OK.');
  await turn2;
  assert.strictEqual(store.items[histKey(x)].length, 8);
});

test('without navigator.locks: the panel\'s own queue serializes and can be left; turns of two tabs in sequence keep both', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  const B = await panel(store);
  assert.strictEqual(A.ctx.navigator.locks, undefined);
  const x = A.state.chatId;
  // within one panel: the second holder waits for the first; an aborted wait leaves the queue
  const r1 = await A.T.holdChatLock(DOC, x);
  assert.strictEqual(await A.T.tryChatLock(DOC, x), null);
  let second = false;
  const p2 = A.T.holdChatLock(DOC, x).then((rel) => { second = true; return rel; });
  const ac = new A.ctx.AbortController();
  const p3 = A.T.holdChatLock(DOC, x, { signal: ac.signal });
  await tick(5);
  assert.strictEqual(second, false);
  ac.abort();
  await assert.rejects(p3, (e) => e.name === 'AbortError');
  r1();
  const r2 = await p2;
  assert.strictEqual(second, true);
  r2();
  const r3 = await A.T.tryChatLock(DOC, x);
  assert.ok(r3);
  r3();
  // two tabs in sequence; B does not hear A (a stale copy): its turn still starts from the stored history
  B.handle.detached = true;
  answers(A, 'First answer.');
  await send(A, 'First');
  deq(pairs(B.state.messages), []);
  answers(B, 'Second answer.');
  await send(B, 'Second');
  const final = [['user', 'First'], ['assistant', 'First answer.'], ['user', 'Second'], ['assistant', 'Second answer.']];
  deq(pairs(store.items[histKey(x)]), final);
  deq(pairs(B.state.messages), final);
  deq(sentTexts(B.bodies[0]).map((t) => t.split('\n\n').pop()), ['First', 'First answer.', 'Second']);
  await waitFor(() => A.state.messages.length === 4, 'A to follow');
});

test('the open chat deleted in B while A is idle: A switches away; switching or + does not overwrite a newer copy', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  answers(A, 'Reply.');
  await send(A, 'In X');
  await waitFor(() => B.state.messages.length === 2, 'B to follow');
  await B.T.createChat();
  const y = B.state.chatId;
  answers(B, 'Reply in Y.');
  await send(B, 'In Y');
  await waitFor(() => A.state.chats.some((c) => c.id === y), 'A to list Y');
  assert.strictEqual(A.state.chatId, x); // A stays in its chat
  // + in a tab whose copy is stale does not write its copy over the stored one
  B.handle.detached = true;
  await B.T.switchChat(x);
  answers(A, 'Reply 2.');
  await send(A, 'More in X');
  assert.strictEqual(B.state.messages.length, 2); // stale
  await B.T.createChat();
  deq(pairs(store.items[histKey(x)]).map((p) => p[1]), ['In X', 'Reply.', 'More in X', 'Reply 2.']);
  B.handle.detached = false;
  await B.T.switchChat(x);
  assert.strictEqual(B.state.messages.length, 4);
  // B deletes X while A is idle in it
  await B.T.deleteChat(x);
  await waitFor(() => A.state.chatId !== x, 'A to switch away');
  assert.ok(!A.state.chats.some((c) => c.id === x));
  assert.ok(A.state.chats.some((c) => c.id === A.state.chatId));
  assert.ok(notices(A).includes('This chat was deleted in another tab.'));
  assert.ok(!(histKey(x) in store.items));
});

test('compaction in A, then a turn in B: B starts from the compacted history', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const A = await panel(store, locks);
  const B = await panel(store, locks);
  const x = A.state.chatId;
  const big = (c) => c.repeat(9000);
  A.state.messages.push(
    { role: 'user', content: 'First: ' + big('a') }, { role: 'assistant', content: big('b') },
    { role: 'user', content: 'Second: ' + big('c') }, { role: 'assistant', content: big('e') },
    { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
  );
  await A.T.saveHistory();
  await waitFor(() => B.state.messages.length === 6, 'B to follow');
  B.handle.detached = true; // B keeps the copy from before the compaction
  A.PROVIDERS.anthropic.contextTokens = 100; // A's budget: the 8,000-token floor (B's stays large)
  answers(A, 'The summary.', 'Answer in A.');
  await send(A, 'Question in A');
  assert.strictEqual(A.bodies[0].system, A.T.COMPACT_PROMPT);
  assert.ok(store.items[histKey(x)].some((m) => m._summary));
  assert.ok(!B.state.messages.some((m) => m._summary)); // stale
  answers(B, 'Answer in B.');
  await send(B, 'Question in B');
  assert.strictEqual(B.bodies.length, 1); // no compaction of its own
  const texts = sentTexts(B.bodies[0]);
  assert.ok(texts[0].startsWith('[Summary of the earlier conversation]\nThe summary.'), texts[0]);
  assert.ok(!JSON.stringify(B.bodies[0]).includes('aaaaaaaa')); // the compacted turns are not sent
  assert.ok(texts.some((t) => t.endsWith('Question in A')) && texts[texts.length - 1].endsWith('Question in B'));
  const stored = store.items[histKey(x)];
  assert.ok(stored.some((m) => m._summary) && stored.filter((m) => m._compacted).length >= 4);
  deq(pairs(stored).slice(-2), [['user', 'Question in B'], ['assistant', 'Answer in B.']]);
});
