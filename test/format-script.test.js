'use strict';
// format_text script (superscript / subscript, the Docs API's baselineOffset): the request and its field mask, the
// reading notation ({1}(script=super)), the re-read check, the no-op and repeat guard, the reset, undo, the edit_document
// operation, and the writing checks: a digit that only gets this formatting is no dropped number (the text does not
// change, so neither the number-drop check nor provenance sees it).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  const env = await load();
  T = env.T;
  state = env.state;
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, installIdentity(env), ref));
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// 1 title, 2 the authors with their affiliation digits, 3–4 the affiliations, 5 a formula.
const SPEC = () => docSpec({ items: [
  { p: 'Spin labels', style: 'TITLE' }, { p: 'Anna Example1, Ben Sample2' }, { p: '1 Department of Chemistry' },
  { p: '2 Institute of Physics' }, { p: 'H2O at 10 mM' },
] });
const NONE = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, script: null, link: null };
const fmtCall = (old_text, line, props, id, same) => exec('format_text', { old_text, line, all: null, ...NONE, ...props }, id, same);
const RF = (n) => T.runReadingTool('read_formatting', { start: n, end: n }, as);
const style = () => lastPost().requests[0].updateTextStyle;
const rng = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const at = (line, off) => as.model.lines[line - 1].start + off;

test('format_text script: superscript sent as baselineOffset, shown as script=super, verified, a repeat is caught, undone', async () => {
  await fresh(SPEC());
  let w = pushTool(await fmtCall('1', 3, { script: 'super' }, 's1'));
  assert.ok(w._ok, w.content);
  deq(style(), { range: rng(at(3, 0), at(3, 1)), textStyle: { baselineOffset: 'SUPERSCRIPT' }, fields: 'baselineOffset' });
  // the re-read shows it: no "did not apply" note
  assert.ok(w.content.startsWith('Done: formatted line 3 (script super); the document has 5 lines.') && !/did not apply/.test(w.content), w.content);
  deq(fake.fmt('t.0')[2], [[0, 1, { script: 'super' }]]);
  assert.ok(RF(3).endsWith('\n3: {1}(script=super) Department of Chemistry'), RF(3));
  assert.strictEqual(as.model.lines[2].runs[0].script, 'super');
  // the same call again in the turn (also as "superscript"): "Already done"; in a new turn: "No change"
  for (const script of ['super', 'superscript']) {
    w = await fmtCall('1', 3, { script }, 's2', true);
    assert.strictEqual(w.content, 'Already done in this message: line 3 now reads: {1}(script=super) Department of Chemistry\nDo not call format_text again for this.');
  }
  const turn2 = T.takeSnapshot(); T.snapshotDocument(turn2);
  w = await T.executeTool({ id: 's3', function: { name: 'format_text', arguments: JSON.stringify({ old_text: '1', line: 3, ...NONE, script: 'super' }) } }, 'edit', turn2);
  assert.ok(w._ok && !w._edit && w.content.startsWith('No change: «1» on line 3 is already superscript.'), w.content);
  // the undo puts the digit back on the baseline
  deq(state.messages[0]._edit.requests, [{ updateTextStyle: { range: rng(at(3, 0), at(3, 1)), textStyle: {}, fields: 'baselineOffset' } }]);
  assert.ok((await exec('undo_last_edit', {}, 'su'))._ok);
  deq(fake.fmt('t.0')[2], []);
});

test('format_text script: subscript, "none" removes it (a reset), loose words; bad values are refused', async () => {
  await fresh(SPEC());
  let w = pushTool(await fmtCall('2', 5, { script: 'sub' }, 'b1'));
  assert.ok(w._ok, w.content);
  deq(style().textStyle, { baselineOffset: 'SUBSCRIPT' });
  assert.ok(RF(5).endsWith('\n5: H{2}(script=sub)O at 10 mM'), RF(5));
  w = pushTool(await fmtCall('2', 5, { script: 'none' }, 'b2'));
  assert.ok(w._ok && w.content.startsWith('Done: formatted line 5 (script removed);'), w.content);
  deq(style(), { range: rng(at(5, 1), at(5, 2)), textStyle: {}, fields: 'baselineOffset' });
  deq(fake.fmt('t.0')[4], []);
  // its undo makes it a subscript again
  deq(w._edit.requests, [{ updateTextStyle: { range: rng(at(5, 1), at(5, 2)), textStyle: { baselineOffset: 'SUBSCRIPT' }, fields: 'baselineOffset' } }]);
  // "baseline" is the same reset (so the call is a repeat); with nothing to remove it is a no-op
  w = await fmtCall('2', 5, { script: 'baseline' });
  assert.ok(w._ok && w.content.startsWith('Already done in this message: line 5 now reads: H2O at 10 mM'), w.content);
  w = await fmtCall('10', 5, { script: 'none' });
  assert.ok(w._ok && w.content.startsWith('No change: «10» on line 5 is already on the baseline.'), w.content);
  w = await fmtCall('2', 5, { script: 'up' });
  deq([w._ok, w.content], [false, 'Error: script must be "super", "sub" or "none"; got the string "up"']);
  // the action log names it as sent
  assert.strictEqual(T.toolCallSummary('format_text', { old_text: '2', ...NONE, script: 'sub' }), '"2" (script sub)');
});

test('edit_document: superscript affiliation digits in one batch with a replace; no number counts as dropped, nothing is refused', async () => {
  await fresh(SPEC());
  const F = (old_text, line) => ({ op: 'format_text', old_text, line, all: null, ...NONE, script: 'super' });
  const ops = [F('1', 2), F('2', 2), F('1', 3), F('2', 4), { op: 'replace', old_text: 'at 10 mM', new_text: 'at 10 mM in water', line: 5 }];
  // the writing checks see the replaced text only: the formatted digits are neither lost nor new
  const only = { operations: [F('1', 3)] };
  const plan = T.planEditDocument(as.model, only);
  deq([plan.batchTexts.oldText, plan.batchTexts.newText, plan.batchTexts.pairs], ['', '', []]);
  deq([T.proseCheck('edit_document', plan, only, as), T.provenanceCheck('edit_document', plan, only, as)], [null, null]);
  deq([T.proseCheck('format_text', null, { old_text: '1', script: 'super' }, as), T.provenanceCheck('format_text', null, { old_text: '1', script: 'super' }, as)], [null, null]);
  const w = await exec('edit_document', { operations: ops });
  assert.ok(w._ok && !/Refused|did not apply/.test(w.content), w.content);
  assert.ok(RF(2).endsWith('\n2: Anna Example{1}(script=super), Ben Sample{2}(script=super)'), RF(2));
  deq([fake.fmt('t.0')[2], fake.fmt('t.0')[3]], [[[0, 1, { script: 'super' }]], [[0, 1, { script: 'super' }]]]);
});

test('format_text script: the schema offers it on format_text and the edit_document operation, as one short enum', () => {
  const enumOf = (p) => p.anyOf[0].enum;
  deq(enumOf(T.TOOL_DEFS.format_text.function.parameters.properties.script), ['super', 'sub', 'none']);
  const op = T.TOOL_DEFS.edit_document.function.parameters.properties.operations.items.anyOf.find((v) => v.properties.op.enum[0] === 'format_text');
  deq(op.properties.script, { anyOf: [{ type: 'string', enum: ['super', 'sub', 'none'] }, { type: 'null' }] });
  assert.ok(!('description' in T.TOOL_DEFS.format_text.function.parameters.properties.script));
});
