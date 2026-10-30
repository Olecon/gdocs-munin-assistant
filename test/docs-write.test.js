'use strict';
// Writing through the Docs API: replace_text, replace_all, insert_after_line, delete_lines, format_text,
// replace_selection, the undo stack, refusals (stale line numbers, suggestions, tables).
const { test, before } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, OC, VT, MARK, docSpec, ORIGINAL, ORIGINAL_STYLES, docsBench } = require('./lib/fake-docs');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, D, state, sandbox, chrome, ident, fresh, exec, pushTool, lastPost, w, card, postCount;

before(async () => {
  env = await load();
  T = D = env.T;
  state = env.state;
  sandbox = env.ctx;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  // the Docs tab (replace_selection pastes into it) and the provider as the old harness had them at this point
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

test('replace_text: 0 / 1 / 2 matches, multi-paragraph, stripped characters, verification', async () => {
  // --- writing tools against the fake server. exec = one call in its own model response.
  await fresh();
  // 0 matches, 2 matches, an embedded object
  w = await exec('replace_text', { old_text: 'Gamma ray', new_text: 'x' });
  assert.ok(!w._ok && /not found in the document/.test(w.content) && /read_lines/.test(w.content));
  w = await exec('replace_text', { old_text: 'Alpha beta', new_text: 'x' });
  assert.ok(!w._ok && /occurs 2 times \(lines 4, 5\)/.test(w.content) && /surrounding text/.test(w.content));
  w = await exec('replace_text', { old_text: 'Image ' + OC, new_text: 'Picture' });
  assert.ok(!w._ok && /embedded object/.test(w.content));
  assert.strictEqual(fake.revision, 1); // nothing was written
  // 1 match inside a line with an emoji before it; a control character the API would strip is removed first
  w = pushTool(await exec('replace_text', { old_text: 'text.', new_text: 'wor' + String.fromCharCode(7) + 'ds!' }, 'w1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Replaced line 2');
  assert.strictEqual(w.content, 'Done: replaced line 2.\nLines 2-2 now:\n2: Intro 😀 words!\nThe document now has 10 lines.');
  deq(lastPost(), { requests: [
    { deleteContentRange: { range: { startIndex: 20, endIndex: 25, tabId: 't.0' } } },
    { insertText: { location: { index: 20, tabId: 't.0' }, text: 'words!' } },
  ], writeControl: { requiredRevisionId: 'rev-1' } });
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'Intro 😀 words!');
  assert.strictEqual(as.docText, fake.text('t.0')); assert.strictEqual(state.docText, fake.text('t.0')); assert.strictEqual(as.model.revisionId, 'rev-2');
  assert.strictEqual(T.runReadingTool('read_lines', { start: 2, end: 2 }, as), 'Lines 2-2 of 10:\n2: Intro 😀 words!');
  deq(w._edit, { id: 'w1', docId: 'DOC123', tabId: 't.0', kind: 'replace', index: 20, text: 'words!', restore: 'text.', paras: [], title: 'Replaced line 2', undone: false,
    anchor: { before: 'Report 📊\nIntro 😀 ', after: '\nMethods\nAlpha beta ', revision: 'rev-2' } });
  // multi-paragraph match, new_text with an extra paragraph: first/last styles kept, the new one normal
  w = pushTool(await exec('replace_text', { old_text: 'gamma.\nAlpha beta delta', new_text: 'GAMMA.\nNew para\nAlpha DELTA' }, 'w2'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Replaced lines 4–5');
  assert.ok(w.content.includes('Lines 4-6 now:\n4: Alpha beta GAMMA.\n5: New para\n6: Alpha DELTA.') && w.content.includes('now has 11 lines'));
  deq(fake.text('t.0').split('\n').slice(3, 7), ['Alpha beta GAMMA.', 'New para', 'Alpha DELTA.', 'Cell A']);
  assert.strictEqual(T.runReadingTool('find_in_document', { query: 'new para' }, as), '1 line contains "new para":\n5: New para');
  w = await exec('replace_text', { old_text: 'DELTA.\nCell A', new_text: 'x' });
  assert.ok(!w._ok && /crosses the end of line 6/.test(w.content));
});

test('replace_text across heading boundaries keeps the paragraph styles (and undo)', async () => {
  // multi-paragraph replace across a heading, both directions: the styles of the first and last line stay
  await fresh();
  w = pushTool(await exec('replace_text', { old_text: 'Methods\nAlpha beta gamma', new_text: 'Method\nAlpha beta gamma' }, 'h1'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(2, 4), ['Method', 'Alpha beta gamma.']);
  deq(fake.styles('t.0').slice(0, 5), ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  // prefix/suffix trimming: only the word "Methods" of line 3 is replaced, no paragraph is merged or split
  deq(lastPost().requests, [
    { deleteContentRange: { range: { startIndex: 26, endIndex: 33, tabId: 't.0' } } },
    { insertText: { location: { index: 26, tabId: 't.0' }, text: 'Method' } },
  ]);
  w = pushTool(await exec('replace_text', { old_text: 'text.\nMethod', new_text: 'text!\nMethods' }, 'h2'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(1, 3), ['Intro 😀 text!', 'Methods']);
  deq(fake.styles('t.0').slice(0, 4), ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT']);
  for (const id of ['u-h2', 'u-h1']) assert.ok(pushTool(await exec('undo_last_edit', {}, id))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // whole lines with their trailing newline (the paragraph after the range survives and keeps its style)
  const styleReq = (s0, style) => ({ updateParagraphStyle: { range: { startIndex: s0, endIndex: s0 + 1, tabId: 't.0' }, paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } });
  await fresh();
  w = pushTool(await exec('replace_text', { old_text: 'Intro 😀 text.\n', new_text: 'Intro 😀 words.\n' }, 'q1'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(0, 4), ['Report 📊', 'Intro 😀 words.', 'Methods', 'Alpha beta gamma.']);
  deq(fake.styles('t.0').slice(0, 4), ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT']);
  // only "text" -> "words" (the common "Intro 😀 " and ".\n" stay), so no paragraph styles are needed
  deq(lastPost().requests, [
    { deleteContentRange: { range: { startIndex: 20, endIndex: 24, tabId: 't.0' } } },
    { insertText: { location: { index: 20, tabId: 't.0' }, text: 'words' } },
  ]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'q1u'))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // two whole lines deleted with an empty new_text: the following heading stays a heading; undo restores all
  w = pushTool(await exec('replace_text', { old_text: 'Report 📊\nIntro 😀 text.\n', new_text: '' }, 'q2'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(0, 3), ['Methods', 'Alpha beta gamma.', 'Alpha beta delta.']);
  deq(fake.styles('t.0').slice(0, 3), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(lastPost().requests, [{ deleteContentRange: { range: { startIndex: 1, endIndex: 26, tabId: 't.0' } } }, styleReq(1, 'HEADING_1')]);
  deq(w._edit.paras, [{ nl: -1, style: 'TITLE' }, { nl: 0, style: 'NORMAL_TEXT' }, { nl: 1, style: 'HEADING_1' }]);
  w = pushTool(await exec('undo_last_edit', {}, 'q2u'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  deq(fake.styles('t.0').slice(0, 4), ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT']);
  deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // a heading line with its newline replaced: the heading keeps its style, the next line too
  w = pushTool(await exec('replace_text', { old_text: 'Methods\n', new_text: 'Methods and data\n' }, 'q5'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(2, 4), ['Methods and data', 'Alpha beta gamma.']);
  deq(fake.styles('t.0').slice(2, 4), ['HEADING_1', 'NORMAL_TEXT']);
});

test('insert_after_line (line 0, after a heading, trailing newline)', async () => {
  // insert_after_line: after a heading (style reset, trailing newline dropped), at line 0, invalid line
  await fresh();
  w = pushTool(await exec('insert_after_line', { line: 3, text: 'First under Methods\n' }, 'w3'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Inserted after line 3');
  assert.strictEqual(w.content, 'Done: inserted after line 3.\nLines 4-4 now:\n4: First under Methods\nThe document now has 11 lines.');
  deq(fake.text('t.0').split('\n').slice(2, 5), ['Methods', 'First under Methods', 'Alpha beta gamma.']);
  deq(fake.styles('t.0').slice(2, 5), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(lastPost().requests, [
    { insertText: { location: { index: 33, tabId: 't.0' }, text: '\nFirst under Methods' } },
    { updateParagraphStyle: { range: { startIndex: 34, endIndex: 53, tabId: 't.0' }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
  ]);
  w = pushTool(await exec('insert_after_line', { line: 0, text: 'Draft\nDo not share\n' }, 'w4'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Inserted at the beginning');
  assert.ok(w.content.includes('Lines 1-2 now:\n1: Draft\n2: Do not share') && w.content.includes('now has 13 lines'));
  deq(fake.styles('t.0').slice(0, 3), ['NORMAL_TEXT', 'NORMAL_TEXT', 'TITLE']);
  w = await exec('insert_after_line', { line: 99, text: 'x' });
  assert.ok(!w._ok && /from 0 to 13/.test(w.content));
});

test('delete_lines (body, last line, table boundary)', async () => {
  // delete_lines: inside the body, the last line (newline before it is deleted), across a table boundary
  w = pushTool(await exec('delete_lines', { start: 8, end: 8 }, 'w5')); // "Alpha beta delta."
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Deleted line 8');
  assert.strictEqual(w.content, 'Done: deleted line 8.\nLines 7-8 now:\n7: Alpha beta gamma.\n[table T1: 1 row × 2 columns, lines 8–9]\n8 [r1c1]: Cell A\nThe document now has 12 lines.');
  w = pushTool(await exec('delete_lines', { start: 12, end: 12 }, 'w6')); // "Last line"
  assert.ok(w._ok, w.content);
  assert.ok(fake.text('t.0').endsWith('Image ' + OC + ' done'));
  assert.strictEqual(w._edit.restore, '\nLast line'); // the newline before the line is deleted (the last newline must stay)
  w = await exec('delete_lines', { start: 8, end: 9 }); // Cell A and Cell B
  assert.ok(!w._ok && /different parts of the document/.test(w.content));
  w = await exec('delete_lines', { start: 3, end: 2 });
  assert.ok(!w._ok && /1 <= start <= end/.test(w.content));
});

test('undo_last_edit (stack, styles restored, card updated, undo of an undo refused)', async () => {
  // --- undo: newest first, journal kept in the history, styles restored
  assert.strictEqual(D.latestUndoable()._edit.id, 'w6');
  card = D.toolCardFor({ id: 'w6', function: { name: 'delete_lines', arguments: '{"start":12,"end":12}' } }, state.messages[state.messages.length - 1]);
  assert.ok(card.innerHTML.includes('✅ Deleted line 12') && card.innerHTML.includes('data-act="undo-edit" data-edit="w6"') && card.innerHTML.includes('<summary>Deleted text</summary><pre>Last line</pre>'));
  assert.strictEqual(D.editCards.get('w6'), card);
  card = D.toolCardFor({ id: 'w5', function: { name: 'delete_lines', arguments: '{}' } }, state.messages.find((x) => x._edit && x._edit.id === 'w5'));
  assert.ok(!card.innerHTML.includes('undo-edit')); // only the most recent edit has the button
  state.googleConnected = false;
  card = D.toolCardFor({ id: 'w6', function: { name: 'delete_lines', arguments: '{}' } }, state.messages[state.messages.length - 1]);
  assert.ok(!card.innerHTML.includes('undo-edit')); // hidden when not connected
  state.googleConnected = true;
  let replaced = null;
  D.editCards.get('w6').replaceWith = (n) => { replaced = n; };
  w = pushTool(await exec('undo_last_edit', {}, 'u1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Undid: Deleted line 12');
  assert.ok(w.content.startsWith('Done: undid "Deleted line 12".') && w.content.includes('12: Last line') && w.content.includes('now has 12 lines'));
  assert.ok(replaced && replaced.innerHTML.includes('Deleted line 12 (undone)')); // the card is updated within the turn
  w = await exec('insert_after_line', { line: 1, text: 'x' }, null, true); // same response as the undo: refused
  assert.ok(!w._ok && /line numbers changed after the previous edit/.test(w.content) && w.content.includes('12: Last line'));
  for (const id of ['u2', 'u3', 'u4']) { w = pushTool(await exec('undo_last_edit', {}, id)); assert.ok(w._ok, w.content); }
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  w = await exec('undo_last_edit', {}, 'u5');
  assert.ok(!w._ok && /no edit to undo/.test(w.content) && w._message === 'Nothing to undo'); // an undo cannot be undone
  assert.strictEqual(D.latestUndoable(), null);
});

test('a second line-number write in the same response is refused (also after a refused write)', async () => {
  // --- several writes in one model response: the second line-number write is refused
  await fresh();
  w = pushTool(await exec('delete_lines', { start: 4, end: 4 }, 'p1'));
  assert.ok(w._ok);
  w = await exec('delete_lines', { start: 9, end: 9 }, 'p2', true); // the model meant old line 9 ("Image ... done")
  assert.ok(!w._ok && /line numbers changed after the previous edit in this response/.test(w.content) && /re-read with read_lines/.test(w.content));
  assert.ok(w.content.includes('3: Methods\n4: Alpha beta delta.'));
  assert.ok(fake.text('t.0').includes('Image ' + OC + ' done') && fake.text('t.0').includes('Details'));
  w = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' }, 'p3', true); // text-based: allowed
  assert.ok(w._ok, w.content);
  // a refused write that re-read a changed document also makes the numbers stale for this response
  await fresh();
  fake.typeParagraph(0, 'Typed meanwhile');
  w = await exec('delete_lines', { start: 4, end: 4 }, 'q3a');
  assert.ok(!w._ok && /changed after it was read/.test(w.content));
  w = await exec('delete_lines', { start: 4, end: 4 }, 'q3b', true); // same response, numbers from before the re-read
  assert.ok(!w._ok && /line numbers changed/.test(w.content), w.content);
  deq(fake.text('t.0').split('\n'), ['Typed meanwhile', ...ORIGINAL]); // "Methods" (now line 4) was not deleted
});

test('a 400 without a revision change is reported as a rejection', async () => {
  // --- a 400 without a revision change is reported with the server message; nothing is pasted
  await fresh();
  fake.failNext = { status: 400, message: 'Invalid requests[0].deleteContentRange: something odd.' };
  w = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' });
  assert.ok(!w._ok && /rejected the edit/.test(w.content) && /something odd/.test(w.content) && !/changed after it was read/.test(w.content));
});

test('soft line breaks: mark in the output, newline or mark accepted in old_text', async () => {
  // --- soft line breaks: shown as a mark, matched by a newline or the mark
  await fresh(docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'Alpha' + VT + 'beta gamma.' }, { p: 'End' }] }));
  assert.strictEqual(T.runReadingTool('read_lines', { start: 2, end: 2 }, as), 'Lines 2-2 of 3:\n2: Alpha' + MARK + 'beta gamma.');
  w = pushTool(await exec('replace_text', { old_text: 'Alpha\nbeta', new_text: 'One' + MARK + 'two' }, 's1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'One' + VT + 'two gamma.');
  assert.ok(w.content.includes('2: One' + MARK + 'two gamma.'));
  w = pushTool(await exec('replace_text', { old_text: 'One' + MARK + 'two', new_text: 'Three' }, 's2'));
  assert.ok(w._ok && fake.text('t.0').split('\n')[1] === 'Three gamma.', w.content);
});

test('suggestions: flagged, noted, writes refused', async () => {
  // --- suggestions: flagged lines, a note in the prompt, writes refused
  await fresh(docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'Suggested words here', suggest: true }, { p: 'Plain line' }] }));
  assert.ok(as.model.lines[1].suggested && !as.model.lines[2].suggested);
  assert.strictEqual(T.runReadingTool('read_lines', { start: 2, end: 3 }, as), 'Lines 2-3 of 3:\n2: Suggested words here  [contains suggested changes]\n3: Plain line');
  assert.ok(T.buildTurnContext('edit', as).includes('[1 line contains suggested changes (suggesting mode)'));
  w = await exec('replace_text', { old_text: 'words', new_text: 'terms' });
  assert.ok(!w._ok && /contains suggested changes/.test(w.content));
  w = await exec('delete_lines', { start: 2, end: 2 });
  assert.ok(!w._ok && /contains suggested changes/.test(w.content));
  w = await exec('insert_after_line', { line: 2, text: 'x' });
  assert.ok(!w._ok && /contains suggested changes/.test(w.content));
  w = await exec('replace_text', { old_text: 'Plain', new_text: 'Simple' });
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.revision, 2);
});

test('delete_lines of the last line takes the newline of the line before: refused when that line has suggestions', async () => {
  await fresh(docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'Suggested words here', suggest: true }, { p: 'Plain line' }] }));
  const r = await exec('delete_lines', { start: 3, end: 3 });
  assert.strictEqual(r.content, 'Error: deleting line 3 also removes the end of line 2, which contains suggested changes (suggesting mode); accept or reject them in Google Docs first');
  assert.strictEqual(r._message, 'delete_lines: the line has suggested changes');
  assert.strictEqual(fake.revision, 1); // nothing sent
  assert.strictEqual(fake.text('t.0'), 'Title\nSuggested words here\nPlain line');
});

test('a document ending in a table', async () => {
  // --- a document that ends in a table
  await fresh(docSpec({ items: [{ p: 'Intro' }, { table: [[[{ p: 'A1' }], [{ p: 'B1' }, { p: 'B2' }]]] }] }));
  deq(as.model.lines.map((l) => [l.text, l.start, l.end, !!l.closing]), [['Intro', 1, 6, true], ['A1', 10, 12, true], ['B1', 14, 16, false], ['B2', 17, 19, true]]);
  w = pushTool(await exec('delete_lines', { start: 4, end: 4 }, 't1')); // last paragraph of the last cell: the newline before it goes
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n'), ['Intro', 'A1', 'B1']);
  w = pushTool(await exec('insert_after_line', { line: 3, text: 'B3' }, 't2')); // inside the cell
  assert.ok(w._ok, w.content);
  deq(fake.tabs[0].blocks[1].rows[0][1].paras.map((p) => p.text), ['B1', 'B3']);
  w = pushTool(await exec('delete_lines', { start: 2, end: 2 }, 't3')); // a cell's only paragraph: emptied
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n'), ['Intro', '', 'B1', 'B3']);
  w = await exec('delete_lines', { start: 2, end: 2 });
  assert.ok(!w._ok && /cannot be removed/.test(w.content));
  for (const id of ['t3u', 't2u', 't1u']) { w = pushTool(await exec('undo_last_edit', {}, id)); assert.ok(w._ok, w.content); }
  deq(fake.text('t.0').split('\n'), ['Intro', 'A1', 'B1', 'B2']);
});

test('replace_selection via the API; paste only when nothing was applied', async () => {
  // --- replace_selection: via the API; paste fallback only when nothing can have happened
  await fresh();
  const pasted = [];
  chrome.tabs.sendMessage = async (id, msg) => { if (msg.type === 'REPLACE_SELECTION') { pasted.push(msg.text); return { ok: true }; } return { ok: true, text: '' }; };
  state.selection = 'beta delta';
  w = pushTool(await exec('replace_selection', { text: 'beta epsilon' }, 'rs1'));
  assert.ok(w._ok && w._edit && w._message === 'Replaced the selection (line 5)', w.content);
  assert.ok(fake.text('t.0').includes('Alpha beta epsilon.')); deq(pasted, []);
  assert.strictEqual(state.selection, '');
  state.selection = 'Alpha beta'; // twice in the document: pasted as before
  w = pushTool(await exec('replace_selection', { text: 'Omega' }, 'rs2'));
  assert.ok(w._ok && !w._edit && JSON.parse(w.content).ok === true && JSON.parse(w.content).note === T.PASTE_DONE_NOTE);
  deq(pasted, ['Omega']);
  assert.strictEqual(as.pasteDone, true);
  // the API path is not limited by the paste: the selection is found exactly once, replaced through the API again
  state.selection = 'beta epsilon';
  w = pushTool(await exec('replace_selection', { text: 'beta kappa' }, 'rs2a'));
  assert.ok(w._ok && w._edit && w._message === 'Replaced the selection (line 5)', w.content);
  deq(pasted, ['Omega']);
  w = pushTool(await exec('undo_last_edit', {}, 'rs2a-u'));
  assert.ok(w._ok && fake.text('t.0').includes('Alpha beta epsilon.'), w.content);
  // a second paste in the same turn is refused without touching the document
  state.selection = 'Alpha beta';
  w = await exec('replace_selection', { text: 'Omega again' }, 'rs2b');
  assert.ok(!w._ok && w.content === T.PASTE_AGAIN_TEXT && w._message === T.PASTE_AGAIN_CARD, w.content);
  deq(pasted, ['Omega']);
  // and so is the paste fallback of a failed API edit in that turn
  state.selection = 'beta epsilon';
  fake.failNext = { network: true, apply: false };
  w = await exec('replace_selection', { text: 'beta iota' }, 'rs2c');
  assert.ok(!w._ok && w.content === T.PASTE_AGAIN_TEXT, w.content); deq(pasted, ['Omega']);
  as.pasteDone = false; // the next checks: a new turn
  w = pushTool(await exec('undo_last_edit', {}, 'rs-u')); // the API replacement is undoable
  assert.ok(w._ok && fake.text('t.0').includes('Alpha beta delta.'), w.content);
  // the document changed meanwhile: reported, not pasted
  fake.typeParagraph(0, 'Typed');
  state.selection = 'beta delta';
  w = await exec('replace_selection', { text: 'beta zeta' }, 'rs3');
  assert.ok(!w._ok && /changed after it was read/.test(w.content)); deq(pasted, ['Omega']);
  assert.ok(!fake.text('t.0').includes('zeta'));
  // network failure before the request arrived: not applied, so pasted
  state.selection = 'beta delta';
  fake.failNext = { network: true, apply: false };
  w = await exec('replace_selection', { text: 'beta eta' }, 'rs4');
  assert.ok(w._ok && JSON.parse(w.content).note === T.PASTE_DONE_NOTE); deq(pasted, ['Omega', 'beta eta']);
  as.pasteDone = false; // the next check: a new turn
  assert.ok(!fake.text('t.0').includes('beta eta'));
  // network failure after the edit was applied: recognized as done, not pasted again
  state.selection = 'beta delta';
  fake.failNext = { network: true, apply: true };
  w = await exec('replace_selection', { text: 'beta theta' }, 'rs5');
  assert.ok(w._ok && w._edit && /Done: replaced the selection/.test(w.content), w.content);
  deq(pasted, ['Omega', 'beta eta']);
  assert.strictEqual(fake.text('t.0').split('beta theta').length, 2); // applied exactly once
});

test('replace_all: errors, one back-to-front batch, same-response use, undo and its refusals', async () => {
  // --- replace_all: plan errors, every occurrence in one batch (back to front), undo by occurrence count
  await fresh();
  postCount = () => fake.log.filter((x) => x.method === 'POST').length;
  w = await exec('replace_all', { old_text: 'Gamma ray', new_text: 'x' });
  assert.ok(!w._ok && /not found in the document/.test(w.content) && w._message === 'replace_all: the text was not found', w.content);
  w = await exec('replace_all', { old_text: '', new_text: 'x' });
  assert.ok(!w._ok && /old_text is empty/.test(w.content));
  w = await exec('replace_all', { old_text: 'gamma.\nAlpha', new_text: 'x' });
  assert.ok(!w._ok && /within paragraphs only/.test(w.content) && /use replace_text/.test(w.content));
  w = await exec('replace_all', { old_text: 'Alpha', new_text: 'A' + MARK + 'B' });
  assert.ok(!w._ok && /within paragraphs only/.test(w.content));
  w = await exec('replace_all', { old_text: 'Image ' + OC, new_text: 'Picture' });
  assert.ok(!w._ok && /embedded object/.test(w.content) && /replace_all cannot re-create/.test(w.content));
  w = await exec('replace_all', { old_text: 'Alpha beta', new_text: 'Alpha beta' });
  assert.ok(!w._ok && /nothing to change/.test(w.content));
  assert.strictEqual(fake.revision, 1); assert.strictEqual(postCount(), 0);
  w = pushTool(await exec('replace_all', { old_text: 'Alpha beta', new_text: 'Omega' }, 'ra1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(postCount(), 1); // one atomic batch
  assert.strictEqual(w._message, 'Replaced 2 × "Alpha beta"');
  assert.strictEqual(w.content, 'Done: replaced 2 occurrences on lines 4, 5.\nLines 4, 5 now:\n4: Omega gamma.\n5: Omega delta.\nThe document now has 10 lines.');
  deq(lastPost(), { requests: [
    { deleteContentRange: { range: { startIndex: 52, endIndex: 62, tabId: 't.0' } } },
    { insertText: { location: { index: 52, tabId: 't.0' }, text: 'Omega' } },
    { deleteContentRange: { range: { startIndex: 34, endIndex: 44, tabId: 't.0' } } },
    { insertText: { location: { index: 34, tabId: 't.0' }, text: 'Omega' } },
  ], writeControl: { requiredRevisionId: 'rev-1' } });
  deq(fake.text('t.0').split('\n').slice(3, 5), ['Omega gamma.', 'Omega delta.']);
  const { anchor: raAnchor, ...raEdit } = w._edit;
  assert.ok(raAnchor);
  deq(raEdit, { id: 'ra1', docId: 'DOC123', tabId: 't.0', kind: 'replace-all', index: 34, text: '', restore: 'Alpha beta', paras: [], find: 'Omega', replace: 'Alpha beta', count: 2, title: 'Replaced 2 × "Alpha beta"', undone: false });
  card = D.toolCardFor({ id: 'ra1', function: { name: 'replace_all', arguments: '{}' } }, w);
  assert.ok(card.innerHTML.includes('<summary>New text</summary><pre>Omega</pre>') && card.innerHTML.includes('data-act="undo-edit" data-edit="ra1"'));
  assert.strictEqual(vm.runInContext('toolCallSummary', sandbox)('replace_all', { old_text: 'lipid raft', new_text: 'membrane raft' }), '"lipid raft" → "membrane raft"');
  // text-based: allowed after an edit in the same response
  w = pushTool(await exec('replace_all', { old_text: 'delta', new_text: 'epsilon' }, 'ra2', true));
  assert.ok(w._ok && w.content.startsWith('Done: replaced 1 occurrence on line 5.\nLines 5 now:\n5: Omega epsilon.'), w.content);
  w = pushTool(await exec('undo_last_edit', {}, 'ra2u'));
  assert.ok(w._ok && w._message === 'Undid: Replaced 1 × "delta"', w.content);
  assert.ok(w.content.startsWith('Done: undid replace_all: 1 occurrence of "epsilon" changed back to "delta".\nLines 5 now:\n5: Omega delta.'), w.content);
  w = pushTool(await exec('undo_last_edit', {}, 'ra1u'));
  assert.ok(w._ok && w.content.includes('Lines 4, 5 now:\n4: Alpha beta gamma.\n5: Alpha beta delta.'), w.content);
  deq(lastPost().requests.map((r) => (r.deleteContentRange ? ['del', r.deleteContentRange.range.startIndex] : ['ins', r.insertText.location.index, r.insertText.text])),
    [['del', 47], ['ins', 47, 'Alpha beta'], ['del', 34], ['ins', 34, 'Alpha beta']]); // "Omega gamma." is 34..46
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // undo refused when the count of new_text changed: one more typed, then one edited away
  await fresh();
  pushTool(await exec('replace_all', { old_text: 'Alpha beta', new_text: 'Omega' }, 'rb1'));
  fake.typeParagraph(0, 'Omega typed by the user');
  let typed = fake.text('t.0');
  w = await exec('undo_last_edit', {}, 'rb1u');
  assert.ok(!w._ok && /"Omega" now occurs 3 times in the document instead of the 2 inserted by that edit/.test(w.content) && /Ctrl\+Z/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0'), typed);
  fake.tabs[0].blocks[0].paras.splice(0, 1); fake.tabs[0].blocks[0].paras[3].text = 'Psi gamma.'; fake.revision++;
  typed = fake.text('t.0');
  w = await exec('undo_last_edit', {}, 'rb1u2');
  assert.ok(!w._ok && /now occurs 1 time in/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0'), typed);
  // undo refused after an empty new_text (the occurrences cannot be found again)
  await fresh();
  w = pushTool(await exec('replace_all', { old_text: 'Alpha beta ', new_text: '' }, 'rc1'));
  assert.ok(w._ok && w._cardLabel === '', w.content);
  deq(fake.text('t.0').split('\n').slice(3, 5), ['gamma.', 'delta.']);
  w = await exec('undo_last_edit', {}, 'rc1u');
  assert.ok(!w._ok && /deleted every occurrence of "Alpha beta "/.test(w.content) && /Ctrl\+Z/.test(w.content), w.content);
  // overlapping matches are taken left to right, without overlap
  await fresh(docSpec({ items: [{ p: 'aaa x aa' }, { p: 'End' }] }));
  w = pushTool(await exec('replace_all', { old_text: 'aa', new_text: 'b' }, 'rd1'));
  assert.ok(w._ok && /replaced 2 occurrences on line 1\./.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[0], 'ba x b');
  // an occurrence on a line with suggested changes: nothing replaced
  await fresh(docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'Suggested words here', suggest: true }, { p: 'Plain words' }] }));
  w = await exec('replace_all', { old_text: 'words', new_text: 'terms' });
  assert.ok(!w._ok && /occurs on line 2, which contains suggested changes/.test(w.content) && /nothing was replaced/.test(w.content), w.content);
  assert.strictEqual(fake.revision, 1);
});

test('inline formatting: runs (UTF-16 offsets, merged), read_formatting, format_text with exact undo and refusals', async () => {
  // --- inline formatting: runs in the line model, read_formatting, format_text with undo
  const FNOTE = vm.runInContext('FORMAT_NOTE', sandbox);
  const B = { bold: true, italic: false, underline: false, link: null };
  const fmtSpec = () => docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: 'abcdefghijkl', fmt: [[0, 5, { bold: true }], [8, 10, { italic: true }]] },
    { p: 'Hi 😀 bold it both link.', fmt: [[6, 10, { bold: true }], [11, 13, { italic: true }], [14, 18, { bold: true, italic: true, underline: true }], [19, 23, { link: 'https://x.org', underline: true }]] },
    { p: 'Merged text', fmt: [[0, 3, { bold: true, italic: true }], [3, 6, { italic: true, bold: true }]] }, // two textRuns, one style
    { p: 'Repeat x' }, { p: 'Repeat x' },
    { p: 'Sugg here', suggest: true },
    { p: 'Image ' + OC + ' done' },
  ] });
  await fresh(fmtSpec());
  assert.strictEqual(fake.render(true).tabs[0].documentTab.body.content[4].paragraph.elements.length, 3); // "Merged", "Merged" again, " text\n"
  // (runs also carry font, weight, size, color, bg and linkRaw: see test/format-reading.test.js)
  const inline = ({ s, e, bold, italic, underline, link }) => ({ s, e, bold, italic, underline, link });
  deq(as.model.lines.map((l) => l.runs.map(inline)), [
    [],
    [{ s: 0, e: 5, ...B }, { s: 8, e: 10, ...B, bold: false, italic: true }],
    [{ s: 6, e: 10, ...B }, { s: 11, e: 13, ...B, bold: false, italic: true }, { s: 14, e: 18, bold: true, italic: true, underline: true, link: null },
      { s: 19, e: 23, bold: false, italic: false, underline: true, link: 'https://x.org' }], // the emoji takes 2 offsets
    [{ s: 0, e: 6, ...B, italic: true }],
    [], [], [], [],
  ]);
  deq(as.model.lines.map((l) => [l.start, l.end]).slice(0, 5), [[1, 6], [7, 19], [20, 44], [45, 56], [57, 65]]);
  // read_formatting: markers nested link > bold > italic > underline; the note first; suggestions flagged
  assert.strictEqual(T.runReadingTool('read_formatting', { start: 2, end: 4 }, as),
    `${FNOTE}\nLines 2-4 of 8:\n2: **abcde**fgh*ij*kl\n3: Hi 😀 **bold** *it* ***__both__*** [link](https://x.org).\n4: ***Merged*** text`);
  assert.ok(T.runReadingTool('read_formatting', { start: 7, end: 7 }, as).endsWith('\n7: Sugg here  [contains suggested changes]'));
  assert.ok(FNOTE.includes('not document text') && FNOTE.includes('old_text'));
  w = await T.executeTool({ id: 'rf1', function: { name: 'read_formatting', arguments: '{"start":2,"end":3}' } }, 'edit', as);
  assert.ok(w._ok && w._reading && w._message === 'lines 2–3' && w.content.startsWith(FNOTE));
  w = await T.executeTool({ id: 'rf2', function: { name: 'read_formatting', arguments: '{"start":1,"end":1,"doc":"doc2"}' } }, 'edit', as);
  assert.strictEqual(w.content, 'Error: read_formatting works only on the main document (omit doc or pass null).');
  assert.strictEqual(T.runReadingTool('read_formatting', { start: 1, end: 1 }, { docText: '# A', docFormat: 'markdown', model: null, lines: null, selection: '' }),
    'Error: formatting is only available when the document is read through the Google Docs API.');
  const mdSnap = T.takeSnapshot(); Object.assign(mdSnap, { docText: '# A', docFormat: 'markdown' });
  assert.ok(!T.toolsFor('edit', mdSnap).some((t) => t.function.name === 'read_formatting'));
  assert.ok(T.toolsFor('manual', as).some((t) => t.function.name === 'read_formatting'));
  const bigModel = D.buildLineModel(fakeDocsServer({ documentId: 'DOCB', title: 'Big', tabs: [{ id: 't.0', title: 'Main',
    items: Array.from({ length: 350 }, (_, i) => ({ p: 'Line ' + i, fmt: [[0, 4, { bold: true }]] })) }] }).render(true), null, 'DOCB');
  const bigOut = T.runReadingTool('read_formatting', { start: 1, end: 350 }, { docText: bigModel.text, docFormat: 'docs-api', model: bigModel, lines: null, selection: '' });
  assert.ok(bigOut.includes('\nLines 1-300 of 350:\n1: **Line** 0\n') && bigOut.endsWith('\n300: **Line** 299\n[Stopped at line 300 (limit per call). Call read_formatting(301, 350) to continue.]'));
  // prompt: the reading-tool line, the writing-tool line and the rule
  const fsys = T.buildRequest('edit', as).body.system[0].text;
  // the notation is described once, in read_formatting's definition; the prompt only states the shared limits
  assert.ok(T.TOOL_DEFS.read_formatting.function.description.includes('**bold**, *italic*, __underline__, [text](url) for links, {text}(font= size= color= bg=)') && !fsys.includes('{text}(font='));
  assert.ok(fsys.includes('read_lines and read_formatting return at most') && fsys.includes('lists and alignment are not shown (read_formatting shows them)'));
  assert.ok(!fsys.includes('- format_text(') && !fsys.includes('- format_lines('));
  assert.ok(fsys.includes('Pass PLAIN TEXT only: no Markdown (no #, **, -, 1. or backticks)') && fsys.includes('To format, use format_text for words and format_lines for whole lines') && fsys.includes('then call format_lines on them'));
  assert.ok(!T.buildRequest('edit', mdSnap).body.system[0].text.includes('read_formatting'));
  assert.ok(T.buildRequest('manual', as).body.system[0].text.includes('read_lines and read_formatting return at most'));
  deq(T.TOOL_DEFS.format_text.function.parameters.required, ['old_text', 'bold', 'italic', 'underline', 'font', 'size', 'color', 'highlight', 'link']);
  deq(T.TOOL_DEFS.format_text.function.parameters.properties.bold.anyOf, [{ type: 'boolean' }, { type: 'null' }]);
  // format_text refusals: nothing written
  w = await exec('format_text', { old_text: 'Merged', bold: null, italic: null, underline: null });
  assert.ok(!w._ok && /pass at least one property that is not null \(bold, italic, underline, font, size, color, highlight, link\)/.test(w.content), w.content);
  w = await exec('format_text', { old_text: 'Repeat x', bold: true, italic: null, underline: null });
  assert.ok(!w._ok && /occurs 2 times \(lines 5, 6\)/.test(w.content) && w._message === 'format_text: the text occurs 2 times', w.content);
  w = await exec('format_text', { old_text: 'Nowhere', bold: true, italic: null, underline: null });
  assert.ok(!w._ok && /not found/.test(w.content) && /formatting markers/.test(w.content));
  w = await exec('format_text', { old_text: '**Nowhere**', bold: false, italic: null, underline: null });
  assert.ok(!w._ok && /not found/.test(w.content));
  w = await exec('format_text', { old_text: 'Sugg', bold: true, italic: null, underline: null });
  assert.ok(!w._ok && /line 7 contains suggested changes/.test(w.content), w.content);
  w = await exec('format_text', { old_text: 'x', bold: 'maybe', italic: null, underline: null });
  assert.strictEqual(w.content, 'Error: bold must be true, false or null (JSON booleans); got the string "maybe"');
  assert.strictEqual(w._message, 'format_text: invalid bold');
  w = await exec('format_text', { old_text: 'x', bold: null, italic: 2, underline: null });
  assert.strictEqual(w.content, 'Error: italic must be true, false or null (JSON booleans); got 2 (number)');
  w = await exec('format_text', { old_text: 7, bold: true });
  assert.ok(!w._ok && /^Error: invalid arguments\. Example: \{"old_text":"lazy dog"/.test(w.content), w.content);
  assert.strictEqual(postCount(), 0);
  // success across two lines: one updateTextStyle, fields of the non-null flags only, writeControl
  w = pushTool(await exec('format_text', { old_text: 'text\nRepeat', bold: true, italic: null, underline: false }, 'f1'));
  assert.ok(w._ok, w.content);
  deq(lastPost(), { requests: [{ updateTextStyle: { range: { startIndex: 52, endIndex: 63, tabId: 't.0' }, textStyle: { bold: true, underline: false }, fields: 'bold,underline' } }],
    writeControl: { requiredRevisionId: 'rev-1' } });
  assert.strictEqual(w.content, `Done: formatted lines 4–5 (bold on, underline off).\n${T.formatNote(as.model)}\nLines 4-5 now:\n4: ***Merged*** **text**\n5: **Repeat** x\nThe document now has 8 lines.`);
  assert.strictEqual(w._message, 'Formatted lines 4–5');
  deq(fake.fmt('t.0').slice(3, 6), [[[0, 6, { bold: true, italic: true }], [7, 11, { bold: true }]], [[0, 6, { bold: true }]], []]);
  assert.strictEqual(fake.text('t.0'), as.model.text); // text unchanged
  const { anchor: fAnchor, ...fEdit } = w._edit;
  assert.ok(fAnchor && fAnchor.revision === 'rev-2');
  deq(fEdit, { id: 'f1', docId: 'DOC123', tabId: 't.0', kind: 'format', index: 52, end: 63, text: 'text\nRepeat', restore: '', paras: [],
    requests: [{ updateTextStyle: { range: { startIndex: 52, endIndex: 63, tabId: 't.0' }, textStyle: {}, fields: 'bold,underline' } }], title: 'Formatted lines 4–5', undone: false });
  deq(JSON.parse(JSON.stringify(w._edit)), w._edit); // plain JSON for the journal
  card = D.toolCardFor({ id: 'f1', function: { name: 'format_text', arguments: '{}' } }, w);
  assert.ok(card.innerHTML.includes('✅ Formatted lines 4–5') && card.innerHTML.includes('<summary>Formatted text</summary><pre>text\nRepeat</pre>') && card.innerHTML.includes('data-edit="f1"'));
  assert.strictEqual(vm.runInContext('toolCallSummary', sandbox)('format_text', { old_text: 'Alpha beta', bold: true, italic: null, underline: false }), '"Alpha beta" (bold on, underline off)');
  assert.strictEqual(vm.runInContext('toolCallSummary', sandbox)('format_text', { old_text: 'Alpha', bold: 'yes', italic: null, underline: null, font: 'Arial', size: '14pt', color: null, highlight: 'none', link: '' }),
    '"Alpha" (bold on, font Arial, size 14pt, highlight none, link removed)');
  assert.strictEqual(vm.runInContext('activityIcon', sandbox)('format_text'), '🖌️');
  assert.strictEqual(vm.runInContext('activityIcon', sandbox)('read_formatting'), '🎨');
  // text-based: allowed after an edit in the same response; an embedded object in the range is fine
  w = pushTool(await exec('format_text', { old_text: 'Image ' + OC + ' done', bold: null, italic: true, underline: null }, 'f2', true));
  assert.ok(w._ok && w.content.includes('\n8: *Image ' + OC + ' done*\n'), w.content);
  w = pushTool(await exec('undo_last_edit', {}, 'f2u'));
  assert.ok(w._ok && w.content.startsWith(`Done: undid formatting of line 8.\n${FNOTE}\nLines 8-8 now:\n8: Image ${OC} done`), w.content);
  w = pushTool(await exec('undo_last_edit', {}, 'f1u'));
  assert.ok(w._ok && w._message === 'Undid: Formatted lines 4–5', w.content);
  assert.ok(w.content.startsWith(`Done: undid formatting of lines 4–5.\n${FNOTE}\nLines 4-5 now:\n4: ***Merged*** text\n5: Repeat x\n`), w.content);
  deq(fmtSpec().tabs[0].items.map((it) => it.p).slice(3, 5), fake.text('t.0').split('\n').slice(3, 5));
  deq(fake.fmt('t.0').slice(3, 6), [[[0, 6, { bold: true, italic: true }]], [], []]);
  // partial range over mixed formatting: undo restores the exact prior state; untouched attributes stay
  w = pushTool(await exec('format_text', { old_text: 'cdefghijk', bold: true, italic: null, underline: null }, 'f3'));
  assert.ok(w._ok, w.content);
  deq(fake.fmt('t.0')[1], [[0, 8, { bold: true }], [8, 10, { italic: true, bold: true }], [10, 11, { bold: true }]]);
  deq(w._edit.requests, [
    { updateTextStyle: { range: { startIndex: 9, endIndex: 12, tabId: 't.0' }, textStyle: { bold: true }, fields: 'bold' } },
    { updateTextStyle: { range: { startIndex: 12, endIndex: 18, tabId: 't.0' }, textStyle: {}, fields: 'bold' } },
  ]);
  assert.ok(w.content.includes('\n2: **abcdefgh*ij*k**l\n'), w.content);
  w = pushTool(await exec('undo_last_edit', {}, 'f3u'));
  assert.ok(w._ok, w.content);
  deq(fake.fmt('t.0')[1], [[0, 5, { bold: true }], [8, 10, { italic: true }]]);
  assert.ok(T.runReadingTool('read_formatting', { start: 2, end: 2 }, as).endsWith('\n2: **abcde**fgh*ij*kl'));
  // a paragraph typed above shifts the indices: the edit is found again by its anchor and undone there
  // (formerly refused; see the anchor relocation in docs-undo.js)
  const fmtOrig = JSON.stringify(fake.fmt('t.0'));
  pushTool(await exec('format_text', { old_text: 'Merged text', bold: null, italic: null, underline: true }, 'f4'));
  fake.typeParagraph(0, 'Typed by the user');
  w = pushTool(await exec('undo_last_edit', {}, 'f4u'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(JSON.stringify(fake.fmt('t.0').slice(1)), fmtOrig);
  // ... but a change right at the formatted text still blocks it
  pushTool(await exec('format_text', { old_text: 'Merged text', bold: null, italic: null, underline: true }, 'f5'));
  const p = fake.tabs[0].blocks[0].paras.find((x) => x.text.endsWith('Merged text'));
  p.text = p.text + '!'; p.chars.push(undefined); fake.revision++;
  const fmtBefore = JSON.stringify(fake.fmt('t.0'));
  w = await exec('undo_last_edit', {}, 'f5u');
  assert.ok(!w._ok && /changed near that edit/.test(w.content) && /Ctrl\+Z/.test(w.content), w.content);
  assert.strictEqual(JSON.stringify(fake.fmt('t.0')), fmtBefore);
});

// ---- prefix/suffix trimming (replacePlan, planReplaceAll)
const del = (s, e) => ({ deleteContentRange: { range: { startIndex: s, endIndex: e, tabId: 't.0' } } });
const ins = (at, text) => ({ insertText: { location: { index: at, tabId: 't.0' }, text } });
const pstyle = (s0, style) => ({ updateParagraphStyle: { range: { startIndex: s0, endIndex: s0 + 1, tabId: 't.0' }, paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } });

test('trimming: only the middle is deleted / inserted; pure insertion and deletion; exact undo', async () => {
  await fresh(); // line 4 "Alpha beta gamma." starts at 34, line 5 "Alpha beta delta." at 52
  w = pushTool(await exec('replace_text', { old_text: 'Alpha beta gamma.', new_text: 'Alpha BETA gamma.' }, 't1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Replaced line 4');
  assert.strictEqual(w.content, 'Done: replaced line 4.\nLines 4-4 now:\n4: Alpha BETA gamma.\nThe document now has 10 lines.');
  deq(lastPost().requests, [del(40, 44), ins(40, 'BETA')]);
  assert.strictEqual(w._edit.index, 40); assert.strictEqual(w._edit.restore, 'beta'); assert.strictEqual(w._edit.text, 'BETA');
  assert.strictEqual(w._cardText, 'Alpha BETA gamma.'); // the card still shows the whole new text
  // pure insertion: nothing is deleted
  w = pushTool(await exec('replace_text', { old_text: 'Alpha beta delta.', new_text: 'Alpha beta and delta.' }, 't2'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [ins(63, 'and ')]);
  deq([w._edit.restore, w._edit.text], ['', 'and ']);
  // pure deletion: nothing is inserted
  w = pushTool(await exec('replace_text', { old_text: 'Alpha BETA gamma.', new_text: 'Alpha gamma.' }, 't3'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [del(40, 45)]);
  deq([w._edit.restore, w._edit.text], ['BETA ', '']);
  deq(fake.text('t.0').split('\n').slice(3, 5), ['Alpha gamma.', 'Alpha beta and delta.']);
  for (const id of ['t3u', 't2u', 't1u']) assert.ok(pushTool(await exec('undo_last_edit', {}, id))._ok, id);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
});

test('trimming across paragraph boundaries keeps the paragraph styles (merge, split; undo)', async () => {
  await fresh();
  // merge "Intro 😀 text." with the heading "Methods": only the newline becomes a space; the merged
  // paragraph keeps the first line's style
  w = pushTool(await exec('replace_text', { old_text: 'text.\nMethods', new_text: 'text. Methods' }, 'b1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._message, 'Replaced lines 2–3');
  deq(lastPost().requests, [del(25, 26), ins(25, ' '), pstyle(25, 'NORMAL_TEXT')]);
  deq(fake.text('t.0').split('\n').slice(1, 3), ['Intro 😀 text. Methods', 'Alpha beta gamma.']);
  deq(fake.styles('t.0').slice(0, 3), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(w._edit.paras, [{ nl: -1, style: 'NORMAL_TEXT' }, { nl: 0, style: 'HEADING_1' }]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'b1u'))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // split a line: only the space becomes a newline; both halves keep the line's style
  w = pushTool(await exec('replace_text', { old_text: 'Methods\nAlpha beta gamma.', new_text: 'Methods\nAlpha beta\ngamma.' }, 'b2'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [del(44, 45), ins(44, '\n'), pstyle(44, 'NORMAL_TEXT'), pstyle(45, 'NORMAL_TEXT')]);
  deq(fake.text('t.0').split('\n').slice(2, 6), ['Methods', 'Alpha beta', 'gamma.', 'Alpha beta delta.']);
  deq(fake.styles('t.0').slice(2, 6), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  assert.ok(w.content.includes('Lines 3-5 now:\n3: Methods\n4: Alpha beta\n5: gamma.'), w.content);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'b2u'))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
  // a whole line removed with the trimmed edges: "Methods\n" is deleted, the next line keeps its style
  w = pushTool(await exec('replace_text', { old_text: 'text.\nMethods\nAlpha', new_text: 'text.\nAlpha' }, 'b3'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [del(26, 34), pstyle(26, 'NORMAL_TEXT')]);
  deq(fake.styles('t.0').slice(0, 3), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'b3u'))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL); deq(fake.styles('t.0'), ORIGINAL_STYLES);
});

test('trimming: a link inside the deleted part is reported; replace_all replaces only the middle', async () => {
  await fresh(docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: 'See the docs here.', fmt: [[8, 12, { link: 'https://ex.com/docs' }]] },
    { p: 'Alpha beta. Alpha beta.' },
    { p: 'Last' },
  ] }));
  // outside the link: no note, the link stays
  w = pushTool(await exec('replace_text', { old_text: 'See the docs here.', new_text: 'Read the docs here.' }, 'l1'));
  assert.ok(w._ok && !/link/.test(w.content), w.content);
  deq(fake.fmt('t.0')[1], [[9, 13, { link: 'https://ex.com/docs' }]]);
  // the linked word itself: the note
  w = pushTool(await exec('replace_text', { old_text: 'the docs here', new_text: 'the manual here' }, 'l2'));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.endsWith('\nNote: the replaced text contained a link (https://ex.com/docs); it was removed and cannot be restored by format_text.'), w.content);
  // replace_all: per occurrence only the changed word, back to front
  w = pushTool(await exec('replace_all', { old_text: 'Alpha beta', new_text: 'Alpha Beta' }, 'l3'));
  assert.ok(w._ok, w.content);
  const l3 = as.model.lines[2].start;
  deq(lastPost().requests, [del(l3 + 18, l3 + 22), ins(l3 + 18, 'Beta'), del(l3 + 6, l3 + 10), ins(l3 + 6, 'Beta')]);
  assert.strictEqual(fake.text('t.0').split('\n')[2], 'Alpha Beta. Alpha Beta.');
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'l3u'))._ok);
  assert.strictEqual(fake.text('t.0').split('\n')[2], 'Alpha beta. Alpha beta.');
  deq(lastPost().requests, [del(l3 + 18, l3 + 22), ins(l3 + 18, 'beta'), del(l3 + 6, l3 + 10), ins(l3 + 6, 'beta')]);
});

test('format_text: flags sent as strings (Qwen-style tool-call parsers) are read as booleans or null', async () => {
  const spec = () => docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'The quick brown fox jumps over the lazy dog.' }] });
  await fresh(spec());
  const style = () => lastPost().requests[0].updateTextStyle;
  // "true" sets, " NULL " and "" leave the attribute out of the request
  w = await exec('format_text', { old_text: 'lazy dog', bold: 'true', italic: ' NULL ', underline: '' });
  assert.ok(w._ok, w.content);
  deq([style().textStyle, style().fields], [{ bold: true }, 'bold']);
  w = await exec('format_text', { old_text: 'quick', bold: 'False', italic: null, underline: 'TRUE' });
  assert.ok(w._ok, w.content);
  deq([style().textStyle, style().fields], [{ bold: false, underline: true }, 'bold,underline']);
  // only "null" strings: nothing to set
  w = await exec('format_text', { old_text: 'quick', bold: 'null', italic: 'null', underline: 'null' });
  assert.ok(!w._ok && /pass at least one property that is not null/.test(w.content), w.content);
  // real booleans unchanged
  w = await exec('format_text', { old_text: 'brown', bold: null, italic: true, underline: false });
  assert.ok(w._ok, w.content);
  deq([style().textStyle, style().fields], [{ italic: true, underline: false }, 'italic,underline']);
  // anything else names the field, the value and its type
  w = await exec('format_text', { old_text: 'quick', bold: 'maybe', italic: null, underline: null });
  assert.strictEqual(w.content, 'Error: bold must be true, false or null (JSON booleans); got the string "maybe"');
  w = await exec('format_text', { old_text: 'quick', bold: null, italic: null, underline: [true] });
  assert.strictEqual(w.content, 'Error: underline must be true, false or null (JSON booleans); got [true] (array)');
});

test('doc: "null" as a string means the main document', async () => {
  await fresh();
  w = await T.executeTool({ id: 'dn1', function: { name: 'read_lines', arguments: '{"start":1,"end":1,"doc":"null"}' } }, 'edit', as);
  assert.ok(w._ok && /^Lines 1-1 of /.test(w.content), w.content);
});

test('format_text / replace_text: markdown markers and quotes around old_text are removed when the text is not found as given', async () => {
  const spec = () => docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'The quick brown fox jumps over the lazy dog.' }, { p: 'A *note* and "quoted" words.' }] });
  const MNOTE = 'Note: formatting markers/quotes were removed from old_text to find it; pass the plain document text next time.';
  for (const old of ['**lazy dog**', "'lazy dog'", '*lazy dog*', '__lazy dog__', '\u00ablazy dog\u00bb', '\u201clazy dog\u201d', '"**lazy dog**"', 'over the **lazy dog**']) {
    await fresh(spec());
    w = await exec('format_text', { old_text: old, bold: true, italic: null, underline: null });
    assert.ok(w._ok, `${old}: ${w.content}`);
    const r = lastPost().requests[0].updateTextStyle.range;
    const text = fake.raw('t.0');
    const want = old.startsWith('over') ? 'over the lazy dog' : 'lazy dog';
    // the range covers exactly the plain text (indices are 1-based offsets + 1 in this one-tab fake)
    assert.strictEqual(r.endIndex - r.startIndex, want.length, old);
    assert.strictEqual(text.slice(r.startIndex - 1, r.endIndex - 1), want, old);
    assert.ok(w.content.endsWith('\n' + MNOTE), w.content);
  }
  // a literal * or quote that the document has matches exactly first (no note)
  await fresh(spec());
  w = await exec('format_text', { old_text: '*note*', bold: true, italic: null, underline: null });
  assert.ok(w._ok && !w.content.includes(MNOTE), w.content);
  assert.strictEqual(lastPost().requests[0].updateTextStyle.range.endIndex - lastPost().requests[0].updateTextStyle.range.startIndex, 6);
  w = await exec('replace_text', { old_text: '"quoted"', new_text: '"cited"' });
  assert.ok(w._ok && !w.content.includes(MNOTE), w.content);
  assert.ok(fake.raw('t.0').includes('A *note* and "cited" words.'), fake.raw('t.0'));
  // replace_text: the same wrapping is dropped from new_text, so no markers land in the document
  await fresh(spec());
  w = await exec('replace_text', { old_text: '**lazy dog**', new_text: '**sleepy cat**' });
  assert.ok(w._ok && w.content.endsWith('\n' + MNOTE), w.content);
  assert.ok(fake.raw('t.0').includes('jumps over the sleepy cat.'), fake.raw('t.0'));
  await fresh(spec());
  w = await exec('replace_text', { old_text: "'quick brown fox'", new_text: 'slow green turtle' });
  assert.ok(w._ok && w.content.endsWith('\n' + MNOTE), w.content);
  assert.ok(fake.raw('t.0').includes('The slow green turtle jumps'), fake.raw('t.0'));
});
