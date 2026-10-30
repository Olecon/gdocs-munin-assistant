'use strict';
// /check's "Replace with the Crossref record" (src/check.js: checkReplaceEntry) on a real DOM with the fake Docs API: a
// Warning entry gets the button, a click rewrites that one line from the Crossref record in the document's style (the
// number kept), recorded in the chat as one undoable edit whose card has Undo; Undo restores the line. Without the Docs
// API (the export) there is no button.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { docsBench } = require('../lib/fake-docs');
require('../lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, chrome, bench;

const ENTRY1 = '[1] Smith J, Lee K. Interfacial activation of bacterial lipases. J Catal. 2019;18:45-58. doi:10.1000/lip';
const ENTRY2 = '[2] Doe A. Soil models of carbon. Soil Journal. 2019;3:1-2.';
const ITEMS = [{ p: 'Lipase paper', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: 'We followed [1] and [2].' },
  { p: 'References', style: 'HEADING_1' }, { p: ENTRY1 }, { p: ENTRY2 }];
const CSL = { title: 'Interfacial activation of bacterial lipases', 'container-title': 'Journal of Catalysis', 'container-title-short': 'J. Catal.',
  volume: '18', issue: '3', page: '45-58', issued: { 'date-parts': [[2020]] }, DOI: '10.1000/lip',
  author: [{ family: 'Smith', given: 'John' }, { family: 'Lee', given: 'Kim' }] };
const NEW1 = '[1] Smith J, Lee K. Interfacial activation of bacterial lipases. Journal of Catalysis. 2020;18(3):45-58. doi:10.1000/lip';

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  bench = docsBench(env, installIdentity(env), ref);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Lipase paper' });
  await T.refreshContext({ force: true });
});
after(() => env.close());

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const network = (url) => {
  const u = String(url);
  if (/api\.crossref\.org\/v1\/works\/10\.1000\/lip/.test(u)) return json(CSL);
  return json({ results: [], message: { items: [] } });
};
const card = () => [...el.chat.querySelectorAll('.msg.check-report')].pop() || null;
const lines = () => fake.text('t.0').split('\n');

async function runCheck() {
  T.renderHistory();
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
}

test('a Warning entry gets the button; a click rewrites only that line, once, as one undoable edit; Undo restores it', async () => {
  await bench.fresh({ documentId: 'DOC123', title: 'Lipase paper', tabs: [{ id: 't.0', title: 'Tab', items: ITEMS }] });
  state.googleConnected = true;
  state.settings.references = true;
  chrome.permissions = { contains: async () => true };
  env.ctx.fetch = bench.routeDocs(network);
  await runCheck();
  const buttons = [...card().querySelectorAll('button.ck-replace')];
  assert.strictEqual(buttons.length, 1); // the Suspect entry has no Crossref record
  assert.strictEqual(buttons[0].textContent, 'Replace with the Crossref record');
  assert.match(buttons[0].closest('.ck-item').textContent, /Warning: \[1\] Smith \(2019\)\. Matches Crossref by DOI, but year 2019 here, 2020 in Crossref\./);
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  const before = posts();
  click(buttons[0]);
  await waitFor(() => !state.busy && card().querySelector('button.ck-replace[disabled]'), 'the replacement');
  assert.strictEqual(posts() - before, 1); // one batchUpdate
  const now = lines();
  assert.strictEqual(now[4], NEW1);
  assert.strictEqual(now[5], ENTRY2);
  assert.strictEqual(card().querySelector('button.ck-replace').textContent, 'Replaced');
  // the chat: the request, the call, its journaled result and a short answer
  const roles = state.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(state.messages[0].content, 'Replace the reference entry [1] Smith (2019) (line 5) with its Crossref record.');
  assert.strictEqual(state.messages[1].tool_calls[0].function.name, 'replace_text');
  const tool = state.messages[2];
  assert.ok(tool._ok && tool._edit && !tool._edit.undone);
  assert.ok(card()); // the report stays below the new edit card
  // the edit card has Undo; Undo restores the entry
  const undo = el.chat.querySelector('button[data-act="undo-edit"]');
  assert.ok(undo, 'the Undo button');
  click(undo);
  await waitFor(() => state.messages[2]._edit.undone && !state.undoing, 'the undo');
  assert.strictEqual(lines()[4], ENTRY1);
  state.settings.references = false;
  state.googleConnected = false;
});

test('the export (no Docs API): no Replace button', async () => {
  const DOC = ['# Lipase paper', '', '## References', '', ENTRY1].join('\n');
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT' ? { ok: true, text: DOC, format: 'markdown', title: 'Lipase paper' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Lipase paper' });
  state.googleConnected = false;
  state.settings.references = true;
  env.ctx.fetch = async (url) => (/docs\.google\.com/.test(String(url)) ? (() => { throw new Error('Failed to fetch'); })() : network(url));
  state.messages = [];
  await runCheck();
  assert.match(card().textContent, /Warning: \[1\] Smith \(2019\)/);
  assert.strictEqual(card().querySelector('button.ck-replace'), null);
  state.settings.references = false;
});
