'use strict';
// Paragraph controls (updateParagraphStyle): format_lines box (shaded / bordered / none: the fixed look, every box field
// in the mask, exact undo of a former border), page_break_before and indent_end (requests, the tag, "No change", undo),
// the refusals in a table cell, the verification by the re-read; the formatting sheet's controls per type ("h1
// page-break", "h2 keep-with-next", the default headings' keep-with-next inherited from Docs' heading styles): on new
// headings, on a style change (the call's own page_break_before wins), through apply_sheet (list items and table cells
// left alone, one undo), and in document_styles apply (updateNamedStyle).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Lines: 1 Title, 2 Intro (h1), 3 Alpha, 4 Beta, 5 Cell A, 6 Cell B (a table), 7 Item (a bullet), 8 Methods (h2), 9 Last.
const spec = (over = {}) => docSpec({ items: [
  { p: 'Title', style: 'TITLE' },
  { p: 'Intro', style: 'HEADING_1' },
  { p: 'Alpha' }, { p: 'Beta' },
  { table: [[[{ p: 'Cell A' }], [{ p: 'Cell B' }]]] },
  { p: 'Item', bullet: { listId: 'kix.b', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  { p: 'Methods', style: 'HEADING_2', ...(over.h2 || {}) },
  { p: 'Last' },
] });
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, indent_end: null, space_above: null, space_below: null,
  line_spacing: null, box: null, page_break_before: null, numbers: null, apply_sheet: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });
const pt = (n) => ({ magnitude: n, unit: 'PT' });
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const pstyle = (s, e, paragraphStyle, fields) => ({ updateParagraphStyle: { range: range(s, e), paragraphStyle, fields } });
const grey = (v) => ({ color: { rgbColor: { red: v / 255, green: v / 255, blue: v / 255 } } });
const BORDER = { color: grey(191), width: pt(0.75), padding: pt(4), dashStyle: 'SOLID' };
const BOX_FIELDS = 'shading,borderTop,borderBottom,borderLeft,borderRight,borderBetween';
const undo = async () => { const u = pushTool(await exec('undo_last_edit', {})); assert.ok(u._ok, u.content); return u; };
const RF = (start, end) => T.runReadingTool('read_formatting', { start, end }, as);
const paraPosts = () => lastPost().requests.filter((r) => r.updateParagraphStyle);

test('format_lines box: shaded, bordered and none with the fixed look; every box field in the mask; the tag; exact undo of a former border', async () => {
  await fresh(spec());
  const s = pushTool(await exec('format_lines', fl(3, 4, { box: 'shaded' })));
  assert.ok(s._ok, s.content);
  deq(lastPost().requests, [pstyle(13, 24, { shading: { backgroundColor: grey(242) } }, BOX_FIELDS)]);
  assert.strictEqual(s.content, 'Done: formatted lines 3–4 (shaded); the document has 9 lines.');
  assert.ok(RF(3, 4).endsWith('\n3: [shaded] Alpha\n4: [shaded] Beta'), RF(3, 4));
  // the same again: nothing is sent
  const again = await exec('format_lines', fl(3, 4, { box: 'shade' }), 'again');
  assert.match(again.content, /^Already done in this message: formatted lines 3–4 \(shaded\)/);
  // bordered replaces the shading (reset), all four sides written whole
  const b = pushTool(await exec('format_lines', fl(3, 3, { box: 'bordered' })));
  deq(lastPost().requests, [pstyle(13, 19, { borderTop: BORDER, borderBottom: BORDER, borderLeft: BORDER, borderRight: BORDER }, BOX_FIELDS)]);
  assert.ok(b._ok, b.content);
  assert.ok(RF(3, 3).endsWith('\n3: [bordered] Alpha'), RF(3, 3));
  // undo: the shading comes back exactly, the borders go
  await undo();
  deq(fake.pstyles('t.0')[2], { shading: { backgroundColor: grey(242) } });
  // none removes it; undo puts it back
  pushTool(await exec('format_lines', fl(3, 4, { box: 'none' })));
  deq(lastPost().requests, [pstyle(13, 24, {}, BOX_FIELDS)]);
  deq(fake.pstyles('t.0').slice(2, 4), [{}, {}]);
  await undo();
  await undo();
  deq(fake.pstyles('t.0').slice(2, 4), [{}, {}]);
  // a border the user drew (red, 2 pt) is restored exactly after a box
  const red = { color: { color: { rgbColor: { red: 1 } } }, width: pt(2), padding: pt(1), dashStyle: 'DASH' };
  await fresh(docSpec({ items: [{ p: 'Quote', pstyle: { borderLeft: red } }, { p: 'Next' }] }));
  assert.ok(RF(1, 1).endsWith('\n1: Quote'), RF(1, 1)); // one side is not a box
  pushTool(await exec('format_lines', fl(1, 1, { box: 'shaded' })));
  deq(pushTool(await exec('undo_last_edit', {}))._ok, true);
  deq(fake.pstyles('t.0')[0], { borderLeft: red });
});

test('format_lines page_break_before and indent_end: requests, words, tag, "No change", undo; refused in a table cell; loose values', async () => {
  await fresh(spec());
  const w = pushTool(await exec('format_lines', fl(8, 8, { page_break_before: true, indent_end: 36 })));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [pstyle(48, 56, { indentEnd: pt(36), pageBreakBefore: true }, 'indentEnd,pageBreakBefore')]); // after the table (its end index)
  assert.strictEqual(w.content, 'Done: formatted line 8 (right indent 36, page break before); the document has 9 lines.');
  assert.ok(RF(8, 8).endsWith('\n8: [h2 indent-end 36 page-break] Methods'), RF(8, 8));
  T.snapshotDocument(as); as.formatLinesDone = null;
  const same = await exec('format_lines', fl(8, 8, { page_break_before: 'yes' }));
  assert.match(same.content, /^No change: line 8 is already formatted like this \(page break before\)/);
  await undo();
  deq(fake.pstyles('t.0')[7], {});
  // false on a line without a break: nothing to change (it inherits none)
  const none = await exec('format_lines', fl(3, 3, { page_break_before: false }));
  assert.match(none.content, /^No change: line 3 is already formatted like this \(no page break before\)/);
  // errors: a bad value, a table cell
  const bad = await exec('format_lines', fl(3, 3, { box: 'dotted' }));
  deq([bad.content, bad._message], ['Error: box must be shaded, bordered or none', 'format_lines: invalid box']);
  const bad2 = await exec('format_lines', fl(3, 3, { page_break_before: 'maybe' }));
  assert.match(bad2.content, /^Error: page_break_before must be true, false or null; got the string "maybe"/);
  for (const over of [{ page_break_before: true }, { box: 'shaded' }]) {
    const cell = await exec('format_lines', fl(4, 5, over));
    deq([cell.content, cell._message], ['Error: line 5 is in a table cell: box and page_break_before work on lines outside tables; leave it out', 'format_lines: box or page break in a table']);
  }
});

test('format_lines verification: a box Google Docs did not apply is named with the line', async () => {
  await fresh(spec());
  // A server that drops the shading of every updateParagraphStyle (the rest applies).
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init && init.method === 'POST' && /:batchUpdate/.test(url)) {
      const body = JSON.parse(init.body);
      for (const r of body.requests) if (r.updateParagraphStyle) delete r.updateParagraphStyle.paragraphStyle.shading;
      init = { ...init, body: JSON.stringify(body) };
    }
    return real(url, init);
  };
  const w = pushTool(await exec('format_lines', fl(3, 3, { box: 'shaded' })));
  assert.ok(w._ok, w.content);
  assert.match(w.content, /\nNote: Google Docs did not apply all of it \(not shown: shaded\); line 3 now reads:/);
});

test('edit_document: a format_lines operation takes box and page_break_before', async () => {
  await fresh(spec());
  const w = pushTool(await exec('edit_document', { operations: [{ op: 'format_lines', start: 3, end: 3, box: 'bordered' }, { op: 'format_lines', start: 8, end: 8, page_break_before: true }] }));
  assert.ok(w._ok, w.content);
  deq(fake.pstyles('t.0')[7], { pageBreakBefore: true });
  assert.ok(fake.pstyles('t.0')[2].borderTop);
  await undo();
  deq([fake.pstyles('t.0')[2], fake.pstyles('t.0')[7]], [{}, {}]);
});

test('the sheet\'s controls: parsed per type; the default headings keep with next (inherited, nothing written); h1 page-break on new and restyled headings; the call wins', async () => {
  const p = T.parseStyleSheet('Formatting: h1 page-break keep-lines; h2 no-keep-with-next widow-control; body no-widow-control keep-next; h3 page-brake');
  deq(JSON.parse(JSON.stringify(p.entries)), { h1: { pageBreakBefore: true, keepLinesTogether: true }, h2: { keepWithNext: false, avoidWidowAndOrphan: true },
    body: { avoidWidowAndOrphan: false, keepWithNext: true } });
  deq(p.ignored, ['h3 page-brake']);
  // the default: a new heading inherits keep-with-next from Docs' heading style; no control request
  await fresh(spec());
  pushTool(await exec('insert_after_line', { line: 4, text: 'New part', style: 'h1' }));
  assert.ok(!paraPosts().some((r) => /keepWithNext|pageBreakBefore/.test(r.updateParagraphStyle.fields)), JSON.stringify(lastPost().requests));
  // h1 page-break: a new h1 gets it; a line made h1 gets it; an explicit page_break_before false wins
  await fresh(spec());
  as.docInstructions = 'Formatting: h1 page-break';
  pushTool(await exec('insert_after_line', { line: 4, text: 'New part', style: 'h1' }));
  assert.ok(paraPosts().some((r) => r.updateParagraphStyle.paragraphStyle.pageBreakBefore === true), JSON.stringify(lastPost().requests));
  deq(fake.pstyles('t.0')[4].pageBreakBefore, true);
  const f = pushTool(await exec('format_lines', fl(4, 4, { style: 'h1' })));
  assert.ok(f._ok, f.content);
  deq(fake.pstyles('t.0')[3].pageBreakBefore, true);
  await undo();
  assert.strictEqual(fake.pstyles('t.0')[3].pageBreakBefore, undefined);
  pushTool(await exec('format_lines', fl(4, 4, { style: 'h1', page_break_before: false })));
  deq(fake.pstyles('t.0')[3].pageBreakBefore, false);
});

test('apply_sheet with controls: headings get keep-with-next where they turned it off and the page break; list items and cells untouched; one undo; verified', async () => {
  await fresh(spec({ h2: { pstyle: { keepWithNext: false } } }));
  as.docInstructions = 'Formatting: h1 page-break; body widow-control';
  const before = fake.pstyles('t.0');
  const w = pushTool(await exec('format_lines', fl(null, null, { apply_sheet: true })));
  assert.ok(w._ok, w.content);
  assert.ok(!/still differ/.test(w.content), w.content);
  const ps = fake.pstyles('t.0');
  deq(ps[1].pageBreakBefore, true); // h1
  assert.strictEqual(ps[1].keepWithNext, undefined); // inherited from Heading 1 already
  deq(ps[7].keepWithNext, true); // h2 had it off
  deq([ps[2].avoidWidowAndOrphan, ps[3].avoidWidowAndOrphan, ps[8].avoidWidowAndOrphan], [true, true, true]); // body
  assert.ok(ps[4].avoidWidowAndOrphan === undefined && ps[5].avoidWidowAndOrphan === undefined); // cells
  deq(Object.keys(ps[6]).filter((k) => /keep|widow|pageBreak/i.test(k)), []); // the list item
  assert.strictEqual(ps[0].pageBreakBefore, undefined); // the title is not in the sheet
  T.snapshotDocument(as); as.formatLinesDone = null;
  const again = await exec('format_lines', fl(null, null, { apply_sheet: true }));
  assert.match(again.content, /^No change: lines 1–9 already follow the formatting sheet\./);
  await undo();
  deq(fake.pstyles('t.0').map((x) => JSON.stringify(Object.keys(x).filter((k) => !['spaceAbove', 'spaceBelow', 'alignment', 'lineSpacing'].includes(k)).sort())),
    before.map((x) => JSON.stringify(Object.keys(x).sort())));
  deq(fake.pstyles('t.0')[7].keepWithNext, false);
});

test('document_styles apply: the sheet\'s controls go into the named styles (updateNamedStyle pageBreakBefore); undo restores', async () => {
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'Body.' }] }));
  as.docInstructions = 'Formatting: h1 page-break';
  const r = pushTool(await exec('document_styles', { action: 'apply', page: null }, 'nsc'));
  assert.ok(r._ok, r.content);
  const h1 = lastPost().requests.find((q) => q.updateNamedStyle && q.updateNamedStyle.namedStyle.namedStyleType === 'HEADING_1').updateNamedStyle;
  assert.match(h1.fields, /paragraphStyle\.pageBreakBefore/);
  deq(h1.namedStyle.paragraphStyle.pageBreakBefore, true);
  assert.ok(!/keepWithNext/.test(h1.fields), h1.fields); // Docs' Heading 1 keeps with next already
  deq(fake.tabs[0].named.HEADING_1.paragraphStyle.pageBreakBefore, true);
  const read = await exec('document_styles', { action: 'read', page: null });
  assert.match(read.content, /\nHeading 1: Times New Roman 16 left space 18\/0 page-break\n/);
  await undo();
  assert.strictEqual(fake.tabs[0].named.HEADING_1.paragraphStyle.pageBreakBefore, undefined);
});

test('the fake refuses a partial border, as the API does (the box writes each side whole)', async () => {
  await fresh(spec());
  const res = await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer ' + fake.token },
    body: JSON.stringify({ requests: [pstyle(13, 19, { borderTop: { width: pt(1) } }, 'borderTop')] }) });
  deq(res.status, 400);
});
