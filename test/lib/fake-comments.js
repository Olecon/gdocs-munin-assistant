'use strict';
// Fake Docs plugin: comment threads (read-only). spec.comments: [{ id, status ('open' | 'resolved'), start, end (API
// indices of the anchor; omit both for a thread without a range), tab (default the first tab), segmentId, quoted,
// author ('Name' or { displayName, me, anonymous }), date ('2026-10-20'), text, deleted, replies: [{ author, date,
// text, action ('RESOLVE' | 'REOPEN'), deleted }] }]. A documents.get with commentsViewMode answers with the API's
// shapes (Document.comments[] of CommentThread { commentId, anchorId, headPost, replies, status, plainTextQuote };
// DocumentTab.commentAnchors keyed by anchor ID: CommentAnchor { anchorId, ranges: [Range { startIndex, endIndex,
// tabId, segmentId }] }) and the API's parameter rules (400 without includeTabsContent=true or with a suggestions
// view other than SUGGESTIONS_INLINE). Anchors move with text insertions and deletions (srv.onShift).
const { registerFakeGet, registerFakeInit } = require('./fake-docs');

const authorOf = (a) => (a && typeof a === 'object' ? { ...a } : { displayName: a || 'Anna K.' });
const post = (p, id) => ({
  postId: id, content: p.text || '', author: authorOf(p.author), createTime: `${p.date || '2026-10-20'}T10:00:00.000Z`,
  ...(p.deleted ? { deleted: true } : {}), ...(p.action ? { commentAction: p.action } : {}),
});

registerFakeInit((srv, spec) => {
  srv.comments = (spec.comments || []).map((c) => JSON.parse(JSON.stringify({ tab: srv.tabs[0].id, ...c })));
  srv.backupKeys.push('comments');
  srv.onShift.push((tabId, segmentId, index, delta) => {
    for (const c of srv.comments) {
      if (c.start == null || (c.tab || srv.tabs[0].id) !== tabId || (c.segmentId || '') !== (segmentId || '')) continue;
      const move = (i) => (delta > 0 ? (i >= index ? i + delta : i) : (i >= index - delta ? i + delta : i > index ? index : i));
      c.start = move(c.start);
      c.end = move(c.end);
    }
  });
});

// The documents.get response of the comments view.
function renderComments(srv) {
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
    return { tabProperties: { tabId: t.id, title: t.title, index: i }, documentTab: Object.keys(anchors).length ? { commentAnchors: anchors } : {} };
  });
  // the API leaves out empty lists
  return { revisionId: 'rev-' + srv.revision, ...(threads.length ? { comments: threads } : {}), tabs };
}

registerFakeGet((srv, url, params, api) => {
  const mode = params.get('commentsViewMode');
  if (!mode || mode === 'COMMENTS_VIEW_MODE_OMITTED') return null;
  const bad = (message) => api.json(400, { error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
  if (params.get('includeTabsContent') !== 'true') return bad('commentsViewMode requires includeTabsContent=true.');
  const sugg = params.get('suggestionsViewMode');
  if (mode === 'COMMENTS_VIEW_MODE_INCLUDED' && sugg && sugg !== 'SUGGESTIONS_INLINE') return bad('COMMENTS_VIEW_MODE_INCLUDED requires SUGGESTIONS_INLINE.');
  if (srv.commentsUnsupported) return bad('Invalid value at \'comments_view_mode\'.');
  return api.json(200, renderComments(srv));
});

module.exports = { renderComments };
