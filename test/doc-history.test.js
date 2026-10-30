'use strict';
// document_changes (src/doc-history.js): the text baseline per document (saved at the end of every turn, promoted
// to "previous" once per panel), the line diff and its rendering, the docNote, the storage cleanup and a turn
// in which the model calls the tool.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { sharedStorage, tick } = require('./lib/shared-storage');
const { docBench, useProvider, send, recordFetch } = require('./lib/context');
const { msgStart, tu, stopTool, textRound } = require('./lib/streams');

const KEY = 'muninDocText:DOC123';
const AT = new Date(2026, 9, 22, 18, 40).getTime();
let T;
before(async () => { T = (await load()).T; });

const entry = (lines, extra = {}) => {
  const text = lines.join('\n');
  return { text, at: AT, format: 'text', tab: '', chars: text.length, lines: lines.length, ...extra };
};
const BASE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const changes = (a, b, opts) => T.renderDocChanges(entry(a), b.join('\n'), opts);
const head = (counts, now, was, more = '') =>
  `Changes since 2026-10-22 18:40 (end of the previous session): ${counts}; now ${now} lines (was ${was}).${more} ("- was N": old line N; "+ N": current line N.)`;

// A panel on the shared storage, showing DOC123 (Markdown export; doc.text is the document).
async function panel(store) {
  const env = await load();
  store.attach(env);
  const { doc } = docBench(env);
  env.doc = doc;
  await env.T.refreshContext({ force: true });
  await tick(5);
  return env;
}

test('diff: insert, delete, change, moved block, no change', () => {
  assert.strictEqual(changes(BASE, ['A', 'B', 'X', 'Y', 'C', 'D', 'E', 'F', 'G', 'H']),
    `${head('2 lines added', 10, 8)}\n… 2 unchanged lines …\n+ 3: X\n+ 4: Y\n… 6 unchanged lines …`);
  assert.strictEqual(changes(BASE, ['A', 'B', 'E', 'F', 'G', 'H']),
    `${head('2 lines removed', 6, 8)}\n… 2 unchanged lines …\n- was 3: C\n- was 4: D\n… 4 unchanged lines …`);
  assert.strictEqual(changes(BASE, ['A', 'B', 'C2', 'D', 'E', 'F', 'G', 'H']),
    `${head('1 line changed', 8, 8)}\n… 2 unchanged lines …\n- was 3: C\n+ 3: C2\n… 5 unchanged lines …`);
  // a moved block: added where it is now, removed where it was
  assert.strictEqual(changes(BASE, ['A', 'E', 'F', 'B', 'C', 'D', 'G', 'H']),
    `${head('2 lines added, 2 lines removed', 8, 8)}\n… 1 unchanged line …\n+ 2: E\n+ 3: F\n… 3 unchanged lines …\n- was 5: E\n- was 6: F\n… 2 unchanged lines …`);
  // removed at the very start and added at the very end
  assert.strictEqual(changes(BASE, ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']),
    `${head('1 line added, 1 line removed', 8, 8)}\n- was 1: A\n… 7 unchanged lines …\n+ 8: I`);
  assert.strictEqual(changes(BASE, BASE), 'No changes since the previous session (2026-10-22 18:40).');
  // from or to an empty document
  assert.ok(changes([''], ['One', 'Two']).includes('- was 1: \n+ 1: One\n+ 2: Two'));
});

test('lineDiff: an edit script that rebuilds the new text; a coarse block above the edit limit', () => {
  const a = 'the quick brown fox jumps over the lazy dog and runs away'.split(' ');
  const b = 'a quick red fox jumps over the dog and then runs far away'.split(' ');
  const { ops, coarse } = T.lineDiff(a, b);
  assert.strictEqual(coarse, false);
  deq(ops.filter((o) => o.t !== '-').map((o) => b[o.n - 1]), b);
  deq(ops.filter((o) => o.t !== '+').map((o) => a[o.o - 1]), a);
  assert.ok(ops.filter((o) => o.t === '=').every((o) => a[o.o - 1] === b[o.n - 1]));
  assert.strictEqual(ops.filter((o) => o.t !== '=').length, 7); // minimal: 12 + 13 words, 9 in common
  // more than 1000 removed plus added lines in the changed region: one block (common head and tail still matched)
  const x = ['top', ...Array.from({ length: 800 }, (_, i) => 'a' + i), 'end'];
  const y = ['top', ...Array.from({ length: 800 }, (_, i) => 'b' + i), 'end'];
  const big = T.lineDiff(x, y);
  assert.strictEqual(big.coarse, true);
  deq([big.ops.length, big.ops[0], big.ops[1].t, big.ops[800].t, big.ops[801].t, big.ops[1600], big.ops[1601]],
    [1602, { t: '=', o: 1, n: 1 }, '-', '-', '+', { t: '+', n: 801 }, { t: '=', o: 802, n: 802 }]);
  const text = T.renderDocChanges({ text: x.join('\n'), at: AT, format: 'text', tab: '', chars: 1, lines: 802 }, y.join('\n'));
  assert.ok(text.includes('Too many differences for a line-by-line comparison: everything between the first and the last difference is shown as one block.'));
  assert.ok(/\[Stopped inside the change at current lines 2-801 \(limit per call\)\. Read the current text with read_lines\(2, 801\), then call document_changes with lines "802-802"\.\]$/.test(text));
});

test('rendering: caps with a continuation range, the lines argument, long lines, soft breaks', () => {
  const big = Array.from({ length: 50 }, (_, i) => 'line ' + i);
  const every2 = big.map((l, i) => (i % 2 ? l + '!' : l));
  const capped = changes(big, every2, { limits: { lines: 10, chars: 1000 } });
  assert.ok(capped.startsWith(head('25 lines changed', 50, 50) + '\n… 1 unchanged line …\n- was 2: line 1\n+ 2: line 1!\n'));
  assert.ok(capped.endsWith('- was 10: line 9\n+ 10: line 9!\n[Stopped at current line 12 (limit per call). Call document_changes with lines "12-50" to continue.]'));
  // the characters limit stops too
  assert.ok(changes(big, every2, { limits: { lines: 300, chars: 40 } }).endsWith('+ 2: line 1!\n[Stopped at current line 4 (limit per call). Call document_changes with lines "4-50" to continue.]'));
  // lines "12-15": only the changes there; unchanged lines counted inside the range
  assert.strictEqual(changes(big, every2, { range: { start: 12, end: 15 } }),
    `${head('25 lines changed', 50, 50, ' Showing lines 12-15.')}\n- was 12: line 11\n+ 12: line 11!\n… 1 unchanged line …\n- was 14: line 13\n+ 14: line 13!\n… 1 unchanged line …`);
  assert.ok(changes(BASE, ['A2', ...BASE.slice(1)], { range: { start: 3, end: 8 } }).endsWith('\nNo changes in lines 3-8.'));
  // a one-word edit in a long paragraph: only the changed part with some context
  const long = 'word '.repeat(200).trim();
  const out = changes(['x', long], ['x', long.replace('word word word', 'word NEW word')]);
  assert.ok(out.endsWith('\n- was 2: word word word word word word word word word word word word word word…\n+ 2: word NEW word word word word word word word word word word word word…'), out);
  // a long added line is clipped with its size
  assert.ok(changes(['x'], ['x', 'y'.repeat(400)]).endsWith(`+ 2: ${'y'.repeat(300)}… (400 characters)`));
  // Docs API text: soft line breaks shown as in read_lines
  assert.ok(T.renderDocChanges(entry(['a'], { format: 'docs-api' }), 'a\nb\u000bc', { format: 'docs-api', api: true }).endsWith('+ 2: b⏎c'));
});

test('rendering: another reading format or tab, a baseline too large to store: sizes only', () => {
  const md = entry(['# T', 'x'], { format: 'markdown' });
  assert.strictEqual(T.renderDocChanges(md, 'T\nx\ny', { format: 'docs-api' }),
    'The previous session (2026-10-22 18:40) read the document through the export and this one through the Google Docs API; the texts differ in form, so only sizes are compared: 5 → 5 characters, 2 → 3 lines.');
  assert.ok(T.renderDocChanges(md, '# T\nx\ny', { format: 'text' }).includes('+ 3: y')); // both exports: compared
  assert.ok(/^The previous session \(2026-10-22 18:40\) read another tab of this document; only sizes are compared/.test(
    T.renderDocChanges(entry(['a'], { format: 'docs-api', tab: 't.0' }), 'a', { format: 'docs-api', tab: 't.1' })));
  assert.strictEqual(T.renderDocChanges({ at: AT, format: 'text', tab: '', chars: 3000000, lines: 9, tooLarge: true }, 'abc'),
    'The document was too large to store at the end of the previous session (2026-10-22 18:40), so only sizes are compared: 3,000,000 → 3 characters, 9 → 1 lines.');
});

test('baseline: finish saves latest; a new panel promotes it once; the same panel never again; the size cap', async () => {
  const store = sharedStorage();
  const A = await panel(store);
  assert.ok(!(KEY in store.items)); // nothing stored before a turn
  useProvider(A, 'anthropic', { model: 'claude-opus-5-5' });
  recordFetch(A, [textRound('OK.')]);
  A.doc.text = 'One\nTwo';
  await send(A, 'hi');
  await tick(5);
  const latestA = store.items[KEY].latest;
  deq([store.items[KEY].previous, latestA.text, latestA.format, latestA.chars, latestA.lines, latestA.session],
    [null, 'One\nTwo', 'markdown', 7, 2, A.T.DOC_HISTORY_SESSION]);
  // A reloads its chat list: no promotion (A's own text is not "an earlier session")
  await A.T.refreshContext({ force: true }); await tick(5);
  assert.strictEqual(store.items[KEY].previous, null);
  // a new panel: A's latest becomes previous
  const B = await panel(store);
  deq(store.items[KEY].previous, latestA);
  // B's turn writes latest and keeps previous; reloading B's chat list does not promote B's own text
  useProvider(B, 'anthropic', { model: 'claude-opus-5-5' });
  recordFetch(B, [textRound('OK.')]);
  B.doc.text = 'One\nTwo\nThree';
  await send(B, 'hi');
  await tick(5);
  await B.T.refreshContext({ force: true }); await tick(5);
  deq([store.items[KEY].previous.text, store.items[KEY].latest.text, store.items[KEY].latest.session], ['One\nTwo', 'One\nTwo\nThree', B.T.DOC_HISTORY_SESSION]);
  // switching to another document and back in the same panel: no promotion either
  await B.T.startDocHistory('OTHER');
  await B.T.refreshContext({ force: true }); await tick(5);
  assert.strictEqual(store.items[KEY].previous.text, 'One\nTwo');
  // a text over 2,000,000 characters: a marker with the sizes, no text
  await B.T.saveDocText({ docId: 'DOC123', docText: 'x'.repeat(2000001), docFormat: 'text' });
  const big = store.items[KEY].latest;
  deq([big.tooLarge, big.text, big.chars, big.lines], [true, undefined, 2000001, 1]);
  // no document text (an export error): nothing written
  await B.T.saveDocText({ docId: 'DOC123', docText: null, docFormat: 'text' });
  assert.strictEqual(store.items[KEY].latest.chars, 2000001);
});

test('saveDocText: an unchanged text is not written again; a changed one is', async () => {
  const store = sharedStorage();
  const B = await panel(store);
  const writes = [];
  const set = store.local.set;
  store.local.set = async (obj) => { if (KEY in obj) writes.push(obj[KEY].latest.text); return set(obj); };
  const snap = (text) => ({ docId: 'DOC123', docText: text, docFormat: 'text' });
  // two turns on the same text: one write
  useProvider(B, 'anthropic', { model: 'claude-opus-5-5' });
  recordFetch(B, [textRound('OK.'), textRound('OK again.')]);
  B.doc.text = 'One\nTwo';
  await send(B, 'hi'); await tick(5);
  const at = store.items[KEY].latest.at;
  await send(B, 'again'); await tick(5);
  deq(B.state.messages.filter((m) => m.role === 'assistant').map((m) => m.content), ['OK.', 'OK again.']);
  deq(writes, ['One\nTwo']);
  assert.strictEqual(store.items[KEY].latest.at, at);
  await B.T.saveDocText(snap('One\nTwo\nThree'));
  deq(writes, ['One\nTwo', 'One\nTwo\nThree']);
  // the same text in another form (an export instead of the Docs API) is a new entry
  await B.T.saveDocText({ ...snap('One\nTwo\nThree'), docFormat: 'markdown' });
  assert.strictEqual(writes.length, 3);
  // a latest of another session is replaced by this panel's, even with the same text
  store.items[KEY].latest.session = 'earlier';
  await B.T.saveDocText({ ...snap('One\nTwo\nThree'), docFormat: 'markdown' });
  assert.strictEqual(writes.length, 4);
  assert.strictEqual(store.items[KEY].latest.session, B.T.DOC_HISTORY_SESSION);
});

test('docNote: only with a previous text that differs from the text at the start of the turn', async () => {
  const store = sharedStorage();
  store.items[KEY] = { previous: null, latest: { ...entry(['One', 'Two']), session: 'earlier', hash: undefined } };
  store.items[KEY].latest.hash = T.textHash('One\nTwo');
  const B = await panel(store);
  const snap = (text) => ({ docId: 'DOC123', docText: text, docFormat: 'text' });
  assert.strictEqual(B.T.docHistoryNote(snap('One\nTwo')), '');
  assert.strictEqual(B.T.docHistoryNote(snap('One\nTwo\nThree')), 'The document changed since the previous session; document_changes shows the diff.');
  assert.strictEqual(B.T.docHistoryNote(snap('One\nTwx')), 'The document changed since the previous session; document_changes shows the diff.'); // same length: the hash
  assert.strictEqual(B.T.docHistoryNote({ ...snap('x'), docId: 'OTHER' }), ''); // no baseline loaded
  // a panel without an earlier session: no note, and the tool is not offered
  const C = await panel(sharedStorage());
  assert.strictEqual(C.T.docHistoryNote(snap('anything')), '');
  useProvider(C, 'anthropic');
  const s = C.T.takeSnapshot(); C.T.snapshotDocument(s);
  assert.ok(!C.T.toolsFor('edit', s).some((t) => t.function.name === 'document_changes'));
  deq(await C.T.docChangesResult({ lines: null }, { ...s, docText: 'x' }), { content: 'No earlier session is stored for this document yet; changes are tracked from now on.', _ok: true, _message: 'no earlier session stored' });
});

test('storage cleanup: the baseline goes with the document\'s chats; kept while the chats are', async () => {
  const store = sharedStorage();
  const old = Date.now() - 181 * 24 * 3600 * 1000;
  Object.assign(store.items, {
    'muninChats:OLD': [{ id: 'o1', title: '', createdAt: old, updatedAt: old }], 'muninChatHistory:OLD:o1': [], 'muninDocText:OLD': { previous: null, latest: entry(['x']) },
    'muninChats:NEW': [{ id: 'n1', title: '', createdAt: Date.now(), updatedAt: Date.now() }], 'muninChatHistory:NEW:n1': [], 'muninDocText:NEW': { previous: null, latest: entry(['y']) },
    'muninDocText:GHOST': { previous: null, latest: entry(['z']) }, // no chat list
  });
  await panel(store); // the first chat-list load starts the daily cleanup
  await tick(20);
  deq(Object.keys(store.items).filter((k) => k.startsWith('muninDocText:')).sort(), ['muninDocText:NEW']);
});

test('storage cleanup: the citation store (muninCitations:) goes with the document\'s chats too', async () => {
  const store = sharedStorage();
  const old = Date.now() - 181 * 24 * 3600 * 1000;
  const cites = { style: 'apa', items: {}, order: [], marks: [] };
  Object.assign(store.items, {
    'muninChats:OLD': [{ id: 'o1', title: '', createdAt: old, updatedAt: old }], 'muninChatHistory:OLD:o1': [], 'muninCitations:OLD': cites,
    'muninChats:NEW': [{ id: 'n1', title: '', createdAt: Date.now(), updatedAt: Date.now() }], 'muninChatHistory:NEW:n1': [], 'muninCitations:NEW': cites,
    'muninCitations:GHOST': cites, // no chat list
  });
  await panel(store);
  await tick(20);
  deq(Object.keys(store.items).filter((k) => k.startsWith('muninCitations:')).sort(), ['muninCitations:NEW']);
  assert.strictEqual(T.citationsKey('X'), T.CITATIONS_PREFIX + 'X');
});

test('in a turn: offered with a baseline, listed in the prompt, a quiet reading call with the diff; the note in the context', async () => {
  const store = sharedStorage();
  const prevText = ['# Paper', '', 'Intro.', '', '## Methods', '', 'Old method.'].join('\n');
  store.items[KEY] = { previous: null, latest: { ...entry(prevText.split('\n'), { format: 'markdown' }), session: 'earlier', hash: T.textHash(prevText) } };
  const B = await panel(store);
  useProvider(B, 'anthropic', { model: 'claude-opus-5-5' });
  await B.T.createChat();
  B.doc.text = ['# Paper', '', 'Intro.', 'Added by a colleague.', '', '## Methods', '', 'New method.'].join('\n');
  const bodies = recordFetch(B, [msgStart + tu(0, 'dc1', 'document_changes', { lines: null }) + stopTool, textRound('A colleague added a line.')]);
  await send(B, 'What changed?');
  const tools = bodies[0].tools.map((t) => t.name);
  assert.strictEqual(tools[tools.length - 1], 'document_changes');
  const sys = JSON.stringify(bodies[0].system);
  assert.ok(sys.includes('- document_changes(lines): what changed in the document since the end of your previous session (removed/added lines). Use it when the user asks what changed or what collaborators did.'));
  assert.ok(B.state.messages[0]._context.includes('</document>\nThe document changed since the previous session; document_changes shows the diff.'));
  const result = B.state.messages.find((m) => m.role === 'tool');
  const when = B.T.fmtStamp(AT);
  // a reading result: sent in full in the next round, stubbed after the turn like read_lines
  assert.strictEqual(result.content, '[document_changes: content omitted after the turn; re-read if needed]');
  const sent = bodies[1].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_result');
  assert.strictEqual(typeof sent.content === 'string' ? sent.content : sent.content.map((c) => c.text).join(''), `Changes since ${when} (end of the previous session): 1 line added, 1 line changed; now 8 lines (was 7). ("- was N": old line N; "+ N": current line N.)\n` +
    '… 3 unchanged lines …\n+ 4: Added by a colleague.\n… 3 unchanged lines …\n- was 7: Old method.\n+ 8: New method.');
  deq([result._ok, result._reading, result._message], [true, true, `changes since ${when}`]);
  assert.ok(B.T.isReadingTool({ function: { name: 'document_changes', arguments: '{"lines":null}' } }));
  deq([B.T.activityIcon('document_changes'), B.T.logEntry({ function: { name: 'document_changes', arguments: '{"lines":"3-9"}' } }, null).summary],
    ['🕓', `changes since ${when} (lines 3–9)`]);
  // a bad range is an error the model can act on
  const s = B.T.takeSnapshot(); B.T.snapshotDocument(s);
  assert.ok(/^Error: lines must be a range of current line numbers like "120-180"/.test(await B.T.docChangesResult({ lines: 'intro' }, s)));
  assert.strictEqual(await B.T.docChangesResult({ lines: '40-50' }, s), 'Error: the document has only 8 lines.');
});
