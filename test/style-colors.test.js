'use strict';
// The colour a line takes from its named style (a saved chat, w17): Docs greys Heading 3 (#434343), Heading 4-6 and
// Subtitle (#666666) and stores no text colour equal to the one a line inherits. namedStyleValues reads a style's colour
// (the named-styles read asks for it); format_text's check counts an inherited colour as applied once the named styles
// are read; document_styles read, the formatting view's header and style_map name a style's colour where it is not black;
// a write that gives lines a grey style says so once. The colour is no sheet value: nothing compares or writes it.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docsBench, registerFakeGet } = require('./lib/fake-docs');
const { parseMask, maskPaths, covers } = require('./lib/field-mask');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, fresh, exec;

// The fields masks of the named-styles reads (the fake answers every namedStyles field whatever the mask names).
const namedMasks = [];
registerFakeGet((srv, url, params) => {
  const f = params.get('fields') || '';
  if (f.includes('namedStyles')) namedMasks.push(f);
  return null;
});

before(async () => {
  const env = await load();
  T = env.T;
  ({ fresh, exec } = docsBench(env, installIdentity(env), ref));
  env.state.settings.provider = 'anthropic'; env.state.googleConnected = true;
});

const spec = (items, more = {}) => ({ documentId: 'DOC123', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', items }], ...more });
// 1 h1, 2 h2, 3 h4, 4 body, 5 h3, 6 h4, 7 body
const DOC = () => [{ p: 'Notes', style: 'HEADING_1' }, { p: 'Methods', style: 'HEADING_2' }, { p: 'Sample preparation', style: 'HEADING_4' },
  { p: 'Body text here.' }, { p: 'Measurements', style: 'HEADING_3' }, { p: 'Data analysis', style: 'HEADING_4' }, { p: 'More body text.' }];
const TNR = 'Times New Roman';
// The named styles of a document that follows the default sheet (their colours are Docs' own).
const MATCHING = { NORMAL_TEXT: { font: TNR, size: 12, alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 },
  HEADING_1: { font: TNR, size: 16, spaceAbove: 18, spaceBelow: 0, alignment: 'START' }, HEADING_2: { font: TNR, size: 14, spaceAbove: 14, spaceBelow: 0, alignment: 'START' },
  HEADING_3: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' }, HEADING_4: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' },
  HEADING_5: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' }, HEADING_6: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' },
  TITLE: { alignment: 'START' }, SUBTITLE: { alignment: 'START' } };
const FT = { line: null, all: null, bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const FL = { end: null, style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null, apply_sheet: null };
const FL_OP = { op: 'format_lines', end: null, style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, indent_end: null, box: null, page_break_before: null };
const namedGets = () => fake.log.filter((x) => x.method === 'GET' && /namedStyles/.test(decodeURIComponent(x.url))).length;
const readFormatting = async () => (await exec('read_document', { scope: 'all', include: ['formatting'], doc: null })).content;
const styleNotes = (w) => w.content.split('\n').filter((l) => l.startsWith('Note: the named style'));

// A server that stores no text colour (the field stays in the mask: a reset), as Docs does with a value the text inherits.
function dropTextColor() {
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && /:batchUpdate/.test(url)) {
      const body = JSON.parse(init.body);
      for (const rq of body.requests) if (rq.updateTextStyle) delete rq.updateTextStyle.textStyle.foregroundColor;
      init = { ...init, body: JSON.stringify(body) };
    }
    return orig(url, init);
  };
  return () => { fake.fetch = orig; };
}

test('namedStyleValues: a style\'s colour, Normal text\'s black, none where the style sets none; the read\'s mask names it', async () => {
  await fresh(spec(DOC()));
  namedMasks.length = 0;
  const nm = T.namedStyleValues(await T.fetchNamedStylesRaw('DOC123', 't.0'));
  assert.deepStrictEqual([nm.NORMAL_TEXT.color, nm.TITLE.color, nm.HEADING_1.color, nm.HEADING_3.color, nm.HEADING_4.color, nm.HEADING_6.color, nm.SUBTITLE.color],
    ['#000000', undefined, undefined, '#434343', '#666666', '#666666', '#666666']);
  assert.ok(covers(maskPaths(parseMask(namedMasks[0])), 'tabs.documentTab.namedStyles.styles.textStyle.foregroundColor'), namedMasks[0]);
  // the colours that differ from Normal text's; a style without one shows Normal text's (Title, Heading 1); unread: unknown
  deq(T.styleColors(nm), { SUBTITLE: '#666666', HEADING_3: '#434343', HEADING_4: '#666666', HEADING_5: '#666666', HEADING_6: '#666666' });
  assert.strictEqual(T.namedColor({ NORMAL_TEXT: { color: '#333333' }, HEADING_1: {} }, 'HEADING_1'), '#333333');
  assert.strictEqual(T.namedColor({ NORMAL_TEXT: {}, HEADING_1: {} }, 'HEADING_1'), '#000000');
  assert.strictEqual(T.namedColor({}, 'HEADING_4'), null);
  assert.strictEqual(T.namedColor(null, 'HEADING_4'), null);
});

test('document_styles read: a style\'s colour where it is not black, no "(differs)" for it; apply never writes a colour', async () => {
  await fresh(spec(DOC(), { namedStyles: MATCHING }));
  const r = await exec('document_styles', { action: 'read' });
  assert.ok(!r.content.includes('(differs)'), r.content);
  assert.match(r.content, /^Normal text: Times New Roman 12 justify space 0\/0\nHeading 1: Times New Roman 16 left space 18\/0\n/); // black: silent
  assert.match(r.content, /\nHeading 3: Times New Roman 12 color #434343 left space 12\/0\nHeading 4: Times New Roman 12 color #666666 left space 12\/0\n/);
  assert.match((await exec('document_styles', { action: 'apply' })).content, /^No change: /);
  // a dark Normal text: on Normal text and on the styles that show it
  await fresh(spec(DOC(), { namedStyles: { NORMAL_TEXT: { color: '#333333' } } }));
  const d = (await exec('document_styles', { action: 'read' })).content.split('\n');
  deq(d.slice(0, 2), ['Normal text: Arial 11 color #333333 left space 0/0 (differs)', 'Heading 1: Arial 20 color #333333 left space 20/6 (differs)']);
  const a = await exec('document_styles', { action: 'apply' });
  assert.ok(a._ok && !/color/i.test(a.content), a.content);
  const fields = fake.log.filter((x) => x.method === 'POST').flatMap((x) => x.body.requests).filter((q) => q.updateNamedStyle).map((q) => q.updateNamedStyle.fields);
  assert.ok(fields.length && fields.every((f) => !/Color/.test(f)), fields.join(' | '));
  deq([fake.named('t.0').NORMAL_TEXT.color, fake.named('t.0').HEADING_4.color], ['#333333', '#666666']);
});

test('format_text color: an inherited colour that Docs does not store counts as applied once the named styles are read; an unstored black on a grey heading is reported', async () => {
  // Heading 3 without a colour of its own in this document (it shows Normal text's black); Heading 4 Docs' grey
  await fresh(spec(DOC(), { namedStyles: { HEADING_3: { color: null } } }));
  let w = await exec('format_text', { ...FT, old_text: 'Measurements', color: '#000000' });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(fake.fmt('t.0')[4], []); // Docs stored nothing: the heading shows black anyway
  // the grey Heading 4: Docs stores the black, it reads back
  w = await exec('format_text', { ...FT, old_text: 'Sample preparation', color: '#000000' });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(fake.fmt('t.0')[2], [[0, 18, { color: '#000000' }]]);
  // its own grey on a Heading 4 is not stored either, and counts as applied
  w = await exec('format_text', { ...FT, old_text: 'Data analysis', color: '#666666' });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  deq(fake.fmt('t.0')[5], []);
  // a black Docs did not store on a grey heading: still reported, with the line as it reads
  await fresh(spec(DOC()));
  const undrop = dropTextColor();
  w = await exec('format_text', { ...FT, old_text: 'Data analysis', color: '#000000' });
  undrop();
  assert.match(w.content, /did not apply all of it \(not shown: color #000000\); line 6 now reads:/);
});

test('the formatting view: the header names the colour a grey style gives its lines; an explicit black stays marked; the write results show the same header', async () => {
  T.namedNormalSeen.clear(); // a new panel session
  await fresh(spec(DOC()));
  const view = await readFormatting();
  const legend = view.split('\n')[0];
  assert.ok(legend.endsWith(' Unmarked text: Arial 11; h3 text #434343, h4 text #666666 (named styles).'), legend);
  deq(namedGets(), 1); // not read in this session yet: read once
  // the next turn: known, nothing read; the write path reads nothing for it either ("No change")
  await fresh(spec(DOC()));
  assert.strictEqual((await readFormatting()).split('\n')[0], legend);
  assert.match((await exec('format_text', { ...FT, old_text: 'Body text here.', bold: false })).content, /^No change: /);
  deq(namedGets(), 0);
  // a black written on a grey heading reads as an explicit colour
  assert.ok((await exec('format_text', { ...FT, old_text: 'Sample preparation', color: '#000000' }))._ok);
  as.model = await T.fetchDocModel('DOC123', 't.0');
  assert.match(await readFormatting(), /\n3: \[h4\] \{Sample preparation\}\(color=#000000\)\n/);
  // a write result that shows lines has the same header as the reading view
  await fresh(spec(DOC()));
  const undrop = dropTextColor();
  const w = await exec('format_text', { ...FT, old_text: 'Data analysis', color: '#000000' });
  undrop();
  assert.ok(w.content.split('\n').includes(legend), w.content);
  // a document without a grey style: no clause
  await fresh(spec([{ p: 'Notes', style: 'HEADING_1' }, { p: 'Body text here.' }]));
  assert.ok((await readFormatting()).split('\n')[0].endsWith(' Unmarked text: Arial 11.'));
});

test('the formatting view: with most text explicitly black, an explicit black on a grey heading is still shown', async () => {
  const black = (p) => ({ p, fmt: [[0, p.length, { color: '#000000' }]] });
  await fresh(spec([{ p: 'Sample preparation', style: 'HEADING_4', fmt: [[0, 18, { color: '#000000' }]] }, black('A long body paragraph whose text carries an explicit black.'),
    { p: 'Data analysis', style: 'HEADING_4' }, black('Another body paragraph in explicit black.')]));
  const view = (await readFormatting()).split('\n');
  assert.ok(view[0].endsWith(' Unmarked text: Arial 11 #000000; h4 text #666666 (named style).'), view[0]);
  deq(view.slice(2), ['1: [h4] {Sample preparation}(color=#000000)', '2: A long body paragraph whose text carries an explicit black.', '3: [h4] Data analysis',
    '4: Another body paragraph in explicit black.']);
});

test('style_map color: an unset colour reads as the style\'s where the style colours its text, "(none)" where it is black', async () => {
  await fresh(spec(DOC()));
  const r = await exec('style_map', { property: 'color', scope: null });
  assert.strictEqual(r.content, ['color (lines 1–7):', '- (none): lines 1–2, 4, 7', '- (h4 style: #666666): lines 3, 6', '- (h3 style: #434343): line 5'].join('\n'));
  // the named styles unread (a failed read): a heading's colour stays unnamed
  assert.strictEqual(T.styleMap(as.model, { property: 'color', scope: { start: 3, end: 4 } }, 4000, null, null), ['color (lines 3–4):', '- (h4 style): line 3', '- (none): line 4'].join('\n'));
});

test('a write that gives lines a grey style says so once, when the named styles are known in the turn; nothing is read for it', async () => {
  await fresh(spec(DOC()));
  // format_lines reads the named styles anyway
  let w = await exec('format_lines', { ...FL, start: 4, end: 4, style: 'h4' });
  assert.ok(w._ok, w.content);
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
  // a style that keeps Normal text's black, and lines that had the style already: no note
  w = await exec('format_lines', { ...FL, start: 7, end: 7, style: 'h2' });
  deq(styleNotes(w), []);
  w = await exec('format_lines', { ...FL, start: 3, end: 3, style: 'h4', align: 'center' });
  assert.ok(w._ok, w.content);
  deq(styleNotes(w), []);
  // edit_document: one note for its parts
  await fresh(spec(DOC()));
  w = await exec('edit_document', { operations: [{ ...FL_OP, start: 4, style: 'h3' }, { op: 'insert', line: 7, text: 'Outlook', style: 'h5', fill: null }] });
  assert.ok(w._ok, w.content);
  deq(styleNotes(w), ['Note: the named styles make h3 text #434343, h5 text #666666.']);
  // insert_after_line: only with the named styles read in this turn
  await fresh(spec(DOC()));
  const gets = namedGets();
  w = await exec('insert_after_line', { line: 7, text: 'Outlook', style: 'h4', fill: null });
  assert.ok(w._ok, w.content);
  deq([styleNotes(w), namedGets()], [[], gets]);
  await T.turnNamedStyles(as); // read earlier in the turn (a formatting view, a format_lines)
  w = await exec('insert_after_line', { line: 8, text: 'Summary', style: 'h4', fill: null });
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
});

test('format_lines style with numbers in one call: the grey style\'s note once, none for lines of that style or a black style', async () => {
  // style and numbers set both write: the combined plan (a saved chat: lines made h4 and numbered turned grey unexplained)
  await fresh(spec(DOC()));
  let w = await exec('format_lines', { ...FL, start: 4, end: 4, style: 'h4', numbers: 'set' });
  assert.ok(w._ok, w.content);
  assert.match(w.content, /numbered/);
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
  // only the style writes (no numbers to clear): the formatting part alone
  await fresh(spec(DOC()));
  w = await exec('format_lines', { ...FL, start: 4, end: 4, style: 'h4', numbers: 'clear' });
  assert.ok(w._ok, w.content);
  assert.match(w.content, /Note: no change for the 1 heading in line 4 is not numbered\./);
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
  // the lines are h4 already: the numbers alone, or with an alignment (combined), give no note
  await fresh(spec(DOC()));
  w = await exec('format_lines', { ...FL, start: 3, end: 3, style: 'h4', numbers: 'set' });
  assert.ok(w._ok, w.content);
  deq(styleNotes(w), []);
  await fresh(spec(DOC()));
  w = await exec('format_lines', { ...FL, start: 3, end: 3, style: 'h4', align: 'center', numbers: 'set' });
  assert.ok(w._ok, w.content);
  assert.match(w.content, /numbered/);
  deq(styleNotes(w), []);
  // a style that keeps Normal text's black
  await fresh(spec(DOC()));
  w = await exec('format_lines', { ...FL, start: 4, end: 4, style: 'h2', numbers: 'set' });
  assert.ok(w._ok, w.content);
  assert.match(w.content, /numbered/);
  deq(styleNotes(w), []);
  // apply_sheet with a style: the same combined plan
  await fresh(spec(DOC()));
  w = await exec('format_lines', { ...FL, start: 4, end: 4, style: 'h4', apply_sheet: true });
  assert.ok(w._ok, w.content);
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
  // edit_document: a format_lines part next to a number_headings part (refused on the same lines) keeps its note
  await fresh(spec(DOC()));
  w = await exec('edit_document', { operations: [{ ...FL_OP, start: 7, style: 'h4' }, { op: 'number_headings', numbers: 'set', start: 1, end: 6, prefix: null }] });
  assert.ok(w._ok, w.content);
  assert.match(w.content, /numbered/);
  deq(styleNotes(w), ['Note: the named style makes h4 text #666666.']);
});
