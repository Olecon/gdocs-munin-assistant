'use strict';
// The action row of a round (render.js syncToolGroup, jsdom): a round with two or more calls has its own collapsed row
// "Actions N" (the names "name ×k, …" in its tooltip) that a click (a button: Enter / Space) opens to the round's rows as
// they are; the Undo of the turn's latest edit sits on the action row of the round that made it (Undo all with it); a
// round with one call shows that call's row as its action row; a failed call has no card (its round's dot is red); renderHistory
// keeps the rounds and the open state.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');

let env, T, state, el;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
});
after(() => env.close());

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const shown = (n) => !n.classList.contains('hidden');
const bubbles = () => [...el.chat.querySelectorAll('.msg.assistant')];
const stagesOf = (b) => [...b.querySelectorAll('.activity-rows > .stage')].filter(shown);
const headOf = (s) => s.querySelector(':scope > .stage-head');
const lineOf = (s) => s.querySelector(':scope > .stage-head > .stage-line');
const rowsOf = (s) => s.querySelector(':scope > .stage-rows');

// One turn of two rounds: round 1 reads once; round 2 reads, inserts, replaces (the latest edit) and fails a delete.
function history() {
  const edit = (id, kind, extra) => ({ id, kind, index: 9, text: 'x', restore: '', paras: [], undone: false, ...extra });
  return [
    { role: 'user', content: 'Edit.' },
    { role: 'assistant', content: 'Let me read it first.', tool_calls: [call('g1', 'read_lines', { start: 1, end: 3 })] },
    { role: 'tool', tool_call_id: 'g1', content: 'Lines 1-3', _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [call('g2', 'read_lines', { start: 4, end: 6 }),
      call('g3', 'insert_after_line', { line: 3, text: 'New line' }), call('g4', 'replace_text', { old_text: 'Alpha', new_text: 'Omega' }),
      call('g5', 'delete_lines', { start: 90, end: 91 })] },
    { role: 'tool', tool_call_id: 'g2', content: 'Lines 4-6', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'g3', content: 'Done: inserted.', _ok: true, _message: 'Inserted after line 3', _cardText: 'New line', _edit: edit('g3', 'insert') },
    { role: 'tool', tool_call_id: 'g4', content: 'Done: replaced.', _ok: true, _message: 'Replaced line 1', _edit: edit('g4', 'replace', { text: 'Omega', restore: 'Alpha' }) },
    { role: 'tool', tool_call_id: 'g5', content: 'Error: bad range', _ok: false, _message: 'delete_lines: invalid range' },
    { role: 'assistant', content: 'Done.' },
  ];
}

const G4 = 6; // the index of g4's tool message

test('one action row per round: a one-call round shows its call\'s row; a four-call round "Actions 4", folded; a failed call: no card, the round\'s dot red', () => {
  state.googleConnected = true;
  state.messages = history();
  T.renderHistory();
  const b = bubbles()[0];
  assert.strictEqual(b.querySelector('.tool-group'), null, 'no per-turn group row');
  const [s1, s2] = stagesOf(b);
  assert.strictEqual(stagesOf(b).length, 2);
  // round 1: its one row is the action row, no head
  assert.ok(!shown(headOf(s1)) && shown(rowsOf(s1)));
  assert.deepStrictEqual([...rowsOf(s1).querySelectorAll('.activity-name')].map((x) => x.textContent), ['read_lines']);
  assert.strictEqual(s1.querySelector('.stage-text').textContent, 'Let me read it first.', 'its own text above its action row');
  assert.ok(s1.querySelector('.stage-text').compareDocumentPosition(rowsOf(s1)) & 4, 'written before the call: above its row');
  // round 2: "Actions 4 · failed", the names in the tooltip, the rows folded
  assert.ok(shown(headOf(s2)));
  const line = lineOf(s2);
  assert.strictEqual(line.tagName, 'BUTTON');
  assert.strictEqual(line.textContent, 'Actions 4 · failed'); // the failed delete_lines: its row is folded away
  assert.strictEqual(line.dataset.tip, 'read_lines, insert_after_line, replace_text, delete_lines');
  assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  assert.ok(!shown(rowsOf(s2)), 'collapsed by default');
  assert.strictEqual(rowsOf(s2).querySelectorAll('.activity-row').length, 4); // the rows are there, folded away
  assert.strictEqual(el.chat.querySelector('.tool-card'), null);
  assert.ok(rowsOf(s2).querySelectorAll('.activity-row')[3].classList.contains('fail'));
  assert.ok(s2.classList.contains('tl-fail') && !s1.classList.contains('tl-fail')); // the failed call's round: a red dot
  assert.ok(!/round \d/.test(b.textContent), 'no "round N · K calls" line any more');
});

test('a click on a round\'s action row opens its rows as they are, a second click folds them', async () => {
  const s2 = stagesOf(bubbles()[0])[1];
  const line = lineOf(s2);
  click(line);
  await tick();
  assert.ok(shown(rowsOf(s2)));
  assert.strictEqual(line.getAttribute('aria-expanded'), 'true');
  assert.ok(s2.classList.contains('open'));
  const rows = [...rowsOf(s2).querySelectorAll('.activity-row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.activity-name').textContent), ['read_lines', 'insert_after_line', 'replace_text', 'delete_lines']);
  assert.ok(rows[2].classList.contains('write-row') && rows[2].querySelector('[data-act="undo-edit"]'), 'the row keeps its own Undo');
  click(line);
  await tick();
  assert.ok(!shown(rowsOf(s2)));
});

test('the round\'s action row carries the Undo (and Undo all) of the latest edit; it undoes that edit; "Undone" afterwards', async () => {
  const [s1, s2] = stagesOf(bubbles()[0]);
  assert.strictEqual(s1.querySelector('.row-act'), null, 'a round without the latest edit has no Undo');
  const acts = [...headOf(s2).querySelectorAll(':scope > .row-acts > .row-act')];
  assert.deepStrictEqual(acts.map((x) => [x.dataset.act, x.dataset.edit, x.textContent, x.dataset.tip]),
    [['undo-edit', 'g4', '↶', 'Undo this edit'], ['undo-all', 'g4', '⟲', 'Undo all 2 edits']]);
  const seen = [];
  const prev = env.get('undoFromButton');
  env.ctx.__seenUndo = seen;
  env.run('undoFromButton = (id, btn) => { __seenUndo.push([id, btn.dataset.act]); return Promise.resolve(true); }');
  try {
    click(acts[0]);
    await tick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), [['g4', 'undo-edit']]);
  } finally { env.ctx.__prevUndo = prev; env.run('undoFromButton = __prevUndo'); }
  // after the undo (renderHistory): the round's row says so and offers the Undo of the edit before
  state.messages[G4]._edit.undone = true;
  T.renderHistory();
  const h = headOf(stagesOf(bubbles()[0])[1]);
  assert.strictEqual(h.querySelector('.stage-line').textContent, 'Actions 4 · Undone · failed');
  assert.deepStrictEqual([...h.querySelectorAll('.row-act')].map((x) => [x.dataset.act, x.dataset.edit]), [['undo-edit', 'g3']]);
  state.messages[G4]._edit.undone = false;
});

test('Undo all sits on the last round with an undoable edit; an earlier edited round has none', () => {
  const edit = (id) => ({ id, kind: 'insert', index: 9, text: 'x', restore: '', paras: [], undone: false });
  const ins = (id, line) => call(id, 'insert_after_line', { line, text: 'Line ' + id });
  const done = (id) => ({ role: 'tool', tool_call_id: id, content: 'Done: inserted.', _ok: true, _message: 'Inserted', _cardText: 'Line ' + id, _edit: edit(id) });
  state.messages = [
    { role: 'user', content: 'Edit twice.' },
    { role: 'assistant', content: null, tool_calls: [ins('u1', 1), ins('u2', 2)] }, done('u1'), done('u2'),
    { role: 'assistant', content: null, tool_calls: [ins('u3', 3)] }, done('u3'),
    { role: 'assistant', content: 'Done.' },
  ];
  T.renderHistory();
  const [s1, s2] = stagesOf(bubbles()[0]);
  assert.strictEqual(lineOf(s1).textContent, 'Actions 2');
  assert.strictEqual(headOf(s1).querySelector('.row-act'), null);
  // the last round's action row is its one write row: Undo and Undo all (3) of the turn
  assert.ok(!shown(headOf(s2)));
  assert.deepStrictEqual([...rowsOf(s2).querySelectorAll('.row-act')].map((x) => [x.dataset.act, x.dataset.edit, x.textContent, x.dataset.tip]),
    [['undo-edit', 'u3', '↶', 'Undo this edit'], ['undo-all', 'u3', '⟲', 'Undo all 3 edits']]);
});

test('an undo inside the turn (refreshEditCard) redraws the row and its round\'s action row', () => {
  state.messages = history();
  T.renderHistory();
  state.messages[G4]._edit.undone = true;
  env.run('refreshEditCard("g4")');
  const b = bubbles()[0];
  assert.ok(lineOf(stagesOf(b)[1]).textContent.startsWith('Actions 4 · Undone'));
  assert.ok(b.querySelector('.write-row.undone'));
  state.messages[G4]._edit.undone = false;
});

test('a running turn: the first call\'s row, then "Actions 2" in its place when the round\'s second call starts', () => {
  Object.assign(state, { docText: '# Title\nIntro\n## Methods\nWe measured\nmore\n', docFormat: 'markdown', docModel: null });
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  const pending = (id, name, args) => ({ log: true, id, name, summary: '', args, result: null, status: 'pending' });
  const done = (id, name, args) => ({ ...pending(id, name, args), result: 'ok', status: 'ok' });
  T.updateAssistantBubble(b, { streaming: true, activity: [pending('r1', 'get_outline', {})] });
  const s = stagesOf(b)[0];
  assert.ok(!shown(headOf(s)), 'one call: its row only');
  assert.ok(shown(rowsOf(s)));
  T.updateAssistantBubble(b, { streaming: true, activity: [done('r1', 'get_outline', {}), pending('r2', 'read_lines', { start: 4, end: 5 })] });
  assert.ok(shown(headOf(s)));
  assert.strictEqual(lineOf(s).textContent, 'Actions 2');
  assert.strictEqual(stagesOf(b)[0], s, 'the same item');
  T.updateAssistantBubble(b, { streaming: true, activity: [done('r1', 'get_outline', {}), done('r2', 'read_lines', { start: 4, end: 5 }), pending('r3', 'read_lines', { start: 1, end: 2 })] });
  assert.strictEqual(lineOf(s).textContent, 'Actions 3');
  // a new round: a new item below, the first round's row unchanged
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true, activity: [pending('r4', 'read_lines', { start: 2, end: 3 })] });
  assert.strictEqual(stagesOf(b).length, 2);
  assert.strictEqual(lineOf(s).textContent, 'Actions 3');
  assert.ok(!shown(headOf(stagesOf(b)[1])));
});

test('reload (renderHistory) rebuilds the rounds and keeps a round that was opened', async () => {
  state.messages = history();
  T.renderHistory();
  click(lineOf(stagesOf(bubbles()[0])[1]));
  await tick();
  T.renderHistory();
  let s2 = stagesOf(bubbles()[0])[1];
  assert.ok(shown(rowsOf(s2)), 'still open after the re-render');
  assert.strictEqual(lineOf(s2).getAttribute('aria-expanded'), 'true');
  click(lineOf(s2));
  await tick();
  T.renderHistory();
  s2 = stagesOf(bubbles()[0])[1];
  assert.ok(!shown(rowsOf(s2)), 'closed again');
});
