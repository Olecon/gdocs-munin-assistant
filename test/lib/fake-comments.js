'use strict';
// Fake Docs plugin: comment threads and suggestion threads. spec.comments: [{ id, status ('open' | 'resolved'), start, end (API
// indices of the anchor; omit both for a thread without a range), tab (default the first tab), segmentId, quoted,
// author ('Name' or { displayName, me, anonymous }), date ('2026-10-20'), text, deleted, replies: [{ author, date,
// text, action ('RESOLVE' | 'REOPEN'), deleted }] }]. A documents.get with commentsViewMode answers with the API's
// shapes (Document.comments[] of CommentThread { commentId, anchorId, headPost, replies, status, plainTextQuote };
// DocumentTab.commentAnchors keyed by anchor ID: CommentAnchor { anchorId, ranges: [Range { startIndex, endIndex,
// tabId, segmentId }] }) and the API's parameter rules (400 without includeTabsContent=true or with a suggestions
// view other than SUGGESTIONS_INLINE). Anchors move with text insertions and deletions (srv.onShift).
// Suggestions: a paragraph's suggest id (fake-docs) marks its text as a suggested insertion; spec.suggestions: [{ id,
// status ('open' | 'accepted' | 'rejected'), author, date, summary, replies }] (a suggest id of the text without a thread
// gets an open one). The comments view answers Document.suggestions[] (SuggestionThread { suggestionId, headPost, replies,
// status, summaryText }) and, when its fields mask names body, each tab's body (the suggestion ids of the text).
// Writes (batchUpdate): insertComment { content, range, assigneeEmailAddress } -> { insertComment: { commentThread } },
// addCommentReply { commentId | suggestionId, post { content, commentAction, assigneeEmail } } -> { addCommentReply:
// { post } } (RESOLVE / REOPEN change the thread's status), deleteComment { commentId } (the head post's author only),
// deleteCommentReply { commentId | suggestionId, postId } (own replies without an action or an assignee), acceptSuggestion /
// rejectSuggestion { suggestionId } (accept keeps the text, reject removes it; the thread is ACCEPTED / REJECTED). The
// signed-in account is ME. The response carries commentUpdateState: ALL_SAVED when the batch had comment requests,
// NO_UPDATES_REQUESTED otherwise. srv.commentFail: comment requests change nothing and answer ALL_FAILED_UNKNOWN_REASON;
// srv.commentNoop: they change nothing and answer ALL_SAVED (a save that did not take).
// Suggestions made in suggest mode (fake-docs: per character) are listed as open threads by ME while their text is in the
// document (summary "Add: …" / "Delete: …"); accept / reject settle them in the text (srv.settleSuggestion).
const { registerFakeGet, registerFakeInit, registerFakeRequest, registerFakeResponse } = require('./fake-docs');
const ME = { displayName: 'Ivan', me: true };

const authorOf = (a) => (a && typeof a === 'object' ? { ...a } : { displayName: a || 'Anna K.' });
const post = (p, id) => ({
  postId: id, content: p.text || '', author: authorOf(p.author), createTime: `${p.date || '2026-10-20'}T10:00:00.000Z`,
  ...(p.deleted ? { deleted: true } : {}), ...(p.action ? { commentAction: p.action } : {}),
});

// Every paragraph of the fake (body runs and table cells of every tab), for the suggestion ids of its text.
const allParas = (srv) => srv.tabs.flatMap((t) => t.blocks.flatMap((b) => (b.type === 'run' ? b.paras : b.type === 'table' ? b.rows.flat().flatMap((c) => c.paras) : [])));
const suggestIdOf = (p) => (p.suggest ? (typeof p.suggest === 'string' ? p.suggest : 'suggest.1') : null);

registerFakeInit((srv, spec) => {
  srv.comments = (spec.comments || []).map((c) => JSON.parse(JSON.stringify({ tab: srv.tabs[0].id, ...c })));
  srv.suggestions = (spec.suggestions || []).map((x) => JSON.parse(JSON.stringify(x)));
  for (const p of allParas(srv)) {
    const id = suggestIdOf(p);
    if (id && !srv.suggestions.some((x) => x.id === id)) srv.suggestions.push({ id, author: 'Bob', summary: `Add: "${p.text}"` });
  }
  srv.commentSeq = 0;
  srv.backupKeys.push('comments', 'suggestions', 'commentSeq');
  srv.onShift.push((tabId, segmentId, index, delta) => {
    for (const c of srv.comments) {
      if (c.start == null || (c.tab || srv.tabs[0].id) !== tabId || (c.segmentId || '') !== (segmentId || '')) continue;
      const move = (i) => (delta > 0 ? (i >= index ? i + delta : i) : (i >= index - delta ? i + delta : i > index ? index : i));
      c.start = move(c.start);
      c.end = move(c.end);
    }
  });
});

// The documents.get response of the comments view (withBody: each tab's body too).
function renderComments(srv, withBody = false) {
  const threads = srv.comments.map((c, i) => ({
    commentId: c.id, anchorId: `kix.anchor${i}`, status: c.status === 'resolved' ? 'RESOLVED' : 'OPEN',
    ...(c.quoted != null ? { plainTextQuote: c.quoted } : {}),
    headPost: post(c, `${c.id}.p0`),
    ...(c.replies && c.replies.length ? { replies: c.replies.map((r, k) => post(r, `${c.id}.p${k + 1}`)) } : {}),
  }));
  const tabs = srv.tabs.map((t, i) => {
    const anchors = {};
    srv.comments.forEach((c, k) => {
      if (c.start == null || c.tab !== t.id) return;
      anchors[`kix.anchor${k}`] = { anchorId: `kix.anchor${k}`, ranges: [{ ...(c.segmentId ? { segmentId: c.segmentId } : {}), startIndex: c.start, endIndex: c.end, tabId: t.id }] };
    });
    const documentTab = Object.keys(anchors).length ? { commentAnchors: anchors } : {};
    if (withBody) documentTab.body = srv.render(true).tabs[i].documentTab.body;
    return { tabProperties: { tabId: t.id, title: t.title, index: i }, documentTab };
  });
  const own = [];
  for (const t of srv.tabs) {
    for (const x of srv.suggested(t.id)) {
      if (srv.suggestions.some((y) => y.id === x.id)) continue;
      const o = own.find((y) => y.id === x.id);
      const part = `${x.kind === 'ins' ? 'Add' : 'Delete'}: "${x.text.replace(/\n/g, ' ').trim()}"`;
      if (o) o.summary += `; ${part}`; else own.push({ id: x.id, author: { ...ME }, date: '2026-11-01', summary: part });
    }
  }
  const suggestions = [...srv.suggestions, ...own].map((x) => ({
    suggestionId: x.id, status: (x.status || 'open').toUpperCase(), ...(x.summary ? { summaryText: x.summary } : {}),
    headPost: post({ author: x.author || 'Bob', date: x.date, text: '' }, `${x.id}.p0`),
    ...(x.replies && x.replies.length ? { replies: x.replies.map((r, k) => post(r, `${x.id}.p${k + 1}`)) } : {}),
  }));
  // the API leaves out empty lists
  return { revisionId: 'rev-' + srv.revision, ...(threads.length ? { comments: threads } : {}), ...(suggestions.length ? { suggestions } : {}), tabs };
}

registerFakeGet((srv, url, params, api) => {
  const mode = params.get('commentsViewMode');
  if (!mode || mode === 'COMMENTS_VIEW_MODE_OMITTED') return null;
  const bad = (message) => api.json(400, { error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
  if (params.get('includeTabsContent') !== 'true') return bad('commentsViewMode requires includeTabsContent=true.');
  const sugg = params.get('suggestionsViewMode');
  if (mode === 'COMMENTS_VIEW_MODE_INCLUDED' && sugg && sugg !== 'SUGGESTIONS_INLINE') return bad('COMMENTS_VIEW_MODE_INCLUDED requires SUGGESTIONS_INLINE.');
  if (srv.commentsUnsupported) return bad('Invalid value at \'comments_view_mode\'.');
  return api.json(200, renderComments(srv, /(^|[,(])body\(/.test(params.get('fields') || '')));
});

// ---- Writes -----------------------------------------------------------------------------------------------------
const COMMENT_REQUESTS = ['insertComment', 'addCommentReply', 'updateCommentPost', 'deleteComment', 'deleteCommentReply'];
const utf8Len = (t) => Buffer.byteLength(String(t), 'utf8');
// The thread of a request: { thread, kind } for commentId or suggestionId, or a 400.
function threadOf(srv, body, api) {
  if (body.commentId && body.suggestionId) api.fail('Only one of commentId and suggestionId may be set.');
  if (body.commentId) {
    const thread = srv.comments.find((c) => c.id === body.commentId);
    if (!thread) api.fail(`Comment ${body.commentId} not found.`);
    return thread;
  }
  if (body.suggestionId) {
    const thread = srv.suggestions.find((x) => x.id === body.suggestionId);
    if (!thread) api.fail(`Suggestion ${body.suggestionId} not found.`);
    return thread;
  }
  return api.fail('commentId or suggestionId is required.');
}
const skipped = (srv) => srv.commentFail || srv.commentNoop;
// The text of body range [s, e) of a tab, as the quote of a new comment.
function quoteOf(srv, tabId, s, e) {
  const tab = srv.render(true).tabs.find((t) => t.tabProperties.tabId === tabId);
  let out = '';
  const walk = (content) => {
    for (const el of content || []) {
      for (const pe of (el.paragraph || {}).elements || []) {
        const c = (pe.textRun || {}).content || '';
        for (let i = 0; i < c.length; i++) if (pe.startIndex + i >= s && pe.startIndex + i < e) out += c[i];
      }
      if (el.table) for (const row of el.table.tableRows) for (const cell of row.tableCells) walk(cell.content);
    }
  };
  walk(tab ? tab.documentTab.body.content : []);
  return out;
}
registerFakeRequest('insertComment', (body, api) => {
  const { srv } = api;
  if (!body.content || utf8Len(body.content) > 2048) api.fail('content is required and must be at most 2048 UTF-8 code units.');
  const r = body.range;
  if (!r || typeof r.startIndex !== 'number' || typeof r.endIndex !== 'number' || r.endIndex <= r.startIndex) api.fail('A valid range is required.');
  if (skipped(srv)) return { insertComment: {} };
  const tab = r.tabId || srv.tabs[0].id;
  const id = `new${++srv.commentSeq}`;
  const c = { id, status: 'open', tab, start: r.startIndex, end: r.endIndex, ...(r.segmentId ? { segmentId: r.segmentId } : {}),
    quoted: r.segmentId ? '' : quoteOf(srv, tab, r.startIndex, r.endIndex), author: { ...ME }, date: '2026-11-01', text: body.content,
    ...(body.assigneeEmailAddress ? { assignee: body.assigneeEmailAddress } : {}), replies: [] };
  srv.comments.push(c);
  return { insertComment: { commentThread: renderComments(srv).comments.find((t) => t.commentId === id) } };
});
registerFakeRequest('addCommentReply', (body, api) => {
  const { srv } = api;
  const thread = threadOf(srv, body, api);
  const p = body.post || {};
  if (!p.content && !p.commentAction && !p.assigneeEmail) api.fail('The reply needs content, an action or an assignee.');
  if (p.content && utf8Len(p.content) > 2048) api.fail('content must be at most 2048 UTF-8 code units.');
  if (p.commentAction && !['RESOLVE', 'REOPEN'].includes(p.commentAction)) api.fail(`Invalid commentAction ${p.commentAction}.`);
  if (skipped(srv)) return { addCommentReply: {} };
  thread.replies = thread.replies || [];
  const r = { author: { ...ME }, date: '2026-11-01', text: p.content || '', ...(p.commentAction ? { action: p.commentAction } : {}) };
  thread.replies.push(r);
  if (p.commentAction === 'RESOLVE') thread.status = 'resolved';
  if (p.commentAction === 'REOPEN') thread.status = 'open';
  const postId = `${thread.id}.p${thread.replies.length}`;
  return { addCommentReply: { post: post(r, postId) } };
});
registerFakeRequest('deleteComment', (body, api) => {
  const { srv } = api;
  const thread = threadOf(srv, { commentId: body.commentId }, api);
  if (!(thread.author && thread.author.me)) api.fail('The requester is not the author of the comment.');
  if (skipped(srv)) return {};
  srv.comments = srv.comments.filter((c) => c !== thread);
  return {};
});
registerFakeRequest('deleteCommentReply', (body, api) => {
  const { srv } = api;
  const thread = threadOf(srv, body, api);
  const k = Number(String(body.postId || '').split('.p').pop());
  const r = (thread.replies || [])[k - 1];
  if (!r || body.postId !== `${thread.id}.p${k}` || r.deleted) api.fail(`Post ${body.postId} not found.`);
  if (!(r.author && r.author.me)) api.fail('The requester is not the author of the reply.');
  if (r.action || r.assignee) api.fail('A reply with an action or an assignee cannot be deleted.');
  if (skipped(srv)) return {};
  r.deleted = true;
  return {};
});
function settleSuggestion(body, api, accept) {
  const { srv } = api;
  const x = srv.suggestions.find((s) => s.id === body.suggestionId);
  if (!x && !srv.suggestionNoop && srv.settleSuggestion(body.suggestionId, accept)) return {}; // a suggestion made in suggest mode
  if (!x || (x.status && x.status !== 'open')) api.fail(`Suggestion ${body.suggestionId} not found.`);
  if (srv.suggestionNoop) return {};
  x.status = accept ? 'accepted' : 'rejected';
  for (const p of allParas(srv)) {
    if (suggestIdOf(p) !== x.id) continue;
    p.suggest = false;
    if (!accept) { p.text = ''; p.chars = []; } // the suggested insertion goes (anchors are not moved here)
  }
  return {};
}
registerFakeRequest('acceptSuggestion', (body, api) => settleSuggestion(body, api, true));
registerFakeRequest('rejectSuggestion', (body, api) => settleSuggestion(body, api, false));
registerFakeResponse((srv, body) => {
  const comments = (body.requests || []).some((rq) => COMMENT_REQUESTS.some((k) => rq[k]));
  return { commentUpdateState: !comments ? 'NO_UPDATES_REQUESTED' : srv.commentFail ? 'ALL_FAILED_UNKNOWN_REASON' : 'ALL_SAVED' };
});

module.exports = { renderComments, ME };
