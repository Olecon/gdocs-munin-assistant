'use strict';
// Headings: insert_after_line with a style (Normal text by default, also after a heading; a chosen style; a heading
// after a list item; verification and undo), replace_text that appends a paragraph to a heading, heading numbers
// (format_lines numbers: set / clear, depth, ranges, mixed existing numbers, one batch, one undo), the structure check
// (src/headings.js: findings, only new ones, the row of the turn and the next turn's context line), the schema texts and rule 7.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor, turnRowTexts } = require('./lib/sandbox');
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
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const texts = () => fake.text('t.0').split('\n');
const styles = () => fake.styles('t.0');
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const undo = () => exec('undo_last_edit', {});
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const ins = (at, text) => ({ insertText: { location: { index: at, tabId: 't.0' }, text } });
const del = (s, e) => ({ deleteContentRange: { range: range(s, e) } });
const pstyle = (s, e, style) => ({ updateParagraphStyle: { range: range(s, e), paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } });
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });

// ---- Schema and rule 7 ---------------------------------------------------------------------------------------------
test('schema: insert_after_line takes a nullable style, format_lines a nullable numbers; rule 7 says Normal and numbers', () => {
  const p = T.TOOL_DEFS.insert_after_line.function.parameters;
  deq(p.required, ['line', 'text', 'style', 'fill']);
  deq(p.properties.fill, { anyOf: [{ type: 'boolean' }, { type: 'null' }] });
  assert.ok(T.TOOL_DEFS.insert_after_line.function.description.includes('fill: true writes it into line when empty (an empty document: line 1)'));
  deq(T.compactSchema(p).required, ['line', 'text']); // Munin: style and fill optional
  deq(p.properties.style, { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'null = normal; h1-h6, title, subtitle: every line; outline: "# ", "## "… lines headings, others normal' });
  const f = T.TOOL_DEFS.format_lines.function.parameters.properties.numbers;
  // where the numbered heading text starts: the sheet's numbers entry, said in the numbers field (not in the head)
  deq(f, { anyOf: [{ type: 'string', enum: ['set', 'typed', 'clear'] }, { type: 'null' }], description: 'set: the sheet entry "numbers 0.6/0.9/1.2" (cm) or "numbers docs" sets where the heading text starts' });
  assert.ok(T.TOOL_DEFS.format_lines.function.description.includes('set = Docs numbering of the headings (1., 1.1.), typed = numbers written into the heading text, clear = remove'));
  assert.ok(!T.FORMATTING_PROMPT_LINE.includes('numbers 0.6'));
  const rules = T.apiEditRules();
  // Normal text by default and number_headings in edit_document: the definitions say it; the rule says when
  assert.ok(rules.includes('a newline starts a paragraph') && rules.includes('Headings: insert_after_line with style (h1-h6 apply to every line; a heading with its text: outline).') && rules.includes('heading numbers: format_lines numbers: set (S1: typed, prefix "S"); never type numbers or bullets.'), rules);
  assert.ok(!rules.includes('takes the formatting of the place'));
  assert.strictEqual(T.formatLinesArgsText(fl(1, 9, { numbers: 'set' })), 'heading numbers');
  assert.strictEqual(T.formatLinesArgsText(fl(1, 9, { numbers: 'clear' })), 'heading numbers removed');
  assert.strictEqual(T.formatLinesArgsText(fl(1, 9, { numbers: 'typed' })), 'typed heading numbers');
});

// ---- insert_after_line with a style ---------------------------------------------------------------------------------
// Lines: 1 Report (title), 2 Intro, 3 Methods (h1), 4 Alpha, 5-6 a bulleted list, 7 Conclusions (h1), 8 Last item (a list
// item, the last line).
const listSpec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'Intro' },
  { p: 'Methods', style: 'HEADING_1' },
  { p: 'Alpha' },
  { p: 'One', bullet: { listId: 'kix.a', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  { p: 'Two', bullet: { listId: 'kix.a', level: 0 } },
  { p: 'Conclusions', style: 'HEADING_1' },
  { p: 'Last item', bullet: { listId: 'kix.b', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
] });

test('insert_after_line: Normal text after a heading by default, verified, one undo restores text and styles', async () => {
  await fresh(listSpec());
  const before = { t: texts(), s: styles() };
  const end = as.model.lines[2].end; // the newline of line 3
  const w = pushTool(await exec('insert_after_line', { line: 3, text: 'First under Methods', style: null }));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [ins(end, '\nFirst under Methods'), pstyle(end + 1, end + 20, 'NORMAL_TEXT'),
    // the formatting sheet's body values (the default: Times New Roman 12 justify space 0/0)
    { updateTextStyle: { range: { startIndex: end + 1, endIndex: end + 20, tabId: 't.0' }, textStyle: { weightedFontFamily: { fontFamily: 'Times New Roman', weight: 400 }, fontSize: { magnitude: 12, unit: 'PT' } }, fields: 'weightedFontFamily,fontSize' } },
    { updateParagraphStyle: { range: { startIndex: end + 1, endIndex: end + 20, tabId: 't.0' }, paragraphStyle: { alignment: 'JUSTIFIED', spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } }, fields: 'alignment,spaceAbove,spaceBelow' } }]);
  deq(texts().slice(2, 5), ['Methods', 'First under Methods', 'Alpha']);
  deq(styles().slice(2, 5), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  assert.ok(w.content.startsWith('Done: inserted after line 3; now line 4; the document has 9 lines.'), w.content);
  assert.ok(!w.content.includes('Note:'), w.content);
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq({ t: texts(), s: styles() }, before);
});

test('insert_after_line: a chosen style (h2 after body text, loose names, title at line 0); an invalid style is refused', async () => {
  await fresh(listSpec());
  const before = { t: texts(), s: styles() };
  let w = pushTool(await exec('insert_after_line', { line: 4, text: 'Results\nThe results.', style: 'h2' }));
  assert.ok(w._ok, w.content);
  deq(styles().slice(3, 7), ['NORMAL_TEXT', 'HEADING_2', 'HEADING_2', 'NORMAL_TEXT']); // every new paragraph gets the style
  w = pushTool(await exec('insert_after_line', { line: 0, text: 'Draft', style: 'Title' }));
  assert.ok(w._ok, w.content);
  deq(styles().slice(0, 2), ['TITLE', 'TITLE']);
  w = pushTool(await exec('insert_after_line', { line: 1, text: 'Sub', style: 'Heading 3' }));
  assert.ok(w._ok, w.content);
  deq(styles().slice(0, 3), ['TITLE', 'HEADING_3', 'TITLE']);
  for (let i = 0; i < 3; i++) assert.ok((await undo())._ok);
  deq({ t: texts(), s: styles() }, before); // line 4 is body text again, not a heading
  const bad = await exec('insert_after_line', { line: 2, text: 'x', style: 'huge' });
  deq([bad._ok, bad.content], [false, 'Error: style must be one of title, subtitle, h1…h6, normal, outline (got "huge")']);
});

test('insert_after_line: after a list item Normal continues the list; a heading goes before the next line without a bullet', async () => {
  await fresh(listSpec());
  const before = { t: texts(), s: styles(), b: JSON.stringify(fake.bullets('t.0')) };
  let w = pushTool(await exec('insert_after_line', { line: 6, text: 'Three', style: null }));
  assert.ok(w._ok, w.content);
  deq(fake.bullets('t.0').slice(4, 7).map((b) => !!b), [true, true, true]); // the new line is a list item too
  assert.ok((await undo())._ok);
  const at = as.model.lines[6].start; // line 7, Conclusions
  w = pushTool(await exec('insert_after_line', { line: 6, text: 'Discussion', style: 'h1' }));
  assert.ok(w._ok, w.content);
  deq(texts().slice(5, 8), ['Two', 'Discussion', 'Conclusions']);
  deq(styles().slice(5, 8), ['NORMAL_TEXT', 'HEADING_1', 'HEADING_1']);
  deq(fake.bullets('t.0').slice(4, 7).map((b) => !!b), [true, true, false]);
  deq(lastPost().requests[0], ins(at, 'Discussion\n')); // at the start of line 7
  assert.ok((await undo())._ok);
  deq({ t: texts(), s: styles(), b: JSON.stringify(fake.bullets('t.0')) }, before); // "Two" keeps its bullet
  const n = posts();
  const e = await exec('insert_after_line', { line: 8, text: 'Appendix', style: 'h1' });
  assert.strictEqual(e._ok, false);
  assert.ok(e.content.startsWith('Error: line 8 is a list item at the end of its part of the document, so a h1 cannot be inserted right after it.'), e.content);
  assert.strictEqual(posts(), n);
});

test('insert_after_line: the result names the lines when the re-read document shows another style', async () => {
  await fresh(listSpec());
  const plan = T.planInsert(as.model, { line: 4, text: 'Results', style: 'h2' });
  assert.strictEqual(plan.report(as.model).split('\n')[0], 'Note: Google Docs did not apply all of it (not shown: style h2); line 5 now reads:'); // line 5 is still "One"
});

test('replace_text: a paragraph appended to a heading is Normal text; the heading stays; undo restores', async () => {
  await fresh(listSpec());
  const before = { t: texts(), s: styles() };
  const w = pushTool(await exec('replace_text', { old_text: 'Conclusions', new_text: 'Conclusions\nWe found it.' }));
  assert.ok(w._ok, w.content);
  deq(texts().slice(6, 8), ['Conclusions', 'We found it.']);
  deq(styles().slice(6, 8), ['HEADING_1', 'NORMAL_TEXT']);
  assert.ok((await undo())._ok);
  deq({ t: texts(), s: styles() }, before);
  // A heading rewritten into two lines keeps the heading style on both (the old text changed, not only appended).
  const w2 = pushTool(await exec('replace_text', { old_text: 'Methods', new_text: 'Materials\nMethods used' }));
  assert.ok(w2._ok, w2.content);
  deq(styles().slice(2, 4), ['HEADING_1', 'HEADING_1']);
});

// ---- Heading numbers ------------------------------------------------------------------------------------------------
// Mixed existing numbers: Roman, decimal with and without a dot, a letter; a year is not a number; a heading in a table is
// left alone; title and subtitle are never numbered.
const numSpec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'A subtitle', style: 'SUBTITLE' },
  { p: 'I. Background', style: 'HEADING_1' },
  { p: 'Body text.' },
  { p: '1.1 Scope', style: 'HEADING_2' },
  { p: 'Aims', style: 'HEADING_2' },
  { p: 'A. Detail', style: 'HEADING_3' },
  { p: 'Deep', style: 'HEADING_4' },
  { p: '3. Methods', style: 'HEADING_1' },
  { p: '2020 in review', style: 'HEADING_2' },
  { p: '4.2. Sample', style: 'HEADING_2' },
] });
const NUMBERED = ['Report', 'A subtitle', '1 Background', 'Body text.', '1.1 Scope', '1.2 Aims', '1.2.1 Detail', 'Deep', '2 Methods', '2.1 2020 in review', '2.2 Sample'];

test('numbers typed: h1–h3 numbered hierarchically, existing numbers replaced, one batch, verified; one undo restores', async () => {
  await fresh(numSpec());
  const before = texts();
  const n = posts();
  const start3 = as.model.lines[2].start;
  const w = pushTool(await exec('format_lines', fl(1, 11, { numbers: 'typed' })));
  assert.ok(w._ok, w.content);
  assert.strictEqual(posts(), n + 1); // one batchUpdate
  deq(texts(), NUMBERED);
  assert.strictEqual(w.content, 'Done: numbered 6 headings on lines 3, 6, 7, 9, 10, 11; the document has 11 lines.');
  deq([w._edit.kind, w._edit.changes.length, w._message], ['number-headings', 6, 'Numbered 6 headings']);
  assert.strictEqual(w._cardText.split('\n')[0], '1 Background');
  // the requests go back to front: the first heading ("I. " at line 3) last
  const reqs = lastPost().requests;
  deq(reqs.slice(-2), [del(start3, start3 + 3), ins(start3, '1 ')]);
  assert.ok(reqs.findIndex((r) => r.insertText && r.insertText.text === '2.2 ') < reqs.findIndex((r) => r.insertText && r.insertText.text === '1 '));
  // the same call again: nothing to change
  const again = await exec('format_lines', fl(1, 11, { numbers: 'typed' }));
  deq([again._ok, again.content], [true, 'No change: the 7 headings in the document are already numbered this way.']);
  assert.strictEqual(posts(), n + 1);
  const u = await undo();
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: undid the heading numbers of 6 headings.'), u.content);
  deq(texts(), before);
});

test('numbers clear: every leading number goes (all depths); a second clear is no change; numbers leaves list and indents to itself', async () => {
  await fresh(numSpec());
  let w = pushTool(await exec('format_lines', fl(1, 11, { numbers: 'clear' })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Report', 'A subtitle', 'Background', 'Body text.', 'Scope', 'Aims', 'Detail', 'Deep', 'Methods', '2020 in review', 'Sample']);
  assert.strictEqual(w._message, 'Removed the numbers of 5 headings');
  w = await exec('format_lines', fl(1, 11, { numbers: 'clear' }));
  deq([w._ok, w.content], [true, 'No change: the 8 headings in the document are not numbered.']);
  w = await exec('format_lines', fl(1, 11, { numbers: 'set', indent_start: 10, list: 'none' }));
  deq([w._ok, w.content], [false, 'Error: numbers writes the headings\' list and indents itself: send the call without list, indent_start']);
  w = await exec('format_lines', fl(1, 2, { numbers: 'set' }));
  assert.strictEqual(w._ok, false);
  assert.ok(w.content.startsWith('Error: lines 1–2 has no headings (h1–h6, the top 3 levels) to number. Title and subtitle are never numbered'), w.content);
  w = await exec('format_lines', fl(1, 11, { numbers: 'renumber' }));
  deq([w._ok, w.content], [false, 'Error: action must be set, typed or clear']);
});

test('undo of numbers clear and numbers set puts a typed number back in its own style, not the heading text\'s', async () => {
  // a plain "1. " before bold heading text, and a red "2. " before plain text (bold with the font Docs stores with it)
  const items = [{ p: '1. Intro', style: 'HEADING_1', fmt: [[3, 8, { bold: true, font: 'Arial' }]] }, { p: 'Body.' },
    { p: '2. End', style: 'HEADING_1', fmt: [[0, 3, { color: '#FF0000' }]] }, { p: 'Body.' }];
  await fresh(docSpec({ items }));
  const before = fake.fmt('t.0');
  const w = pushTool(await exec('format_lines', fl(1, 4, { numbers: 'clear' })));
  assert.ok(w._ok, w.content);
  deq(w._edit.changes.map((c) => (c.restoreStyles ? c.restoreStyles.map(([s, e, st]) => [s, e, st.color]) : null)), [null, [[0, 3, '#FF0000']]]);
  assert.ok((await undo())._ok);
  deq([texts(), fake.fmt('t.0')], [['1. Intro', 'Body.', '2. End', 'Body.'], before]);
  // numbers set (Google Docs numbering): its undo too
  await fresh(docSpec({ items }));
  assert.ok(pushTool(await exec('format_lines', fl(1, 4, { numbers: 'set' })))._ok);
  deq(texts(), ['Intro', 'Body.', 'End', 'Body.']);
  assert.ok((await undo())._ok);
  deq([texts(), fake.fmt('t.0')], [['1. Intro', 'Body.', '2. End', 'Body.'], before]);
});

test('numbers typed in a range: the numbers count the whole document, only the range is written', async () => {
  await fresh(numSpec());
  const w = pushTool(await exec('format_lines', fl(9, 11, { numbers: 'typed' })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Report', 'A subtitle', 'I. Background', 'Body text.', '1.1 Scope', 'Aims', 'A. Detail', 'Deep', '2 Methods', '2.1 2020 in review', '2.2 Sample']);
});

test('numbers typed: the depth (levels) and a document whose top headings are h2', async () => {
  await fresh(numSpec());
  let plan = T.planNumberHeadings(as.model, { action: 'typed', levels: 1 });
  deq(plan.journal.changes.map((c) => c.after), ['1 Background', '2 Methods']);
  plan = T.planNumberHeadings(as.model, { action: 'typed', levels: 4 });
  assert.strictEqual(plan.error, 'levels must be an integer from 1 to 3');
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_2' }, { p: 'Part', style: 'HEADING_3' }, { p: 'Next', style: 'HEADING_2' }, { p: 'x' }] }));
  const w = pushTool(await exec('format_lines', fl(1, 4, { numbers: 'typed' })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['1 Intro', '1.1 Part', '2 Next', 'x']);
});

test('numbers typed under a title h1 (the only h1, first): the sections are 1, 2, 2.1, 3; a range, levels, a former title number, clear', async () => {
  const si = (title = 'Supporting Information', h = ['Software', 'Spectra', 'Fits', 'Tables']) => docSpec({ items: [
    { p: title, style: 'HEADING_1' }, { p: 'Authors.' }, { p: h[0], style: 'HEADING_2' }, { p: 'Body.' },
    { p: h[1], style: 'HEADING_2' }, { p: h[2], style: 'HEADING_3' }, { p: h[3], style: 'HEADING_2' },
  ] });
  await fresh(si());
  let w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'typed' })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Supporting Information', 'Authors.', '1 Software', 'Body.', '2 Spectra', '2.1 Fits', '3 Tables']);
  assert.strictEqual(w.content, 'Done: numbered 4 headings on lines 3, 5, 6, 7; the document has 7 lines.');
  w = await exec('format_lines', fl(1, 7, { numbers: 'typed' }));
  deq([w._ok, w.content], [true, 'No change: the 4 headings in the document are already numbered this way.']);
  // a range counts the whole document; levels 1 is the sections
  await fresh(si());
  assert.ok(pushTool(await exec('format_lines', fl(5, 7, { numbers: 'typed' })))._ok);
  deq(texts(), ['Supporting Information', 'Authors.', 'Software', 'Body.', '2 Spectra', '2.1 Fits', '3 Tables']);
  await fresh(si());
  deq(T.planNumberHeadings(as.model, { action: 'typed', levels: 1 }).journal.changes.map((c) => c.after), ['1 Software', '2 Spectra', '3 Tables']);
  // numbered before the title rule: the title's number goes, the sections move up a level
  await fresh(si('1 Supporting Information', ['1.1 Software', '1.2 Spectra', '1.2.1 Fits', '1.3 Tables']));
  w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'typed' })));
  deq(texts(), ['Supporting Information', 'Authors.', '1 Software', 'Body.', '2 Spectra', '2.1 Fits', '3 Tables']);
  assert.strictEqual(w.content, 'Done: numbered 4 headings on lines 3, 5, 6, 7; removed the number of the title on line 1; the document has 7 lines.');
  assert.ok((await undo())._ok);
  deq(texts(), ['1 Supporting Information', 'Authors.', '1.1 Software', 'Body.', '1.2 Spectra', '1.2.1 Fits', '1.3 Tables']);
  // clear takes the title's number too
  w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'clear' })));
  deq(texts(), ['Supporting Information', 'Authors.', 'Software', 'Body.', 'Spectra', 'Fits', 'Tables']);
  assert.strictEqual(w._message, 'Removed the numbers of 5 headings');
  // a lone h1 is no title (nothing below it): numbered as before
  await fresh(docSpec({ items: [{ p: 'Only', style: 'HEADING_1' }, { p: 'Text.' }] }));
  assert.ok(pushTool(await exec('format_lines', fl(1, 2, { numbers: 'typed' })))._ok);
  deq(texts(), ['1 Only', 'Text.']);
});

// Supporting information under a title h1: 1 title, 2 body, 3 h2, 4 body, 5 h2, 6 h3, 7 h2.
const siSpec = (h = ['Software', 'Spectra', 'Fits', 'Tables']) => docSpec({ items: [
  { p: 'Supporting Information', style: 'HEADING_1' }, { p: 'Authors.' }, { p: h[0], style: 'HEADING_2' }, { p: 'Body.' },
  { p: h[1], style: 'HEADING_2' }, { p: h[2], style: 'HEADING_3' }, { p: h[3], style: 'HEADING_2' },
] });
const SI_NUMBERED = ['Supporting Information', 'Authors.', 'S1 Software', 'Body.', 'S2 Spectra', 'S2.1 Fits', 'S3 Tables'];

test('numbers typed with a prefix: S1, S2, S2.1 under the title; already numbered, renumbered, replaced plain numbers, undone', async () => {
  await fresh(siSpec());
  let w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'typed', prefix: 'S' })));
  assert.ok(w._ok, w.content);
  deq(texts(), SI_NUMBERED);
  assert.strictEqual(w.content, 'Done: numbered 4 headings on lines 3, 5, 6, 7; the document has 7 lines.');
  // recognised as numbered: the same call is no change
  w = await exec('format_lines', fl(1, 7, { numbers: 'typed', prefix: 'S' }));
  deq([w._ok, w.content], [true, 'No change: the 4 headings in the document are already numbered this way.']);
  assert.ok((await undo())._ok);
  deq(texts(), siSpec().tabs[0].items.map((i) => i.p));
  // sections moved or numbered by hand ("S1.", a gap, one missing): renumbered; plain numbers get the prefix
  await fresh(siSpec(['S1. Software', 'S3 Spectra', 'Fits', '2 Tables']));
  w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'typed', prefix: 'S' })));
  assert.ok(w._ok, w.content);
  deq(texts(), SI_NUMBERED);
  assert.ok((await undo())._ok);
  deq(texts(), ['Supporting Information', 'Authors.', 'S1. Software', 'Body.', 'S3 Spectra', 'Fits', '2 Tables']);
  // the edit_document operation takes it too
  await fresh(siSpec());
  w = pushTool(await exec('edit_document', { operations: [{ op: 'number_headings', start: null, end: null, numbers: 'typed', prefix: 'S' }] }));
  assert.ok(w._ok, w.content);
  deq(texts(), SI_NUMBERED);
});

test('numbers clear with a prefix removes S numbers (without it they are text); set refuses a prefix; a bad prefix is refused', async () => {
  await fresh(siSpec(['S1 Software', 'S2 Spectra', 'S2.1 Fits', 'S3 Tables']));
  // without the prefix an S number is not taken for one (a heading such as "T1 relaxation" stays as written)
  let w = await exec('format_lines', fl(1, 7, { numbers: 'clear' }));
  deq([w._ok, w.content], [true, 'No change: the 5 headings in the document are not numbered.']);
  w = pushTool(await exec('format_lines', fl(1, 7, { numbers: 'clear', prefix: 'S' })));
  assert.ok(w._ok, w.content);
  deq(texts(), siSpec().tabs[0].items.map((i) => i.p));
  assert.ok((await undo())._ok);
  deq(texts(), SI_NUMBERED);
  w = await exec('format_lines', fl(1, 7, { numbers: 'set', prefix: 'S' }));
  deq([w._ok, w.content], [false, 'Error: Google Docs numbering takes no prefix: use numbers typed with the prefix']);
  for (const prefix of ['S1', ' S', 'A\nB', 'x'.repeat(13), 5]) {
    w = await exec('format_lines', fl(1, 7, { numbers: 'typed', prefix }));
    deq([w._ok, w.content], [false, 'Error: prefix must be the letters before the numbers, such as "S" (S1, S1.1) or "A." (A.1), not ending with a digit'], JSON.stringify(prefix));
  }
  // null and "" are no prefix
  await fresh(siSpec(['S1 Software', 'S2 Spectra', 'S2.1 Fits', 'S3 Tables']));
  for (const prefix of [null, '', 'null']) deq(T.planNumberHeadings(as.model, { action: 'clear', prefix }).reply.content, 'No change: the 5 headings in the document are not numbered.');
});

test('numbers typed with a prefix in a range: a numbering of its own from 1 (the paper\'s sections are not counted); appendix A.1', async () => {
  const doc = () => docSpec({ items: [
    { p: 'Introduction', style: 'HEADING_1' }, { p: 'Text.' }, { p: 'Methods', style: 'HEADING_1' }, { p: 'Text.' },
    { p: 'Supporting Information', style: 'HEADING_1' }, { p: 'Software', style: 'HEADING_2' }, { p: 'Spectra', style: 'HEADING_2' }, { p: 'Fits', style: 'HEADING_3' },
    { p: 'Appendix A', style: 'HEADING_1' }, { p: 'Data', style: 'HEADING_2' }, { p: 'Code', style: 'HEADING_2' },
  ] });
  await fresh(doc());
  // without a prefix a range counts the whole document, as before
  deq(T.planNumberHeadings(as.model, { action: 'typed', start_line: 5, end_line: 8 }).journal.changes.map((c) => c.after),
    ['3 Supporting Information', '3.1 Software', '3.2 Spectra', '3.2.1 Fits']);
  // with one, the range's own title rule and depths: the SI heading is its title
  let w = pushTool(await exec('format_lines', fl(5, 8, { numbers: 'typed', prefix: 'S' })));
  assert.ok(w._ok, w.content);
  w = pushTool(await exec('format_lines', fl(9, 11, { numbers: 'typed', prefix: 'A.' })));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Introduction', 'Text.', 'Methods', 'Text.', 'Supporting Information', 'S1 Software', 'S2 Spectra', 'S2.1 Fits', 'Appendix A', 'A.1 Data', 'A.2 Code']);
  // and the appendix numbers are recognised again with their prefix
  w = await exec('format_lines', fl(9, 11, { numbers: 'typed', prefix: 'A.' }));
  deq([w._ok, w.content], [true, 'No change: the 2 headings in lines 9–11 are already numbered this way.']);
});

test('numbers typed undo: refused when a numbered heading changed afterwards; text inserted above is followed', async () => {
  await fresh(numSpec());
  pushTool(await exec('format_lines', fl(1, 11, { numbers: 'typed' })));
  fake.typeParagraph(0, 'Typed above');
  let u = await undo();
  assert.ok(u._ok, u.content); // moved: found again by its text
  deq(texts().slice(1), numSpec().tabs[0].items.map((i) => i.p));
  pushTool(await exec('format_lines', fl(1, 12, { numbers: 'typed' })));
  const r = await exec('replace_text', { old_text: '1.2 Aims', new_text: '1.2 Aims and limits' });
  assert.ok(r._ok, r.content);
  state.messages = state.messages.filter((m) => m !== r); // only the numbering is in the journal
  u = await undo();
  assert.strictEqual(u._ok, false);
  assert.ok(u.content.includes('the headings of that edit changed after it, so it cannot be undone automatically'), u.content);
});

// ---- The structure check ----------------------------------------------------------------------------------------------
const model = (items) => ({ lines: items.map(([text, style], i) => ({ line: i + 1, text, style: style || 'NORMAL_TEXT',
  heading: /^HEADING_(\d)$/.test(style || '') ? Number(style.slice(-1)) : style === 'TITLE' ? 1 : style === 'SUBTITLE' ? 2 : 0 })) });
const H1 = 'HEADING_1'; const H2 = 'HEADING_2'; const H3 = 'HEADING_3';

test('structureFindings: skipped and duplicated numbers, level jumps, body text left in a heading style, empty headings', () => {
  const f = T.structureFindings(model([
    ['Report', 'TITLE'], ['1 Intro', H1], ['1.1 Aims', H2], ['1.3 Scope', H2], ['1.3 Again', H2], ['2 Methods', H1],
    ['Detail', H3], ['Conclusions', H1], ['We found that the effect holds in every sample.', H1], ['', H2], ['4 Last', H1],
  ]));
  deq(f.map((x) => x.text), [
    'heading 1.3 follows 1.1 (1.2 is missing)',
    'heading 1.3 appears twice (lines 4 and 5)',
    '«Detail» (line 7) is H3 right after H1 «2 Methods»',
    '«We found that the effect holds in every …» after «Conclusions» is still a heading (line 9)',
    'line 10 is an empty heading',
    'heading 4 follows 2 (3 is missing)',
  ]);
  deq(T.structureFindings(model([['1 A', H1], ['1.1 B', H2], ['1.1.1 C', H3], ['2 D', H1], ['2.1 E', H2]])), []);
  deq(T.structureFindings(model([['1 A', H1], ['1.1.1 C', H2]])).map((x) => x.text), ['heading 1.1.1 follows 1 (a level is skipped)']);
  deq(T.structureFindings(model([['1 A', H1], ['3.1 C', H2]])).map((x) => x.text), ['heading 3.1 follows 1 (expected 1.1)']);
  // a short heading after a heading of the same style is a heading (a section without body), not body text
  deq(T.structureFindings(model([['Results', H1], ['Discussion', H1]])), []);
});

test('structureFindings: a number typed in a body line is named as such, not "missing"; body text after an empty heading', () => {
  // the saved chat: 2.1 and 2.2 existed as typed numbers in body lines, and the line said "2.1 is missing"
  deq(T.structureFindings(model([['2 Methods', H1], ['2.1 Model objects'], ['Text.'], ['2.2 Charges'], ['2.4 Dynamics', H2]])).map((x) => x.text),
    ['heading 2.4 follows 2 (2.1 is body text on line 2)']);
  deq(T.structureFindings(model([['1 A', H1], ['1.1 B', H2], ['1.2 Typed'], ['1.4 D', H2]])).map((x) => x.text),
    ['heading 1.4 follows 1.1 (1.2 is body text on line 3)']);
  // a typed number outside the two headings does not count
  deq(T.structureFindings(model([['3.1 Early'], ['3 Results', H1], ['3.2 B', H2]])).map((x) => x.text), ['heading 3.2 follows 3 (3.1 is missing)']);
  // an inserted section made every line a heading: the sentence after the empty heading is found too
  deq(T.structureFindings(model([['Conclusions', H1], ['Results', H3], ['Using', H3], ['', H3], ['We found that the effect holds in every sample.', H3]])).map((x) => x.text), [
    '«Results» (line 2) is H3 right after H1 «Conclusions»',
    'line 4 is an empty heading',
    '«We found that the effect holds in every …» after «Using» is still a heading (line 5)',
  ]);
});

test('structureFinish: only what the turn introduced, only after an edit; the next turn gets one line while it is still true', async () => {
  await fresh(docSpec({ items: [{ p: '1 Intro', style: H1 }, { p: 'Text.' }, { p: '2 Methods', style: H1 }, { p: 'Body.' }, { p: 'Detail', style: H3 }] }));
  const u = { role: 'user', content: 'Go.' };
  const chat = (...msgs) => ({ docId: 'DOC123', chatId: 'c1', messages: [u, ...msgs] });
  // the start already has the level jump: not reported
  const w = await exec('insert_after_line', { line: 3, text: '4 Results', style: 'h1' });
  assert.ok(w._ok, w.content);
  deq(T.structureFinish(u, as, chat()), []); // no edit in this turn's messages
  const found = T.structureFinish(u, as, chat(w));
  deq(found.map((x) => x.text), ['heading 4 follows 2 (3 is missing)']);
  // the hook: a row of the turn, and a line for the next turn of the document
  T.runTurnHooks('finish', u, as, chat(w));
  const next = T.takeSnapshot(); T.snapshotDocument(next);
  next.docId = 'DOC123';
  // what it is for, said at its end: information, not the task (the saved chat restructured on a request about fonts)
  assert.strictEqual(T.structureLine(next), 'After the last edits: heading 4 follows 2 (3 is missing). Mention it in a sentence if relevant; restructure only if the user asks.');
  assert.strictEqual(T.structureLine(next), ''); // once
  // fixed before the next turn: no line
  T.runTurnHooks('finish', u, as, chat(w));
  const fix = await exec('replace_text', { old_text: '4 Results', new_text: '3 Results' }); // a typed section number: no refusal (prose-lint.js)
  assert.ok(fix._ok, fix.content);
  const later = T.takeSnapshot(); T.snapshotDocument(later);
  later.docId = 'DOC123';
  assert.strictEqual(T.structureLine(later), '');
});

test('the structure row: two findings and "and N more", the full list in its fold, stored on the turn\'s last message', async () => {
  const fs = ['a', 'b', 'c', 'd'].map((t) => ({ key: t, text: `finding ${t}` }));
  deq(T.structureNotice(fs), { text: 'Structure check: finding a; finding b; and 2 more.', title: 'finding a\nfinding b\nfinding c\nfinding d' });
  deq(T.structureNotice(fs.slice(0, 2)), { text: 'Structure check: finding a; finding b.', title: '' });
  // the hook: one row of the turn on its last message, the whole list as its detail
  await fresh(docSpec({ items: [{ p: 'Intro', style: H1 }, { p: 'Text.' }] }));
  const u = { role: 'user', content: 'Go.' };
  const w = await exec('insert_after_line', { line: 2, text: '# A\n### B\n# C\n### D\n# E\n### F', style: 'outline' });
  assert.ok(w._ok, w.content);
  state.docId = 'DOC123'; state.busy = false;
  T.runTurnHooks('finish', u, as, { docId: 'DOC123', chatId: 'c1', messages: [u, w] });
  assert.strictEqual(w._notes.length, 1);
  assert.match(w._notes[0].text, /^Structure check: [^;]+; [^;]+; and 1 more\.$/);
  assert.strictEqual(w._notes[0].detail.split('\n').length, 3);
});

test('a chat turn: the stray heading row of the turn and the context line of the next message', async () => {
  fake = fakeDocsServer(docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Conclusions', style: H1 }, { p: 'Last.' }] }));
  await T.createChat();
  T.el.chat.children.length = 0;
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
  const args = { line: 2, text: 'The effect holds in every sample we measured.', style: 'h1' };
  const rounds = [msgStart + tu(0, 'toolu_1', 'insert_after_line', args) + stopTool, textRound('Added.'), textRound('Fine.')];
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = 'Add a sentence after Conclusions';
  await T.sendMessage();
  const rows = () => turnRowTexts(T.el.chat);
  await waitFor(() => rows().some((t) => t.includes('Structure check')), 'the row');
  assert.ok(rows().includes('Structure check: «The effect holds in every sample we meas…» after «Conclusions» is still a heading (line 3).'), rows().join('|'));
  T.el.input.value = 'Thanks';
  await T.sendMessage();
  assert.ok(JSON.stringify(bodies[2]).includes('After the last edits: «The effect holds in every sample we meas…» after «Conclusions» is still a heading (line 3). Mention it in a sentence if relevant; restructure only if the user asks.'));
  assert.ok(!JSON.stringify(bodies[0]).includes('Structure check') && !JSON.stringify(bodies[0]).includes('After the last edits'));
});
