'use strict';
// Module docs-comments.js: the comment threads and suggestion threads of the main document through the Docs API
// (read-only: nothing here writes to the document; the comment tool of docs-comment-write.js writes), shown by
// read_document with include "comments" (tools.js readDocumentTool; the read_comments tool of earlier versions). The
// threads come from a separate, lazy documents.get with the comments view (the main field mask stays without
// comments), read at most once per turn and document revision (snap.comments); anchors are mapped to the lines of the
// turn's model (snap.model, never changed here), suggestions through the suggestion ids of the paragraphs' text.
/* global docsApi, findFlexible, lineAtIndex, lineAtOffset, rangeLabel, segmentModel */
/* exported COMMENTS_QUERY, COMMENTS_MAX_THREADS, COMMENTS_MAX_CHARS, fetchComments, formatComments,
   commentLineRange, commentPlace, readComments, suggestionPlace, commentFacts, isOpenThread, ownReplyDeletable */

// documents.get parameters: the comments view needs the tabs content and inline suggestions (API reference,
// commentsViewMode). Only the comment and suggestion threads and, per tab (three levels like DOCS_GET_FIELDS), the
// tab's id, title, comment anchors and the suggestion ids of the body's text (paragraph start indices, one table level)
// are requested: they place a suggestion thread on its lines.
const COMMENTS_QUERY = (() => {
  const ids = '(suggestedInsertionIds,suggestedDeletionIds)';
  const para = `startIndex,paragraph(elements(textRun${ids},inlineObjectElement${ids}))`;
  const body = `body(content(${para},table(tableRows(tableCells(content(${para}))))))`;
  const tab = (depth) => `tabProperties(tabId,title),documentTab(commentAnchors,${body})` + (depth > 1 ? `,childTabs(${tab(depth - 1)})` : '');
  return 'includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED' +
    `&fields=revisionId,comments,suggestions,tabs(${tab(3)})`;
})();
// Output limits (the result costs prompt tokens): threads per call, characters in all, a quote and a post.
const COMMENTS_MAX_THREADS = 50;
const COMMENTS_MAX_CHARS = 6000;
const COMMENT_QUOTE_MAX_CHARS = 80;
const COMMENT_POST_MAX_CHARS = 400;

// The threads and anchors of the main document: { revisionId, comments, suggestions, anchors: { anchorId: {ranges} },
// tabs: { tabId: title }, suggestionAt: { suggestionId: { tabId, starts: [paragraph start index] } } }. Cached on the
// snapshot per document revision: a write in this turn moves the anchors, so the next call reads them again (the
// comment tool drops the cache after its own writes, which may leave the revision as it was).
async function fetchComments(snap) {
  const m = snap.model;
  const c = snap.comments;
  if (c && c.docId === m.docId && c.modelRevision === m.revisionId) return c;
  const doc = await docsApi(`${encodeURIComponent(m.docId)}?${COMMENTS_QUERY}`);
  const anchors = {};
  const tabs = {};
  const suggestionAt = {};
  const walk = (list) => {
    for (const t of list || []) {
      const p = t.tabProperties || {};
      if (p.tabId) tabs[p.tabId] = p.title || '';
      const ca = (t.documentTab || {}).commentAnchors || {};
      // keyed by anchor ID (API reference); a list is accepted too
      for (const [k, a] of Object.entries(ca)) if (a) anchors[a.anchorId || k] = { tabId: p.tabId || null, ranges: a.ranges || [] };
      suggestionStarts(((t.documentTab || {}).body || {}).content, p.tabId || null, suggestionAt);
      walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  snap.comments = { docId: m.docId, modelRevision: m.revisionId, revisionId: doc.revisionId || '', comments: doc.comments || [],
    suggestions: doc.suggestions || [], anchors, tabs, suggestionAt };
  return snap.comments;
}
// The start index of every paragraph whose text carries a suggestion id, per id (out[id] = { tabId, starts }): the
// paragraphs of content and of its tables' cells.
function suggestionStarts(content, tabId, out) {
  for (const el of content || []) {
    if (el.paragraph) {
      const ids = new Set();
      for (const pe of el.paragraph.elements || []) {
        for (const v of Object.values(pe)) {
          if (!v || typeof v !== 'object') continue;
          for (const id of [...(v.suggestedInsertionIds || []), ...(v.suggestedDeletionIds || [])]) ids.add(id);
        }
      }
      for (const id of ids) {
        const at = out[id] || (out[id] = { tabId, starts: [] });
        if (at.tabId === tabId && typeof el.startIndex === 'number') at.starts.push(el.startIndex);
      }
    }
    if (el.table) for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) suggestionStarts(cell.content, tabId, out);
  }
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
// A reply the signed-in account may delete (deleteCommentReply: its own, without an action or an assignee); the
// reading output shows its id so the comment tool can delete it.
const ownReplyDeletable = (p) => !!p && !p.deleted && !!(p.author || {}).me && (!p.commentAction || p.commentAction === 'NO_COMMENT_ACTION_CHANGE') && !p.assigneeEmail;
const commentReplyLine = (p) => `  ↳ ${ownReplyDeletable(p) && p.postId ? `[reply ${p.postId}] ` : ''}${commentAuthor(p)} · ${commentDate(p)}: ${commentPostText(p)}`;

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

// Where a suggestion thread is, in the turn's model: { from, to, where } for body lines of the open tab (the lines whose
// text carries its id), { where } for another tab, or { where: 'not in the text' } (a style suggestion, or one that
// is no longer in the document).
function suggestionPlace(model, data, s) {
  const at = (data.suggestionAt || {})[s.suggestionId];
  if (!at || !at.starts.length) return { where: 'not in the text' };
  if (at.tabId && model.tabId && at.tabId !== model.tabId) {
    const title = (data.tabs || {})[at.tabId];
    return { where: title ? `in tab "${title}"` : 'in another tab' };
  }
  const ls = at.starts.map((i) => lineAtIndex(model, i)).filter(Boolean).map((l) => l.line);
  if (!ls.length) return { where: 'not in the text' };
  const from = Math.min(...ls);
  const to = Math.max(...ls);
  return { from, to, where: rangeLabel(from, to) };
}
const suggestionStatus = (s) => String(s.status || 'OPEN').toUpperCase();
const isOpenSuggestion = (s) => suggestionStatus(s) === 'OPEN';

// The counts the comment tool's offer and its document note use: { open, resolved, suggestions (open ones) }.
function commentFacts(data) {
  const all = (data && data.comments) || [];
  const open = all.filter(isOpenThread).length;
  return { open, resolved: all.length - open, suggestions: ((data && data.suggestions) || []).filter(isOpenSuggestion).length };
}

// The result text for the threads of data (fetchComments) with status 'open' | 'resolved' | 'all' (open threads first),
// limited to the body lines in range ({ from, to } or null) and to maxChars characters of threads. The suggestion
// threads follow the comment threads in their own list (open: OPEN; resolved: accepted or rejected), within the same
// thread count and characters.
const isOpenThread = (t) => String(t.status || 'OPEN').toLowerCase() === 'open';
function formatComments(model, data, status, range, maxChars = COMMENTS_MAX_CHARS) {
  const all = data.comments || [];
  const wanted = status === 'all' ? [...all.filter(isOpenThread), ...all.filter((t) => !isOpenThread(t))]
    : all.filter((t) => String(t.status || 'OPEN').toLowerCase() === status);
  const inRange = ({ place }) => !range || (place.from != null && place.from <= range.to && place.to >= range.from);
  const placed = wanted.map((t) => ({ t, place: commentPlace(model, data, t) })).filter(inRange);
  const allSugg = data.suggestions || [];
  const wantedSugg = status === 'all' ? [...allSugg.filter(isOpenSuggestion), ...allSugg.filter((s) => !isOpenSuggestion(s))]
    : allSugg.filter((s) => isOpenSuggestion(s) === (status === 'open'));
  const placedSugg = wantedSugg.map((t) => ({ t, place: suggestionPlace(model, data, t) })).filter(inRange);
  const what = status === 'all' ? 'comment thread' : `${status} comment thread`;
  const inLines = range ? ` in ${rangeLabel(range.from, range.to)}` : '';
  if (!placed.length && !placedSugg.length) {
    const others = all.length ? `; ${all.length} thread${all.length === 1 ? '' : 's'} in all` : '';
    return `No comments (status: ${status}${range ? ', ' + rangeLabel(range.from, range.to) : ''}${others}).`;
  }
  const budget = { blocks: 0, chars: 0 };
  const take = (list, render) => {
    const out = [];
    for (const x of list) {
      const block = render(x);
      if (budget.blocks && (budget.blocks >= COMMENTS_MAX_THREADS || budget.chars + block.length > maxChars)) break;
      out.push(block);
      budget.blocks++;
      budget.chars += block.length + 1;
    }
    return out;
  };
  const blocks = take(placed, ({ t, place }) => {
    const head = t.headPost || {};
    const quote = commentClip(t.plainTextQuote, COMMENT_QUOTE_MAX_CHARS);
    const lost = place.lost && quote ? ` (quote: «${quote}»)` : '';
    const lines = [`[id ${t.commentId}] ${String(t.status || 'OPEN').toLowerCase()} · ${place.where}${lost}${quote && !place.lost ? ` «${quote}»` : ''} · ${commentAuthor(head)} · ${commentDate(head)}: ${commentPostText(head)}`];
    for (const p of t.replies || []) if (!p.deleted) lines.push(commentReplyLine(p));
    return lines.join('\n');
  });
  const suggBlocks = blocks.length < placed.length ? [] : take(placedSugg, ({ t, place }) => {
    const head = t.headPost || {};
    const text = commentClip(t.summaryText || head.content, COMMENT_POST_MAX_CHARS);
    const lines = [`[id ${t.suggestionId}] ${suggestionStatus(t).toLowerCase()} · ${place.where} · ${commentAuthor(head)} · ${commentDate(head)}: ${text}`];
    for (const p of t.replies || []) if (!p.deleted) lines.push(commentReplyLine(p));
    return lines.join('\n');
  });
  const more = placed.length - blocks.length + placedSugg.length - suggBlocks.length;
  const of = placed.length < all.length ? ` (of ${all.length})` : '';
  const changed = data.revisionId && model.revisionId && data.revisionId !== model.revisionId
    ? '\n[The document changed after this message was sent: line numbers may be slightly off.]' : '';
  const parts = [];
  if (placed.length) parts.push(`${placed.length} ${what}${placed.length === 1 ? '' : 's'}${inLines}${of}:\n${blocks.join('\n')}`);
  const sw = status === 'all' ? 'suggested change' : status === 'open' ? 'open suggested change' : 'accepted or rejected suggested change';
  if (placedSugg.length && (suggBlocks.length || !placed.length)) {
    parts.push(`${placedSugg.length} ${sw}${placedSugg.length === 1 ? '' : 's'}${inLines}:${suggBlocks.length ? '\n' + suggBlocks.join('\n') : ''}`);
  }
  return parts.join('\n') + (more ? `\n[${more} more; read a smaller range.]` : '') + changed;
}

// The comment threads for args { status, lines } ("10-25" or null), within maxChars; an "Error: …" text when they
// cannot be read.
async function readComments(args, snap, maxChars = COMMENTS_MAX_CHARS) {
  if (snap.docFormat !== 'docs-api' || !snap.model) return 'Error: comments need the Google Docs API, which is not available for this message.';
  const status = ['open', 'resolved', 'all'].includes(args.status) ? args.status : 'open';
  const range = commentLineRange(args.lines);
  if (range && range.error) return range.error;
  let data;
  try { data = await fetchComments(snap); } catch (e) {
    if (e.status === 400) return `Error: Google refused to return the comments (HTTP 400; the comments view may not be available for this document or account${e.serverMessage ? ': ' + e.serverMessage : ''}). Answer without them, or ask the user to paste the comments.`;
    return `Error: could not read the comments: ${e.message}`;
  }
  return formatComments(snap.model, data, status, range, maxChars);
}

