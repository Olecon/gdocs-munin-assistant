'use strict';
// Draft mode (src/draft.js): the draft tool's schema and offer (Auto with the Docs API only), its prompt line,
// plan / done / end across turns with the turn-context line, the plan per chat in storage, malformed plans,
// reader questions (validation, the open questions in the line, the ask_user card that trims the readers),
// the "Draft complete" notice, the action-log summary and icon.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
const { muTool, muText } = require('./lib/context');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, storage, ident, routeDocs, fresh;

const SECTIONS = [
  { heading: 'Introduction', intent: 'why membrane order matters' },
  { heading: 'Methods', intent: 'how we measured it' },
  { heading: 'Results', intent: 'what changed' },
];
const NULLS = { sections: null, section: null, readers: null };
const call = (args, id = 'd' + Math.random().toString(36).slice(2, 6)) => ({ id, function: { name: 'draft', arguments: JSON.stringify({ ...NULLS, ...args }) } });
const run = (args, snap = as, mode = 'edit') => T.executeTool(call(args), mode, snap, {});
const key = (chatId) => `muninDraft:DOC123:${chatId}`;
const noticeTexts = () => T.el.chat.children.filter((c) => c.className.includes('notice')).map((c) => c.innerHTML);

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  ident = installIdentity(env);
  ({ routeDocs, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: '# Exported\n\nexport text', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true; state.applyMode = 'auto';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
  Object.assign(state.settings.providers.munin, { apiKey: 'k-T' });
});

test('definition: strict schema; offered and prompted only in Auto with the Docs API', async () => {
  await fresh();
  const def = T.toolsFor('edit', as).find((t) => t.function.name === 'draft');
  assert.ok(def, 'offered in Auto with the Docs API');
  const p = def.function.parameters;
  deq([p.required, p.additionalProperties, p.properties.action.enum], [['action', 'sections', 'section', 'readers'], false, ['plan', 'done', 'end']]);
  deq(p.properties.sections.anyOf[0].items.required, ['heading', 'intent']);
  deq(p.properties.readers.anyOf[0].items.required, ['reader', 'question', 'section']);
  const line = '\n- draft(action, sections, section, readers): for a text over about two pages, first name 3–4 readers of its type (paper: reviewer 2, methods expert, newcomer; grant: programme officer, neighbouring-field reviewer; thesis: examiner, future student) with 1–2 questions each and ask_user which one to drop; save the outline with draft(plan), the kept questions as readers; write one section per edit (insert_after_line or replace_section), mark it with draft(done); draft(end) when the text is complete.\n';
  assert.ok(T.buildSystemParts('edit', 1e5, as).head.includes(line));
  // Manual, a side question, the export path and Munin persona turns: not offered, no prompt line
  const names = (mode, snap) => T.toolsFor(mode, snap).map((t) => t.function.name);
  assert.ok(!names('manual', as).includes('draft'));
  assert.ok(!T.buildSystemParts('manual', 1e5, as).head.includes('draft('));
  assert.ok(!names('edit', { ...as, side: true }).includes('draft'));
  const exported = { ...as, docFormat: 'markdown', model: null, promptView: { ...as.promptView, docFormat: 'markdown', model: null } };
  assert.ok(!names('edit', exported).includes('draft'));
  assert.ok(!T.buildSystemParts('edit', 1e5, exported).head.includes('draft('));
  state.settings.provider = 'munin';
  const mu = T.takeSnapshot(); T.snapshotDocument(mu);
  assert.ok(names('edit', mu).includes('draft'), 'Munin Auto turns with the Docs API');
  deq(names('research', mu), []);
  state.settings.provider = 'anthropic';
  // not offered: refused like an unknown tool
  const r = await run({ action: 'end' }, exported);
  deq([r._ok, r.content], [false, 'Error: draft is not available for this message.']);
});

test('plan: validation of the sections (empty, more than 30, no heading, duplicates, not an array)', async () => {
  await fresh();
  const bad = 'Error: draft(plan) needs 1 to 30 sections, each with a heading and an intent.';
  for (const sections of [[], null, 'Intro, Methods', Array.from({ length: 31 }, (_, i) => ({ heading: `S${i}`, intent: '' })), [{ heading: '  ', intent: 'x' }], [{ intent: 'x' }]]) {
    const r = await run({ action: 'plan', sections });
    deq([r._ok, r.content], [false, bad], JSON.stringify(sections).slice(0, 40));
  }
  const dup = await run({ action: 'plan', sections: [{ heading: 'Intro', intent: '' }, { heading: ' intro ', intent: '' }] });
  deq([dup._ok, dup.content], [false, 'Error: two sections have the heading «intro»; give each section its own heading.']);
  assert.strictEqual(storage[key(state.chatId)], undefined); // nothing stored
  // 30 is fine; a bad action
  const ok = await run({ action: 'plan', sections: Array.from({ length: 30 }, (_, i) => ({ heading: `S${i + 1}`, intent: '' })) });
  assert.ok(ok._ok, ok.content);
  deq((await run({ action: 'write' })).content, 'Error: action must be "plan", "done" or "end".');
  await run({ action: 'end' });
});

test('done and end: by heading or number, already written, unknown section, no plan', async () => {
  await fresh();
  let r = await run({ action: 'done', section: 'Methods' });
  deq([r._ok, r.content], [false, 'Error: there is no draft plan in this chat; save one with draft(plan) first.']);
  r = await run({ action: 'plan', sections: SECTIONS });
  deq([r._ok, r._reading, r._message, r.content], [true, true, 'plan: 3 sections',
    'Draft plan saved: 3 sections. Next: «Introduction» (why membrane order matters). Mark each section with draft(done) once it is in the document.']);
  r = await run({ action: 'done', section: '  methods ' });
  deq([r._ok, r.content], [true, 'Marked «Methods» written (1 of 3). Next: «Introduction» (why membrane order matters).']);
  r = await run({ action: 'done', section: 'Methods' });
  assert.strictEqual(r.content, '«Methods» was already marked written. Next: «Introduction» (why membrane order matters).');
  r = await run({ action: 'done', section: 'Discussion' });
  deq([r._ok, r.content], [false, 'Error: no section «Discussion» in the plan. Sections: «Introduction», «Methods», «Results».']);
  r = await run({ action: 'done', section: '1' });
  assert.strictEqual(r.content, 'Marked «Introduction» written (2 of 3). Next: «Results» (what changed).');
  deq(storage[key(state.chatId)].sections.map((s) => s.done), [true, true, false]);
  r = await run({ action: 'plan', sections: SECTIONS.slice(0, 2) });
  assert.ok(r.content.startsWith('Draft plan saved (it replaces the earlier one): 2 sections.'), r.content);
  r = await run({ action: 'end' });
  deq([r._ok, r.content], [true, 'Draft plan cleared.']);
  assert.strictEqual(storage[key(state.chatId)], undefined);
  assert.strictEqual((await run({ action: 'end' })).content, 'There was no draft plan in this chat; nothing to clear.');
});

test('the plan belongs to its chat; the turn-context line follows it', async () => {
  await fresh();
  const chatA = state.chatId;
  as.chatCtx = { docId: 'DOC123', chatId: chatA, messages: [] };
  await run({ action: 'plan', sections: SECTIONS });
  await run({ action: 'done', section: 'Introduction' });
  assert.strictEqual(await T.beforeTurnLines('edit', as).then((l) => l.join('|')),
    'Draft in progress: 3 sections, 1 written; open: Methods, Results; next: Methods (how we measured it).');
  // another chat of the same document has no plan
  const other = { ...as, chatCtx: { docId: 'DOC123', chatId: 'cOther', messages: [] } };
  deq(await T.beforeTurnLines('edit', other), []);
  // not in Manual or a side question (the tool is not offered)
  deq(await T.beforeTurnLines('manual', as), []);
  deq(await T.beforeTurnLines('edit', { ...as, side: true, chatCtx: { docId: 'DOC123', chatId: null, messages: [] } }), []);
  // all written
  await run({ action: 'done', section: 'Methods' });
  await run({ action: 'done', section: 'Results' });
  deq(await T.beforeTurnLines('edit', as), ['Draft in progress: 3 sections, all written; call draft(end) when the text is complete.']);
  deq(T.draftLine({ sections: [{ heading: 'Only', intent: '', done: false }] }), 'Draft in progress: 1 section, 0 written; open: Only; next: Only.');
  await run({ action: 'end' });
  deq(await T.beforeTurnLines('edit', as), []);
});

// One chat turn on the fake Docs API document; rounds: the SSE texts. Returns the request bodies.
async function turn(rounds, text, prov = 'anthropic') {
  state.settings.provider = prov;
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = text;
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  state.settings.provider = 'anthropic';
  return bodies;
}
const aTool = (i, name, args) => msgStart + tu(0, 'toolu_' + i, name, args) + stopTool;

test('across turns: plan and the first section in one turn, the line in the next turn context, the notice when the last section is marked, end', async () => {
  fake = fakeDocsServer(docSpec());
  await T.createChat();
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto';
  const chatId = state.chatId;
  T.el.chat.children.length = 0;
  // turn 1 (Anthropic): plan, write the first section, mark it
  let bodies = await turn([
    aTool(1, 'draft', { ...NULLS, action: 'plan', sections: SECTIONS.slice(0, 2) }),
    aTool(2, 'insert_after_line', { line: 10, text: 'Introduction\nCells order their membranes.' }),
    aTool(3, 'draft', { ...NULLS, action: 'done', section: 'Introduction' }),
    textRound('The introduction is in.'),
  ], 'Write a short paper');
  assert.strictEqual(bodies.length, 4);
  assert.ok(!state.messages[0]._context.includes('Draft in progress'));
  deq(storage[key(chatId)].sections.map((s) => [s.heading, s.done]), [['Introduction', true], ['Methods', false]]);
  const logged = state.messages.filter((m) => m.role === 'tool').map((m) => [m._ok, m._message]);
  deq([logged[0], logged[2]], [[true, 'plan: 2 sections'], [true, 'done: «Introduction» (1 of 2)']]);
  deq(noticeTexts().filter((t) => t.startsWith('Draft complete')), []);
  // turn 2 (Munin): the context names the plan; the last section is written and marked: the notice
  bodies = await turn([
    muTool('c1', 'insert_after_line', { line: 12, text: 'Methods\nWe used Laurdan.' }),
    muTool('c2', 'draft', { ...NULLS, action: 'done', section: 'Methods' }),
    muText('Both sections are in.'),
  ], 'Next section', 'munin');
  const ctx = state.messages.filter((m) => m.role === 'user').pop()._context;
  assert.ok(ctx.includes('\nDraft in progress: 2 sections, 1 written; open: Methods; next: Methods (how we measured it).\nCurrent selection'), ctx);
  assert.ok(JSON.stringify(bodies[0]).includes('Draft in progress: 2 sections'));
  await waitFor(() => noticeTexts().includes('Draft complete: 2 sections'), 'the notice');
  // turn 3: end
  await turn([aTool(4, 'draft', { ...NULLS, action: 'end' }), textRound('Done.')], 'Finish');
  assert.ok(state.messages.filter((m) => m.role === 'user').pop()._context.includes('all written; call draft(end)'));
  assert.strictEqual(storage[key(chatId)], undefined);
  // turn 4: no line any more; another chat never saw the plan
  await turn([textRound('Hi.')], 'Thanks');
  assert.ok(!state.messages.filter((m) => m.role === 'user').pop()._context.includes('Draft in progress'));
});

test('action-log summary and icon', () => {
  const t = T.extraTool('draft');
  deq([t.summary('draft', { action: 'plan', sections: SECTIONS }), t.summary('draft', { action: 'done', section: 'Methods' }), t.summary('draft', { action: 'end' })],
    ['plan: 3 sections', 'done: «Methods»', 'end']);
  assert.strictEqual(T.extraIcon('draft'), '🗂');
  assert.ok(T.isExtraReading('draft', {})); // no document edit: a quiet row, no card, no gate
});

const READERS = [
  { reader: 'Reviewer 2', question: 'Why only twelve samples?', section: 'methods' },
  { reader: 'Methods expert', question: 'How was Laurdan calibrated?', section: '2' },
  { reader: 'Newcomer', question: 'What is membrane order?', section: 'Introduction' },
  { reader: 'Newcomer', question: 'What does a GP value mean?', section: 'Results' },
];

test('plan with readers: stored per question with its section; validation; a plan without readers still works', async () => {
  await fresh();
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  let r = await run({ action: 'plan', sections: SECTIONS, readers: READERS });
  deq([r._ok, r.content], [true, 'Draft plan saved: 3 sections and 4 reader questions. Next: «Introduction» (why membrane order matters). Mark each section with draft(done) once it is in the document.']);
  deq(storage[key(state.chatId)].readers.map((q) => [q.reader, q.section]),
    [['Reviewer 2', 'Methods'], ['Methods expert', 'Methods'], ['Newcomer', 'Introduction'], ['Newcomer', 'Results']]);
  // invalid: an unknown section, an empty question, more than eight, not an array
  const bad = 'Error: readers needs at most 8 questions, each with a reader, a question and the heading of the section that answers it (or null).';
  r = await run({ action: 'plan', sections: SECTIONS, readers: [{ reader: 'Examiner', question: 'Is it new?', section: 'Conclusion' }] });
  deq([r._ok, r.content], [false, 'Error: the question «Is it new?» names no section of the plan; give the heading of the section that answers it.']);
  for (const readers of [[{ reader: 'Examiner', question: ' ', section: 'Methods' }], Array.from({ length: 9 }, () => READERS[0]), 'Reviewer 2']) {
    r = await run({ action: 'plan', sections: SECTIONS, readers });
    deq([r._ok, r.content], [false, bad], JSON.stringify(readers).slice(0, 40));
  }
  assert.strictEqual(storage[key(state.chatId)].readers.length, 4, 'a refused plan leaves the stored one');
  // null or left out (a lenient model): no readers
  r = await run({ action: 'plan', sections: SECTIONS, readers: null });
  assert.ok(r._ok && r.content.startsWith('Draft plan saved (it replaces the earlier one): 3 sections. Next:'), r.content);
  deq(storage[key(state.chatId)].readers, []);
  r = await T.executeTool({ id: 'd-old', function: { name: 'draft', arguments: JSON.stringify({ action: 'plan', sections: SECTIONS, section: null }) } }, 'edit', as, {});
  assert.ok(r._ok, r.content);
  assert.strictEqual(await T.beforeTurnLines('edit', as).then((l) => l.find((x) => x.startsWith('Draft'))),
    'Draft in progress: 3 sections, 0 written; open: Introduction, Methods, Results; next: Introduction (why membrane order matters).');
  await run({ action: 'end' });
});

test('the turn-context line lists the open reader questions (capped) until their section is written', async () => {
  await fresh();
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  await run({ action: 'plan', sections: SECTIONS, readers: READERS });
  const line = async () => (await T.beforeTurnLines('edit', as)).find((x) => x.startsWith('Draft'));
  assert.strictEqual(await line(), 'Draft in progress: 3 sections, 0 written; open: Introduction, Methods, Results; next: Introduction (why membrane order matters).' +
    ' Open reader questions: Reviewer 2: Why only twelve samples? (Methods); Methods expert: How was Laurdan calibrated? (Methods); Newcomer: What is membrane order? (Introduction); 1 more.');
  await run({ action: 'done', section: 'Methods' });
  assert.strictEqual(await line(), 'Draft in progress: 3 sections, 1 written; open: Introduction, Results; next: Introduction (why membrane order matters).' +
    ' Open reader questions: Newcomer: What is membrane order? (Introduction); Newcomer: What does a GP value mean? (Results).');
  await run({ action: 'done', section: 'Introduction' });
  await run({ action: 'done', section: 'Results' });
  assert.strictEqual(await line(), 'Draft in progress: 3 sections, all written; call draft(end) when the text is complete.');
  deq(T.openReaderQuestions(storage[key(state.chatId)], T.draftStatus(storage[key(state.chatId)], null)), []);
  // more than six open sections: the rest is counted
  const many = Array.from({ length: 8 }, (_, i) => ({ heading: `Part ${i + 1}`, intent: '' }));
  assert.ok(T.draftLine({ sections: many.map((s) => ({ ...s, done: false })), readers: [] }).includes('open: Part 1, Part 2, Part 3, Part 4, Part 5, Part 6 and 2 more; next: Part 1.'));
  await run({ action: 'end' });
});

test('readers before the outline: the ask_user card offers the readers and "I\'ll answer in chat"; the choice reaches the plan call', async () => {
  fake = fakeDocsServer(docSpec());
  await T.createChat();
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto';
  const chatId = state.chatId;
  const options = ['Reviewer 2', 'Methods expert', 'Newcomer'];
  const bodies = [];
  const rounds = [
    aTool(10, 'ask_user', { question: 'Which reader should I drop?', options }),
    aTool(11, 'draft', { action: 'plan', sections: SECTIONS, section: null, readers: READERS.filter((q) => q.reader !== 'Methods expert') }),
    textRound('Here is the outline.'),
  ];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = 'Write a short paper on membrane order';
  const p = T.sendMessage();
  await waitFor(() => T.pendingPreviews.size === 1, 'the readers card');
  const [[id, { card }]] = [...T.pendingPreviews.entries()];
  for (const o of options) assert.ok(card.innerHTML.includes(`>${o}</button>`), o);
  assert.ok(card.innerHTML.includes('Which reader should I drop?'));
  assert.ok(card.innerHTML.includes('I&#39;ll answer in chat') || card.innerHTML.includes("I'll answer in chat"));
  assert.ok(T.decidePreview(id, 'option:1'));
  await p;
  await new Promise((r) => setTimeout(r, 20));
  const toolMsgs = state.messages.filter((m) => m.role === 'tool');
  deq(toolMsgs.slice(-2).map((m) => m.content.slice(0, 41)), ['The user chose: Methods expert.', 'Draft plan saved: 3 sections and 3 reader']);
  deq(storage[key(chatId)].readers.map((q) => q.reader), ['Reviewer 2', 'Newcomer', 'Newcomer']);
});
