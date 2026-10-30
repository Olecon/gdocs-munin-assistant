'use strict';
// /side: a throwaway side question. Parsing and the popup entry; a Manual-like turn (reading tools, no editing,
// remember refused) on state.sideMessages that leaves the chat history and its stored copy untouched; the side
// thread continues across side questions, is never sent with a main turn and is dropped on a chat switch; the
// Side bubbles survive a re-render until the next main turn ends.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, oaText, muText, muTool } = require('./lib/context');

let env, T, state, doc;
const histKey = () => 'muninChatHistory:DOC123:' + state.chatId;
const toolNames = (body) => (body.tools || []).map((t) => t.name || (t.function && t.function.name));
const textRoundFor = (prov, t) => (prov === 'anthropic' ? textRound(t) : prov === 'openai' ? oaText(t) : muText(t));
const bubbles = () => T.el.chat.children.filter((c) => c && c.classList && (c.classList.contains('user') || c.classList.contains('assistant')));
const sideBubbles = () => bubbles().filter((b) => b.classList.contains('side'));

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nThe term entropy appears here.\n\nSecond paragraph.';
  await T.refreshContext({ force: true });
});

// A fresh chat with one finished main turn (Anthropic), so that there is a stored history to protect.
async function chatWithOneTurn() {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  T.el.chat.children.length = 0;
  recordFetch(env, [textRound('Main answer.')]);
  await send(env, 'main question');
  assert.strictEqual(state.messages.length, 2);
}

test('/side parses as a built-in command and is listed in the popup', () => {
  deq(T.parseSlashCommand('/side what does entropy mean?'), { persona: null, side: true, text: 'what does entropy mean?' });
  deq(T.parseSlashCommand('  /SIDE   hi  '), { persona: null, side: true, text: 'hi' });
  deq(T.parseSlashCommand('/side'), { persona: null, side: true, text: '' });
  deq(T.parseSlashCommand('/sidebar x'), { persona: null, text: '/sidebar x' });
  deq(T.parseSlashCommand('/chat /side x'), { persona: 'chat', text: '/side x' });
  assert.ok(T.popupNames().includes('side'));
  assert.strictEqual(T.popupEntry('side').desc, 'Side question: not saved, not sent with later messages');
});

test('/side with no text: a notice, nothing is sent, the input keeps the command', async () => {
  await chatWithOneTurn();
  const bodies = recordFetch(env, [textRound('never')]);
  const before = T.el.chat.children.length;
  T.el.input.value = '/side   ';
  await T.sendMessage();
  assert.strictEqual(bodies.length, 0);
  assert.strictEqual(state.busy, false);
  assert.strictEqual(T.el.input.value, '/side   ');
  const notice = T.el.chat.children[before];
  assert.ok(notice.classList.contains('notice') && notice.innerHTML.includes('Write your question after /side'));
  deq(state.sideMessages, []);
});

test('a side turn runs on sideMessages; the chat history and its stored copy stay byte-identical', async () => {
  await chatWithOneTurn();
  const mem = JSON.stringify(state.messages);
  const stored = JSON.stringify(env.storage[histKey()]);
  const all = JSON.stringify(env.storage);
  const bodies = recordFetch(env, [textRound('Entropy measures disorder.')]);
  await send(env, '/side what does entropy mean?');
  assert.strictEqual(bodies.length, 1);
  // only the side question is sent, with the normal turn context
  assert.strictEqual(bodies[0].messages.length, 1);
  const sent = JSON.stringify(bodies[0].messages);
  assert.ok(sent.includes('what does entropy mean?') && sent.includes('<document'));
  assert.ok(!sent.includes('main question') && !sent.includes('Main answer.'));
  // the main chat is untouched, in memory and in storage (and nothing else is stored: chat list, document text baseline)
  assert.strictEqual(JSON.stringify(state.messages), mem);
  assert.strictEqual(JSON.stringify(env.storage[histKey()]), stored);
  assert.strictEqual(JSON.stringify(env.storage), all);
  deq(state.sideMessages.map((m) => [m.role, m.content]), [['user', 'what does entropy mean?'], ['assistant', 'Entropy measures disorder.']]);
  assert.ok(state.sideMessages[0]._context.includes('<document'));
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.sideTurn, false);
  assert.strictEqual(T.el.input.value, '');
  // the side bubbles: user + assistant, styled, with a Side badge
  const side = sideBubbles();
  assert.strictEqual(side.length, 2);
  assert.ok(side[0].classList.contains('user') && side[1].classList.contains('assistant'));
  for (const b of side) assert.ok(b.children.some((c) => c && c.className === 'side-badge' && c.textContent === 'Side'));
});

for (const prov of ['anthropic', 'openai', 'munin']) {
  test(`${prov}: a side turn offers the reading tools only (no writing tools, no replace_selection), even in Auto`, async () => {
    await chatWithOneTurn();
    useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
    state.applyMode = 'auto';
    const bodies = recordFetch(env, [textRoundFor(prov, 'Side answer.')]);
    await send(env, '/side is this phrasing correct?');
    assert.strictEqual(bodies.length, 1);
    const names = toolNames(bodies[0]);
    assert.ok(names.includes('read_lines') && names.includes('get_selection'), names.join(','));
    assert.ok(!names.includes('replace_selection'));
    assert.ok(!names.includes('remember')); // a side question leaves nothing behind: not offered at all
    for (const w of T.WRITE_TOOLS) assert.ok(!names.includes(w), w);
    if (prov === 'munin') assert.strictEqual(bodies[0].persona, 'raw'); // the tools pipeline, not a persona stream
    // the Manual rules, not the Auto ones; no remember note (the tool is not offered)
    const system = JSON.stringify(prov === 'anthropic' ? bodies[0].system : prov === 'openai' ? bodies[0].instructions : bodies[0].messages[0]);
    assert.ok(system.includes('You CANNOT modify the document'));
    assert.ok(!system.includes('remember(action, text)'));
    assert.strictEqual(state.sideMessages.at(-1).content, 'Side answer.');
  });
}

test('remember is refused in a side turn: the document instructions stay as they were', async () => {
  await chatWithOneTurn();
  useProvider(env, 'munin');
  const instructions = state.docInstructions;
  const storedKeys = JSON.stringify(Object.keys(env.storage).sort());
  const bodies = recordFetch(env, [muTool('call_r', 'remember', { action: 'add', text: 'Always use British spelling.' }), muText('OK.')]);
  await send(env, '/side remember: always British spelling');
  assert.strictEqual(bodies.length, 2);
  const result = state.sideMessages.find((m) => m.role === 'tool');
  assert.ok(result.content.startsWith('Error: remember is not available in a side question'));
  assert.strictEqual(result._ok, false);
  assert.strictEqual(state.docInstructions, instructions);
  assert.strictEqual(JSON.stringify(Object.keys(env.storage).sort()), storedKeys);
});

test('consecutive side questions share the side thread; a main turn does not send it and leaves it alone', async () => {
  await chatWithOneTurn();
  let bodies = recordFetch(env, [textRound('First side answer.')]);
  await send(env, '/side first side question');
  bodies = recordFetch(env, [textRound('Second side answer.')]);
  await send(env, '/side second side question');
  // the second side request carries the first side exchange, and still nothing of the main chat
  deq(bodies[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const sent = JSON.stringify(bodies[0].messages);
  assert.ok(sent.includes('first side question') && sent.includes('First side answer.') && sent.includes('second side question'));
  assert.ok(!sent.includes('main question'));
  assert.strictEqual(state.sideMessages.length, 4);
  assert.strictEqual(sideBubbles().length, 4);
  // a re-render (another tab's change, an undo) keeps the side exchange at the end (the stub DOM's innerHTML = ''
  // does not clear the children, so the test does; test/dom/side-chat.test.js checks this on a real DOM)
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(sideBubbles().length, 4);
  assert.ok(bubbles().at(-1).classList.contains('side'));
  // a main turn: no side message in its request, the side thread kept, the side bubbles gone after it
  const side = JSON.stringify(state.sideMessages);
  bodies = recordFetch(env, [textRound('Main again.')]);
  await send(env, 'next main question');
  const mainSent = JSON.stringify(bodies[0].messages);
  assert.ok(mainSent.includes('main question') && mainSent.includes('next main question'));
  assert.ok(!mainSent.includes('side question') && !mainSent.includes('side answer'));
  assert.ok(!JSON.stringify(state.messages).includes('side question'));
  assert.ok(!JSON.stringify(env.storage[histKey()]).includes('side question'));
  assert.strictEqual(JSON.stringify(state.sideMessages), side);
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(sideBubbles().length, 0);
  // the next side question still continues the thread
  bodies = recordFetch(env, [textRound('Third.')]);
  await send(env, '/side third side question');
  assert.strictEqual(bodies[0].messages.length, 5);
});

test('a chat switch (or a new chat) drops the side thread', async () => {
  await chatWithOneTurn();
  const first = state.chatId;
  recordFetch(env, [textRound('Side.')]);
  await send(env, '/side a side question');
  assert.strictEqual(state.sideMessages.length, 2);
  await T.createChat();
  deq(state.sideMessages, []);
  // and switching back does not bring it back
  await T.switchChat(first);
  assert.strictEqual(state.chatId, first);
  deq(state.sideMessages, []);
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.strictEqual(sideBubbles().length, 0);
  // the next side question starts a new thread
  const bodies = recordFetch(env, [textRound('Fresh.')]);
  await send(env, '/side again');
  assert.strictEqual(bodies[0].messages.length, 1);
});

test('Stop during a side turn: the turn ends, the panel is idle, the main chat untouched', async () => {
  await chatWithOneTurn();
  const mem = JSON.stringify(state.messages);
  env.ctx.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    state.abort.abort();
  });
  await send(env, '/side slow question');
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null);
  assert.strictEqual(JSON.stringify(state.messages), mem);
  assert.ok(T.el.chat.children.some((c) => c.classList && c.classList.contains('notice') && c.innerHTML.includes('Stopped.')));
  assert.strictEqual(state.sideMessages.at(-1).content, 'slow question');
});

test('Anthropic tool round in a side turn: the reading call runs, results are slimmed after the turn', async () => {
  await chatWithOneTurn();
  doc.text = ['# Big', '', ...Array.from({ length: 40 }, (_, i) => `Line ${i + 3} with some words in it.`)].join('\n');
  const bodies = recordFetch(env, [msgStart + tu(0, 'toolu_side', 'read_lines', { start: 1, end: 42, doc: null }) + stopTool, textRound('Read.')]);
  await send(env, '/side summarize the document');
  assert.strictEqual(bodies.length, 2);
  deq(state.sideMessages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(state.sideMessages[2].content.startsWith('[read_lines 1–42: content omitted after the turn'));
});
