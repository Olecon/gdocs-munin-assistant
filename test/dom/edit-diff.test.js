'use strict';
// "What changed" in the action-log row of an applied replacement (render.js writeRow / editDiff + src/word-diff.js,
// jsdom): the row's fold holds the word diff of the call's old and new text (replace_text, replace_all) or of the
// journal's replaced middle (replace_section, replace_selection), escaped; capped; insert and delete rows keep their
// text; failed edits keep their card without a diff; edits without a change get none; Undo stays.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

let env, T, el;
before(async () => { env = await load(); ({ T, el } = env); });
after(() => env.close());

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
// The row of a finished call (as the action log draws it).
const row = (tc, r) => T.activityRow(T.logEntry(tc, r));
const changedLabel = (d) => [...d.querySelectorAll('.log-label')].find((x) => x.textContent === 'What changed') || null;
const ok = (id, extra = {}) => ({ role: 'tool', tool_call_id: id, content: 'Done.', _ok: true, _message: 'Replaced line 4', _cardText: 'x', _cardLabel: 'New text', ...extra });

test('replace_text: "What changed" with the word diff in the folded row, document text escaped', () => {
  el.chat.textContent = '';
  const tc = call('c1', 'replace_text', { old_text: 'if a < b then <i>stop</i>', new_text: 'if a <= b then <i>go</i>' });
  assert.strictEqual(T.toolCardFor(tc, ok('c1')).nodeType, 11); // no card: an empty fragment
  const r = row(tc, ok('c1'));
  const fold = r.querySelector('details.log-fold');
  assert.ok(fold);
  assert.strictEqual(fold.open, false); // the row is one line until clicked
  assert.ok(changedLabel(fold.querySelector('.log-body')));
  const box = fold.querySelector('.log-body .word-diff');
  assert.deepStrictEqual([...box.querySelectorAll('del')].map((d) => d.textContent), ['stop']);
  assert.deepStrictEqual([...box.querySelectorAll('ins')].map((d) => d.textContent), ['=', 'go']);
  assert.strictEqual(box.textContent, 'if a <= b then <i>stopgo</i>'); // shown as text, not markup
  assert.strictEqual(box.querySelector('i'), null);
  assert.ok(!r.innerHTML.includes('>New text<')); // in place of the plain text
});

test('replace_all, replace_section and replace_selection; the cap of long diffs', () => {
  el.chat.textContent = '';
  const all = row(call('c2', 'replace_all', { old_text: 'colour', new_text: 'color' }), ok('c2'));
  assert.strictEqual(all.querySelector('.word-diff').innerHTML, '<del>colour</del><ins>color</ins>');
  const sec = row(call('c3', 'replace_section', { heading: 'Methods', new_text: 'We used X.' }),
    ok('c3', { _edit: { id: 'c3', kind: 'replace', restore: 'used Y', text: 'used X' } }));
  assert.strictEqual(sec.querySelector('.word-diff').innerHTML, 'used <del>Y</del><ins>X</ins>');
  const sel = row(call('c4', 'replace_selection', { text: 'Новый текст' }),
    ok('c4', { _edit: { id: 'c4', kind: 'replace', restore: 'Старый текст', text: 'Новый текст' } }));
  assert.strictEqual(sel.querySelector('.word-diff').innerHTML, '<del>Старый</del><ins>Новый</ins> текст');
  const long = 'word '.repeat(150);
  const big = row(call('c5', 'replace_text', { old_text: long + 'end', new_text: long + 'finish' }), ok('c5'));
  const text = big.querySelector('.word-diff').textContent;
  assert.ok(text.endsWith('…'));
  assert.strictEqual(text.length, 401);
});

test('insert and delete rows keep their text; failures and no-op edits get no diff; Undo stays', () => {
  el.chat.textContent = '';
  const ins = row(call('c6', 'insert_after_line', { line: 2, text: 'New line.' }), ok('c6', { _cardText: 'New line.', _cardLabel: 'Inserted text' }));
  assert.strictEqual(ins.querySelector('.word-diff'), null);
  assert.ok([...ins.querySelectorAll('.log-label')].some((x) => x.textContent === 'Inserted text'));
  assert.strictEqual(ins.querySelector('pre.log-text').textContent, 'New line.');
  const del = row(call('c7', 'delete_lines', { start: 2, end: 2 }), ok('c7', { _cardText: 'Old line.', _cardLabel: 'Deleted text' }));
  assert.strictEqual(del.querySelector('.word-diff'), null);
  assert.strictEqual(del.querySelector('pre.log-text').textContent, 'Old line.');
  const fail = T.toolCardFor(call('c8', 'replace_text', { old_text: 'a', new_text: 'b' }), { role: 'tool', tool_call_id: 'c8', content: 'Error: not found', _ok: false });
  assert.strictEqual(fail.nodeType, 11); // a failure has no card: its failed row
  assert.strictEqual(fail.childNodes.length, 0);
  const failRow = T.activityRow(T.logEntry(call('c8', 'replace_text', { old_text: 'a', new_text: 'b' }), { role: 'tool', tool_call_id: 'c8', content: 'Error: not found', _ok: false }));
  assert.ok(failRow.classList.contains('fail') && !failRow.classList.contains('write-row'));
  assert.strictEqual(failRow.querySelector('.word-diff'), null);
  const same = row(call('c9', 'replace_text', { old_text: 'a', new_text: 'a' }), ok('c9'));
  assert.strictEqual(same.querySelector('.word-diff'), null);
  T.state.googleConnected = true;
  T.state.messages = [{ role: 'tool', tool_call_id: 'c10', _ok: true, _edit: { id: 'c10', kind: 'replace', restore: 'a', text: 'b', undone: false } }];
  const undo = row(call('c10', 'replace_text', { old_text: 'cat', new_text: 'dog' }), ok('c10', { _edit: T.state.messages[0]._edit }));
  assert.ok(undo.querySelector('.word-diff'));
  assert.ok(undo.querySelector('.row-acts button[data-act="undo-edit"]'));
});
