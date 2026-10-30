'use strict';
// page_parts (src/docs-segments.js): the schema and where it is offered, the prompt lines, the turn-context note,
// read (header, footer, footnotes with their mark, the table of contents), set_text (header, footer, footnote; a
// missing header or footer created in two batches), add_footnote (two batches with rollback), delete_footnote,
// the exact requests of each, undo of each, the gate, the errors, and a turn whose read is a reading call.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { docsBench } = require('./lib/fake-docs');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, lastPost, routeDocs;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost, routeDocs } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Lines: 1 Title, 2 The quick brown fox… (24-68), 3 Methods, 4 Data come from the survey[^1] and the archive[^2].
// (77-121; marks at 102 and 118); a table of contents (Methods / Results) before line 2; a header, a footer and
// two footnotes (" Survey of 2024.", " Archive").
const spec = ({ header = true, footer = true, headers = null, documentStyle = null } = {}) => ({ documentId: 'DOC123', title: 'Parts', tabs: [{ id: 't.0', title: 'Main',
  items: [
    { p: 'Title', style: 'TITLE' },
    { toc: [{ p: 'Methods' }, { p: 'Results' }] },
    { p: 'The quick brown fox jumps over the lazy dog.' },
    { p: 'Methods', style: 'HEADING_1' },
    { p: 'Data come from the survey[^fn.a] and the archive[^fn.b].' },
  ],
  ...(headers ? { headers } : header ? { headers: { 'kix.h1': [{ p: 'Draft header' }] } } : {}),
  ...(footer ? { footers: { 'kix.f1': [{ p: 'Page footer' }] } } : {}),
  ...(documentStyle ? { documentStyle } : {}),
  footnotes: { 'fn.a': [{ p: ' Survey of 2024.' }], 'fn.b': [{ p: ' Archive' }] },
}] });
const A = (over) => ({ action: 'read', part: null, number: null, text: null, after_text: null, ...over });
const posts = () => fake.log.filter((x) => x.method === 'POST').map((x) => x.body);
const loc = (index, extra = {}) => ({ index, tabId: 't.0', ...extra });
const range = (s, e, extra = {}) => ({ startIndex: s, endIndex: e, tabId: 't.0', ...extra });
const READ_ALL = 'Header: «Draft header»\nFooter: «Page footer»\nFootnotes (2):\n1 (line 4, after «Data come from the survey»): Survey of 2024.\n' +
  '2 (line 4, after «…om the survey￼ and the archive»): Archive\nTable of contents before line 2 (read-only): Methods / Results\n' +
  '"￼" marks an embedded element (a page number, image or chip); keep it where it is in set_text.';
// The Nth POST fails with HTTP 400 before it is applied (fake.failNext answers the next request).
function failPost(k, message = 'Invalid requests[0].insertText: boom') {
  const real = fake.fetch;
  let n = 0;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && ++n === k) fake.failNext = { status: 400, message };
    return real(url, init);
  };
}
// A call that must show the gate card: decides it and returns { r, html }.
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, p]] = [...T.pendingPreviews.entries()];
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}

test('schema, where it is offered, prompt lines, the turn-context note, icon, summary, pending card', async () => {
  await fresh(spec());
  const def = T.PAGE_PARTS_DEF.function;
  deq(def.parameters.required, ['action', 'part', 'number', 'text', 'after_text']);
  assert.strictEqual(def.parameters.additionalProperties, false);
  deq(def.parameters.properties.action.enum, ['read', 'set_text', 'add_footnote', 'delete_footnote']);
  deq(def.parameters.properties.part.anyOf, [{ type: 'string', enum: ['header', 'footer', 'footnote', 'toc'] }, { type: 'null' }]);
  deq(def.parameters.properties.number.anyOf, [{ type: 'integer' }, { type: 'null' }]);
  const names = (mode, s) => T.toolsFor(mode, s).map((t) => t.function.name);
  assert.ok(names('edit', as).includes('page_parts') && names('manual', as).includes('page_parts'));
  assert.ok(!names('edit', { ...as, docFormat: 'markdown', model: null }).includes('page_parts'));
  // the reading line in every such turn, the edit line only in Auto with the Docs API
  const edit = T.buildSystemParts('edit', 1e5, as).head;
  const manual = T.buildSystemParts('manual', 1e5, as).head;
  assert.ok(edit.includes('\n- page_parts(action "read", part, number): the header, footer, footnotes (with the line of each mark) and the table of contents; they are not in the numbered lines.\n'));
  assert.ok(manual.includes('- page_parts(action "read", part, number)'));
  assert.ok(edit.includes('\n- page_parts(action, part, number, text, after_text): set_text replaces the whole text of the header, the footer or footnote N (a missing header or footer is created); add_footnote adds a footnote with text right after after_text (exact body text); delete_footnote removes footnote N. The table of contents is read-only.\n'));
  assert.ok(!manual.includes('- page_parts(action, part'));
  assert.ok(T.buildTurnContext('edit', as).includes('</document>\nPage parts: header, footer, 2 footnotes, a table of contents before line 2; read them with page_parts.\n'));
  deq(T.pagePartsNote({ model: { segments: [], toc: null } }), '');
  // reading vs writing calls; log summaries; icon; pending text
  const call = (args) => ({ id: 'x', type: 'function', function: { name: 'page_parts', arguments: JSON.stringify(args) } });
  assert.ok(T.isReadingTool(call(A())) && !T.isReadingTool(call(A({ action: 'set_text' }))));
  deq([T.logEntry(call(A()), null).summary, T.logEntry(call(A({ part: 'footnote', number: 2 })), null).summary,
    T.logEntry(call(A({ action: 'set_text', part: 'footer', text: 'x' })), null).summary,
    T.logEntry(call(A({ action: 'add_footnote', after_text: 'the lazy dog', text: 'x' })), null).summary,
    T.logEntry(call(A({ action: 'delete_footnote', part: 'footnote', number: 1 })), null).summary],
  ['read', 'read footnote 2', 'set_text footer', 'add_footnote after «the lazy dog»', 'delete_footnote footnote 1']);
  deq([T.activityIcon('page_parts'), T.pendingCardText('page_parts'), T.isEditTool('page_parts')], ['📎', 'Changing a page part…', true]);
});

test('read: header, footer, footnotes with the line and text before each mark, the TOC; one part; one footnote', async () => {
  await fresh(spec());
  let r = await exec('page_parts', A());
  deq([r.content, r._ok, r._reading, r._message], [READ_ALL, true, true, 'read']);
  assert.strictEqual((await exec('page_parts', A({ part: 'footer' }))).content, 'Footer: «Page footer»');
  assert.strictEqual((await exec('page_parts', A({ part: 'footnote', number: 2 }))).content,
    'Footnote 2 (line 4, after «…om the survey￼ and the archive»): Archive\n"￼" marks an embedded element (a page number, image or chip); keep it where it is in set_text.');
  assert.strictEqual((await exec('page_parts', A({ part: 'footnote 1' }))).content, 'Footnote 1 (line 4, after «Data come from the survey»): Survey of 2024.');
  assert.strictEqual((await exec('page_parts', A({ part: 'toc' }))).content, 'Table of contents before line 2 (read-only): Methods / Results');
  // read works in Manual too (a reading call)
  r = await T.executeTool({ id: 'm1', type: 'function', function: { name: 'page_parts', arguments: JSON.stringify(A({ part: 'header' })) } }, 'manual', as);
  deq([r._ok, r.content], [true, 'Header: «Draft header»']);
  // nothing there; first-page and even-page headers are listed when they exist
  await fresh({ documentId: 'DOC123', title: 'Bare', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body' }] }] });
  assert.strictEqual((await exec('page_parts', A())).content, 'Header: (none)\nFooter: (none)\nFootnotes: none');
  assert.strictEqual((await exec('page_parts', A({ part: 'toc' }))).content, 'Table of contents: none');
  assert.strictEqual(T.buildTurnContext('edit', as).includes('Page parts'), false);
  await fresh(spec({ headers: { 'kix.h1': [{ p: 'Main head' }], 'kix.h2': [{ p: '' }] }, documentStyle: { defaultHeaderId: 'kix.h1', firstPageHeaderId: 'kix.h2' } }));
  assert.strictEqual((await exec('page_parts', A({ part: 'header' }))).content, 'Header: «Main head»\nFirst-page header: (empty)');
  assert.ok(T.buildTurnContext('edit', as).includes('Page parts: header, first-page header, footer, 2 footnotes'));
});

test('set_text: the header (only the differing middle), footnote 2 (its leading space kept); exact undo of each', async () => {
  await fresh(spec());
  let r = pushTool(await exec('page_parts', A({ action: 'set_text', part: 'header', text: 'Final header' }), 's1'));
  assert.strictEqual(r.content, 'Done: set the text of the header.\nIn the header:\nLines 1-1 now:\n1: Final header\nThe document now has 4 lines.');
  deq(lastPost().requests, [{ deleteContentRange: { range: range(0, 5, { segmentId: 'kix.h1' }) } }, { insertText: { location: loc(0, { segmentId: 'kix.h1' }), text: 'Final' } }]);
  deq([r._message, r._cardText, r._cardLabel, r._edit.kind, r._edit.segmentId], ['Header text set', 'Final header', 'Header text', 'replace', 'kix.h1']);
  assert.strictEqual(as.responseWrite, null); // no body line moved
  r = pushTool(await exec('page_parts', A({ action: 'set_text', part: 'footnote', number: 2, text: 'Archive of 1990\n' }), 's2'));
  assert.strictEqual(r.content, 'Done: set the text of footnote 2.\nIn the footnote 2:\nLines 1-1 now:\n1:  Archive of 1990\nThe document now has 4 lines.');
  deq(lastPost().requests, [{ insertText: { location: loc(8, { segmentId: 'fn.b' }), text: ' of 1990' } }]);
  assert.strictEqual(fake.segText('fn.b'), ' Archive of 1990');
  // an empty text empties the part (the paragraph stays)
  r = pushTool(await exec('page_parts', A({ action: 'set_text', part: 'footer', text: '' }), 's3'));
  assert.ok(r._ok, r.content);
  assert.strictEqual(fake.segText('kix.f1'), '');
  for (const [id, seg, text] of [['u3', 'kix.f1', 'Page footer'], ['u2', 'fn.b', ' Archive'], ['u1', 'kix.h1', 'Draft header']]) {
    const u = pushTool(await exec('undo_last_edit', {}, id));
    assert.ok(u._ok, u.content);
    assert.strictEqual(fake.segText(seg), text);
  }
  const u = state.messages[state.messages.length - 1];
  assert.strictEqual(u.content, 'Done: undid "Header text set".\nIn the header:\nLines 1-1 now:\n1: Draft header\nThe document now has 4 lines.');
});

test('set_text on a missing footer: createFooter, then its text (two batches); undo deletes the footer; a failed text batch deletes it again', async () => {
  await fresh(spec({ footer: false }));
  const r = pushTool(await exec('page_parts', A({ action: 'set_text', part: 'footer', text: 'New foot' }), 'c1'));
  assert.strictEqual(r.content, 'Done: created the footer with the text.\nIn the footer:\nLines 1-1 now:\n1: New foot\nThe document now has 4 lines.');
  const [b1, b2] = posts();
  deq(b1.requests, [{ createFooter: { type: 'DEFAULT', sectionBreakLocation: loc(0) } }]);
  const id = fake.segments('t.0').footers[0];
  deq(b2.requests, [{ insertText: { location: loc(0, { segmentId: id }), text: 'New foot' } }]);
  deq([r._message, r._edit.kind, r._edit.parts.map((p) => p.kind), r._edit.parts[0].requests, r._edit.parts[0].anchor],
    ['Footer created', 'multi', ['requests', 'insert'], [{ deleteFooter: { footerId: id, tabId: 't.0' } }], false]);
  const u = pushTool(await exec('undo_last_edit', {}, 'c1u'));
  assert.ok(u._ok && u.content.startsWith('Done: undid "Footer created".'), u.content);
  deq(fake.segments('t.0').footers, []);
  deq(posts().slice(2).map((b) => Object.keys(b.requests[0])[0]), ['deleteContentRange', 'deleteFooter']);
  // the text was changed by hand: undo refuses (the inserted text is checked first)
  await fresh(spec({ footer: false }));
  pushTool(await exec('page_parts', A({ action: 'set_text', part: 'footer', text: 'New foot' }), 'c2'));
  const fid = fake.segments('t.0').footers[0];
  await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' },
    body: JSON.stringify({ requests: [{ insertText: { location: loc(0, { segmentId: fid }), text: 'My ' } }] }) });
  const u2 = await exec('undo_last_edit', {}, 'c2u');
  assert.ok(!u2._ok && /changed near that edit/.test(u2.content), u2.content);
  deq(fake.segments('t.0').footers, [fid]);
  // the second batch fails: the new footer is deleted again
  await fresh(spec({ footer: false }));
  failPost(2);
  const f = await exec('page_parts', A({ action: 'set_text', part: 'footer', text: 'New foot' }), 'c3');
  assert.ok(!f._ok && /failed halfway \(Google Docs API error 400: Invalid requests\[0\]\.insertText: boom\) and its first part was rolled back/.test(f.content), f.content);
  deq(fake.segments('t.0').footers, []);
  deq(Object.keys(posts().pop().requests[0]), ['deleteFooter']);
});

test('add_footnote: createFootnote right after the passage, then its text in the new footnote; undo removes both; rollback', async () => {
  await fresh(spec());
  const r = pushTool(await exec('page_parts', A({ action: 'add_footnote', after_text: 'lazy dog', text: '  A dog. ' }), 'f1'));
  assert.strictEqual(r.content, 'Done: added footnote 1 after «lazy dog» on line 2.\nLines 2-2 now:\n2: The quick brown fox jumps over the lazy dog￼.\nIn the footnote 1:\nLines 1-1 now:\n1:  A dog.\nThe document now has 4 lines.');
  const [b1, b2] = posts();
  deq(b1.requests, [{ createFootnote: { location: loc(67) } }]);
  const fid = b2.requests[0].insertText.location.segmentId;
  deq(b2.requests, [{ insertText: { location: loc(1, { segmentId: fid }), text: 'A dog.' } }]);
  deq([r._message, r._cardText, r._cardLabel], ['Footnote 1 added after line 2', 'A dog.', 'Footnote text']);
  assert.strictEqual(as.responseWrite, null);
  // the later footnotes are renumbered by Docs
  assert.strictEqual((await exec('page_parts', A({ part: 'footnote' , number: 3 }))).content.split('\n')[0], 'Footnote 3 (line 4, after «…om the survey￼ and the archive»): Archive');
  const u = pushTool(await exec('undo_last_edit', {}, 'f1u'));
  assert.strictEqual(u.content, 'Done: undid "Footnote 1 added after line 2".\nLines 2-2 now:\n2: The quick brown fox jumps over the lazy dog.\nThe document now has 4 lines.');
  deq(posts().slice(2).map((b) => b.requests), [[{ deleteContentRange: { range: range(1, 7, { segmentId: fid }) } }], [{ deleteContentRange: { range: range(67, 68) } }]]);
  deq(as.model.segments.filter((s) => s.type === 'footnote').map((s) => s.segmentId), ['fn.a', 'fn.b']);
  // the text batch fails: the mark (and with it the footnote) is deleted again
  await fresh(spec());
  failPost(2);
  const f = await exec('page_parts', A({ action: 'add_footnote', after_text: 'lazy dog', text: 'A dog.' }), 'f2');
  assert.ok(!f._ok && /rolled back, so the document is as it was/.test(f.content), f.content);
  deq(posts().pop().requests, [{ deleteContentRange: { range: range(67, 68) } }]);
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'The quick brown fox jumps over the lazy dog.');
  // the first batch fails: nothing changed, reported like any rejected edit
  await fresh(spec());
  failPost(1, 'Invalid location');
  const g = await exec('page_parts', A({ action: 'add_footnote', after_text: 'lazy dog', text: 'A dog.' }), 'f3');
  assert.ok(!g._ok && /rejected the edit: Google Docs API error 400: Invalid location/.test(g.content), g.content);
});

test('delete_footnote: a large edit (card), the mark deleted; undo re-creates the footnote with its plain text', async () => {
  await fresh(spec());
  const p = exec('page_parts', A({ action: 'delete_footnote', part: 'footnote', number: 1 }), 'd1');
  const { r, html } = await decided(p, 'accept');
  assert.ok(html.includes('Large edit: it deletes footnote 1.') && html.includes('Survey of 2024.'), html);
  pushTool(r);
  assert.strictEqual(r.content, 'Done: deleted footnote 1 (its text was «Survey of 2024.»).\nLines 4-4 now:\n4: Data come from the survey and the archive￼.\nThe document now has 4 lines.');
  deq(lastPost().requests, [{ deleteContentRange: { range: range(102, 103) } }]);
  deq([r._message, r._decision, r._edit.kind, r._edit.index, r._edit.restore], ['Footnote 1 deleted', 'accepted', 'footnote-restore', 102, 'Survey of 2024.']);
  // someone typed above it: the undo finds the place by its context
  fake.typeParagraph(0, 'New first line');
  const u = pushTool(await exec('undo_last_edit', {}, 'd1u'));
  assert.strictEqual(u.content, 'Done: undid "Footnote 1 deleted": footnote 1 re-created on line 5.\nNote: the footnote was re-created as plain text; its formatting was not restored.\nLines 5-5 now:\n5: Data come from the survey￼ and the archive￼.\nThe document now has 5 lines.');
  const [c1, c2] = posts().slice(-2);
  deq(c1.requests, [{ createFootnote: { location: loc(117) } }]);
  deq(c2.requests[0].insertText.text, 'Survey of 2024.');
  deq(as.model.segments.filter((s) => s.type === 'footnote').map((s) => [s.n, s.text]), [[1, ' Survey of 2024.'], [2, ' Archive']]);
  // the context changed: refused
  await fresh(spec());
  as.editAll = true;
  pushTool(await exec('page_parts', A({ action: 'delete_footnote', part: 'footnote', number: 2 }), 'd2'));
  await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' },
    body: JSON.stringify({ requests: [{ insertText: { location: loc(117), text: 's' } }] }) });
  const u2 = await exec('undo_last_edit', {}, 'd2u');
  assert.ok(!u2._ok && /text around the deleted footnote's mark changed/.test(u2.content), u2.content);
  // Deny: nothing sent
  await fresh(spec());
  const n = posts().length;
  const d = await decided(exec('page_parts', A({ action: 'delete_footnote', part: 'footnote', number: 2 }), 'd3'), 'reject');
  deq([d.r._ok, d.r._decision, posts().length], [false, 'rejected', n]);
});

test('gate: set_text that removes 300+ characters asks; small edits pass without a card unless the turn is tainted', async () => {
  const long = 'x'.repeat(320);
  await fresh({ ...spec(), tabs: [{ ...spec().tabs[0], headers: { 'kix.h1': [{ p: long }] } }] });
  const { r, html } = await decided(exec('page_parts', A({ action: 'set_text', part: 'header', text: 'Short' }), 'g1'), 'accept');
  assert.ok(r._ok && html.includes('Large edit: it replaces the text of the header (320 characters removed).'), html);
  assert.strictEqual(fake.segText('kix.h1'), 'Short');
  // small: no card
  const s = await exec('page_parts', A({ action: 'set_text', part: 'header', text: 'Shorter' }), 'g2');
  assert.ok(s._ok && s._decision === undefined && T.pendingPreviews.size === 0);
  const f = await exec('page_parts', A({ action: 'add_footnote', after_text: 'lazy dog', text: 'x' }), 'g3');
  assert.ok(f._ok && f._decision === undefined);
  // a tainted turn asks for any write
  as.tainted = true;
  const t = await decided(exec('page_parts', A({ action: 'add_footnote', after_text: 'brown fox', text: 'y' }), 'g4'), 'reject');
  assert.ok(t.html.includes('This edit adds a footnote.') && t.r.content === T.EDIT_DENIED_TEXT, t.html);
  as.tainted = false;
  deq(T.editGateInfo('page_parts', {}), null); // no plan: no gate info
});

test('errors: unknown part, missing footnote, first-page header, the TOC, after_text not in the body, ambiguous, missing arguments', async () => {
  await fresh(spec());
  const err = async (args) => { const r = await exec('page_parts', A(args)); assert.ok(!r._ok, r.content); return r.content; };
  assert.strictEqual(await err({ part: 'sidebar' }), 'Error: part must be "header", "footer", "footnote" (with number) or "toc".');
  assert.strictEqual(await err({ action: 'rename' }), 'Error: action must be "read", "set_text", "add_footnote" or "delete_footnote".');
  assert.strictEqual(await err({ part: 'footnote', number: 5 }), 'Error: the document has 2 footnotes; number must be 1-2.');
  assert.strictEqual(await err({ action: 'set_text', part: 'footnote', number: null, text: 'x' }), 'Error: number is required with part "footnote" (1-2).');
  const kind = 'Error: page_parts changes only the default header and footer (part "header" or "footer"); a first-page or even-page header or footer cannot be created or changed here. Change it in Google Docs.';
  assert.strictEqual(await err({ action: 'set_text', part: 'first-page header', text: 'x' }), kind);
  assert.strictEqual(await err({ action: 'set_text', part: 'even-page footer', text: 'x' }), kind);
  const toc = 'Error: the table of contents cannot be changed through the Google Docs API; it is updated in Google Docs (click the table of contents → Update).';
  assert.strictEqual(await err({ action: 'set_text', part: 'toc', text: 'x' }), toc);
  assert.strictEqual(await err({ action: 'delete_footnote', part: 'toc' }), toc);
  assert.strictEqual(await err({ action: 'set_text', part: 'header', text: null }), 'Error: text is required for set_text: the new plain text of the part ("" empties it).');
  assert.strictEqual(await err({ action: 'set_text', part: 'header', text: 'Draft header' }), 'Error: the header already reads that; nothing to change.');
  assert.strictEqual(await err({ action: 'set_text', part: null, text: 'x' }), 'Error: set_text needs part "header", "footer" or "footnote" (with number).');
  assert.strictEqual(await err({ action: 'set_text', part: 'header', text: 'Page ￼' }), 'Error: the header contains an embedded element (shown as "￼": a page number, image or chip) that set_text cannot re-create. Keep "￼" in text where it is and change only the text around it.');
  assert.strictEqual(await err({ action: 'add_footnote', after_text: 'Draft header', text: 'x' }), 'Error: after_text must be body text (footnotes cannot go into a header, footer or footnote).');
  assert.match(await err({ action: 'add_footnote', after_text: 'the', text: 'x' }), /^Error: after_text occurs 3 times \(lines 2, 4\)\. Include more of the surrounding text so that it occurs exactly once\.$/);
  assert.match(await err({ action: 'add_footnote', after_text: 'lazy cat', text: 'x' }), /^Error: after_text not found\. Closest match at line 2: .*after_text must match the body text exactly/s);
  assert.strictEqual(await err({ action: 'add_footnote', after_text: null, text: 'x' }), 'Error: after_text is required for add_footnote: the exact body text (occurring once) that the footnote mark follows.');
  assert.strictEqual(await err({ action: 'add_footnote', after_text: 'lazy dog', text: ' ' }), 'Error: text is required for add_footnote: the footnote text.');
  assert.strictEqual(await err({ action: 'add_footnote', part: 'header', after_text: 'lazy dog', text: 'x' }), 'Error: add_footnote adds a footnote to the body; pass part null (a header cannot get one).');
  assert.strictEqual(await err({ action: 'delete_footnote', part: 'footer' }), 'Error: delete_footnote deletes footnotes only; to empty the footer use set_text with text "".');
  await fresh({ documentId: 'DOC123', title: 'Bare', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body' }] }] });
  assert.strictEqual(await err({ action: 'delete_footnote', part: 'footnote', number: 1 }), 'Error: the document has no footnotes; add one with add_footnote.');
  assert.strictEqual(await err({ action: 'set_text', part: 'header', text: '' }), 'Error: the document has no header; nothing to empty.');
  assert.strictEqual(posts().length, 0);
  // writing calls: Auto only; read stays available in Manual
  const m = await T.executeTool({ id: 'w', type: 'function', function: { name: 'page_parts', arguments: JSON.stringify(A({ action: 'set_text', part: 'header', text: 'x' })) } }, 'manual', as);
  assert.ok(!m._ok && /cannot be modified in this mode/.test(m.content));
});

test('a turn: page_parts read is a reading call (quiet row, no card, stubbed after the turn); the answer follows', async () => {
  await fresh(spec());
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  const bodies = [];
  const rounds = [msgStart + tu(0, 'toolu_pp', 'page_parts', A()) + stopTool, textRound('Two footnotes.')];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  const messages = [{ role: 'user', content: 'How many footnotes?' }];
  const out = await T.toolLoop('edit', s, new AbortController().signal, { messages, save: async () => {} });
  deq(out.tools, ['page_parts']);
  const r = messages.find((m) => m.role === 'tool');
  deq([r._ok, r._reading, r._message, r.content], [true, true, 'read', READ_ALL]);
  assert.ok(bodies[0].tools.some((t) => t.name === 'page_parts'));
  T.slimHistory(messages);
  assert.strictEqual(r.content, '[page_parts: content omitted after the turn; re-read if needed]');
});
