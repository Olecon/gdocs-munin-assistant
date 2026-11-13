'use strict';
// Chat titles (src/chat-title.js, the title fields of src/chats.js): the parsing of a model's title, the material of
// the automatic title request, the request itself (once per chat after a finished turn, in the background; a failure
// keeps the first-message title and is not retried; Stop and a new turn cancel it; none for side questions, the
// self-test or document passes), the chat_title tool (read, rename, errors, where it is offered), the merge of a given
// title across tabs and the switcher showing it.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, waitFor, makeSnapFor } = require('./lib/sandbox');
const { sseResponse } = require('./lib/streams');
const { docBench, useProvider, oaText, send } = require('./lib/context');

let env, T, state, snapFor;
const ANSWER = 'The methods section describes the sample preparation. ' + 'x'.repeat(800);
const meta = () => state.chats.find((c) => c.id === state.chatId);
const isTitleReq = (b) => b.instructions === T.CHAT_TITLE_PROMPT;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// The provider's fetch: the main turn's requests get main(), the title requests title(body, init) (default: a title).
function route({ main = () => oaText(ANSWER), title = () => oaText('Methods Section Overview') } = {}) {
  const log = { main: [], title: [] };
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    const kind = isTitleReq(b) ? 'title' : 'main';
    log[kind].push(b);
    const out = await (kind === 'title' ? title(b, init) : main(b, init));
    return typeof out === 'string' ? sseResponse(out) : out;
  };
  return log;
}
async function newChat() {
  await T.createChat();
  assert.strictEqual(state.messages.length, 0);
}

before(async () => {
  env = await load({ autoTitle: true });
  ({ T, state } = env);
  snapFor = makeSnapFor(env);
  const { doc } = docBench(env);
  doc.text = '# Paper\n\n## Methods\n\nSamples were prepared.';
  await T.refreshContext({ force: true });
  useProvider(env, 'openai');
});

test('parseChatTitle: the first line without quotes, labels, Markdown or a period; long replies and reasoning dropped', () => {
  assert.strictEqual(T.parseChatTitle('"Methods Section Overview."'), 'Methods Section Overview');
  assert.strictEqual(T.parseChatTitle('**Title:** «Обзор раздела методов»\nSecond line'), 'Обзор раздела методов');
  assert.strictEqual(T.parseChatTitle('## Lipid rafts in membranes'), 'Lipid rafts in membranes');
  assert.strictEqual(T.parseChatTitle('<think>the user asks…</think>\n\nRaft size estimates'), 'Raft size estimates');
  assert.strictEqual(T.parseChatTitle('reasoning without its start</think>Raft size'), 'Raft size');
  assert.strictEqual(T.parseChatTitle('<think>cut off before the answer'), '');
  assert.strictEqual(T.parseChatTitle(''), '');
  assert.strictEqual(T.parseChatTitle('This chat is about the methods section of the paper and its samples'), '', 'more than 8 words');
  const long = T.parseChatTitle('Supercalifragilisticexpialidocious '.repeat(3));
  assert.ok(long.length <= T.CHAT_TITLE_NAMED_MAX && long.endsWith('…'), long);
  assert.strictEqual(T.cleanChatTitle('  New \n  name  '), 'New name');
});

test('chatTitleMaterial: the first message without its command, the beginning of its answer; panel requests skipped', () => {
  const msgs = [
    { role: 'user', content: 'Earlier turns', _summary: true },
    { role: 'user', content: 'Review this document.', _persona: 'review' },
    { role: 'assistant', content: 'Findings…' },
    { role: 'user', content: '/research lipid rafts', _persona: 'research' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'assistant', content: 'A'.repeat(700) },
    { role: 'user', content: 'Go on', _auto: true },
    { role: 'assistant', content: 'B' },
    { role: 'user', content: 'Next question' },
  ];
  const m = T.chatTitleMaterial(msgs, msgs[8]);
  assert.ok(m.startsWith('<user_message>\nlipid rafts\n</user_message>'), m.slice(0, 80));
  assert.ok(m.includes(`<answer_start>\n${'A'.repeat(T.CHAT_TITLE_ANSWER_CHARS)}\n</answer_start>`));
  // the first answer is empty (stopped): the answer of the turn just finished
  const two = [{ role: 'user', content: 'First' }, { role: 'user', content: 'Second' }, { role: 'assistant', content: 'Reply two' }];
  assert.ok(T.chatTitleMaterial(two, two[1]).includes('Reply two'));
  assert.strictEqual(T.chatTitleMaterial([{ role: 'assistant', content: 'x' }], null), '');
});

test('the title request: one quiet request per provider shape, no tools, no history, low reasoning', () => {
  const mu = T.chatTitleRequest(snapFor('munin'), 'MATERIAL');
  assert.strictEqual(mu.body.persona, 'raw');
  assert.strictEqual(mu.body.max_tokens, T.CHAT_TITLE_REPLY_TOKENS.munin);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mu.body.chat_template_kwargs)), { reasoning_effort: 'low' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mu.body.messages)), [{ role: 'system', content: T.CHAT_TITLE_PROMPT }, { role: 'user', content: 'MATERIAL' }]);
  assert.ok(!mu.body.tools);
  const an = T.chatTitleRequest(snapFor('anthropic'), 'MATERIAL');
  assert.strictEqual(an.kind, 'anthropic');
  assert.strictEqual(an.body.system, T.CHAT_TITLE_PROMPT);
  assert.ok(!an.body.tools);
  const oa = T.chatTitleRequest(snapFor('openai', { model: 'gpt-6.1-sol' }), 'MATERIAL');
  assert.strictEqual(oa.kind, 'responses');
  assert.strictEqual(oa.body.reasoning.effort, 'low');
  assert.ok(T.CHAT_TITLE_PROMPT.length < 300, 'a short instruction');
});

test('after the first turn: one title request with the first message and the answer excerpt; the title shows at once', async () => {
  await newChat();
  const log = route();
  await send(env, 'Summarize the methods');
  await waitFor(() => meta().titleBy === 'model', 'the automatic title');
  assert.strictEqual(log.main.length, 1);
  assert.strictEqual(log.title.length, 1);
  const user = log.title[0].input[0].content;
  assert.ok(user.includes('<user_message>\nSummarize the methods\n</user_message>'), user);
  assert.ok(user.includes(ANSWER.slice(0, T.CHAT_TITLE_ANSWER_CHARS)) && !user.includes(ANSWER.slice(0, T.CHAT_TITLE_ANSWER_CHARS + 1)));
  assert.ok(!log.title[0].tools, 'no tools');
  assert.strictEqual(meta().title, 'Methods Section Overview');
  assert.ok(meta().titledAt > 0);
  assert.strictEqual(T.el.chatSwitchTitle.textContent, 'Methods Section Overview');
  const stored = env.storage['muninChats:' + state.docId].find((c) => c.id === state.chatId);
  assert.strictEqual(stored.title, 'Methods Section Overview');
  assert.strictEqual(stored.titleBy, 'model');
  // the next turn: no second request
  await send(env, 'And the results?');
  await tick();
  assert.strictEqual(log.main.length, 2);
  assert.strictEqual(log.title.length, 1);
  assert.strictEqual(meta().title, 'Methods Section Overview');
});

test('a failed request keeps the first-message title and is not retried; an unusable reply counts as an attempt too', async () => {
  await newChat();
  const log = route({ title: () => sseResponse('{"error":{"message":"busy"}}', 503) });
  await send(env, 'What is the sample size?');
  await waitFor(() => meta().titleTried === true, 'the failed attempt');
  assert.strictEqual(log.title.length, 1, 'one attempt, no transport retry');
  assert.strictEqual(meta().title, 'What is the sample size?');
  assert.strictEqual(meta().titleBy, undefined);
  assert.strictEqual(T.el.chatSwitchTitle.textContent, 'What is the sample size?');
  assert.ok(!/retrying/i.test(T.el.docStatus.textContent), 'no status text');
  await send(env, 'Thanks');
  await tick();
  assert.strictEqual(log.title.length, 1, 'not retried');

  await newChat();
  const log2 = route({ title: () => oaText('This is a long sentence and not a short chat title at all') });
  await send(env, 'Explain the statistics');
  await waitFor(() => meta().titleTried === true, 'the unusable reply');
  assert.strictEqual(log2.title.length, 1);
  assert.strictEqual(meta().title, 'Explain the statistics');
});

test('Stop: a stopped turn asks for no title; a new turn cancels a request in flight, and a later turn asks again', async () => {
  await newChat();
  const log = route({ main: () => { state.abort.abort(); throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }); } });
  await send(env, 'Stopped question');
  await tick();
  assert.strictEqual(log.title.length, 0);
  assert.ok(T.needsAutoTitle(meta()), 'still due');

  // a title request that hangs until it is aborted; the next message cancels it
  let aborted = 0;
  const hang = (b, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => { aborted++; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
  const log2 = route({ title: hang });
  await send(env, 'Second try');
  await waitFor(() => log2.title.length === 1, 'the title request');
  const log3 = route();
  await send(env, 'Third message');
  assert.strictEqual(aborted, 1, 'cancelled by the new turn');
  await waitFor(() => meta().titleBy === 'model', 'the title of the later turn');
  assert.strictEqual(log3.title.length, 1);
  assert.strictEqual(meta().titleTried, undefined, 'a cancelled request is no attempt');
  assert.ok(!T.el.chat.children.some((c) => /aborted/i.test(c.textContent || '')), 'no notice');
});

test('the title request never holds up the chat: the turn ends and a queued message starts while it is pending', async () => {
  await newChat();
  // title requests are held until the test releases them (or they are aborted)
  const held = [];
  const hold = (b, init) => new Promise((res, rej) => {
    const h = { release: () => res(oaText('Methods Section Overview')), aborted: false };
    held.push(h);
    init.signal.addEventListener('abort', () => { h.aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  let mains = 0;
  const log = route({
    title: hold,
    main: () => {
      mains++;
      if (mains === 1) { T.el.input.value = 'And the results?'; T.queueInput(); } // typed while the first answer runs
      return oaText(ANSWER);
    },
  });
  T.el.input.value = 'Summarize the methods';
  await T.sendMessage(); // the first turn, then the queued one, without waiting for any title request
  assert.strictEqual(log.main.length, 2, 'the queued message went out');
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null);
  assert.strictEqual(state.queued, null);
  assert.ok(!/title/i.test(T.el.docStatus.textContent), 'nothing on the status line');
  await waitFor(() => held.some((h) => !h.aborted), 'the title request of the last turn, pending');
  assert.ok(held.slice(0, -1).every((h) => h.aborted), 'an earlier one was cancelled by the queued turn');
  assert.strictEqual(meta().titleBy, undefined, 'no title yet');
  held[held.length - 1].release();
  await waitFor(() => meta().titleBy === 'model', 'the title lands later');
  assert.strictEqual(meta().title, 'Methods Section Overview');
});

test('no title request in a side question, a self-test loop, an agent or a document pass', async () => {
  await newChat();
  const log = route();
  await send(env, '/side What does line 3 say?');
  await tick();
  assert.strictEqual(log.main.length, 1);
  assert.strictEqual(log.title.length, 0);
  const chatCtx = { docId: state.docId, chatId: state.chatId, messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }] };
  const userMsg = chatCtx.messages[0];
  const s = snapFor('openai');
  for (const extra of [{ quiet: true }, { side: true }, { agent: { id: 'a1' } }]) await T.autoTitle(userMsg, { ...s, ...extra }, chatCtx);
  await T.autoTitle({ role: 'user', content: 'Review this document.', _persona: 'review' }, s, chatCtx);
  assert.strictEqual(log.title.length, 0);
  await T.autoTitle(userMsg, s, chatCtx); // the same call as a main turn makes
  assert.strictEqual(log.title.length, 1);
});

test('chat_title: read, rename (trimmed, capped), empty is an error; the read-only chat turn, no gate; the button follows', async () => {
  await newChat();
  route();
  await send(env, 'Look at the abstract');
  await waitFor(() => meta().titleBy === 'model', 'the automatic title');
  const s = snapFor('openai');
  s.chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };
  const call = (args, mode = 'manual') => T.executeTool({ id: 't' + Math.random(), function: { name: 'chat_title', arguments: JSON.stringify(args) } }, mode, s, {});
  let r = await call({ title: null });
  assert.strictEqual(r.content, 'Chat title: Methods Section Overview');
  assert.strictEqual(r._ok, true);
  r = await call({ title: '  Abstract   wording \n review ' }, 'plan');
  assert.strictEqual(r.content, 'Chat title now: Abstract wording review');
  assert.strictEqual(r._ok, true);
  assert.strictEqual(meta().title, 'Abstract wording review');
  assert.strictEqual(meta().titleBy, 'model');
  assert.strictEqual(T.el.chatSwitchTitle.textContent, 'Abstract wording review');
  r = await call({ title: 'y'.repeat(100) }, 'edit');
  assert.strictEqual(meta().title.length, T.CHAT_TITLE_NAMED_MAX);
  r = await call({ title: '   ' });
  assert.ok(r.content.startsWith('Error: the title is empty'), r.content);
  assert.strictEqual(r._ok, false);
  r = await call({ title: 5 });
  assert.ok(r.content.startsWith('Error:'), r.content);
  // a given title: the automatic request does not run again
  assert.strictEqual(T.needsAutoTitle(meta()), false);
});

test('chat_title is offered in chat turns (the read-only chat turn, Edit, Plan, OpenAI / Anthropic personas), not to agents, side questions, the self-test or Munin personas', () => {
  const names = (mode, prov, extra = {}, text = 'Fix the intro') => {
    const s = snapFor(prov);
    s.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [{ role: 'user', content: text }] };
    Object.assign(s, extra);
    return T.toolsFor(mode, s).map((t) => t.function.name);
  };
  for (const mode of ['manual', 'edit', 'plan', 'research', 'chat']) {
    assert.ok(names(mode, 'openai').includes('chat_title'), mode);
    assert.ok(names(mode, 'anthropic').includes('chat_title'), mode);
  }
  // Munin (no prompt cache): only when the message is about the title, in English or Russian
  assert.ok(!names('edit', 'munin').includes('chat_title'));
  for (const t of ['Rename this chat to Methods', 'What is the title of this chat?', 'Переименуй чат', 'Дай заголовок этому чату', 'смени название чата']) {
    assert.ok(names('edit', 'munin', {}, t).includes('chat_title'), t);
  }
  assert.ok(!names('research', 'munin').includes('chat_title'), 'Munin persona: no client tools');
  assert.ok(!names('edit', 'openai', { agent: { id: 'a1' } }).includes('chat_title'), 'agent');
  assert.ok(!names('manual', 'openai', { side: true }).includes('chat_title'), 'side question');
  assert.ok(!names('edit', 'openai', { quiet: true }).includes('chat_title'), 'self-test');
  const def = T.CHAT_TITLE_TOOL.function;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(def.parameters)), {
    type: 'object',
    properties: { title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The new title, or null to read it.' } },
    required: ['title'],
    additionalProperties: false,
  });
  assert.ok(def.description.length < 200, 'about 40 tokens');
  assert.strictEqual(typeof T.extraTool('chat_title').reading, 'function');
  assert.ok(T.isExtraReading('chat_title', { title: null }), 'a read is a quiet reading call');
  assert.ok(!T.isExtraReading('chat_title', { title: 'Benzothiazole hybridization' }), 'a rename is a write');
  assert.strictEqual(T.extraTool('chat_title').anyMode, true);
});

test('merging metas: the later given title wins whatever updatedAt says; the switcher list shows it', () => {
  const stored = [{ id: 'c1', title: 'Given title', titleBy: 'model', titledAt: 500, createdAt: 1, updatedAt: 1000 }];
  const local = [{ id: 'c1', title: 'First message', createdAt: 1, updatedAt: 2000 }];
  let m = T.mergeChatLists(stored, local, {})[0];
  assert.strictEqual(m.title, 'Given title');
  assert.strictEqual(m.titleBy, 'model');
  assert.strictEqual(m.updatedAt, 2000);
  m = T.mergeChatLists(stored, [{ ...local[0], title: 'Renamed', titleBy: 'user', titledAt: 900 }], {})[0];
  assert.strictEqual(m.title, 'Renamed');
  assert.strictEqual(m.titleBy, 'user');
  assert.strictEqual(T.needsAutoTitle(m), false);
  assert.strictEqual(T.needsAutoTitle({ id: 'c', title: 'First message' }), true);
  assert.strictEqual(T.needsAutoTitle({ id: 'c', title: 'First message', titleTried: true }), false);
  // the chat list: one row per chat with its title (also as the tooltip of a long one)
  T.renderChatMenu();
  const rows = T.el.chatMenu.children;
  assert.strictEqual(rows.length, state.chats.length);
  const row = rows.find((r) => r.dataset.id === state.chatId);
  assert.strictEqual(row.children[0].textContent, meta().title);
  assert.strictEqual(row.children[0].dataset.tip, meta().title);
});
