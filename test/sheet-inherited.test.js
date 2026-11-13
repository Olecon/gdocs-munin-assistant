'use strict';
// The formatting sheet against inherited paragraph values (src/style-sheet.js sheetLineChanges: a value a paragraph
// does not set is its named style's, read for format_lines; Docs' Normal text has line spacing 1.15), the list items
// replace_section creates (left alone by the sheet), and style_map's explicit "not bold" and its unread defaults.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh, pushTool;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null, apply_sheet: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });
const posts = () => fake.log.filter((x) => x.method === 'POST');
const paraReqs = () => posts().flatMap((p) => p.body.requests).filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle);
// over: spec fields beside the items (namedStyles, which docSpec does not pass on).
const doc = (over = {}) => ({ ...docSpec({ items: [{ p: 'Title line', style: 'HEADING_1' }, { p: 'Body one.' }, { p: 'Body two.' }] }), ...over });
async function freshWith(spec, docMd = '') {
  await fresh(spec);
  as.docInstructions = docMd; as.mainInstructions = '';
}

test('apply_sheet: "spacing 1" is written on a line inheriting Docs\' 1.15 from Normal text', async () => {
  await freshWith(doc(), 'Formatting: body Arial 11 left space 0/0 spacing 1');
  const w = pushTool(await exec('format_lines', fl(2, 2, { apply_sheet: true })));
  assert.ok(w._ok, w.content);
  const p = paraReqs();
  deq(p.length, 1);
  deq([p[0].fields.split(',').includes('lineSpacing'), p[0].paragraphStyle.lineSpacing], [true, 100]);
  deq(fake.pstyles('t.0')[1].lineSpacing, 100);
});

test('apply_sheet: "left" is written where Normal text is justified; nothing is written where the inherited value matches', async () => {
  await freshWith(doc({ namedStyles: { NORMAL_TEXT: { alignment: 'JUSTIFIED' } } }), 'Formatting: body Arial 11 left space 0/0');
  const w = pushTool(await exec('format_lines', fl(2, 2, { apply_sheet: true })));
  assert.ok(w._ok, w.content);
  deq(paraReqs().map((r) => r.paragraphStyle.alignment), ['START']);
  assert.doesNotMatch(w.content, /still differ/); // verified with the same named styles
  // the document's own Normal text (left, 0/0, 1.15) already matches the sheet: no paragraph write, the text values only
  await freshWith(doc(), 'Formatting: body Times New Roman 11 left space 0/0 spacing 1.15');
  const m = pushTool(await exec('format_lines', fl(2, 3, { apply_sheet: true })));
  assert.ok(m._ok, m.content);
  deq(paraReqs().length, 0);
  assert.ok(posts().flatMap((p) => p.body.requests).some((r) => r.updateTextStyle));
  // a second call finds nothing to change
  const again = await exec('format_lines', fl(2, 3, { apply_sheet: true }));
  assert.match(again.content, /^No change: lines 2–3 already follow the formatting sheet\./);
});

test('apply_sheet on a heading compares with its named style (Heading 1: 20/6), not with zero', async () => {
  await freshWith(doc(), 'Formatting: h1 Arial 20 space 20/6');
  const w = await exec('format_lines', fl(1, 1, { apply_sheet: true }));
  // Arial 20 is what Heading 1 shows already, and so is the spacing: nothing is written
  assert.strictEqual(w.content, 'No change: line 1 already follows the formatting sheet.');
  deq(paraReqs(), []);
  await freshWith(doc(), 'Formatting: h1 Arial 20 space 18/0');
  await exec('format_lines', fl(1, 1, { apply_sheet: true }));
  deq(paraReqs().map((r) => [r.paragraphStyle.spaceAbove.magnitude, r.paragraphStyle.spaceBelow.magnitude]), [[18, 0]]);
});

test('replace_section: new paragraphs inside a list stay list items: no alignment, spacing or first-line indent from the sheet', async () => {
  const spec = docSpec({ items: [{ p: 'Methods', style: 'HEADING_1' }, { p: 'First item', bullet: { listId: 'L1' } }, { p: 'Second item', bullet: { listId: 'L1' } }, { p: 'End', style: 'HEADING_1' }] });
  await freshWith(spec, 'Formatting: body Arial 11 justify space 0/6 first-line 18');
  const w = pushTool(await exec('replace_section', { heading: 'Methods', new_text: 'First item\nNew A\nNew B\nSecond item' })); // Auto: no card
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n'), ['Methods', 'First item', 'New A', 'New B', 'Second item', 'End']);
  const ps = paraReqs().filter((r) => r.fields.split(',').some((f) => ['alignment', 'spaceAbove', 'spaceBelow', 'indentFirstLine'].includes(f)));
  deq(ps, []);
});

test('replaceNewParas: list and cell come from the paragraphs of the replaced range', () => {
  const line = (n, start, end, extra = {}) => ({ line: n, start, end, off: start - 1, text: 'x'.repeat(end - start), style: 'NORMAL_TEXT', ...extra });
  const model = { lines: [line(1, 1, 8), line(2, 9, 14, { list: { kind: 'bullet', level: 0 } }), line(3, 15, 20, { list: { kind: 'bullet', level: 0 } })] };
  const plan = { journal: { index: 9 }, mid: { oldText: 'xxxxx', newText: 'aa\nbb\ncc\nxxxxx' } };
  const out = T.replaceNewParas(model, plan);
  assert.ok(out.length >= 3, JSON.stringify(out));
  assert.ok(out.every((p) => p.list === true && p.cell === false), JSON.stringify(out));
  // outside a list: no list flag
  const plain = { lines: model.lines.map((l) => ({ ...l, list: null })) };
  assert.ok(T.replaceNewParas(plain, plan).every((p) => p.list === false), 'plain');
});

test('style_map: text un-bolded in a bold heading reads "not bold", not the style\'s bold; italic the same', async () => {
  await freshWith({ ...docSpec({ items: [{ p: 'Bold heading words', style: 'HEADING_1', fmt: [[5, 12, { bold: false, italic: false }]] }, { p: 'Body.' }] }),
    namedStyles: { HEADING_1: { bold: true } } });
  const r = await exec('style_map', { property: 'bold', scope: { start: 1, end: 1 } });
  const text = typeof r === 'string' ? r : r.content;
  assert.match(text, /- \(h1 style: bold\): line 1 \(chars 1–5, 13–18\)/, text);
  assert.match(text, /- not bold: line 1 \(chars 6–12\)/, text);
  const it = await exec('style_map', { property: 'italic', scope: { start: 1, end: 1 } });
  assert.match(typeof it === 'string' ? it : it.content, /- not italic: line 1 \(chars 6–12\)/);
  // the run model keeps the explicit false apart from an unset value
  const run = state.docModel.lines[0].runs.find((x) => x.s === 5);
  deq([run.bold, run.boldOff, run.italicOff], [false, true, true]);
});

// Docs does not store a text value equal to the inherited one (11 pt and black on Normal text; real-docs.js facts 2, 7g),
// so the sheet's checks count an inherited value equal to the sheet's as applied.
test('apply_sheet: a text value the line inherits counts as applied ("No change", no "still differs"); unread named styles count it as missing', async () => {
  // fact 7g: "body Arial 11" on Normal text (Arial 11): nothing to write
  await freshWith(doc(), 'Formatting: body Arial 11 left space 0/0');
  const a = await exec('format_lines', fl(2, 2, { apply_sheet: true }));
  assert.strictEqual(a.content, 'No change: line 2 already follows the formatting sheet.');
  deq(posts().length, 0);
  // a line in Georgia: font and size written; Docs keeps the Arial and drops the 11 pt, and the check counts both as applied
  await freshWith({ ...docSpec({ items: [{ p: 'Title line', style: 'HEADING_1' }, { p: 'Body one.', fmt: [[0, 9, { font: 'Georgia', size: 13 }]] }] }) },
    'Formatting: body Arial 11 left space 0/0');
  const w = pushTool(await exec('format_lines', fl(2, 2, { apply_sheet: true })));
  assert.strictEqual(w.content, 'Done: applied the formatting sheet to line 2; the document has 2 lines.');
  deq(fake.fmt('t.0')[1], [[0, 9, { font: 'Arial' }]]);
  assert.strictEqual((await exec('format_lines', fl(2, 2, { apply_sheet: true }))).content, 'No change: line 2 already follows the formatting sheet.');
  // bold and italic: the named style's (a bold Heading 1 is "bold" without a value of its own; "regular" differs)
  await freshWith({ ...doc(), namedStyles: { HEADING_1: { bold: true } } }, 'Formatting: h1 Arial 20 bold space 20/6');
  assert.match((await exec('format_lines', fl(1, 1, { apply_sheet: true }))).content, /^No change/);
  await freshWith({ ...doc(), namedStyles: { HEADING_1: { bold: true } } }, 'Formatting: h1 Arial 20 regular space 20/6');
  assert.ok(pushTool(await exec('format_lines', fl(1, 1, { apply_sheet: true })))._ok);
  assert.ok(posts().flatMap((p) => p.body.requests).some((r) => r.updateTextStyle && r.updateTextStyle.textStyle.bold === false));
  // the line model alone: named styles unread, an inherited value is unknown and counts as missing
  const line = { line: 1, start: 1, end: 6, text: 'Body.', style: 'NORMAL_TEXT', runs: [], para: {} };
  const model = { lines: [line] };
  assert.strictEqual(T.sheetLineChanges(model, line, { font: 'Arial', size: 11 }).text, true);
  assert.strictEqual(T.sheetLineChanges({ ...model, named: { NORMAL_TEXT: { font: 'Arial', size: 11 } } }, line, { font: 'Arial', size: 11 }).text, false);
  assert.strictEqual(T.sheetLineChanges({ ...model, named: { NORMAL_TEXT: { font: 'Arial', size: 11 } } }, line, { font: 'Arial', size: 12 }).text, true);
  deq(T.inheritedTextValues({ NORMAL_TEXT: { font: 'Arial', size: 11 }, HEADING_2: { size: 16, italic: true } }, 'HEADING_2'), { font: 'Arial', size: 16, bold: false, italic: true });
  deq(T.inheritedTextValues({}, 'HEADING_2'), {});
});

test('style_map: when the named-style read fails, unset text is "(default)" or the Normal text last read, never the most common explicit font', () => {
  const model = { docId: 'NEVER-READ', tabId: 't.9', textDefault: { font: 'Courier New', size: 10 },
    lines: [{ line: 1, text: 'Plain text', style: 'NORMAL_TEXT', runs: [], para: {} }] };
  const out = T.styleMap(model, { property: 'font', scope: 'all' }, 10000, null);
  assert.match(out, /- \(default\): line 1/, out);
  assert.doesNotMatch(out, /Courier/);
});
