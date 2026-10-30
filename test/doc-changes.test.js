'use strict';
// The <document_changes> note of the turn context: what changed in the document since the previous turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

const facts = (chars, nLines, outline, extra = {}) => ({ format: 'markdown', chars, lines: nLines, outline, ...extra });

test('docChangesNote: wording, signs, moved / new / removed headings, cap, nothing when unchanged', () => {
  const prev = facts(5000, 120, [[1, 'Title'], [40, 'Methods'], [88, 'Results']]);
  // the example of the brief
  assert.strictEqual(T.docChangesNote(prev, facts(6240, 123, [[1, 'Title'], [43, 'Methods'], [91, 'Results']])),
    '<document_changes>Since your last turn: +1240 characters, +3 lines; headings moved: "Methods" 40→43, "Results" 88→91.</document_changes>');
  // shrinking, a single line, new and removed headings
  assert.strictEqual(T.docChangesNote(prev, facts(4999, 119, [[1, 'Title'], [39, 'Methods'], [100, 'Discussion']])),
    '<document_changes>Since your last turn: -1 character, -1 line; headings moved: "Methods" 40→39; new headings: "Discussion" (line 100); removed headings: "Results".</document_changes>');
  // only the headings changed (renamed in place)
  assert.strictEqual(T.docChangesNote(prev, facts(5000, 120, [[1, 'Title'], [40, 'Method'], [88, 'Results']])),
    '<document_changes>Since your last turn: new headings: "Method" (line 40); removed headings: "Methods".</document_changes>');
  // nothing changed; no previous facts (first turn); not comparable (another format or tab)
  assert.strictEqual(T.docChangesNote(prev, facts(5000, 120, prev.outline)), '');
  assert.strictEqual(T.docChangesNote(null, prev), '');
  assert.strictEqual(T.docChangesNote(prev, null), '');
  assert.strictEqual(T.docChangesNote(prev, { ...facts(9000, 300, []), format: 'docs-api' }), '');
  assert.strictEqual(T.docChangesNote(facts(1, 1, [], { format: 'docs-api', tab: 'A' }), facts(9, 9, [], { format: 'docs-api', tab: 'B' })), '');
  // the same revision (Docs API): no note; another revision with the same size: a short note
  const r1 = facts(5000, 120, prev.outline, { format: 'docs-api', revisionId: 'r1' });
  assert.strictEqual(T.docChangesNote(r1, { ...r1 }), '');
  assert.strictEqual(T.docChangesNote(r1, { ...r1, revisionId: 'r2' }),
    '<document_changes>Since your last turn: the text was edited (its size and headings are unchanged).</document_changes>');
  // duplicate titles are matched in order
  assert.strictEqual(T.docChangesNote(facts(10, 10, [[2, 'Notes'], [6, 'Notes']]), facts(10, 10, [[2, 'Notes'], [7, 'Notes']])),
    '<document_changes>Since your last turn: headings moved: "Notes" 6→7.</document_changes>');
});

test('docChangesNote: at most 5 headings per list, with the rest counted', () => {
  const prev = facts(1000, 100, lines(8, (i) => [i * 10, `H${i}`]));
  const cur = facts(1000, 102, [...lines(8, (i) => [i * 10 + 2, `H${i}`]), ...lines(7, (i) => [100 + i, `N${i}`])]);
  assert.strictEqual(T.docChangesNote(prev, cur), '<document_changes>Since your last turn: +2 lines; ' +
    'headings moved: "H1" 10→12, "H2" 20→22, "H3" 30→32, "H4" 40→42, "H5" 50→52 and 3 more; ' +
    'new headings: "N1" (line 101), "N2" (line 102), "N3" (line 103), "N4" (line 104), "N5" (line 105) and 2 more.</document_changes>');
});

test('docFacts: size, lines, outline; the Docs API revision and tab', () => {
  useProvider(env, 'anthropic');
  state.docFormat = 'markdown'; state.docText = '# A\n\ntext\n\n## B'; state.docTitle = 'X'; state.docError = ''; state.selection = '';
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  deq(T.docFacts(s), { format: 'markdown', chars: 15, lines: 5, outline: [[1, 'A'], [5, 'B']] });
  const api = { ...s, docFormat: 'docs-api', model: { lines: [{ line: 1, heading: 1, text: 'A', style: 'HEADING_1' }], revisionId: 'rev9', tabCount: 2, tabTitle: 'Main' }, lines: null };
  deq(T.docFacts(api), { format: 'docs-api', chars: 15, lines: 5, outline: [[1, 'A']], revisionId: 'rev9', tab: 'Main' });
  assert.strictEqual(T.docFacts({ ...s, docText: null }), null);
});

test('in a chat: no note on the first turn, a note after a change, none when nothing changed; facts stored at the end of the turn', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  const bodies = recordFetch(env, [textRound('OK.')]);
  const base = ['# Paper', '', 'Intro.', '', '## Methods', '', 'Text.', '', '## Results', '', 'More.'];
  doc.text = base.join('\n'); doc.selection = '';
  await send(env, 'first');
  assert.ok(!state.messages[0]._context.includes('<document_changes>')); // first turn: nothing to compare with
  deq(state.messages[0]._docFacts, { format: 'markdown', chars: doc.text.length, lines: 11, outline: [[1, 'Paper'], [5, 'Methods'], [9, 'Results']] });
  // the user adds three lines before Methods
  const changed = [...base.slice(0, 4), 'One.', 'Two.', 'Three.', ...base.slice(4)];
  doc.text = changed.join('\n');
  await send(env, 'second');
  const note = '<document_changes>Since your last turn: +17 characters, +3 lines; headings moved: "Methods" 5→8, "Results" 9→12.</document_changes>';
  const own = 'Since your last message you added lines 5–7: «One. / Two. / Three.».'; // own-changes.js
  assert.ok(state.messages[2]._context.includes(`</document>\n${note}\n${own}\nCurrent selection in the document:`), state.messages[2]._context);
  assert.ok(bodies[1].messages[bodies[1].messages.length - 1].content[0].text.includes(note)); // sent with the turn
  assert.strictEqual(state.messages[0]._docFacts, undefined); // only the newest facts are kept
  assert.strictEqual(state.messages[2]._docFacts.lines, 14);
  // nothing changed since: no note
  await send(env, 'third');
  assert.ok(!state.messages[4]._context.includes('<document_changes>'));
  // the facts survive a reload (they are stored with the history)
  assert.strictEqual(env.storage['muninChatHistory:DOC123:' + state.chatId][4]._docFacts.lines, 14);
});
