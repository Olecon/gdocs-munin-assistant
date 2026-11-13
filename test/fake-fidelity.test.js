'use strict';
// test/lib/fake-docs.js against what the real Docs API answered (development/tools/real-docs.js facts 6, 8b, 10): an
// updateNamedStyle mask naming a parent with one of its leaves keeps the part's other fields; updateDocumentStyle cannot
// unset a margin, the page size or the background (a 400), but resets the page number start and the orientation; an
// image's contentUri is on docs.google.com.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq } = require('./lib/sandbox');
const { fakeDocsServer } = require('./lib/fake-docs');

const spec = (items, more = {}) => ({ documentId: 'DOC1', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', items, ...more }] });
const post = (f, requests) => f.fetch('https://docs.googleapis.com/v1/documents/DOC1:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) });
const get = async (f) => (await f.fetch('https://docs.googleapis.com/v1/documents/DOC1?includeTabsContent=true', { headers: { Authorization: 'Bearer tok-1' } })).json();

test('fake Docs: updateNamedStyle with a parent and its leaf keeps the other fields; the parent alone replaces the part', async () => {
  const f = fakeDocsServer(spec([{ p: 'Grey heading', style: 'HEADING_3' }]));
  const ns = (fields) => ({ updateNamedStyle: { namedStyle: { namedStyleType: 'HEADING_3', textStyle: { fontSize: { magnitude: 15, unit: 'PT' } } }, fields, tabId: 't.0' } });
  assert.strictEqual((await post(f, [ns('namedStyleType,textStyle,textStyle.fontSize')])).status, 200);
  deq(f.named('t.0').HEADING_3, { size: 15, color: '#434343', spaceAbove: 16, spaceBelow: 4 });
  await post(f, [ns('namedStyleType,textStyle')]);
  deq(f.named('t.0').HEADING_3, { size: 15, spaceAbove: 16, spaceBelow: 4 });
});

test('fake Docs: updateDocumentStyle cannot unset margins, the page size or the background; the other fields reset', async () => {
  const f = fakeDocsServer(spec([{ p: 'Text' }], { documentStyle: { marginTop: { magnitude: 72, unit: 'PT' }, pageNumberStart: 3 } }));
  for (const k of ['marginTop', 'marginHeader', 'pageSize', 'background']) {
    const r = await post(f, [{ updateDocumentStyle: { documentStyle: {}, fields: k, tabId: 't.0' } }]);
    assert.strictEqual(r.status, 400, k);
    assert.match((await r.json()).error.message, new RegExp(`A value for ${k} must be specified`));
  }
  assert.strictEqual((await post(f, [{ updateDocumentStyle: { documentStyle: {}, fields: 'pageNumberStart,flipPageOrientation', tabId: 't.0' } }])).status, 200);
  deq((await get(f)).tabs[0].documentTab.documentStyle, { marginTop: { magnitude: 72, unit: 'PT' } });
});

test('fake Docs: a size or color equal to the inherited one is not stored (dropInherited); bold stores the shown font (boldFont)', async () => {
  const items = [{ p: 'Heading', style: 'HEADING_1' }, { p: 'Body text' }];
  const ts = (s, e, textStyle, fields) => ({ updateTextStyle: { range: { startIndex: s, endIndex: e, tabId: 't.0' }, textStyle, fields } });
  const black = { foregroundColor: { color: { rgbColor: {} } } };
  const reqs = [ts(1, 4, { fontSize: { magnitude: 20, unit: 'PT' } }, 'fontSize'), ts(9, 13, { fontSize: { magnitude: 11, unit: 'PT' }, ...black }, 'fontSize,foregroundColor'),
    ts(14, 18, { fontSize: { magnitude: 12, unit: 'PT' }, bold: true }, 'fontSize,bold')];
  const f = fakeDocsServer(spec(items, {}));
  assert.strictEqual((await post(f, reqs)).status, 200);
  // H1's 20 pt and Normal text's 11 pt and black are dropped; 12 pt stays, and the bold stores Arial (weight 400)
  deq(f.fmt('t.0'), [[], [[5, 9, { size: 12, bold: true, font: 'Arial' }]]]);
  // a bold on Heading 1 under a Georgia Normal text stores Georgia (the font the heading shows)
  const h = fakeDocsServer({ ...spec(items, {}), namedStyles: { NORMAL_TEXT: { font: 'Georgia' } } });
  await post(h, [ts(1, 4, { bold: true }, 'bold')]);
  deq(h.fmt('t.0')[0], [[0, 3, { bold: true, font: 'Georgia' }]]);
  // both off (spec.dropInherited: false, spec.boldFont: false): stored as written
  const g = fakeDocsServer({ ...spec(items, {}), dropInherited: false, boldFont: false });
  await post(g, reqs);
  deq(g.fmt('t.0'), [[[0, 3, { size: 20 }]], [[0, 4, { size: 11, color: '#000000' }], [5, 9, { size: 12, bold: true }]]]);
});

test('fake Docs: an image\'s contentUri is on docs.google.com, as the real API gives it', async () => {
  const f = fakeDocsServer(spec([{ p: 'Fig ￼ here', objects: [[4, { image: { id: 'kix.i1', title: 'Fig', width: 100, height: 50 } }]] }]));
  const io = (await get(f)).tabs[0].documentTab.inlineObjects['kix.i1'];
  assert.strictEqual(new URL(io.inlineObjectProperties.embeddedObject.imageProperties.contentUri).host, 'docs.google.com');
});
