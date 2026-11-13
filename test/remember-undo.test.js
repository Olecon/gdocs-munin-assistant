'use strict';
// remember in the undo journal: every successful call journals one entry (kind 'remember') whose undo is its inverse on
// MAIN.md or DOC.md as stored now (add -> the line removed, remove -> the line back at its place, replace -> the old
// text back), verified by reading the file again; undone in order with the document edits by undo_last_edit, the Undo
// button and Undo all; refused when the line is no longer there; the row's fold says what an undo does.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { ORIGINAL, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, storage, fresh, exec, pushTool;
const DOC = 'muninDocInstructions:DOC123';
const MAIN = 'muninMainInstructions';

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'PING' ? { ok: true, title: 'My Doc' } : { ok: true });
});

// A fresh document and chat with one answer that made the given calls ([tool, args] in order), saved (an undo starts
// from the stored history). doc / main: DOC.md and MAIN.md before it. Returns the ids, oldest first.
async function answer(calls, { doc = '', main = '' } = {}) {
  for (const id of [...T.pendingPreviews.keys()]) T.decidePreview(id, 'reject');
  await fresh();
  await T.createChat();
  if (doc) storage[DOC] = doc; else delete storage[DOC];
  if (main) storage[MAIN] = main; else delete storage[MAIN];
  state.docInstructions = doc; state.mainInstructions = main;
  state.messages = [{ role: 'user', content: 'Do it' }];
  const ids = [];
  for (const [i, [name, args]] of calls.entries()) {
    const id = 'e' + i;
    state.messages.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const r = pushTool({ role: 'tool', tool_call_id: id, ...(await exec(name, args, id)) });
    assert.ok(r._ok, r.content);
    ids.push(id);
  }
  await T.saveHistory();
  return ids;
}
const rem = (action, text, extra = {}) => ['remember', { scope: 'document', action, text, old: null, ...extra }];
const resultOf = (id) => state.messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
const tc = (id) => state.messages.flatMap((m) => m.tool_calls || []).find((c) => c.id === id);
const undoTool = () => exec('undo_last_edit', {}, 'u' + Math.random().toString(36).slice(2, 6));

test('each change journals one entry; undo_last_edit takes back add, remove and replace in both files', async () => {
  // add: the line is removed again
  let [id] = await answer([rem('add', 'Use SI units.')], { doc: 'Mine.' });
  assert.strictEqual(storage[DOC], 'Mine.\nUse SI units.');
  deq([resultOf(id)._edit.kind, resultOf(id)._edit.id], ['remember', id]);
  assert.strictEqual(T.latestUndoable(), resultOf(id));
  let u = await undoTool();
  assert.ok(u._ok, u.content);
  assert.strictEqual(u.content, 'Done: undid remember: removed «Use SI units.» from DOC.md. The document is unchanged; the instructions apply from the next message.');
  assert.strictEqual(storage[DOC], 'Mine.');
  assert.strictEqual(state.docInstructions, 'Mine.', 'the panel follows');
  assert.ok(resultOf(id)._edit.undone);
  // remove: the line goes back at its place
  [id] = await answer([rem('remove', 'Two.')], { doc: 'One.\nTwo.\nThree.' });
  assert.strictEqual(storage[DOC], 'One.\nThree.');
  u = await undoTool();
  assert.ok(u._ok, u.content);
  assert.strictEqual(storage[DOC], 'One.\nTwo.\nThree.');
  // replace in MAIN.md: the old text back
  [id] = await answer([['remember', { scope: 'main', action: 'replace', text: 'US spelling.', old: 'British spelling.' }]], { main: 'Short answers.\nBritish spelling.' });
  assert.strictEqual(storage[MAIN], 'Short answers.\nUS spelling.');
  u = await undoTool();
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: undid remember: changed «US spelling.» in MAIN.md back to «British spelling.».'), u.content);
  assert.strictEqual(storage[MAIN], 'Short answers.\nBritish spelling.');
  assert.strictEqual(state.mainInstructions, 'Short answers.\nBritish spelling.');
  // nothing left
  assert.strictEqual(T.latestUndoable(), null);
});

test('the Undo button undoes a remember; refused when the line was changed meanwhile (the entry stays undoable)', async () => {
  let [id] = await answer([rem('add', 'Use SI units.')], { doc: 'Mine.' });
  assert.strictEqual(await T.undoFromButton(id, null), true);
  assert.strictEqual(storage[DOC], 'Mine.');
  assert.ok(resultOf(id)._edit.undone);
  assert.ok(resultOf(id).content.endsWith('[Later the user undid this edit with the Undo button.]'));
  // the user edits the line by hand in Files: the undo is refused, nothing is written
  [id] = await answer([rem('add', 'Use SI units.')], { doc: 'Mine.' });
  storage[DOC] = 'Mine.\nUse SI units where possible.';
  const u = await undoTool();
  assert.ok(!u._ok);
  assert.ok(u.content.includes('the line «Use SI units.» is no longer in DOC.md (it was changed meanwhile), so there is nothing to undo.'), u.content);
  assert.strictEqual(storage[DOC], 'Mine.\nUse SI units where possible.');
  assert.ok(!resultOf(id)._edit.undone);
  assert.strictEqual(await T.undoFromButton(id, null), false);
  assert.strictEqual(storage[DOC], 'Mine.\nUse SI units where possible.');
  // a removed line that is back already: refused too
  [id] = await answer([rem('remove', 'Two.')], { doc: 'One.\nTwo.' });
  storage[DOC] = 'One.\nTwo.';
  assert.ok(!(await undoTool())._ok);
});

test('Undo all after a format write and a remember takes back both, newest first; the dry run checks the file', async () => {
  const ids = await answer([
    ['format_text', { old_text: 'beta gamma', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null }],
    rem('add', 'Highlight the key terms.'),
  ], { doc: 'Mine.' });
  assert.strictEqual(storage[DOC], 'Mine.\nHighlight the key terms.');
  deq(T.answerEdits(ids[1]).map((m) => m._edit.id), [ids[1], ids[0]]);
  const p = T.undoAllFromButton(ids[1], null);
  await waitFor(() => T.pendingPreviews.size === 1, 'the Undo all card');
  const [[cid, pv]] = [...T.pendingPreviews.entries()];
  assert.ok(pv.card.innerHTML.includes('Undo all 2 edits of this answer?'), pv.card.innerHTML);
  assert.ok(pv.card.innerHTML.includes('Added to DOC.md: «Highlight the key terms.»'));
  T.decidePreview(cid, 'accept');
  assert.strictEqual(await p, true);
  assert.strictEqual(storage[DOC], 'Mine.');
  assert.ok(resultOf(ids[0])._edit.undone && resultOf(ids[1])._edit.undone);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  // the dry run sees a remember that cannot be undone: blocked, nothing applied
  const again = await answer([
    ['format_text', { old_text: 'beta gamma', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null }],
    rem('add', 'Highlight the key terms.'),
  ], { doc: 'Mine.' });
  storage[DOC] = 'Mine.';
  const q = T.undoAllFromButton(again[1], null);
  await waitFor(() => T.pendingPreviews.size === 1, 'the Undo all card');
  const [[cid2, pv2]] = [...T.pendingPreviews.entries()];
  assert.ok(pv2.card.innerHTML.includes('is no longer in DOC.md'), pv2.card.innerHTML);
  T.decidePreview(cid2, 'reject');
  assert.strictEqual(await q, false);
  assert.ok(!resultOf(again[0])._edit.undone);
});

test('the row: Undo like any write\'s (no Revert), its fold says what an undo does; undone, the row says so', async () => {
  const [id] = await answer([rem('add', 'Use SI units.')], { doc: 'Mine.' });
  const w = T.writeRowInfo(tc(id), resultOf(id));
  deq([w.editId, w.undone, w.undoText], [id, false, 'Undo removes «Use SI units.» from DOC.md.']);
  const row = T.activityRow(T.logEntry(tc(id), resultOf(id)));
  assert.ok(row.innerHTML.includes('<div class="log-detail log-undo">Undo removes «Use SI units.» from DOC.md.</div>'), row.innerHTML);
  assert.ok(row.innerHTML.includes('data-act="undo-edit"') && !row.innerHTML.includes('revert'), 'the Undo arrow, no Revert');
  deq(T.writeRowInfo(tc(id), { ...resultOf(id), _edit: { ...resultOf(id)._edit, action: 'remove' } }).undoText, 'Undo puts «Use SI units.» back into DOC.md.');
  assert.strictEqual(await T.undoFromButton(id, null), true);
  const after = T.activityRow(T.logEntry(tc(id), resultOf(id)));
  assert.ok(after.innerHTML.includes('<span class="log-status">Undone</span>') && !after.innerHTML.includes('log-undo'), after.innerHTML);
});
