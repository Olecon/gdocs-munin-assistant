'use strict';
// read_comments (read-only comment threads through the Docs API comments view): where it is offered, the prompt
// line, the result text (status filter, anchors mapped to lines in the body, a table cell, another tab, a footnote,
// the quote fallback, lost anchors, replies), the limits, the per-turn cache, the errors, the fake's API shapes and
// a full turn (a reading call: no card, stubbed after the turn, works in Manual).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
require('./lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, storage, fresh, exec, routeDocs, ident;

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  ident = installIdentity(env);
  ({ fresh, exec, routeDocs } = docsBench(env, ident, ref));
  Object.assign(storage, { muninProvider: 'anthropic', anthropicApiKey: 'sk-ant-NEW', anthropicModel: 'claude-sonnet-5-5' });
  await T.loadSettings();
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// The standard document's lines (docSpec): 4 'Alpha beta gamma.', 5 'Alpha beta delta.', 6 'Cell A' (a table cell),
// 10 'Last line'; the second tab 'Notes'.
const baseModel = () => T.buildLineModel(fakeDocsServer(docSpec()).render(true), 't.0', 'DOC123');
function threads() {
  const L = (n) => baseModel().lines[n - 1];
  return [
    { id: 'c1', status: 'open', start: L(4).start + 6, end: L(5).start + 5, quoted: 'beta gamma.\nAlpha', author: 'Anna K.', date: '2026-10-20', text: 'Too vague.\nExplain.',
      replies: [{ author: { displayName: 'Ivan', me: true }, date: '2026-10-21', text: 'Fixed' }, { author: 'Bob', text: 'gone', deleted: true }] },
    { id: 'c2', status: 'resolved', start: L(6).start, end: L(6).end, quoted: 'Cell A', author: 'Bob', text: 'Rename', replies: [{ author: 'Anna K.', action: 'RESOLVE', text: '' }] },
    { id: 'c3', status: 'open', tab: 't.second', start: 1, end: 7, quoted: 'Second', author: 'Carol', text: 'Other tab' },
    { id: 'c4', status: 'open', quoted: 'Last line', text: 'Check' },
    { id: 'c5', status: 'open', quoted: 'gone text', text: 'Stale' },
  ];
}
const withComments = (comments, over) => ({ ...docSpec(over), comments });
const call = (args, id = 'rc' + Math.random().toString(36).slice(2, 6)) => ({ id, type: 'function', function: { name: 'read_comments', arguments: JSON.stringify(args) } });
const read = async (args, mode = 'edit') => (await T.executeTool(call({ status: 'open', lines: null, ...args }), mode, as)).content;
const commentGets = () => fake.log.filter((x) => x.method === 'GET' && /commentsViewMode=/.test(x.url));

const OPEN = '4 open comment threads (of 5):\n' +
  '[id c1] open · lines 4–5 «beta gamma. Alpha» · Anna K. · 2026-10-20: Too vague. Explain.\n' +
  '  ↳ Ivan (you) · 2026-10-21: Fixed\n' +
  '[id c3] open · in tab "Notes" «Second» · Carol · 2026-10-20: Other tab\n' +
  '[id c4] open · line 10 (by its quote) «Last line» · Anna K. · 2026-10-20: Check\n' +
  '[id c5] open · anchor text no longer in the document (quote: «gone text») · Anna K. · 2026-10-20: Stale';

test('offered with read_formatting: tools turns whose main document was read through the Docs API; the prompt line', async () => {
  await fresh(withComments([]));
  deq(T.READ_COMMENTS_TOOL.function.parameters.required, ['status', 'lines']);
  for (const mode of ['edit', 'manual', 'research']) {
    const names = T.toolsFor(mode, as).map((t) => t.function.name);
    assert.ok(names.includes('read_comments'), mode);
    // the research prompt lists no reading tools (like read_formatting)
    if (mode !== 'research') assert.ok(T.buildSystemParts(mode, 1e5, as).head.includes('\n- read_comments(status, lines): the comment threads'), mode);
  }
  const exported = { ...as, docFormat: 'markdown', model: null, promptView: null };
  assert.ok(!T.toolsFor('edit', exported).some((t) => t.function.name === 'read_comments'));
  assert.ok(!T.buildSystemParts('edit', 1e5, exported).head.includes('read_comments'));
  state.settings.provider = 'munin';
  deq(T.toolsFor('code', T.takeSnapshot()), []); // Munin persona turns: no client tools
  state.settings.provider = 'anthropic';
  // not offered: refused without a request
  const r = await T.executeTool(call({ status: 'open', lines: null }), 'edit', exported);
  assert.ok(!r._ok && /not available for this message/.test(r.content));
  // action log and icon
  assert.strictEqual(T.logEntry(call({ status: 'open', lines: null }), null).summary, 'comments (open)');
  assert.strictEqual(T.logEntry(call({ status: 'resolved', lines: '9-3' }), null).summary, 'comments (resolved, lines 3–9)');
  assert.strictEqual(T.activityIcon('read_comments'), '💬');
  assert.ok(T.isReadingTool(call({ status: 'all', lines: null })) && !T.isEditTool('read_comments'));
});

test('result: open threads with lines, tabs, the quote fallback, lost anchors and replies; resolved, all, a line range', async () => {
  await fresh(withComments(threads()));
  assert.strictEqual(await read({}), OPEN);
  assert.strictEqual(await read({ status: 'resolved' }), '1 resolved comment thread (of 5):\n[id c2] resolved · line 6 «Cell A» · Bob · 2026-10-20: Rename\n  ↳ Anna K. · 2026-10-20: [resolved]');
  const all = await read({ status: 'all' });
  assert.ok(all.startsWith('5 comment threads:\n[id c1] open'), all);
  assert.ok(all.includes('\n[id c2] resolved · line 6'));
  assert.strictEqual(await read({ status: 'all', lines: '5-6' }), '2 comment threads in lines 5–6 (of 5):\n' +
    '[id c1] open · lines 4–5 «beta gamma. Alpha» · Anna K. · 2026-10-20: Too vague. Explain.\n  ↳ Ivan (you) · 2026-10-21: Fixed\n' +
    '[id c2] resolved · line 6 «Cell A» · Bob · 2026-10-20: Rename\n  ↳ Anna K. · 2026-10-20: [resolved]');
  assert.strictEqual(await read({ lines: 'lines 10' }), '1 open comment thread in line 10 (of 5):\n[id c4] open · line 10 (by its quote) «Last line» · Anna K. · 2026-10-20: Check');
  assert.strictEqual(await read({ lines: '1–3' }), 'No comments (status: open, lines 1–3; 5 threads in all).');
  assert.strictEqual(await read({ lines: 'intro' }), 'Error: lines must be a range like "10-25" (got "intro"), or null.');
  assert.strictEqual(await read({ status: 'bogus' }), OPEN); // an unknown status reads the open threads
  assert.strictEqual(commentGets().length, 1); // one GET for all of these calls
  // no comments at all
  await fresh(withComments([]));
  assert.strictEqual(await read({}), 'No comments (status: open).');
});

test('result: anchors in a footnote and in a vanished segment; an anonymous author; a deleted head post', async () => {
  const spec = { documentId: 'DOC123', title: 'Notes', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body[^fn.a] text.' }, { p: 'More' }], footnotes: { 'fn.a': [{ p: ' First note' }] } }],
    comments: [
      { id: 'f1', start: 1, end: 6, segmentId: 'fn.a', quoted: 'First', author: { displayName: '', anonymous: true }, text: 'Cite it' },
      { id: 'f2', start: 0, end: 3, segmentId: 'kix.gone', quoted: 'Old', text: 'x' },
      { id: 'f3', start: 1, end: 5, quoted: 'Body', text: 'removed', deleted: true },
    ] };
  await fresh(spec);
  assert.strictEqual(await read({}), '3 open comment threads:\n' +
    '[id f1] open · footnote 1, line 1 «First» · Anonymous · 2026-10-20: Cite it\n' +
    '[id f2] open · in a header, footer or footnote «Old» · Anna K. · 2026-10-20: x\n' +
    '[id f3] open · line 1 «Body» · Anna K. · 2026-10-20: (deleted)');
  // a line range keeps only threads with body lines
  assert.strictEqual(await read({ lines: '1-2' }), '1 open comment thread in lines 1–2 (of 3):\n[id f3] open · line 1 «Body» · Anna K. · 2026-10-20: (deleted)');
});

test('limits: 50 threads, 6,000 characters, long posts and quotes clipped; the note says how to narrow', async () => {
  const L4 = baseModel().lines[3];
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'm' + i, start: L4.start, end: L4.start + 5, quoted: 'Alpha', text: 'Short ' + i }));
  await fresh(withComments(many));
  let r = await read({});
  assert.strictEqual((r.match(/^\[id /gm) || []).length, T.COMMENTS_MAX_THREADS);
  assert.ok(r.startsWith('60 open comment threads:\n') && r.endsWith('\n[10 more; narrow with lines or status.]'), r.slice(-60));
  const long = Array.from({ length: 20 }, (_, i) => ({ id: 'l' + i, start: L4.start, end: L4.end, quoted: 'q'.repeat(200), text: 'w'.repeat(1000) }));
  await fresh(withComments(long));
  r = await read({});
  const shown = (r.match(/^\[id /gm) || []).length;
  assert.ok(shown < 20 && r.length <= T.COMMENTS_MAX_CHARS + 200, `${shown} threads, ${r.length} chars`);
  assert.ok(r.endsWith(`\n[${20 - shown} more; narrow with lines or status.]`));
  assert.ok(r.includes(`«${'q'.repeat(80)}…»`) && r.includes(`: ${'w'.repeat(400)}…\n`));
});

test('cache: read once per turn and document revision; an edit in the turn reads the moved anchors again; snap.model untouched', async () => {
  await fresh(withComments(threads()));
  const model = as.model;
  await read({});
  await read({ status: 'all' });
  assert.strictEqual(commentGets().length, 1);
  assert.strictEqual(commentGets()[0].url, 'https://docs.googleapis.com/v1/documents/DOC123?' + T.COMMENTS_QUERY);
  assert.ok(/fields=revisionId,comments,tabs\(tabProperties\(tabId,title\),documentTab\(commentAnchors\),childTabs\(/.test(T.COMMENTS_QUERY));
  assert.ok(T.COMMENTS_QUERY.includes('includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED'));
  assert.strictEqual(as.model, model); // reading comments never replaces the turn's model
  // a write in the same turn: a new line before the anchor; the next call reads again and maps to the new lines
  const w = await exec('insert_after_line', { line: 2, text: 'Inserted' });
  assert.ok(w._ok, w.content);
  const r = await read({ lines: '5-6' });
  assert.strictEqual(commentGets().length, 2);
  assert.ok(r.includes('[id c1] open · lines 5–6 «beta gamma. Alpha»'), r);
  // a new turn has a new snapshot: read again
  as = T.takeSnapshot(); T.snapshotDocument(as);
  await read({});
  assert.strictEqual(commentGets().length, 3);
});

test('a comments read from a later revision says the line numbers may be off', async () => {
  await fresh(withComments(threads()));
  fake.typeParagraph(0, 'Typed by someone'); // the document changed after the snapshot
  const r = await read({});
  assert.ok(r.endsWith('\n[The document changed after this message was sent: line numbers may be slightly off.]'), r);
});

test('errors: 403, 404, no comments view, no Docs API model', async () => {
  await fresh(withComments(threads()));
  fake.failNext = { status: 403, message: 'The caller does not have permission' };
  let r = await read({});
  assert.ok(r.startsWith('Error: could not read the comments: Google denied access (HTTP 403)'), r);
  fake.failNext = { status: 404, message: 'Requested entity was not found.' };
  r = await read({});
  assert.ok(r.startsWith('Error: could not read the comments: The Docs API cannot find this document (HTTP 404)'), r);
  fake.commentsUnsupported = true;
  r = await read({});
  assert.ok(r.startsWith('Error: Google refused to return the comments (HTTP 400; the comments view may not be available for this document or account: Invalid value'), r);
  assert.ok(r.endsWith('Answer without them, or ask the user to paste the comments.'));
  fake.commentsUnsupported = false;
  assert.strictEqual(await read({}), OPEN); // a failure is not cached
  deq(await T.readComments({ status: 'open' }, { ...as, docFormat: 'markdown', model: null }), 'Error: comments need the Google Docs API, which is not available for this message.');
});

test('fake: the comments view in the API shapes and the parameter rules; the plain GET has no comments', async () => {
  await fresh(withComments(threads()));
  const get = (q) => fake.fetch('https://docs.googleapis.com/v1/documents/DOC123?' + q, { headers: { Authorization: 'Bearer tok-1' } });
  let r = await get(T.COMMENTS_QUERY);
  const body = await r.json();
  assert.strictEqual(body.revisionId, 'rev-1');
  deq(body.comments[0], { commentId: 'c1', anchorId: 'kix.anchor0', status: 'OPEN', plainTextQuote: 'beta gamma.\nAlpha',
    headPost: { postId: 'c1.p0', content: 'Too vague.\nExplain.', author: { displayName: 'Anna K.' }, createTime: '2026-10-20T10:00:00.000Z' },
    replies: [{ postId: 'c1.p1', content: 'Fixed', author: { displayName: 'Ivan', me: true }, createTime: '2026-10-21T10:00:00.000Z' },
      { postId: 'c1.p2', content: 'gone', author: { displayName: 'Bob' }, createTime: '2026-10-20T10:00:00.000Z', deleted: true }] });
  deq(body.comments[1].replies[0].commentAction, 'RESOLVE');
  deq(body.comments.map((c) => c.status), ['OPEN', 'RESOLVED', 'OPEN', 'OPEN', 'OPEN']);
  const L = baseModel().lines;
  deq(body.tabs[0], { tabProperties: { tabId: 't.0', title: 'Main', index: 0 }, documentTab: { commentAnchors: {
    'kix.anchor0': { anchorId: 'kix.anchor0', ranges: [{ startIndex: L[3].start + 6, endIndex: L[4].start + 5, tabId: 't.0' }] },
    'kix.anchor1': { anchorId: 'kix.anchor1', ranges: [{ startIndex: L[5].start, endIndex: L[5].end, tabId: 't.0' }] },
  } } });
  deq(body.tabs[1].documentTab, { commentAnchors: { 'kix.anchor2': { anchorId: 'kix.anchor2', ranges: [{ startIndex: 1, endIndex: 7, tabId: 't.second' }] } } });
  r = await get('suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED');
  assert.strictEqual(r.status, 400);
  r = await get('includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED');
  assert.strictEqual(r.status, 400);
  r = await get('includeTabsContent=true');
  assert.ok(!('comments' in (await r.json())));
});

test('a turn: read_comments is a reading call (no card, no journal), stubbed after the turn, in Auto and Manual', async () => {
  for (const applyMode of ['auto', 'manual']) {
    fake = fakeDocsServer(withComments(threads()));
    env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
      : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
    await T.createChat();
    ident.granted = true; state.googleConnected = true; state.applyMode = applyMode;
    const rounds = [msgStart + tu(0, 'toolu_c', 'read_comments', { status: 'open', lines: null }) + stopTool, textRound('Four open comments.')];
    const bodies = [];
    env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
    T.el.input.value = 'What do the reviewers say?';
    await T.sendMessage();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(bodies.length, 2, applyMode);
    assert.strictEqual(bodies[0].tools.filter((t) => !['draft', 'revise_section'].includes(t.name)).pop().name, 'read_comments'); // draft, revise_section: Auto only
    assert.ok(bodies[0].system.some((b) => b.text.includes('- read_comments(status, lines)')));
    assert.strictEqual(bodies[1].messages[2].content[0].content, OPEN);
    const msg = state.messages.find((m) => m.role === 'tool');
    deq([msg._reading, msg._ok, msg._message, msg._edit], [true, true, 'comments (open)', undefined]);
    assert.strictEqual(msg.content, '[read_comments: content omitted after the turn; re-read if needed]');
    assert.strictEqual(state.messages[state.messages.length - 1].content, 'Four open comments.');
    assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 0); // nothing written
    assert.strictEqual(commentGets().length, 1);
  }
  state.applyMode = 'auto';
});
