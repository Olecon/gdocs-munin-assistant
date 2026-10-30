'use strict';
// The foundation of the table, page-part, comment, reference and history features: the line model's table
// cells, model.tables, model.segments and model.toc; the fake Docs server's tables, segments and plugin hooks;
// the segment-aware request builders; commitSequence with its rollback; the 'multi' and 'requests' journal kinds;
// and the registries of src/registry.js (tools, prompt lines, undo kinds, self-test rows, line notation, hooks).
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docsBench, OC, registerFakeRequest, registerFakeRender, registerFakeGet, registerFakeInit } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// A body with a title, a table of contents, a footnote mark, a 2×2 table (a cell with two paragraphs, column
// widths), a heading and a second mark; a header, a footer and two footnotes.
const partsSpec = ({ segments = true } = {}) => ({ documentId: 'DOC123', title: 'Parts', tabs: [{ id: 't.0', title: 'Main',
  items: [
    { p: 'Title', style: 'TITLE' },
    ...(segments ? [{ toc: [{ p: 'Methods' }] }] : []),
    { p: segments ? 'Body with a note[^fn.a] here.' : `Body with a note${OC} here.` },
    { table: [[[{ p: 'A' }], [{ p: 'B' }, { p: 'B2' }]], [[{ p: 'C' }], [{ p: 'D' }]]], widths: [{ type: 'FIXED_WIDTH', pt: 120 }, { type: 'EVENLY_DISTRIBUTED' }] },
    { p: 'Methods', style: 'HEADING_1' },
    { p: segments ? 'Second note[^fn.b].' : `Second note${OC}.` },
  ],
  ...(segments ? {
    headers: { 'kix.h1': [{ p: 'Draft header' }] }, footers: { 'kix.f1': [{ p: 'Page footer' }] },
    footnotes: { 'fn.a': [{ p: ' First note' }], 'fn.b': [{ p: ' Second' }] },
  } : {}),
}] });
const modelOf = (srv, Tx = T) => Tx.buildLineModel(srv.render(true), 't.0', 'DOC123');
const post = (srv, requests) => srv.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate',
  { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
const loc = (index, extra = {}) => ({ index, tabId: 't.0', ...extra });

test('line model: segment and cell on every line, model.tables, model.segments and model.toc; body numbering unchanged', () => {
  const m = modelOf(fakeDocsServer(partsSpec()));
  deq(m.lines.map((l) => l.text), ['Title', `Body with a note${OC} here.`, 'A', 'B', 'B2', 'C', 'D', 'Methods', `Second note${OC}.`]);
  assert.ok(m.lines.every((l) => l.segment === 'body'));
  deq(m.lines.map((l) => l.cell || null), [null, null, { t: 1, r: 0, c: 0 }, { t: 1, r: 0, c: 1 }, { t: 1, r: 0, c: 1 }, { t: 1, r: 1, c: 0 }, { t: 1, r: 1, c: 1 }, null, null]);
  const t = m.tables[0];
  deq({ ...t, start: 0, end: 0 }, { n: 1, start: 0, end: 0, rows: 2, cols: 2, nested: false, merged: [], widths: [{ type: 'FIXED_WIDTH', pt: 120 }, { type: 'EVENLY_DISTRIBUTED', pt: null }], firstLine: 3, lastLine: 7 });
  assert.strictEqual(t.start, m.lines[1].end + 1); // the table follows the body line's newline
  deq(m.toc, { start: m.toc.start, end: m.toc.end, beforeLine: 2, lines: ['Methods'] });
  deq(m.segments.map((s) => [s.type, s.kind, s.label, s.segmentId, s.n, s.text, s.refLine]),
    [['header', 'default', 'header', 'kix.h1', undefined, 'Draft header', undefined], ['footer', 'default', 'footer', 'kix.f1', undefined, 'Page footer', undefined],
      ['footnote', null, 'footnote 1', 'fn.a', 1, ' First note', 2], ['footnote', null, 'footnote 2', 'fn.b', 2, ' Second', 9]]);
  const fn = T.findSegment(m, 'Footnote 1');
  assert.strictEqual(fn.refIndex, m.lines[1].start + 'Body with a note'.length);
  deq(fn.lines.map((l) => [l.line, l.start, l.end, l.segment, l.segmentId, l.footnote]), [[1, 0, 11, 'footnote', 'fn.a', 1]]);
  // a segment model has the shape of a body model (the helpers work on it)
  for (const k of ['docId', 'revisionId', 'tabId', 'text', 'textDefault', 'tables']) assert.ok(k in fn, k);
  assert.strictEqual(T.segmentModel(m, ''), m);
  assert.strictEqual(T.segmentModel(m, 'fn.b').label, 'footnote 2');
  assert.strictEqual(T.segmentModel(m, 'gone'), null);
  assert.strictEqual(T.findSegment(m, 'first-page header'), null);
  // the same body without segments and TOC: the same lines and numbers
  const plain = modelOf(fakeDocsServer(partsSpec({ segments: false })));
  deq(plain.lines.map((l) => [l.line, l.text, l.off]), m.lines.map((l) => [l.line, l.text, l.off]));
  assert.strictEqual(plain.text, m.text);
  deq(plain.segments, []); assert.strictEqual(plain.toc, null);
});

test('line model: first-page and even-page headers, nested tables, merged cells, unreferenced footnotes', () => {
  const srv = fakeDocsServer({ documentId: 'DOC123', title: 'X', tabs: [{ id: 't.0', title: 'Main',
    items: [{ p: 'Top' }, { table: [[[{ p: 'Outer' }], [{ p: 'Wide' }]], [[{ p: 'L' }], [{ p: 'R' }]]], spans: [[0, 1, 1, 2]] }, { p: 'End' }],
    headers: { 'kix.e': [{ p: 'Even' }], 'kix.d': [{ p: 'Default' }], 'kix.x': [{ p: 'Section' }] }, footnotes: { 'fn.lost': [{ p: ' Lost' }] },
    documentStyle: { defaultHeaderId: 'kix.d', evenPageHeaderId: 'kix.e' } }] });
  const doc = srv.render(true);
  // a nested table, written into the rendered response (the fake has no nested tables)
  const cell = doc.tabs[0].documentTab.body.content[2].table.tableRows[1].tableCells[1];
  cell.content.push({ startIndex: 90, endIndex: 99, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 93, endIndex: 96, paragraph: { elements: [{ startIndex: 93, endIndex: 96, textRun: { content: 'In\n' } }] } }] }] }] } },
    { startIndex: 99, endIndex: 100, paragraph: { elements: [{ startIndex: 99, endIndex: 100, textRun: { content: '\n' } }] } });
  doc.tabs[0].documentTab.footnotes = { 'fn.lost': { footnoteId: 'fn.lost', content: [{ startIndex: 0, endIndex: 6, paragraph: { elements: [{ startIndex: 0, endIndex: 6, textRun: { content: ' Lost\n' } }] } }] } };
  const m = T.buildLineModel(doc, 't.0', 'DOC123');
  deq(m.lines.map((l) => [l.text, l.cell ? `${l.cell.t}:${l.cell.r}${l.cell.c}` : '']), [['Top', ''], ['Outer', '1:00'], ['Wide', '1:01'], ['L', '1:10'], ['R', '1:11'], ['In', '2:00'], ['', '1:11'], ['End', '']]);
  deq(m.tables.map((t) => [t.n, t.rows, t.cols, t.firstLine, t.lastLine, t.nested, t.merged]),
    [[1, 2, 2, 2, 7, false, [{ r: 0, c: 1, rowSpan: 1, colSpan: 2 }]], [2, 1, 1, 6, 6, true, []]]);
  deq(m.segments.map((s) => s.label), ['header', 'even-page header', 'header kix.x', 'footnote 1']);
  assert.strictEqual(m.segments[3].refLine, null);
});

test('fake Docs: insertTable splits the paragraph (table at index + 1, an empty paragraph after it) and renders cells, widths and spans', async () => {
  const srv = fakeDocsServer({ documentId: 'DOC123', title: 'T', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'One' }, { p: 'Two' }] }] });
  const one = modelOf(srv).lines[0];
  let r = await post(srv, [{ insertTable: { rows: 2, columns: 2, location: loc(one.end) } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const m = modelOf(srv);
  deq(m.lines.map((l) => l.text), ['One', '', '', '', '', '', 'Two']);
  const t = m.tables[0];
  deq([t.start, t.end, t.rows, t.cols, t.firstLine, t.lastLine], [one.end + 1, one.end + 12, 2, 2, 2, 5]);
  assert.strictEqual(m.lines[1].start, t.start + 3); // cell (0,0)'s paragraph, as in the API how-to
  assert.strictEqual(m.lines[5].cell, undefined); // the empty paragraph Docs leaves after the table
  deq(t.widths, [{ type: 'EVENLY_DISTRIBUTED', pt: null }, { type: 'EVENLY_DISTRIBUTED', pt: null }]);
  // its cells take text like any paragraph; the fake keeps the structure
  r = await post(srv, [{ insertText: { location: loc(m.lines[4].start), text: 'D' } }, { insertText: { location: loc(m.lines[1].start), text: 'A' } }]);
  deq(modelOf(srv).lines.slice(1, 5).map((l) => l.text), ['A', '', '', 'D']);
  deq(srv.tables('t.0'), [{ rows: [['A', ''], ['', 'D']], widths: null, spans: [] }]);
  // line 0 style: at a paragraph's start the table goes before it, after an empty paragraph
  r = await post(srv, [{ insertTable: { rows: 1, columns: 1, location: loc(1) } }]);
  deq(modelOf(srv).lines.map((l) => l.text).slice(0, 4), ['', '', 'One', 'A']);
  // refused like the API: inside a cell (the fake models no nested tables), past the end, bad sizes
  r = await post(srv, [{ insertTable: { rows: 1, columns: 1, location: loc(modelOf(srv).lines[1].start) } }]);
  assert.strictEqual(r.status, 400);
  r = await post(srv, [{ insertTable: { rows: 0, columns: 1, location: loc(1) } }]);
  assert.strictEqual(r.status, 400);
  // endOfSegmentLocation: before the body's last newline
  r = await post(srv, [{ insertTable: { rows: 1, columns: 2, endOfSegmentLocation: { tabId: 't.0' } } }]);
  const end = modelOf(srv);
  deq(end.lines.slice(-4).map((l) => [l.text, !!l.cell]), [['Two', false], ['', true], ['', true], ['', false]]);
});

test('fake Docs: headers, footers and footnotes take segmentId edits; createHeader / createFooter / createFootnote / delete*', async () => {
  const srv = fakeDocsServer(partsSpec());
  const shifts = [];
  srv.onShift.push((tabId, seg, index, delta) => shifts.push([tabId, seg, index, delta]));
  let r = await post(srv, [{ insertText: { location: loc(5, { segmentId: 'kix.h1' }), text: 'ed' } }, { deleteContentRange: { range: { startIndex: 0, endIndex: 5, tabId: 't.0', segmentId: 'kix.h1' } } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(srv.segText('kix.h1'), 'ed header');
  deq(shifts, [['t.0', 'kix.h1', 5, 2], ['t.0', 'kix.h1', 0, -5]]);
  r = await post(srv, [{ updateTextStyle: { range: { startIndex: 0, endIndex: 2, tabId: 't.0', segmentId: 'fn.a' }, textStyle: { bold: true }, fields: 'bold' } },
    { updateParagraphStyle: { range: { startIndex: 0, endIndex: 1, tabId: 't.0', segmentId: 'kix.f1' }, paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } }]);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let m = modelOf(srv);
  deq(T.findSegment(m, 'footnote 1').lines[0].runs.map((x) => [x.s, x.e, x.bold]), [[0, 2, true]]);
  deq(T.findSegment(m, 'footer').lines[0].para, { align: 'center' });
  deq(srv.fmt('t.0')[1], []); // a footnote mark is no text style
  // the final newline of a segment stays; an unknown segment is a 400
  r = await post(srv, [{ deleteContentRange: { range: { startIndex: 0, endIndex: 10, tabId: 't.0', segmentId: 'kix.h1' } } }]);
  assert.strictEqual(r.status, 400);
  r = await post(srv, [{ insertText: { location: loc(0, { segmentId: 'nope' }), text: 'x' } }]);
  assert.ok(r.status === 400 && /segment/i.test(r.error.message));
  // a second default header is refused; a footer can be created and deleted
  r = await post(srv, [{ createHeader: { type: 'DEFAULT' } }]);
  assert.strictEqual(r.status, 400);
  r = await post(srv, [{ deleteFooter: { footerId: 'kix.f1' } }, { createFooter: { type: 'DEFAULT' } }]);
  const footerId = r.replies[1].createFooter.footerId;
  deq(r.replies[0], {});
  r = await post(srv, [{ insertText: { location: loc(0, { segmentId: footerId }), text: 'New footer' } }]);
  m = modelOf(srv);
  deq(m.segments.filter((s) => s.type === 'footer').map((s) => [s.segmentId, s.text, s.kind]), [[footerId, 'New footer', 'default']]);
  // a new footnote: a mark in the body (one index), its content " \n"; deleting the mark drops it
  const body = m.lines[0];
  r = await post(srv, [{ createFootnote: { location: loc(body.end) } }]);
  const fid = r.replies[0].createFootnote.footnoteId;
  m = modelOf(srv);
  assert.strictEqual(m.lines[0].text, 'Title' + OC);
  deq(m.segments.filter((s) => s.type === 'footnote').map((s) => [s.n, s.segmentId, s.text, s.refLine]), [[1, fid, ' ', 1], [2, 'fn.a', ' First note', 2], [3, 'fn.b', ' Second', 9]]);
  r = await post(srv, [{ insertText: { location: loc(1, { segmentId: fid }), text: 'Source.' } }]);
  assert.strictEqual(srv.segText(fid), ' Source.');
  r = await post(srv, [{ createFootnote: { location: loc(0, { segmentId: 'kix.h1' }) } }]);
  assert.strictEqual(r.status, 400); // not in a header
  r = await post(srv, [{ deleteContentRange: { range: { startIndex: body.end, endIndex: body.end + 1, tabId: 't.0' } } }]);
  m = modelOf(srv);
  deq(m.segments.filter((s) => s.type === 'footnote').map((s) => s.segmentId), ['fn.a', 'fn.b']);
  assert.ok(srv.segments('t.0').footnotes.includes(fid)); // stored, but no longer rendered
  // a failed batch changes nothing (segments included)
  const before = JSON.stringify(srv.render(true));
  r = await post(srv, [{ insertText: { location: loc(0, { segmentId: 'kix.h1' }), text: 'zz' } }, { deleteHeader: { headerId: 'nope' } }]);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.stringify(srv.render(true)), before);
});

test('fake Docs plugins: registerFakeRequest / Render / Get / Init', async () => {
  registerFakeInit((srv, spec) => { srv.notes = spec.notes || []; srv.backupKeys.push('notes'); });
  registerFakeRequest('addNote', (body, api) => {
    if (!body.text) api.fail('empty note');
    api.srv.notes.push(body.text);
    return { addNote: { count: api.srv.notes.length } };
  });
  registerFakeRender((srv, out) => { out.notes = srv.notes.slice(); });
  registerFakeGet((srv, url, params, api) => (params.get('notesOnly') === 'true' ? api.json(200, { notes: srv.notes }) : null));
  const srv = fakeDocsServer({ documentId: 'DOC123', title: 'P', notes: ['a'], tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'x' }] }] });
  let r = await post(srv, [{ addNote: { text: 'b' } }]);
  deq(r.replies, [{ addNote: { count: 2 } }]);
  r = await post(srv, [{ addNote: { text: 'c' } }, { addNote: { text: '' } }]);
  assert.strictEqual(r.status, 400);
  deq(srv.notes, ['a', 'b']); // restored with the plugin's backup key
  deq(srv.render(true).notes, ['a', 'b']);
  const g = await srv.fetch('https://docs.googleapis.com/v1/documents/DOC123?notesOnly=true', { headers: { Authorization: 'Bearer tok-1' } });
  deq(await g.json(), { notes: ['a', 'b'] });
});

test('request builders: a segment model adds its segmentId (and the tabId); the body model does not', () => {
  const m = modelOf(fakeDocsServer(partsSpec()));
  const h = T.findSegment(m, 'header');
  deq(T.reqInsert(h, 0, 'x'), { insertText: { location: { index: 0, tabId: 't.0', segmentId: 'kix.h1' }, text: 'x' } });
  deq(T.reqDelete(h, 0, 2), { deleteContentRange: { range: { startIndex: 0, endIndex: 2, tabId: 't.0', segmentId: 'kix.h1' } } });
  deq(T.reqStyle(h, 0, 1, 'HEADING_1').updateParagraphStyle.range, { startIndex: 0, endIndex: 1, tabId: 't.0', segmentId: 'kix.h1' });
  deq(T.reqTextStyle(h, 0, 1, { bold: true }, ['bold']).updateTextStyle.range.segmentId, 'kix.h1');
  deq(T.reqParaStyle(h, 0, 1, { alignment: 'CENTER' }, ['alignment']).updateParagraphStyle.range.segmentId, 'kix.h1');
  deq(T.reqBulletsOn(h, 0, 1, 'BULLET_DISC_CIRCLE_SQUARE').createParagraphBullets.range.segmentId, 'kix.h1');
  deq(T.reqLocation(h, 3), { index: 3, tabId: 't.0', segmentId: 'kix.h1' });
  deq(T.reqRange(h, 1, 3), { startIndex: 1, endIndex: 3, tabId: 't.0', segmentId: 'kix.h1' });
  deq(T.reqEndOfSegment(h), { tabId: 't.0', segmentId: 'kix.h1' });
  deq(T.reqInsert(m, 1, 'x'), { insertText: { location: { index: 1, tabId: 't.0' }, text: 'x' } });
  deq(T.reqEndOfSegment(m), { tabId: 't.0' });
  // replacePlan on a segment model: segment requests and a segment journal
  const plan = T.replacePlan(h, 0, 'Draft header', 'Final header');
  deq(plan.requests, [T.reqDelete(h, 0, 5), T.reqInsert(h, 0, 'Final')]);
  deq([plan.journal.kind, plan.journal.segmentId, plan.journal.text, plan.journal.restore], ['replace', 'kix.h1', 'Final', 'Draft']);
  assert.strictEqual(T.replacePlan(m, m.lines[0].off, 'Title', 'Head').journal.segmentId, undefined);
});

// A plan whose lines are in a segment: the module's own report and affected lines.
const segPlan = (fields) => ({ region: [1, 1], affected: () => [1, 1], keepsLines: true, report: () => 'Header now reads the new text.', ...fields });
const toolMsg = (id, r) => ({ role: 'tool', tool_call_id: id, ...r });

test('a replace in a header: commitEdit, the anchor in the segment, undo_last_edit restores it', async () => {
  await fresh(partsSpec());
  const h = T.findSegment(as.model, 'header');
  const plan = segPlan({ ...T.replacePlan(h, 0, 'Draft header', 'Final header'), title: 'Header replaced' });
  const r = pushTool(toolMsg('h1', await T.commitEdit(as, plan, 'h1')));
  assert.ok(r._ok, r.content);
  assert.strictEqual(fake.segText('kix.h1'), 'Final header');
  deq([r._edit.segmentId, r._edit.anchor.before, r._edit.anchor.after], ['kix.h1', '', ' header']);
  const u = pushTool(await exec('undo_last_edit', {}, 'h1u'));
  assert.ok(u._ok, u.content);
  assert.strictEqual(fake.segText('kix.h1'), 'Draft header');
  assert.ok(/In the header:\nLines 1-1 now:\n1: Draft header/.test(u.content), u.content);
  // the header is gone: undo refuses with a readable reason
  await fresh(partsSpec());
  const h2 = T.findSegment(as.model, 'header');
  pushTool(toolMsg('h2', await T.commitEdit(as, segPlan({ ...T.replacePlan(h2, 0, 'Draft', 'Old'), title: 'Header' }), 'h2')));
  await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests: [{ deleteHeader: { headerId: 'kix.h1' } }] }) });
  const u2 = await exec('undo_last_edit', {}, 'h2u');
  assert.ok(!u2._ok && /header, footer or footnote of that edit no longer exists/.test(u2.content), u2.content);
});

// The two batches of "create a header and write into it", with the rollback of the first.
const headerSteps = (text) => [
  () => ({ requests: [{ createHeader: { type: 'DEFAULT' } }], rollback: (m, replies) => [{ deleteHeader: { headerId: replies[0][0].createHeader.headerId } }] }),
  (m, replies) => ({ requests: [T.reqInsert(T.segmentModel(m, replies[0][0].createHeader.headerId), typeof text === 'number' ? text : 0, typeof text === 'number' ? 'x' : text)] }),
];
const noHeaderSpec = () => ({ documentId: 'DOC123', title: 'H', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body text' }] }] });

test('commitSequence + multi journal: two batches, journaled as parts, undone newest first; a failing batch rolls back', async () => {
  await fresh(noHeaderSpec());
  const seq = await T.commitSequence(as, segPlan({ journal: {} }), 'm1', headerSteps('New head'));
  assert.ok(!seq.fail, seq.fail && seq.fail.content);
  const hid = seq.replies[0][0].createHeader.headerId;
  assert.strictEqual(as.model, seq.model);
  assert.strictEqual(T.findSegment(seq.model, 'header').text, 'New head');
  const journal = T.multiJournal([
    { kind: 'requests', requests: [{ deleteHeader: { headerId: hid } }], anchor: false },
    { kind: 'insert', index: 0, text: 'New head', restore: '', paras: [], segmentId: hid },
  ]);
  const r = pushTool(toolMsg('m1', await T.finishEdit(as, segPlan({ journal, title: 'Header added' }), 'm1', seq.model)));
  assert.ok(r._ok && r.content.startsWith('Done: header added.\nHeader now reads the new text.'), r.content);
  deq([r._edit.kind, r._edit.parts[0].anchor, r._edit.parts[1].anchor], ['multi', false, { before: '', after: '', revision: seq.model.revisionId }]);
  const u = pushTool(await exec('undo_last_edit', {}, 'm1u'));
  assert.ok(u._ok && /undid "Header added"/.test(u.content), u.content);
  deq(fake.segments('t.0').headers, []);
  assert.ok(r._edit.undone && r._edit.parts.every((p) => p.undone));
  // the second batch fails: the header is deleted again and the result says so
  await fresh(noHeaderSpec());
  const bad = await T.commitSequence(as, segPlan({ journal: {} }), 'm2', headerSteps(99));
  assert.ok(bad.fail && !bad.fail._ok && /rolled back/.test(bad.fail.content), bad.fail && bad.fail.content);
  deq(fake.segments('t.0').headers, []);
  // the first batch fails: reported like commitEdit (nothing changed)
  await fresh(partsSpec());
  const first = await T.commitSequence(as, segPlan({ journal: {} }), 'm3', headerSteps('x'));
  assert.ok(first.fail && /rejected the edit/.test(first.fail.content), first.fail && first.fail.content);
});

test('multi undo: a part that fails after another was undone; the next undo continues with the parts left', async () => {
  await fresh(partsSpec());
  const h = T.findSegment(as.model, 'header');
  const p = T.replacePlan(h, 0, 'Draft header', 'Final header');
  await T.docsBatchUpdate(as.model, p.requests);
  const model = await T.refreshSnapModel(as);
  const journal = T.multiJournal([{ kind: 'requests', requests: [{ deleteHeader: { headerId: 'kix.nope' } }], anchor: false }, p.journal]);
  pushTool(toolMsg('p1', await T.finishEdit(as, segPlan({ journal, title: 'Two parts' }), 'p1', model)));
  let u = await exec('undo_last_edit', {}, 'p1u');
  assert.ok(!u._ok && /only part of that edit was undone/.test(u.content), u.content);
  assert.strictEqual(fake.segText('kix.h1'), 'Draft header'); // the newer part was undone
  const m = state.messages.find((x) => x.tool_call_id === 'p1');
  deq([m._edit.undone, m._edit.parts.map((x) => !!x.undone)], [false, [false, true]]);
  u = await exec('undo_last_edit', {}, 'p1u2'); // only the part left is tried again
  assert.ok(!u._ok && /only part/.test(u.content) && /kix.nope/.test(u.content), u.content);
  assert.strictEqual(fake.segText('kix.h1'), 'Draft header');
});

test('journal: an entry with undoable: false is skipped; relocateEdit moves every index of the inverse requests', async () => {
  await fresh(partsSpec());
  pushTool(await exec('replace_text', { old_text: 'Second note', new_text: 'Next note' }, 'r1'));
  pushTool({ role: 'tool', tool_call_id: 'x1', content: 'Done.', _ok: true, _edit: { id: 'x1', kind: 'comment', undoable: false, title: 'Comment deleted' } });
  assert.strictEqual(T.latestUndoable().tool_call_id, 'r1');
  deq(T.answerEdits('r1').map((x) => x.tool_call_id), ['r1']);
  const u = await exec('undo_last_edit', {}, 'r1u');
  assert.ok(u._ok && fake.text('t.0').includes('Second note'), u.content);
  // relocation shifts nested indices (a table start) along with ranges and locations
  const m = as.model;
  const line = m.lines[7]; // Methods
  const edit = { index: line.start, end: line.end, text: line.text, anchor: T.makeAnchor(m, line.start, line.text),
    requests: [{ insertTableRow: { tableCellLocation: { tableStartLocation: { index: m.tables[0].start }, rowIndex: 1, columnIndex: 0 }, insertBelow: true } },
      { updateTextStyle: { range: { startIndex: line.start, endIndex: line.end }, textStyle: {}, fields: 'bold' } }] };
  fake.typeParagraph(0, 'New');
  const moved = T.relocateEdit(T.buildLineModel(fake.render(true), 't.0', 'DOC123'), edit);
  assert.ok(moved);
  deq([moved.index, moved.end, moved.requests[0].insertTableRow.tableCellLocation.tableStartLocation.index, moved.requests[0].insertTableRow.tableCellLocation.rowIndex,
    moved.requests[1].updateTextStyle.range.startIndex], [line.start + 4, line.end + 4, m.tables[0].start + 4, 1, line.start + 4]);
});

// ---- Registries (each test group in its own sandbox: registrations are global to a panel) ------------------
const READ_DEF = { type: 'function', function: { name: 'list_parts', description: 'List parts.', parameters: { type: 'object', properties: { part: { type: 'string' } }, required: ['part'], additionalProperties: false } } };
const MIXED_DEF = { type: 'function', function: { name: 'parts', description: 'Read or set parts.', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false } } };

async function registryBench() {
  const e = await load();
  const Tx = e.T;
  const calls = [];
  // The tools the feature modules registered at load time (page_parts, …): left out of the order checks below.
  const own = Tx.EXTRA_TOOLS.flatMap((t) => t.names);
  Tx.registerTools([READ_DEF], {
    offer: (mode, snap) => snap.docFormat === 'docs-api',
    reading: true, icon: '🧩', summary: (name, args) => `part ${args.part}`,
    run: (name, args) => { calls.push([name, args]); return args.part === 'bad' ? 'Error: no such part' : `Parts: ${args.part}`; },
    prompt: [{ section: 'reading', line: '- list_parts(part): the parts.' }],
    docNote: () => '[Also: a header]',
  });
  Tx.registerTools(MIXED_DEF, {
    offer: (mode, snap) => mode === 'edit' && snap.docFormat === 'docs-api',
    reading: (name, args) => args.action === 'read', icon: { parts: '📝' }, pending: 'Changing parts…',
    gate: (name, plan) => ({ large: plan.big, what: 'changes parts', range: '', excerptLabel: 'Part', excerpt: 'x' }),
    run: async (name, args, snap, ui, call) => {
      calls.push([name, args, call]);
      if (args.action === 'boom') throw new Error('it broke');
      return args.action === 'read' ? { content: 'Header: «x»', _ok: true } : { content: 'Done: set.', _ok: true, _message: 'Parts set' };
    },
    prompt: [{ section: 'edit', line: '- parts(action): change parts.' }],
  });
  return { e, T: Tx, calls, own };
}
const apiSnap = (Tx, model) => ({ ...Tx.takeSnapshot(), docText: model.text, docFormat: 'docs-api', model, lines: null, selection: '', docId: 'DOC123', googleConnected: true });
const call = (name, args, id = 'c' + Math.random().toString(36).slice(2, 6)) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('registerTools: offered after the built-in tools, dispatched, logged, gated, prompted; refusals like the built-in tools', async () => {
  const { T: Tx, calls, own } = await registryBench();
  const model = modelOf(fakeDocsServer(partsSpec()), Tx);
  const snap = apiSnap(Tx, model);
  const names = (mode, s) => Tx.toolsFor(mode, s).map((t) => t.function.name).filter((n) => !own.includes(n));
  assert.ok(own.includes('table') && own.includes('page_parts')); // docs-tables.js, docs-segments.js
  deq(names('edit', snap).slice(-3), ['replace_selection', 'list_parts', 'parts']);
  deq(names('manual', snap).slice(-2), ['remember', 'list_parts']);
  deq(names('edit', { ...snap, docFormat: 'markdown', model: null }).slice(-1), ['replace_selection']);
  // the static prompt lists them in their sections; the turn context carries the docNote
  const head = Tx.buildSystemParts('edit', 1e5, snap).head;
  assert.ok(/characters per call; read a longer part in several calls\.\n(- .*\n)*- list_parts\(part\): the parts\.\n/.test(head), 'reading line');
  assert.ok(/with the writing tools\.\n(- .*\n)*- parts\(action\): change parts\.\n\nFollow these rules/.test(head), 'edit line');
  assert.ok(!Tx.buildSystemParts('manual', 1e5, snap).head.includes('- parts(action)'));
  assert.ok(Tx.buildTurnContext('edit', snap, null).match(/<\/document>\n(.*\n)*\[Also: a header\]/));
  // reading call: quiet, summary as _message
  let r = await Tx.executeTool(call('list_parts', { part: 'header' }, 'l1'), 'edit', snap);
  deq([r.content, r._ok, r._reading, r._message, r.tool_call_id], ['Parts: header', true, true, 'part header', 'l1']);
  r = await Tx.executeTool(call('list_parts', { part: 'bad' }), 'manual', snap);
  deq([r._ok, r._reading], [false, true]);
  assert.ok(Tx.isReadingTool(call('list_parts', {})) && Tx.isReadingTool(call('parts', { action: 'read' })) && !Tx.isReadingTool(call('parts', { action: 'set' })));
  // writing call: the call id and mode reach run; refused in Manual, on an opened document, when not offered
  r = await Tx.executeTool(call('parts', { action: 'set' }, 'p1'), 'edit', snap);
  deq([r.content, r._ok, r._reading], ['Done: set.', true, undefined]);
  deq(calls[calls.length - 1][2], { id: 'p1', mode: 'edit' });
  r = await Tx.executeTool(call('parts', { action: 'read' }), 'edit', snap);
  deq([r._reading, r._message], [true, '']);
  r = await Tx.executeTool(call('parts', { action: 'boom' }), 'edit', snap);
  assert.ok(!r._ok && r.content === 'Error: it broke');
  r = await Tx.executeTool(call('parts', { action: 'set', doc: 'doc2' }), 'edit', snap);
  assert.ok(!r._ok && /read-only/.test(r.content));
  const n = calls.length;
  r = await Tx.executeTool(call('parts', { action: 'set' }), 'manual', snap);
  assert.ok(!r._ok && /not available for this message/.test(r.content));
  r = await Tx.executeTool(call('list_parts', { part: 'x' }), 'edit', { ...snap, docFormat: 'markdown', model: null });
  assert.ok(!r._ok && /not available/.test(r.content));
  assert.strictEqual(calls.length, n);
  // action log, icons, cards, gate
  assert.strictEqual(Tx.logEntry(call('list_parts', { part: 'footer' }), null).summary, 'part footer');
  assert.strictEqual(Tx.logEntry(call('parts', { action: 'set' }), null).summary, '{"action":"set"}'); // no summary: activitySummary
  deq([Tx.activityIcon('list_parts'), Tx.activityIcon('parts'), Tx.activityIcon('read_lines')], ['🧩', '📝', '📖']);
  deq([Tx.isEditTool('parts'), Tx.isEditTool('list_parts'), Tx.pendingCardText('parts')], [true, false, 'Changing parts…']);
  deq(Tx.editGateInfo('parts', { big: true }).large, true);
  deq(Tx.editGateInfo('list_parts', {}), { large: false, what: 'runs list_parts', range: '', excerptLabel: '', excerpt: '' });
  // a long result of a registered reading tool is stubbed after the turn like read_lines
  const msgs = [{ role: 'assistant', content: null, tool_calls: [call('list_parts', { part: 'all' }, 's1')] }, { role: 'tool', tool_call_id: 's1', content: 'x'.repeat(500) }];
  Tx.slimHistory(msgs);
  assert.strictEqual(msgs[1].content, '[list_parts: content omitted after the turn; re-read if needed]');
  // names are unique
  assert.throws(() => Tx.registerTools([READ_DEF], { offer: () => true, run: () => '' }), /exists already/);
  assert.throws(() => Tx.registerTools([{ type: 'function', function: { name: 'read_lines' } }], { offer: () => true, run: () => '' }), /exists already/);
  assert.throws(() => Tx.registerTools([{ type: 'function', function: { name: 'x_tool' } }], { run: () => '' }), /offer and run/);
});

test('registerSelfTestRows, registerUndoHandler, registerTurnHook, registerPromptLine', async () => {
  const { T: Tx } = await load();
  const before = Tx.selfTestChecks('api').map((c) => c.name);
  Tx.registerSelfTestRows([{ name: 'Write: tables', run: async () => ({ status: 'pass', detail: '' }) }, { name: 'Write: footnotes', run: async () => ({ status: 'pass', detail: '' }) }]);
  Tx.registerSelfTestRows([{ name: 'References', after: 'No such row', modes: ['api', 'export'], run: async () => ({ status: 'skip', detail: '' }) }]);
  Tx.registerSelfTestRows([{ name: 'History', after: 'Write: insert_after_line', modes: ['export'], run: async () => ({ status: 'pass', detail: '' }) }]);
  const api = Tx.selfTestChecks('api').map((c) => c.name);
  // after "Write: lists" and the rows the feature modules registered at load time, in registration order
  const at = api.indexOf('Write: tables');
  deq(api.slice(api.indexOf('Write: lists'), at), before.slice(before.indexOf('Write: lists'), before.indexOf('Write: delete_lines')));
  deq(api.slice(at, at + 3), ['Write: tables', 'Write: footnotes', 'Write: delete_lines']);
  deq(api.slice(api.indexOf('Write: lists'), api.indexOf('Write: lists') + 3), ['Write: lists', 'Write: table', 'Write: page parts']); // docs-tables.js, docs-segments.js
  deq(api.filter((x) => !['Write: tables', 'Write: footnotes', 'References'].includes(x)), before);
  assert.strictEqual(api[api.length - 1], 'References');
  const exp = Tx.selfTestChecks('export').map((c) => c.name);
  deq(exp.slice(exp.indexOf('Write: insert_after_line'), exp.indexOf('Write: insert_after_line') + 2), ['Write: insert_after_line', 'History']);
  assert.ok(!exp.includes('Write: tables') && exp[exp.length - 1] === 'References');
  assert.throws(() => Tx.registerSelfTestRows([{ name: 'x' }]), /name and run/);
  // undo kinds
  const seen = [];
  Tx.registerUndoHandler('demo', async (edit) => { seen.push(edit.id); return { model: { lines: [] }, restored: '', note: 'Note: lossy.' }; });
  const res = await Tx.undoEdit({ id: 'e1', kind: 'demo' });
  deq([seen, res.note], [['e1'], 'Note: lossy.']);
  assert.throws(() => Tx.registerUndoHandler('demo', () => {}), /exists already/);
  assert.throws(() => Tx.registerUndoHandler('table', () => {}), /exists already/); // docs-tables.js
  assert.throws(() => Tx.registerUndoHandler('multi', () => {}), /exists already/);
  // turn hooks: best effort
  const got = [];
  Tx.registerTurnHook('finish', (userMsg, snap) => { got.push(['finish', userMsg.content, snap.docText]); throw new Error('ignored'); });
  Tx.registerTurnHook('finish', async () => { got.push(['async']); throw new Error('ignored too'); });
  Tx.registerTurnHook('panelDoc', (docId) => got.push(['panelDoc', docId]));
  Tx.finishTurn({ role: 'user', content: 'Hi' }, { docText: 'text', docFormat: 'text' }, { messages: [] });
  Tx.runTurnHooks('panelDoc', 'DOC9');
  deq(got, [['finish', 'Hi', 'text'], ['async'], ['panelDoc', 'DOC9']]);
  assert.throws(() => Tx.registerTurnHook('start', () => {}), /unknown event/);
  // prompt lines without a tool
  Tx.registerPromptLine({ section: 'reading', line: (mode) => `- extra (${mode})`, when: (mode) => mode === 'manual' });
  deq(Tx.extraPromptLines('reading', 'manual', {}), ['- extra (manual)']); // ask_user has no prompt line (its description says it all)
  deq(Tx.extraPromptLines('reading', 'edit', {}), []);
  assert.throws(() => Tx.registerPromptLine({ section: 'rules', line: 'x' }), /section/);
});

test('table notation (TABLE_LINE_DECORATOR): cell labels and the [table …] line in the reading output; unchanged without tables', async () => {
  const { T: Tx } = await load();
  const tables = modelOf(fakeDocsServer(partsSpec()), Tx);
  const plainSpec = { documentId: 'DOC123', title: 'P', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'One', style: 'HEADING_1' }, { p: 'Two words' }] }] };
  const plain = modelOf(fakeDocsServer(plainSpec), Tx);
  const outputs = (m) => {
    const snap = apiSnap(Tx, m);
    return [Tx.runReadingTool('read_lines', { start: 1, end: 9 }, snap), Tx.runReadingTool('read_formatting', { start: 1, end: 9 }, snap),
      Tx.runReadingTool('find_in_document', { query: 'o' }, snap), Tx.linesReport(m, 1, 9), Tx.changedLinesReport(m, [1, 2])];
  };
  // docs-tables.js registers the decorator at load; a document without tables reads as before
  assert.ok(outputs(plain)[0].includes('\n1: One\n2: Two words') && !/\[(table|r1)/.test(outputs(plain).join('\n')));
  const [lines, fmt, find, report] = outputs(tables);
  const head = Tx.buildSystemParts('edit', 1e5, apiSnap(Tx, plain)).head; // static: the same with or without tables
  assert.ok(lines.includes('\n2: Body with a note￼ here.\n[table T1: 2 rows × 2 columns, lines 3–7]\n3 [r1c1]: A\n4 [r1c2]: B\n5 [r1c2]: B2\n6 [r2c1]: C\n7 [r2c2]: D\n8: Methods'), lines);
  assert.ok(fmt.includes('\n[table T1: 2 rows × 2 columns, lines 3–7]\n3 [r1c1]: A\n'), fmt);
  assert.ok(find.includes('\n2: Body with a note') && !find.includes('[table'), find);
  assert.ok(report.includes('\n[table T1: 2 rows × 2 columns, lines 3–7]\n3 [r1c1]: A'), report);
  assert.ok(head.includes('(table cells are separate lines marked [rNcM] (row N, column M), under a [table Tn …] line, in reading order)'), 'prompt sentence');
  deq(Tx.changedLinesReport(tables, [4, 8]), 'Lines 4, 8 now:\n4 [r1c2]: B\n8: Methods');
  // a copied prefix still finds the text
  assert.strictEqual(Tx.stripMarkers('3 [r1c1]: A'), 'A');
  assert.strictEqual(Tx.stripMarkers('[table T1: 2 rows × 2 columns, lines 3–7]\n3 [r1c1]: A\n4 [r1c2]: B'), 'A\nB');
  deq([Tx.cellLabel(tables.lines[5]), Tx.cellLabel(tables.lines[0]), Tx.tableOfLine(tables, tables.lines[4]).n, Tx.tableOfLine(tables, tables.lines[0])], ['[r2c1]', '', 1, null]);
});

test('the registry module loads first and the feature modules have their (empty) slots in sidepanel.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
  const order = [...html.matchAll(/<script src="src\/([^"]+)"/g)].map((m) => m[1]);
  deq(order.slice(0, 2), ['constants.js', 'registry.js']);
  const at = order.indexOf('tools.js');
  deq(order.slice(at, at + 14), ['tools.js', 'docs-tables.js', 'docs-segments.js', 'docs-comments.js', 'zotero.js', 'references.js', 'doc-history.js', 'prose-lint.js', 'draft.js',
    'revise.js', 'hidden-text.js', 'own-changes.js', 'provenance.js', 'action-log.js']);
});

test('registerTools: an offer() that throws only leaves that feature out (tools, prompt lines), the turn goes on', async () => {
  const e2 = await load();
  const Tx = e2.T;
  const warned = [];
  e2.ctx.console = { ...console, warn: (...a) => warned.push(a.join(' ')) };
  Tx.registerTools([{ type: 'function', function: { name: 'broken_tool', description: 'x', parameters: { type: 'object', properties: {} } } }], {
    offer: () => { throw new Error('feature bug'); }, run: () => 'never',
    prompt: [{ section: 'reading', line: '- broken_tool(): never in the prompt' }],
  });
  e2.state.settings.provider = 'anthropic';
  const snap = Tx.takeSnapshot(); Tx.snapshotDocument(snap);
  const names = Tx.toolsFor('edit', snap).map((t) => t.function.name);
  assert.ok(names.includes('read_lines') && !names.includes('broken_tool'));
  assert.ok(!Tx.extraPromptLines('reading', 'edit', snap).some((l) => l.includes('broken_tool')));
  assert.strictEqual(Tx.offered(Tx.extraTool('broken_tool'), 'edit', snap), false);
  assert.ok(warned.some((w) => w.includes('broken_tool') && w.includes('feature bug')));
});
