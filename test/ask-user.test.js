'use strict';
// ask_user: the definition and where it is offered (Auto, Manual, /side; not Munin persona turns), the prompt line,
// the question card (kind 'ask': the question, one button per option, "I'll answer in chat"), the result texts of
// each answer and of Stop, _decision, one question per turn, invalid arguments, the self-test's quiet loop, and
// whole turns: the answer goes to the model, survives slimHistory, and the card shows what was chosen.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, waitFor } = require('./lib/sandbox');
const { tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, muTool, muText } = require('./lib/context');

let env, T, state, doc;
const QUESTION = 'Which section should I shorten?';
const OPTIONS = ['Introduction', 'Methods', 'Both'];
const call = (id, args = { question: QUESTION, options: OPTIONS }) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(args) } });
const snap = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
const names = (tools) => tools.map((t) => t.name || (t.function && t.function.name));
const pending = () => [...T.pendingPreviews.entries()].map(([id, p]) => ({ id, card: p.card }));

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\n## Introduction\n\nIntro text.\n\n## Methods\n\nMethod text.';
  await T.refreshContext({ force: true });
});

// Runs one ask_user call and answers its card with decision (decidePreview), or Stop when decision is 'stop'.
async function ask(decision, s = snap(), args) {
  const ac = new AbortController();
  s.signal = ac.signal;
  const ui = {};
  const p = T.executeTool(call('a1', args), 'edit', s, ui);
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  const [{ id, card }] = pending();
  if (decision === 'stop') ac.abort(); else assert.ok(T.decidePreview(id, decision));
  const r = await p;
  return { r, card, ui, s };
}

test('definition: strict schema, offered in every turn with client tools (Auto, Manual, /side), not in Munin persona turns', () => {
  deq(T.ASK_USER_TOOL.function.parameters, {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One short sentence.' },
      options: { type: 'array', items: { type: 'string' }, description: '2 to 4 short answers, each a few words.' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  });
  assert.strictEqual(T.TOOL_DEFS.ask_user, undefined); // registered, after the built-in tools
  for (const [mode, prov] of [['edit', 'anthropic'], ['manual', 'anthropic'], ['edit', 'munin'], ['manual', 'openai'], ['research', 'anthropic']]) {
    state.settings.provider = prov;
    const s = snap();
    const tools = names(T.toolsFor(mode, s));
    assert.ok(tools.includes('ask_user'), `${mode}/${prov}`);
    s.side = true;
    assert.ok(names(T.toolsFor(mode, s)).includes('ask_user'), `${mode}/${prov} side`);
  }
  // no prompt line: the description alone says when to ask and how often (Auto and Manual)
  state.settings.provider = 'anthropic';
  for (const mode of ['edit', 'manual']) {
    assert.ok(!T.buildSystemParts(mode, 1000, snap()).head.includes('ask_user'), mode);
  }
  const desc = T.ASK_USER_TOOL.function.description;
  assert.ok(desc.includes('for a choice you cannot make yourself and that blocks your work') && desc.includes('At most once per message.'), desc);
  state.settings.provider = 'munin';
  assert.ok(!names(T.toolsFor('code', snap())).includes('ask_user')); // Munin persona turns: no client tools
  state.settings.provider = 'anthropic';
});

test('the card: the question, one button per option and "I\'ll answer in chat"; the attention dot while it waits', async () => {
  const sent = [];
  const prevSend = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg) => { if (msg.type === 'ATTENTION') sent.push(msg.pending); return prevSend(id, msg); };
  state.pinnedTabId = 7;
  const s = snap();
  s.signal = new AbortController().signal;
  const p = T.executeTool(call('c1'), 'manual', s, {});
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  const [{ id, card }] = pending();
  assert.ok(card.className.includes('preview') && card.className.includes('ask'));
  const html = card.innerHTML;
  assert.ok(html.includes('<span class="pv-tool">ask_user</span>') && html.includes('❓'), html);
  assert.ok(html.includes(`<div class="pv-note">${QUESTION}</div>`), html);
  const buttons = [...html.matchAll(/<button [^>]*data-ask="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
  deq(buttons, [['0', 'Introduction'], ['1', 'Methods'], ['2', 'Both'], ['chat', "I'll answer in chat"]]);
  assert.ok(!html.includes('preview-accept') && !html.includes('Allow'), 'no Allow / Deny');
  deq(sent, [true]);
  T.decidePreview(id, 'option:1');
  await p;
  deq(sent, [true, false]);
  assert.ok(card.className.includes('decided'));
  state.pinnedTabId = null;
  env.chrome.tabs.sendMessage = prevSend;
});

test('answers: each option, "I\'ll answer in chat" and Stop give their result texts and _decision', async () => {
  for (const [i, opt] of OPTIONS.entries()) {
    const { r } = await ask(`option:${i}`);
    deq([r.content, r._ok, r._decision, r._message, r._detail, r._icon], [`The user chose: ${opt}.`, true, 'answered', `You chose: ${opt}`, QUESTION, '❓']);
    assert.strictEqual(r._edit, undefined); assert.strictEqual(r._reading, undefined); // no journal, not a reading call
  }
  let { r } = await ask('chat');
  deq([r.content, r._ok, r._decision, r._message], ['The user will answer in the chat; finish what you can and end your turn.', true, 'chat', 'You will answer in the chat']);
  ({ r } = await ask('stop'));
  deq([r.content, r._ok, r._decision, r._message], [T.ASK_STOPPED_TEXT, false, 'stopped', 'Question not answered: stopped']);
  assert.ok(r.content.startsWith('Error: the user stopped the answer'));
  // the action log: a stopped question shows as rejected; an answered one as ok, with the question as its summary
  const tc = call('a1');
  deq([T.logEntry(tc, r).status, T.logEntry(tc, (await ask('option:0')).r).status, T.logEntry(tc, null).summary], ['rejected', 'ok', QUESTION]);
});

test('one question per turn: a second call is refused without a card; invalid arguments are refused', async () => {
  const { s } = await ask('option:0');
  const again = await T.executeTool(call('a2'), 'edit', s, {});
  deq([again.content, again._ok, again._decision], ['Error: ask_user was already used in this message; put the remaining questions in your answer text instead.', false, undefined]);
  assert.strictEqual(T.pendingPreviews.size, 0);
  for (const args of [{ question: '', options: ['a', 'b'] }, { question: 'Q?', options: ['only'] }, { question: 'Q?', options: ['a', 'b', 'c', 'd', 'e'] },
    { question: 'Q?', options: ['a', 'a'] }, { question: 'Q?', options: 'a, b' }, { question: 'Q?', options: ['a', '  '] }]) {
    const s2 = snap();
    const r = await T.executeTool(call('bad', args), 'edit', s2, {});
    assert.strictEqual(r.content, 'Error: ask_user needs a question and 2 to 4 different, non-empty options.', JSON.stringify(args));
    assert.strictEqual(T.pendingPreviews.size, 0);
    assert.ok(!s2.askedUser); // an invalid call does not use up the question
  }
  // a quiet tool loop (the self-test) has nobody to answer
  const q = snap(); q.quiet = true;
  assert.ok((await T.executeTool(call('q'), 'edit', q, {})).content.startsWith('Error: ask_user is not available here'));
});

// A whole turn: round 0 asks, the user answers on the card, round 1 gets the answer and replies.
async function askTurn(prov, decision, rounds, text = 'Shorten it') {
  useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
  await T.createChat();
  T.el.chat.children.length = 0;
  const bodies = recordFetch(env, rounds);
  env.T.el.input.value = text;
  const turn = env.T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  const [{ id }] = pending();
  T.decidePreview(id, decision);
  await turn;
  return bodies;
}

test('a turn (Anthropic, Auto): the answer reaches the model, survives slimHistory; the card shows the choice', async () => {
  const bodies = await askTurn('anthropic', 'option:1',
    [msgStart + tu(0, 'toolu_ask', 'ask_user', { question: QUESTION, options: OPTIONS }) + stopTool, textRound('Methods it is; it is already short.')]);
  assert.strictEqual(bodies.length, 2);
  assert.ok(names(bodies[0].tools).includes('ask_user'));
  const result = bodies[1].messages[2].content[0];
  deq([result.type, result.tool_use_id, result.content], ['tool_result', 'toolu_ask', 'The user chose: Methods.']);
  const toolMsg = state.messages.find((m) => m.role === 'tool');
  deq([toolMsg.content, toolMsg._decision, toolMsg._ok], ['The user chose: Methods.', 'answered', true]);
  // slimming keeps the answer (it is not a reading result), also for a long option text
  const long = { role: 'tool', tool_call_id: 'toolu_ask', content: 'The user chose: ' + 'x'.repeat(300) + '.' };
  const hist = [{ role: 'assistant', content: null, tool_calls: [call('toolu_ask')] }, long];
  T.slimHistory(hist);
  assert.ok(hist[1].content.startsWith('The user chose: xxx') && !hist[1]._omittedChars);
  // renderHistory: the result card (not a pending question) shows what was chosen, under the question
  T.el.chat.children.length = 0; // the stub DOM's innerHTML = '' does not remove children
  T.renderHistory();
  const cards = T.el.chat.children.filter((c) => c.className && c.className.includes('tool-card'));
  assert.strictEqual(cards.length, 1);
  assert.ok(cards[0].innerHTML.includes('❓ You chose: Methods') && cards[0].innerHTML.includes(QUESTION), cards[0].innerHTML);
  assert.ok(!cards[0].className.includes('preview'));
  assert.strictEqual(state.busy, false);
});

test('a turn (Munin, Manual): "I\'ll answer in chat" ends the question; the model is told to finish', async () => {
  state.applyMode = 'manual';
  const bodies = await askTurn('munin', 'chat', [muTool('c_ask', 'ask_user', { question: QUESTION, options: OPTIONS }), muText('Tell me which section.')]);
  state.applyMode = 'auto';
  assert.strictEqual(bodies.length, 2);
  const sent = bodies[1].messages[bodies[1].messages.length - 1];
  deq([sent.role, sent.tool_call_id, sent.content], ['tool', 'c_ask', T.ASK_CHAT_TEXT]);
  assert.ok(T.el.chat.children.some((c) => c.className && c.className.includes('tool-card') && c.innerHTML.includes('You will answer in the chat')));
});

test('a side question (/side) may ask too; a second ask_user in the same response is refused', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  const two = msgStart + tu(0, 'toolu_a1', 'ask_user', { question: QUESTION, options: OPTIONS }) +
    tu(1, 'toolu_a2', 'ask_user', { question: 'And the tone?', options: ['Formal', 'Casual'] }) + stopTool;
  const bodies = recordFetch(env, [two, textRound('Shortening Methods.')]);
  T.el.input.value = '/side which part is long?';
  const turn = T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  T.decidePreview(pending()[0].id, 'option:2');
  await turn;
  assert.strictEqual(bodies.length, 2);
  const results = bodies[1].messages[bodies[1].messages.length - 1].content.map((b) => b.content);
  deq(results, ['The user chose: Both.', T.ASK_AGAIN_TEXT]);
  deq(state.sideMessages.filter((m) => m.role === 'tool').map((m) => m._decision), ['answered', undefined]);
  assert.ok(!JSON.stringify(state.messages).includes('ask_user')); // the chat history is untouched
});

test('Stop while the question waits: the stopped text, the turn ends stopped', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  const bodies = recordFetch(env, [msgStart + tu(0, 'toolu_s', 'ask_user', { question: QUESTION, options: OPTIONS }) + stopTool, textRound('never')]);
  T.el.input.value = 'Shorten it';
  const turn = T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  state.abort.abort();
  await turn;
  assert.strictEqual(bodies.length, 1);
  const toolMsg = state.messages.find((m) => m.role === 'tool');
  deq([toolMsg.content, toolMsg._decision], [T.ASK_STOPPED_TEXT, 'stopped']);
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.strictEqual(state.busy, false);
});
