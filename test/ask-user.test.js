'use strict';
// ask_user: the definition (the questions list) and where it is offered (Auto, Manual, /side; not Munin persona
// turns), the head's ask rule, the questionnaire card (kind 'ask': the question, one button per suggested answer, the
// Other field; no "I'll answer in chat"), the result texts for one and several questions (a multiple question's answers
// joined with "; ") and of Stop, _decision, one card
// per message, invalid arguments, the old {question, options} shape, the self-test's quiet loop, the answered rows
// (and from history), the chat log, and whole turns: the answers go to the model, survive slimHistory, and the card
// shows what was chosen.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { chatCards, deq, load, stageCards, waitFor } = require('./lib/sandbox');
const { tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, muTool, muText } = require('./lib/context');

let env, T, state, doc;
const QUESTION = 'Which section should I shorten?';
const OPTIONS = ['Introduction', 'Methods', 'Both'];
const ARGS = { questions: [{ question: QUESTION, options: OPTIONS }] };
const THREE = { questions: [{ question: 'Which spin labels?', options: ['MTSL', 'TEMPO'] }, { question: 'Which force field?', options: ['AMBER', 'CHARMM', 'OPLS'] },
  { question: 'How do you validate them?', options: [] }] };
const call = (id, args = ARGS) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(args) } });
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
async function ask(decision, s = snap(), args, mode = 'edit') {
  const ac = new AbortController();
  s.signal = ac.signal;
  const ui = {};
  const p = T.executeTool(call('a1', args), mode, s, ui);
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
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
            multiple: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'the user may pick several answers' } },
          required: ['question', 'options', 'multiple'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  });
  // compact (Munin, custom servers): multiple is a plain boolean and optional
  deq(T.compactTool(T.ASK_USER_TOOL).function.parameters.properties.questions.items, {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
      multiple: { type: 'boolean', description: 'the user may pick several answers' } },
    required: ['question', 'options'],
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
  // no prompt line of its own; the head's ask rule (every mode, not an agent's head) says when to ask
  state.settings.provider = 'anthropic';
  const rule = 'Questions you need answered before writing go in one ask_user call, not in your answer text.'; // the how (several, suggested answers) is in the definition
  for (const mode of ['edit', 'manual', 'plan']) {
    assert.strictEqual(T.buildSystemParts(mode, 1000, snap()).head.split('ask_user call').length, 2, mode);
    assert.ok(T.buildSystemParts(mode, 1000, snap()).head.includes(rule), mode);
  }
  const agent = snap(); agent.agent = { access: 'read' };
  assert.ok(!T.toolsInstructions('edit', agent).includes('ask_user call'));
  const desc = T.ASK_USER_TOOL.function.description;
  assert.strictEqual(desc, 'Ask the user up to 4 questions in one card, each with 2–4 suggested answers (a few words each); the user can also type their own. Use it before writing when you need facts or choices from the user. At most once per message.');
  state.settings.provider = 'munin';
  assert.ok(!names(T.toolsFor('code', snap())).includes('ask_user')); // Munin persona turns: no client tools
  state.settings.provider = 'anthropic';
});

test('the card: the question, one numbered button per option, the Other field, no chat button; the attention dot while it waits', async () => {
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
  assert.ok(html.includes('<span class="pv-tool">ask_user</span>') && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), html);
  assert.ok(html.includes(`<div class="pv-note">${QUESTION}</div>`), html);
  const buttons = [...html.matchAll(/<button [^>]*data-ask="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
  deq(buttons, [['0', '1. Introduction'], ['1', '2. Methods'], ['2', '3. Both']]); // one question: no Send
  assert.ok(!html.includes('data-ask="chat"') && !html.includes('answer in chat') && !html.includes('ask-end'), html);
  assert.ok(html.includes('placeholder="Other"') && !html.includes('ask-steps'), html);
  assert.ok(!html.includes('preview-accept') && !html.includes('Allow'), 'no Allow / Deny');
  deq(sent, [true]);
  T.decidePreview(id, 'option:1');
  await p;
  deq(sent, [true, false]);
  assert.ok(card.className.includes('answered-row') && card.innerHTML.includes('<span class="log-status">Chosen: Methods</span>'), card.className); // the card became its answered row in place
  state.pinnedTabId = null;
  env.chrome.tabs.sendMessage = prevSend;
});

test('answers: each option and Stop give their result texts and _decision', async () => {
  for (const [i, opt] of OPTIONS.entries()) {
    const { r } = await ask(`option:${i}`);
    deq([r.content, r._ok, r._decision, r._message, r._detail, r._icon], [`The user answered:\n1. ${QUESTION} \u2014 ${opt}`, true, 'answered', `Chosen: ${opt}`, QUESTION, undefined]);
    assert.strictEqual(r._edit, undefined); assert.strictEqual(r._reading, undefined); // no journal, not a reading call
  }
  let { r } = await ask('stop');
  deq([r.content, r._ok, r._decision, r._message], [T.ASK_STOPPED_TEXT, false, 'stopped', 'Question not answered: stopped']);
  assert.ok(r.content.startsWith('Error: the user stopped the answer'));
  // the action log: a stopped question shows as rejected; an answered one as ok, with the question as its summary
  const tc = call('a1');
  deq([T.logEntry(tc, r).status, T.logEntry(tc, (await ask('option:0')).r).status, T.logEntry(tc, null).summary], ['rejected', 'ok', QUESTION]);
});

test('three questions: one tool message lists each question with its answer; the row and its fold; Stop', async () => {
  let { r, card } = await ask('answers:' + JSON.stringify(['MTSL', 'CHARMM', 'DEER distances against the crystal structure']), snap(), THREE);
  deq([r.content, r._ok, r._decision, r._message], ['The user answered:\n1. Which spin labels? \u2014 MTSL\n2. Which force field? \u2014 CHARMM\n' +
    '3. How do you validate them? \u2014 DEER distances against the crystal structure', true, 'answered', 'Answered 3 questions']);
  // the programmatic option:<i> gives each question its own option i (a question without options stays empty)
  ({ r } = await ask('option:1', snap(), THREE));
  assert.strictEqual(r.content, 'The user answered:\n1. Which spin labels? \u2014 TEMPO\n2. Which force field? \u2014 CHARMM\n3. How do you validate them? \u2014 (no answer)');
  ({ r, card } = await ask('answers:' + JSON.stringify(['MTSL', 'CHARMM', 'DEER']), snap(), THREE));
  assert.ok(card.innerHTML.includes('<span class="activity-name">ask_user</span> · <span class="log-status">Answered 3 questions</span><span class="log-preview"> · Which spin labels?</span>'), card.innerHTML);
  assert.ok(card.innerHTML.includes('<div class="log-what">Questions</div><div class="log-asked">1. Which spin labels? \u2014 MTSL</div><div class="log-asked">2. Which force field? \u2014 CHARMM</div>' +
    '<div class="log-asked">3. How do you validate them? \u2014 DEER</div>'), card.innerHTML);
  deq(r._answered, [{ kind: 'ask', tool: 'ask_user', title: 'Questions', text: 'Which spin labels?', decision: 'option',
    questions: [{ question: 'Which spin labels?', answer: 'MTSL' }, { question: 'Which force field?', answer: 'CHARMM' }, { question: 'How do you validate them?', answer: 'DEER' }] }]);
  // rebuilt from history: the same row
  const [again] = T.answeredCardsFor(call('a1', THREE), r);
  assert.strictEqual(again.innerHTML, card.innerHTML);
  ({ r, card } = await ask('stop', snap(), THREE));
  deq([r.content, r._decision], [T.ASK_STOPPED_TEXT, 'stopped']);
  assert.ok(card.innerHTML.includes('<span class="log-status">Stopped</span>') && card.innerHTML.includes('<div class="log-asked">2. Which force field?</div>'), card.innerHTML);
  // a stored chat of the removed "I'll answer in chat" button still draws its row
  const [old] = T.answeredCardsFor(call('a1', THREE), { ...r, _decision: 'chat', _answered: [{ kind: 'ask', tool: 'ask_user', title: 'Questions', text: 'Which spin labels?', decision: 'chat', questions: [{ question: 'Which spin labels?' }] }] });
  assert.ok(old.innerHTML.includes('<span class="log-status">Answered in the chat</span>'), old.innerHTML);
});

test('the old shape: a call with question and options is one question; a stored old answer draws its row', async () => {
  const { r } = await ask('option:2', snap(), { question: QUESTION, options: OPTIONS });
  deq([r.content, r._message], [`The user answered:\n1. ${QUESTION} \u2014 Both`, 'Chosen: Both']);
  // a tool message stored before the questionnaire (with _answered, and older still: only _decision)
  const old = call('o1', { question: QUESTION, options: OPTIONS });
  const stored = { role: 'tool', tool_call_id: 'o1', content: 'The user chose: Methods.', _ok: true, _decision: 'answered', _message: 'Chosen: Methods', _detail: QUESTION };
  for (const m of [{ ...stored, _answered: [{ kind: 'ask', tool: 'ask_user', title: 'Question', text: QUESTION, decision: 'option', choice: 'Methods' }] }, stored]) {
    const [row] = T.answeredCardsFor(old, m);
    assert.ok(row.innerHTML.includes('<span class="log-status">Chosen: Methods</span>') && row.innerHTML.includes(`<div class="log-asked">${QUESTION}</div>`), row.innerHTML);
  }
  // its copied log line
  assert.ok(T.buildChatLog([{ role: 'assistant', content: null, tool_calls: [old] }, stored]).includes(`> ask_user → ok\n  1. ${QUESTION} \u2014 Methods\n`));
});

test('the chat log prints the questions and their answers', async () => {
  const { r } = await ask('answers:' + JSON.stringify(['MTSL', 'CHARMM', 'DEER']), snap(), THREE);
  const one = (await ask('option:1')).r;
  const multi = (await ask('answers:' + JSON.stringify(['Formal; Casual']), snap(), { questions: [{ question: 'Which tone?', options: ['Formal', 'Casual'], multiple: true }] })).r;
  const log = T.buildChatLog([
    { role: 'user', content: 'Parametrize the labels' },
    { role: 'assistant', content: null, tool_calls: [call('t1', THREE)] }, { ...r, role: 'tool', tool_call_id: 't1' },
    { role: 'assistant', content: null, tool_calls: [call('t2')] }, { ...one, role: 'tool', tool_call_id: 't2' },
    { role: 'assistant', content: null, tool_calls: [call('t3', { questions: [{ question: 'Which tone?', options: ['Formal', 'Casual'], multiple: true }] })] }, { ...multi, role: 'tool', tool_call_id: 't3' },
  ], { title: 'Labels' });
  assert.ok(log.includes('> ask_user → ok\n  1. Which spin labels? \u2014 MTSL\n  2. Which force field? \u2014 CHARMM\n  3. How do you validate them? \u2014 DEER\n' +
    `> ask_user → ok\n  1. ${QUESTION} \u2014 Methods\n` +
    '> ask_user → ok\n  1. Which tone? \u2014 Formal; Casual\n'), log);
});

test('one card per message: a second call is refused without a card; invalid arguments are refused', async () => {
  const { s } = await ask('option:0');
  const again = await T.executeTool(call('a2'), 'edit', s, {});
  deq([again.content, again._ok, again._decision], ['Error: ask_user was already used in this message; put the remaining questions in your answer text instead.', false, undefined]);
  assert.strictEqual(T.pendingPreviews.size, 0);
  const qa = (question, options) => ({ question, options });
  // refused: no question, more than 4, a question without text (named)
  for (const [args, text] of [[{ questions: [] }, 'Error: ask_user takes 1 to 4 questions; this call has 0.'], [{ questions: 'Q?' }, 'Error: ask_user takes 1 to 4 questions; this call has 0.'],
    [{}, 'Error: ask_user takes 1 to 4 questions; this call has 0.'],
    [{ questions: [qa('1?', []), qa('2?', []), qa('3?', []), qa('4?', []), qa('5?', [])] }, 'Error: ask_user takes 1 to 4 questions; this call has 5.'],
    [{ questions: [qa('Q?', ['a']), qa(' ', ['a', 'b'])] }, 'Error: question 2 of ask_user has no text; give every question its text.'],
    [{ questions: [{ options: ['a'] }] }, 'Error: question 1 of ask_user has no text; give every question its text.']]) {
    const s2 = snap();
    const r = await T.executeTool(call('bad', args), 'edit', s2, {});
    assert.strictEqual(r.content, text, JSON.stringify(args));
    assert.strictEqual(T.pendingPreviews.size, 0);
    assert.ok(!s2.askedUser); // an invalid call does not use up the question
  }
  // lenient: duplicates and blank or non-string answers dropped, the first 4 kept; options missing or not a list: none
  const opts = (args) => T.askQuestions(args).questions.map((q) => q.options);
  deq(opts({ questions: [qa('Q?', ['a', 'b', 'c', 'd', 'e'])] }), [['a', 'b', 'c', 'd']]);
  deq(opts({ questions: [qa('Q?', ['a', ' a ', 'b', '', 1, 'a', 'c', 'd', 'e'])] }), [['a', 'b', 'c', 'd']]);
  deq(opts({ questions: [qa('Q?', 'a, b'), { question: 'R?' }] }), [[], []]);
  deq(opts({ question: 'Q?', options: ['a', 'a'] }), [['a']]);
  // a quiet tool loop (the self-test) has nobody to answer
  const q = snap(); q.quiet = true;
  assert.ok((await T.executeTool(call('q'), 'edit', q, {})).content.startsWith('Error: ask_user is not available here'));
});

// A whole turn: round 0 asks, the user answers on the card, round 1 gets the answer and replies.
async function askTurn(prov, decision, rounds, text = 'Shorten it', applyMode = 'auto') {
  useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
  state.applyMode = applyMode;
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
    [msgStart + tu(0, 'toolu_ask', 'ask_user', ARGS) + stopTool, textRound('Methods it is; it is already short.')]);
  assert.strictEqual(bodies.length, 2);
  assert.ok(names(bodies[0].tools).includes('ask_user'));
  const result = bodies[1].messages[2].content[0];
  const answered = `The user answered:\n1. ${QUESTION} \u2014 Methods`;
  deq([result.type, result.tool_use_id, result.content], ['tool_result', 'toolu_ask', answered]);
  const toolMsg = state.messages.find((m) => m.role === 'tool');
  deq([toolMsg.content, toolMsg._decision, toolMsg._ok], [answered, 'answered', true]);
  // slimming keeps the answer (it is not a reading result), also for a long option text
  const long = { role: 'tool', tool_call_id: 'toolu_ask', content: 'The user answered:\n1. Q? \u2014 ' + 'x'.repeat(300) };
  const hist = [{ role: 'assistant', content: null, tool_calls: [call('toolu_ask')] }, long];
  T.slimHistory(hist);
  assert.ok(hist[1].content.endsWith('xxx') && !hist[1]._omittedChars);
  deq(toolMsg._answered, [{ kind: 'ask', tool: 'ask_user', title: 'Question', text: QUESTION, decision: 'option', choice: 'Methods' }]);
  // renderHistory: the question card in its answered state (the question muted, the choice), no second card, in the
  // turn's bubble (the stage of its call), not after it
  T.el.chat.children.length = 0; // the stub DOM's innerHTML = '' does not remove children
  T.renderHistory();
  const cards = chatCards(T.el.chat);
  assert.strictEqual(cards.length, 1);
  const bubble = T.el.chat.children.find((c) => c._rounds);
  assert.ok(stageCards(bubble)[0] === cards[0]);
  assert.ok(cards[0].className.includes('answered-row') && !cards[0].className.includes('tool-card'), cards[0].className);
  // the row "ask_user · Chosen: Methods · <the question>", the whole question in its fold
  assert.ok(cards[0].innerHTML.includes('<span class="activity-name">ask_user</span> · <span class="log-status">Chosen: Methods</span><span class="log-preview"> · ') &&
    cards[0].innerHTML.includes(`<div class="log-what">Question</div><div class="log-asked">${QUESTION}</div>`), cards[0].innerHTML);
  assert.ok(!cards[0].innerHTML.includes('You chose') && !cards[0].innerHTML.includes('<button'));
  assert.strictEqual(state.busy, false);
});

test('a turn (Munin, Manual): the compact definition leaves multiple optional; a multiple question\'s answers reach the model joined', async () => {
  const MULTI = { questions: [{ question: 'Which sections?', options: ['Introduction', 'Methods', 'Results'], multiple: true }] };
  const bodies = await askTurn('munin', 'answers:' + JSON.stringify(['Introduction; Results; the abstract']), [muTool('c_ask', 'ask_user', MULTI), muText('Shortening them.')], 'Shorten it', 'manual');
  state.applyMode = 'auto';
  assert.strictEqual(bodies.length, 2);
  const def = bodies[0].tools.find((t) => t.function && t.function.name === 'ask_user');
  deq(def.function.parameters.properties.questions.items.required, ['question', 'options']);
  const sent = bodies[1].messages[bodies[1].messages.length - 1];
  deq([sent.role, sent.tool_call_id, sent.content], ['tool', 'c_ask', 'The user answered:\n1. Which sections? \u2014 Introduction; Results; the abstract']);
  const answered = chatCards(T.el.chat);
  assert.ok(answered.length >= 1);
  for (const c of answered) assert.ok(c.innerHTML.includes('<span class="log-status">Chosen: Introduction; Results; the abstract</span>'), c.innerHTML);
});

test('a side question (/side) may ask too; a second ask_user in the same response is refused', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  const two = msgStart + tu(0, 'toolu_a1', 'ask_user', ARGS) +
    tu(1, 'toolu_a2', 'ask_user', { questions: [{ question: 'And the tone?', options: ['Formal', 'Casual'] }] }) + stopTool;
  const bodies = recordFetch(env, [two, textRound('Shortening Methods.')]);
  T.el.input.value = '/side which part is long?';
  const turn = T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  T.decidePreview(pending()[0].id, 'option:2');
  await turn;
  assert.strictEqual(bodies.length, 2);
  const results = bodies[1].messages[bodies[1].messages.length - 1].content.map((b) => b.content);
  deq(results, [`The user answered:\n1. ${QUESTION} \u2014 Both`, T.ASK_AGAIN_TEXT]);
  deq(state.sideMessages.filter((m) => m.role === 'tool').map((m) => m._decision), ['answered', undefined]);
  assert.ok(!JSON.stringify(state.messages).includes('ask_user')); // the chat history is untouched
});

test('Stop while the question waits: the stopped text, the turn ends stopped', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  const bodies = recordFetch(env, [msgStart + tu(0, 'toolu_s', 'ask_user', ARGS) + stopTool, textRound('never')]);
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
