'use strict';
// Sections (src/docs-segments.js page_parts, src/docs-model.js model.sectionBreaks): the line model keeps section breaks
// out of the lines with unchanged offsets, read_document shows a "— section break —" line, page_parts read part
// "sections" lists them; section_break (insertSectionBreak at the end of the line's text, the empty paragraph after it
// deleted when a body line follows; kept before a table and at the end), section_style (updateSectionStyle over the
// section's first index, a leaf mask), their exact undo, the verification by re-read, the gate and the refusals.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const dim = (n) => ({ magnitude: n, unit: 'PT' });
const TWO_COLS = { sectionType: 'CONTINUOUS', columnProperties: [{ paddingEnd: dim(36) }, { paddingEnd: dim(0) }], columnSeparatorStyle: 'BETWEEN_EACH_COLUMN' };
// Lines: 1 Title (1-6), 2 Intro text. (7-18), 3 Wide part [H1] (19-28), 4 Body of the wide part. (29-51), 5-6 the table
// cells A / B, 7 After table, 8 Last line. sections: a break before line 3 (an existing section) when given.
const spec = ({ sections = false, documentStyle = null } = {}) => ({ documentId: 'DOC123', title: 'Sections', tabs: [{ id: 't.0', title: 'Main',
  items: [
    { p: 'Title', style: 'TITLE' },
    { p: 'Intro text.' },
    ...(sections ? [{ section: TWO_COLS }] : []),
    { p: 'Wide part', style: 'HEADING_1' },
    { p: 'Body of the wide part.' },
    { table: [[[{ p: 'A' }], [{ p: 'B' }]]] },
    { p: 'After table' },
    { p: 'Last line' },
  ],
  ...(documentStyle ? { documentStyle } : {}),
}] });
const TEXTS = ['Title', 'Intro text.', 'Wide part', 'Body of the wide part.', 'A', 'B', 'After table', 'Last line'];
const STYLES = ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT'];
const A = (over) => ({ action: 'read', part: null, number: null, text: null, after_text: null, line: null, type: null, ...over });
const loc = (index) => ({ index, tabId: 't.0' });
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const lines = () => state.docModel.lines.map((l) => l.text);
const breaks = () => fake.sections('t.0').map((s) => [s.index, s.style.sectionType || null]);

test('reading: a section break is no line, offsets stay the API\'s; read_document shows it; read part "sections"; the turn context', async () => {
  await fresh(spec());
  const starts0 = state.docModel.lines.map((l) => [l.start, l.end]);
  deq(state.docModel.sectionBreaks, [{ n: 1, index: 0, firstLine: 1, style: {} }]);
  await fresh(spec({ sections: true }));
  const m = state.docModel;
  deq(m.lines.map((l) => l.text), TEXTS);
  // the break takes one index: lines after it start one later, and line 2's newline cannot be deleted (closing)
  deq(m.lines.map((l) => [l.start, l.end]), starts0.map(([s, e], i) => (i < 2 ? [s, e] : [s + 1, e + 1])));
  deq(m.sectionBreaks.map((b) => [b.n, b.index, b.firstLine, b.style.sectionType || null]), [[1, 0, 1, null], [2, 19, 3, 'CONTINUOUS']]);
  assert.ok(m.lines[1].closing && T.isClosing(m, 1));
  // read_document: an unnumbered line before the section's first line; stripMarkers removes it from a copied old_text
  const r = await exec('read_document', { scope: { start: 2, end: 3 }, include: ['text'], doc: null });
  assert.ok(r.content.includes('2: Intro text.\n— section break (continuous) —\n3: Wide part'), r.content);
  assert.strictEqual(T.stripMarkers('2: Intro text.\n— section break (continuous) —\n3: Wide part'), 'Intro text.\nWide part');
  // the listing: lines and effective style of each section
  const s = await exec('page_parts', A({ part: 'sections' }));
  deq([s._ok, s._reading], [true, true]);
  assert.strictEqual(s.content, 'Sections (2):\n1: lines 1–2; 1 column, portrait margins 2.54 cm first page number 1\n' +
    '2 (continuous): lines 3–8; 2 columns spacing 1.27 cm separator, portrait margins 2.54 cm');
  // read with part null lists them too when there is more than one section
  assert.ok((await exec('page_parts', A())).content.endsWith(s.content));
  assert.ok(T.buildTurnContext('edit', as).includes('Page parts: 2 sections (new ones at line 3).'));
  // the inherited documentStyle values: a landscape A4 page (flipped), margins and the first page number
  await fresh(spec({ sections: true, documentStyle: { pageSize: { width: dim(595.28), height: dim(841.89) }, flipPageOrientation: true, marginLeft: dim(36), pageNumberStart: 4 } }));
  assert.strictEqual((await exec('page_parts', A({ part: 'section' }))).content, 'Sections (2):\n1: lines 1–2; 1 column, landscape margins 2.54/2.54/2.54/1.27 cm first page number 4\n' +
    '2 (continuous): lines 3–8; 2 columns spacing 1.27 cm separator, landscape margins 2.54/2.54/2.54/1.27 cm');
});

test('section_break: insertSectionBreak at the end of the line\'s text, the empty paragraph after it deleted; lines and styles unchanged; exact undo', async () => {
  await fresh(spec());
  const r = pushTool(await exec('page_parts', A({ action: 'section_break', line: 2, type: 'continuous' }), 'b1'));
  assert.strictEqual(r.content, 'Done: inserted a section break (continuous) after line 2; the document has 8 lines.\nSection 2 starts at line 3.');
  // line 2 is 7-18: the newline goes in at 18, the break at 19, line 2's own newline (now 20) ends an empty paragraph
  deq(lastPost().requests, [{ insertSectionBreak: { location: loc(18), sectionType: 'CONTINUOUS' } }, { deleteContentRange: { range: range(20, 21) } }]);
  deq([r._message, r._cardText, r._cardLabel, r._edit.kind, r._edit.index, r._edit.cleaned], ['Section break after line 2', 'Section break (continuous) after line 2', 'Section break', 'section-break', 19, true]);
  deq(breaks(), [[0, null], [19, 'CONTINUOUS']]);
  deq([fake.text().split('\n'), fake.styles()], [TEXTS, STYLES]);
  assert.strictEqual(as.responseWrite, null); // no line moved
  deq(state.docModel.sectionBreaks.map((b) => b.firstLine), [1, 3]);
  // undo: the paragraph split again, then the old newline and the break deleted
  const u = pushTool(await exec('undo_last_edit', {}, 'b1u'));
  assert.ok(u._ok, u.content);
  deq(lastPost().requests, [{ insertText: { location: loc(18), text: '\n' } }, { deleteContentRange: { range: range(19, 21) } }]);
  deq([breaks(), fake.text().split('\n'), fake.styles()], [[[0, null]], TEXTS, STYLES]);
  assert.ok(u.content.startsWith('Done: undid "Section break after line 2"'), u.content);
});

test('section_break after the last line and before a table: the empty line stays (the new section\'s first line); undo deletes the break with its newline', async () => {
  await fresh(spec());
  let r = pushTool(await exec('page_parts', A({ action: 'section_break', line: 8 }), 'e1'));
  assert.strictEqual(r.content, 'Done: inserted a section break (next page) after line 8; now lines 8–9; the document has 9 lines.\n' +
    'Section 2 starts at line 9, an empty line Google Docs keeps after the break (write the section\'s text there).');
  const end = state.docModel.lines[7];
  deq(lastPost().requests, [{ insertSectionBreak: { location: loc(end.end), sectionType: 'NEXT_PAGE' } }]);
  deq([lines(), r._edit.cleaned, breaks().length], [[...TEXTS, ''], false, 2]);
  let u = pushTool(await exec('undo_last_edit', {}, 'e1u'));
  assert.ok(u._ok, u.content);
  deq(lastPost().requests, [{ deleteContentRange: { range: range(end.end, end.end + 2) } }]);
  deq([fake.text().split('\n'), breaks().length], [TEXTS, 1]);
  // line 4 is followed by a table: the newline before a table cannot be deleted, so the empty line stays
  r = pushTool(await exec('page_parts', A({ action: 'section_break', line: 4 }), 'e2'));
  assert.ok(r._ok, r.content);
  deq(lastPost().requests.length, 1);
  deq(lines(), [...TEXTS.slice(0, 4), '', ...TEXTS.slice(4)]);
  // text typed into that empty line blocks the undo (it would be joined to line 4)
  fake.tabs[0].blocks[2].paras[0].text = 'typed'; fake.tabs[0].blocks[2].paras[0].chars = Array(5).fill(undefined); fake.revision++;
  u = await exec('undo_last_edit', {}, 'e2u');
  assert.ok(!u._ok && /text was written into the empty line after the section break/.test(u.content), u.content);
});

test('section_break refusals: a table cell, a line out of range, an unknown type, a break that is already there; the fake refuses segments', async () => {
  await fresh(spec({ sections: true }));
  const err = async (args) => { const r = await exec('page_parts', A({ action: 'section_break', ...args })); assert.ok(!r._ok, r.content); return r.content; };
  assert.strictEqual(await err({ line: 5 }), 'Error: line 5 is in a table cell; a section break cannot go inside a table. Give a body line outside the table (line 4 is the line before it).');
  assert.strictEqual(await err({ line: 0 }), 'Error: line must be 1-8.');
  assert.strictEqual(await err({ line: null }), 'Error: section_break needs line: the body line the new section follows.');
  assert.strictEqual(await err({ line: 2, type: 'odd_page' }), 'Error: type must be "next_page" or "continuous".');
  assert.strictEqual(await err({ line: 2 }), 'Error: a section break already follows line 2.');
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 0);
  // the fake as the API: no break in a header, footer or footnote, nor in a table
  const m = state.docModel;
  await assert.rejects(T.docsBatchUpdate(m, [{ insertSectionBreak: { location: { index: 0, segmentId: 'kix.x', tabId: 't.0' }, sectionType: 'NEXT_PAGE' } }]), /body/);
  await assert.rejects(T.docsBatchUpdate(m, [{ insertSectionBreak: { location: loc(m.lines[4].start), sectionType: 'NEXT_PAGE' } }]), /table/);
  // nor a deletion of the newline before a break without the break
  await assert.rejects(T.docsBatchUpdate(m, [{ deleteContentRange: { range: range(18, 19) } }]));
});

test('section_style: columns, separator and orientation in one updateSectionStyle with a leaf mask; verified; exact undo', async () => {
  await fresh(spec({ sections: true }));
  let r = pushTool(await exec('page_parts', A({ action: 'section_style', number: 1, text: '2 columns spacing 1 cm, separator, landscape' }), 's1'));
  assert.strictEqual(r.content, 'Done: set section 1 (lines 1–2) to 2 columns spacing 1 cm, separator, landscape; the document has 8 lines.');
  deq(lastPost().requests, [{ updateSectionStyle: { range: range(1, 2), sectionStyle: { flipPageOrientation: true,
    columnProperties: [{ paddingEnd: dim(28.35) }, { paddingEnd: dim(0) }], columnSeparatorStyle: 'BETWEEN_EACH_COLUMN' },
  fields: 'flipPageOrientation,columnProperties,columnSeparatorStyle' } }]);
  deq([r._edit.kind, r._edit.index, r._edit.n, r._cardLabel], ['section-style', 0, 1, 'Section 1']);
  deq(fake.sections()[1].style, TWO_COLS); // section 2 untouched
  // section 2 by a line of it: margins and one column again
  r = pushTool(await exec('page_parts', A({ action: 'section_style', line: 4, text: 'one column margins 2 cm' }), 's2'));
  assert.ok(r._ok, r.content);
  deq(lastPost().requests[0].updateSectionStyle, { range: range(20, 21), sectionStyle: { marginTop: dim(56.69), marginBottom: dim(56.69), marginLeft: dim(56.69),
    marginRight: dim(56.69), columnProperties: [{ paddingEnd: dim(0) }] }, fields: 'marginTop,marginBottom,marginLeft,marginRight,columnProperties' });
  assert.strictEqual((await exec('page_parts', A({ part: 'sections' }))).content, 'Sections (2):\n1: lines 1–2; 2 columns spacing 1 cm separator, landscape margins 2.54 cm first page number 1\n' +
    '2 (continuous): lines 3–8; 1 column, portrait margins 2 cm');
  // undo, newest first: the values in effect before are written (no field can be unset)
  let u = pushTool(await exec('undo_last_edit', {}, 's2u'));
  assert.ok(u._ok, u.content);
  deq(lastPost().requests[0].updateSectionStyle.sectionStyle, { marginTop: dim(72), marginBottom: dim(72), marginLeft: dim(72), marginRight: dim(72),
    columnProperties: [{ paddingEnd: dim(36) }, { paddingEnd: dim(0) }] });
  u = pushTool(await exec('undo_last_edit', {}, 's1u'));
  assert.ok(u._ok, u.content);
  deq(lastPost().requests[0].updateSectionStyle, { range: range(1, 2), sectionStyle: { flipPageOrientation: false, columnProperties: [{ paddingEnd: dim(0) }],
    columnSeparatorStyle: 'NONE' }, fields: 'flipPageOrientation,columnProperties,columnSeparatorStyle' });
  assert.strictEqual((await exec('page_parts', A({ part: 'sections' }))).content, 'Sections (2):\n1: lines 1–2; 1 column, portrait margins 2.54 cm first page number 1\n' +
    '2 (continuous): lines 3–8; 2 columns spacing 1.27 cm separator, portrait margins 2.54 cm');
});

test('section_style: a first page number on a later section cannot be undone exactly (a note); no change; refusals; a value Docs did not apply', async () => {
  await fresh(spec({ sections: true }));
  const r = pushTool(await exec('page_parts', A({ action: 'section_style', number: 2, text: 'first page number 5' }), 'p1'));
  assert.ok(r._ok, r.content);
  deq(lastPost().requests[0].updateSectionStyle.fields, 'pageNumberStart');
  deq(r._edit.inverse, { style: {}, fields: [] });
  const u = pushTool(await exec('undo_last_edit', {}, 'p1u'));
  assert.ok(u._ok && u.content.includes('the page numbering continuing from the section before could not be restored'), u.content);
  // nothing differs: no request
  const n = fake.log.length;
  assert.strictEqual((await exec('page_parts', A({ action: 'section_style', number: 2, text: '2 columns separator' }))).content,
    'No change: section 2 already reads 2 columns spacing 1.27 cm separator, portrait margins 2.54 cm first page number 5.');
  assert.strictEqual(fake.log.filter((x, i) => i >= n && x.method === 'POST').length, 0);
  const err = async (args) => { const x = await exec('page_parts', A({ action: 'section_style', ...args })); assert.ok(!x._ok, x.content); return x.content; };
  assert.strictEqual(await err({ number: 1, text: 'A4 landscape' }), 'Error: a section has no page size of its own in Google Docs (only its orientation: landscape or portrait); the page size is the whole document\'s: document_styles action page.');
  assert.match(await err({ number: 1, text: '4 columns' }), /1 to 3 columns/);
  assert.match(await err({ number: 1, text: 'pageless' }), /whole document's/);
  assert.match(await err({ number: 1, text: 'wobbly' }), /unknown word "wobbly"/);
  assert.match(await err({ number: 3, text: 'landscape' }), /the document has 2 sections; number must be 1-2/);
  assert.match(await err({ text: 'landscape' }), /needs number/);
  assert.match(await err({ number: 1, text: null }), /needs text/);
  // Docs leaves a field as it was: the re-read names it
  const real = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body);
      for (const rq of body.requests) if (rq.updateSectionStyle) { delete rq.updateSectionStyle.sectionStyle.flipPageOrientation; rq.updateSectionStyle.fields = 'marginLeft'; rq.updateSectionStyle.sectionStyle.marginLeft = dim(30); }
      init = { ...init, body: JSON.stringify(body) };
    }
    return real(url, init);
  };
  const v = await exec('page_parts', A({ action: 'section_style', number: 1, text: 'landscape left 30 pt' }), 'p2');
  fake.fetch = real;
  assert.ok(v._ok && v.content.includes('Note: Google Docs did not apply all of it (flipPageOrientation still differs)'), v.content);
});

test('gate: a section break or style change asks in Manual only (Auto: none, in a tainted turn too); the summaries', async () => {
  await fresh(spec());
  as.tainted = true;
  const ok = await exec('page_parts', A({ action: 'section_break', line: 2 }), 'g1');
  assert.ok(ok._ok && ok._decision === undefined && T.pendingPreviews.size === 0);
  as.tainted = false;
  as.askEdits = true;
  const p = exec('page_parts', A({ action: 'section_style', number: 2, text: 'landscape' }), 'g2');
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, card]] = [...T.pendingPreviews.entries()];
  assert.ok(card.card.innerHTML.includes('<div class="pv-note">Changes the layout of section 2.</div><div class="pv-anchor">Section 2</div>') &&
    card.card.innerHTML.includes('<span class="code-lang">New settings</span></div><pre>landscape</pre>'), card.card.innerHTML);
  T.decidePreview(id, 'reject');
  assert.strictEqual((await p).content, T.EDIT_DENIED_TEXT);
  as.askEdits = false;
  const call = (args) => ({ id: 'x', type: 'function', function: { name: 'page_parts', arguments: JSON.stringify(args) } });
  deq([T.logEntry(call(A({ action: 'section_break', line: 4 })), null).summary, T.logEntry(call(A({ action: 'section_style', number: 2 })), null).summary,
    T.logEntry(call(A({ action: 'section_style', line: 7 })), null).summary], ['section_break after line 4', 'section_style section 2', 'section_style line 7']);
  assert.ok(T.isReadingTool(call(A({ part: 'sections' }))) && !T.isReadingTool(call(A({ action: 'section_break', line: 2 }))));
});

test('undo finds a break that moved (text typed above it) by the text around it, and refuses when that text changed; a break Docs did not insert is named', async () => {
  await fresh(spec());
  pushTool(await exec('page_parts', A({ action: 'section_break', line: 2 }), 'm1'));
  fake.typeParagraph(0, 'New first line');
  const u = pushTool(await exec('undo_last_edit', {}, 'm1u'));
  assert.ok(u._ok, u.content);
  deq([fake.text().split('\n'), breaks().length], [['New first line', ...TEXTS], 1]);
  await fresh(spec());
  pushTool(await exec('page_parts', A({ action: 'section_break', line: 2 }), 'm2'));
  fake.tabs[0].blocks[0].paras[1].text = 'Changed.'; fake.tabs[0].blocks[0].paras[1].chars = []; fake.typeParagraph(0, 'Top');
  const v = await exec('undo_last_edit', {}, 'm2u');
  assert.ok(!v._ok && /the section break is no longer where it was inserted/.test(v.content), v.content);
  // the batch arrives without the break (simulated): the re-read says so
  await fresh(spec());
  const real = fake.fetch;
  fake.fetch = async (url, init = {}) => ((init.method || 'GET') === 'POST'
    ? real(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), requests: [{ insertText: { location: loc(1), text: 'x' } }] }) }) : real(url, init));
  const w = await exec('page_parts', A({ action: 'section_break', line: 2 }), 'm3');
  fake.fetch = real;
  assert.ok(w.content.includes('Note: the section break was not found after line 2 when the document was read again'), w.content);
});
