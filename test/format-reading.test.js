'use strict';
// The reading side of the formatting tools: the line model's runs (fonts, sizes, colors, raw links), paragraph
// fields and lists, the read_formatting notation (line tags, {text}(…) spans, the default-font header), the
// vocabularies of docs-style.js, stripMarkers on notation, relocateEdit with insertText inverses, and the fake
// Docs server's formatting requests (field masks, paragraph styles, lists).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { fakeDocsServer, CHECKBOX_GLYPH, LINK_HEX } = require('./lib/fake-docs');

let T;
before(async () => { T = (await load()).T; });

const doc = (items, lists, extra = {}) => ({ documentId: 'DOC1', title: 'Doc', ...extra, tabs: [{ id: 't.0', title: 'Main', items, lists }] });
const modelOf = (fake) => T.buildLineModel(fake.render(true), 't.0', 'DOC1');
const snapOf = (model) => ({ docText: model.text, docFormat: 'docs-api', model, lines: null, selection: '' });
const post = (fake, requests) => fake.fetch('https://docs.googleapis.com/v1/documents/DOC1:batchUpdate',
  { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) });
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const A11 = { font: 'Arial', size: 11 };

// The example of the design (section 3): every character is Arial 11, so the header names it once.
const exampleSpec = () => doc([
  { p: 'Report', style: 'TITLE', fmt: [[0, 6, A11]] },
  { p: 'Methods', style: 'HEADING_1', fmt: [[0, 7, A11]] },
  { p: 'Alpha beta gamma.', fmt: [[0, 17, A11], [6, 10, { bold: true }]], bullet: { listId: 'kix.n' } },
  { p: 'Sub-item', fmt: [[0, 8, A11]], bullet: { listId: 'kix.n', level: 1 } },
  { p: 'Plain centered text', fmt: [[0, 19, A11], [6, 14, { size: 14, color: '#FF0000' }]], pstyle: { alignment: 'CENTER', lineSpacing: 150 } },
  { p: 'Buy milk', fmt: [[0, 8, A11], [4, 8, { link: 'https://x.org' }]], bullet: { listId: 'kix.c' } },
], { 'kix.n': 'NUMBERED_DECIMAL_ALPHA_ROMAN', 'kix.c': 'BULLET_CHECKBOX' });

test('read_formatting: line tags, spans and the default-font header (the example of the design)', () => {
  const m = modelOf(fakeDocsServer(exampleSpec()));
  deq(m.textDefault, { font: 'Arial', size: 11, color: null });
  const out = T.runReadingTool('read_formatting', { start: 1, end: 6 }, snapOf(m));
  assert.strictEqual(out, `${T.FORMAT_NOTE} Unmarked text: Arial 11.\nLines 1-6 of 6:\n` + [
    '1: [title] Report',
    '2: [h1] Methods',
    '3: [number] Alpha **beta** gamma.',
    '4: [number L2] Sub-item',
    '5: [center line 1.5] Plain {centered}(size=14 color=#FF0000) text',
    '6: [checklist] Buy [milk](https://x.org)',
  ].join('\n'));
  assert.ok(T.FORMAT_NOTE.includes('{text}(font= size= color= bg=)') && T.FORMAT_NOTE.includes('[tags]') && T.FORMAT_NOTE.includes('old_text'));
  // read_lines stays plain
  assert.strictEqual(T.runReadingTool('read_lines', { start: 3, end: 3 }, { ...snapOf(m), lines: null }), 'Lines 3-3 of 6:\n3: Alpha beta gamma.');
  // without a default (a hand-built model) every explicit value is shown; linesReport passes the model's default
  assert.strictEqual(T.markedText(m.lines[4]), '[center line 1.5] {Plain }(font=Arial size=11){centered}(font=Arial size=14 color=#FF0000){ text}(font=Arial size=11)');
  assert.ok(T.linesReport(m, 5, 5, T.markedText).endsWith('\n5: [center line 1.5] Plain {centered}(size=14 color=#FF0000) text'));
  // the tool description names tags and spans
  const desc = T.TOOL_DEFS.read_formatting.function.description;
  assert.ok(desc.includes('{text}(font= size= color= bg=)') && desc.includes('[tag]'), desc);
});

test('line model: runs keep font, weight, size, colors and the raw link; plain runs are left out', () => {
  const m = modelOf(fakeDocsServer(doc([
    { p: 'Fonts and colors here', fmt: [[0, 5, { font: 'Roboto', weight: 700, size: 14 }], [10, 16, { color: '#00B050', bg: '#FFFF00' }], [17, 21, { link: { headingId: 'h.abc' } }]] },
    { p: 'Black text', fmt: [[0, 5, { color: '#000000' }]] },
  ])));
  const plain = { bold: false, italic: false, underline: false, link: null, font: null, weight: null, size: null, color: null, bg: null, linkRaw: null };
  deq(m.lines[0].runs, [
    { s: 0, e: 5, ...plain, font: 'Roboto', weight: 700, size: 14 },
    { s: 10, e: 16, ...plain, color: '#00B050', bg: '#FFFF00' },
    { s: 17, e: 21, ...plain, linkRaw: { headingId: 'h.abc' } }, // a heading link: kept for undo, no marker
  ]);
  deq(m.lines[1].runs, [{ s: 0, e: 5, ...plain, color: '#000000' }]); // {rgbColor: {}} is black
  deq(m.textDefault, { font: null, size: null, color: null });
  assert.strictEqual(T.markedText(m.lines[0], m.textDefault), '{Fonts}(font=Roboto size=14) and {colors}(color=#00B050 bg=#FFFF00) here');
  assert.strictEqual(T.formatNote(m), T.FORMAT_NOTE); // no default: no "Unmarked text"
  deq([...T.TEXT_STYLE_KEYS], ['bold', 'italic', 'underline', 'link', 'font', 'weight', 'size', 'color', 'bg', 'linkRaw']);
  assert.ok(T.isPlainStyle(plain) && !T.isPlainStyle({ ...plain, linkRaw: { headingId: 'h' } }) && !T.isPlainStyle({ ...plain, bg: '#FFFFFF' }));
  assert.ok(T.sameStyle({ ...plain, linkRaw: { url: 'a' } }, { ...plain, linkRaw: { url: 'a' } }) && !T.sameStyle(plain, { ...plain, size: 11 }));
  // the link color Docs adds by itself is not repeated in a span on a link
  const lm = modelOf(fakeDocsServer(doc([{ p: 'see site', fmt: [[4, 8, { link: 'https://e.org', underline: true, color: LINK_HEX }]] }])));
  assert.strictEqual(T.markedText(lm.lines[0], lm.textDefault), 'see [site](https://e.org)');
});

test('notation: no underline marker inside a link; explicit underline elsewhere is kept', () => {
  const m = modelOf(fakeDocsServer(doc([{ p: 'see site now ok', fmt: [
    [4, 8, { link: 'https://e.org', underline: true, color: LINK_HEX }], [9, 12, { underline: true }], [13, 15, { link: 'https://f.org', underline: true, bold: true }]] }])));
  assert.strictEqual(T.markedText(m.lines[0], m.textDefault), 'see [site](https://e.org) __now__ [**ok**](https://f.org)');
  // an underline that runs on past the end of a link opens right after it
  const n = modelOf(fakeDocsServer(doc([{ p: 'abcdef', fmt: [[0, 6, { underline: true }], [0, 3, { link: 'https://e.org' }]] }])));
  assert.strictEqual(T.markedText(n.lines[0], n.textDefault), '[abc](https://e.org)__def__');
});

test('line model: para (explicit fields, RTL alignment) and list kinds', () => {
  const rendered = fakeDocsServer(doc([
    { p: 'Indented', pstyle: { indentStart: 36, indentFirstLine: 18, spaceAbove: 12, spaceBelow: 6 } },
    { p: 'RTL start', pstyle: { alignment: 'START', direction: 'RIGHT_TO_LEFT' } },
    { p: 'RTL end', pstyle: { alignment: 'END', direction: 'RIGHT_TO_LEFT' } },
    { p: 'Justified', pstyle: { alignment: 'JUSTIFIED', spaceAbove: { unit: 'PT' } } },
    { p: 'Roman', bullet: { listId: 'kix.r', level: 1 } },
    { p: 'Dash', bullet: { listId: 'kix.d' } },
    { p: 'Box', bullet: { listId: 'kix.x' } },
    { p: 'Unknown list', bullet: { listId: 'kix.gone' } },
    { p: 'Plain' },
  ], {
    'kix.r': { nestingLevels: [{ glyphSymbol: '-' }, { glyphType: 'UPPER_ROMAN' }] },
    'kix.d': { nestingLevels: [{ glyphSymbol: '-' }] },
    'kix.x': { nestingLevels: [CHECKBOX_GLYPH] },
  })).render(true);
  delete rendered.tabs[0].documentTab.lists['kix.gone']; // a list missing from documentTab.lists counts as a bullet
  const m = T.buildLineModel(rendered, 't.0', 'DOC1');
  const raw = m.lines.map((l) => [l.para, l.list]);
  deq(raw[0], [{ indentStart: 36, indentFirstLine: 18, spaceAbove: 12, spaceBelow: 6 }, null]);
  deq(raw[1][0], { align: 'right', direction: 'RIGHT_TO_LEFT' });
  deq(raw[2][0], { align: 'left', direction: 'RIGHT_TO_LEFT' });
  deq(raw[3][0], { align: 'justify', spaceAbove: 0 }); // a Dimension without magnitude is 0
  deq(m.lines.slice(4, 8).map((l) => l.list), [
    { listId: 'kix.r', level: 1, kind: 'number' }, { listId: 'kix.d', level: 0, kind: 'bullet' },
    { listId: 'kix.x', level: 0, kind: 'checklist' }, { listId: 'kix.gone', level: 0, kind: 'bullet' },
  ]);
  deq(raw[8], [{}, null]);
  const out = T.runReadingTool('read_formatting', { start: 1, end: 9 }, snapOf(m)).split('\n').slice(2);
  deq(out, ['1: [indent 36/18 space 12/6] Indented', '2: [right] RTL start', '3: RTL end', '4: [justify] Justified',
    '5: [number L2] Roman', '6: [bullet] Dash', '7: [checklist] Box', '8: [bullet] Unknown list', '9: Plain']);
  // a hand-made list entry whose level is missing: bullet
  assert.strictEqual(T.listKind(undefined), 'bullet');
  // an empty line with a tag: no trailing space
  assert.strictEqual(T.markedText({ text: '', runs: [], style: 'HEADING_2', para: {}, list: null }), '[h2]');
});

test('docs-style: vocabularies and loose parsers', () => {
  deq(T.parseColor('#f00'), { hex: '#FF0000', r: 255, g: 0, b: 0 });
  deq(T.parseColor('C00000'), { hex: '#C00000', r: 192, g: 0, b: 0 });
  assert.strictEqual(T.parseColor('rgb(0, 128, 255)').hex, '#0080FF');
  assert.strictEqual(T.parseColor('Dark Red').hex, '#C00000');
  assert.strictEqual(T.parseColor(' light-yellow ').hex, '#FFF2CC');
  deq(T.parseColor('none'), { none: true });
  deq(T.parseColor('default'), { none: true });
  assert.strictEqual(T.parseColor('reddish'), null);
  assert.strictEqual(T.parseColor('rgb(300,0,0)'), null);
  assert.strictEqual(T.hexFromRgbColor({ red: 1, blue: 0.2 }), '#FF0033');
  assert.strictEqual(T.hexFromRgbColor({}), '#000000');
  assert.strictEqual(T.hexFromOptionalColor({}), null); // transparent
  deq(T.apiColor('#FF0000'), { color: { rgbColor: { red: 1 } } });
  assert.strictEqual(T.hexFromOptionalColor(T.apiColor('#123456')), '#123456');
  deq([T.parseSize('14pt'), T.parseSize(' 10.3 '), T.parseSize(12), T.parseSize('big'), T.parseSize('14 points')], [14, 10.5, 12, null, 14]);
  deq([T.parsePt('0'), T.parsePt(null), T.dimensionPt({ magnitude: 4.5, unit: 'PT' }), T.dimensionPt({ unit: 'PT' }), T.dimensionPt(undefined)], [0, null, 4.5, 0, null]);
  deq(T.ptDimension(12), { magnitude: 12, unit: 'PT' });
  deq([T.lineSpacingPercent(1.15), T.lineSpacingMultiplier(150)], [115, 1.5]);
  deq([T.parseLineSpacing(1.5), T.parseLineSpacing('115'), T.parseLineSpacing('150%'), T.parseLineSpacing('x')],
    [{ value: 1.5, percent: false }, { value: 1.15, percent: true }, { value: 1.5, percent: true }, null]);
  deq(['Heading 1', 'heading2', 'H3', '#', '###', 'Title', 'Normal text', 'paragraph', 'HEADING_4', 'NORMAL_TEXT', 'Heading One'].map(T.parseHeading),
    ['h1', 'h2', 'h3', 'h1', 'h3', 'title', 'normal', 'normal', 'h4', 'normal', null]);
  deq(['centre', 'Justified', 'start', 'end', 'LEFT', 'diagonal'].map(T.parseAlign), ['center', 'justify', 'left', 'right', 'left', null]);
  deq(['bulleted', 'numbered', 'ordered', 'checkbox', 'todo', 'remove', 'None', 'stars'].map(T.parseListKind),
    ['bullet', 'number', 'number', 'checklist', 'checklist', 'none', 'none', null]);
  assert.strictEqual(T.HEADING_STYLES.h2, 'HEADING_2');
  deq(['TITLE', 'SUBTITLE', 'HEADING_6', 'NORMAL_TEXT', ''].map(T.headingName), ['title', 'subtitle', 'h6', '', '']);
  deq(['left', 'center', 'right', 'justify'].map((a) => T.alignToApi(a)), ['START', 'CENTER', 'END', 'JUSTIFIED']);
  deq(['left', 'right'].map((a) => T.alignToApi(a, 'RIGHT_TO_LEFT')), ['END', 'START']);
  deq(['START', 'END', 'CENTER', 'JUSTIFIED', undefined].map((a) => T.alignName(a, 'RIGHT_TO_LEFT')), ['right', 'left', 'center', 'justify', null]);
  deq(T.LIST_PRESETS, { bullet: 'BULLET_DISC_CIRCLE_SQUARE', number: 'NUMBERED_DECIMAL_ALPHA_ROMAN', checklist: 'BULLET_CHECKBOX' });
  deq([{ glyphType: 'DECIMAL' }, { glyphType: 'ZERO_DECIMAL' }, { glyphSymbol: '●' }, { glyphType: 'GLYPH_TYPE_UNSPECIFIED' }, {}].map(T.listKind),
    ['number', 'number', 'bullet', 'checklist', 'checklist']);
  deq(T.knownFont('  times   new roman '), { name: 'Times New Roman', known: true });
  deq(T.knownFont('Fooo'), { name: 'Fooo', known: false });
  assert.strictEqual(T.knownFont(' '), null);
  assert.strictEqual(T.TEXT_STYLE_API_FIELDS.highlight, 'backgroundColor');
  assert.strictEqual(T.lineTag({ style: 'HEADING_2', list: null, para: { align: 'center', spaceAbove: 12, spaceBelow: 6, lineSpacing: 150 } }), 'h2 center space 12/6 line 1.5');
  assert.strictEqual(T.lineTag({ style: 'NORMAL_TEXT', list: { kind: 'bullet', level: 2 }, para: { indentStart: 108, spaceBelow: 4 } }), 'bullet L3 space -/4');
  assert.strictEqual(T.spanAttrs({ font: 'Courier New', size: 14, color: '#FF0000', bg: '#FFFF00' }, { font: 'Arial', size: 11 }), 'font=Courier New size=14 color=#FF0000 bg=#FFFF00');
  assert.strictEqual(T.unmarkedNote({ font: null, size: 12, color: null }), ' Unmarked text: size 12.');
  assert.strictEqual(T.unmarkedNote({ font: null, size: null, color: null }), '');
});

test('stripMarkers: line numbers, line tags, links and spans are removed too; null when nothing changes', () => {
  const s = T.stripMarkers;
  assert.strictEqual(s('3: [number] Alpha **beta** gamma.'), 'Alpha beta gamma.');
  assert.strictEqual(s('5: [center line 1.5] Plain {centered}(size=14 color=#FF0000) text'), 'Plain centered text');
  assert.strictEqual(s('Buy [milk](https://x.org)'), 'Buy milk');
  assert.strictEqual(s('the [{***lazy dog***}(font=Courier New size=14 color=#FF0000 bg=#FFFF00)](https://example.com/)'), 'the *lazy dog*');
  assert.strictEqual(s('{***lazy dog***}(font=Courier New size=14)'), 'lazy dog');
  assert.strictEqual(s('4: Alpha beta\n5: [h2 space 12/6] Methods'), 'Alpha beta\nMethods');
  assert.strictEqual(s('[indent 36/18] Indented'), 'Indented');
  assert.strictEqual(s('12: plain text'), 'plain text');
  // the existing contract
  assert.strictEqual(s('**lazy dog**'), 'lazy dog');
  assert.strictEqual(s("'lazy dog'"), 'lazy dog');
  assert.strictEqual(s('lazy dog'), null);
  assert.strictEqual(s('[not a tag] text'), null);
  assert.strictEqual(s('see [1] and {x}(y)'), null); // brackets that are not notation stay
  assert.strictEqual(s('3: [h1] '), null); // nothing left
});

test('relocateEdit shifts insertText locations and ranges of the inverse requests', () => {
  const fake = fakeDocsServer(doc([{ p: 'Introduction paragraph here' }, { p: 'Item one' }, { p: 'Item two' }, { p: 'Tail' }]));
  const m0 = modelOf(fake);
  const index = m0.lines[1].start; // 29 (the anchor keeps 20 characters of context)
  const text = 'Item one\nItem two';
  const edit = { kind: 'format', index, end: index + text.length + 1, text, anchor: T.makeAnchor(m0, index, text),
    requests: [
      { deleteParagraphBullets: { range: range(index, index + 18) } },
      { insertText: { location: { index: index + 9, tabId: 't.0' }, text: '\t' } },
      { createParagraphBullets: { range: range(index, index + 19), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ] };
  fake.typeParagraph(0, 'Typed above'); // 12 index units
  const moved = T.relocateEdit(modelOf(fake), edit);
  assert.ok(moved);
  assert.strictEqual(moved.index, index + 12);
  deq(moved.requests, [
    { deleteParagraphBullets: { range: range(index + 12, index + 30) } },
    { insertText: { location: { index: index + 21, tabId: 't.0' }, text: '\t' } },
    { createParagraphBullets: { range: range(index + 12, index + 31), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  ]);
  assert.strictEqual(edit.requests[1].insertText.location.index, index + 9); // the journal entry itself is not changed
});

test('fake Docs: text styles in API shapes, field masks, the link auto-style', async () => {
  const fake = fakeDocsServer(doc([{ p: 'Hello world' }, { p: 'Second' }]));
  let r = await post(fake, [{ updateTextStyle: { range: range(1, 6), fields: 'weightedFontFamily,fontSize,foregroundColor,backgroundColor,bold',
    textStyle: { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 }, fontSize: { magnitude: 14, unit: 'PT' },
      foregroundColor: T.apiColor('#FF0000'), backgroundColor: T.apiColor('#FFFF00'), bold: true } } }]);
  assert.strictEqual(r.status, 200);
  deq(fake.fmt('t.0')[0], [[0, 5, { font: 'Courier New', size: 14, color: '#FF0000', bg: '#FFFF00', bold: true }]]);
  deq(fake.render(true).tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle, {
    bold: true, weightedFontFamily: { fontFamily: 'Courier New', weight: 400 }, fontSize: { magnitude: 14, unit: 'PT' },
    foregroundColor: { color: { rgbColor: { red: 1 } } }, backgroundColor: { color: { rgbColor: { red: 1, green: 1 } } } });
  assert.strictEqual(T.markedText(modelOf(fake).lines[0]), '{**Hello**}(font=Courier New size=14 color=#FF0000 bg=#FFFF00) world');
  // listed but absent: reset; not listed: kept
  await post(fake, [{ updateTextStyle: { range: range(1, 3), fields: 'fontSize,foregroundColor', textStyle: {} } }]);
  deq(fake.fmt('t.0')[0], [[0, 2, { font: 'Courier New', bg: '#FFFF00', bold: true }], [2, 5, { font: 'Courier New', size: 14, color: '#FF0000', bg: '#FFFF00', bold: true }]]);
  // a link: Docs underlines and colors it
  await post(fake, [{ updateTextStyle: { range: range(7, 12), fields: 'link', textStyle: { link: { url: 'https://e.org' } } } }]);
  deq(fake.fmt('t.0')[0][2], [6, 11, { link: 'https://e.org', underline: true, color: LINK_HEX }]);
  // a raw link object (heading link) is kept as given; linkAutoStyle off: no auto style
  const plain = fakeDocsServer(doc([{ p: 'Go there' }], undefined, { linkAutoStyle: false }));
  await post(plain, [{ updateTextStyle: { range: range(4, 9), fields: 'link', textStyle: { link: { headingId: 'h.1' } } } }]);
  deq(plain.fmt('t.0')[0], [[3, 8, { link: { headingId: 'h.1' } }]]);
  deq(modelOf(plain).lines[0].runs[0].linkRaw, { headingId: 'h.1' });
  // an unknown field name: HTTP 400 "Invalid field mask", nothing applied (the whole batch)
  const rev = fake.revision;
  const before = JSON.stringify(fake.fmt('t.0'));
  r = await post(fake, [{ updateTextStyle: { range: range(1, 3), fields: 'bold', textStyle: {} } }, { updateTextStyle: { range: range(1, 3), fields: 'fontsize', textStyle: {} } }]);
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error.message, /Invalid field mask.*fontsize/);
  r = await post(fake, [{ updateParagraphStyle: { range: range(1, 3), fields: 'align', paragraphStyle: { alignment: 'CENTER' } } }]);
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error.message, /Invalid field mask.*align/);
  assert.strictEqual(fake.revision, rev);
  assert.strictEqual(JSON.stringify(fake.fmt('t.0')), before);
});

test('fake Docs: paragraph styles honour fields; a new paragraph copies style and bullet', async () => {
  const fake = fakeDocsServer(doc([{ p: 'One' }, { p: 'Two', style: 'HEADING_2' }, { p: 'Three' }]));
  await post(fake, [{ updateParagraphStyle: { range: range(1, 9), fields: 'alignment,spaceAbove,lineSpacing',
    paragraphStyle: { alignment: 'CENTER', spaceAbove: { magnitude: 12, unit: 'PT' }, lineSpacing: 150 } } }]);
  deq(fake.pstyles('t.0'), [{ alignment: 'CENTER', spaceAbove: 12, lineSpacing: 150 }, { alignment: 'CENTER', spaceAbove: 12, lineSpacing: 150 }, {}]);
  deq(fake.styles('t.0'), ['NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT']); // namedStyleType not listed: kept
  await post(fake, [{ updateParagraphStyle: { range: range(5, 6), fields: 'alignment,namedStyleType', paragraphStyle: {} } }]);
  deq(fake.pstyles('t.0')[1], { spaceAbove: 12, lineSpacing: 150 });
  deq(fake.styles('t.0'), ['NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  const m = modelOf(fake);
  deq(m.lines[0].para, { align: 'center', spaceAbove: 12, lineSpacing: 150 });
  assert.strictEqual(T.markedText(m.lines[0]), '[center space 12/- line 1.5] One');
  // Enter inside a styled, bulleted paragraph: both halves keep the style and the bullet
  await post(fake, [{ createParagraphBullets: { range: range(1, 2), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } },
    { insertText: { location: { index: 3, tabId: 't.0' }, text: 'X\nY' } }]);
  deq(fake.text('t.0').split('\n'), ['OnX', 'Ye', 'Two', 'Three']);
  deq(fake.pstyles('t.0').slice(0, 2), [0, 1].map(() => ({ alignment: 'CENTER', spaceAbove: 12, lineSpacing: 150, indentStart: 36, indentFirstLine: 18 })));
  deq(fake.bullets('t.0').slice(0, 3), [{ listId: 'kix.list.1', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' }, { listId: 'kix.list.1', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' }, null]);
});

test('fake Docs: lists (leading tabs are the nesting level, joining a preceding list, removal keeps the indent)', async () => {
  const fake = fakeDocsServer(doc([{ p: 'Head' }, { p: 'One' }, { p: '\tTwo' }, { p: 'Three' }]));
  // Head 1-5, One 6-9, "\tTwo" 10-14, Three 15-20
  let r = await post(fake, [{ createParagraphBullets: { range: range(6, 15), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } }]);
  assert.strictEqual(r.status, 200);
  deq(fake.text('t.0').split('\n'), ['Head', 'One', 'Two', 'Three']); // the tab is gone: indices after it move by one
  const NUM = 'NUMBERED_DECIMAL_ALPHA_ROMAN';
  deq(fake.bullets('t.0'), [null, { listId: 'kix.list.1', level: 0, preset: NUM }, { listId: 'kix.list.1', level: 1, preset: NUM }, null]);
  deq(fake.pstyles('t.0')[2], { indentStart: 72, indentFirstLine: 54 });
  // rendered: bullet (nestingLevel left out at 0) and the tab's lists
  const tab = fake.render(true).tabs[0].documentTab;
  deq(tab.body.content[2].paragraph.bullet, { listId: 'kix.list.1' });
  deq(tab.body.content[3].paragraph.bullet, { listId: 'kix.list.1', nestingLevel: 1 });
  deq(tab.lists['kix.list.1'].listProperties.nestingLevels.slice(0, 2).map((l) => l.glyphType), ['DECIMAL', 'ALPHA']);
  // "Three" (now 14-19) with the same preset continues the list right before it
  await post(fake, [{ createParagraphBullets: { range: range(14, 19), bulletPreset: NUM } }]);
  deq(fake.bullets('t.0')[3], { listId: 'kix.list.1', level: 0, preset: NUM });
  // another preset: a new list
  await post(fake, [{ createParagraphBullets: { range: range(1, 5), bulletPreset: 'BULLET_CHECKBOX' } }]);
  deq(fake.bullets('t.0')[0], { listId: 'kix.list.2', level: 0, preset: 'BULLET_CHECKBOX' });
  deq(fake.render(true).tabs[0].documentTab.lists['kix.list.2'].listProperties.nestingLevels[0], { ...CHECKBOX_GLYPH, indentFirstLine: { magnitude: 18, unit: 'PT' }, indentStart: { magnitude: 36, unit: 'PT' } });
  const m = modelOf(fake);
  deq(m.lines.map((l) => l.list && [l.list.kind, l.list.level]), [['checklist', 0], ['number', 0], ['number', 1], ['number', 0]]);
  deq(T.runReadingTool('read_formatting', { start: 1, end: 4 }, snapOf(m)).split('\n').slice(2), ['1: [checklist] Head', '2: [number] One', '3: [number L2] Two', '4: [number] Three']);
  // deleteParagraphBullets: the bullet goes, the level's indent stays as a plain indent
  await post(fake, [{ deleteParagraphBullets: { range: range(10, 13) } }]);
  deq(fake.bullets('t.0')[2], null);
  deq(fake.pstyles('t.0')[2], { indentStart: 72, indentFirstLine: 72 });
  assert.strictEqual(T.markedText(modelOf(fake).lines[2]), '[indent 72/72] Two');
  // an unknown preset: 400, nothing changed
  const rev = fake.revision;
  r = await post(fake, [{ createParagraphBullets: { range: range(1, 5), bulletPreset: 'STARS' } }]);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(fake.revision, rev);
});
