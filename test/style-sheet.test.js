'use strict';
// The formatting sheet (src/style-sheet.js): the Formatting: line's grammar (alignment words and space A/B too), the precedence (the call > DOC.md >
// MAIN.md > the default), the sheet on new paragraphs (insert_after_line with a style and an outline, edit_document,
// replace_section) and on style changes (format_lines style), text inside a paragraph never restyled, the numbering
// indents and the headings' text values, format_lines apply_sheet (a range, "No change", undo), exact undo, the
// first-run detection, the schema and the head line; the alignment and spacing on inserts, style changes and
// apply_sheet (list items and table cells left alone) and in the first-run detection.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench, registerFakeGet } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh, pushTool, lastPost;

// The named styles a test document has (srv.namedStyles), answered for the small read of fetchNamedStyles.
registerFakeGet((srv, url, params) => {
  if (!srv.namedStyles || !String(params.get('fields') || '').includes('namedStyles')) return null; // else the fake's own (Docs' defaults)
  const styles = Object.entries(srv.namedStyles || {}).map(([type, v]) => ({ namedStyleType: type, textStyle: {
    ...(v.font ? { weightedFontFamily: { fontFamily: v.font, weight: 400 } } : {}), ...(v.size ? { fontSize: { magnitude: v.size, unit: 'PT' } } : {}), ...(v.bold ? { bold: true } : {}) },
  paragraphStyle: { ...(v.alignment ? { alignment: v.alignment } : {}), ...(v.spaceAbove != null ? { spaceAbove: { magnitude: v.spaceAbove, unit: 'PT' } } : {}),
    ...(v.spaceBelow != null ? { spaceBelow: { magnitude: v.spaceBelow, unit: 'PT' } } : {}) } }));
  const doc = { tabs: srv.tabs.map((t) => ({ tabProperties: { tabId: t.id }, documentTab: { namedStyles: { styles } } })) };
  return { ok: true, status: 200, json: async () => doc, text: async () => JSON.stringify(doc) };
});

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null, apply_sheet: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });
const fmt = () => fake.fmt('t.0');
const texts = () => fake.text('t.0').split('\n');
const undo = async () => { const u = pushTool(await exec('undo_last_edit', {})); assert.ok(u._ok, u.content); return u; };
const TNR = 'Times New Roman';
const run = (n, extra = {}) => [0, n, { font: TNR, ...extra }];
// A fresh document with the given DOC.md and MAIN.md for the turn.
async function freshWith(spec, doc = '', main = '') {
  await fresh(spec);
  as.docInstructions = doc; as.mainInstructions = main;
}
const simple = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'Intro', style: 'HEADING_1' },
  { p: 'First body paragraph.' },
  { p: 'Methods', style: 'HEADING_2' },
  { p: 'Second body paragraph.' },
] });

test('parsing: the default line, case and spacing, partial entries, units, extra fields; invalid entries are ignored', () => {
  const d = T.parseStyleSheet(T.DEFAULT_FORMATTING_LINE);
  const sp = (above) => ({ spaceAbove: above, spaceBelow: 0, keepWithNext: true });
  deq(JSON.parse(JSON.stringify(d.entries)), { body: { font: TNR, size: 12, align: 'justify', spaceAbove: 0, spaceBelow: 0 }, h1: { size: 16, ...sp(18) }, h2: { size: 14, ...sp(14) },
    h3: { size: 12, ...sp(12) }, h4: { size: 12, ...sp(12) }, h5: { size: 12, ...sp(12) }, h6: { size: 12, ...sp(12) } });
  deq(d.ignored, []);
  const s = T.parseStyleSheet('Keep the term "lipid raft".\n  formatting :  BODY times new roman 11pt ;Heading 2   Arial 13 pt Bold ; h3 italic;normal text spacing 1.5 align justify first-line 18; title Georgia 20 center');
  deq(JSON.parse(JSON.stringify(s.entries)), {
    body: { font: TNR, size: 11, lineSpacing: 1.5, align: 'justify', firstLine: 18 },
    h2: { font: 'Arial', size: 13, bold: true }, h3: { italic: true }, title: { font: 'Georgia', size: 20, align: 'center' } });
  // a later line of the same file wins field by field; percent spacing; regular / upright unset bold and italic
  const m = T.parseStyleSheet('Formatting: h1 18 bold italic\nFormatting: h1 regular upright spacing 150%');
  deq(JSON.parse(JSON.stringify(m.entries)), { h1: { size: 18, bold: false, italic: false, lineSpacing: 1.5 } });
  // invalid: an unknown type, a size out of range, a lower-case unknown word (a typo), a missing value; the rest is read
  const bad = T.parseStyleSheet('Formatting: h7 12; h1 0; h2 blod 14; body spacing; h3 align diagonal; h4 first-line; h5 Linux Libertine 12');
  deq(bad.ignored, ['h7 12', 'h1 0', 'h2 blod 14', 'body spacing', 'h3 align diagonal', 'h4 first-line']);
  deq(JSON.parse(JSON.stringify(bad.entries)), { h5: { font: 'Linux Libertine', size: 12 } });
  // alignment words (bare or after align) and space above/below in pt; a bad word or value drops its entry only
  const al = T.parseStyleSheet('Formatting: body Arial 11 left space 6pt/3; h1 16 center space 18/0; h2 right; h3 align justified; h4 justify space 12; h5 space 6/x; h6 space 300/0; title 20 sideways');
  deq(JSON.parse(JSON.stringify(al.entries)), { body: { font: 'Arial', size: 11, align: 'left', spaceAbove: 6, spaceBelow: 3 },
    h1: { size: 16, align: 'center', spaceAbove: 18, spaceBelow: 0 }, h2: { align: 'right' }, h3: { align: 'justify' } });
  deq(al.ignored, ['h4 justify space 12', 'h5 space 6/x', 'h6 space 300/0', 'title 20 sideways']);
  assert.strictEqual(T.parseStyleSheet('No sheet here.'), null);
  assert.strictEqual(T.parseStyleSheet(''), null);
});

test('precedence: DOC.md over MAIN.md over the default, field by field; headings take the body font; title only when named', () => {
  let s = T.resolveStyleSheet('', '');
  assert.strictEqual(s.source, 'default');
  deq(JSON.parse(JSON.stringify(s.types.h1)), { size: 16, spaceAbove: 18, spaceBelow: 0, keepWithNext: true, font: TNR });
  deq(JSON.parse(JSON.stringify(s.types.body)), { font: TNR, size: 12, align: 'justify', spaceAbove: 0, spaceBelow: 0 });
  assert.strictEqual(s.types.title, undefined);
  s = T.resolveStyleSheet('', 'Formatting: body Arial 11 left; h1 18');
  assert.strictEqual(s.source, 'MAIN.md');
  deq(JSON.parse(JSON.stringify(s.types.body)), { font: 'Arial', size: 11, align: 'left', spaceAbove: 0, spaceBelow: 0 });
  deq(JSON.parse(JSON.stringify(s.types.h1)), { size: 18, spaceAbove: 18, spaceBelow: 0, keepWithNext: true, font: 'Arial' }); // no weight in the default; the font from the body
  s = T.resolveStyleSheet('Formatting: body Georgia center space 6/6; h1 regular; title 24', 'Formatting: body Arial 11 left; h1 18');
  assert.strictEqual(s.source, 'DOC.md');
  deq(JSON.parse(JSON.stringify(s.types.body)), { font: 'Georgia', size: 11, align: 'center', spaceAbove: 6, spaceBelow: 6 });
  deq(JSON.parse(JSON.stringify(s.types.h1)), { size: 18, spaceAbove: 18, spaceBelow: 0, keepWithNext: true, bold: false, font: 'Georgia' });
  deq(JSON.parse(JSON.stringify(s.types.title)), { size: 24, font: 'Georgia' });
  // the turn's frozen texts decide
  const snap = { docInstructions: 'Formatting: h2 20', mainInstructions: '' };
  assert.strictEqual(T.styleSheetFor(snap).types.h2.size, 20);
});

test('insert_after_line: a styled insert and an outline get the sheet; the call is verified and one undo removes it', async () => {
  await freshWith(simple());
  let w = pushTool(await exec('insert_after_line', { line: 3, text: 'Results', style: 'h1' }));
  assert.ok(w._ok, w.content);
  deq(fmt()[3], [run(7, { size: 16 })]);
  assert.ok(!w.content.includes('Note:'), w.content);
  await undo();
  deq(texts(), ['Report', 'Intro', 'First body paragraph.', 'Methods', 'Second body paragraph.']);
  deq(fmt(), [[], [], [], [], []]);
  // an outline: every line gets the values of its own type, in one batch
  w = pushTool(await exec('insert_after_line', { line: 5, text: '# Discussion\nWhat it means.\n## Limits\nSmall sample.', style: 'outline' }));
  assert.ok(w._ok, w.content);
  deq(fmt().slice(5), [[run(10, { size: 16 })], [run(14, { size: 12 })], [run(6, { size: 14 })], [run(13, { size: 12 })]]);
  // the body lines in one request (adjacent paragraphs of one type would share it), each heading its own
  const ts = lastPost().requests.filter((r) => r.updateTextStyle);
  assert.strictEqual(ts.length, 4);
  await undo();
  deq(fmt(), [[], [], [], [], []]);
});

test('edit_document insert and replace_section get the sheet for the paragraphs they create; replace_text inside a paragraph never restyles', async () => {
  await freshWith(simple(), 'Formatting: body Georgia 13');
  let w = pushTool(await exec('edit_document', { operations: [{ op: 'insert', line: 1, text: 'Abstract text.', style: null, old_text: null, new_text: null, start: null, end: null }] }));
  assert.ok(w._ok, w.content);
  deq(fmt()[1], [[0, 14, { font: 'Georgia', size: 13 }]]);
  await undo();
  // replace_section: the paragraphs it creates whole get the sheet; the heading keeps its formatting
  w = pushTool(await exec('replace_section', { heading: 'Methods', new_text: 'One.\nTwo.\nThree.' })); // Auto: no card
  assert.ok(w._ok, w.content);
  deq(texts().slice(3), ['Methods', 'One.', 'Two.', 'Three.']);
  deq(fmt().slice(3), [[], [[0, 4, { font: 'Georgia', size: 13 }]], [[0, 4, { font: 'Georgia', size: 13 }]], [[0, 6, { font: 'Georgia', size: 13 }]]]);
  await undo();
  deq(texts().slice(3), ['Methods', 'Second body paragraph.']);
  deq(fmt(), [[], [], [], [], []]);
  // replace_text inside a paragraph: no text style is written, the paragraph keeps its formatting
  await freshWith(docSpec({ items: [{ p: 'Plain words here.', fmt: [[0, 17, { font: 'Arial', size: 11 }]] }, { p: 'End.' }] }));
  w = pushTool(await exec('replace_text', { old_text: 'words', new_text: 'new words' }));
  assert.ok(w._ok, w.content);
  assert.ok(lastPost().requests.every((r) => !r.updateTextStyle && !r.updateParagraphStyle), JSON.stringify(lastPost().requests));
  // a new paragraph split off inside a replace_text is not restyled either
  w = pushTool(await exec('replace_text', { old_text: 'here.', new_text: 'here.\nAnd more.' }));
  assert.ok(w._ok, w.content);
  assert.ok(lastPost().requests.every((r) => !r.updateTextStyle), JSON.stringify(lastPost().requests));
});

test('format_lines style: the restyled lines get the sheet; an explicit value of the call wins; undo restores the formatting', async () => {
  await freshWith(simple(), 'Formatting: h2 align center spacing 1.5');
  const before = { fmt: fmt(), p: fake.pstyles('t.0') };
  let w = pushTool(await exec('format_lines', fl(3, 3, { style: 'h2' })));
  assert.ok(w._ok, w.content);
  deq(fmt()[2], [run(21, { size: 14 })]);
  deq(fake.pstyles('t.0')[2], { alignment: 'CENTER', lineSpacing: 150, spaceAbove: 14, spaceBelow: 0 });
  await undo();
  deq({ fmt: fmt(), p: fake.pstyles('t.0') }, before);
  assert.strictEqual(fake.styles('t.0')[2], 'NORMAL_TEXT');
  // align given in the call: the call's value, the sheet's line spacing
  w = pushTool(await exec('format_lines', fl(3, 3, { style: 'h2', align: 'right' })));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[2], { alignment: 'END', lineSpacing: 150, spaceAbove: 14, spaceBelow: 0 });
  assert.ok(!lastPost().requests.some((r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.alignment === 'CENTER'));
  await undo();
  deq({ fmt: fmt(), p: fake.pstyles('t.0') }, before);
  // a line that already has the style is not restyled (no style change)
  w = pushTool(await exec('format_lines', fl(4, 4, { style: 'h2', align: 'left' })));
  assert.ok(w._ok, w.content);
  assert.ok(lastPost().requests.every((r) => !r.updateTextStyle), JSON.stringify(lastPost().requests));
});

test('an insert after a line: the paragraph values the sheet writes are undone on that line too', async () => {
  await freshWith(docSpec({ items: [{ p: 'Heading', style: 'HEADING_1' }, { p: 'Last body line.', pstyle: { alignment: 'END' } }] }), 'Formatting: body justify first-line 18');
  const before = fake.pstyles('t.0');
  const w = pushTool(await exec('insert_after_line', { line: 2, text: 'New last line.', style: null }));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[2], { alignment: 'JUSTIFIED', indentFirstLine: 18, spaceAbove: 0, spaceBelow: 0 });
  await undo();
  deq(texts(), ['Heading', 'Last body line.']);
  deq(fake.pstyles('t.0'), before);
});

test('numbers set: the standard indents per level (the number at the body text\'s edge) and the headings get the sheet; undo restores both', async () => {
  // the h1 at the end (not numbered: outside lines 1–6) makes the first h1 a section, not a title
  await freshWith(docSpec({ items: [
    { p: 'Background', style: 'HEADING_1' }, { p: 'Body.' },
    { p: 'Scope', style: 'HEADING_2' }, { p: 'Body.' },
    { p: 'Detail', style: 'HEADING_3', fmt: [[0, 6, { font: 'Arial', italic: true }]] }, { p: 'Body.' },
    { p: 'End', style: 'HEADING_1' },
  ] }));
  const before = { fmt: fmt(), p: fake.pstyles('t.0'), b: fake.bullets('t.0') };
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  const ps = fake.pstyles('t.0');
  // the number ends at the first-line indent, its width at the heading's size and font ("1." Times New Roman 16 pt: 12;
  // "1.1." 14 pt: 21; "1.1.1." Arial 12 pt: 30.5), the text half an em after it
  deq([ps[0], ps[2], ps[4]].map((p) => [p.indentStart, p.indentFirstLine]), [[20, 12], [28, 21], [36.5, 30.5]]);
  // the formatting view leaves the numbering's own indents out (numberingShown), and the body lines' explicit 0
  const rd = pushTool(await exec('read_document', { scope: { start: 1, end: 6 }, include: ['formatting'], doc: null }));
  deq(rd.content.split('\n').filter((l) => /^\d+:/.test(l)).map((l) => l.replace(/\].*$/, ']')),
    ['1: [h1 number space 18/0]', '2: Body.', '3: [h2 number L2 space 14/0]', '4: Body.', '5: [h3 number L3 space 12/0]', '6: Body.']);
  // the sheet fills in what a heading's text does not set itself: Detail keeps its own Arial (the user's), gets the size
  deq([fmt()[0], fmt()[2], fmt()[4]], [[run(10, { size: 16 })], [run(5, { size: 14 })],
    [[0, 6, { font: 'Arial', size: 12, italic: true }]]]);
  deq(fmt()[1], []); // body text between the headings is not touched
  await undo();
  // the headings had no indent of their own: they lose the bullet with an explicit 0 (a reset keeps the list's in Docs)
  const zero = (p, k) => (k % 2 || k > 4 ? p : { ...p, indentStart: 0, indentFirstLine: 0 }); // lines 1, 3, 5
  deq({ fmt: fmt(), p: fake.pstyles('t.0'), b: fake.bullets('t.0') }, { ...before, p: before.p.map(zero) });
  // typed numbers are stripped in the same batch: the sheet's undo addresses the text after them, and a restored number
  // is plain text, as before the sheet (Docs would give it the 20 pt of the text after it: the undo writes its own styles)
  await freshWith(docSpec({ items: [{ p: '1. Intro', style: 'HEADING_1', fmt: [[3, 8, { size: 18 }]] }, { p: 'Body.' }, { p: '2. End', style: 'HEADING_1' }] }));
  const b2 = { fmt: fmt(), t: texts() };
  assert.ok(pushTool(await exec('format_lines', fl(1, 3, { numbers: 'set' })))._ok);
  deq(texts(), ['Intro', 'Body.', 'End']);
  deq(fmt()[0], [run(5, { size: 18 })]); // its own 18 pt stays (the sheet's 16 is not forced on it), the font is filled in
  await undo();
  deq({ fmt: fmt(), t: texts() }, b2);
});

test('numbers set keeps the headings\' own text formatting: the sheet fills in only what a run does not set, the number follows the text', async () => {
  // As reported: sections set to 12 pt by the user (the sheet's h2 is 14) went back to 14 when they were numbered.
  // Line 1 is the title (not numbered, not touched); line 6 has a typed number (plain) before its 12 pt text, which the
  // undo restores plain (Docs would give it the 12 pt of "Tables").
  await freshWith(docSpec({ items: [
    { p: 'Supporting Information', style: 'HEADING_1' }, { p: 'Body.' },
    { p: 'Software', style: 'HEADING_2', fmt: [[0, 8, { size: 12, font: TNR }]] }, { p: 'Body.' },
    { p: 'Spectra', style: 'HEADING_2', fmt: [[0, 7, { size: 12 }]] },
    { p: '3. Tables', style: 'HEADING_2', fmt: [[3, 9, { size: 12, font: TNR }]] },
  ] }));
  const before = { fmt: fmt(), t: texts() };
  const [, , L3, , L5, L6] = as.model.lines;
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: numbered 3 headings on lines 3, 5, 6 (Google Docs numbering); formatting sheet values added where the heading text had none: Times New Roman; the document has 6 lines.');
  deq(texts(), ['Supporting Information', 'Body.', 'Software', 'Body.', 'Spectra', 'Tables']);
  deq(fmt(), [[], [], [run(8, { size: 12 })], [], [run(7, { size: 12 })], [run(6, { size: 12 })]]);
  // the requests: the font where the text has none; each newline (it carries the number Docs draws) the text's own 12 pt
  // and font, for line 6 the text's after the typed number (whose characters get the sheet's values and then go)
  const ts = (s, e, size) => ({ updateTextStyle: { range: { startIndex: s, endIndex: e, tabId: 't.0' },
    textStyle: { weightedFontFamily: { fontFamily: TNR, weight: 400 }, ...(size ? { fontSize: { magnitude: size, unit: 'PT' } } : {}) },
    fields: size ? 'weightedFontFamily,fontSize' : 'weightedFontFamily' } });
  deq(lastPost().requests.filter((r) => r.updateTextStyle), [ts(L3.end, L3.end + 1, 12), ts(L5.start, L5.end), ts(L5.end, L5.end + 1, 12),
    ts(L6.start, L6.start + 3, 14), ts(L6.end, L6.end + 1, 12)]);
  await undo();
  deq({ fmt: fmt(), t: texts() }, before);
  // every heading sets its font and size: nothing is filled in, the result says nothing about the sheet
  await freshWith(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1', fmt: [[0, 5, { size: 12, font: 'Arial' }]] }, { p: 'Body.' },
    { p: 'End', style: 'HEADING_1', fmt: [[0, 3, { size: 12, font: 'Arial' }]] }] }));
  const w2 = pushTool(await exec('format_lines', fl(1, 3, { numbers: 'set' })));
  assert.strictEqual(w2.content, 'Done: numbered 2 headings on lines 1, 3 (Google Docs numbering); the document has 3 lines.');
  deq([fmt()[0], fmt()[2]], [[[0, 5, { size: 12, font: 'Arial' }]], [[0, 3, { size: 12, font: 'Arial' }]]]);
  // apply_sheet (asked for) still writes the sheet over them
  assert.ok(pushTool(await exec('format_lines', fl(1, 3, { apply_sheet: true })))._ok);
  deq(fmt()[0], [run(5, { size: 16 })]);
});

// Three numbered levels in lines 1–6; the h1 at line 7 makes the first h1 a section, not a title.
const run3 = () => docSpec({ items: [
  { p: 'Background', style: 'HEADING_1' }, { p: 'Body.' }, { p: 'Scope', style: 'HEADING_2' }, { p: 'Body.' },
  { p: 'Detail', style: 'HEADING_3' }, { p: 'Body.' }, { p: 'End', style: 'HEADING_1' },
] });
const headIndents = () => { const ps = fake.pstyles('t.0'); return [ps[0], ps[2], ps[4]].map((p) => [p.indentStart, p.indentFirstLine]); };

test('numbers set: indents per level from the number\'s width at the heading size; the sheet\'s numbers entry in cm; numbers docs keeps the list\'s own', async () => {
  // the standard: the number at the body's left edge, the text half an em after it, at other heading sizes too
  await freshWith(run3(), 'Formatting: h1 20; h2 18; h3 10');
  assert.ok(pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })))._ok);
  deq(headIndents(), [[25, 15], [36, 27], [27.5, 22.5]]);
  // "numbers 0/0/0" is the standard written out
  await freshWith(run3(), 'Formatting: h1 20; h2 18; h3 10; numbers 0/0/0');
  assert.ok(pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })))._ok);
  deq(headIndents(), [[25, 15], [36, 27], [27.5, 22.5]]);
  deq([0, 1, 2, 5].map((k) => T.numberIndent(k)), [0, 1, 2, 5].map(() => ({ indentStart: 0, indentFirstLine: 0 })));
  // numbers 0.5/0.8/1.1 (cm, rounded to half points)
  await freshWith(run3(), 'Formatting: numbers 0.5/0.8/1.1');
  assert.ok(pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })))._ok);
  deq(headIndents(), [[14, 0], [22.5, 0], [31, 0]]);
  // numbers docs: Google Docs' list indents (18 pt hanging, each level +36 pt); the view shows no indent for them
  await freshWith(run3(), 'Formatting: numbers docs');
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  deq(headIndents(), [[36, 18], [72, 54], [108, 90]]);
  const rd = pushTool(await exec('read_document', { scope: { start: 1, end: 6 }, include: ['formatting'], doc: null }));
  deq(rd.content.split('\n').filter((l) => /^\d+:/.test(l)).map((l) => l.replace(/\].*$/, ']')),
    ['1: [h1 number space 18/0]', '2: Body.', '3: [h2 number L2 space 14/0]', '4: Body.', '5: [h3 number L3 space 12/0]', '6: Body.']);
});

test('numbers entry: precedence DOC.md > MAIN.md > the standard; a bad value is named in the result and the rest of the line applies', async () => {
  deq(T.resolveStyleSheet('', '').numbers, null);
  deq(T.resolveStyleSheet('', 'Formatting: numbers docs').numbers, { docs: true });
  deq(T.resolveStyleSheet('Formatting: numbers 0.6/0.9/1.2 cm', 'Formatting: numbers docs').numbers, { starts: [17, 25.5, 34] });
  deq(T.resolveStyleSheet('Formatting: h1 18', 'Formatting: numbers docs').numbers, { docs: true }); // a DOC.md line without numbers
  deq(T.parseStyleSheet('Formatting: NUMBERS Docs').numbers, { docs: true });
  deq(T.parseStyleSheet('Formatting: numbers 0,5/0.8cm/1.1').numbers, { starts: [14, 22.5, 31] });
  deq(T.parseStyleSheet('Formatting: numbers 0/0/0').numbers, { starts: [0, 0, 0] }); // the standard, written out
  for (const bad of ['numbers', 'numbers 0.6/0.9', 'numbers 0.6/0.9/11', 'numbers a/b/c', 'numbers 0.6/0.9/1.2/1.5', 'numbers wide']) {
    const s = T.parseStyleSheet(`Formatting: h1 18; ${bad}`);
    deq(s.ignored, [bad]);
    assert.strictEqual(s.numbers, null);
    deq(JSON.parse(JSON.stringify(s.entries)), { h1: { size: 18 } });
  }
  // a bad DOC.md entry: the MAIN.md entry applies, the h1 size of the same line too, and the result says what to write
  await freshWith(run3(), 'Formatting: h1 18; numbers 6mm/9mm/12mm', 'Formatting: numbers 0.5/0.8/1.1');
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  deq(headIndents(), [[14, 0], [22.5, 0], [31, 0]]);
  deq(fmt()[0], [run(10, { size: 18 })]);
  assert.ok(w.content.includes('\nNote: In the Formatting line of DOC.md, "numbers 6mm/9mm/12mm" is ignored: write numbers 0.6/0.9/1.2 (where the heading text starts, in cm, for levels 1/2/3) or numbers docs (Google Docs\' list indents).'), w.content);
  // the same note on apply_sheet, also when nothing changes
  const a = pushTool(await exec('format_lines', fl(1, 6, { apply_sheet: true })));
  assert.ok(/^Done: .*\nNote: In the Formatting line of DOC\.md, "numbers 6mm/.test(a.content), a.content);
  const a2 = pushTool(await exec('format_lines', fl(1, 6, { apply_sheet: true })));
  assert.ok(/^No change: .*\nNote: In the Formatting line of DOC\.md, "numbers 6mm/.test(a2.content), a2.content);
});

test('numbers entry changed: numbers set and apply_sheet put the new indents on numbered headings; undo restores the former ones', async () => {
  await freshWith(run3());
  assert.ok(pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })))._ok);
  deq(headIndents(), [[20, 12], [28, 21], [33, 27]]);
  const again = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(/^No change: the 3 headings in lines 1–6 are already numbered by Google Docs\./.test(again.content), again.content);
  assert.ok(pushTool(await exec('format_lines', fl(1, 7, { apply_sheet: true })))._ok); // the body lines and line 7 get their font
  // the user asks for Google Docs' indents: numbers docs in DOC.md, then apply_sheet (one batch, only the headings)
  as.docInstructions = 'Formatting: numbers docs';
  const before = fake.pstyles('t.0');
  const posts = fake.log.filter((x) => x.method === 'POST').length;
  const w = pushTool(await exec('format_lines', { start: null, end: null, ...NULLS, apply_sheet: true }));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: applied the formatting sheet to lines 1, 3, 5; the document has 7 lines.');
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, posts + 1);
  deq(headIndents(), [[36, 18], [72, 54], [108, 90]]);
  assert.strictEqual(pushTool(await exec('format_lines', fl(1, 6, { apply_sheet: true }))).content, 'No change: lines 1–6 already follow the formatting sheet.');
  await undo();
  deq(fake.pstyles('t.0'), before);
  // ... or numbers: set again (the list is made again with the new indents; its undo restores the former indents)
  const b2 = fake.pstyles('t.0');
  const s = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(/^Done: numbered 3 headings/.test(s.content), s.content);
  deq(headIndents(), [[36, 18], [72, 54], [108, 90]]);
  await undo();
  deq(fake.pstyles('t.0'), b2);
  deq(headIndents(), [[20, 12], [28, 21], [33, 27]]);
  // back to cm values through apply_sheet
  as.docInstructions = 'Formatting: numbers 0.5/0.8/1.1';
  assert.ok(pushTool(await exec('format_lines', fl(1, 6, { apply_sheet: true })))._ok);
  deq(headIndents(), [[14, 0], [22.5, 0], [31, 0]]);
  // headings without numbers and body lines keep their indents
  await freshWith(docSpec({ items: [{ p: 'Plain', style: 'HEADING_1', pstyle: { indentStart: 10 } }, { p: 'Body.', pstyle: { indentStart: 20 } }] }));
  assert.ok(pushTool(await exec('format_lines', fl(1, 2, { apply_sheet: true })))._ok);
  deq([fake.pstyles('t.0')[0].indentStart, fake.pstyles('t.0')[1].indentStart], [10, 20]);
});

test('format_lines apply_sheet: a range in one batch, "No change" afterwards, title only when named, tables kept, one undo', async () => {
  await freshWith(docSpec({ items: [
    { p: 'Report', style: 'TITLE' },
    // sizes Docs stores (an explicit 20 pt on Heading 1 or 11 pt on Normal text is not stored, so an undo could not restore it)
    { p: 'Intro', style: 'HEADING_1', fmt: [[0, 5, { font: 'Arial', size: 18 }]] },
    { p: 'Some bold words here.', fmt: [[0, 21, { font: 'Arial', size: 10 }], [5, 15, { bold: true }]] },
    { table: [[[{ p: 'Cell', fmt: [[0, 4, { font: 'Arial', size: 9 }]] }]]] },
    { p: 'After.', pstyle: { alignment: 'CENTER' } },
  ] }), 'Formatting: body align justify');
  const before = { fmt: fmt(), p: fake.pstyles('t.0') };
  const w = pushTool(await exec('format_lines', { start: null, end: null, ...NULLS, apply_sheet: true }));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: applied the formatting sheet to lines 2, 3, 5; the document has 5 lines.');
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 1);
  deq(fmt()[0], []); // the title: the sheet does not name it
  deq(fmt()[1], [run(5, { size: 16 })]);
  // the body keeps its bold words (a font write drops bold in Docs; the bold stretch is written again)
  deq(fmt()[2], [[0, 5, { font: TNR, size: 12 }], [5, 15, { font: TNR, size: 12, bold: true }], [15, 21, { font: TNR, size: 12 }]]);
  deq(fmt()[3], [[0, 4, { font: 'Arial', size: 9 }]]); // the table cell
  deq(fake.pstyles('t.0')[2], { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 });
  deq(fake.pstyles('t.0')[4], { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 });
  const again = pushTool(await exec('format_lines', fl(1, 5, { apply_sheet: true })));
  assert.strictEqual(again.content, 'No change: lines 1–5 already follow the formatting sheet.');
  await undo();
  deq({ fmt: fmt(), p: fake.pstyles('t.0') }, before);
  // apply_sheet goes with style and numbers only (planFormatNumbers); a non-boolean is refused
  const alone = await exec('format_lines', fl(2, 2, { apply_sheet: true, align: 'left' }));
  assert.strictEqual(alone.content, 'Error: apply_sheet goes with style and numbers only: call format_lines once without align, then once with align alone');
  const bad = await exec('format_lines', fl(2, 2, { apply_sheet: 'maybe' }));
  assert.ok(/^Error: apply_sheet must be true or null/.test(bad.content), bad.content);
  // the title follows a sheet that names it
  as.docInstructions = 'Formatting: title 26';
  assert.ok(pushTool(await exec('format_lines', fl(1, 1, { apply_sheet: true })))._ok);
  deq(fmt()[0], [run(6)]); // the font; 26 pt is Title's own size, which Docs does not store
  assert.strictEqual(T.formatLinesArgsText(fl(1, 1, { apply_sheet: true })), 'formatting sheet');
});

// A paragraph that follows the default sheet: Times New Roman, the size; justified body; a heading's space above.
const STD_SPACE = { 16: 18, 14: 14, 12: 12 };
const std = (p, style, size, pstyle) => ({ p, style, fmt: [[0, p.length, { font: TNR, size, ...(style ? { bold: true } : {}) }]],
  pstyle: pstyle || (style ? { spaceAbove: STD_SPACE[size], spaceBelow: 0 } : { alignment: 'JUSTIFIED' }) });

test('the first-run detection: a differing document writes its line; a conforming one or too little text writes nothing', async () => {
  const head = (p, style, size) => ({ p, style, fmt: [[0, p.length, { font: 'Georgia', size, bold: true }]] });
  const body = (p) => ({ p, fmt: [[0, p.length, { font: 'Georgia', size: 11 }]] });
  await fresh(docSpec({ items: [head('Intro', 'HEADING_1', 18), body('One.'), body('Two.'), head('More', 'HEADING_2', 14), body('Three.')] }));
  // the alignment and spacing the default sets are recorded too (Docs' own: body left 0/0, h1 20/6, h2 18/6)
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), 'Formatting: body Georgia 11 left space 0/0; h1 Georgia 18 bold space 20/6; h2 Georgia 14 bold space 18/6');
  // the turn's pass: the named styles are read once (text that inherits takes them), and the line is what DOC.md gets
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'One.' }, { p: 'Two.' }, { p: 'More', style: 'HEADING_2' }, { p: 'Three.' }] }));
  fake.namedStyles = { NORMAL_TEXT: { font: 'Arial', size: 11 }, HEADING_1: { size: 20 }, HEADING_2: { size: 16 } };
  deq(JSON.parse(JSON.stringify(await T.fetchNamedStyles('DOC123', 't.0'))), { NORMAL_TEXT: { font: 'Arial', size: 11 }, HEADING_1: { size: 20 }, HEADING_2: { size: 16 } });
  assert.strictEqual(await T.docInitFormatting(as), 'Formatting: body Arial 11 left space 0/0; h1 Arial 20 regular space 20/6; h2 Arial 16 regular space 18/6');
  // the named styles' alignment and spacing count as the paragraphs' own
  fake.namedStyles = { NORMAL_TEXT: { font: TNR, size: 12, alignment: 'JUSTIFIED' }, HEADING_1: { size: 16, bold: true, spaceAbove: 18, spaceBelow: 0 }, HEADING_2: { size: 14, bold: true, spaceAbove: 14, spaceBelow: 0 } };
  assert.strictEqual(await T.docInitFormatting(as), '');
  // a document that follows the standard: nothing
  await fresh(docSpec({ items: [std('Intro', 'HEADING_1', 16), std('One.', undefined, 12), std('Two.', undefined, 12), std('More', 'HEADING_2', 14), std('Three.', undefined, 12)] }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), '');
  // ... or the sheet of MAIN.md
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: body Arial'), 'Formatting: body Times New Roman 12 justify space 0/0; h1 Times New Roman 16 bold space 18/0; h2 Times New Roman 14 bold space 14/0');
  // too little text: two body paragraphs, or one heading
  await fresh(docSpec({ items: [head('Intro', 'HEADING_1', 18), body('One.'), body('Two.'), head('More', 'HEADING_2', 14)] }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), '');
  await fresh(docSpec({ items: [head('Intro', 'HEADING_1', 18), body('One.'), body('Two.'), body('Three.')] }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), '');
  // the export path: no detection
  assert.strictEqual(await T.docInitFormatting({ docFormat: 'markdown', model: null }), '');
});

test('the first-run detection: numbering indents count only when MAIN.md sets numbers', async () => {
  // headings numbered with Google Docs' own indents (a list's level indents on the paragraphs, as createParagraphBullets
  // writes them)
  const head = (p, style, size, ind) => std(p, style, size, { spaceAbove: STD_SPACE[size], spaceBelow: 0, ...ind });
  const docsItems = (own) => [
    { ...head('Intro', 'HEADING_1', 16, own && { indentStart: 36, indentFirstLine: 18 }), bullet: { listId: 'kix.h', preset: 'NUMBERED_DECIMAL_NESTED' } },
    std('One.', undefined, 12), std('Two.', undefined, 12),
    { ...head('More', 'HEADING_2', 14, own && { indentStart: 72, indentFirstLine: 54 }), bullet: { listId: 'kix.h', level: 1 } }, std('Three.', undefined, 12)];
  await fresh(docSpec({ items: docsItems(true) }));
  for (const l of [as.model.lines[0], as.model.lines[3]]) assert.ok(l.list && l.list.nested, JSON.stringify(l.list));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), ''); // the standard does not make it differ
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: numbers docs'), '');
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: numbers 0.6/0.9/1.2'), 'Formatting: numbers docs');
  // the same headings with no indent of their own are drawn at their named styles' indents, not the level's (chrome-check
  // line-starts): none here, so the text at 0, written "numbers 0/0/0" like the standard (the number then moves to the
  // body's edge on the next numbering); with a heading style's indent, that one
  await fresh(docSpec({ items: docsItems(false) }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: numbers docs'), 'Formatting: numbers 0/0/0');
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: numbers 0/0/0'), '');
  assert.strictEqual(T.detectFormattingLine(as.model, { HEADING_1: { indentStart: 17, indentFirstLine: 0 }, HEADING_2: { indentStart: 17, indentFirstLine: 0 } },
    'Formatting: numbers docs'), 'Formatting: numbers 0.6/0.6/0');
  // the product's indents in a document whose MAIN.md asks for docs: the measured positions (level 3: the standard's).
  // The headings carry the list with the level's indents, so set is not "No change"; the only h1 is the title: it leaves
  // the list, and the h2 is the first level of the new list ("1.", not "1.1.").
  await fresh(docSpec({ items: docsItems(true) }));
  const w = pushTool(await exec('format_lines', fl(1, 5, { numbers: 'set' })));
  assert.ok(w.content.startsWith('Done: numbered 1 heading on line 4 (Google Docs numbering); removed the number of the title on line 1;'), w.content);
  const m = await T.fetchDocModel('DOC123', 't.0');
  assert.strictEqual(T.detectFormattingLine(m, {}, 'Formatting: numbers docs'), 'Formatting: numbers 0/0/0');
  assert.strictEqual(T.detectFormattingLine(m, {}, 'Formatting: numbers 0/0/0'), '');
  assert.strictEqual(T.detectFormattingLine(m, {}, 'Formatting: numbers 0.6/0.9/1.2'), 'Formatting: numbers 0/0/0');
  assert.strictEqual(T.detectFormattingLine(m, {}, ''), '');
  // with fonts that differ too, the numbers entry ends the line
  assert.strictEqual(T.detectFormattingLine(m, {}, 'Formatting: body Arial; numbers docs'),
    'Formatting: body Times New Roman 12 justify space 0/0; h1 Times New Roman 16 bold space 18/0; h2 Times New Roman 14 bold space 14/0; numbers 0/0/0');
});

test('schema and head: apply_sheet is a nullable boolean of format_lines; one Edit-rules line in Auto with the Docs API only', async () => {
  const p = T.TOOL_DEFS.format_lines.function.parameters.properties.apply_sheet;
  deq(p.anyOf, [{ type: 'boolean' }, { type: 'null' }]);
  assert.ok(p.description.split(/\s+/).length <= 15, p.description);
  await fresh(simple());
  const head = (mode) => T.joinSystem(T.buildSystemParts(mode, 100000, as));
  assert.ok(head('edit').includes(T.FORMATTING_PROMPT_LINE.slice(2)), head('edit'));
  assert.strictEqual(head('edit').split('formatting sheet').length, 2); // once
  assert.ok(!head('manual').includes('formatting sheet'));
});

// ---- Alignment and paragraph spacing (the default: justified body text without spacing, headings with space above) ----
const tags = (rd) => rd.content.split('\n').filter((l) => /^\d+:/.test(l)).map((l) => l.replace(/\].*$/, ']'));
const readTags = async (a, b) => tags(pushTool(await exec('read_document', { scope: { start: a, end: b }, include: ['formatting'], doc: null })));

test('an insert under the default sheet: body paragraphs justified with no spacing, headings with space above and no alignment, list items left alone; one undo', async () => {
  await freshWith(docSpec({ items: [
    { p: 'Intro', style: 'HEADING_1' }, { p: 'Body.' },
    { p: 'One', bullet: { listId: 'kix.l', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } }, { p: 'End.' },
  ] }));
  const before = fake.pstyles('t.0');
  let w = pushTool(await exec('insert_after_line', { line: 2, text: '# Results\nWhat we found.\n## Limits\nSmall sample.', style: 'outline' }));
  assert.ok(w._ok, w.content);
  const ps = fake.pstyles('t.0');
  const body = { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 };
  deq(ps.slice(2, 6), [{ spaceAbove: 18, spaceBelow: 0 }, body, { spaceAbove: 14, spaceBelow: 0 }, body]);
  // the formatting view: [justify] on a justified body line (0/0 spacing is not shown), the heading's spacing
  deq(await readTags(2, 6), ['2: Body.', '3: [h1 space 18/0]', '4: [justify]', '5: [h2 space 14/0]', '6: [justify]']);
  await undo();
  deq(fake.pstyles('t.0'), before); // line 2, whose paragraph end the last new line took, gets its own values back
  // after a list item the new line continues the list: no alignment, no spacing (the list keeps its look)
  w = pushTool(await exec('insert_after_line', { line: 3, text: 'Two', style: null }));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[3], {});
  assert.ok(!lastPost().requests.some((r) => r.updateParagraphStyle && /alignment|space/.test(r.updateParagraphStyle.fields)), JSON.stringify(lastPost().requests));
  await undo();
  // inside a table cell the paragraph keeps the cell's look
  await freshWith(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { table: [[[{ p: 'Cell' }]]] }, { p: 'End.' }] }));
  w = pushTool(await exec('insert_after_line', { line: 2, text: 'More in the cell', style: null }));
  assert.ok(w._ok, w.content);
  assert.ok(!lastPost().requests.some((r) => r.updateParagraphStyle && /alignment|space/.test(r.updateParagraphStyle.fields)), JSON.stringify(lastPost().requests));
});

test('a sheet that names a heading alignment applies it; a left-aligned DOC.md line keeps new body text left', async () => {
  await freshWith(simple(), 'Formatting: h1 center; body left');
  const w = pushTool(await exec('insert_after_line', { line: 5, text: '# Discussion\nText.', style: 'outline' }));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0').slice(5, 7), [{ alignment: 'CENTER', spaceAbove: 18, spaceBelow: 0 }, { alignment: 'START', spaceAbove: 0, spaceBelow: 0 }]);
  deq(await readTags(6, 7), ['6: [h1 center space 18/0]', '7: {Text.}(font=Times New Roman size=12)']); // left: no tag
});

test('format_lines: align and space of the call win over the sheet; undo restores the former values', async () => {
  await freshWith(docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Heading text', style: 'HEADING_1', pstyle: { spaceAbove: 20, spaceBelow: 6 } }, { p: 'Body.' }] }));
  const before = fake.pstyles('t.0');
  // the heading becomes body text: the sheet would justify it; the call says left and space above 6
  let w = pushTool(await exec('format_lines', fl(2, 2, { style: 'normal', align: 'left', space_above: 6 })));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[1], { alignment: 'START', spaceAbove: 6, spaceBelow: 0 });
  await undo();
  deq(fake.pstyles('t.0'), before);
  // without the call's values: the sheet's
  w = pushTool(await exec('format_lines', fl(2, 2, { style: 'normal' })));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[1], { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 });
  await undo();
  deq(fake.pstyles('t.0'), before);
});

test('apply_sheet over a mixed range: body justified with no spacing, headings get their spacing and keep their alignment, list items and cells untouched; one undo', async () => {
  const list = { listId: 'kix.l', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' };
  await freshWith(docSpec({ items: [
    { p: 'Intro', style: 'HEADING_1', pstyle: { alignment: 'CENTER' } },
    { p: 'Left body.', pstyle: { spaceBelow: 8 } },
    { p: 'Item one', bullet: list }, { p: 'Item two', bullet: list },
    { table: [[[{ p: 'Cell' }]]] },
    { p: 'Methods', style: 'HEADING_2' },
    { p: 'More body.', pstyle: { alignment: 'END' } },
  ] }));
  const before = fake.pstyles('t.0');
  const w = pushTool(await exec('format_lines', { start: null, end: null, ...NULLS, apply_sheet: true }));
  assert.ok(w._ok, w.content);
  const ps = fake.pstyles('t.0');
  const body = { alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 };
  deq(ps[0], { alignment: 'CENTER', spaceAbove: 18, spaceBelow: 0 });
  deq(ps[1], body);
  deq([ps[2], ps[3], ps[4]].map((p) => [p.alignment, p.spaceAbove, p.spaceBelow]), [[undefined, undefined, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined]]);
  deq(ps[5], { spaceAbove: 14, spaceBelow: 0 });
  deq(ps[6], body);
  assert.strictEqual(pushTool(await exec('format_lines', fl(1, 7, { apply_sheet: true }))).content, 'No change: lines 1–7 already follow the formatting sheet.');
  await undo();
  deq(fake.pstyles('t.0'), before);
});

test('the first-run detection: alignment and spacing count only where the sheet in force sets them; a left-aligned document records left', async () => {
  // a document in the standard's fonts and sizes, left-aligned: it differs, and its line keeps it left
  const left = (p) => std(p, undefined, 12, {});
  await fresh(docSpec({ items: [std('Intro', 'HEADING_1', 16), left('One.'), left('Two.'), std('More', 'HEADING_2', 14), left('Three.')] }));
  const line = T.detectFormattingLine(as.model, {}, '');
  assert.strictEqual(line, 'Formatting: body Times New Roman 12 left space 0/0; h1 Times New Roman 16 bold space 18/0; h2 Times New Roman 14 bold space 14/0');
  // recorded in DOC.md, that line keeps a new paragraph left
  deq(JSON.parse(JSON.stringify(T.resolveStyleSheet(line, '').types.body)), { font: TNR, size: 12, align: 'left', spaceAbove: 0, spaceBelow: 0 });
  // MAIN.md asks for left body text: the same document conforms
  assert.strictEqual(T.detectFormattingLine(as.model, {}, 'Formatting: body left'), '');
  // a heading's own spacing differs from the sheet's: recorded
  await fresh(docSpec({ items: [std('Intro', 'HEADING_1', 16, { spaceAbove: 24, spaceBelow: 6 }), std('One.', undefined, 12), std('Two.', undefined, 12),
    std('More', 'HEADING_2', 14), std('Three.', undefined, 12)] }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), 'Formatting: body Times New Roman 12 justify space 0/0; h1 Times New Roman 16 bold space 24/6; h2 Times New Roman 14 bold space 14/0');
  // list items do not count for the alignment (the sheet leaves them alone)
  const item = (p) => ({ ...std(p, undefined, 12, {}), bullet: { listId: 'kix.l', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  await fresh(docSpec({ items: [std('Intro', 'HEADING_1', 16), std('One.', undefined, 12), item('A long list item that is left-aligned.'), item('Another long left-aligned list item.'),
    std('Two.', undefined, 12), std('More', 'HEADING_2', 14), std('Three.', undefined, 12)] }));
  assert.strictEqual(T.detectFormattingLine(as.model, {}, ''), '');
});

test('the sheet\'s first-line indent: a line without one of its own is compared with the one its named style gives it', () => {
  const line = { line: 1, text: '', style: 'NORMAL_TEXT', para: {}, start: 1, end: 1 };
  const v = { firstLine: 17 };
  assert.strictEqual(T.sheetLineChanges({ named: { NORMAL_TEXT: { indentFirstLine: 17 } } }, line, v).para, false);
  assert.strictEqual(T.sheetLineChanges({ named: {} }, line, v).para, true);
  assert.strictEqual(T.sheetLineChanges({ named: { NORMAL_TEXT: { indentFirstLine: 17 } } }, { ...line, para: { indentFirstLine: 0 } }, v).para, true);
});
