'use strict';
// "What changed" on the card of an applied replacement (render.js toolCardFor / editDiff + src/word-diff.js, jsdom):
// a folded <details> with the word diff of the call's old and new text (replace_text, replace_all) or of the journal's
// replaced middle (replace_section, replace_selection), escaped; capped; insert and delete cards keep their text fold;
// failed edits and edits without a change get none; Undo stays.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

let env, T, el;
before(async () => { env = await load(); ({ T, el } = env); });
after(() => env.close());

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const ok = (id, extra = {}) => ({ role: 'tool', tool_call_id: id, content: 'Done.', _ok: true, _message: 'Replaced line 4', _cardText: 'x', _cardLabel: 'New text', ...extra });

test('replace_text: a folded "What changed" with the word diff, document text escaped', () => {
  el.chat.textContent = '';
  const card = T.toolCardFor(call('c1', 'replace_text', { old_text: 'if a < b then <i>stop</i>', new_text: 'if a <= b then <i>go</i>' }), ok('c1'));
  const fold = card.querySelector('details.what-changed');
  assert.ok(fold);
  assert.strictEqual(fold.open, false); // folded by default
  assert.strictEqual(fold.querySelector('summary').textContent, 'What changed');
  const box = fold.querySelector('.word-diff');
  assert.deepStrictEqual([...box.querySelectorAll('del')].map((d) => d.textContent), ['stop']);
  assert.deepStrictEqual([...box.querySelectorAll('ins')].map((d) => d.textContent), ['=', 'go']);
  assert.strictEqual(box.textContent, 'if a <= b then <i>stopgo</i>'); // shown as text, not markup
  assert.strictEqual(box.querySelector('i'), null);
  assert.ok(!card.innerHTML.includes('<summary>New text</summary>')); // in place of the plain text fold
});

test('replace_all, replace_section and replace_selection; the cap of long diffs', () => {
  el.chat.textContent = '';
  const all = T.toolCardFor(call('c2', 'replace_all', { old_text: 'colour', new_text: 'color' }), ok('c2'));
  assert.strictEqual(all.querySelector('.word-diff').innerHTML, '<del>colour</del><ins>color</ins>');
  const sec = T.toolCardFor(call('c3', 'replace_section', { heading: 'Methods', new_text: 'We used X.' }),
    ok('c3', { _edit: { id: 'c3', kind: 'replace', restore: 'used Y', text: 'used X' } }));
  assert.strictEqual(sec.querySelector('.word-diff').innerHTML, 'used <del>Y</del><ins>X</ins>');
  const sel = T.toolCardFor(call('c4', 'replace_selection', { text: 'Новый текст' }),
    ok('c4', { _edit: { id: 'c4', kind: 'replace', restore: 'Старый текст', text: 'Новый текст' } }));
  assert.strictEqual(sel.querySelector('.word-diff').innerHTML, '<del>Старый</del><ins>Новый</ins> текст');
  const long = 'word '.repeat(150);
  const big = T.toolCardFor(call('c5', 'replace_text', { old_text: long + 'end', new_text: long + 'finish' }), ok('c5'));
  const text = big.querySelector('.word-diff').textContent;
  assert.ok(text.endsWith('…'));
  assert.strictEqual(text.length, 401);
});

test('insert and delete cards keep their text; failures and no-op edits get no diff; Undo stays', () => {
  el.chat.textContent = '';
  const ins = T.toolCardFor(call('c6', 'insert_after_line', { line: 2, text: 'New line.' }), ok('c6', { _cardText: 'New line.', _cardLabel: 'Inserted text' }));
  assert.strictEqual(ins.querySelector('.what-changed'), null);
  assert.strictEqual(ins.querySelector('details > summary').textContent, 'Inserted text');
  const del = T.toolCardFor(call('c7', 'delete_lines', { start: 2, end: 2 }), ok('c7', { _cardText: 'Old line.', _cardLabel: 'Deleted text' }));
  assert.strictEqual(del.querySelector('.what-changed'), null);
  assert.strictEqual(del.querySelector('pre').textContent, 'Old line.');
  const fail = T.toolCardFor(call('c8', 'replace_text', { old_text: 'a', new_text: 'b' }), { role: 'tool', tool_call_id: 'c8', content: 'Error: not found', _ok: false });
  assert.strictEqual(fail.querySelector('.what-changed'), null);
  const same = T.toolCardFor(call('c9', 'replace_text', { old_text: 'a', new_text: 'a' }), ok('c9'));
  assert.strictEqual(same.querySelector('.what-changed'), null);
  T.state.googleConnected = true;
  T.state.messages = [{ role: 'tool', tool_call_id: 'c10', _ok: true, _edit: { id: 'c10', kind: 'replace', restore: 'a', text: 'b', undone: false } }];
  const undo = T.toolCardFor(call('c10', 'replace_text', { old_text: 'cat', new_text: 'dog' }), ok('c10', { _edit: T.state.messages[0]._edit }));
  assert.ok(undo.querySelector('.what-changed'));
  assert.ok(undo.querySelector('button[data-act="undo-edit"]'));
});
