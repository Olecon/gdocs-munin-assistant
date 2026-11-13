'use strict';
// Token cuts of the tool set: the on-demand offers of table, page_parts, models, style_map and document_styles on
// providers without a prompt cache (Munin, custom servers; request.js onDemandOffer), the sticky offers of comment and
// find_relevant_sections on providers with one (stickyOffer), the read-only definitions of the read-only chat turn and
// Plan (registerTools defsFor) and the mode-specific write refusal (turn.js editRefusal).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.googleConnected = true;
  for (const id of ['munin', 'openai', 'anthropic']) state.settings.providers[id].apiKey = 'k-' + id;
});

const ON_DEMAND = ['table', 'page_parts', 'models', 'style_map', 'document_styles'];
const plain = () => docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: 'Alpha beta gamma.' }] });
// A snapshot of the open document on prov whose chat holds the given user messages (and any other messages).
function snapOn(prov, messages = [], extra = {}) {
  state.settings.provider = prov;
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  s.chatCtx = { docId: state.docId, chatId: state.chatId, messages: messages.map((m) => (typeof m === 'string' ? { role: 'user', content: m } : m)) };
  return Object.assign(s, extra);
}
const names = (mode, s) => T.toolsFor(mode, s).map((t) => t.function.name);
const offeredOf = (mode, s) => ON_DEMAND.filter((n) => names(mode, s).includes(n));

test('Munin: the five large tools are left out of an unrelated turn; providers with a prompt cache keep them on', async () => {
  await fresh(plain());
  state.docInstructions = ''; state.mainInstructions = '';
  const ask = 'Tighten the Methods section a bit, keeping every number and citation as written.';
  deq(offeredOf('edit', snapOn('munin', [ask])), []);
  deq(offeredOf('manual', snapOn('munin', [ask])), []);
  for (const prov of ['openai', 'anthropic']) deq(offeredOf('edit', snapOn(prov, [ask])), ON_DEMAND, prov);
  // a call made unoffered still runs (its old condition): the turn does not fail on a tool the model knew from before
  for (const n of ON_DEMAND) assert.ok(T.extraRuns(T.extraTool(n), 'edit', snapOn('munin', [ask])), n);
});

test('Munin: each is offered when the newest message names its subject (English and Russian); only the newest counts', async () => {
  await fresh(plain());
  state.docInstructions = ''; state.mainInstructions = '';
  const cases = [
    ['Insert a table with three columns after line 2.', ['table', 'page_parts']], // columns: a layout's too
    ['Добавь таблицу после второй строки.', ['table']],
    ['Add a footnote after "gamma" with the source.', ['page_parts']],
    ['Сделай колонтитул с названием отчёта.', ['page_parts']],
    ['Insert a section break after line 2 and make it landscape.', ['page_parts', 'document_styles']],
    ['Switch this chat to another model.', ['models']],
    ['Какие провайдеры сейчас доступны?', ['models']],
    ['Which fonts does the document use?', ['style_map', 'document_styles']],
    ['Проверь шрифты и интервалы в документе.', ['style_map', 'document_styles']],
    ['Set the page to A4 with 2 cm margins.', ['page_parts', 'document_styles']],
  ];
  for (const [text, want] of cases) deq(offeredOf('edit', snapOn('munin', [text])), want, text);
  // the heading's section of an edit request is not a layout section
  deq(offeredOf('edit', snapOn('munin', ['Rewrite the Methods section in simpler words, keeping every number.'])), []);
  deq(offeredOf('edit', snapOn('munin', ['Перепиши раздел Methods проще, сохранив все числа.'])), []);
  // an earlier message does not keep the offer on Munin
  deq(offeredOf('edit', snapOn('munin', ['Insert a table with three columns after line 2.', { role: 'assistant', content: 'Done.' }, 'Now fix the typo "recieved" in the Methods, please, and nothing else at all.'])), []);
});

test('Munin: a short reply or Do it counts with the answer it replies to', async () => {
  await fresh(plain());
  state.docInstructions = ''; state.mainInstructions = '';
  const proposal = { role: 'assistant', content: 'I can put the three values into a table after line 3. Should I?' };
  deq(offeredOf('edit', snapOn('munin', ['Summarise the values of the Methods for me in a short and clear way.', proposal, 'yes'])), ['table']);
  deq(offeredOf('edit', snapOn('munin', ['Plan it.', { role: 'assistant', content: '1. Insert a table after line 3.' }, T.PLAN_DO_TEXT])), ['table']);
  // an agent's brief counts like the user's message
  deq(offeredOf('edit', snapOn('munin', ['Check the whole document for problems and report them back.'], { agent: { task: 'Check every table cell for units.', access: 'edit' } })), ['table']);
});

test('Munin: the document or the instructions can make the offer (a table, page parts, a Formatting line, the named-styles note)', async () => {
  const ask = 'Fix the typo "recieved" in the Methods, please, and change nothing else in the text.';
  state.docInstructions = ''; state.mainInstructions = '';
  await fresh(); // docSpec: a table
  deq(offeredOf('edit', snapOn('munin', [ask])), ['table']);
  await fresh({ documentId: 'DOC123', title: 'Parts', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Title', style: 'TITLE' }, { p: 'Data come from the survey[^fn.a].' }],
    headers: { 'kix.h1': [{ p: 'Draft header' }] }, footnotes: { 'fn.a': [{ p: ' Survey of 2024.' }] } }] });
  deq(offeredOf('edit', snapOn('munin', [ask])), ['page_parts']);
  assert.match(T.buildTurnContext('edit', snapOn('munin', [ask]), null), /Page parts: header, 1 footnote\./);
  // an empty header alone is no page part: no line, no offer (a message that names a header still gets the tool)
  await fresh({ documentId: 'DOC123', title: 'Parts', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Title', style: 'TITLE' }, { p: 'Body.' }],
    headers: { 'kix.h1': [{ p: '' }] } }] });
  deq(offeredOf('edit', snapOn('munin', [ask])), []);
  deq(offeredOf('edit', snapOn('munin', ['Put the title into the header, please.'])), ['page_parts']);
  assert.doesNotMatch(T.buildTurnContext('edit', snapOn('munin', [ask]), null), /Page parts/);
  await fresh(plain());
  state.docInstructions = 'Formatting: body Georgia 11';
  deq(offeredOf('edit', snapOn('munin', [ask])), ['style_map', 'document_styles']);
  state.docInstructions = ''; state.mainInstructions = 'Formatting: body Georgia 11';
  deq(offeredOf('manual', snapOn('munin', [ask])), ['style_map', 'document_styles']);
  state.mainInstructions = '';
  // the named-styles note of this turn or the one before: the user's "yes" finds document_styles
  const note = { role: 'tool', tool_call_id: 'w1', content: 'Done: replaced line 3.\nNote: the document\'s named styles differ from the formatting sheet (Normal text: Arial 11). Do not change them unasked; …' };
  deq(offeredOf('edit', snapOn('munin', [ask, { role: 'assistant', content: null, tool_calls: [] }, note, { role: 'assistant', content: 'Fixed. Shall I change them too?' }, 'yes'])), ['document_styles']);
  deq(offeredOf('edit', snapOn('munin', [ask, note])), ['document_styles']);
  deq(offeredOf('edit', snapOn('munin', [ask, note, { role: 'assistant', content: 'Fixed.' }, 'ok', { role: 'assistant', content: 'Fine.' }, ask])), []);
});

test('the read-only chat turn and Plan get read-only page_parts, document_styles and delegate; Auto the full definitions', async () => {
  await fresh(plain());
  state.docInstructions = 'Formatting: body Georgia 11';
  const props = (mode, n) => {
    const t = T.toolsFor(mode, snapOn('anthropic', ['Read the header, footer and page setup.'])).find((d) => d.function.name === n);
    return t && t.function.parameters.properties;
  };
  for (const mode of ['manual', 'plan']) {
    deq(props(mode, 'page_parts').action.enum, ['read'], mode);
    deq(Object.keys(props(mode, 'page_parts')), ['action', 'part', 'number'], mode);
    deq(Object.keys(props(mode, 'document_styles')), ['action'], mode);
    deq(props(mode, 'document_styles').action.enum, ['read'], mode);
    assert.ok(!('access' in props(mode, 'delegate')) && !('scope' in props(mode, 'delegate')), mode);
    deq(T.DELEGATE_READ_TOOL.function.parameters.required, ['label', 'task', 'context', 'model', 'search']);
  }
  deq(props('edit', 'page_parts').action.enum, ['read', 'set_text', 'add_footnote', 'delete_footnote', 'section_break', 'section_style']);
  deq(props('edit', 'document_styles').action.enum, ['read', 'apply', 'page']);
  assert.ok('access' in props('edit', 'delegate') && 'scope' in props('edit', 'delegate'));
  // the read-only definitions are strict too (every property required, no additional properties)
  for (const d of [T.PAGE_PARTS_READ_DEF, T.DOCUMENT_STYLES_READ_TOOL, T.DELEGATE_READ_TOOL]) {
    deq(d.function.parameters.required, Object.keys(d.function.parameters.properties), d.function.name);
    assert.strictEqual(d.function.parameters.additionalProperties, false);
  }
  state.docInstructions = '';
});

test('the write refusal of a read-only chat turn (/side, a read agent) and of Plan says what to do there', async () => {
  await fresh(plain());
  const call = (name, args) => ({ id: 'x_' + name, function: { name, arguments: JSON.stringify(args) } });
  const s = snapOn('anthropic', ['Change it.']);
  const m = await T.executeTool(call('replace_text', { old_text: 'Alpha', new_text: 'Beta', line: null }), 'manual', s);
  assert.strictEqual(m.content, 'Error: the document cannot be modified here. Put the complete resulting text in your answer.');
  const p = await T.executeTool(call('replace_text', { old_text: 'Alpha', new_text: 'Beta', line: null }), 'plan', s);
  assert.strictEqual(p.content, 'Error: the document cannot be modified here. Plan mode: add it as a step of the plan.');
  // the action-log row: true in Plan and in a /side question asked while the mode button shows Manual or Auto
  deq([m._message, p._message], ['Editing is not available here', 'Editing is not available here']);
});

test('sticky offers on a provider with a prompt cache: once offered in a chat, comment and find_relevant_sections stay; Munin decides per turn', async () => {
  await fresh(plain());
  const sticky = (prov, msgs) => T.stickyOffer(snapOn(prov, msgs), 'comment', false);
  // the finish hook records the offers of the turn on its user message (never sent)
  const user = { role: 'user', content: 'Reply to the reviewer comments.' };
  const s = snapOn('anthropic', [user]);
  assert.strictEqual(T.stickyOffer(s, 'comment', true), true);
  T.runTurnHooks('finish', user, s, s.chatCtx);
  deq(user._offers, ['comment']);
  assert.strictEqual(sticky('anthropic', [user, { role: 'assistant', content: 'Done.' }, 'Now shorten line 3.']), true);
  assert.strictEqual(sticky('openai', [user, 'Now shorten line 3.']), true);
  assert.strictEqual(sticky('munin', [user, 'Now shorten line 3.']), false);
  assert.strictEqual(sticky('anthropic', ['Now shorten line 3.']), false);
  // never in the request
  const sent = T.buildApiMessages(true, [user], 'S');
  deq(sent[1], { role: 'user', content: 'Reply to the reviewer comments.' });
  // find_relevant_sections: not in a document pass even when it was offered earlier in the chat
  const fr = T.extraTool('find_relevant_sections');
  const marked = { role: 'user', content: 'x', _offers: ['find_relevant_sections'] };
  assert.ok(T.offered(fr, 'edit', snapOn('anthropic', [marked, 'y'])));
  assert.ok(!T.offered(fr, 'review', snapOn('anthropic', [marked, 'y'])));
  assert.ok(!T.offered(fr, 'edit', snapOn('munin', [marked, 'y'])));
});

test('the tool-eval requests keep the tools they need on Munin', async () => {
  await fresh(plain());
  state.docInstructions = ''; state.mainInstructions = '';
  const cases = require('./fixtures/tool-eval-cases.json');
  const list = Array.isArray(cases) ? cases : cases.cases;
  for (const c of list.filter((x) => x.docsApi && x.mode === 'auto')) {
    for (const prompt of c.prompts) {
      const offered = names('edit', snapOn('munin', [prompt]));
      for (const step of (c.expect.order || []).filter((o) => o !== 'write')) {
        assert.ok(step.split('|').some((n) => offered.includes(n)), `${c.id}: ${step} for "${prompt}"`);
      }
    }
  }
});

test('trim_to_words and phrase_usage (src/prose-tools.js): on demand on Munin, always on providers with a prompt cache', async () => {
  await fresh(plain());
  state.docInstructions = ''; state.mainInstructions = '';
  const ask = 'Tighten the Methods section a bit, keeping every number and citation as written.';
  const two = (s) => ['trim_to_words', 'phrase_usage'].filter((n) => names('edit', s).includes(n));
  deq(two(snapOn('munin', [ask])), []);
  for (const prov of ['openai', 'anthropic']) deq(two(snapOn(prov, [ask])), ['trim_to_words', 'phrase_usage'], prov);
  deq(two(snapOn('munin', ['Trim the Methods to 120 words.'])), ['trim_to_words']);
  deq(two(snapOn('munin', ['Is "in good agreement with" an idiomatic phrase?'])), ['phrase_usage']);
  // the read-only chat turn and Plan: phrase_usage only (trim_to_words writes)
  deq(['trim_to_words', 'phrase_usage'].filter((n) => names('manual', snapOn('anthropic', [ask])).includes(n)), ['phrase_usage']);
  deq(['trim_to_words', 'phrase_usage'].filter((n) => names('plan', snapOn('anthropic', [ask])).includes(n)), ['phrase_usage']);
});
