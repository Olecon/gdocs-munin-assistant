'use strict';
// Module docs-comments.js: read_comments, the comment threads of the main document through the Docs API (read-only:
// nothing here writes to the document). The threads come from a separate, lazy documents.get with the comments view
// (the main field mask stays without comments), read at most once per turn and document revision (snap.comments);
// anchors are mapped to the lines of the turn's model (snap.model, never changed here).
/* global docsApi, findFlexible, lineAtIndex, lineAtOffset, offersFormatting, rangeLabel, registerTools, segmentModel */
/* exported COMMENTS_QUERY, COMMENTS_MAX_THREADS, COMMENTS_MAX_CHARS, READ_COMMENTS_TOOL, fetchComments, formatComments,
   commentLineRange, commentPlace, readComments */

// documents.get parameters: the comments view needs the tabs content and inline suggestions (API reference,
// commentsViewMode). Only the comment threads and, per tab (three levels like DOCS_GET_FIELDS), the tab's id, title
// and comment anchors are requested.
const COMMENTS_QUERY = (() => {
  const tab = (depth) => 'tabProperties(tabId,title),documentTab(commentAnchors)' + (depth > 1 ? `,childTabs(${tab(depth - 1)})` : '');
  return 'includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED' +
    `&fields=revisionId,comments,tabs(${tab(3)})`;
})();
// Output limits (the result costs prompt tokens): threads per call, characters in all, a quote and a post.
const COMMENTS_MAX_THREADS = 50;
const COMMENTS_MAX_CHARS = 6000;
const COMMENT_QUOTE_MAX_CHARS = 80;
const COMMENT_POST_MAX_CHARS = 400;

const READ_COMMENTS_TOOL = { type: 'function', function: {
  name: 'read_comments',
  description: 'Comment threads of the document: id, status, the lines the comment is anchored to, the quoted text, author, date, text and replies. Read-only. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Which threads to list (usually open).' },
      lines: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Only threads anchored in this line range, e.g. "10-25"; null for the whole document.' },
    },
    required: ['status', 'lines'],
    additionalProperties: false,
  },
} };

// The threads and anchors of the main document: { revisionId, comments, anchors: { anchorId: {ranges} }, tabs:
// { tabId: title } }. Cached on the snapshot per document revision: a write in this turn moves the anchors, so the
// next call reads them again.
async function fetchComments(snap) {
  const m = snap.model;
  const c = snap.comments;
  if (c && c.docId === m.docId && c.modelRevision === m.revisionId) return c;
  const doc = await docsApi(`${encodeURIComponent(m.docId)}?${COMMENTS_QUERY}`);
  const anchors = {};
  const tabs = {};
  const walk = (list) => {
    for (const t of list || []) {
      const p = t.tabProperties || {};
      if (p.tabId) tabs[p.tabId] = p.title || '';
      const ca = (t.documentTab || {}).commentAnchors || {};
      // keyed by anchor ID (API reference); a list is accepted too
      for (const [k, a] of Object.entries(ca)) if (a) anchors[a.anchorId || k] = { tabId: p.tabId || null, ranges: a.ranges || [] };
      walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  snap.comments = { docId: m.docId, modelRevision: m.revisionId, revisionId: doc.revisionId || '', comments: doc.comments || [], anchors, tabs };
  return snap.comments;
}

// "12", "10-25", "10–25" (en dash), "lines 10 to 25" -> { from, to }; null when absent; { error } otherwise.
function commentLineRange(v) {
  if (v == null || String(v).trim() === '') return null;
  const m = /^\s*(?:lines?\s*)?(\d+)\s*(?:(?:-|–|—|to|\.\.)\s*(\d+))?\s*$/i.exec(String(v));
  if (!m) return { error: `Error: lines must be a range like "10-25" (got "${String(v).slice(0, 40)}"), or null.` };
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

const commentClip = (t, max) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max) + '…' : s; };
const commentDate = (p) => String(p.createTime || '').slice(0, 10);
const commentAuthor = (p) => { const a = p.author || {}; return (a.anonymous ? 'Anonymous' : a.displayName || 'Unknown') + (a.me ? ' (you)' : ''); };
const COMMENT_ACTION_NOTE = { RESOLVE: '[resolved]', REOPEN: '[reopened]' };
const commentPostText = (p) => (p.deleted ? '(deleted)' : [COMMENT_ACTION_NOTE[p.commentAction], commentClip(p.content, COMMENT_POST_MAX_CHARS)].filter(Boolean).join(' '));

// Body lines [from, to] overlapped by the API range [s, e) of a model (lineAtIndex; a range that starts or ends on
// a structural index, such as a table start, falls back to the lines it overlaps), or null.
function commentLines(model, s, e) {
  const a = lineAtIndex(model, s);
  const b = lineAtIndex(model, Math.max(s, e - 1));
  if (a && b) return { from: a.line, to: b.line };
  const hit = model.lines.filter((l) => l.start < e && l.end + 1 > s);
  return hit.length ? { from: hit[0].line, to: hit[hit.length - 1].line } : null;
}

// Where a thread is anchored, in the turn's model: { from, to } for body lines of the open tab, plus where (the text
// shown: "lines 3–4", "footnote 1, line 1", 'in tab "Notes"', or the note for a lost anchor).
function commentPlace(model, data, t) {
  const anchor = data.anchors[t.anchorId];
  const ranges = (anchor && anchor.ranges) || [];
  if (ranges.length) {
    const r0 = ranges[0];
    const tabId = r0.tabId || anchor.tabId;
    if (tabId && model.tabId && tabId !== model.tabId) {
      const title = data.tabs[tabId];
      return { where: title ? `in tab "${title}"` : 'in another tab' };
    }
    const same = ranges.filter((r) => (r.segmentId || '') === (r0.segmentId || ''));
    const s = Math.min(...same.map((r) => r.startIndex || 0));
    const e = Math.max(...same.map((r) => r.endIndex || 0));
    if (r0.segmentId) {
      const seg = segmentModel(model, r0.segmentId);
      const ls = seg && commentLines(seg, s, e);
      return { where: seg ? `${seg.label}${ls ? ', ' + rangeLabel(ls.from, ls.to) : ''}` : 'in a header, footer or footnote' };
    }
    const ls = commentLines(model, s, e);
    if (ls) return { ...ls, where: rangeLabel(ls.from, ls.to) };
  }
  // No usable range: the quote, when it occurs exactly once, still gives the line.
  const q = String(t.plainTextQuote || '');
  const hits = q.trim() ? findFlexible(model.text, q) : [];
  if (hits.length === 1) {
    const a = lineAtOffset(model, hits[0].at).line;
    const b = lineAtOffset(model, hits[0].at + Math.max(0, hits[0].text.length - 1)).line;
    return { from: a, to: b, where: `${rangeLabel(a, b)} (by its quote)` };
  }
  return { where: 'anchor text no longer in the document', lost: true };
}

// The result text for the threads of data (fetchComments) with status 'open' | 'resolved' | 'all', limited to the
// body lines in range ({ from, to } or null).
function formatComments(model, data, status, range) {
  const all = data.comments || [];
  const wanted = all.filter((t) => status === 'all' || String(t.status || 'OPEN').toLowerCase() === status);
  const placed = wanted.map((t) => ({ t, place: commentPlace(model, data, t) }))
    .filter(({ place }) => !range || (place.from != null && place.from <= range.to && place.to >= range.from));
  const what = status === 'all' ? 'comment thread' : `${status} comment thread`;
  const inLines = range ? ` in ${rangeLabel(range.from, range.to)}` : '';
  if (!placed.length) {
    const others = all.length ? `; ${all.length} thread${all.length === 1 ? '' : 's'} in all` : '';
    return `No comments (status: ${status}${range ? ', ' + rangeLabel(range.from, range.to) : ''}${others}).`;
  }
  const blocks = [];
  let chars = 0;
  for (const { t, place } of placed) {
    const head = t.headPost || {};
    const quote = commentClip(t.plainTextQuote, COMMENT_QUOTE_MAX_CHARS);
    const lost = place.lost && quote ? ` (quote: «${quote}»)` : '';
    const lines = [`[id ${t.commentId}] ${String(t.status || 'OPEN').toLowerCase()} · ${place.where}${lost}${quote && !place.lost ? ` «${quote}»` : ''} · ${commentAuthor(head)} · ${commentDate(head)}: ${commentPostText(head)}`];
    for (const p of t.replies || []) if (!p.deleted) lines.push(`  ↳ ${commentAuthor(p)} · ${commentDate(p)}: ${commentPostText(p)}`);
    const block = lines.join('\n');
    if (blocks.length && (blocks.length >= COMMENTS_MAX_THREADS || chars + block.length > COMMENTS_MAX_CHARS)) break;
    blocks.push(block);
    chars += block.length + 1;
  }
  const more = placed.length - blocks.length;
  const of = placed.length < all.length ? ` (of ${all.length})` : '';
  const changed = data.revisionId && model.revisionId && data.revisionId !== model.revisionId
    ? '\n[The document changed after this message was sent: line numbers may be slightly off.]' : '';
  return `${placed.length} ${what}${placed.length === 1 ? '' : 's'}${inLines}${of}:\n${blocks.join('\n')}` +
    (more ? `\n[${more} more; narrow with lines or status.]` : '') + changed;
}

async function readComments(args, snap) {
  if (snap.docFormat !== 'docs-api' || !snap.model) return 'Error: comments need the Google Docs API, which is not available for this message.';
  const status = ['open', 'resolved', 'all'].includes(args.status) ? args.status : 'open';
  const range = commentLineRange(args.lines);
  if (range && range.error) return range.error;
  let data;
  try { data = await fetchComments(snap); } catch (e) {
    if (e.status === 400) return `Error: Google refused to return the comments (HTTP 400; the comments view may not be available for this document or account${e.serverMessage ? ': ' + e.serverMessage : ''}). Answer without them, or ask the user to paste the comments.`;
    return `Error: could not read the comments: ${e.message}`;
  }
  return formatComments(snap.model, data, status, range);
}

// Offered with read_formatting: tools turns whose main document was read through the Docs API.
registerTools([READ_COMMENTS_TOOL], {
  offer: (mode, snap) => offersFormatting(mode, snap),
  reading: true,
  icon: '💬',
  summary: (name, args) => {
    const a = args || {};
    const r = commentLineRange(a.lines);
    return `comments (${['open', 'resolved', 'all'].includes(a.status) ? a.status : 'open'}${r && !r.error ? ', ' + rangeLabel(r.from, r.to) : ''})`;
  },
  run: (name, args, snap) => readComments(args || {}, snap),
  prompt: [{ section: 'reading', line: '- read_comments(status, lines): the comment threads (anchored lines, quoted text, author, replies); read-only. Use it when the user mentions comments, reviewers or feedback.' }],
});
