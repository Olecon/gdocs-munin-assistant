'use strict';
// The comment tool (docs-comment-write.js) and the suggestion threads in read_document include "comments"
// (docs-comments.js): reading suggestions with their lines, each action's request shape (its own batch), the delete card
// (unless the message asked), the accept card over 5, commentUpdateState and the re-read check, undo of add / reply /
// resolve, the refreshed model after accept, and when the tool is offered (threads, a mention, neither).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
require('./lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, ident;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// The standard document's lines (docSpec): 4 'Alpha beta gamma.', 5 'Alpha beta delta.', 6 'Cell A', 10 'Last line'.
const baseModel = () => T.buildLineModel(fakeDocsServer(docSpec()).render(true), 't.0', 'DOC123');
const L = (n) => baseModel().lines[n - 1];
// c1: Anna's open thread on lines 4-5 with my reply; c2: my own resolved thread on line 6; c3: my open thread on line 10.
const threads = () => [
  { id: 'c1', status: 'open', start: L(4).start + 6, end: L(5).start + 5, quoted: 'beta gamma.\nAlpha', author: 'Anna K.', text: 'Too vague.',
    replies: [{ author: { displayName: 'Ivan', me: true }, text: 'Fixed' }, { author: { displayName: 'Ivan', me: true }, text: '', action: 'RESOLVE' }] },
  { id: 'c2', status: 'resolved', start: L(6).start, end: L(6).end, quoted: 'Cell A', author: { displayName: 'Ivan', me: true }, text: 'Rename' },
  { id: 'c3', status: 'open', start: L(10).start, end: L(10).end, quoted: 'Last line', author: { displayName: 'Ivan', me: true }, text: 'Check' },
];
// Line 4 a suggested insertion s1 by Bob, line 6 (a table cell) s2; s9 an accepted one.
const withSuggestions = (comments = threads(), extra = []) => {
  const spec = docSpec({ items: [
    { p: 'Report 📊', style: 'TITLE' }, { p: 'Intro 😀 text.' }, { p: 'Methods', style: 'HEADING_1' },
    { p: 'Alpha beta gamma.', suggest: 's1' }, { p: 'Alpha beta delta.' },
    { table: [[[{ p: 'Cell A', suggest: 's2' }], [{ p: 'Cell B' }]]] },
    { p: 'Details', style: 'HEADING_2' }, { p: 'Image ' + String.fromCharCode(0xFFFC) + ' done' }, { p: 'Last line' },
  ] });
  return { ...spec, comments, suggestions: [{ id: 's1', author: 'Bob', summary: 'Add: "Alpha beta gamma."' }, { id: 's2', author: 'Carol', summary: 'Add: "Cell A"' },
    { id: 's9', status: 'accepted', author: 'Bob', summary: 'Delete: "old"' }, ...extra] };
};
const ARGS = { ids: null, text: null, old_text: null, lines: null, assignee: null };
const cmt = (args, id) => exec('comment', { ...ARGS, ...args }, id);
const lastPost = () => fake.log.filter((x) => x.method === 'POST').pop().body;
const posts = () => fake.log.filter((x) => x.method === 'POST');
const cards = () => [...T.pendingPreviews.entries()];
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the card');
  const [[id, p]] = cards();
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}
// The turn's user message (the delete card reads it) and an offered tool (beforeTurn decides).
const userSays = (text) => { as.chatCtx = { docId: 'DOC123', chatId: null, messages: [{ role: 'user', content: text }] }; };
async function turnStart(text = 'Hi', mode = 'edit') {
  T.addUserBubble(text);
  userSays(text);
  return T.beforeTurnLines(mode, as);
}

test('reading: suggestion threads after the comment threads, with ids, status, author, summary and lines; status and range filters', async () => {
  await fresh(withSuggestions());
  const r = await T.readComments({ status: 'all', lines: null }, as);
  assert.strictEqual(r, '3 comment threads:\n' +
    '[id c1] open · lines 4–5 «beta gamma. Alpha» · Anna K. · 2026-10-20: Too vague.\n  ↳ [reply c1.p1] Ivan (you) · 2026-10-20: Fixed\n  ↳ Ivan (you) · 2026-10-20: [resolved]\n' +
    '[id c3] open · line 10 «Last line» · Ivan (you) · 2026-10-20: Check\n' +
    '[id c2] resolved · line 6 «Cell A» · Ivan (you) · 2026-10-20: Rename\n' +
    '3 suggested changes:\n' +
    '[id s1] open · line 4 · Bob · 2026-10-20: Add: "Alpha beta gamma."\n' +
    '[id s2] open · line 6 · Carol · 2026-10-20: Add: "Cell A"\n' +
    '[id s9] accepted · not in the text · Bob · 2026-10-20: Delete: "old"');
  assert.strictEqual(await T.readComments({ status: 'open', lines: '6' }, as), '1 open suggested change in line 6:\n[id s2] open · line 6 · Carol · 2026-10-20: Add: "Cell A"');
  assert.ok((await T.readComments({ status: 'resolved', lines: null }, as)).endsWith('1 accepted or rejected suggested change:\n[id s9] accepted · not in the text · Bob · 2026-10-20: Delete: "old"'));
  // the line model still flags the suggested lines; the same GET gave the suggestions (one read per turn)
  deq(as.model.lines.filter((l) => l.suggested).map((l) => l.line), [4, 6]);
  assert.strictEqual(fake.log.filter((x) => x.method === 'GET' && /commentsViewMode=/.test(x.url)).length, 1);
  // only suggestions: no "No comments" line
  await fresh({ ...withSuggestions([]) });
  assert.ok((await T.readComments({ status: 'open', lines: null }, as)).startsWith('2 open suggested changes:\n[id s1] open · line 4'));
});

test('offer: threads or suggestions in the document, or a message about comments / review (English, Russian); neither: not offered', async () => {
  const offered = () => T.toolsFor('edit', as).some((t) => t.function.name === 'comment');
  await fresh(docSpec());
  await turnStart('Fix the typo in line 4');
  assert.ok(!offered());
  assert.ok(!T.buildTurnContext('edit', as, null).includes('[Comments:'));
  for (const text of ['Answer the reviewers', 'Resolve the comments', 'Ответь на комментарии', 'Учти замечания рецензента', 'Прими все предложенные изменения']) {
    as = T.takeSnapshot(); T.snapshotDocument(as);
    await turnStart(text);
    assert.ok(offered(), text);
  }
  assert.ok(T.buildTurnContext('edit', as, null).includes('[Comments: 0 open threads, 0 open suggested changes.]'));
  // threads present: offered with any message; the note counts them; the read-only chat turn: never
  await fresh(withSuggestions());
  await turnStart('Shorten line 5');
  assert.ok(offered());
  assert.ok(T.buildTurnContext('edit', as, null).includes('[Comments: 2 open threads, 2 open suggested changes.]'));
  assert.ok(T.buildSystemParts('edit', 1e5, as).head.includes('- Comments and suggested changes: read them with read_document include ["comments"], then reply, resolve, accept or reject with comment'));
  as = T.takeSnapshot(); T.snapshotDocument(as);
  await turnStart('Shorten line 5', 'manual');
  assert.ok(!T.toolsFor('manual', as).some((t) => t.function.name === 'comment'));
  // only resolved threads: not offered
  await fresh({ ...docSpec(), comments: [{ id: 'r1', status: 'resolved', start: L(4).start, end: L(4).end, text: 'old' }] });
  await turnStart('Shorten line 5');
  assert.ok(!offered());
  // the comments view refused: the lines with suggestions still offer it
  await fresh(withSuggestions());
  fake.commentsUnsupported = true;
  await turnStart('Shorten line 5');
  assert.ok(offered());
  assert.ok(!T.buildTurnContext('edit', as, null).includes('[Comments:'));
  // a definition with nullable optional fields; the regexes
  const def = T.COMMENT_TOOL.function;
  deq(def.parameters.required, ['action', 'ids', 'text', 'old_text', 'lines', 'assignee']);
  assert.ok(T.commentsMentioned('Look at the suggested changes') && !T.commentsMentioned('Suggest a better title'));
  assert.ok(T.deleteCommentsAsked('Delete my comments on line 3') && T.deleteCommentsAsked('удали все комментарии') && !T.deleteCommentsAsked("Don't delete the comments") && !T.deleteCommentsAsked('Delete line 3'));
});

test('add: one insertComment batch on old_text or lines (with the revision), an assignee; errors; the new id; undo deletes the thread', async () => {
  await fresh(withSuggestions());
  await turnStart('Comment on the methods');
  let r = await cmt({ action: 'add', text: 'Needs a citation', old_text: 'beta delta' });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Done: added comment [id new1] on line 5.');
  const body = lastPost();
  deq(body.requests, [{ insertComment: { content: 'Needs a citation', range: { startIndex: L(5).start + 6, endIndex: L(5).start + 16, tabId: 't.0' } } }]);
  assert.ok(body.writeControl && body.writeControl.requiredRevisionId);
  deq([r._edit.kind, r._edit.title, r._edit.undoable], ['comment', 'Comment on line 5', undefined]);
  pushTool(r);
  assert.ok((await T.readComments({ status: 'open', lines: '5' }, as)).includes('[id new1] open · line 5 «beta delta» · Ivan (you)'));
  // lines and an assignee
  r = await cmt({ action: 'add', text: 'Whole section', lines: '4-5', assignee: 'bob@example.com' });
  assert.ok(r._ok, r.content);
  deq(lastPost().requests[0].insertComment, { content: 'Whole section', range: { startIndex: L(4).start, endIndex: L(5).end, tabId: 't.0' }, assigneeEmailAddress: 'bob@example.com' });
  pushTool(r);
  // errors: nothing sent
  const n = posts().length;
  for (const [args, re] of [
    [{ action: 'add', text: 'x', old_text: 'Alpha' }, /old_text occurs 2 times \(lines 4, 5\)/],
    [{ action: 'add', text: 'x', old_text: 'no such words here' }, /old_text was not found/],
    [{ action: 'add', text: 'x' }, /add needs old_text \(the text to comment on\) or lines/],
    [{ action: 'add', text: '', old_text: 'gamma' }, /add needs text/],
    [{ action: 'add', text: 'x', lines: '99' }, /lines must be within 1-10/],
    [{ action: 'add', text: 'x', old_text: 'gamma', assignee: 'bob' }, /assignee must be an email address/],
    [{ action: 'add', text: 'ж'.repeat(1100), old_text: 'gamma' }, /too long for a comment \(at most 2048 bytes\)/],
    [{ action: 'shout' }, /action must be one of add, reply/],
  ]) {
    const e = await cmt(args);
    assert.ok(!e._ok && re.test(e.content), e.content);
  }
  assert.strictEqual(posts().length, n);
  // undo_last_edit: the newest (lines 4-5) thread is deleted, then the first
  let u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: deleted the comment [id new2] on lines 4–5.'), u.content);
  deq(lastPost().requests, [{ deleteComment: { commentId: 'new2' } }]);
  u = await exec('undo_last_edit', {});
  assert.ok(u.content.startsWith('Done: deleted the comment [id new1] on line 5.'), u.content);
  deq(fake.comments.map((c) => c.id), ['c1', 'c2', 'c3']);
});

test('reply, resolve, reopen: request shapes, already-done ids, suggestion threads; undo: delete the reply, reopen with the note', async () => {
  await fresh(withSuggestions());
  await turnStart('Answer the reviewers');
  let r = await cmt({ action: 'reply', ids: ['[id c1]'], text: 'Clarified in line 4.' });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Done: replied to [id c1] (reply c1.p3).');
  deq(lastPost(), { requests: [{ addCommentReply: { commentId: 'c1', post: { content: 'Clarified in line 4.' } } }] }); // no writeControl: by id
  pushTool(r);
  // a reply on a suggestion thread
  r = await cmt({ action: 'reply', ids: ['s1'], text: 'Why?' });
  assert.ok(r._ok, r.content);
  deq(lastPost().requests, [{ addCommentReply: { suggestionId: 's1', post: { content: 'Why?' } } }]);
  pushTool(r);
  // resolve two (c2 is resolved already) with a text
  r = await cmt({ action: 'resolve', ids: ['c1', 'c2', 'c3'], text: 'Done.' });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Done: resolved [id c1], [id c3]. [id c2] was already resolved.');
  deq(lastPost().requests, [{ addCommentReply: { commentId: 'c1', post: { commentAction: 'RESOLVE', content: 'Done.' } } },
    { addCommentReply: { commentId: 'c3', post: { commentAction: 'RESOLVE', content: 'Done.' } } }]);
  deq(fake.comments.map((c) => c.status), ['resolved', 'resolved', 'resolved']);
  pushTool(r);
  let e = await cmt({ action: 'resolve', ids: ['c2'] });
  deq([e._ok, e.content], [true, 'No change: [id c2] was already resolved.']);
  e = await cmt({ action: 'resolve', ids: ['s1'] });
  assert.ok(!e._ok && /s1 is a suggested change: use accept or reject/.test(e.content));
  e = await cmt({ action: 'reply', ids: ['c1', 'c3'], text: 'x' });
  assert.ok(!e._ok && /reply takes one thread id/.test(e.content));
  e = await cmt({ action: 'reopen', ids: ['zz'] });
  assert.ok(!e._ok && /no comment, reply or suggested change with the id "zz"/.test(e.content));
  // undo of resolve: REOPEN replies; the note says both entries stay
  let u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: reopened [id c1], [id c3] again.\nNote: the threads show both entries ("resolved", then "reopened"); Google Docs keeps them.'), u.content);
  deq(lastPost().requests, [{ addCommentReply: { commentId: 'c1', post: { commentAction: 'REOPEN' } } }, { addCommentReply: { commentId: 'c3', post: { commentAction: 'REOPEN' } } }]);
  deq(fake.comments.map((c) => c.status), ['open', 'resolved', 'open']);
  // undo of the suggestion reply, then the comment reply
  u = await exec('undo_last_edit', {});
  assert.ok(u.content.startsWith('Done: deleted the reply s1.p1 in [id s1]'), u.content);
  deq(lastPost().requests, [{ deleteCommentReply: { suggestionId: 's1', postId: 's1.p1' } }]);
  u = await exec('undo_last_edit', {});
  deq(lastPost().requests, [{ deleteCommentReply: { commentId: 'c1', postId: 'c1.p3' } }]);
  assert.ok(!(await T.readComments({ status: 'all', lines: null }, as)).includes('Clarified'));
  // reopen
  r = await cmt({ action: 'reopen', ids: ['c2'] });
  assert.ok(r._ok, r.content);
  deq(lastPost().requests, [{ addCommentReply: { commentId: 'c2', post: { commentAction: 'REOPEN' } } }]);
});

test('delete: a card every time (Allow all does not cover it) unless the message asks to delete comments; own threads and replies only; not undoable', async () => {
  await fresh(withSuggestions());
  await turnStart('Tidy up');
  // a card; Deny sends nothing
  const n = posts().length;
  let d = await decided(cmt({ action: 'delete', ids: ['c3'] }), 'reject');
  assert.ok(!d.r._ok && d.r._decision === 'rejected');
  assert.ok(d.html.includes('Delete 1 comment thread? This cannot be undone from the panel.') && d.html.includes('[id c3] Check'), d.html);
  assert.strictEqual(posts().length, n);
  // Allow all in this turn does not skip the next delete card
  d = await decided(cmt({ action: 'delete', ids: ['c1.p1'] }), 'accept-all');
  assert.ok(d.r._ok, d.r.content);
  deq(lastPost().requests, [{ deleteCommentReply: { commentId: 'c1', postId: 'c1.p1' } }]);
  d = await decided(cmt({ action: 'delete', ids: ['c3', 'c2'] }), 'accept');
  assert.strictEqual(d.r.content, 'Done: deleted 2 comment threads (c3, c2). This cannot be undone from the panel.');
  deq(lastPost().requests, [{ deleteComment: { commentId: 'c3' } }, { deleteComment: { commentId: 'c2' } }]);
  deq([d.r._edit.kind, d.r._edit.undoable], ['comment', false]);
  pushTool(d.r);
  assert.ok(!(await exec('undo_last_edit', {}))._ok);
  // refused before any card: someone else's thread, a reply with an action, a suggestion
  for (const [ids, re] of [[['c1'], /only the author can delete a comment, and \[id c1\] is by Anna K\.: resolve it instead/],
    [['c1.p2'], /the reply c1\.p2 cannot be deleted/], [['s1'], /s1 is a suggested change: use reject/]]) {
    const e = await cmt({ action: 'delete', ids });
    assert.ok(!e._ok && re.test(e.content), e.content);
    assert.strictEqual(T.pendingPreviews.size, 0);
  }
  // the message asked: no card
  await fresh(withSuggestions());
  await turnStart('Delete my comment on the last line');
  const r = await cmt({ action: 'delete', ids: ['c3'] });
  assert.ok(r._ok && r._decision === undefined, r.content);
  deq(fake.comments.map((c) => c.id), ['c1', 'c2']);
  // but a tainted turn still asks
  as.tainted = true;
  d = await decided(cmt({ action: 'delete', ids: ['c2'] }), 'reject');
  assert.ok(!d.r._ok);
});

test('accept / reject: one batch, the model read again (the lines are editable), the next line-number write refused; over 5 ids a card', async () => {
  await fresh(withSuggestions());
  await turnStart('Accept the suggestions');
  const before = as.model;
  assert.ok(/suggested changes/.test((await exec('replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' })).content));
  let r = await cmt({ action: 'accept', ids: ['s1', 's9'] });
  assert.ok(r._ok, r.content);
  assert.ok(r.content.startsWith('Done: accepted 1 suggested change (s1) on line 4. [id s9] is no longer open. This cannot be undone from the panel: use Ctrl+Z in Google Docs if needed.\nLines 4-4 now:\n4: Alpha beta gamma.'), r.content);
  deq(lastPost(), { requests: [{ acceptSuggestion: { suggestionId: 's1' } }] });
  assert.notStrictEqual(as.model, before);
  deq(as.model.lines.filter((l) => l.suggested).map((l) => l.line), [6]);
  deq([r._edit.undoable, r._edit.title], [false, 'Accept 1 suggested change']);
  // the next write of the same response with line numbers is refused; a new response may edit line 4
  assert.ok(/line numbers changed after the previous edit/.test((await exec('delete_lines', { start: 9, end: 9 }, null, true)).content));
  const w = await exec('replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' });
  assert.ok(w._ok, w.content);
  // reject removes the suggested text
  r = await cmt({ action: 'reject', ids: ['s2'] });
  assert.ok(r._ok, r.content);
  deq(lastPost().requests, [{ rejectSuggestion: { suggestionId: 's2' } }]);
  assert.strictEqual(as.model.lines[5].text, '');
  // errors
  let e = await cmt({ action: 'accept', ids: ['c1'] });
  assert.ok(!e._ok && /c1 is a comment thread, not a suggested change: use resolve/.test(e.content));
  e = await cmt({ action: 'accept', ids: ['s1'] });
  deq([e._ok, e.content], [true, 'No change: [id s1] is no longer open.']);
  // six suggestions: a card like Undo all; five: none
  const many = Array.from({ length: 6 }, (_, i) => ({ p: `Para ${i}`, suggest: `m${i}` }));
  await fresh({ ...docSpec({ items: many }) });
  await turnStart('Accept all');
  const d = await decided(cmt({ action: 'reject', ids: many.map((x) => x.suggest) }), 'accept');
  assert.ok(d.r._ok, d.r.content);
  assert.ok(d.html.includes('Rejects 6 suggested changes. This cannot be undone from the panel (Ctrl+Z in Google Docs can).'), d.html);
  // every suggestion whole, no cut
  assert.ok(d.html.includes('[id m0] Add: &quot;Para 0&quot;\n') && d.html.includes('[id m5] Add: &quot;Para 5&quot;</pre>') && !d.html.includes('…'), d.html);
  await fresh({ ...docSpec({ items: many }) });
  await turnStart('Accept all');
  r = await cmt({ action: 'accept', ids: many.slice(0, 5).map((x) => x.suggest) });
  assert.ok(r._ok && r._decision === undefined, r.content);
  assert.strictEqual(lastPost().requests.length, 5);
});

test('Manual asks before every comment write (an added comment shows its whole text); Auto adds one without a card, in a tainted turn too', async () => {
  await fresh(withSuggestions());
  await turnStart('Comment on it');
  const long = 'Please check this claim against the cited source. '.repeat(10).trim();
  as.tainted = true; // the panel can undo an added comment: no card in Auto
  let r = await cmt({ action: 'add', old_text: 'beta gamma', text: 'A short note.' });
  assert.ok(r._ok && r._decision === undefined, r.content);
  as.tainted = false;
  as.askEdits = true;
  const d = await decided(cmt({ action: 'add', old_text: 'beta gamma', text: long }), 'reject');
  assert.ok(!d.r._ok && d.r._decision === 'rejected');
  assert.ok(d.html.includes('<div class="pv-note">Adds a comment.</div><div class="pv-anchor">line 4</div>') && d.html.includes(`<pre>${long}</pre>`), d.html);
  // five suggestions: Manual asks; the card says the panel cannot undo it
  const many = Array.from({ length: 5 }, (_, i) => ({ p: `Para ${i}`, suggest: `m${i}` }));
  await fresh({ ...docSpec({ items: many }) });
  await turnStart('Accept all');
  as.askEdits = true;
  const d2 = await decided(cmt({ action: 'accept', ids: many.map((x) => x.suggest) }), 'accept');
  assert.ok(d2.r._ok, d2.r.content);
  assert.ok(d2.html.includes('Accepts 5 suggested changes. This cannot be undone from the panel (Ctrl+Z in Google Docs can).'), d2.html);
});

test('verification: commentUpdateState other than ALL_SAVED fails; a change the re-read does not show fails; a failed batch; the comments unreadable', async () => {
  await fresh(withSuggestions());
  await turnStart('Resolve the comments');
  fake.commentFail = true;
  let r = await cmt({ action: 'resolve', ids: ['c1'] });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: Google Docs did not save the change (commentUpdateState ALL_FAILED_UNKNOWN_REASON). Read the comments again with read_document include ["comments"] and try once more; if it fails again, tell the user to do it in Google Docs.');
  assert.strictEqual(r._edit, undefined);
  fake.commentFail = false;
  fake.commentNoop = true; // saved, says Google, but nothing changed
  r = await cmt({ action: 'resolve', ids: ['c1'] });
  assert.ok(!r._ok && r.content.startsWith('Error: Google Docs answered, but the comment [id c1] is still open.'), r.content);
  r = await cmt({ action: 'add', text: 'x', old_text: 'gamma' });
  assert.ok(!r._ok && r.content.startsWith('Error: Google Docs answered, but the new comment is not in the document.'), r.content);
  fake.commentNoop = false;
  fake.suggestionNoop = true;
  r = await cmt({ action: 'accept', ids: ['s1'] });
  assert.ok(!r._ok && r.content.startsWith('Error: Google Docs answered, but the suggested change [id s1] is still open.'), r.content);
  fake.suggestionNoop = false;
  // a failed batch (400): nothing changed, the next step named
  fake.failNext = { status: 400, message: 'Invalid requests[0].addCommentReply' };
  r = await cmt({ action: 'resolve', ids: ['c1'] });
  assert.ok(!r._ok && /^Error: the comment change was not made \(.*Invalid requests\[0\]\.addCommentReply.*\)\. Read the comments again/.test(r.content), r.content);
  // the comments cannot be read: nothing is sent
  const n = posts().length;
  as.comments = null;
  fake.commentsUnsupported = true;
  r = await cmt({ action: 'resolve', ids: ['c1'] });
  assert.ok(!r._ok && /could not read the comments .*nothing was changed/.test(r.content), r.content);
  assert.strictEqual(posts().length, n);
});

test('a turn: the model resolves a thread through the tool; the action-log row; never mixed with document edits in one batch', async () => {
  await fresh(withSuggestions());
  await turnStart('Fix line 5 and resolve the comment');
  const w = await exec('replace_text', { old_text: 'beta delta', new_text: 'beta DELTA' });
  assert.ok(w._ok, w.content);
  const r = await cmt({ action: 'resolve', ids: ['c1'] }, 'tc_res');
  assert.ok(r._ok, r.content);
  const kinds = posts().map((p) => p.body.requests.map((q) => Object.keys(q)[0]));
  assert.ok(kinds.every((k) => k.every((x) => /Comment|Suggestion/.test(x)) || k.every((x) => !/Comment|Suggestion/.test(x))), JSON.stringify(kinds));
  assert.strictEqual(T.logEntry({ id: 'tc_res', function: { name: 'comment', arguments: JSON.stringify({ ...ARGS, action: 'resolve', ids: ['c1'] }) } }, r).summary, 'resolve c1');
});
