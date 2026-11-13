'use strict';
// test/lib/real-docs.js without the network: the reset's requests applied to a fake-docs server rebuild the spec (the eval
// cases' documents, a table, lists with levels and gaps), the pinned server for the sandbox (the panel's DOC123 mapped to
// the real id and back, other ids refused, one tab shown, writes pinned to it) and the request guard.
const test = require('node:test');
const assert = require('assert');
const { fakeDocsServer, docSpec } = require('./lib/fake-docs');
const { pinRequests, realDocsServer, clearAndInsert, styleRequests, bodyParagraphs, compareWithSpec, oneTabBody, mirrorServer } = require('./lib/real-docs');
const { loadCases, docsSpec, caseLines, docLines } = require('./lib/tool-eval');

// A client over a fake server (send: GET with its token; batchUpdate: POST).
function fakeClient(fake) {
  const send = async (method, url, body) => {
    const r = await fake.fetch(url, { method, headers: { Authorization: 'Bearer ' + fake.token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text, json: JSON.parse(text) };
  };
  return { send, get: (id, q) => send('GET', `https://docs.googleapis.com/v1/documents/${id}?${q}`), batchUpdate: (id, body) => send('POST', `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, body) };
}
// Runs a reset on a fake server holding `start` (tab tabId) and returns the differences from the spec.
async function rebuild(spec, start, tabId = 't.0') {
  const fake = fakeDocsServer(start);
  const client = fakeClient(fake);
  const read = async () => (await client.get(start.documentId, 'includeTabsContent=true')).json;
  const tabOf = (doc) => doc.tabs.find((t) => t.tabProperties.tabId === tabId).documentTab;
  const a = clearAndInsert(spec, spec.tabs[0], tabOf(await read()), tabId);
  const ra = await client.batchUpdate(start.documentId, { requests: a.requests });
  assert.strictEqual(ra.status, 200, JSON.stringify(ra.json));
  const b = styleRequests(spec, spec.tabs[0], bodyParagraphs(tabOf(await read()).body.content), tabId);
  const rb = await client.batchUpdate(start.documentId, { requests: b.requests });
  assert.strictEqual(rb.status, 200, JSON.stringify(rb.json));
  return { diffs: compareWithSpec(spec, 0, oneTabBody(await read(), tabId), tabId), unsupported: [...a.unsupported, ...b.unsupported], fake };
}
// A document with something to clear: headings, a bulleted last paragraph, bold text.
const messy = (tabId = 't.0') => ({ documentId: 'REAL1', title: 'x', tabs: [{ id: tabId, title: 'T', items: [
  { p: 'Old title', style: 'TITLE' }, { p: 'Old bold text', fmt: [[0, 3, { bold: true }]] }, { p: 'Old item', bullet: { listId: 'l1', level: 1 } },
] }] });

test('every Docs API case document of the eval is rebuilt exactly from a used document', async () => {
  const cases = loadCases().filter((c) => c.docsApi && Array.isArray(c.doc));
  assert.ok(cases.length > 20);
  for (const c of cases) {
    const spec = docsSpec(caseLines(c), c);
    const { diffs, unsupported } = await rebuild(spec, messy());
    assert.deepStrictEqual(diffs, [], c.id);
    assert.deepStrictEqual(unsupported, [], c.id);
  }
});

test('lists with levels, a gap, a second list, indents, text styles and a table', async () => {
  const spec = { documentId: 'REAL1', title: 'x', tabs: [{ id: 't.0', title: 'T', lists: { b: 'BULLET_DISC_CIRCLE_SQUARE' }, items: [
    { p: 'Title', style: 'TITLE' },
    { p: 'One', style: 'HEADING_1', bullet: { listId: 'h', level: 0, preset: 'NUMBERED_DECIMAL_NESTED' } },
    { p: 'Body under one', pstyle: { indentStart: 10 } },
    { p: 'One one', style: 'HEADING_2', bullet: { listId: 'h', level: 1, preset: 'NUMBERED_DECIMAL_NESTED' }, pstyle: { indentStart: 28.5, indentFirstLine: 21.26 } },
    { p: 'Two', style: 'HEADING_1', bullet: { listId: 'h', level: 0, preset: 'NUMBERED_DECIMAL_NESTED' } },
    { p: 'a bullet', bullet: { listId: 'b', level: 0 } }, { p: 'a deeper bullet', bullet: { listId: 'b', level: 2 } },
    { p: 'Mixed: bold, italic 14 pt, a font, red, super', fmt: [[7, 11, { bold: true }], [13, 19, { italic: true, size: 14 }], [21, 27, { font: 'Georgia' }], [29, 32, { color: '#FF0000' }], [34, 39, { script: 'super' }]] },
    { table: [[[{ p: 'A1' }], [{ p: 'B1' }, { p: 'B1 second' }]], [[{ p: '' }], [{ p: 'B2', fmt: [[0, 2, { bold: true }]] }]]] },
    { p: 'After the table' },
  ] }] };
  const { diffs, unsupported } = await rebuild(spec, messy());
  assert.deepStrictEqual(diffs, []);
  assert.deepStrictEqual(unsupported, []);
});

test('what cannot be built is named', async () => {
  const spec = { documentId: 'REAL1', title: 'x', tabs: [{ id: 't.0', title: 'T', footnotes: { f1: [{ p: ' note' }] }, items: [
    { table: [[[{ p: 'A' }]]] }, { p: 'Text[^f1] and ' + String.fromCharCode(0xFFFC), objects: [[9, { image: { id: 'i1' } }]] }, { toc: [{ p: 'x' }] }, { table: [[[{ p: 'B' }]]], pinned: 1 },
  ] }] };
  const a = clearAndInsert(spec, spec.tabs[0], { body: { content: [{ endIndex: 1 }, { startIndex: 1, endIndex: 2, paragraph: { elements: [] } }] } }, 't.0');
  const words = a.unsupported.join('\n');
  for (const w of ['footnotes are not built', 'a table at the start', 'a table of contents', 'pinned rows', 'a table at the end']) assert.match(words, new RegExp(w));
  const b = styleRequests(spec, spec.tabs[0], [{ start: 1, end: 2, text: '' }, { start: 3, end: 5, text: 'A' }, { start: 9, end: 23, text: 'Text and ' }, { start: 24, end: 26, text: 'B' }], 't.0');
  assert.match(b.unsupported.join('\n'), /footnote marks and objects are not built/);
});

test('real shapes: an explicit 0 comes as a Dimension without a magnitude and reads as 0 (an own indent), the real named styles count', () => {
  const body = { documentId: 'REAL1', tabs: [{ tabProperties: { tabId: 't.x', title: 'T', index: 0 }, documentTab: {
    body: { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }, { startIndex: 1, endIndex: 9, paragraph: { elements: [{ startIndex: 1, endIndex: 9, textRun: { content: 'Methods\n', textStyle: {} } }],
      paragraphStyle: { namedStyleType: 'HEADING_2', indentStart: { unit: 'PT' }, indentFirstLine: { unit: 'PT' }, spaceBelow: { unit: 'PT' } } } }] },
    namedStyles: { styles: [{ namedStyleType: 'HEADING_2', textStyle: { fontSize: { magnitude: 14, unit: 'PT' } }, paragraphStyle: { spaceBelow: { magnitude: 6, unit: 'PT' }, indentStart: { magnitude: 28.5, unit: 'PT' } } }] },
  } }] };
  const [l] = docLines(mirrorServer(body, 't.x'), 't.x');
  assert.deepStrictEqual([l.ownIndent, l.indent, l.spaceBelow, l.size], [[0, 0], [0, 0], 0, 14]);
});

test('fake-docs refuses an updateNamedStyle mask without namedStyleType, as Google does', async () => {
  const fake = fakeDocsServer(docSpec());
  const r = await fakeClient(fake).batchUpdate('DOC123', { requests: [{ updateNamedStyle: { namedStyle: { namedStyleType: 'HEADING_3', textStyle: { fontSize: { magnitude: 15, unit: 'PT' } } }, fields: 'textStyle.fontSize' } }] });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error.message, /Named style type is required/);
});

test('the request guard pins locations and top-level tab fields, and refuses other tabs and cross-tab requests', () => {
  const notes = [];
  const out = pinRequests([
    { insertText: { location: { index: 5 }, text: 'x' } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 3, tabId: 't.me' }, paragraphStyle: {}, fields: 'alignment' } },
    { updateNamedStyle: { namedStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { insertTableRow: { tableCellLocation: { tableStartLocation: { index: 9 }, rowIndex: 0, columnIndex: 0 }, insertBelow: true } },
    { createHeader: { type: 'DEFAULT', sectionBreakLocation: { index: 0 } } },
  ], 't.me', notes);
  assert.strictEqual(out[0].insertText.location.tabId, 't.me');
  assert.strictEqual(out[2].updateNamedStyle.tabId, 't.me');
  assert.strictEqual(out[3].insertTableRow.tableCellLocation.tableStartLocation.tabId, 't.me');
  assert.strictEqual(out[4].createHeader.sectionBreakLocation.tabId, 't.me');
  assert.strictEqual(notes.length, 4);
  assert.throws(() => pinRequests([{ insertText: { location: { index: 1, tabId: 't.0' }, text: 'x' } }], 't.me'), /addresses tab t\.0/);
  assert.throws(() => pinRequests([{ replaceAllText: { containsText: { text: 'a' }, replaceText: 'b' } }], 't.me'), /may reach other tabs/);
  assert.throws(() => pinRequests([{ createFooter: { type: 'DEFAULT' } }], 't.me'), /without sectionBreakLocation/);
});

test('the pinned server: the panel\'s id mapped both ways, one tab shown, other ids and unsafe reads not sent', async () => {
  const spec = docSpec();
  spec.documentId = 'REALID';
  const fake = fakeDocsServer(spec);
  const srv = realDocsServer(fakeClient(fake), { docId: 'REALID', tabId: 't.second' });
  const get = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123?includeTabsContent=true&fields=documentId,revisionId,tabs', { headers: { Authorization: 'Bearer panel' } });
  const doc = await get.json();
  assert.strictEqual(doc.documentId, 'DOC123');
  assert.deepStrictEqual(doc.tabs.map((t) => [t.tabProperties.tabId, t.tabProperties.index]), [['t.second', 0]]);
  assert.strictEqual(await srv.fetch('https://example.org/x', {}), null);
  const other = await srv.fetch('https://docs.googleapis.com/v1/documents/OTHER?includeTabsContent=true', {});
  assert.strictEqual(other.status, 404);
  const flat = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123?fields=body', {});
  assert.strictEqual(flat.status, 400);
  const rev = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123?fields=revisionId', {});
  assert.strictEqual(rev.status, 200);
  const before = fake.log.length;
  const bad = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index: 1, tabId: 't.0' }, text: 'x' } }] }) });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(fake.log.length, before); // nothing sent
  const ok = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: 'New ' } }] }) });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).documentId, 'DOC123');
  assert.strictEqual(fake.text('t.second').split('\n')[0], 'New Second tab');
  assert.strictEqual(fake.text('t.0').split('\n')[0], 'Report 📊');
  assert.deepStrictEqual(srv.notes, ['a read without includeTabsContent (body) was not sent: it would read the first tab', 'requests[0].insertText addresses tab t.0, not the test tab: not sent', 'insertText.location: tabId added']);
  // The mirror reads the real named styles: the second tab's own.
  const m = mirrorServer(oneTabBody(fake.render(true), 't.second'), 't.second');
  assert.strictEqual(m.tabs.length, 1);
});
