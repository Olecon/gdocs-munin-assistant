'use strict';
// Several edits in one call, and an honest wrap-up: edit_document (replace, insert, delete, format_text, format_lines and
// number_headings in one batch from the bottom up, one re-read, one undo; overlaps and bad entries refused with the
// entry named; an insert where another operation starts goes before it; the gate and the read-first check over its
// parts; the batch fields of earlier versions refused, their stored calls still rendered and undone),
// insert_after_line style "outline" (# ## ### become headings in one batch, one undo), the wrap-up that lists the
// turn's edits, and the round limit (20 on the Docs API, 12 on the export).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, exec, fresh, pushTool, lastPost;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ routeDocs, exec, fresh, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: '# Notes\n\nFirst.\n\nSecond.', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const texts = () => fake.text('t.0').split('\n');
const styles = () => fake.styles('t.0');
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const undo = () => exec('undo_last_edit', {});
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null };
const fl = (over) => ({ start: 1, end: 1, ...NULLS, ...over });
// Lines: 1 Report (title), 2 Intro, 3 Methods, 4 Alpha, 5 Results, 6 Beta, 7 Discussion, 8 Gamma.
const plain = () => docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Intro' }, { p: 'Methods' }, { p: 'Alpha' }, { p: 'Results' }, { p: 'Beta' }, { p: 'Discussion' }, { p: 'Gamma' }] });


test('insert_after_line outline: # ## ### become headings, other lines Normal, one batch; the result names the headings; one undo', async () => {
  await fresh(plain());
  const before = { t: texts(), s: styles() };
  const n = posts();
  const text = '# Introduction\nWhy it matters.\n## Background\n### Prior work\nText one.\n\nText two.\n#hashtag stays';
  const w = pushTool(await exec('insert_after_line', { line: 1, text, style: 'outline' }));
  assert.ok(w._ok, w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  deq(texts().slice(0, 10), ['Report', 'Introduction', 'Why it matters.', 'Background', 'Prior work', 'Text one.', '', 'Text two.', '#hashtag stays', 'Intro']);
  deq(styles().slice(0, 10), ['TITLE', 'HEADING_1', 'NORMAL_TEXT', 'HEADING_2', 'HEADING_3', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  assert.strictEqual(w.content, 'Done: inserted after line 1; now lines 2–9; the document has 16 lines.\nHeadings made: lines 2 (h1), 4 (h2), 5 (h3).');
  assert.strictEqual(w._cardText.split('\n')[0], 'Introduction');
  const u = pushTool(await undo());
  assert.ok(u._ok, u.content);
  deq({ t: texts(), s: styles() }, before);
});

test('insert_after_line outline: verification names lines Google Docs styled differently; a text of only markers is empty', async () => {
  await fresh(plain());
  const plan = T.planInsert(as.model, { line: 2, text: '# Head\nBody', style: 'outline' });
  const report = plan.report(as.model); // not applied: line 3 is still "Methods" (Normal)
  assert.ok(report.startsWith('Headings made: line 3 (h1).\nNote: Google Docs did not apply all of it (not shown: style h1); lines 3–4 now read:'), report);
  const e = await exec('insert_after_line', { line: 2, text: '# \n## ', style: 'outline' });
  deq([e._ok, e.content], [false, 'Error: text is empty']);
});


// ---- edit_document -------------------------------------------------------------------------------------------------
// Every field of every operation is listed (strict schema): op() fills the ones an operation leaves out with null.
const OP_NULLS = { old_text: null, new_text: null, line: null, text: null, start: null, end: null, ...NULLS,
  bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const op = (name, over) => ({ ...OP_NULLS, op: name, ...over });
const ed = (...operations) => exec('edit_document', { operations });
// Without the header's "Unmarked text" (it appears once a format_lines call has read the named styles).
const RF = (start, end) => String(T.runReadingTool('read_formatting', { start, end }, as)).replace(/ Unmarked text: [^\n]*?\.(?=\n)/, '');
// Lines: 1 Report (title), 2 Intro (h1), 3 Alpha, 4 Methods (h1), 5 Beta, 6 Results (h1), 7 Gamma.
const headed = () => docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Intro', style: 'HEADING_1' }, { p: 'Alpha' }, { p: 'Methods', style: 'HEADING_1' },
  { p: 'Beta' }, { p: 'Results', style: 'HEADING_1' }, { p: 'Gamma' }] });

test('edit_document: schema strict, one object per op with only its fields; the description within budget', () => {
  const d = T.TOOL_DEFS.edit_document.function;
  const variants = d.parameters.properties.operations.items.anyOf;
  deq(d.parameters.required, ['operations']);
  deq(d.parameters.additionalProperties, false);
  deq(variants.map((v) => v.properties.op), T.EDIT_OPS.map((o) => ({ type: 'string', enum: [o] })));
  // strict mode (OpenAI, Anthropic): every property required, no additional ones, at every level
  for (const v of variants) {
    deq([v.type, v.required, v.additionalProperties], ['object', Object.keys(v.properties), false]);
  }
  const fields = Object.fromEntries(variants.map((v) => [v.properties.op.enum[0], Object.keys(v.properties).slice(1)]));
  deq(fields, {
    replace: ['old_text', 'new_text', 'line'], insert: ['line', 'text', 'style', 'fill'], delete: ['start', 'end'],
    format_text: ['old_text', 'line', 'all', 'bold', 'italic', 'underline', 'font', 'size', 'color', 'highlight', 'script', 'link'],
    format_lines: ['start', 'end', 'style', 'align', 'list', 'indent_start', 'indent_first_line', 'space_above', 'space_below', 'line_spacing', 'indent_end', 'box', 'page_break_before'],
    number_headings: ['start', 'end', 'numbers', 'prefix'],
  });
  // the fields an op needs are plain types; the optional ones nullable
  const nullableOf = (v) => Object.keys(v.properties).filter((k) => v.properties[k].anyOf && v.properties[k].anyOf.some((x) => x.type === 'null'));
  deq(Object.fromEntries(variants.map((v) => [v.properties.op.enum[0], nullableOf(v).length])), { replace: 1, insert: 2, delete: 1, format_text: 11, format_lines: 11, number_headings: 3 });
  deq(variants[0].properties.old_text, { type: 'string' });
  // every op argument of a call goes through the planner: the field names are those planOperation reads
  const all = new Set(variants.flatMap((v) => Object.keys(v.properties)));
  for (const k of ['old_text', 'new_text', 'line', 'all', 'text', 'start', 'end', 'style', 'numbers']) assert.ok(all.has(k), k);
  assert.ok(T.estimateTokens([{ content: d.description }]) <= 120, `${T.estimateTokens([{ content: d.description }])} tokens`);
  // the single tools have no batch fields any more
  for (const [name, field] of [['replace_text', 'edits'], ['insert_after_line', 'inserts'], ['delete_lines', 'ranges'], ['format_text', 'items'], ['format_lines', 'ranges']]) {
    assert.ok(!(field in T.TOOL_DEFS[name].function.parameters.properties), name);
  }
  assert.ok(T.WRITE_TOOLS.includes('edit_document'));
});

// A strict operation (only its op's fields) checked against the schema the way a strict provider would produce it.
function strictValid(o) {
  const variant = T.TOOL_DEFS.edit_document.function.parameters.properties.operations.items.anyOf.find((v) => v.properties.op.enum.includes(o.op));
  if (!variant) return `no variant for ${o.op}`;
  const want = Object.keys(variant.properties).sort().join();
  if (Object.keys(o).sort().join() !== want) return `${o.op}: fields ${Object.keys(o).sort().join()} instead of ${want}`;
  const typeOk = (v, s) => (s.anyOf ? s.anyOf.some((x) => typeOk(v, x)) : s.type === 'null' ? v === null
    : s.type === 'integer' ? Number.isInteger(v) : s.type === 'number' ? typeof v === 'number' : typeof v === s.type) && (!s.enum || s.enum.includes(v));
  const bad = Object.keys(o).filter((k) => !typeOk(o[k], variant.properties[k]));
  return bad.length ? `${o.op}: ${bad.join(', ')} do not match` : '';
}

test('edit_document: one operation of each op in its strict shape (only its fields) validates and is applied; one undo', async () => {
  await fresh(headed());
  const before = { t: texts(), s: styles(), f: RF(1, 7) };
  const F = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, script: null, link: null };
  const L = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, indent_end: null, box: null, page_break_before: null };
  const ops = [
    { op: 'replace', old_text: 'Alpha', new_text: 'Alpha one', line: 3 },
    { op: 'insert', line: 5, text: 'Beta two', style: null, fill: null },
    { op: 'delete', start: 6, end: null },
    { op: 'format_text', old_text: 'Beta', line: null, all: null, ...F, bold: true },
    { op: 'format_lines', start: 4, end: 4, ...L, align: 'center' },
    { op: 'number_headings', start: 1, end: 2, numbers: 'typed', prefix: null },
  ];
  for (const o of ops) assert.strictEqual(strictValid(o), '', JSON.stringify(o));
  assert.ok(strictValid({ op: 'replace', old_text: 'a', new_text: 'b', line: null, bold: null }).includes('fields'), 'another op\'s field is not allowed');
  const w = pushTool(await ed(...ops));
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(texts(), ['Report', '1 Intro', 'Alpha one', 'Methods', 'Beta', 'Beta two', 'Gamma']);
  assert.ok(RF(5, 5).endsWith('5: **Beta**') && RF(4, 4).endsWith('4: [h1 center] Methods'), RF(1, 7));
  pushTool(await undo());
  deq({ t: texts(), s: styles(), f: RF(1, 7) }, before);
});

test('edit_document: replace + insert + format_lines + number_headings in one batch from the bottom up; verified; one undo restores all', async () => {
  await fresh(headed());
  const before = { t: texts(), s: styles(), f: RF(1, 7) };
  const n = posts();
  const ops = [
    op('replace', { old_text: 'Alpha', new_text: 'Alpha one' }),
    op('format_lines', { start: 7, end: 7, align: 'center' }),
    op('insert', { line: 5, text: 'Beta two' }),
    op('number_headings', { start: 1, end: 2, numbers: 'typed' }),
  ];
  const w = pushTool(await ed(...ops));
  assert.ok(w._ok, w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  deq(texts(), ['Report', '1 Intro', 'Alpha one', 'Methods', 'Beta', 'Beta two', 'Results', 'Gamma']);
  deq(styles(), ['TITLE', 'HEADING_1', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT']);
  assert.ok(RF(8, 8).endsWith('8: [center] Gamma'), RF(1, 8));
  assert.strictEqual(w.content, 'Done: made 4 edits (line numbers as before this edit): numbered 1 heading on line 2; replaced line 3; inserted after line 5 (now line 6); formatted line 7 (centered); the document has 8 lines.');
  assert.strictEqual(w._message, 'Made 4 edits');
  assert.strictEqual(w._edit.kind, 'multi');
  deq(w._edit.parts.map((p) => p.kind), ['number-headings', 'replace', 'insert', 'format']);
  // bottom-up: the alignment of line 7 first, the heading number of line 2 last
  const reqs = lastPost().requests;
  assert.ok(reqs[0].updateParagraphStyle && reqs[0].updateParagraphStyle.paragraphStyle.alignment === 'CENTER', JSON.stringify(reqs[0]));
  assert.ok(reqs[reqs.length - 1].insertText && reqs[reqs.length - 1].insertText.text === '1 ', JSON.stringify(reqs[reqs.length - 1]));
  assert.strictEqual(T.toolCallSummary('edit_document', { operations: ops }), '4 edits (replace "Alpha", format_lines 7, insert after 5, number_headings 1–2)');
  assert.ok(T.turnEditsLine([w]).startsWith('made 4 edits (line numbers as before this edit): numbered 1 heading on line 2;'));
  const u = pushTool(await undo());
  assert.ok(u._ok, u.content);
  deq({ t: texts(), s: styles(), f: RF(1, 7) }, before);
  const again = await undo();
  assert.ok(!again._ok && /no edit to undo/.test(again.content), again.content);
});

test('edit_document: an insert where another operation starts goes before it; neighbours undo; format parts verified on the moved lines', async () => {
  await fresh(plain());
  const before = { t: texts(), s: styles(), f: RF(1, 8) };
  // after line 2 = where line 3 starts: the heading style still lands on "Methods"; the text edit right below it undoes
  const w = pushTool(await ed(op('format_lines', { start: 3, end: 3, style: 'h1' }), op('insert', { line: 2, text: 'Inserted' }),
    op('replace', { old_text: 'Alpha', new_text: 'Alpha, edited' }), op('format_text', { old_text: 'Beta', bold: true }), op('delete', { start: 8, end: 8 })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Report', 'Intro', 'Inserted', 'Methods', 'Alpha, edited', 'Results', 'Beta', 'Discussion']);
  deq(styles(), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  assert.ok(RF(7, 7).endsWith('7: **Beta**'), RF(1, 8));
  assert.ok(!/did not apply/.test(w.content), w.content); // the checks look at the lines where the parts are now
  const u = pushTool(await undo());
  assert.ok(u._ok, u.content);
  deq({ t: texts(), s: styles(), f: RF(1, 8) }, before);
});

test('edit_document: format_text and format_lines on one line in one call; the text values win over the sheet\'s; verified; one undo', async () => {
  await fresh(headed());
  const before = { t: texts(), s: styles(), f: RF(1, 7) };
  const n = posts();
  // the format_text first in the list and starting where the line starts; the style change writes the sheet's h2 size 14
  const w = pushTool(await ed(op('format_text', { old_text: 'Alpha', size: 12, bold: true }), op('format_lines', { start: 3, end: 3, style: 'h2', align: 'center' })));
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  assert.strictEqual(styles()[2], 'HEADING_2');
  assert.ok(RF(3, 3).endsWith('3: [h2 center space 14/0] {**Alpha**}(font=Times New Roman size=12)'), RF(3, 3));
  // the format_text goes after the format_lines (and after the sheet's text values)
  const reqs = lastPost().requests;
  const last = reqs[reqs.length - 1].updateTextStyle;
  assert.ok(last && last.textStyle.fontSize.magnitude === 12 && last.textStyle.bold === true, JSON.stringify(reqs));
  deq(w._edit.parts.map((p) => p.kind), ['format', 'format']);
  pushTool(await undo());
  deq({ t: texts(), s: styles(), f: RF(1, 7) }, before);
});

test('edit_document: an insert where a format_lines starts and a format_text on that line: the format_text is moved by the insert too; one undo', async () => {
  await fresh(headed());
  const before = { t: texts(), s: styles(), f: RF(1, 7) };
  const w = pushTool(await ed(op('insert', { line: 2, text: 'New line' }), op('format_text', { old_text: 'lph', italic: true }),
    op('format_lines', { start: 3, end: 3, align: 'right' })));
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(texts().slice(0, 4), ['Report', 'Intro', 'New line', 'Alpha']);
  assert.ok(RF(3, 4).endsWith('3: [justify] {New line}(font=Times New Roman size=12)\n4: [right] A*lph*a'), RF(3, 4));
  pushTool(await undo());
  deq({ t: texts(), s: styles(), f: RF(1, 7) }, before);
});

test('edit_document: a replace inside one paragraph and a format_lines on its line in one call: the format_lines first; verified; one undo', async () => {
  await fresh(headed());
  const before = { t: texts(), s: styles(), f: RF(1, 7) };
  const n = posts();
  // the replace starts where the line starts; a format_text on the same line too
  const w = pushTool(await ed(op('replace', { old_text: 'Alpha', new_text: 'Alpha and more' }), op('format_lines', { start: 3, end: 3, style: 'h2', space_above: 6 }),
    op('format_text', { old_text: 'Gamma', italic: true })));
  assert.ok(w._ok && !/did not apply|stored the text differently/.test(w.content), w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  deq(texts(), ['Report', 'Intro', 'Alpha and more', 'Methods', 'Beta', 'Results', 'Gamma']);
  assert.strictEqual(styles()[2], 'HEADING_2');
  // the format_lines' requests come before the replace's (they address the line as it was)
  const reqs = lastPost().requests;
  const firstPara = reqs.findIndex((r) => r.updateParagraphStyle);
  const ins = reqs.findIndex((r) => r.insertText);
  assert.ok(firstPara >= 0 && ins > firstPara, JSON.stringify(reqs));
  // the sheet's h2 text values on the line as it was; the inserted words take their neighbour's style (as in Docs:
  // real-docs.js fact 7)
  assert.strictEqual(RF(3, 3).split('\n').pop(), '3: [h2 space 6/0] {Alpha and more}(font=Times New Roman size=14)');
  deq(w._edit.parts.map((p) => p.kind), ['format', 'replace', 'format']);
  pushTool(await undo());
  deq({ t: texts(), s: styles(), f: RF(1, 7) }, before);
});

test('edit_document: a format_lines making a list over lines with a replace and a format_text: one batch, one undo', async () => {
  await fresh(plain());
  const before = { t: texts(), s: styles(), f: RF(1, 8) };
  const w = pushTool(await ed(op('format_lines', { start: 4, end: 6, list: 'number' }), op('replace', { old_text: 'Results', new_text: 'Findings' }),
    op('format_text', { old_text: 'Beta', bold: true }), op('replace', { old_text: 'Alpha', new_text: 'Alpha one' })));
  assert.ok(w._ok && !/did not apply|stored the text differently/.test(w.content), w.content);
  deq(texts(), ['Report', 'Intro', 'Methods', 'Alpha one', 'Findings', 'Beta', 'Discussion', 'Gamma']);
  const f = RF(4, 6);
  assert.ok(/4: \[number[^\]]*\] Alpha one\n5: \[number[^\]]*\] Findings\n6: \[number[^\]]*\] \*\*Beta\*\*$/.test(f), f);
  pushTool(await undo());
  deq({ t: texts(), s: styles(), f: RF(1, 8) }, before);
});

test('edit_document: a replace that splits or joins lines, or starts above the format_lines, stays refused with the way forward', async () => {
  await fresh(plain());
  const n = posts();
  let e = await ed(op('format_lines', { start: 4, end: 4, align: 'center' }), op('replace', { old_text: 'Alpha', new_text: 'Al\npha' }));
  deq([e._ok, e.content], [false, 'Error: operation 2 (replace «Alpha») overlaps operation 1 (format_lines line 4). Send this call without operation 2, then operation 2 in a second edit_document call']);
  e = await ed(op('format_lines', { start: 4, end: 4, align: 'center' }), op('replace', { old_text: 'Methods\nAlpha', new_text: 'Methods\nAlpha one' }));
  assert.ok(!e._ok && /^Error: operation 2 \(replace «Methods.*»\) overlaps operation 1 \(format_lines line 4\)\. Send this call without operation 2/.test(e.content), e.content);
  assert.strictEqual(posts(), n);
});

test('edit_document: overlaps, a bad entry and old batch fields are refused with the entry named; nothing is written', async () => {
  await fresh(plain());
  const n = posts();
  let e = await ed(op('replace', { old_text: 'Alpha', new_text: 'A' }), op('format_text', { old_text: 'pha', italic: true }));
  deq([e._ok, e.content], [false, 'Error: operation 2 (format_text «pha») overlaps operation 1 (replace «Alpha»). Send this call without operation 2, then operation 2 in a second edit_document call']);
  // every overlapping pair in one error; the later operation of each pair goes into the second call
  e = await ed(op('format_text', { old_text: 'Beta', bold: true }), op('replace', { old_text: 'Alpha', new_text: 'A' }), op('delete', { start: 6, end: 6 }),
    op('format_text', { old_text: 'lph', italic: true }));
  deq([e._ok, e.content], [false, 'Error: operation 3 (delete line 6) overlaps operation 1 (format_text «Beta»); operation 4 (format_text «lph») overlaps operation 2 (replace «Alpha»). '
    + 'Send this call without operations 3, 4, then those in a second edit_document call']);
  e = await ed(op('insert', { line: 2, text: 'A' }), op('insert', { line: 2, text: 'B' }));
  deq([e._ok, e.content], [false, 'Error: operation 2 (insert after line 2) goes where operation 1 (insert after line 2) goes; put both texts in one insert']);
  e = await ed(op('delete', { start: 3, end: 4 }), op('format_lines', { start: 4, end: 5, style: 'h2' }));
  assert.ok(/overlaps operation 1 \(delete lines 3–4\)/.test(e.content), e.content);
  e = await ed(op('replace', { old_text: 'Omega', new_text: 'O' }));
  assert.ok(e.content.startsWith('Error: operation 1 (replace «Omega»): old_text was not found in the document'), e.content);
  e = await ed(op('insert', { line: 40, text: 'Far' }));
  deq([e._ok, e.content], [false, 'Error: operation 1 (insert after line 40): line must be an integer from 0 to 8']);
  e = await ed(op('rename', {}));
  assert.ok(e.content.startsWith('Error: operation 1 (rename): op must be one of replace, insert, delete, format_text, format_lines, number_headings'), e.content);
  e = await ed(op('format_lines', { start: 3, end: 3, numbers: 'set' }));
  assert.ok(e.content.startsWith('Error: operation 1 (format_lines line 3): numbers belongs to the op number_headings'), e.content);
  e = await exec('edit_document', { operations: [] });
  assert.ok(e.content.startsWith('Error: operations must be a non-empty list'), e.content);
  // a single tool with a batch field of earlier versions
  e = await exec('replace_text', { old_text: '', new_text: '', edits: [{ old_text: 'Alpha', new_text: 'A' }] });
  deq([e._ok, e.content], [false, 'Error: replace_text makes one edit; edits is not a parameter. For several edits at once call edit_document with operations [{"op": …}, …].']);
  e = await exec('format_lines', fl({ ranges: [{ start: 3, end: 3, style: 'h1' }] }));
  assert.ok(!e._ok && e.content.includes('edit_document'), e.content);
  assert.strictEqual(posts(), n);
  // every entry already done: no write
  e = await ed(op('format_lines', { start: 1, end: 1, style: 'title' }));
  deq([e._ok, e.content.startsWith('No change: operation 1 (format_lines line 1): line 1 is already'), posts()], [true, true, n]);
});

test('edit_document: a line-number call after an earlier edit of the response is refused; a text-only one is not', async () => {
  await fresh(plain());
  const first = await exec('replace_text', { old_text: 'Intro', new_text: 'Introduction' }, 'r1');
  assert.ok(first._ok, first.content);
  let e = await exec('edit_document', { operations: [op('insert', { line: 3, text: 'X' })] }, 'r2', true);
  assert.ok(!e._ok && /line numbers changed after the previous edit in this response/.test(e.content), e.content);
  e = await exec('edit_document', { operations: [op('replace', { old_text: 'Gamma', new_text: 'G' }), op('format_text', { old_text: 'Beta', italic: true })] }, 'r3', true);
  assert.ok(e._ok, e.content);
});

// The saved chat: an edit_document call was refused and the retry carried half of its operations, without a word to the
// user. The code names them on the retry's result (snap.editRefused, per turn).
const DROPPED_RE = /\nNote: not in this call, from the refused one: (.*)\. Send them in another call or tell the user they were left out\.$/;
const dropped = (r) => { const m = DROPPED_RE.exec(r.content); return m ? m[1] : null; };
test('edit_document: a retry that leaves out operations of the refused call names them once; a complete retry or a fixed old_text does not', async () => {
  await fresh(plain());
  // an overlap refusal, then the retry without the later operation: named (also when a later call sends it: moot)
  let e = await ed(op('replace', { old_text: 'Alpha', new_text: 'A' }), op('format_text', { old_text: 'pha', italic: true }), op('format_lines', { start: 5, end: 5, style: 'h1' }));
  assert.ok(!e._ok, e.content);
  e = await ed(op('replace', { old_text: 'Alpha', new_text: 'A' }));
  assert.ok(e._ok, e.content);
  deq(dropped(e), 'format_text «pha»; format_lines 5');
  e = await ed(op('format_lines', { start: 5, end: 5, style: 'h1' }));
  deq([e._ok, dropped(e)], [true, null]); // said once: the state is gone
  // a not-found refusal fixed in the retry (same new_text), the line numbers shifted by an edit in between: no note
  await fresh(plain());
  e = await ed(op('replace', { old_text: 'Gama', new_text: 'Omega' }), op('format_lines', { start: 5, end: 5, style: 'h1' }), op('insert', { line: 6, text: 'New line.' }),
    op('format_text', { old_text: 'Discusion', italic: true }));
  assert.ok(!e._ok && /not found/.test(e.content), e.content);
  e = await exec('replace_text', { old_text: 'Intro', new_text: 'Intro\nMore intro' }); // one line more above
  assert.ok(e._ok, e.content);
  e = await ed(op('replace', { old_text: 'Gamma', new_text: 'Omega' }), op('format_lines', { start: 6, end: 6, style: 'h1' }), op('insert', { line: 7, text: 'New line.' }),
    op('format_text', { old_text: 'Discussion', italic: true }));
  deq([e._ok, dropped(e)], [true, null]);
  deq(texts().slice(5, 8), ['Results', 'Beta', 'New line.']);
  // a line-number call refused after an earlier edit of the same response: its lines are the ones the model saw
  await fresh(plain());
  assert.ok((await exec('replace_text', { old_text: 'Intro', new_text: 'Intro\nMore' }, 'd1'))._ok);
  e = await exec('edit_document', { operations: [op('delete', { start: 4, end: 4 }), op('format_lines', { start: 6, end: 6, style: 'h1' })] }, 'd2', true);
  assert.ok(!e._ok && /line numbers changed/.test(e.content), e.content);
  e = await ed(op('delete', { start: 5, end: 5 }), op('format_lines', { start: 7, end: 7, style: 'h1' })); // Alpha and Beta, now one line lower
  deq([e._ok, dropped(e)], [true, null]);
  deq(texts().slice(3, 6), ['Methods', 'Results', 'Beta']);
  // a single tool's write takes its operation off the list; at most six are named, then the count
  await fresh(plain());
  const bold = (t) => op('format_text', { old_text: t, bold: true });
  e = await ed(...['Report', 'Intro', 'Methods', 'Alpha', 'Results', 'Beta', 'Discussion', 'Gamma'].map(bold), op('replace', { old_text: 'Omega', new_text: 'x' }));
  assert.ok(!e._ok, e.content);
  assert.ok((await exec('format_text', { old_text: 'Report', bold: true, italic: null, underline: null }))._ok);
  e = await ed(bold('Intro'));
  deq(dropped(e), 'format_text «Methods»; format_text «Alpha»; format_text «Results»; format_text «Beta»; format_text «Discussion»; format_text «Gamma»; and 1 more');
  // an operation that landed earlier in the turn is not named; an invalid one (the refusal's subject) neither
  await fresh(plain());
  assert.ok((await ed(bold('Alpha')))._ok);
  e = await ed(bold('Alpha'), bold('Beta'), op('rename', {}));
  assert.ok(!e._ok, e.content);
  e = await ed(bold('Gamma'));
  deq(dropped(e), 'format_text «Beta»');
  // a call the user denied is not the model's to resend: nothing is kept from it
  const r = { content: 'Error: x', _ok: false };
  const snap = {};
  T.noteDroppedOps('edit_document', T.writeOps('edit_document', { operations: [bold('Beta')] }, as.model), r, snap, true);
  assert.strictEqual(snap.editRefused, undefined);
});

test('no-op writes: an ok "No change" (the repeat guard does not count it); a no-op replace in edit_document is noted, the rest applied', async () => {
  await fresh(plain());
  const n = posts();
  const call = { id: 'nc', function: { name: 'replace_text', arguments: JSON.stringify({ old_text: 'Alpha', new_text: 'Alpha' }) } };
  for (let i = 0; i < 3; i++) {
    const r = await T.executeTool(call, 'edit', as);
    deq([r._ok, r.content, r._message, T.noteRepeatFailure(as, call, r)], [true, 'No change: «Alpha» already reads that; its look: format_text or format_lines.', 'No change', 0]);
  }
  let e = await ed(op('replace', { old_text: 'Alpha', new_text: 'Alpha' }));
  deq([e._ok, e.content], [true, 'No change: operation 1 (replace «Alpha»): «Alpha» already reads that; its look: format_text or format_lines.']);
  assert.strictEqual(posts(), n);
  e = await ed(op('replace', { old_text: 'Alpha', new_text: 'Alpha' }), op('replace', { old_text: 'Beta', new_text: 'B' }));
  assert.ok(e._ok && e.content.includes('\nNote: no change for operation 1 (replace «Alpha»): «Alpha» already reads that; its look: format_text or format_lines.'), e.content);
  deq(texts()[5], 'B');
});

test('edit_document: the card shows its operations in the call\'s order, each whole; read-first covers its delete operations', async () => {
  await fresh(plain());
  const plan = T.planEditDocument(as.model, { operations: [op('delete', { start: 6, end: 8 }), op('delete', { start: 2, end: 4 })] });
  const info = T.editGateInfo('edit_document', plan);
  assert.strictEqual(info.what, 'makes 2 edits on lines 2–8');
  deq(info.blocks, [{ head: '1. Deletes lines 6–8.' }, { label: 'Removed: lines 6–8', text: 'Beta\nDiscussion\nGamma' },
    { head: '2. Deletes lines 2–4.' }, { label: 'Removed: lines 2–4', text: 'Intro\nMethods\nAlpha' }]);
  assert.strictEqual(info.large, undefined); // no size rule
  const small = T.editGateInfo('edit_document', T.planEditDocument(as.model, { operations: [op('replace', { old_text: 'Alpha', new_text: 'A' }), op('format_lines', { start: 3, end: 3, style: 'h1' })] }));
  assert.strictEqual(small.what, 'makes 2 edits on lines 3–4');
  deq(small.blocks.slice(0, 2), [{ head: '1. Replaces line 4.' }, { label: 'Line 4 after the edit', text: 'A', diff: { oldText: 'Alpha', newText: 'A' } }]);
  assert.match(small.blocks[2].head, /^2\. Formats line 3: .+\.$/);
  deq(small.blocks[3], { label: 'Formatted lines', text: 'Methods' });
  // read-first: the delete parts' lines must have been read in this message
  as.readFirst = true; as.seenLines = new Set([2]);
  const r = T.readFirstCheck('edit_document', T.planEditDocument(as.model, { operations: [op('delete', { start: 2, end: 3 })] }), {}, as);
  assert.ok(r && /you have not read line 3 in this message/.test(r.refuse), JSON.stringify(r));
  as.readFirst = false;
});

test('stored chats: an old replace_text call with edits and an old format_lines ranges call render with their old labels and still undo', async () => {
  await fresh(plain());
  const before = { t: texts(), s: styles() };
  // the journals of earlier versions: a 'multi' of replace parts (replace_text edits) and a 'format' entry with groups
  const w1 = await ed(op('replace', { old_text: 'Intro', new_text: 'Introduction' }), op('replace', { old_text: 'Gamma', new_text: 'Gamma ray' }));
  const w2 = await exec('format_lines', fl({ start: 3, end: 3, style: 'h1' }));
  assert.ok(w1._ok && w2._ok, w1.content + w2.content);
  const old1 = { id: 'o1', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ old_text: '', new_text: '', edits: [{ old_text: 'Intro', new_text: 'Introduction' }, { old_text: 'Gamma', new_text: 'Gamma ray' }] }) } };
  const old2 = { id: 'o2', type: 'function', function: { name: 'format_lines', arguments: JSON.stringify(fl({ ranges: [{ start: 3, end: 3, style: 'h1' }] })) } };
  state.messages = [
    { role: 'user', content: 'Fix it' },
    { role: 'assistant', content: null, tool_calls: [old1] },
    { ...w1, tool_call_id: 'o1', _message: 'Replaced at 2 places', _edit: { ...w1._edit, id: 'o1', title: 'Replaced at 2 places' } },
    { role: 'assistant', content: null, tool_calls: [old2] },
    { ...w2, tool_call_id: 'o2', _edit: { ...w2._edit, id: 'o2' } },
    { role: 'assistant', content: 'Done.' },
  ];
  T.renderHistory();
  const log = T.actionLogFromToolCalls([old1, old2], new Map([['o1', state.messages[2]], ['o2', state.messages[4]]]));
  deq(log.map((x) => [x.name, x.summary, x.status]), [['replace_text', '2 edits ("Intro", "Gamma")', 'ok'], ['format_lines', '1 ranges (lines 3)', 'ok']]);
  let u = await undo();
  assert.ok(u._ok && /undid formatting of line 3/.test(u.content), u.content);
  u = await undo();
  assert.ok(u._ok && /undid "Replaced at 2 places"/.test(u.content), u.content);
  deq({ t: texts(), s: styles() }, before);
  state.messages = [];
});

// ---- The wrap-up and the round limit --------------------------------------------------------------------------------
test('turnEditsLine: the successful edits that are not undone, clipped; none gives the plain wrap-up', () => {
  const msgs = [
    { role: 'tool', _ok: true, _edit: { title: 'Inserted after line 2' }, content: 'Done: inserted after line 2; now lines 3–28; the document has 40 lines.' },
    { role: 'tool', _ok: true, _edit: { title: 'Formatted 3 ranges' }, content: 'Done: formatted lines 3, 7 (h1); line 5 (h2); the document has 40 lines.' },
    { role: 'tool', _ok: true, _edit: { title: 'Deleted line 9', undone: true }, content: 'Done: deleted line 9; the document has 39 lines.' },
    { role: 'tool', _ok: false, content: 'Error: x' },
    { role: 'tool', _ok: true, _reading: true, content: 'Lines 1-3 …' },
  ];
  assert.strictEqual(T.turnEditsLine(msgs), 'inserted after line 2 (now lines 3–28); formatted lines 3, 7 (h1); line 5 (h2)');
  assert.strictEqual(T.wrapUpContent('W.', msgs), 'W.\nEdits made since the user\'s last message: inserted after line 2 (now lines 3–28); formatted lines 3, 7 (h1); line 5 (h2). They are in the document: name them, and never say that nothing was changed.');
  assert.strictEqual(T.wrapUpContent('W.', msgs.slice(2)), 'W.');
  const many = Array.from({ length: 40 }, () => msgs[0]);
  assert.strictEqual(T.turnEditsLine(many).length, T.WRAP_UP_EDITS_MAX_CHARS);
});

// A chat turn on the Docs API (Anthropic): rounds of tool calls scripted, the document served by the fake.
async function apiTurn(rounds) {
  fake = fakeDocsServer(plain());
  await T.createChat();
  T.el.chat.children.length = 0;
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = 'Build the structure';
  await T.sendMessage();
  return bodies;
}
const lastText = (body) => { const m = body.messages[body.messages.length - 1]; return m.content[m.content.length - 1].text; };

test('the Docs API turn: 20 tool rounds, then the wrap-up lists the edits made in the turn', async () => {
  assert.strictEqual(T.MAX_TOOL_ITERATIONS_API, 20);
  const edit = msgStart + tu(0, 'toolu_e', 'insert_after_line', { line: 1, text: '# Aims\nText.', style: 'outline' }) + stopTool;
  const fmt = msgStart + tu(0, 'toolu_f', 'edit_document', { operations: [op('format_lines', { start: 5, end: 5, style: 'h1' }), op('format_lines', { start: 7, end: 7, style: 'h2' })] }) + stopTool;
  // reads that differ (an identical one repeated would end the rounds after its third repeat: readAgain)
  const read = (i) => msgStart + tu(0, 'toolu_r' + i, 'find_in_document', { query: 'q' + i, doc: null }) + stopTool;
  const rounds = [edit, fmt, ...Array.from({ length: 19 }, (_, i) => read(i)), textRound('Two edits: the Aims section and two headings.')];
  const bodies = await apiTurn(rounds);
  assert.strictEqual(bodies.length, 22, 'the 21st response wanted tools: the wrap-up follows');
  const wrap = bodies[21];
  assert.strictEqual(wrap.tools, undefined);
  const text = lastText(wrap);
  assert.ok(text.startsWith(`${T.WRAP_UP_TEXT}\nEdits made since the user's last message: inserted after line 1 (now lines 2–3); made 2 edits: formatted line 5 (h1); formatted line 7 (h2). They are in the document: name them, and never say that nothing was changed.\n`), text);
  // the request has no tool blocks, so the calls are listed in its text: one line each, the last results clipped
  const calls = text.split('\n').slice(2);
  assert.strictEqual(calls[0], 'Your tool calls since the user\'s last message (20), the last results clipped:');
  assert.strictEqual(calls.length, 21);
  assert.ok(calls[1].startsWith('[insert_after_line(line=1, text="# Aims\\nText.", style="outline"): ok]'), calls[1]);
  assert.ok(calls[2].startsWith('[edit_document(operations=') && calls[2].endsWith(': ok]'), calls[2]);
  assert.ok(calls.slice(1, 17).every((l) => l.endsWith(']')));
  for (const l of calls.slice(17)) {
    assert.ok(/^\[find_in_document\(query="q\d+"\): ok\] No line contains/.test(l) && l.length <= 40 + T.WRAP_UP_RESULT_CHARS, l);
  }
  // the stored turn keeps the answer only; the request left the history
  assert.ok(!state.messages.some((m) => m._autoKind));
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Two edits: the Aims section and two headings.');
});

test('the export path keeps 12 tool rounds; a wrap-up without edits is the plain text', async () => {
  await T.createChat();
  T.el.chat.children.length = 0;
  ident.granted = false; state.googleConnected = false; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  const read = (i) => msgStart + tu(0, 'toolu_x' + i, 'find_in_document', { query: 'q' + i, doc: null }) + stopTool;
  const rounds = [...Array.from({ length: 13 }, (_, i) => read(i)), textRound('Read it.')];
  const bodies = [];
  env.ctx.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); };
  T.el.input.value = 'Look around';
  await T.sendMessage();
  assert.strictEqual(bodies.length, 14);
  const text = lastText(bodies[13]);
  assert.ok(text.startsWith(`${T.WRAP_UP_TEXT}\nYour tool calls since the user's last message (12), the last results clipped:\n[find_in_document(query="q0"): ok]\n`), text);
  assert.ok(!text.includes('Edits made'));
  state.googleConnected = true; ident.granted = true;
});
