'use strict';
// The draft plan checklist (src/draft.js): a section counts as written from the document (its heading, normalized,
// with at least 40 words below it before the next heading; Docs API model and Markdown export) or from draft(done);
// the card (one per chat, at the end of the chat, drawn again at every turn end), its markup, End draft, and the
// "Draft complete" notice when the document completes the plan.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, storage, ident, routeDocs, fresh;

const SECTIONS = [
  { heading: 'Introduction', intent: 'why membrane order matters' },
  { heading: 'Methods', intent: 'how we measured it' },
  { heading: 'Results', intent: 'what changed' },
];
const READERS = [{ reader: 'Reviewer 2', question: 'Why only twelve samples?', section: 'Methods' }];
const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ') + '.';
const NULLS = { sections: null, section: null, readers: null };
const run = (args, snap = as) => T.executeTool({ id: 'd' + Math.random().toString(36).slice(2, 6), function: { name: 'draft', arguments: JSON.stringify({ ...NULLS, ...args }) } }, 'edit', snap, {});
const key = () => `muninDraft:DOC123:${state.chatId}`;
const cards = () => T.el.chat.children.filter((c) => c.className.includes('draft-card'));
const noticeTexts = () => T.el.chat.children.filter((c) => c.className.includes('notice')).map((c) => c.innerHTML);
// A document: the title, "1. Introduction:" with 45 words, Methods with 10 words, then Results with 50 words under a subheading.
const DOC_ITEMS = [
  { p: 'Membrane order', style: 'TITLE' },
  { p: '1. Introduction:', style: 'HEADING_1' }, { p: words(30) }, { p: words(15, 'more') },
  { p: 'Methods', style: 'HEADING_1' }, { p: words(10) },
  { p: 'Results', style: 'HEADING_1' }, { p: 'Overview', style: 'HEADING_2' }, { p: words(50) },
];

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  ident = installIdentity(env);
  ({ routeDocs, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true; state.applyMode = 'auto';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
});

const docSetup = async () => {
  await fresh(docSpec({ items: DOC_ITEMS }));
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
};

test('detection: a heading equal after normalization with 40+ words before the next heading; Markdown too', async () => {
  await docSetup();
  const plan = { sections: SECTIONS.map((s) => ({ ...s, done: false })), readers: READERS };
  deq(T.draftStatus(plan, { model: state.docModel }).map((s) => [s.heading, s.written]), [['Introduction', true], ['Methods', false], ['Results', false]]);
  deq(['1. Introduction:', 'II. Methods', '  results. ', '2.1 Results'].map(T.draftHeadingKey), ['introduction', 'methods', 'results', 'results']);
  // the Markdown export: "#" headings; a table cell is body text in the model
  const md = `# Paper\n\n## Introduction\n\n${words(39)}\n\n## Methods\n\n${words(20)} ${words(20)}\n\n## Results`;
  deq(T.draftStatus(plan, { docText: md }).map((s) => s.written), [false, true, false]);
  // draft(done) marks explicitly whatever the document holds
  plan.sections[2].done = true;
  deq(T.draftStatus(plan, { model: state.docModel }).map((s) => s.written), [true, false, true]);
  deq(T.openReaderQuestions(plan, T.draftStatus(plan, { model: state.docModel })).map((q) => q.question), ['Why only twelve samples?']);
  deq(T.draftStatus(plan, null).map((s) => s.written), [false, false, true]);
});

test('the turn-context line and draft(done) count what the document already has', async () => {
  await docSetup();
  let r = await run({ action: 'plan', sections: SECTIONS, readers: READERS });
  assert.ok(r.content.includes('Next: «Methods» (how we measured it).'), r.content);
  const line = (await T.beforeTurnLines('edit', as)).find((l) => l.startsWith('Draft'));
  assert.strictEqual(line, 'Draft in progress: 3 sections, 1 written; open: Methods, Results; next: Methods (how we measured it). Open reader questions: Reviewer 2: Why only twelve samples? (Methods).');
  r = await run({ action: 'done', section: 'Results' });
  assert.strictEqual(r.content, 'Marked «Results» written (2 of 3). Next: «Methods» (how we measured it).');
  r = await run({ action: 'done', section: 'Methods' });
  assert.strictEqual(r.content, 'Marked «Methods» written: all 3 sections are written. Call draft(end) when the text is complete.');
  assert.strictEqual(as.draftCompleted, 3);
  await run({ action: 'end' });
});

test('the card: checklist, next section, open reader questions, End draft; one per chat; drawn again after a re-render', async () => {
  await docSetup();
  T.el.chat.children.length = 0;
  assert.strictEqual(await T.refreshDraftCard(), null); // no plan: no card
  deq(cards().length, 0);
  await run({ action: 'plan', sections: SECTIONS, readers: READERS });
  const card = await T.refreshDraftCard();
  deq(cards().length, 1);
  assert.strictEqual(card.innerHTML, '<div class="dc-title">🗂 Draft plan: 1 of 3 sections written</div>' +
    '<ul class="dc-list"><li class="done">☑ Introduction</li><li>☐ Methods</li><li>☐ Results</li></ul>' +
    '<div class="dc-next">Next: Methods (how we measured it)</div>' +
    '<div class="dc-label">Open reader questions</div><ul class="dc-questions"><li>Reviewer 2: Why only twelve samples? <span class="dc-where">(Methods)</span></li></ul>' +
    '<div class="tool-actions"><button class="btn small" type="button" data-draft="end" title="Clear the draft plan of this chat">End draft</button></div>');
  // drawn again: still one card, at the end, with the current state
  T.addNotice('something else');
  await run({ action: 'done', section: 'Methods' });
  await T.refreshDraftCard();
  deq(cards().length, 1);
  assert.ok(T.el.chat.children[T.el.chat.children.length - 1].className.includes('draft-card'));
  assert.ok(cards()[0].innerHTML.includes('2 of 3 sections written') && cards()[0].innerHTML.includes('<li class="done">☑ Methods</li>'));
  assert.ok(!cards()[0].innerHTML.includes('Open reader questions'), 'the Methods question is answered');
  // a re-render of the chat drops it (not stored in the history; the stub DOM drops children by hand)
  T.renderHistory(); T.el.chat.children.length = 0;
  assert.ok(!JSON.stringify(state.messages).includes('draft-card'));
  await T.refreshDraftCard();
  deq(cards().length, 1);
  // another chat without a plan: no card
  const chatA = state.chatId;
  state.chatId = 'cOther';
  await T.refreshDraftCard();
  deq(cards().length, 0);
  state.chatId = chatA;
  // End draft: the same as draft(end)
  await T.refreshDraftCard();
  assert.strictEqual(await T.endDraftFromCard(), true);
  assert.strictEqual(storage[key()], undefined);
  deq(cards().length, 0);
  assert.ok(noticeTexts().includes('Draft ended: the plan of this chat is cleared.'));
  // not while an answer runs
  await run({ action: 'plan', sections: SECTIONS });
  state.busy = true;
  assert.strictEqual(await T.endDraftFromCard(), false);
  state.busy = false;
  assert.ok(storage[key()]);
  await run({ action: 'end' });
});

const aTool = (i, name, args) => msgStart + tu(0, 'toolu_' + i, name, args) + stopTool;
async function turn(rounds, text) {
  let n = 0;
  env.ctx.fetch = routeDocs(async () => sseResponse(rounds[n++]));
  T.el.input.value = text;
  await T.sendMessage();
}

test('turn end: the card is drawn again; writing the last section into the document gives "Draft complete" without draft(done)', async () => {
  await docSetup();
  await T.createChat();
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  T.el.chat.children.length = 0;
  await turn([aTool(1, 'draft', { ...NULLS, action: 'plan', sections: SECTIONS.slice(0, 2) }), textRound('Planned.')], 'Plan a paper');
  await waitFor(() => cards().length === 1, 'the card after the turn');
  assert.ok(cards()[0].innerHTML.includes('1 of 2 sections written'));
  // the model writes the Methods body (no draft(done)): the document completes the plan
  await turn([aTool(2, 'insert_after_line', { line: 6, text: words(45, 'step') }), textRound('Methods are in.')], 'Write Methods');
  await waitFor(() => noticeTexts().includes('Draft complete: 2 sections'), 'the notice');
  await waitFor(() => cards().length === 1 && cards()[0].innerHTML.includes('2 of 2 sections written'), 'the updated card');
  assert.ok(cards()[0].innerHTML.includes('All sections are written.'));
  const ctx = state.messages.filter((m) => m.role === 'user').pop()._context;
  assert.ok(ctx.includes('Draft in progress: 2 sections, 1 written; open: Methods; next: Methods (how we measured it).'), ctx);
});
