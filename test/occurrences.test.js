'use strict';
// Picking one of several identical occurrences and formatting every occurrence: line on replace_text, format_text and
// their edit_document operations (old_text searched only in that line), format_text all: true (every occurrence in one
// batch, one journal entry, one Undo; the edit gate counts the occurrences like replace_all), and the ambiguity errors
// that name both ways out. The incident behind it: "highlight all DOIs in green" with one DOI cited twice.
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

const A = '[10.1016/j.bpj.2022.08.002]';
// Lines: 1 References (h1), 2 Smith (A), 3 Jones (B), 4 Lee (C), 5 Smith b (A again), 6 Park (D), 7 Kim (E), 8 two "10.5" on one line.
const refs = (extra = []) => docSpec({ items: [{ p: 'References', style: 'HEADING_1' },
  { p: `Smith 2022. ${A}` }, { p: 'Jones 2021. [10.1021/acs.jpcb.1c01234]' }, { p: 'Lee 2020. [10.1063/5.0012345]' },
  { p: `Smith 2022b. ${A}` }, { p: 'Park 2019. [10.1103/PhysRevE.99.012345]' }, { p: 'Kim 2018. [10.1039/c8cp01234a]' },
  { p: 'See 10.5 and 10.5 again.' }, ...extra] });
const texts = () => fake.text('t.0').split('\n');
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const undo = () => exec('undo_last_edit', {});
const RF = (start, end) => String(T.runReadingTool('read_formatting', { start, end }, as)).replace(/ Unmarked text: [^\n]*?\.(?=\n)/, '');
const FMT = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const fmt = (over) => ({ line: null, all: null, ...FMT, ...over });
const OP_NULLS = { old_text: null, new_text: null, line: null, all: null, text: null, start: null, end: null, ...FMT };
const op = (name, over) => ({ ...OP_NULLS, op: name, ...over });
const ed = (...operations) => exec('edit_document', { operations });
const highlighted = (line) => /bg=#00B050/.test(RF(line, line).split('\n').pop());

test('replace_text: line picks the occurrence on that line; no match there names the lines; the ambiguity names line and replace_all', async () => {
  await fresh(refs());
  let e = await exec('replace_text', { old_text: A, new_text: '[x]', line: null });
  deq([e._ok, e.content], [false, `Error: old_text occurs 2 times (lines 2, 5). Add line: N to pick the occurrence on line N (one call or operation per occurrence), or call replace_all to replace every occurrence`]);
  e = await exec('replace_text', { old_text: A, new_text: '[x]', line: 3 });
  deq([e._ok, e.content, e._message], [false, 'Error: old_text was not found on line 3; it occurs on lines 2, 5. Pass the line where it occurs (as read before this call), or null when it occurs once', 'replace_text: the text is not on line 3']);
  e = await exec('replace_text', { old_text: A, new_text: '[x]', line: 99 });
  assert.ok(!e._ok && e.content.startsWith('Error: line must be the number of the line (1 to 8) where old_text occurs, or null; got 99 (number)'), e.content);
  e = await exec('replace_text', { old_text: '10.5', new_text: '10.6', line: 8 });
  deq([e._ok, e.content], [false, 'Error: old_text occurs 2 times on line 8. Include more of the surrounding text so that it occurs once on that line']);
  e = await exec('replace_text', { old_text: '10.5', new_text: '10.6' });
  deq(e.content, 'Error: old_text occurs 2 times (lines 8). Include more of the surrounding text so that it occurs exactly once, or call replace_all to replace every occurrence');
  assert.strictEqual(fake.revision, 1, 'nothing written');
  const before = texts();
  const w = pushTool(await exec('replace_text', { old_text: 'Smith 2022', new_text: 'Smyth 2022', line: 5 }));
  assert.ok(w._ok, w.content);
  deq(texts()[1], before[1]);
  deq(texts()[4], `Smyth 2022b. ${A}`);
  // the stripped-markers path and a line number given as text still work
  const w2 = pushTool(await exec('replace_text', { old_text: '**Smith**', new_text: 'Schmidt', line: '2' }));
  assert.ok(w2._ok, w2.content);
  deq(texts()[1], `Schmidt 2022. ${A}`);
  pushTool(await undo()); pushTool(await undo());
  deq(texts(), before);
});

test('format_text: line picks one occurrence; the ambiguity names line and all: true; a line without it names where it is', async () => {
  await fresh(refs());
  let e = await exec('format_text', fmt({ old_text: A, highlight: 'green' }));
  deq([e._ok, e.content], [false, 'Error: old_text occurs 2 times (lines 2, 5). Add line: N to pick the occurrence on line N (one call or operation per occurrence), or all: true to format every occurrence']);
  e = await exec('format_text', fmt({ old_text: '10.5', highlight: 'green', line: 8 }));
  deq(e.content, 'Error: old_text occurs 2 times on line 8. Include more of the surrounding text so that it occurs once on that line, or add all: true to format every occurrence on it');
  e = await exec('format_text', fmt({ old_text: A, highlight: 'green', line: 4 }));
  assert.ok(e.content.startsWith('Error: old_text was not found on line 4; it occurs on lines 2, 5.'), e.content);
  e = await exec('format_text', fmt({ old_text: 'Nowhere', highlight: 'green', line: 4 }));
  assert.ok(/old_text not found|was not found in the document/.test(e.content) && !/on line 4/.test(e.content), e.content);
  e = await exec('format_text', fmt({ old_text: A, highlight: 'green', all: 'maybe' }));
  assert.ok(e.content.startsWith('Error: all must be true, false or null'), e.content);
  assert.strictEqual(fake.revision, 1);
  const w = pushTool(await exec('format_text', fmt({ old_text: A, highlight: 'green', line: 5 })));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: formatted line 5 (highlight #00B050); the document has 8 lines.');
  assert.ok(highlighted(5) && !highlighted(2), RF(1, 8));
  pushTool(await undo());
  assert.ok(!highlighted(5));
});

test('format_text all: true: every occurrence in one batch, one journal entry, one Undo; already formatted ones left out', async () => {
  await fresh(refs());
  const before = RF(1, 8);
  const n = posts();
  const w = pushTool(await exec('format_text', fmt({ old_text: A, highlight: 'green', all: true })));
  assert.ok(w._ok, w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  assert.strictEqual(w.content, 'Done: formatted 2 occurrences on lines 2, 5 (highlight #00B050); the document has 8 lines.');
  assert.strictEqual(w._message, `Formatted 2 × "${A}"`);
  assert.strictEqual(lastPost().requests.filter((r) => r.updateTextStyle).length, 2);
  deq([w._edit.kind, w._edit.groups.map((g) => g.lines)], ['format', [[2, 2], [5, 5]]]);
  assert.ok(highlighted(2) && highlighted(5) && !highlighted(3), RF(1, 8));
  // again: nothing to send
  const again = await exec('format_text', fmt({ old_text: A, highlight: 'green', all: true }));
  deq([again._ok, again.content], [true, `No change: all 2 occurrences of «${A}» (lines 2, 5) are already highlighted #00B050.`]);
  const u = pushTool(await undo());
  assert.ok(u._ok, u.content);
  assert.strictEqual(RF(1, 8), before);
  // one occurrence already formatted: only the other is sent, with a note
  pushTool(await exec('format_text', fmt({ old_text: A, highlight: 'green', line: 2 })));
  const w2 = pushTool(await exec('format_text', fmt({ old_text: A, highlight: 'green', all: true })));
  assert.strictEqual(w2.content, 'Done: formatted 1 occurrence on line 5 (highlight #00B050); the document has 8 lines.\nNote: 1 other occurrence already had this formatting.');
  // all with line: every occurrence on that line
  const w3 = pushTool(await exec('format_text', fmt({ old_text: '10.5', bold: true, all: true, line: 8 })));
  assert.ok(w3._ok && /formatted 2 occurrences on line 8/.test(w3.content), w3.content);
});

test('format_text all: true refusals: text across lines, a line with suggested changes, a bad line; nothing written', async () => {
  await fresh(refs([{ p: `Suggested ${A}`, suggest: true }]));
  let e = await exec('format_text', fmt({ old_text: `${A}\nJones`, bold: true, all: true }));
  assert.ok(e.content.startsWith('Error: all: true formats text within paragraphs only'), e.content);
  e = await exec('format_text', fmt({ old_text: A, bold: true, all: true }));
  deq(e.content, 'Error: old_text occurs on line 9, which contains suggested changes (suggesting mode), so nothing was formatted. Ask the user to accept or reject the suggestions in Google Docs first, or format the other occurrences one at a time with line: N');
  e = await exec('format_text', fmt({ old_text: A, bold: true, all: true, line: 0 }));
  assert.ok(e.content.startsWith('Error: line must be the number of the line'), e.content);
  assert.strictEqual(fake.revision, 1);
});

test('format_text all: true: the card names the occurrences and the values (no size rule)', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ p: `Item ${i + 1} DOI` }));
  await fresh(docSpec({ items: [{ p: 'List', style: 'HEADING_1' }, ...many] }));
  const big = T.editGateInfo('format_text', T.planFormat(as.model, fmt({ old_text: 'DOI', bold: true, all: true }), null));
  deq([big.large, big.what, big.blocks], [undefined, 'formats 20 occurrences on lines 2–21: bold on', [{ label: 'Formatted text (20 occurrences)', text: 'DOI' }]]);
  const small = T.editGateInfo('format_text', T.planFormat(as.model, fmt({ old_text: 'DOI', bold: true, all: true, line: 3 }), null));
  assert.strictEqual(small.what, 'formats line 3: bold on');
  const one = T.editGateInfo('format_text', T.planFormat(as.model, fmt({ old_text: 'Item 1 DOI', bold: true }), null));
  deq([one.what, one.blocks], ['formats line 2: bold on', [{ label: 'Formatted text', text: 'Item 1 DOI' }]]);
  const ed1 = T.editGateInfo('edit_document', T.planEditDocument(as.model, { operations: [op('format_text', { old_text: 'DOI', bold: true, all: true }), op('replace', { old_text: 'List', new_text: 'DOIs' })] }));
  assert.strictEqual(ed1.what, 'makes 2 edits on lines 1–21');
  deq(ed1.blocks.filter((b) => b.head).map((b) => b.head), ['1. Formats 20 occurrences on lines 2–21: bold on.', '2. Replaces line 1.']);
});

test('the incident: five format_text operations, one DOI cited twice: all: true or per-line operations, one batch, verified, one Undo', async () => {
  await fresh(refs());
  const before = RF(1, 8);
  const others = ['[10.1021/acs.jpcb.1c01234]', '[10.1063/5.0012345]', '[10.1103/PhysRevE.99.012345]', '[10.1039/c8cp01234a]'];
  // as the model sent it: refused, and the error names both ways out
  let e = await ed(op('format_text', { old_text: A, highlight: 'green' }), ...others.map((t) => op('format_text', { old_text: t, highlight: 'green' })));
  assert.strictEqual(e.content, `Error: operation 1 (format_text «${A}»): old_text occurs 2 times (lines 2, 5). Add line: N to pick the occurrence on line N (one call or operation per occurrence), or all: true to format every occurrence. No operation was applied; send all 5 again with this one fixed`);
  // all: true
  const n = posts();
  const w = pushTool(await ed(op('format_text', { old_text: A, highlight: 'green', all: true }), ...others.map((t) => op('format_text', { old_text: t, highlight: 'green' }))));
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  assert.strictEqual(posts(), n + 1, 'one batchUpdate');
  assert.strictEqual(w._message, 'Made 5 edits');
  assert.strictEqual(w.content, `Done: made 5 edits: ${[2, 3, 4, 5, 6, 7].map((l) => `formatted line ${l} (highlight #00B050)`).join('; ')}; the document has 8 lines.`);
  for (let l = 2; l <= 7; l++) assert.ok(highlighted(l), `line ${l}: ${RF(l, l)}`);
  pushTool(await undo());
  assert.strictEqual(RF(1, 8), before);
  // per-line operations
  const w2 = pushTool(await ed(op('format_text', { old_text: A, highlight: 'green', line: 2 }), op('format_text', { old_text: A, highlight: 'green', line: 5 }),
    ...others.map((t) => op('format_text', { old_text: t, highlight: 'green' }))));
  assert.ok(w2._ok && w2._message === 'Made 6 edits', w2.content);
  for (let l = 2; l <= 7; l++) assert.ok(highlighted(l), `line ${l}`);
  pushTool(await undo());
  assert.strictEqual(RF(1, 8), before);
});

test('edit_document: line on replace; all: true between text edits that move indices; verified and undone in one step', async () => {
  await fresh(refs());
  const before = { t: texts(), f: RF(1, 8) };
  let e = await ed(op('replace', { old_text: A, new_text: '[x]', line: 4 }));
  assert.ok(e.content.startsWith('Error: operation 1 (replace «[10.1016/j.bpj.2022.08.002]»): old_text was not found on line 4; it occurs on lines 2, 5.'), e.content);
  const w = pushTool(await ed(op('replace', { old_text: 'Jones 2021.', new_text: 'Jones, Brown and Green 2021.' }),
    op('format_text', { old_text: A, bold: true, all: true }), op('insert', { line: 6, text: 'Inserted line' })));
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(texts().slice(0, 8), ['References', `Smith 2022. ${A}`, 'Jones, Brown and Green 2021. [10.1021/acs.jpcb.1c01234]', 'Lee 2020. [10.1063/5.0012345]', `Smith 2022b. ${A}`, 'Park 2019. [10.1103/PhysRevE.99.012345]', 'Inserted line', 'Kim 2018. [10.1039/c8cp01234a]']);
  assert.ok(/\*\*\[10\.1016/.test(RF(2, 2)) && /\*\*\[10\.1016/.test(RF(5, 5)), RF(1, 9));
  pushTool(await undo());
  deq({ t: texts(), f: RF(1, 8) }, before);
  // replace with line in a batch
  const w2 = pushTool(await ed(op('replace', { old_text: 'Smith 2022', new_text: 'Smyth 2022', line: 5 }), op('format_text', { old_text: A, italic: true, line: 2 })));
  assert.ok(w2._ok, w2.content);
  deq([texts()[1], texts()[4]], [`Smith 2022. ${A}`, `Smyth 2022b. ${A}`]);
  assert.ok(/\*\[10\.1016/.test(RF(2, 2)), RF(2, 2));
});

test('line counts as a line number: after an edit that moved lines in the same response, a call with line is refused', async () => {
  await fresh(refs());
  pushTool(await exec('insert_after_line', { line: 1, text: 'New first' }));
  let e = await exec('format_text', fmt({ old_text: A, bold: true, line: 6 }), 'x1', true);
  assert.ok(!e._ok && /line numbers changed after the previous edit in this response/.test(e.content), e.content);
  e = await exec('replace_text', { old_text: A, new_text: '[x]', line: 6 }, 'x2', true);
  assert.ok(!e._ok && /line numbers changed/.test(e.content), e.content);
  e = await ed(op('format_text', { old_text: A, bold: true, line: 6 }));
  assert.ok(e._ok, 'a new response: the numbers read since are valid');
  // without line the text-addressed tools still go after an edit of the same response
  pushTool(await exec('insert_after_line', { line: 1, text: 'Another' }));
  const ok = await exec('format_text', fmt({ old_text: 'Kim 2018.', italic: true }), 'x3', true);
  assert.ok(ok._ok, ok.content);
});

test('schemas: line and all on the single tools and the edit_document operation; compact schemas drop their nulls', () => {
  const ft = T.TOOL_DEFS.format_text.function.parameters;
  deq(ft.properties.line, { anyOf: [{ type: 'integer' }, { type: 'null' }] });
  deq(ft.properties.all, { anyOf: [{ type: 'boolean' }, { type: 'null' }] });
  deq(T.TOOL_DEFS.replace_text.function.parameters.required, ['old_text', 'new_text', 'line']);
  const c = T.compactSchema(ft);
  deq([c.properties.line, c.properties.all, c.required], [{ type: 'integer' }, { type: 'boolean' }, ['old_text']]);
  deq(T.compactSchema(T.TOOL_DEFS.replace_text.function.parameters).required, ['old_text', 'new_text']);
  assert.ok(/line: search only that line when the text occurs several times; all: true formats every occurrence/.test(T.TOOL_DEFS.format_text.function.description));
  assert.ok(/line: search only that line when the text occurs several times/.test(T.TOOL_DEFS.replace_text.function.description));
});
