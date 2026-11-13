'use strict';
// /check's Apply (src/check.js: checkApplyFix) on a real DOM with the fake Docs API: a consistency finding of
// doc-checks.js shows its rule id in its fold and has Apply; a click rewrites the minority forms in one edit_document
// call (one batchUpdate), recorded in the chat as one undoable edit whose card has Undo; Undo restores the lines. A
// line changed since the check is refused with what to do. Without the Docs API (the export) there is no Apply.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { docsBench } = require('../lib/fake-docs');
require('../lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, chrome, bench;

const L3 = 'The colour of the centre and the behaviour were high.';
const L4 = 'The color and the color differ.';
const L5 = 'A color here.';
const ITEMS = [{ p: 'Colour paper', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: L3 }, { p: L4 }, { p: L5 }];

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  bench = docsBench(env, installIdentity(env), ref);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Colour paper' });
  await T.refreshContext({ force: true });
});
after(() => env.close());

const card = () => [...el.chat.querySelectorAll('.msg.check-report')].pop() || null;
const lines = () => fake.text('t.0').split('\n');
const consistencyItem = () => card().querySelector('.ck-group[data-group="consistency"] .ck-item');

async function runCheck() {
  T.renderHistory();
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
}

test('Apply unifies the minority spelling in one batch, as one undoable edit; the fold names the rule; Undo restores', async () => {
  await bench.fresh({ documentId: 'DOC123', title: 'Colour paper', tabs: [{ id: 't.0', title: 'Tab', items: ITEMS }] });
  state.googleConnected = true;
  env.ctx.fetch = bench.routeDocs(() => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  state.messages = [];
  await runCheck();
  const item = consistencyItem();
  // the title block does not count; a tie goes to the form used first
  assert.match(item.textContent, /UK and US spelling: UK 3 times, US 3 times; unify to UK \(lines 4, 5\)\./);
  // the fold: the occurrences and the rule id
  assert.strictEqual(item.querySelector('.ck-fold'), null);
  click(item.querySelector('button.ck-fold-toggle'));
  const fold = consistencyItem().querySelector('.ck-fold');
  assert.ok(fold);
  assert.match(fold.textContent, /line 4: color → colour/);
  assert.match(fold.textContent, /Rule: variant-spelling/);
  const apply = consistencyItem().querySelector('button.ck-apply');
  assert.strictEqual(apply.textContent, 'Apply');
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  const before = posts();
  click(apply);
  await waitFor(() => !state.busy && consistencyItem().querySelector('button.ck-apply[disabled]'), 'the fix');
  assert.strictEqual(posts() - before, 1); // one batchUpdate
  const now = lines();
  assert.strictEqual(now[2], L3);
  assert.strictEqual(now[3], 'The colour and the colour differ.');
  assert.strictEqual(now[4], 'A colour here.');
  assert.strictEqual(consistencyItem().querySelector('button.ck-apply').textContent, 'Applied');
  deq(state.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(state.messages[0].content, 'Unify the spelling to UK on lines 4, 5 (variant-spelling, from the /check report).');
  assert.strictEqual(state.messages[1].tool_calls[0].function.name, 'edit_document');
  assert.strictEqual(state.messages[3].content, 'Unified the spelling to UK: 3 changes on lines 4, 5.');
  assert.ok(state.messages[2]._ok && state.messages[2]._edit);
  const undo = el.chat.querySelector('button[data-act="undo-edit"]');
  assert.ok(undo, 'the Undo button');
  click(undo);
  await waitFor(() => state.messages[2]._edit.undone && !state.undoing, 'the undo');
  assert.strictEqual(lines()[3], L4);
  assert.strictEqual(lines()[4], L5);
});

test('a line changed since the check: Apply refuses and says to run /check again; nothing is written', async () => {
  await bench.fresh({ documentId: 'DOC123', title: 'Colour paper', tabs: [{ id: 't.0', title: 'Tab', items: ITEMS }] });
  state.messages = [];
  await runCheck();
  // the document changes behind the report
  await bench.fresh({ documentId: 'DOC123', title: 'Colour paper', tabs: [{ id: 't.0', title: 'Tab', items: [...ITEMS.slice(0, 4), { p: 'A color there.' }] }] });
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  const before = posts();
  click(consistencyItem().querySelector('button.ck-apply'));
  await waitFor(() => !state.busy && /Apply: Line 5 changed since the check\. Run \/check again\./.test(el.chat.textContent), 'the refusal');
  assert.strictEqual(posts() - before, 0);
  assert.strictEqual(consistencyItem().querySelector('button.ck-apply').disabled, false);
  state.googleConnected = false;
});

test('the export (no Docs API): no Apply button, the fold still names the rule', async () => {
  const DOC = ['# Colour paper', '', '## Methods', '', L3, '', L4, '', L5].join('\n');
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT' ? { ok: true, text: DOC, format: 'markdown', title: 'Colour paper' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Colour paper' });
  state.googleConnected = false;
  env.ctx.fetch = async (url) => { if (/docs\.google\.com/.test(String(url))) throw new Error('Failed to fetch'); return { ok: false, status: 404 }; };
  state.messages = [];
  await runCheck();
  assert.match(consistencyItem().textContent, /UK and US spelling/);
  assert.strictEqual(consistencyItem().querySelector('button.ck-apply'), null);
});

function deq(a, b) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b); }
