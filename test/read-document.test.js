'use strict';
// read_document: the one reading tool for the outline, lines, formatting and comments. Scopes ({start, end}, "outline",
// "all", and the loose forms models send), includes (the default labels heading lines and shows list markers; text alone
// is the plain view; formatting the notation; headings alone the outline of the range), the per-provider limits and the
// continuation note, the stub after the turn, the action-log rows, old_text copied with labels and markers, and the
// reading tools of earlier versions: refused in a new turn, still rendered and stubbed in stored chats.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ fresh, exec } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// 1 Title, 2 Methods (h1), 3 Intro **bold**, 4-5 a bulleted list (levels 0, 1), 6-8 a numbered list (1., a., 2.),
// 9 Results (h2), 10 a checklist item, 11 Last.
const spec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'Methods', style: 'HEADING_1' },
  { p: 'Intro text.', fmt: [[6, 10, { bold: true }]] },
  { p: 'Point one', bullet: { listId: 'kix.b', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  { p: 'Sub point', bullet: { listId: 'kix.b', level: 1 } },
  { p: 'First step', bullet: { listId: 'kix.n', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } },
  { p: 'Detail', bullet: { listId: 'kix.n', level: 1 } },
  { p: 'Second step', bullet: { listId: 'kix.n', level: 0 } },
  { p: 'Results', style: 'HEADING_2' },
  { p: 'Buy milk', bullet: { listId: 'kix.c', level: 0, preset: 'BULLET_CHECKBOX' } },
  { p: 'Last' },
] });
const RD = (scope, include = null, doc = null) => ({ scope, include, doc });
const read = async (scope, include) => (await exec('read_document', RD(scope, include), null)).content;

test('schema: scope, include and doc, strict; the description names the views and that labels are not text', () => {
  const p = T.TOOL_DEFS.read_document.function.parameters;
  deq(p.required, ['scope', 'include', 'doc']);
  deq(p.properties.scope.anyOf[1], { type: 'string', enum: ['outline', 'all'] });
  deq(p.properties.scope.anyOf[0].required, ['start', 'end']);
  deq(p.properties.include.anyOf[0].items.enum, ['text', 'headings', 'lists', 'formatting', 'comments']);
  const d = T.TOOL_DEFS.read_document.function.description;
  assert.ok(/null = text, headings, lists/.test(d) && /never copy them into old_text/.test(d), d);
  deq(T.READING_TOOLS, ['read_document', 'find_in_document', 'get_selection']);
});

test('the default view labels heading lines and shows list markers with their nesting; text alone is the plain view', async () => {
  await fresh(spec());
  assert.strictEqual(await read({ start: 1, end: 11 }), 'Lines 1-11 of 11:\n' +
    '1 [Title]: Report\n2 [H1]: Methods\n3: Intro text.\n4: • Point one\n5:   • Sub point\n6: 1. First step\n7:   a. Detail\n8: 2. Second step\n' +
    '9 [H2]: Results\n10: ☐ Buy milk\n11: Last');
  assert.strictEqual(await read({ start: 4, end: 5 }, ['text']), 'Lines 4-5 of 11:\n4: Point one\n5: Sub point');
  // the markers count from the top of the document, whatever the range
  assert.strictEqual(await read({ start: 8, end: 8 }), 'Lines 8-8 of 11:\n8: 2. Second step');
  // a nested numbering joins the levels
  const m = { lines: [{ line: 1, list: { listId: 'a', level: 0, kind: 'number', nested: true } }, { line: 2, list: { listId: 'a', level: 1, kind: 'number', nested: true } }] };
  deq([...T.listMarks(m).values()], ['1. ', '  1.1. ']);
  // headings alone: the outline of the range
  assert.strictEqual(await read({ start: 2, end: 9 }, ['headings']), '2 headings in lines 2-9 (11 lines in total):\nL2: [H1] Methods\nL9: [H2] Results');
  assert.strictEqual(await read({ start: 3, end: 8 }, ['headings']), 'No headings in lines 3-8.');
});

test('a lone first top-level heading is named the title in the outline, the default view and the formatting view; not with a Title paragraph', async () => {
  // the eval case heading-indent-like-this: an H1 title over H2 sections ("the other headings" are the sections)
  await fresh(docSpec({ items: [{ p: 'Supplementary material', style: 'HEADING_1' }, { p: 'Software', style: 'HEADING_2' }, { p: 'Text.' }, { p: 'Spectra', style: 'HEADING_2' }] }));
  assert.strictEqual(await read({ start: 1, end: 2 }), 'Lines 1-2 of 4:\n1 [H1 title]: Supplementary material\n2 [H2]: Software');
  assert.ok((await read({ start: 1, end: 2 }, ['formatting'])).endsWith('Lines 1-2 of 4:\n1: [h1 title] Supplementary material\n2: [h2] Software'));
  assert.strictEqual(await read('outline'), '3 headings (4 lines in total):\nL1: [H1 title] Supplementary material\nL2: [H2] Software\nL4: [H2] Spectra');
  assert.strictEqual(T.docTitleHeading(as.model), as.model.lines[0]);
  // two H1s, or a Title paragraph: no heading is the title
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'Text.' }, { p: 'End', style: 'HEADING_1' }] }));
  assert.strictEqual(await read('outline'), '2 headings (3 lines in total):\nL1: [H1] Intro\nL3: [H1] End');
  await fresh(docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: 'Data', style: 'HEADING_2' }] }));
  assert.strictEqual(T.docTitleHeading(as.model), null);
  assert.strictEqual(await read('outline'), '3 headings (3 lines in total):\nL1: [Title] Report\nL2: [H1] Methods\nL3: [H2] Data');
});

test('formatting: the notation of read_formatting; scope outline and all; the loose forms', async () => {
  await fresh(spec());
  const f = await read({ start: 2, end: 4 }, ['formatting']);
  assert.ok(f.startsWith(T.FORMAT_NOTE) && f.endsWith('Lines 2-4 of 11:\n2: [h1] Methods\n3: Intro **text**.\n4: [bullet] Point one'), JSON.stringify(f));
  assert.strictEqual(f, T.runReadingTool('read_formatting', { start: 2, end: 4 }, as)); // the internal view
  assert.strictEqual(await read('outline'), '3 headings (11 lines in total):\nL1: [Title] Report\nL2: [H1] Methods\nL9: [H2] Results');
  assert.ok((await read('all', ['text'])).startsWith('Lines 1-11 of 11:\n1: Report\n2: Methods\n'));
  // what models send: a JSON text of the scope, "4-5", start/end at the top level, include as text
  assert.strictEqual((await exec('read_document', { scope: '{"start":4,"end":5}', include: '["text"]', doc: null })).content, 'Lines 4-5 of 11:\n4: Point one\n5: Sub point');
  assert.strictEqual((await exec('read_document', { scope: '4-5', include: 'text', doc: null })).content, 'Lines 4-5 of 11:\n4: Point one\n5: Sub point');
  assert.strictEqual((await exec('read_document', { start: 11, end: 11 })).content, 'Lines 11-11 of 11:\n11: Last');
  // errors
  let r = await exec('read_document', RD('everything'));
  assert.ok(!r._ok && r.content === 'Error: scope must be {"start":N,"end":M}, "outline" or "all" (got "everything").', r.content);
  r = await exec('read_document', RD({ start: 1, end: 2 }, ['bold']));
  assert.ok(!r._ok && r.content === 'Error: include may hold text, headings, lists, formatting and comments (got "bold").', r.content);
  r = await exec('read_document', RD({ start: 40, end: 50 }));
  assert.strictEqual(r.content, 'Error: the document has only 11 lines.');
  // the export has no formatting: the plain lines with a note
  const exported = { ...as, docFormat: 'markdown', model: null, docText: '# A\n- b', lines: null };
  assert.strictEqual(T.runReadingTool('read_document', RD('all', ['formatting']), exported),
    '[Formatting is shown only when the document is read through the Google Docs API; plain text below.]\nLines 1-2 of 2:\n1: # A\n2: - b');
});

test('limits: the provider\'s lines and characters per call, the continuation in read_document form', async () => {
  await fresh(docSpec({ items: Array.from({ length: 150 }, (_, i) => ({ p: `Line ${i + 1} ` + 'x'.repeat(40) })) }));
  const munin = T.readLimits({ readMaxChars: 8000, readMaxLines: 100 });
  const r = T.runReadingTool('read_document', RD('all'), as, munin);
  assert.ok(r.startsWith('Lines 1-100 of 150:\n') && r.endsWith('\n[Stopped at line 100 (limit per call). Call read_document with scope {"start":101,"end":150} to continue.]'), r.slice(-120));
  const small = T.runReadingTool('read_document', RD({ start: 1, end: 150 }, ['formatting']), as, { chars: 500, lines: 100 });
  const shown = Number(/Lines 1-(\d+) of 150/.exec(small)[1]);
  assert.ok(shown < 15 && /Call read_document with scope \{"start":\d+,"end":150\} to continue\.\]$/.test(small), small.slice(-100));
});

test('after the turn: a short stub; the action-log rows and the running line', async () => {
  await fresh(spec());
  const fn = (args) => ({ name: 'read_document', arguments: JSON.stringify(args) });
  assert.strictEqual(T.readingStub(fn(RD({ start: 40, end: 75 })), 'x'.repeat(500), 'after the turn'), '[read_document lines 40–75: content omitted after the turn; re-read if needed]');
  assert.strictEqual(T.readingStub(fn(RD('outline', null, 'doc2')), 'x', 'after the turn'), '[read_document outline (doc2): content omitted after the turn; re-read if needed]');
  assert.strictEqual(T.readingStub(fn(RD({ start: 1, end: 9 }, ['formatting'])), 'x', 'to fit the context window'), '[read_document lines 1–9 + formatting: content omitted to fit the context window; re-read if needed]');
  const entry = T.logEntry({ id: 'a', function: fn(RD({ start: 5, end: 7 })) }, null);
  deq([entry.name, entry.summary, entry.status], ['read_document', 'lines 5–7', 'pending']);
  assert.ok(T.isReadingTool({ function: fn(RD('all')) }) && !T.isEditTool('read_document'));
});

test('old_text copied with a heading label or a list marker still matches (the markers are stripped)', async () => {
  await fresh(spec());
  let r = await exec('replace_text', { old_text: '• Point one', new_text: 'Point zero' });
  assert.ok(r._ok, r.content);
  assert.ok(r.content.includes('Note: formatting markers/quotes were removed from old_text to find it'), r.content);
  assert.strictEqual(as.model.lines[3].text, 'Point zero');
  r = await exec('format_text', { old_text: '9 [H2]: Results', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null });
  assert.ok(r._ok, r.content);
  r = await exec('replace_text', { old_text: '  a. Detail', new_text: 'More detail' });
  assert.ok(r._ok && as.model.lines[6].text === 'More detail', r.content);
});

test('the reading tools of earlier versions: refused as unknown in a new turn (the current tools listed), rendered and stubbed in stored chats', async () => {
  await fresh(spec());
  for (const [name, args] of [['get_outline', { doc: null }], ['read_lines', { start: 1, end: 2, doc: null }], ['read_formatting', { start: 1, end: 2 }], ['read_comments', { status: 'open', lines: null }]]) {
    const r = await exec(name, args);
    assert.ok(!r._ok && r._message === 'Unknown tool: ' + name, name);
    assert.ok(r.content.startsWith(`Error: unknown tool "${name}". Available tools: read_document, find_in_document, get_selection, open_document, remember, replace_text,`), r.content);
    assert.ok(!T.toolsFor('edit', as).some((t) => t.function.name === name) && !T.toolsFor('manual', as).some((t) => t.function.name === name), name);
  }
  // stored calls: quiet rows with their old summaries, stubbed like before
  const old = (name, args) => ({ id: 'o', function: { name, arguments: JSON.stringify(args) } });
  deq(['get_outline', 'read_lines', 'read_formatting', 'read_comments'].map((n) => T.isReadingTool(old(n, {}))), [true, true, true, true]);
  assert.strictEqual(T.logEntry(old('read_lines', { start: 3, end: 9 }), { role: 'tool', content: 'x', _ok: true }).summary, 'lines 3–9');
  assert.strictEqual(T.logEntry(old('read_formatting', { start: 3, end: 3 }), null).summary, 'lines 3–3');
  assert.strictEqual(T.readingStub(old('read_lines', { start: 40, end: 75 }).function, 'x'.repeat(500), 'after the turn'), '[read_lines 40–75: content omitted after the turn; re-read if needed]');
  assert.strictEqual(T.readingStub(old('get_outline', { doc: null }).function, 'x', 'after the turn'), '[get_outline: content omitted after the turn; re-read if needed]');
  // a stored chat with them renders its rows (no card, a quiet log row each)
  state.messages = [
    { role: 'user', content: 'Read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'get_outline', arguments: '{"doc":null}' } }, { id: 'l1', type: 'function', function: { name: 'read_lines', arguments: '{"start":1,"end":3,"doc":null}' } }] },
    { role: 'tool', tool_call_id: 'g1', content: '[get_outline: content omitted after the turn; re-read if needed]', _ok: true, _reading: true, _omittedChars: 300 },
    { role: 'tool', tool_call_id: 'l1', content: '[read_lines 1–3: content omitted after the turn; re-read if needed]', _ok: true, _reading: true, _message: 'lines 1–3', _omittedChars: 300 },
    { role: 'assistant', content: 'Done reading.' },
  ];
  T.renderHistory();
  const log = T.actionLogFromToolCalls(state.messages[1].tool_calls, new Map(state.messages.slice(2, 4).map((m) => [m.tool_call_id, m])));
  deq(log.map((e) => [e.name, e.summary, e.status, e.omitted]), [['get_outline', '', 'ok', 300], ['read_lines', 'lines 1–3', 'ok', 300]]);
  state.messages = [];
});
