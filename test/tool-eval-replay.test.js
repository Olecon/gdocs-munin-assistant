'use strict';
// The replay of a bug bundle in the tool eval (test/lib/tool-eval.js runReplay; development/tools/tool-eval.js --replay):
// the fake Docs server built from a documents.get body (specFromBody renders the body back), a bundle the panel saved
// (src/chat-log.js buildBugBundle) replayed dry from the saved responses (same calls, the same document diff, the
// selection and mode restored), a saved call that fails on the current code, the saved cards (a denied edit), an expect
// in the bundle, the export path, the turn selector, why a turn is not replayed, the line diff and the text report.
// The bundles are synthetic, built here; a file goes to the system's temporary folder only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./lib/tool-eval');
const { load, installDocTab, installIdentity, deq } = require('./lib/sandbox');
const { fakeDocsServer, specFromBody, docSpec, docsBench } = require('./lib/fake-docs');
const { useProvider, send, muTool, muText } = require('./lib/context');
const { sseResponse } = require('./lib/streams');

const RICH = {
  documentId: 'DOCR', title: 'Rich',
  tabs: [{
    id: 't.0', title: 'Main', sectionStyle: { sectionType: 'CONTINUOUS', marginTop: { magnitude: 72, unit: 'PT' } },
    documentStyle: { marginLeft: { magnitude: 72, unit: 'PT' } }, lists: { 'kix.n1': 'NUMBERED_DECIMAL_ALPHA_ROMAN' },
    items: [
      { p: 'Title [^fn1] mark', style: 'TITLE', pstyle: { alignment: 'CENTER', spaceAbove: 6 } },
      { p: 'Bold, link, super and a deletion.', fmt: [[0, 4, { bold: true }], [0, 1, { italic: false }], [6, 10, { link: 'https://example.org' }], [12, 17, { script: 'super', size: 9, font: 'Georgia', weight: 700, color: '#FF0000', bg: '#00FF00' }], [24, 32, { _del: 'suggest.del' }]] },
      { p: 'First item', bullet: { listId: 'kix.n1', level: 0 } },
      { p: 'Nested item', bullet: { listId: 'kix.n1', level: 1 } },
      { p: 'Person ￼, date ￼, link ￼, break ￼.', objects: [[7, { person: { personProperties: { name: 'Ann', email: 'ann@example.org' } } }],
        [15, { dateElement: { dateElementProperties: { timestamp: '2026-11-12T00:00:00Z', displayText: 'Nov 12, 2026' } } }],
        [23, { richLink: { richLinkProperties: { uri: 'https://docs.google.com/document/d/X', title: 'X' } } }], [32, { pageBreak: {} }]] },
      { table: [[[{ p: 'H1' }], [{ p: 'H2' }]], [[{ p: 'a' }], [{ p: 'b' }]]], widths: [{ type: 'FIXED_WIDTH', pt: 100 }, { type: 'EVENLY_DISTRIBUTED' }],
        pinned: 1, spans: [[1, 0, 1, 2]], cellStyles: [[0, 1, { backgroundColor: { color: { rgbColor: { red: 1 } } } }]] },
      { section: { sectionType: 'NEXT_PAGE' } },
      { toc: [{ p: 'Contents line' }] },
      { p: 'Inserted text', suggest: 'suggest.ins' },
      { p: 'Last ￼ image', objects: [[5, { image: { id: 'kix.im', title: 'T', description: 'D', width: 50, height: 20 } }]] },
    ],
    headers: { 'kix.h1': [{ p: 'Header text' }] }, footers: { 'kix.f1': [{ p: 'Footer' }] }, footnotes: { fn1: [{ p: ' Footnote body' }] },
  }, { id: 't.2', title: 'Second', items: [{ p: 'Other tab' }] }],
};

test('specFromBody: the fake server built from a documents.get body renders that body again (text, styles, lists, tables, sections, segments, chips, images, suggestions, tabs)', () => {
  for (const spec of [docSpec(), RICH]) {
    const body = fakeDocsServer(spec).render(true);
    const again = fakeDocsServer(specFromBody(body)).render(true);
    assert.deepStrictEqual(again, body, spec.documentId);
  }
  // a literal "[^x]" in the text stays text; the document id can be replaced; child tabs are flattened
  const body = fakeDocsServer({ documentId: 'D', title: 'T', tabs: [{ id: 't.0', title: 'A', items: [{ p: 'x' }] }] }).render(true);
  body.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content = 'see [^x]\n';
  body.tabs[0].documentTab.body.content[1].endIndex = 10;
  body.tabs[0].childTabs = [{ tabProperties: { tabId: 't.c', title: 'Child' }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }, { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 3, textRun: { content: 'c\n', textStyle: {} } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } }] } } }];
  const srv = fakeDocsServer(specFromBody(body, { documentId: 'DOC123' }));
  deq([srv.documentId, srv.text('t.0'), srv.tabs.map((t) => t.id), srv.text('t.c')], ['DOC123', 'see [^x]', ['t.0', 't.c'], 'c']);
});

// Two Munin turns on the Docs API in a panel sandbox (the second with a selection: replace_text, then an answer), and the
// bundle the panel builds of them.
async function savedBundle() {
  const env = await load();
  const { T, state } = env;
  const ident = installIdentity(env);
  const ref = {};
  installDocTab(env);
  const { routeDocs } = docsBench(env, ident, ref);
  ref.fake = fakeDocsServer({ documentId: 'DOC123', title: 'Replay Doc', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Notes', style: 'HEADING_1' }, { p: 'Teh first line.' }, { p: 'The second line.' }] }] });
  ref.fake.token = ident.token = 'tok-1'; ident.granted = true; ident.forget();
  useProvider(env, 'munin', { apiKey: 'k-REPLAY-SECRET' });
  state.googleConnected = true;
  let selection = '';
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: selection } : { ok: true, title: 'Replay Doc' });
  await T.refreshContext({ force: true });
  await T.createChat();
  const rounds = [muText('Hello.'), muTool('c1', 'replace_text', { old_text: 'Teh', new_text: 'The' }), muText('Fixed.')];
  let n = 0;
  env.ctx.fetch = routeDocs(async () => sseResponse(rounds[n++]));
  await send(env, 'Hi.');
  selection = 'Teh first line.';
  await send(env, 'Fix the typo in the selection.');
  assert.strictEqual(n, 3);
  assert.strictEqual(ref.fake.text('t.0'), 'Notes\nThe first line.\nThe second line.');
  const b = T.buildBugBundle(state.messages, { title: 'Typo' }, T.turnRequestsOf('DOC123', state.chatId), { secrets: await T.bundleSecrets() });
  return JSON.parse(JSON.stringify(b));
}

test('a bundle the panel saved replays dry: the saved calls again, the same document diff, the selection and mode restored, the saved side beside it', async () => {
  const bundle = await savedBundle();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-bundle-')), 'munin-bug-typo.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  const b = E.loadBundle(file);
  fs.rmSync(path.dirname(file), { recursive: true });
  deq(E.bundleTurnIndices(b, ''), [1]);
  const r = await E.runReplay(b, E.bundleTurnIndices(b, 'all'), { provider: 'munin', dry: true });
  deq(r.turns.map((t) => [t.turn, t.document, t.mode, t.runs.length]), [[1, 'docs-api', 'edit', 1], [2, 'docs-api', 'edit', 1]]);
  const [one, two] = r.turns;
  deq([one.runs[0].calls, one.runs[0].answer, one.runs[0].diff], [[], 'Hello.', []]);
  const run = two.runs[0];
  deq(run.calls.map((c) => [c.name, c.args, c.status]), [['replace_text', { old_text: 'Teh', new_text: 'The' }, 'ok']]);
  assert.match(run.calls[0].result, /\S/);
  deq([run.answer, run.outcome, run.diff], ['Fixed.', 'done', ['- L2: Teh first line.', '+ L2: The first line.']]);
  deq([run.metrics.calls, run.metrics.failed, run.metrics.rounds], [1, 0, 2]);
  assert.ok(run.tokens > 0 && r.tokens === one.runs[0].tokens + run.tokens);
  // the saved side: the same call and answer, its provider
  deq([two.saved.providerType, two.saved.calls.map((c) => [c.name, c.status]), two.saved.answer, two.saved.metrics.rounds], ['munin', [['replace_text', 'ok']], 'Fixed.', 2]);
  assert.strictEqual(two.selection, 'Teh first line.');
  // the replayed message saw the selection in its turn context
  const c = E.replayCase(b, 1);
  deq([c.mode, c.docsApi, c.selection, c.prompts, c.replay.messages.length], ['auto', true, 'Teh first line.', ['Fix the typo in the selection.'], 2]);
  const once = await E.runOnce(c, c.prompts[0], { provider: 'munin', dry: true });
  assert.match(once.turns[0].messages[0]._context, /Selection: line 2\b/);
  // the text report: the calls side by side with the saved chat's (same provider), else the saved trajectory in a line
  const text = E.replayText(two, { provider: 'munin' });
  assert.match(text, /^Turn 2 · auto · Docs API \(tab t\.0\) · selection 1 line: «Fix the typo in the selection\.»\n/);
  assert.match(text, /\n {4}1 {3}replace_text\(\{"old_text":"Teh","new_text":"The"\}\) +\| replace_text\(\{"old_text":"Teh","new_text":"The"\}\)\n/);
  assert.match(text, /\n {4}document diff:\n {6}- L2: Teh first line\.\n {6}\+ L2: The first line\.$/);
  const other = E.replayText(two, { provider: 'openai' });
  assert.ok(other.includes('\n    saved chat (munin): replace_text\n') && !other.includes(' | '), other);
});

test('a saved call that fails on this code shows as failed; a denied edit card is denied again; the bundle\'s expect is checked', async () => {
  const lines = ['Notes', ...Array.from({ length: 30 }, (_, i) => `Line ${i + 2}.`)];
  const body = fakeDocsServer({ documentId: 'X', title: 'T', tabs: [{ id: 't.0', title: 'Main', items: lines.map((p) => ({ p })) }] }).render(true);
  const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const bundle = {
    kind: 'munin-bug-bundle', version: 1, chat: { title: 'Gate' }, systems: ['S'], documents: [{ format: 'docs-api', tabId: 't.0', body }],
    messages: [
      { role: 'user', content: 'Fix "Lnie 3".', _mode: 'edit' },
      call('a1', 'replace_text', { old_text: 'Lnie 3', new_text: 'Line 3' }),
      { role: 'tool', tool_call_id: 'a1', content: 'Replaced on line 2.', _ok: true },
      { role: 'assistant', content: 'Fixed.' },
      { role: 'user', content: 'Delete lines 2 to 31.', _mode: 'edit', _asks: true }, // sent in Manual: the delete asked
      call('b0', 'read_document', { scope: { start: 2, end: 31 }, include: ['text'], doc: null }),
      { role: 'tool', tool_call_id: 'b0', content: '2: Line 2.', _ok: true },
      call('b1', 'delete_lines', { start: 2, end: 31 }),
      { role: 'tool', tool_call_id: 'b1', content: 'Refused: the user did not allow this edit.', _ok: false, _decision: 'rejected', _answered: [{ kind: 'edit', tool: 'delete_lines', decision: 'reject' }] },
      { role: 'assistant', content: 'Not deleted.' },
    ],
    turns: [{ message: 0, kept: true, providerType: 'munin', system: 0, tools: [], mode: 'edit', selection: { text: '', lines: null }, document: 0 },
      { message: 4, kept: true, providerType: 'munin', system: 0, tools: [], mode: 'manual', selection: { text: '', lines: null }, document: 0, expect: { forbid: ['delete_lines'] } }],
  };
  // the first turn's saved call succeeded on the saved document; here its text is not in the document: it fails now
  const r = await E.runReplay(bundle, [0, 1], { provider: 'munin', dry: true });
  const [fails, gate] = r.turns;
  deq([fails.saved.calls[0].status, fails.runs[0].calls[0].status, fails.runs[0].metrics.failed, fails.runs[0].diff], ['ok', 'failed', 1, []]);
  assert.ok(!('pass' in fails.runs[0])); // no expect: nothing to check
  // the saved Deny answers the gate card again: the call is refused, the document unchanged; the expect fails on it
  deq(E.savedCards(E.bundleTurnMessages(bundle, 1)), { edit: ['deny'] });
  const g = gate.runs[0];
  deq([g.calls.map((x) => [x.name, x.status]), g.cards.map((x) => [x.kind, x.decision]), g.diff, g.pass, g.failures],
    [[['read_document', 'ok'], ['delete_lines', 'refused']], [['edit', 'reject']], [], false, ['called delete_lines (forbidden: delete_lines)']]);
  assert.match(E.replayText(gate, { provider: 'munin' }), /delete_lines\(\{"start":2,"end":31\}\) REFUSED +\| delete_lines\(\{"start":2,"end":31\}\) REFUSED/);
  // without the saved answer the eval's default allows it: 30 lines go
  const c = E.replayCase(bundle, 1);
  c.cards = {};
  const run = await E.runOnce(c, c.prompts[0], { provider: 'munin', dry: true });
  deq([run.turns[0].calls.map((x) => x.ok), E.lineDiff(run.startText, run.finalText).length], [[true, true], 30]);
});

test('the export path: the saved text on the fake tab; the saved answers of ask cards; why a turn is not replayed; the turn selector', async () => {
  const bundle = {
    kind: 'munin-bug-bundle', version: 1, chat: { title: 'Export' }, systems: ['S'], documents: [{ format: 'markdown', text: '# Notes\n\nTeh first line.' }],
    messages: [
      { role: 'user', content: 'Older.' }, { role: 'assistant', content: 'Old answer.' },
      { role: 'user', content: 'What is on line 3?', _mode: 'manual' }, { role: 'assistant', content: 'Line 3 says "Teh first line."' },
      { role: 'user', content: 'Report', _auto: true, _agentReport: { id: 'a1' }, _context: 'C' }, { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'Dropped.' }, { role: 'assistant', content: 'x' },
    ],
    turns: [{ message: 0, kept: false, note: 'Not kept' }, { message: 2, kept: true, providerType: 'openai', system: 0, tools: [], mode: 'manual', document: 0 },
      { message: 4, kept: true, system: 0, tools: [], document: 0 }, { message: 6, kept: true, system: 0, tools: [], document: null, documentNote: 'No longer in memory (…).' }],
  };
  deq([0, 1, 2, 3].map((n) => E.unreplayable(bundle, n)), ['not kept by the panel (its document and start are unknown)', '',
    'an agents\' report turn (the panel sends it, not the user)', 'No longer in memory (…).']);
  const r = await E.runReplay(bundle, [1, 3], { provider: 'munin', dry: true });
  deq([r.turns[0].document, r.turns[0].mode, r.turns[0].runs[0].answer, r.turns[0].runs[0].diff], ['markdown', 'manual', 'Line 3 says "Teh first line."', []]);
  deq([r.turns[1].skipped, r.turns[1].runs], ['No longer in memory (…).', []]);
  assert.match(E.replayText(r.turns[1]), /\n {2}not replayed: No longer in memory/);
  deq([E.replayCase(bundle, 1).docsApi, E.replayCase(bundle, 1).replay.exportText], [false, '# Notes\n\nTeh first line.']);
  // ask cards: the saved answers (one question, several), a stopped one left to the default
  deq(E.savedCards([{ role: 'tool', _answered: [{ kind: 'ask', decision: 'option', choice: 'Yes' }, { kind: 'ask', decision: 'option', questions: [{ answer: 'A' }, { answer: '' }] },
    { kind: 'ask', decision: 'stop' }, { kind: 'open', decision: 'accept' }, { kind: 'access', decision: 'refused' }, { kind: 'edit', decision: 'accept-all' }] }]),
  { ask: ['answers:["Yes"]', 'answers:["A",""]'], open: ['allow'], access: ['not-now'], edit: ['allow-all'] });
  // the selector: 1-based, a range, all; the default is the last turn
  deq([E.bundleTurnIndices(bundle, '2'), E.bundleTurnIndices(bundle, '2-3'), E.bundleTurnIndices(bundle, 'all'), E.bundleTurnIndices(bundle, null)], [[1], [1, 2], [0, 1, 2, 3], [3]]);
  for (const bad of ['0', '5', '3-2', 'x']) assert.throws(() => E.bundleTurnIndices(bundle, bad), /No turn .*: the bundle has turns 1-4\./);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-bundle-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ kind: 'other' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...bundle, version: 2 }));
  assert.throws(() => E.loadBundle(path.join(dir, 'a.json')), /not a bug bundle/);
  assert.throws(() => E.loadBundle(path.join(dir, 'b.json')), /bundle version 2; this checkout reads version 1/);
  fs.rmSync(dir, { recursive: true });
});

test('lineDiff: the changed lines with their numbers before and after', () => {
  deq(E.lineDiff('a\nb\nc', 'a\nb\nc'), []);
  deq(E.lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne'), ['- L2: b', '+ L2: B', '+ L5: e']);
  deq(E.lineDiff('x\ny', 'y'), ['- L1: x']);
  deq(E.lineDiff('', 'new'), ['- L1: ', '+ L1: new']);
});
