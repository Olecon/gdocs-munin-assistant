'use strict';
// /polish (src/polish.js) on a real DOM with the fake Docs API and a fake provider: the report card with its two groups
// ("Mechanical", "Suggested by the model") in paragraph order, one quiet request per paragraph (no tools, the writing
// rules), a fix that changes the meaning dropped and counted, Apply on a model fix and on a mechanical swap through the
// shared write path of the /check card (one edit_document call, recorded in the chat as one undoable edit), the other
// fixes of a line kept usable after an Apply, a line changed since the report refused, the error for a missing heading.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { sseResponse, textRound } = require('../lib/streams');
const { docsBench } = require('../lib/fake-docs');
require('../lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, chrome, bench;

const P1 = 'In order to stain the cells, we used Laurdan at 5 µM for thirty minutes.';
const P2 = 'The stained cells were imaged on a confocal microscope in a dark room.';
const P2_FIX = 'We imaged the stained cells on a confocal microscope in a dark room.';
const P3 = 'Membrane order rose by 12% in the treated cells compared with the controls.';
const ITEMS = [{ p: 'Order paper', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: P1 }, { p: P2 }, { p: 'Results', style: 'HEADING_1' }, { p: P3 }];
const ANSWERS = [
  '[]',
  JSON.stringify([{ quote: P2, replacement: P2_FIX, why: 'active voice' },
    { quote: 'in a dark room', replacement: 'in no dark room', why: 'x' }]), // a negation: dropped
  '```json\n[]\n```',
];

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  bench = docsBench(env, installIdentity(env), ref);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'Order paper' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-T' });
});
after(() => env.close());

const card = () => [...el.chat.querySelectorAll('.msg.polish-report')].pop() || null;
const group = (id) => card().querySelector(`.ck-group[data-group="${id}"]`);
const lines = () => fake.text('t.0').split('\n');
let bodies = [];
async function runPolish(text = '/polish') {
  await bench.fresh({ documentId: 'DOC123', title: 'Order paper', tabs: [{ id: 't.0', title: 'Tab', items: ITEMS }] });
  state.googleConnected = true;
  bodies = [];
  env.ctx.fetch = bench.routeDocs(async (url, init) => {
    if (!String(url).includes('anthropic')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    bodies.push(JSON.parse(init.body));
    return sseResponse(textRound(ANSWERS[bodies.length - 1] || '[]'));
  });
  state.messages = [];
  T.renderHistory();
  el.input.value = text;
  await T.sendMessage();
  await waitFor(() => !state.busy && (card() || /Polish:/.test(el.chat.textContent)), 'the report');
}

test('/polish: two groups in paragraph order; the model\'s fix with Apply, the drifting one dropped; Apply writes through the card path', async () => {
  await runPolish();
  // one quiet request per paragraph: no tools, the writing rules, the paragraph
  assert.strictEqual(bodies.length, 3);
  for (const b of bodies) assert.ok(!b.tools && b.messages.length === 1 && JSON.stringify(b.system).includes('W1. Write like this document'));
  assert.ok(JSON.stringify(bodies[0].system).startsWith(JSON.stringify(T.POLISH_HEAD).slice(0, 40)));
  assert.ok(bodies[1].messages[0].content.endsWith(`Paragraph:\n${P2}`), bodies[1].messages[0].content);
  assert.match(card().querySelector('.ck-head').textContent, /^Polish · .+ · «Order paper» · the whole document$/);
  const mech = group('mechanical');
  assert.match(mech.querySelector('.ck-group-head').textContent, /^Mechanical/);
  const wordy = [...mech.querySelectorAll('.ck-item')].find((i) => i.textContent.includes('«In order to» → «to».'));
  assert.ok(wordy && wordy.querySelector('button.ck-apply'), mech.textContent);
  const model = group('model');
  assert.match(model.querySelector('.ck-group-head').textContent, /^Suggested by the model/);
  const items = [...model.querySelectorAll('.ck-item')].map((i) => i.textContent.trim());
  assert.ok(items.some((t) => t.includes(`«${P2}» → «${P2_FIX}» (active voice)`)), items.join('\n'));
  assert.ok(items.includes('1 fix dropped: it changed the meaning.'), items.join('\n'));
  assert.match(card().querySelector('.ck-summary').textContent, /mechanical findings?, 1 suggested fix$/);
  // Apply the model's fix: one batchUpdate, the exchange in the chat with an undoable edit
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  let before = posts();
  click([...group('model').querySelectorAll('.ck-item')].find((i) => i.textContent.includes('active voice')).querySelector('button.ck-apply'));
  await waitFor(() => !state.busy && group('model').querySelector('button.ck-apply[disabled]'), 'the fix');
  assert.strictEqual(posts() - before, 1);
  assert.strictEqual(lines()[3], P2_FIX);
  deq(state.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(state.messages[0].content.startsWith('Apply the /polish fix on line 4: «'), state.messages[0].content);
  assert.strictEqual(state.messages[1].tool_calls[0].function.name, 'edit_document');
  assert.strictEqual(state.messages[3].content, 'Applied the /polish fix on line 4 (1 change).');
  assert.ok(state.messages[2]._ok && state.messages[2]._edit);
  // the mechanical swap on line 3
  before = posts();
  const wordyNow = () => [...group('mechanical').querySelectorAll('.ck-item')].find((i) => i.textContent.includes('«In order to» → «to».'));
  click(wordyNow().querySelector('button.ck-apply'));
  await waitFor(() => !state.busy && wordyNow().querySelector('button.ck-apply[disabled]'), 'the swap');
  assert.strictEqual(posts() - before, 1);
  assert.strictEqual(lines()[2], 'To stain the cells, we used Laurdan at 5 µM for thirty minutes.');
  assert.strictEqual(wordyNow().querySelector('button.ck-apply').textContent, 'Applied');
  assert.ok(el.chat.querySelector('button[data-act="undo-edit"]'), 'the Undo button');
});

test('/polish: a named section limits the scope; a missing heading says what to do; a line changed since the report is refused', async () => {
  await runPolish('/polish results');
  assert.strictEqual(bodies.length, 1);
  assert.match(card().querySelector('.ck-head').textContent, /«Results»$/);
  await runPolish('/polish Discussion');
  assert.match(el.chat.textContent, /Polish: No heading reads «Discussion»\. Name a heading as the document shows it, or select the text, then run \/polish again\./);
  // the document changes behind the report: Apply refuses with what to do
  await runPolish();
  await bench.fresh({ documentId: 'DOC123', title: 'Order paper', tabs: [{ id: 't.0', title: 'Tab', items: [ITEMS[0], ITEMS[1], { p: 'Changed meanwhile.' }, ...ITEMS.slice(3)] }] });
  state.googleConnected = true;
  const wordy = [...group('mechanical').querySelectorAll('.ck-item')].find((i) => i.textContent.includes('«In order to»'));
  click(wordy.querySelector('button.ck-apply'));
  await waitFor(() => !state.busy && /Apply: Line 3 changed since the check\. Run \/polish again\./.test(el.chat.textContent), 'the refusal');
  state.googleConnected = false;
});

function deq(a, b) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b); }
