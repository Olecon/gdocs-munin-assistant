'use strict';
// fill: true on insert_after_line and the insert operation of edit_document writes the text INTO an empty line N: its
// first paragraph takes the line's place (no newline before or after the text), the styles (outline headings, a style,
// the formatting sheet) reach the first paragraph too, the result says "inserted at line N", and undo leaves exactly one
// empty paragraph with its former style. On a line with text it is refused; without fill an empty line (an empty
// document included) is an ordinary anchor, as before.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh, pushTool, lastPost;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const texts = () => fake.text('t.0').split('\n');
const styles = () => fake.styles('t.0');
const snapshot = () => ({ t: texts(), s: styles(), p: fake.pstyles('t.0'), f: fake.fmt('t.0') });
const undo = async () => { const u = pushTool(await exec('undo_last_edit', {})); assert.ok(u._ok, u.content); return u; };
const empty = () => docSpec({ items: [{ p: '' }] });
const ins = (line, text, style, fill) => exec('insert_after_line', { line, text, style, fill });
const OP_NULLS = { old_text: null, new_text: null, line: null, text: null, start: null, end: null, style: null, fill: null };
const op = (name, over) => ({ ...OP_NULLS, op: name, ...over });
const SKELETON = '# Introduction\nWhy it matters.\n## Methods\nHow it was done.';
const BODY = { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 }; // the default sheet's body paragraph

test('fill on an empty document: the outline from line 1, headings on the right lines, the sheet on the first paragraph; undo leaves one empty paragraph', async () => {
  await fresh(empty());
  const before = snapshot();
  deq(before.t, ['']);
  const w = pushTool(await ins(1, SKELETON, 'outline', true));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: inserted at line 1; now lines 1–4; the document has 4 lines.\nHeadings made: lines 1 (h1), 3 (h2).');
  deq(texts(), ['Introduction', 'Why it matters.', 'Methods', 'How it was done.']);
  deq(styles(), ['HEADING_1', 'NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT']);
  // the text goes into the paragraph: no newline before or after it
  const it = lastPost().requests.find((r) => r.insertText).insertText;
  deq([it.location.index, it.text], [1, 'Introduction\nWhy it matters.\nMethods\nHow it was done.']);
  // the default sheet: headings with space above, body justified without spacing, line 1 included
  deq(fake.pstyles('t.0'), [{ spaceAbove: 18, spaceBelow: 0 }, BODY, { spaceAbove: 14, spaceBelow: 0 }, BODY]);
  const j = w._edit;
  deq([j.kind, j.index, j.restore, j.paras.map((p) => [p.nl, p.style])], ['insert', 1, '', [[-1, 'NORMAL_TEXT']]]);
  assert.strictEqual(j.title, 'Inserted at line 1');
  await undo();
  deq(snapshot(), before);
});

test('without fill an empty document keeps its empty first line (the default is unchanged); fill: false and null alike', async () => {
  await fresh(empty());
  const before = snapshot();
  for (const fill of [null, false, 'false']) {
    const w = pushTool(await ins(1, 'Hello.\nWorld.', null, fill));
    assert.strictEqual(w.content, 'Done: inserted after line 1; now lines 2–3; the document has 3 lines.');
    deq(texts(), ['', 'Hello.', 'World.']);
    await undo();
    deq(snapshot(), before);
  }
  // the omitted field (a compact schema) too; line 0 keeps its meaning: the text before the empty line
  let w = pushTool(await exec('insert_after_line', { line: 1, text: 'Hello.' }));
  deq(texts(), ['', 'Hello.']);
  await undo();
  w = pushTool(await ins(0, 'Hello.', null, null));
  assert.strictEqual(w.content, 'Done: inserted at the beginning; the document has 2 lines.');
  deq(texts(), ['Hello.', '']);
  await undo();
  deq(snapshot(), before);
});

test('fill on a blank line inside a document: a style on every new line, the lines after it move; one line needs no "now"; undo restores the blank line with its style', async () => {
  await fresh(docSpec({ items: [{ p: 'Alpha' }, { p: '', style: 'HEADING_2' }, { p: 'Beta' }] }));
  const before = snapshot();
  let w = pushTool(await ins(2, 'One\nTwo\n', 'h1', 'true'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: inserted at line 2; now lines 2–3; the document has 4 lines.');
  deq(texts(), ['Alpha', 'One', 'Two', 'Beta']);
  deq(styles(), ['NORMAL_TEXT', 'HEADING_1', 'HEADING_1', 'NORMAL_TEXT']);
  await undo();
  deq(snapshot(), before);
  w = pushTool(await ins(2, 'Gamma', null, true));
  assert.strictEqual(w.content, 'Done: inserted at line 2; the document has 3 lines.');
  deq(texts(), ['Alpha', 'Gamma', 'Beta']);
  deq(styles(), ['NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(fake.pstyles('t.0')[1], BODY);
  await undo();
  deq(snapshot(), before);
});

test('fill refusals: a line with text, line 0, an invalid value, a heading into an empty list item; a normal fill of an empty list item continues the list', async () => {
  await fresh(docSpec({ items: [{ p: 'Alpha' }, { p: '' }] }));
  const n = fake.log.length;
  let w = await ins(1, 'X', null, true);
  deq([w._ok, w.content], [false, 'Error: line 1 is not empty; fill writes into an empty line only. Leave fill out to insert after line 1']);
  w = await ins(0, 'X', null, true);
  deq([w._ok, w.content], [false, 'Error: fill writes into line N, so line must be from 1 (an empty document: line 1)']);
  w = await ins(2, 'X', null, 'maybe');
  deq([w._ok, w.content], [false, 'Error: fill must be true, false or null; got the string "maybe"']);
  assert.ok(!fake.log.slice(n).some((x) => x.method === 'POST'), 'nothing written');
  await fresh(docSpec({ items: [{ p: 'Alpha' }, { p: '', bullet: { listId: 'kix.l', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } }] }));
  const before = snapshot();
  w = await ins(2, 'Head', 'h2', true);
  assert.strictEqual(w._ok, false);
  assert.match(w.content, /^Error: line 2 is an empty list item; fill writes headings into a line outside a list only/);
  w = pushTool(await ins(2, 'Item one\nItem two', null, true));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Alpha', 'Item one', 'Item two']);
  await undo();
  deq(snapshot(), before);
});

test('edit_document insert with fill: the label, the lines, the other operations\' lines; one undo back to one empty paragraph', async () => {
  await fresh(empty());
  let before = snapshot();
  let w = pushTool(await exec('edit_document', { operations: [op('insert', { line: 1, text: SKELETON, style: 'outline', fill: true })] }));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.startsWith('Done: made 1 edit (line numbers as before this edit): inserted at line 1 (now lines 1–4); the document has 4 lines.'), w.content);
  assert.ok(w.content.includes('Headings made: lines 1 (h1), 3 (h2).'), w.content);
  deq(texts(), ['Introduction', 'Why it matters.', 'Methods', 'How it was done.']);
  deq(styles(), ['HEADING_1', 'NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT']);
  await undo();
  deq(snapshot(), before);
  // with a replace below the filled line: its line moves by the new lines minus the filled one
  await fresh(docSpec({ items: [{ p: 'Alpha' }, { p: '' }, { p: 'Beta' }] }));
  before = snapshot();
  w = pushTool(await exec('edit_document', { operations: [op('insert', { line: 2, text: 'One\nTwo', fill: true }), op('replace', { old_text: 'Beta', new_text: 'Gamma' })] }));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.startsWith('Done: made 2 edits (line numbers as before this edit): inserted at line 2 (now lines 2–3); replaced line 3'), w.content);
  deq(texts(), ['Alpha', 'One', 'Two', 'Gamma']);
  const bad = await exec('edit_document', { operations: [op('insert', { line: 1, text: 'X', fill: true })] });
  deq([bad._ok, bad.content], [false, 'Error: operation 1 (insert after line 1): line 1 is not empty; fill writes into an empty line only. Leave fill out to insert after line 1']);
  await undo();
  deq(snapshot(), before);
});

test('the action-log summary names a fill', () => {
  assert.strictEqual(T.toolCallSummary('insert_after_line', { line: 3, text: 'x', fill: true }), 'into line 3');
  assert.strictEqual(T.toolCallSummary('insert_after_line', { line: 3, text: 'x', fill: null }), 'after line 3');
  assert.strictEqual(T.toolCallSummary('edit_document', { operations: [op('insert', { line: 2, text: 'x', fill: 'true' }), op('insert', { line: 5, text: 'y' })] }), '2 edits (insert into 2, insert after 5)');
});
