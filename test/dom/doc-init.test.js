'use strict';
// The first-run document instructions on jsdom: the removed paper card's keys are swept at load and the notes for all
// documents of an earlier build become the main instructions. The first message shows the pass's action row under the
// first turn: while the pass runs a reading tool's pending row (the same classes and markup) with the orb and Stop; the
// turn's answer does not wait for it; once done a write row (the same classes as a document write's) whose fold shows
// the written lines and Open DOC.md (the Files panel); stopped or failed one short row. The row survives the turn's
// re-render, a later turn and a reload of the panel; its Stop stops the pass alone.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');
const { docBench, useProvider, muText } = require('../lib/context');
const { sseResponse } = require('../lib/streams');

const DOC = '# Lipid rafts\n\n' + 'We study how lipid rafts organise signalling proteins in T cells. '.repeat(6);
const isPass = (init) => String(init.body).includes('Project note task.');

test('load: the paper card keys are removed, the notes for all documents move to the main instructions; other keys stay', async () => {
  const env = await load({ storage: { 'muninPaperCard:A': { card: {} }, 'muninPaperCard:B': { card: {} }, muninUserInstructions: 'Answer briefly.', 'muninDocInstructions:A': 'Keep.' } });
  await waitFor(() => !('muninPaperCard:A' in env.storage) && !('muninPaperCard:B' in env.storage), 'the sweep');
  await waitFor(() => env.state.mainInstructions === 'Answer briefly.', 'the main instructions loaded');
  assert.ok(!('muninUserInstructions' in env.storage));
  assert.strictEqual(env.storage.muninMainInstructions, 'Answer briefly.');
  assert.strictEqual(env.storage['muninDocInstructions:A'], 'Keep.');
  env.close();
  // main instructions already set: the old notes are dropped, the main ones stay
  const env2 = await load({ storage: { muninUserInstructions: 'Old.', muninMainInstructions: 'New.' } });
  await waitFor(() => !('muninUserInstructions' in env2.storage), 'the sweep');
  assert.strictEqual(env2.storage.muninMainInstructions, 'New.');
  env2.close();
});

// The pass's row element and the rows it is compared with.
const passEl = (el) => el.chat.querySelector('.msg.doc-init-row');
const classes = (n) => [...n.classList].sort();
// A row of a reading call while it runs, and a document write's row once done, drawn by a bubble.
function bubbleRow(T, a) {
  const b = T.addAssistantBubble();
  T.updateAssistantBubble(b, { activity: [a] });
  const row = b.querySelector('.stage-rows > .activity-row');
  b.remove();
  return row;
}
// The provider's fetch: the turn answers "Done." at once, the pass's request is held until release(text) (or fails on
// its signal). Returns the control: { release, aborted }.
function holdPass(env) {
  const ctl = { release: null, aborted: false };
  const docFetch = env.ctx.fetch; // the document export (docBench)
  env.ctx.fetch = async (url, init) => {
    if (!/api\.muninai\.org/.test(url)) return docFetch(url, init);
    if (!isPass(init)) return sseResponse(muText('Done.'));
    return new Promise((res, rej) => {
      ctl.release = (text) => res(sseResponse(muText(text)));
      init.signal.addEventListener('abort', () => { ctl.aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  };
  return ctl;
}
async function firstMessage(opts = {}) {
  const env = await load({ docInit: true, ...opts });
  const { doc } = docBench(env);
  doc.text = DOC;
  await env.T.refreshContext({ force: true });
  useProvider(env, 'munin');
  const ctl = holdPass(env);
  env.el.input.value = 'tighten the abstract';
  await env.T.sendMessage(); // the turn ends with the pass still running
  await waitFor(() => ctl.release, 'the pass request');
  return { env, ctl, T: env.T, state: env.state, el: env.el };
}

test('the first message: the answer does not wait; the pass\'s row is a reading tool\'s pending row with the orb and Stop, under the turn', async () => {
  const { env, T, state, el } = await firstMessage();
  assert.strictEqual(state.busy, false);
  assert.ok([...el.chat.querySelectorAll('.msg.assistant')].some((b) => b.textContent.includes('Done.')), 'the answer is shown');
  await waitFor(() => passEl(el), 'the row after the re-render');
  const d = passEl(el);
  assert.strictEqual(el.chat.lastElementChild, d, 'under the first turn');
  const row = d.querySelector(':scope > .activity-row');
  const read = bubbleRow(T, { log: true, name: 'read_document', summary: 'lines 1–40', args: {}, result: null, status: 'pending' });
  assert.deepStrictEqual([row.tagName, classes(row)], [read.tagName, classes(read)], 'the markup of a running reading call');
  assert.deepStrictEqual(classes(row), ['activity-row', 'log-row', 'pending']);
  assert.strictEqual(row.innerHTML, read.innerHTML.replace('read_document', 'DOC.md').replace('lines 1–40', 'Reading the document'));
  assert.strictEqual(row.textContent, 'DOC.md: Reading the document …');
  assert.ok(d.querySelector(':scope > canvas.orb'), 'the orb');
  assert.strictEqual(d.querySelector(':scope > .row-acts > button.row-act.doc-init-stop').textContent, 'Stop');
  env.close();
});

test('done: a write row whose fold shows the written lines and opens DOC.md in Files; no notice', async () => {
  const { env, ctl, T, el } = await firstMessage();
  // MAIN.md was the last entry open in this panel
  click(el.filesBtn);
  click(el.filesList.querySelector('[data-entry="main"] .file-open'));
  click(el.filesBtn);
  ctl.release('British English.\nKeep the term "lipid raft".');
  await T.docInitRunning().done;
  assert.strictEqual(env.storage['muninDocInstructions:DOC123'], 'British English.\nKeep the term "lipid raft".');
  const d = passEl(el);
  assert.ok(!d.querySelector('canvas') && !d.querySelector('.doc-init-stop'), 'no orb, no Stop');
  const row = d.querySelector(':scope > .activity-row');
  const write = bubbleRow(T, { log: true, name: 'insert_after_line', summary: 'after line 2', args: {}, result: 'ok', status: 'ok',
    write: { message: 'Inserted after line 2', text: 'x', detail: '', editId: null, undone: false } });
  assert.deepStrictEqual([row.tagName, classes(row)], [write.tagName, classes(write)], 'the markup of a done write');
  assert.strictEqual(row.querySelector('summary').textContent, 'DOC.md · Done · 2 lines written; they apply from your next message');
  const body = row.querySelector('details.log-fold > .log-body');
  assert.strictEqual(body.querySelector('.log-what').textContent, 'Added to DOC.md: 2 lines');
  assert.strictEqual(body.querySelector('.log-label').textContent, 'Written lines');
  assert.strictEqual(body.querySelector('pre.log-text').textContent, 'British English.\nKeep the term "lipid raft".');
  assert.ok(!body.textContent.includes('Result ('), 'no tool result');
  assert.ok(![...el.chat.querySelectorAll('.msg.notice')].some((n) => n.textContent.includes('DOC.md')), 'no notice');
  const open = body.querySelector('button.doc-init-open');
  assert.strictEqual(open.textContent, 'Open DOC.md');
  assert.ok(el.files.classList.contains('hidden'));
  click(open);
  assert.ok(!el.files.classList.contains('hidden'));
  assert.strictEqual(el.filesList.querySelector('.file-row.active').dataset.entry, 'document');
  assert.strictEqual(el.instructionsText.value, env.storage['muninDocInstructions:DOC123']);
  env.close();
});

test('the row survives a re-render, a later turn (it stays under the first one) and a reload of the panel', async () => {
  const { env, ctl, T, el } = await firstMessage();
  ctl.release('British English.');
  await T.docInitRunning().done;
  T.renderHistory();
  const d = passEl(el);
  assert.ok(d, 'back after a re-render');
  assert.strictEqual(d.previousElementSibling.classList.contains('assistant'), true, 'right under the first answer');
  el.input.value = 'and the title';
  await T.sendMessage();
  const users = [...el.chat.querySelectorAll('.msg.user')];
  assert.strictEqual(users.length, 2);
  assert.strictEqual(passEl(el).nextElementSibling, users[1], 'before the second message');
  assert.strictEqual(passEl(el).querySelector('summary').textContent, 'DOC.md · Done · 1 line written; they apply from your next message');
  const storage = JSON.parse(JSON.stringify(env.storage));
  env.close();
  const env2 = await load({ storage });
  docBench(env2).doc.text = DOC;
  await env2.T.refreshContext({ force: true });
  await waitFor(() => passEl(env2.el), 'the row after a reload');
  assert.strictEqual(passEl(env2.el).nextElementSibling, env2.el.chat.querySelectorAll('.msg.user')[1]);
  assert.strictEqual(passEl(env2.el).querySelector('summary').textContent, 'DOC.md · Done · 1 line written; they apply from your next message');
  env2.close();
});

test('the row\'s Stop stops the pass alone, with no turn running: a stopped row, no instructions, one attempt', async () => {
  const { env, ctl, state, el } = await firstMessage();
  assert.strictEqual(state.busy, false);
  await waitFor(() => el.chat.querySelector('.doc-init-row button.doc-init-stop'), 'the running row');
  click(el.chat.querySelector('.doc-init-row button.doc-init-stop'));
  await waitFor(() => env.storage['muninDocInit:DOC123'], 'the pass stopped');
  assert.ok(ctl.aborted);
  const d = passEl(el);
  const row = d.querySelector(':scope > .activity-row');
  assert.strictEqual(row.textContent, 'DOC.md: Stopped; nothing written');
  assert.ok(!d.querySelector('canvas') && !d.querySelector('button'), 'no orb, no Stop');
  assert.ok(!('muninDocInstructions:DOC123' in env.storage));
  assert.strictEqual(state.messages.length, 2, 'the chat is untouched');
  env.close();
});

test('a failed pass: a failed row that says why; its fold keeps the whole sentence', async () => {
  const { env, ctl, T, el } = await firstMessage();
  ctl.release('');
  assert.strictEqual(await T.docInitRunning().done, 'failed');
  const row = passEl(el).querySelector(':scope > .activity-row');
  assert.deepStrictEqual([row.tagName, classes(row)], ['DETAILS', ['activity-row', 'fail', 'log-row']], 'a failed call\'s row');
  assert.strictEqual(row.querySelector('summary').textContent, 'DOC.md: not written: the answer was empty · failed');
  assert.ok(row.querySelector('.log-body').textContent.includes('Could not write DOC.md: the answer was empty. The chat goes on.'));
  env.close();
});
