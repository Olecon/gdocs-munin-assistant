'use strict';
// Tools mode: outline and selection in the prompt, the reading tools, long selections, the Markdown export cleanup.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { fakeDocsServer } = require('./lib/fake-docs');

let env, T, D, state, PROVIDERS, LONG_LINES, LONG_SEL, LONG_TOOLS_TAIL, LONG_PERSONA_TAIL, savedDoc;
// The selection line ends the turn context of the user message (buildTurnContext): its position and size only.
const selTail = (snap) => { const c = T.buildTurnContext('edit', snap); return c.slice(c.lastIndexOf('\n') + 1); };
// A Munin persona turn (no reading tools): the selection follows the document excerpt in the system prompt.
const personaTail = (snap) => T.buildSystemParts('chat', 100000, { ...snap, prov: PROVIDERS.munin }).tail;

before(async () => {
  env = await load();
  T = D = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  // the sample document of the request checks (providers.test.js)
  state.docTitle = 'Doc <1>'; state.docError = '';
});

test('tools mode: outline, selection location, reading tools', async () => {
  // --- tools mode: outline, selection location, reading tools, tool sets
  state.docFormat = 'markdown';
  state.docText = ['# Title', '', 'Intro with **bold** words.', '', '## Methods', '', '```', '# not a heading', '```', '', 'The quick brown fox jumps.', 'Second paragraph here.', '', '### Details', '', 'Last line'].join('\n');
  state.selection = 'quick brown fox jumps.\nSecond paragraph';
  state.settings.provider = 'anthropic'; // a provider with client tools (Munin persona turns have none, tested below)
  let ts = T.takeSnapshot(); T.snapshotDocument(ts);
  deq(T.docOutline(ts), [{ line: 1, level: 1, title: 'Title' }, { line: 5, level: 2, title: 'Methods' }, { line: 14, level: 3, title: 'Details' }]);
  deq(T.locateSelection(ts), { start: 11, end: 12 });
  ts.selection = 'bold words'; deq(T.locateSelection(ts), { start: 3, end: 3 }); // markup ignored
  ts.selection = 'nowhere to be found'; assert.strictEqual(T.locateSelection(ts), null);
  ts.selection = 'quick brown fox jumps.\nSecond paragraph';
  deq(T.toolsFor('edit', ts).map((t) => t.function.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'replace_selection', 'ask_user']);
  deq(T.toolsFor('manual', ts).map((t) => t.function.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user']);
  deq(T.toolsFor('research', ts).map((t) => t.function.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user']);
  const tsMunin = { ...ts, prov: PROVIDERS.munin };
  deq(T.toolsFor('research', tsMunin), []); // Munin persona pipeline: no client tools
  assert.ok(/3 headings \(16 lines in total\):\nL1: # Title\nL5: ## Methods\nL14: ### Details/.test(T.runReadingTool('get_outline', {}, ts)));
  assert.strictEqual(T.runReadingTool('read_lines', { start: 11, end: 12 }, ts), 'Lines 11-12 of 16:\n11: The quick brown fox jumps.\n12: Second paragraph here.');
  assert.strictEqual(T.runReadingTool('read_lines', { start: 15, end: 99 }, ts), 'Lines 15-16 of 16:\n15: \n16: Last line');
  assert.ok(/^Error: the document has only 16 lines/.test(T.runReadingTool('read_lines', { start: 40, end: 50 }, ts)));
  assert.strictEqual(T.runReadingTool('read_lines', { start: 'x', end: 'y' }, ts), 'Lines 1-1 of 16:\n1: # Title');
  assert.strictEqual(T.runReadingTool('find_in_document', { query: 'PARAGRAPH' }, ts), '1 line contains "PARAGRAPH":\n12: Second paragraph here.');
  assert.strictEqual(T.runReadingTool('find_in_document', { query: 'zzz' }, ts), 'No line contains "zzz".');
  assert.ok(/^Selection \(lines 11-12, 39 characters\):\nquick brown fox jumps\.\nSecond paragraph$/.test(T.runReadingTool('get_selection', {}, ts)));
  const big = { ...ts, docText: Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'), lines: null, selection: '' };
  const r400 = T.runReadingTool('read_lines', { start: 1, end: 400 }, big);
  assert.ok(r400.startsWith('Lines 1-300 of 400:\n1: line 1\n') && /\n300: line 300\n\[Stopped at line 300 \(limit per call\)\. Call read_lines\(301, 400\) to continue\.\]$/.test(r400));
  const plain = { ...ts, docFormat: 'text' };
  assert.ok(/outline is unavailable/.test(T.runReadingTool('get_outline', {}, plain)));
  // executeTool: reading works in every mode, replacing only in Auto
  let tr = await T.executeTool({ id: 't1', function: { name: 'read_lines', arguments: '{"start":1,"end":1}' } }, 'manual', ts);
  assert.ok(tr._reading && tr._ok && tr.content === 'Lines 1-1 of 16:\n1: # Title' && tr._message === 'lines 1–1');
  tr = await T.executeTool({ id: 't2', function: { name: 'replace_selection', arguments: '{"text":"x"}' } }, 'manual', ts);
  assert.ok(!tr._ok && /cannot be modified in this mode/.test(tr.content));
  tr = await T.executeTool({ id: 't3', function: { name: 'nope', arguments: '{}' } }, 'edit', ts);
  assert.ok(!tr._ok && /Available tools: get_outline, read_lines, find_in_document, get_selection, open_document, remember, replace_selection/.test(tr.content));
  // Action log entries (every tool call; without results the calls are still pending)
  deq(T.actionLogFromToolCalls([{ id: 'a', function: { name: 'read_lines', arguments: '{"start":5,"end":7}' } }, { id: 'b', function: { name: 'replace_selection', arguments: '{"text":"x"}' } }, { id: 'c', function: { name: 'find_in_document', arguments: '{"query":"fox"}' } }]), [
    { log: true, name: 'read_lines', summary: 'lines 5–7', args: { start: 5, end: 7 }, result: null, status: 'pending' },
    { log: true, name: 'replace_selection', summary: '"x"', args: { text: 'x' }, result: null, status: 'pending' },
    { log: true, name: 'find_in_document', summary: '"fox"', args: { query: 'fox' }, result: null, status: 'pending' },
  ]);
  // Prompt in tools mode: outline + selection with its line range, no document text
  let treq = T.buildRequest('edit', ts);
  // feat/context: the system prompt is static; the outline and the selection are the turn context
  assert.ok(treq.body.system[0].text.includes('The document text is NOT included in the messages'));
  const tctx = T.buildTurnContext('edit', ts);
  assert.ok(tctx.includes('<document title="Doc &lt;1&gt;" format="markdown" lines="16" characters="'));
  assert.ok(tctx.includes('Outline (line: heading):\nL1: # Title\nL5: ## Methods\nL14: ### Details'));
  assert.ok(!treq.body.system[0].text.includes('quick brown fox jumps') && !treq.body.system[0].text.includes('Outline (line: heading)'));
  assert.ok(tctx.endsWith('\nSelection: lines 11–12 (39 characters)') && !tctx.includes('quick brown fox jumps.'), tctx);
  assert.strictEqual(treq.body.tools.length, 8); // + open_document (Phase C1), remember, ask_user
  treq = T.buildRequest('manual', ts);
  assert.ok(treq.body.system[0].text.includes('You CANNOT modify the document: there is no replace_selection tool'));
  assert.strictEqual(treq.body.tools.length, 7); // + open_document (Phase C1), remember, ask_user
  treq = T.buildRequest('code', ts);
  assert.ok(treq.body.system[0].text.includes('Act as a coding assistant') && treq.body.system[0].text.includes('read it with the tools'));
});

test('selection in the turn context: line range and size only; Munin persona turns: the text, or position and excerpt', async () => {
  // --- tools mode: the line range and size, never the text; Munin persona turns (no tools): position + excerpt over 600 characters
  const S3 = 'the selected part begins here' + ' c3'.repeat(100); // 329 characters
  const mid = (k) => `Line ${k}:` + ' word'.repeat(70); // 357 characters
  const E8 = 'm8' + ' m8'.repeat(49) + ' end of selection'; // 166 characters
  LONG_LINES = ['Title', 'Intro paragraph.', 'Lead-in words, then ' + S3, mid(4), mid(5), mid(6), mid(7), E8 + ' trailing words after it.', 'After the selection.'];
  LONG_SEL = [S3, mid(4), mid(5), mid(6), mid(7), E8].join('\n');
  assert.strictEqual(LONG_SEL.length, 1928); // 329 + 4 * 357 + 166 + 5 newlines
  // the first and last 150 characters (newlines as spaces): 29 + 40 * 3 + a space (trimmed); a "8" + 44 * 3 + 17
  const LONG_EXCERPT = 'Begins: "the selected part begins here' + ' c3'.repeat(40) + '…"\nEnds: "…8' + ' m8'.repeat(44) + ' end of selection"';
  LONG_TOOLS_TAIL = 'Selection: lines 3–8 (1,928 characters)';
  // Munin persona turns (no reading tools): position plus excerpt, the text being lines 3-8 of the excerpt
  LONG_PERSONA_TAIL = 'Current selection in the document:\n' +
    '<selection lines="3-8" characters="1928" start="line 3, character 21" end="line 8, character 166">\n' +
    '[Long selection: only its position is given; its text is lines 3-8 of the <document> above.]\n' + LONG_EXCERPT + '\n</selection>';
  savedDoc = { docFormat: state.docFormat, docText: state.docText, selection: state.selection };
  const longSnap = (docText, selection) => {
    Object.assign(state, { docFormat: 'markdown', docText, selection });
    const s = T.takeSnapshot(); T.snapshotDocument(s); return s;
  };
  let ls = longSnap(LONG_LINES.join('\n'), LONG_SEL);
  deq(T.selectionSpan(ls), { start: 3, end: 8, startChar: 21, endChar: 166, approx: false });
  deq(T.locateSelection(ls), { start: 3, end: 8 });
  let lreq = T.buildRequest('edit', ls);
  assert.strictEqual(selTail(ls), LONG_TOOLS_TAIL);
  assert.strictEqual(personaTail(ls), LONG_PERSONA_TAIL);
  assert.ok(!lreq.body.system[0].text.includes('word word') && !T.buildTurnContext('edit', ls).includes('c3 c3'));
  assert.strictEqual(T.buildTurnContext('chat', { ...ls, prov: PROVIDERS.munin }), ''); // persona turns: no turn context
  assert.strictEqual(T.runReadingTool('get_selection', {}, ls), 'Selection (lines 3-8, 1,928 characters):\n' + LONG_SEL); // full text
  ls.selection = 'changed during the turn'; // the prompt keeps the selection from the start of the turn
  assert.strictEqual(selTail(ls), LONG_TOOLS_TAIL);
  // a short selection inside a line: offsets by hand ("Lead-in words, then the selected " = 33 characters)
  ls = longSnap(LONG_LINES.join('\n'), 'part begins');
  deq(T.selectionSpan(ls), { start: 3, end: 3, startChar: 34, endChar: 44, approx: false });
  // Markdown markup in the first line: the position is approximate (the "**" moves the start by 2)
  const MD_LINES = LONG_LINES.slice(); MD_LINES[2] = 'Lead-in words, then **the selected** part begins here' + ' c3'.repeat(100);
  ls = longSnap(MD_LINES.join('\n'), LONG_SEL);
  deq(T.selectionSpan(ls), { start: 3, end: 8, startChar: 23, endChar: 166, approx: true });
  assert.strictEqual(selTail(ls), 'Selection: lines 3–8 (1,928 characters; position approximate)');
  assert.strictEqual(personaTail(ls), 'Current selection in the document:\n' +
    '<selection lines="3-8" characters="1928" start="line 3, character 23" end="line 8, character 166">\n' +
    '[Long selection: only its position is given; its text is lines 3-8 of the <document> above. The position is approximate: the selection was matched ignoring formatting.]\n' +
    LONG_EXCERPT + '\n</selection>');
  // a 200-character selection: one line, no text; a persona turn gets the text
  const SHORT_SEL = mid(4).slice(0, 200);
  ls = longSnap(LONG_LINES.join('\n'), SHORT_SEL);
  assert.strictEqual(selTail(ls), 'Selection: line 4 (200 characters)');
  assert.strictEqual(personaTail(ls), `Current selection in the document:\n<selection>\n${SHORT_SEL}\n</selection>`);
  ls = longSnap(LONG_LINES.join('\n'), 'x');
  assert.strictEqual(selTail(ls), 'Selection: 1 character; its position in the document was not found (read it with get_selection).');
  ls = longSnap(LONG_LINES.join('\n'), '');
  assert.ok(T.buildTurnContext('edit', ls).endsWith('\nCurrent selection in the document:\n<selection>[Nothing is selected. replace_selection would insert text at the cursor position.]</selection>'));
  // a long selection that is not in the document: its size only; a persona turn gets it shortened to 4,000 characters
  const LOST_SEL = 'Unfound text. '.repeat(400); // 5,600 characters
  ls = longSnap(LONG_LINES.join('\n'), LOST_SEL);
  assert.strictEqual(T.selectionSpan(ls), null);
  assert.strictEqual(selTail(ls), 'Selection: 5,600 characters; its position in the document was not found (read it with get_selection).');
  assert.strictEqual(personaTail(ls), 'Current selection in the document:\n<selection>\n' + LOST_SEL.slice(0, 4000) +
    '\n[... shortened: 5,600 characters in total]\n</selection>');
  Object.assign(state, savedDoc);
});

test('unescapeDocsMarkdown', async () => {
  // --- Docs Markdown export escapes
  assert.strictEqual(T.unescapeDocsMarkdown('3\\. Fitting \\- a \\[link\\](u) p\\* x\\_y 5 \\> 4 \\# keep \\\\ and \\` keep'),
    '3. Fitting - a [link](u) p* x_y 5 > 4 \\# keep \\\\ and \\` keep');
});

test('long selection with the Docs API: line range in the turn context, full text through get_selection', async () => {
  // --- long selection on a document read through the Docs API: tools mode and numbered full mode (Auto)
  const longModel = D.buildLineModel(fakeDocsServer({ documentId: 'DOCL', title: 'Long', tabs: [{ id: 't.0', title: 'Main',
    items: LONG_LINES.map((p, i) => (i ? { p } : { p, style: 'TITLE' })) }] }).render(true), null, 'DOCL');
  deq(longModel.lines.map((l) => l.text), LONG_LINES);
  state.settings.provider = 'anthropic';
  Object.assign(state, { docModel: longModel, docText: longModel.text, docFormat: 'docs-api', docTitle: 'Long', docError: '', selection: LONG_SEL });
  let lsApi = T.takeSnapshot(); T.snapshotDocument(lsApi);
  let apiReq = T.buildRequest('edit', lsApi);
  assert.strictEqual(selTail(lsApi), LONG_TOOLS_TAIL); assert.strictEqual(apiReq.body.system.length, 1);
  assert.strictEqual(T.runReadingTool('get_selection', {}, lsApi), 'Selection (lines 3-8, 1,928 characters):\n' + LONG_SEL);
  Object.assign(state, savedDoc, { docModel: null });
});

test('ambiguous selection: no line numbers when the selected text occurs in several places', async () => {
  state.settings.provider = 'anthropic';
  const snapOf = (docText, selection) => {
    Object.assign(state, { docFormat: 'text', docText, selection, docModel: null });
    const s = T.takeSnapshot(); T.snapshotDocument(s); return s;
  };
  // the same sentence on lines 2 and 4
  let s = snapOf(['Title', 'See the results below.', 'Middle', 'See the results below.', 'End'].join('\n'), 'the results');
  deq(T.selectionSpan(s), { start: 2, end: 2, startChar: 5, endChar: 15, approx: false, occurrences: 2 });
  assert.strictEqual(T.locateSelection(s), null);
  assert.strictEqual(selTail(s), 'Selection: 11 characters; the selected text occurs in 2 places in the document, so which one is selected is not known. ' +
    'Read it with get_selection and locate the right occurrence with find_in_document before editing near it; replace_selection replaces exactly what the user selected.');
  assert.strictEqual(T.runReadingTool('get_selection', {}, s), 'Selection (position in the document not found, 11 characters):\nthe results');
  // repeats within one line keep its line number
  s = snapOf(['Title', 'one two one two', 'End'].join('\n'), 'one');
  assert.strictEqual(T.selectionSpan(s).occurrences, undefined);
  assert.strictEqual(selTail(s), 'Selection: line 2 (3 characters)');
  // multi-line: only where all selected lines follow each other
  const lines = ['Title', 'Alpha line here', 'Beta line here', 'Gap', 'Alpha line here', 'Other', 'Alpha line here', 'Beta line here'];
  s = snapOf(lines.join('\n'), 'Alpha line here\nBeta line here');
  assert.strictEqual(T.selectionSpan(s).occurrences, 2);
  s = snapOf(lines.join('\n'), 'line here\nGap');
  assert.strictEqual(T.selectionSpan(s).occurrences, undefined);
  assert.strictEqual(selTail(s), 'Selection: lines 3–4 (13 characters)');
  // a long ambiguous selection: no line numbers either
  const para = 'Repeated paragraph ' + 'text '.repeat(150); // 769 characters
  s = snapOf(['Title', para, 'Middle', para].join('\n'), para.trim());
  assert.ok(selTail(s).startsWith('Selection: 768 characters; the selected text occurs in 2 places'), selTail(s));
});

test('read limits per provider: Munin 8,000 characters / 100 lines, OpenAI and Anthropic 24,000 / 300; generic tool descriptions', async () => {
  // feat/context
  deq([T.readLimits(PROVIDERS.munin), T.readLimits(PROVIDERS.openai), T.readLimits(PROVIDERS.anthropic), T.readLimits(null)],
    [{ chars: 8000, lines: 100 }, { chars: 24000, lines: 300 }, { chars: 24000, lines: 300 }, { chars: 24000, lines: 300 }]);
  Object.assign(state, { docFormat: 'markdown', docText: Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'), selection: '' });
  const snapOf = (prov) => { state.settings.provider = prov; const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
  // lines cap
  const mu = T.runReadingTool('read_lines', { start: 1, end: 400 }, snapOf('munin'));
  assert.ok(mu.startsWith('Lines 1-100 of 400:\n') && mu.endsWith('\n100: line 100\n[Stopped at line 100 (limit per call). Call read_lines(101, 400) to continue.]'));
  assert.ok(T.runReadingTool('read_lines', { start: 1, end: 400 }, snapOf('anthropic')).startsWith('Lines 1-300 of 400:\n'));
  // characters cap: 80-character lines, 8,000 characters reached before 100 lines
  state.docText = Array.from({ length: 200 }, (_, i) => `${i + 1} `.padEnd(80, 'x')).join('\n');
  const mc = T.runReadingTool('read_lines', { start: 1, end: 200 }, snapOf('munin'));
  const last = Number(/Lines 1-(\d+) of 200/.exec(mc)[1]);
  assert.ok(last < 100 && mc.length < 8000 + 200, `stopped at ${last}`);
  assert.ok(T.runReadingTool('read_lines', { start: 1, end: 200 }, snapOf('openai')).startsWith('Lines 1-200 of 200:\n'));
  // explicit limits (the turn passes its provider's; an opened document's view has no provider)
  assert.ok(T.runReadingTool('read_lines', { start: 1, end: 200 }, { docText: state.docText, docFormat: 'text', lines: null }, { chars: 24000, lines: 10 }).startsWith('Lines 1-10 of 200:\n'));
  assert.ok(T.runReadingTool('read_lines', { start: 1, end: 200 }, { docText: state.docText, docFormat: 'text', lines: null }).startsWith('Lines 1-200 of 200:\n'));
  // executeTool uses the turn's provider
  const tr = await T.executeTool({ id: 'm1', function: { name: 'read_lines', arguments: '{"start":1,"end":400,"doc":null}' } }, 'edit', snapOf('munin'));
  assert.ok(/^Lines 1-\d+ of 200:/.test(tr.content) && /\(limit per call\)/.test(tr.content));
  // the tool description is the same for every provider; the instructions state the provider's limits
  assert.ok(!T.TOOL_DEFS.read_lines.function.description.includes('300') && T.TOOL_DEFS.read_lines.function.description.includes('limited number of lines and characters'));
  assert.ok(T.buildRequest('edit', snapOf('munin')).body.messages[0].content.includes('read_lines returns at most 100 lines or about 8,000 characters per call'));
  assert.ok(T.buildRequest('edit', snapOf('anthropic')).body.system[0].text.includes('read_lines returns at most 300 lines or about 24,000 characters per call'));
  Object.assign(state, savedDoc, { docModel: null });
});

test('selection rules: read the selection with get_selection or read_lines; a long one section by section with replace_text', async () => {
  const RULE = "The user's selection is given as a line range and size; read it with get_selection (all of it) or read_lines (parts).";
  Object.assign(state, { docFormat: 'markdown', docText: '# T\n\nBody', selection: 'Body', docModel: null });
  state.settings.provider = 'anthropic';
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  for (const mode of ['edit', 'manual']) assert.ok(T.buildRequest(mode, s).body.system[0].text.includes(RULE), mode);
  assert.ok(T.TOOLS_PERSONA_NOTE.includes(RULE));
  assert.ok(T.TOOLS_EDIT_RULES.includes('Read the selection first (get_selection), then pass the COMPLETE new text for the whole selection'));
  assert.ok(T.apiEditRules().includes('For a long selection that spans several sections, work section by section: read a section, rewrite it with replace_text, then the next. Use replace_selection only to replace the whole selection at once'));
  assert.ok(!/copy/.test(T.TOOL_DEFS.get_selection.function.description));
  Object.assign(state, savedDoc, { docModel: null });
});
