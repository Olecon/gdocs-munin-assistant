'use strict';
// Suggest mode (experiment, docs-write.js): the DOC.md preference "Edits: suggest", the turn-context line, the batch with
// writeMode SUGGEST and requiredRevisionId (and the retry without it after a 400 naming the write control), each covered
// tool producing suggestions in the fake, verification by suggestion ids and the result text, formatting staying direct,
// edits next to and inside a suggested change, undo through deleteSuggestion (and the entries that cannot be undone), the
// suggestion threads in read_document, and the requests Google refuses in suggest mode never sent with the flag.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
require('./lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec, pushTool, lastPost;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});
beforeEach(() => { T.suggestState.noRevision = false; });

// A fresh standard document (docSpec: 4 'Alpha beta gamma.', 5 'Alpha beta delta.', 8 'Details' h2, 10 'Last line')
// whose DOC.md says "Edits: suggest".
async function suggesting(spec, doc = 'Tone: formal.\nEdits: suggest') {
  await fresh(spec);
  as.docInstructions = doc;
}
const posts = () => fake.log.filter((x) => x.method === 'POST').map((x) => x.body);
const gets = () => fake.log.filter((x) => x.method === 'GET').map((x) => x.url);
const line = (n) => fake.text('t.0').split('\n')[n - 1];

test('the preference: an "Edits:" line of DOC.md, the last one wins; the turn context names the mode', async () => {
  for (const [text, want] of [['Edits: suggest', true], ['- edits: Suggestions', true], ['Edits: suggest\nEdits: direct', false], ['', false],
    ['Tone: formal', false], ['Edits suggest', false], ['Notes: Edits: suggest', false], ['Edits: direct\n* Edits: suggesting mode', true]]) {
    assert.strictEqual(T.suggestPreference(text), want, text);
  }
  await suggesting();
  assert.ok((await T.beforeTurnLines('edit', as)).includes('[Edits are written as suggestions (DOC.md "Edits: suggest"): text changes become suggested changes that co-authors accept or reject; formatting, tables and the other parts are written directly.]'));
  as.docInstructions = 'Edits: direct';
  assert.ok(!(await T.beforeTurnLines('edit', as)).some((l) => /suggestions/.test(l) && /Edits/.test(l)));
  // MAIN.md does not switch it: the preference is per document
  as.docInstructions = ''; as.mainInstructions = 'Edits: suggest';
  assert.strictEqual(T.suggestOn(as), false);
});

test('replace_text as a suggestion: writeMode with requiredRevisionId, verified by ids, the lines with the deletion visible; undo deletes it', async () => {
  await suggesting();
  const w = pushTool(await exec('replace_text', { old_text: 'beta gamma.', new_text: 'beta GAMMA.' }, 's1'));
  assert.ok(w._ok, w.content);
  deq(lastPost(), { requests: [
    { deleteContentRange: { range: { startIndex: 45, endIndex: 50, tabId: 't.0' } } },
    { insertText: { location: { index: 45, tabId: 't.0' }, text: 'GAMMA' } },
  ], writeControl: { writeMode: 'SUGGEST', requiredRevisionId: 'rev-1' } });
  // the deleted text stays in the document, marked; the new text goes before it; Google merges the insertion into the
  // deletion next to it (one suggestion, as real Docs: real-docs.js fact 8t)
  assert.strictEqual(line(4), 'Alpha beta GAMMAgamma.');
  deq(fake.suggested('t.0'), [{ id: 'sugg.1', kind: 'ins', text: 'GAMMA' }, { id: 'sugg.1', kind: 'del', text: 'gamma' }]);
  assert.strictEqual(w.content, 'Done: suggested: replace «gamma» with «GAMMA»; the lines now read (the deletion still visible; [-…-] is suggested for deletion, [+…+] for insertion):\n'
    + 'Lines 4-4 now:\n4: Alpha beta [+GAMMA+][-gamma-].  [contains suggested changes]\nThe document has 10 lines. Suggestion sugg.1: a co-author accepts or rejects it.');
  assert.strictEqual(w._message, 'Replaced line 4 (suggested)');
  deq(w._edit, { id: 's1', docId: 'DOC123', tabId: 't.0', kind: 'suggest', ids: ['sugg.1'], title: 'Replaced line 4 (suggested)', undone: false, anchor: false, lines: [4, 4] });
  // the turn's model is the re-read one: the line is flagged, and later line numbers count from it
  assert.strictEqual(as.model.revisionId, 'rev-2'); assert.ok(as.model.lines[3].suggested); assert.strictEqual(state.docText, as.docText);
  deq(as.responseWrite, { from: 4, to: 4 });
  // the threads of these suggestions are listed by read_document like any other
  const r = (await T.executeTool({ id: 'rd', function: { name: 'read_document', arguments: JSON.stringify({ scope: 'all', include: ['comments'], doc: null }) } }, 'edit', as)).content;
  assert.ok(/\[id sugg\.1\] open · line 4 · Ivan \(you\)/.test(r) && !/\[id sugg\.2\]/.test(r), r);
  // undo: deleteSuggestion for its id (no write mode, no revision), checked on a re-read
  const u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  deq(lastPost(), { requests: [{ deleteSuggestion: { suggestionId: 'sugg.1' } }] });
  assert.strictEqual(line(4), 'Alpha beta gamma.');
  deq(fake.suggested('t.0'), []);
  assert.ok(u.content.startsWith('Done: withdrew the suggestion "Replaced line 4 (suggested)".\nLines 4-4 now:\n4: Alpha beta gamma.'), u.content);
  assert.strictEqual(w._edit.undone, true);
});

test('each covered tool writes suggestions: insert_after_line, delete_lines, replace_section, edit_document, replace_all, replace_selection', async () => {
  // insert_after_line: the new lines are real paragraphs (suggested insertions), numbered from the re-read
  await suggesting();
  let w = pushTool(await exec('insert_after_line', { line: 5, text: 'New one\nNew two', style: null }, 'i1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(lastPost().writeControl.writeMode, 'SUGGEST');
  deq(fake.text('t.0').split('\n').slice(4, 7), ['Alpha beta delta.', 'New one', 'New two']);
  deq(fake.suggested('t.0').map((x) => [x.kind, x.text]), [['ins', '\nNew one\nNew two']]);
  assert.ok(w.content.startsWith('Done: suggested: insert «New one ⏎ New two»; the lines now read'), w.content);
  assert.ok(w.content.includes('5: Alpha beta delta.[+¶+]  [contains suggested changes]\n6: [+New one¶+]  [contains suggested changes]\n7: [+New two+]  [contains suggested changes]\nThe document has 12 lines.'), w.content);
  // delete_lines: the lines stay (marked for deletion), so the line count does not change
  await suggesting();
  w = pushTool(await exec('delete_lines', { start: 4, end: 5 }, 'd1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(T.buildLineModel(fake.render(true), 't.0', 'DOC123').lines.length, 10);
  // (line 5 ends before a table, so the newline before line 4 goes instead of line 5's, as for a direct delete)
  deq(fake.suggested('t.0'), [{ id: 'sugg.1', kind: 'del', text: '\nAlpha beta gamma.\nAlpha beta delta.' }]);
  assert.ok(w.content.startsWith('Done: suggested: delete lines 4–5; the lines now read') && w.content.includes('3: Methods[-¶-]') && w.content.includes('4: [-Alpha beta gamma.¶-]')
    && w.content.includes('5: [-Alpha beta delta.-]'), w.content);
  // replace_section: the body's differing paragraphs
  await suggesting(docSpec({ items: [{ p: 'Head', style: 'HEADING_1' }, { p: 'Body one' }, { p: 'Body two' }, { p: 'Next', style: 'HEADING_1' }, { p: 'Tail' }] }));
  w = pushTool(await exec('replace_section', { heading: 'Head', new_text: 'Body one\nBody 2' }, 'rs')); // Auto: no card
  assert.ok(w._ok, w.content);
  deq(fake.suggested('t.0').map((x) => [x.kind, x.text]), [['ins', 'Body 2'], ['del', 'Body two']]);
  assert.ok(/^Done: suggested: replace «Body two» with «Body 2»/.test(w.content) && w.content.includes('3: [+Body 2+][-Body two-]'), w.content);
  // edit_document with text operations only: one suggested batch, bottom-up
  await suggesting();
  w = pushTool(await exec('edit_document', { operations: [
    { op: 'replace', old_text: 'Intro', new_text: 'Preface' }, { op: 'delete', start: 10, end: 10 }, { op: 'insert', line: 3, text: 'Added', style: null },
  ] }, 'ed'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(lastPost().writeControl.writeMode, 'SUGGEST');
  deq(fake.suggested('t.0').map((x) => [x.kind, x.text]), [['ins', 'Preface'], ['del', 'Intro'], ['ins', '\nAdded'], ['del', '\nLast line']]);
  assert.ok(w.content.startsWith('Done: suggested: replace «Intro» with «Preface»; insert «Added»; delete «Last line»; the lines now read'), w.content);
  assert.strictEqual(w._edit.ids.length, 3); // the replace is one suggestion (its insertion merged into its deletion)
  // replace_all: every occurrence
  await suggesting();
  w = pushTool(await exec('replace_all', { old_text: 'Alpha', new_text: 'Omega' }, 'ra'));
  assert.ok(w._ok, w.content);
  deq(fake.suggested('t.0').filter((x) => x.kind === 'ins').map((x) => x.text), ['Omega', 'Omega']);
  assert.ok(w.content.startsWith('Done: suggested: replace 2 × «Alpha» with «Omega»; the lines now read'), w.content);
  // replace_selection through the API
  await suggesting();
  state.selection = 'beta delta';
  const plan = T.planApiSelection('BETA DELTA', as);
  assert.strictEqual(plan.suggest, true);
  w = await T.apiReplaceSelection(plan, as, 'sel');
  assert.ok(w._ok && w._edit.kind === 'suggest', w.content);
  assert.strictEqual(lastPost().writeControl.writeMode, 'SUGGEST');
  assert.strictEqual(line(5), 'Alpha BETA DELTAbeta delta.');
});

test('Google refuses writeMode with requiredRevisionId: one retry without it after a revision check, remembered for the session', async () => {
  await suggesting({ ...docSpec(), suggestNoRevision: true });
  const w = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' });
  assert.ok(w._ok, w.content);
  const ps = posts();
  assert.strictEqual(ps.length, 2);
  deq(ps[0].writeControl, { writeMode: 'SUGGEST', requiredRevisionId: 'rev-1' });
  deq(ps[1].writeControl, { writeMode: 'SUGGEST' });
  assert.ok(gets().some((u) => /\?fields=revisionId$/.test(u)), 'the revision was checked before the retry');
  assert.strictEqual(T.suggestState.noRevision, true);
  // the next suggestion: no requiredRevisionId, a revision check first
  fake.log.length = 0;
  assert.ok((await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }))._ok);
  deq(posts().map((b) => b.writeControl), [{ writeMode: 'SUGGEST' }]);
  assert.ok(/\?fields=revisionId$/.test(gets()[0]));
  // the document changed meanwhile: the revision check refuses, nothing is sent
  fake.typeParagraph(0, 'Typed');
  fake.log.length = 0;
  const stale = await exec('replace_text', { old_text: 'Details', new_text: 'More' });
  assert.ok(!stale._ok && /the document changed after it was read/.test(stale.content), stale.content);
  deq(posts(), []);
});

test('a stale read is not taken for the refused combination; a second refusal is a clear error', async () => {
  // stale: the 400 names no write control and the revision moved: the usual refusal, no retry
  await suggesting();
  fake.typeParagraph(0, 'Typed');
  let w = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' });
  assert.ok(!w._ok && /the document changed after it was read/.test(w.content), w.content);
  assert.strictEqual(posts().length, 1);
  assert.strictEqual(T.suggestState.noRevision, false);
  // the combination is refused and the retry fails too
  await suggesting({ ...docSpec(), suggestNoRevision: true });
  let n = 0;
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    if (/:batchUpdate$/.test(url) && ++n === 2) return { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: { code: 400, message: 'Suggestions are not enabled for this document.' } }) };
    return real(url, init);
  };
  w = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' });
  fake.fetch = real;
  assert.ok(!w._ok && /Suggestions are not enabled/.test(w.content) && /Google Docs refused the edit as a suggestion \(DOC\.md "Edits: suggest"\)/.test(w.content), w.content);
  assert.strictEqual(line(10), 'Last line');
});

test('formatting stays direct with a note; edit_document mixing text and formatting is refused', async () => {
  await suggesting();
  let w = await exec('format_text', { old_text: 'beta gamma', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null });
  assert.ok(w._ok, w.content);
  deq(lastPost().writeControl, { requiredRevisionId: 'rev-1' });
  assert.ok(w.content.endsWith('\nNote: formatting is applied directly, not as a suggestion ("Edits: suggest" covers text changes only).'), w.content);
  assert.strictEqual(w._edit.kind, 'format');
  w = await exec('format_lines', { start: 5, end: 5, style: 'h2', align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null });
  assert.ok(w._ok && /Note: formatting is applied directly/.test(w.content) && !lastPost().writeControl.writeMode, w.content);
  w = await exec('edit_document', { operations: [{ op: 'format_text', old_text: 'Last line', italic: true }] });
  assert.ok(w._ok && /Note: formatting is applied directly/.test(w.content) && !lastPost().writeControl.writeMode, w.content);
  const rev = fake.revision;
  w = await exec('edit_document', { operations: [{ op: 'replace', old_text: 'Intro', new_text: 'Preface' }, { op: 'format_text', old_text: 'Last line', bold: true }] });
  assert.ok(!w._ok && /one edit_document call cannot hold both/.test(w.content), w.content);
  assert.strictEqual(fake.revision, rev);
  // without the preference nothing changes: no note, no write mode
  as.docInstructions = '';
  w = await exec('format_text', { old_text: 'Alpha beta delta', bold: true });
  assert.ok(w._ok && !/Note: formatting/.test(w.content) && !lastPost().writeControl.writeMode, w.content);
  w = await exec('replace_text', { old_text: 'Details', new_text: 'More' });
  assert.ok(w._ok && w._edit.kind === 'replace' && !lastPost().writeControl.writeMode);
});

test('a suggested line: edits outside the suggested change go on as suggestions, inside are refused with the way out', async () => {
  const spec = docSpec({ items: [{ p: 'One two three.' }, { p: 'Second line' }, { p: 'Third', suggest: 'bob1' }] });
  await suggesting(spec);
  // someone else's suggested line (Bob's insertion): the whole line is inside a suggestion
  let w = await exec('replace_text', { old_text: 'Third', new_text: 'Fourth' });
  assert.ok(!w._ok && /line 3 has a suggested change/.test(w.content), w.content);
  assert.ok((await exec('replace_text', { old_text: 'two', new_text: 'TWO' }))._ok);
  // outside the suggestion, same line: allowed, and verified by its own new id (not next to the first one: not merged)
  w = await exec('replace_text', { old_text: 'One', new_text: 'Uno' });
  assert.ok(w._ok, w.content);
  deq(w._edit.ids, ['sugg.2']);
  assert.strictEqual(line(1), 'UnoOne TWOtwo three.');
  // after a suggested line: allowed (its newline is not part of a suggestion)
  w = await exec('insert_after_line', { line: 1, text: 'Between', style: null });
  assert.ok(w._ok, w.content);
  // inside: refused with the way out
  w = await exec('replace_text', { old_text: 'TWOtwo', new_text: 'two' });
  assert.ok(!w._ok, w.content);
  assert.strictEqual(w.content, 'Error: line 1 has a suggested change at that place, which cannot be edited until it is accepted or rejected: accept or reject it with the comment tool (its id from read_document include ["comments"]) or in Google Docs, or edit text outside the suggested change');
  w = await exec('delete_lines', { start: 1, end: 1 });
  assert.ok(!w._ok && /line 1 has a suggested change at that place/.test(w.content), w.content);
  // without suggest mode the whole line is refused as before
  as.docInstructions = '';
  w = await exec('replace_text', { old_text: 'three', new_text: '3' });
  assert.ok(!w._ok && /contains suggested changes \(suggesting mode\)/.test(w.content), w.content);
});

test('undo: Undo all over suggestions; a suggestion settled meanwhile; entries that cannot be undone', async () => {
  await suggesting();
  pushTool(await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }, 'u1'));
  pushTool(await exec('delete_lines', { start: 10, end: 10 }, 'u2'));
  // what Undo all runs once its card is confirmed (the card's dry run leaves registered kinds unchecked)
  const list = T.answerEdits('u2');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(T.dryUndo(list[0]._edit, {}), 'unchecked');
  await T.applyUndoAll(list, null);
  deq(fake.suggested('t.0'), []);
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'Intro 😀 text.');
  assert.ok(state.messages.every((m) => !m._edit || m._edit.undone));
  // a co-author accepted it meanwhile: nothing to undo from the panel
  await suggesting();
  pushTool(await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }, 'u3'));
  fake.settleSuggestion('sugg.1', true);
  let u = await exec('undo_last_edit', {});
  assert.ok(!u._ok && /no longer in the document \(a co-author accepted or rejected it\)/.test(u.content), u.content);
  // one of two settled (two changes apart from each other: two suggestions): the rest is withdrawn, with a note
  await suggesting();
  pushTool(await exec('edit_document', { operations: [{ op: 'replace', old_text: 'Intro', new_text: 'Preface' }, { op: 'delete', start: 10, end: 10 }] }, 'u4'));
  fake.settleSuggestion(fake.suggested('t.0').find((x) => x.text === 'Preface').id, false); // the replace rejected: "Intro" stays
  u = await exec('undo_last_edit', {});
  assert.ok(u._ok && /Note: 1 of its 2 suggested changes had been accepted or rejected already/.test(u.content), u.content);
  assert.strictEqual(line(2), 'Intro 😀 text.');
  // the re-read fails and the reply named no ids: not undoable, says how to remove it
  await suggesting({ ...docSpec(), suggestNoIds: true });
  fake.failReads = 1;
  let w = pushTool(await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }, 'u5'));
  assert.ok(w._ok && /not verified/.test(w.content) && /It cannot be undone from the panel: reject the suggestion in Google Docs or with the comment tool\./.test(w.content), w.content);
  assert.strictEqual(w._edit.undoable, false); deq(w._edit.ids, []);
  u = await exec('undo_last_edit', {});
  assert.strictEqual(u.content, 'Error: the latest change (Replaced line 2 (suggested)) cannot be undone from the panel; nothing was undone. Tell the user to use Undo (Ctrl+Z) in Google Docs.');
  // the re-read fails but the reply named the ids: undoable by them
  await suggesting();
  fake.failReads = 1;
  w = pushTool(await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }, 'u6'));
  assert.ok(w._ok && !/cannot be undone/.test(w.content), w.content);
  deq(w._edit.ids, ['sugg.1']); // created by the deletion; the insertion was merged into it
  assert.ok((await exec('undo_last_edit', {}))._ok);
  assert.strictEqual(line(2), 'Intro 😀 text.');
  // an entry without ids refuses with the advice (a stored one, e.g.)
  await assert.rejects(T.undoEdit({ kind: 'suggest', ids: [], docId: 'DOC123', tabId: 't.0', title: 'x' }), /reject the suggestion in Google Docs or with the comment tool/);
});

test('a suggestion Google merges into the earlier one next to it: reported as a suggestion with that id, not undoable on its own', async () => {
  await suggesting();
  const w1 = pushTool(await exec('insert_after_line', { line: 5, text: 'New one', style: null }, 'm1'));
  deq(fake.suggested('t.0').map((x) => [x.id, x.text]), [['sugg.1', '\nNew one']]);
  // the formatting sheet's style requests name suggested style changes of their own: not text the document shows, no note
  assert.ok(fake.log.filter((x) => x.method === 'POST').pop().body.requests.some((q) => q.updateTextStyle), 'the sheet wrote');
  assert.ok(w1.content.endsWith('Suggestion sugg.1: a co-author accepts or rejects it.'), w1.content);
  deq(w1._edit.ids, ['sugg.1']);
  // the next paragraph right after it: the fake (as Google) merges it into sugg.1 and says so in the reply
  const w = pushTool(await exec('insert_after_line', { line: 6, text: 'New two', style: null }, 'm2'));
  assert.ok(w._ok, w.content);
  deq(fake.suggested('t.0').map((x) => [x.id, x.text]), [['sugg.1', '\nNew one\nNew two']]);
  assert.ok(!/applied this edit directly/.test(w.content), w.content);
  assert.ok(w.content.startsWith('Done: suggested: insert «New two»; the lines now read'), w.content);
  assert.ok(w.content.endsWith('The document has 12 lines. Suggestion sugg.1: a co-author accepts or rejects it.\nNote: Google Docs merged this edit into the earlier suggestion sugg.1 next to it, so the panel cannot undo it on its own.'), w.content);
  deq([w._edit.kind, w._edit.ids, w._edit.merged, w._edit.undoable], ['suggest', [], ['sugg.1'], false]);
  // undo_last_edit refuses (withdrawing sugg.1 would take the first paragraph too); nothing is sent
  const posts0 = fake.log.filter((x) => x.method === 'POST').length;
  const u = await exec('undo_last_edit', {});
  assert.strictEqual(u.content, 'Error: the latest change (Inserted after line 6 (suggested)) cannot be undone from the panel; nothing was undone. Tell the user to use Undo (Ctrl+Z) in Google Docs.');
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, posts0);
  // the fake's reply: updatedSummarySuggestionIds for a merged request, createdSuggestionIds for a new one
  const res = await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1, tabId: 't.0' }, text: 'X' } }, { insertText: { location: { index: 2, tabId: 't.0' }, text: 'Y' } }], writeControl: { writeMode: 'SUGGEST' } }) });
  deq((await res.json()).suggestionResponses, [{ createdSuggestionIds: ['sugg.2'] }, { updatedSummarySuggestionIds: ['sugg.2'] }]);
});

test('Google ignores the write mode: the edit is reported and journaled as the direct edit it is', async () => {
  await suggesting({ ...docSpec(), suggestIgnored: true });
  const w = pushTool(await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' }, 'g1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(line(10), 'Final line');
  assert.ok(w.content.endsWith('\nNote: Google Docs applied this edit directly, not as a suggestion; tell the user.'), w.content);
  assert.strictEqual(w._edit.kind, 'replace');
  assert.ok((await exec('undo_last_edit', {}))._ok);
  assert.strictEqual(line(10), 'Last line');
});

test('the requests Google refuses in suggest mode never get the flag', async () => {
  for (const k of ['addDocumentTab', 'createNamedRange', 'deleteFooter', 'deleteHeader', 'deleteNamedRange', 'deleteTab', 'updateDocumentTabProperties', 'updateTableColumnProperties']) {
    assert.strictEqual(T.refusedInSuggest([{ insertText: {} }, { [k]: {} }]), k);
  }
  assert.strictEqual(T.refusedInSuggest([{ updateDocumentStyle: { fields: 'documentFormat' } }]), 'updateDocumentStyle');
  assert.strictEqual(T.refusedInSuggest([{ updateDocumentStyle: { fields: 'marginTop' } }, { deleteContentRange: {} }]), '');
  await suggesting();
  await assert.rejects(T.suggestBatchUpdate(as.model, [{ deleteHeader: { headerId: 'h' } }]), (e) => e.preSend && /deleteHeader cannot be written as a suggestion/.test(e.message));
  deq(posts(), []);
  // the other modules' writes (tables, page parts, named styles, comments) go through docsBatchUpdate: never a write mode
  await T.docsBatchUpdate(as.model, [{ insertText: { location: { index: 1, tabId: 't.0' }, text: 'x' } }]);
  deq(lastPost().writeControl, { requiredRevisionId: 'rev-1' });
});
