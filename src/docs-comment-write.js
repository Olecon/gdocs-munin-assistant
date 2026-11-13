'use strict';
// Module docs-comment-write.js: the comment tool (Docs API only, an editing turn, main document): add a comment, reply, resolve,
// reopen and delete comment threads (insertComment, addCommentReply, deleteComment, deleteCommentReply) and accept or
// reject suggested changes (acceptSuggestion, rejectSuggestion). The threads come from docs-comments.js (fetchComments,
// the comments view); the tool is offered only when the document has open threads or suggestions, or the message is
// about comments or review (fixed per turn by a beforeTurn hook, which also reads the comments once). Every call is one
// batch of comment requests only (never mixed with document edits); a reply whose commentUpdateState is not ALL_SAVED
// fails, and the comments are read again to check the change took. Undo (journal kind 'comment'): add → delete the
// thread, reply → delete the reply, resolve ↔ reopen; delete, accept and reject are journaled but not undoable.
// Deleting asks every time unless the user's message asked for it; accepting or rejecting more than
// COMMENT_GATE_SUGGESTIONS suggestions asks too, in Auto as well (the panel cannot undo them); in Manual every call asks.
/* global apiEditing, chatAsked, stickyOffer, commentFacts, commentLineRange, commentPlace, docsApi, docsBatchUpdate, fetchComments,
   fetchDocModel, findFlexible, gateEdit, inexactLine, indexAtOffset, isOpenThread, lastSentText, lineAtOffset, linesReport,
   notFoundError, ownReplyDeletable, rangeLabel, registerSelfTestRows, registerTools, registerTurnHook,
   registerUndoHandler, reqRange, setSnapModel, stClip, stFail, stPass, stTool, stWrite, stWriteStep, suggestionPlace,
   useDocModel, writeError */
/* exported COMMENT_TOOL, commentsMentioned, deleteCommentsAsked */

const COMMENT_ACTIONS = ['add', 'reply', 'resolve', 'reopen', 'delete', 'accept', 'reject'];
// The API's limit on a comment's content (UTF-8 code units).
const COMMENT_TEXT_MAX = 2048;
// Accepting or rejecting more suggestions than this in one call asks first, in Auto too (like Undo all).
const COMMENT_GATE_SUGGESTIONS = 5;
// Ids per call (one batch).
const COMMENT_MAX_IDS = 50;

const commentOrNull = (type, description, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }], description });
const COMMENT_TOOL = { type: 'function', function: {
  name: 'comment',
  description: 'Comments and suggested changes, by the ids read_document include ["comments"] shows. add: a comment with text on old_text (exact, once) or lines; reply: text to one thread; resolve / reopen: threads; delete: threads or your own replies; accept / reject: suggested changes (several ids at once).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: COMMENT_ACTIONS },
      ids: commentOrNull('array', 'thread, reply or suggestion ids; not for add', { items: { type: 'string' } }),
      text: commentOrNull('string', 'add, reply: the comment; resolve, reopen: an optional reply'),
      old_text: commentOrNull('string', 'add: the text to comment on'),
      lines: commentOrNull('string', 'add: "N" or "N-M" instead of old_text'),
      assignee: commentOrNull('string', 'add: an email to assign it to'),
    },
    required: ['action', 'ids', 'text', 'old_text', 'lines', 'assignee'],
    additionalProperties: false,
  },
} };

// ---- When the tool is offered ------------------------------------------------------------------------------------
// The message is about comments, review or suggested changes (English and Russian stems).
const COMMENTS_WORDS_RE = /\b(?:comment(?:s|ed|ing)?|reviewers?|review(?:s|ed|ing)?|suggestions?|suggested changes?|suggesting mode|tracked changes|resolve[sd]?)\b|коммент|рецензи|рецензент|ревью|замечани|предложенн\S* (?:изменени|правк)|режим\S* предложени|(?:принять|принимай|примите|прими|отклонить|отклони|отклоните)\s+(?:все\s+)?(?:изменени|предложени|правк)/i;
const commentsMentioned = (text) => COMMENTS_WORDS_RE.test(String(text || ''));
// The user's message asks to delete comments (and does not say not to): deleting then needs no card.
const DELETE_ASKED_RE = /\b(?:delete|remove|clear|erase)\b[^.!?\n]{0,40}\bcomments?\b|\bcomments?\b[^.!?\n]{0,30}\b(?:delete|remove)\b|(?:удали|удалить|удалите|убери|убрать|уберите|сотри|стереть|сотрите)[^.!?\n]{0,40}коммент|коммент[^.!?\n]{0,30}(?:удали|удалить|удалите|убери|убрать|уберите)/i;
const DELETE_DENIED_RE = /\b(?:don'?t|do not|never|not)\b[^.!?\n]{0,15}\b(?:delete|remove)\b|\bне\s+(?:удаля|удали|убира|убери|стира|трогай)/i;
const deleteCommentsAsked = (text) => DELETE_ASKED_RE.test(String(text || '')) && !DELETE_DENIED_RE.test(String(text || ''));
// The user's message of this turn (an agent's brief is not the user's: an agent always asks).
function commentTurnText(snap) {
  if (!snap || snap.agent) return '';
  const msgs = (snap.chatCtx && snap.chatCtx.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && !m._auto && !m._summary) return typeof m.content === 'string' ? m.content : '';
  }
  return String(lastSentText() || '');
}

const hasSuggestedLines = (snap) => !!(snap.model && (snap.model.lines || []).some((l) => l.suggested));
const factsOffer = (f) => !!(f && (f.open || f.suggestions));
// Fixed per turn (snap.commentOffer, set by the beforeTurn hook below), so every round offers the same tools; a
// snapshot no turn prepared (an agent's) decides once on what it has: the comments read so far and the message.
function commentOffered(mode, snap) {
  if (!snap || !apiEditing(mode, snap) || !snap.model || !snap.model.docId) return false;
  if (typeof snap.commentOffer !== 'boolean') {
    snap.commentOffer = stickyOffer(snap, 'comment', factsOffer(snap.comments ? commentFacts(snap.comments) : null) || chatAsked(snap, commentsMentioned, lastSentText()));
  }
  return snap.commentOffer;
}
// Once per turn, after the snapshot: the comments are read (the same read read_document include "comments" uses,
// cached on snap.comments) for the offer and the document note.
registerTurnHook('beforeTurn', async (mode, snap) => {
  if (!snap) return '';
  snap.commentFacts = null;
  if (!apiEditing(mode, snap) || !snap.model || !snap.model.docId) { snap.commentOffer = false; return ''; }
  try { snap.commentFacts = commentFacts(await fetchComments(snap)); } catch (e) { snap.commentFacts = null; }
  // without the comments (the view refused), lines with suggested changes still mean suggestion threads
  // on a provider with a prompt cache an offer stays for the rest of the chat (stickyOffer)
  snap.commentOffer = stickyOffer(snap, 'comment', (snap.commentFacts ? factsOffer(snap.commentFacts) : hasSuggestedLines(snap)) || chatAsked(snap, commentsMentioned, lastSentText()));
  return '';
});
const cwPlural = (n, w) => `${n} ${w === 'reply' && n !== 1 ? 'replies' : w + (n === 1 ? '' : 's')}`;
function commentDocNote(snap) {
  const f = snap.commentFacts;
  if (!f) return '';
  return `[Comments: ${cwPlural(f.open, 'open thread')}, ${cwPlural(f.suggestions, 'open suggested change')}.]`;
}

// ---- Planning ----------------------------------------------------------------------------------------------------
// UTF-8 length (the API counts UTF-8 code units).
function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
// The ids of a call: a list (or one string), "[id x]" / "[reply x]" as read_document shows them accepted, duplicates dropped.
function commentIds(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,\s]+/) : [];
  const out = list.map((x) => String(x == null ? '' : x).trim().replace(/^\[?\s*(?:id|reply)\s+/i, '').replace(/\]$/, '').trim()).filter(Boolean);
  return [...new Set(out)];
}
const commentThreadOf = (data, id) => (data.comments || []).find((t) => t.commentId === id) || null;
const commentSuggestionOf = (data, id) => (data.suggestions || []).find((s) => s.suggestionId === id) || null;
// The reply with post id among the comment and suggestion threads: { thread, key ('commentId' | 'suggestionId'), post }.
function commentReplyOf(data, postId) {
  for (const [list, key] of [[data.comments || [], 'commentId'], [data.suggestions || [], 'suggestionId']]) {
    for (const t of list) {
      const post = (t.replies || []).find((p) => p.postId === postId);
      if (post) return { thread: t, key, post };
    }
  }
  return null;
}
const threadKey = (t) => (t.commentId ? { commentId: t.commentId } : { suggestionId: t.suggestionId });
const threadIdOf = (t) => t.commentId || t.suggestionId;
const statusOf = (t) => String(t.status || 'OPEN').toUpperCase();
const UNKNOWN_ID = 'Use the ids read_document include ["comments"] shows: [id …] for threads and suggested changes, [reply …] for your own replies.';
const unknownIdError = (id) => ({ error: `there is no comment, reply or suggested change with the id "${id}". ${UNKNOWN_ID}`, short: `comment: unknown id ${id}` });
const authorName = (p) => { const a = (p && p.author) || {}; return a.anonymous ? 'an anonymous user' : a.displayName || 'someone else'; };
const clipText = (t, n = 80) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// The lines a list of places covers: [from, to] or null.
function placesRange(places) {
  const ls = places.filter((p) => p && p.from != null);
  return ls.length ? [Math.min(...ls.map((p) => p.from)), Math.max(...ls.map((p) => p.to))] : null;
}
const cwRangeText = (r) => (r ? rangeLabel(r[0], r[1]) : '');

// The plan of one call: { action, requests, comment (comment requests: commentUpdateState must be ALL_SAVED), indexed
// (sent with the model's revision: the range of add), expect(after, replies) -> the state to check, title, done(...),
// journal(replies) -> journal fields or null, gate, lines }, { error, short }, or { reply } (nothing to send).
function planComment(action, args, snap, data) {
  const model = snap.model;
  const text = typeof args.text === 'string' ? args.text.replace(/\r\n?/g, '\n').trim() : '';
  if (text && utf8Length(text) > COMMENT_TEXT_MAX) return { error: `the text is too long for a comment (at most ${COMMENT_TEXT_MAX} bytes); shorten it.`, short: 'comment: text too long' };
  if (action === 'add') return planCommentAdd(model, args, text);
  const ids = commentIds(args.ids);
  if (!ids.length) return { error: `${action} needs ids. ${UNKNOWN_ID}`, short: `comment ${action}: no ids` };
  if (ids.length > COMMENT_MAX_IDS) return { error: `at most ${COMMENT_MAX_IDS} ids per call.`, short: 'comment: too many ids' };
  if (action === 'reply') return planCommentReply(model, data, ids, text);
  if (action === 'resolve' || action === 'reopen') return planCommentStatus(model, data, ids, text, action);
  if (action === 'delete') return planCommentDelete(model, data, ids, snap);
  return planCommentSettle(model, data, ids, action);
}

function planCommentAdd(model, args, text) {
  if (!text) return { error: 'add needs text (the comment).', short: 'comment add: no text' };
  const assignee = typeof args.assignee === 'string' ? args.assignee.trim() : '';
  if (assignee && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignee)) return { error: `assignee must be an email address (got "${clipText(assignee, 40)}"), or null.`, short: 'comment add: invalid assignee' };
  let s;
  let e;
  if (typeof args.old_text === 'string' && args.old_text.trim()) {
    const hits = findFlexible(model.text, args.old_text);
    if (!hits.length) return { error: notFoundError(model, args.old_text, 'Copy old_text exactly from read_document, or give lines instead.', 'Copy old_text exactly from the current text above, without the "N: " prefixes, or give lines instead.'), short: 'comment add: old_text not found' };
    if (hits.length > 1) {
      const ls = [...new Set(hits.map((h) => lineAtOffset(model, h.at).line))];
      return { error: `old_text occurs ${hits.length} times (line${ls.length === 1 ? '' : 's'} ${ls.slice(0, 10).join(', ')}); give a longer old_text that occurs once, or lines.`, short: 'comment add: old_text is ambiguous' };
    }
    s = hits[0].at;
    e = s + hits[0].text.length;
  } else if (args.lines != null && String(args.lines).trim()) {
    const r = commentLineRange(args.lines);
    if (r.error) return { error: r.error.replace(/^Error: /, ''), short: 'comment add: invalid lines' };
    const n = model.lines.length;
    if (r.from < 1 || r.to > n) return { error: `lines must be within 1-${n}.`, short: 'comment add: lines out of range' };
    const a = model.lines[r.from - 1];
    const b = model.lines[r.to - 1];
    s = a.off;
    e = b.off + b.text.length;
    if (e <= s) return { error: `${rangeLabel(r.from, r.to)} ${r.from === r.to ? 'is' : 'are'} empty; anchor the comment on text.`, short: 'comment add: empty lines' };
  } else {
    return { error: 'add needs old_text (the text to comment on) or lines.', short: 'comment add: no anchor' };
  }
  const first = lineAtOffset(model, s).line;
  const last = lineAtOffset(model, e - 1).line;
  for (let i = first; i <= last; i++) {
    if (!model.lines[i - 1].exact) return { error: `${inexactLine(i, 'anchor the comment on other text')}.`, short: 'comment add: inexact line' };
  }
  const range = reqRange(model, indexAtOffset(model, s), indexAtOffset(model, e - 1) + 1);
  const where = rangeLabel(first, last);
  let newId = null;
  return {
    action: 'add', comment: true, indexed: true, lines: [first, last],
    requests: [{ insertComment: { content: text, range, ...(assignee ? { assigneeEmailAddress: assignee } : {}) } }],
    title: `Comment on ${where}`,
    gate: { what: 'adds a comment', range: where, excerptLabel: 'Comment', excerpt: text },
    expect: (after, replies, before) => {
      const t = ((replies[0] || {}).insertComment || {}).commentThread;
      newId = (t && t.commentId) || ((after.comments || []).find((x) => !commentThreadOf(before, x.commentId) && ((x.headPost || {}).content || '').trim() === text) || {}).commentId || null;
      return newId ? { threads: { [newId]: 'OPEN' } } : { missing: 'the new comment is not in the document' };
    },
    done: () => `added comment${newId ? ` [id ${newId}]` : ''} on ${where}${assignee ? `, assigned to ${assignee}` : ''}.`,
    journal: () => (newId
      ? { inverse: [{ deleteComment: { commentId: newId } }], undoExpect: { threads: { [newId]: 'GONE' } }, undoWhat: `deleted the comment [id ${newId}] on ${where}` }
      : { undoable: false }),
  };
}

function planCommentReply(model, data, ids, text) {
  if (ids.length > 1) return { error: 'reply takes one thread id; call it once per thread.', short: 'comment reply: one id' };
  if (!text) return { error: 'reply needs text.', short: 'comment reply: no text' };
  const t = commentThreadOf(data, ids[0]) || commentSuggestionOf(data, ids[0]);
  if (!t) return unknownIdError(ids[0]);
  const place = t.commentId ? commentPlace(model, data, t) : suggestionPlace(model, data, t);
  let postId = null;
  return {
    action: 'reply', comment: true, lines: placesRange([place]),
    requests: [{ addCommentReply: { ...threadKey(t), post: { content: text } } }],
    title: `Reply to ${threadIdOf(t)}`,
    gate: { what: 'replies to a comment', range: place.where, excerptLabel: 'Reply', excerpt: text },
    expect: (after, replies) => {
      postId = (((replies[0] || {}).addCommentReply || {}).post || {}).postId || null;
      return { replies: [{ thread: threadIdOf(t), postId, text }] };
    },
    done: () => `replied to [id ${threadIdOf(t)}]${postId ? ` (reply ${postId})` : ''}.`,
    journal: () => (postId
      ? { inverse: [{ deleteCommentReply: { ...threadKey(t), postId } }], undoExpect: { replies: [{ thread: threadIdOf(t), postId, gone: true }] },
        undoWhat: `deleted the reply ${postId} in [id ${threadIdOf(t)}]` }
      : { undoable: false }),
  };
}

function planCommentStatus(model, data, ids, text, action) {
  const want = action === 'resolve' ? 'RESOLVED' : 'OPEN';
  const act = action === 'resolve' ? 'RESOLVE' : 'REOPEN';
  const back = action === 'resolve' ? 'REOPEN' : 'RESOLVE';
  const todo = [];
  const already = [];
  for (const id of ids) {
    const t = commentThreadOf(data, id);
    if (!t) return commentSuggestionOf(data, id) ? { error: `${id} is a suggested change: use accept or reject.`, short: `comment ${action}: ${id} is a suggestion` } : unknownIdError(id);
    if (statusOf(t) === want) already.push(id); else todo.push(t);
  }
  const state = action === 'resolve' ? 'resolved' : 'open';
  const alreadyNote = already.length ? `${already.map((x) => `[id ${x}]`).join(', ')} ${already.length === 1 ? 'was' : 'were'} already ${state}.` : '';
  if (!todo.length) return { reply: { content: `No change: ${alreadyNote}`, _ok: true, _message: `No change: already ${state}` } };
  const list = todo.map((t) => `[id ${t.commentId}]`).join(', ');
  const range = placesRange(todo.map((t) => commentPlace(model, data, t)));
  const n = cwPlural(todo.length, 'comment thread');
  return {
    action, comment: true, lines: range,
    requests: todo.map((t) => ({ addCommentReply: { commentId: t.commentId, post: { commentAction: act, ...(text ? { content: text } : {}) } } })),
    title: `${action === 'resolve' ? 'Resolve' : 'Reopen'} ${n}`,
    gate: { what: `${action === 'resolve' ? 'resolves' : 'reopens'} ${n}`, range: cwRangeText(range), excerptLabel: text ? 'Reply' : '', excerpt: text || '' },
    expect: () => ({ threads: Object.fromEntries(todo.map((t) => [t.commentId, want])) }),
    done: () => `${action === 'resolve' ? 'resolved' : 'reopened'} ${list}.${already.length ? ' ' + alreadyNote : ''}`,
    journal: () => ({
      inverse: todo.map((t) => ({ addCommentReply: { commentId: t.commentId, post: { commentAction: back } } })),
      undoExpect: { threads: Object.fromEntries(todo.map((t) => [t.commentId, want === 'OPEN' ? 'RESOLVED' : 'OPEN'])) },
      undoWhat: `${action === 'resolve' ? 'reopened' : 'resolved'} ${list} again`,
      undoNote: `Note: the thread${todo.length === 1 ? ' shows' : 's show'} both entries ("${action === 'resolve' ? 'resolved' : 'reopened'}", then "${action === 'resolve' ? 'reopened' : 'resolved'}"); Google Docs keeps them.`,
    }),
  };
}

function planCommentDelete(model, data, ids, snap) {
  const requests = [];
  const expect = { threads: {}, replies: [] };
  const excerpts = [];
  const places = [];
  for (const id of ids) {
    const t = commentThreadOf(data, id);
    if (t) {
      const head = t.headPost || {};
      if (!(head.author || {}).me) return { error: `only the author can delete a comment, and [id ${id}] is by ${authorName(head)}: resolve it instead, or ask the user to delete it in Google Docs.`, short: `comment delete: ${id} is not yours` };
      requests.push({ deleteComment: { commentId: id } });
      expect.threads[id] = 'GONE';
      excerpts.push(`[id ${id}] ${String(head.content || '').trim()}${(t.replies || []).filter((p) => !p.deleted).length ? ` (with ${cwPlural(t.replies.filter((p) => !p.deleted).length, 'reply')})` : ''}`);
      places.push(commentPlace(model, data, t));
      continue;
    }
    if (commentSuggestionOf(data, id)) return { error: `${id} is a suggested change: use reject to remove it.`, short: `comment delete: ${id} is a suggestion` };
    const r = commentReplyOf(data, id);
    if (!r) return unknownIdError(id);
    if (!ownReplyDeletable(r.post)) {
      return { error: `the reply ${id} cannot be deleted: only your own replies without a resolve, reopen or assignment can be.`, short: `comment delete: reply ${id} cannot be deleted` };
    }
    requests.push({ deleteCommentReply: { ...threadKey(r.thread), postId: id } });
    expect.replies.push({ thread: threadIdOf(r.thread), postId: id, gone: true });
    excerpts.push(`reply ${id}: ${String(r.post.content || '').trim()}`);
  }
  const range = placesRange(places);
  const nThreads = Object.keys(expect.threads).length;
  const nReplies = expect.replies.length;
  const what = [nThreads ? cwPlural(nThreads, 'comment thread') : '', nReplies ? cwPlural(nReplies, 'reply') : ''].filter(Boolean).join(' and ');
  const asked = deleteCommentsAsked(commentTurnText(snap));
  // The panel cannot undo it (undoable: false): asked for, it asks in Manual and in a tainted turn; not asked for, every
  // time (asks), also after "Allow all in this turn" (always).
  return {
    action: 'delete', comment: true, lines: range, requests,
    title: `Delete ${what}`,
    gate: asked
      ? { undoable: false, what: `deletes ${what}`, why: `Deletes ${what}. This cannot be undone from the panel.`, range: cwRangeText(range), excerptLabel: 'Deleted', excerpt: excerpts.join('\n') }
      : { undoable: false, asks: true, always: true, why: `Delete ${what}? This cannot be undone from the panel.`, what: `deletes ${what}`, range: cwRangeText(range) || 'Comments',
        excerptLabel: 'Deleted', excerpt: excerpts.join('\n') },
    expect: () => expect,
    done: () => `deleted ${what} (${ids.join(', ')}). This cannot be undone from the panel.`,
    journal: () => ({ undoable: false }),
  };
}

function planCommentSettle(model, data, ids, action) {
  const verb = action === 'accept' ? 'accepted' : 'rejected';
  const todo = [];
  const closed = [];
  for (const id of ids) {
    const s = commentSuggestionOf(data, id);
    if (!s) return commentThreadOf(data, id) ? { error: `${id} is a comment thread, not a suggested change: use resolve.`, short: `comment ${action}: ${id} is a comment` } : unknownIdError(id);
    if (statusOf(s) !== 'OPEN') closed.push(id); else todo.push(s);
  }
  const closedNote = closed.length ? `${closed.map((x) => `[id ${x}]`).join(', ')} ${closed.length === 1 ? 'is' : 'are'} no longer open.` : '';
  if (!todo.length) return { reply: { content: `No change: ${closedNote}`, _ok: true, _message: 'No change: suggestions not open' } };
  const range = placesRange(todo.map((s) => suggestionPlace(model, data, s)));
  const n = cwPlural(todo.length, 'suggested change');
  const excerpt = todo.map((s) => `[id ${s.suggestionId}] ${String(s.summaryText || (s.headPost || {}).content || '').trim()}`).join('\n');
  return {
    action, comment: false, changesText: true, lines: range,
    requests: todo.map((s) => ({ [action === 'accept' ? 'acceptSuggestion' : 'rejectSuggestion']: { suggestionId: s.suggestionId } })),
    title: `${action === 'accept' ? 'Accept' : 'Reject'} ${n}`,
    // The panel cannot undo it: more than COMMENT_GATE_SUGGESTIONS ask in Auto too (asks), fewer in Manual and in a
    // tainted turn.
    gate: { undoable: false, asks: todo.length > COMMENT_GATE_SUGGESTIONS, what: `${action}s ${n}`, range: cwRangeText(range) || 'Suggested changes',
      excerptLabel: 'Suggested changes', excerpt, why: `${action === 'accept' ? 'Accepts' : 'Rejects'} ${n}. This cannot be undone from the panel (Ctrl+Z in Google Docs can).` },
    expect: () => ({ suggestions: todo.map((s) => s.suggestionId) }),
    done: () => `${verb} ${n} (${todo.map((s) => s.suggestionId).join(', ')})${range ? ` on ${cwRangeText(range)}` : ''}.${closed.length ? ' ' + closedNote : ''} This cannot be undone from the panel: use Ctrl+Z in Google Docs if needed.`,
    journal: () => ({ undoable: false }),
  };
}

// ---- Verification ------------------------------------------------------------------------------------------------
// What of expect ({ threads: { id: 'OPEN' | 'RESOLVED' | 'GONE' }, replies: [{ thread, postId, text?, gone? }],
// suggestions: [ids that must be settled], missing }) the comments read again (data) do not show: a list of phrases.
function commentProblems(data, expect) {
  const out = [];
  if (expect.missing) out.push(expect.missing);
  for (const [id, want] of Object.entries(expect.threads || {})) {
    const t = commentThreadOf(data, id);
    if (want === 'GONE') { if (t && !(t.headPost || {}).deleted) out.push(`the comment [id ${id}] is still there`); continue; }
    if (!t) out.push(`the comment [id ${id}] is not in the document`);
    else if (statusOf(t) !== want) out.push(`the comment [id ${id}] is still ${isOpenThread(t) ? 'open' : 'resolved'}`);
  }
  for (const r of expect.replies || []) {
    const t = commentThreadOf(data, r.thread) || commentSuggestionOf(data, r.thread);
    const posts = ((t && t.replies) || []).filter((p) => !p.deleted);
    const found = r.postId ? posts.some((p) => p.postId === r.postId) : posts.some((p) => (p.author || {}).me && String(p.content || '').trim() === r.text);
    if (r.gone && found) out.push(`the reply ${r.postId} is still in [id ${r.thread}]`);
    if (!r.gone && !found) out.push(`the reply is not in [id ${r.thread}]`);
  }
  for (const id of expect.suggestions || []) {
    const s = commentSuggestionOf(data, id);
    const at = (data.suggestionAt || {})[id];
    if ((s && statusOf(s) === 'OPEN') || (at && at.starts.length)) out.push(`the suggested change [id ${id}] is still open`);
  }
  return out;
}
const RETRY_NEXT = 'Read the comments again with read_document include ["comments"] and try once more; if it fails again, tell the user to do it in Google Docs.';
const batchPath = (docId) => `${encodeURIComponent(docId)}:batchUpdate`;
// A failed commentUpdateState for comment requests (anything but ALL_SAVED; a missing state is checked by the re-read),
// or ALL_FAILED_UNKNOWN_REASON for suggestions (their batches may say NO_UPDATES_REQUESTED).
const stateFailed = (state, comment) => !!state && (comment ? state !== 'ALL_SAVED' : state === 'ALL_FAILED_UNKNOWN_REASON');

// Sends the plan (its own batch: comment requests only), reads the document and the comments again and checks them.
async function commitComment(snap, plan, id) {
  const model = snap.model;
  const before = snap.comments;
  let res;
  try {
    res = plan.indexed ? await docsBatchUpdate(model, plan.requests)
      : await docsApi(batchPath(model.docId), { method: 'POST', body: { requests: plan.requests } });
  } catch (e) {
    return writeError(`the comment change was not made (${e.message}). ${RETRY_NEXT}`, `${plan.title}: failed`);
  }
  const replies = (res && res.replies) || [];
  const state = res && res.commentUpdateState;
  // The revision moved (and accept / reject changed the text): the turn's model is read again, so later writes and
  // the lines of formerly suggested text are current.
  let readError = null;
  try {
    const m = await fetchDocModel(model.docId, model.tabId);
    setSnapModel(snap, m);
    useDocModel(m);
  } catch (e) { readError = e; }
  if (plan.changesText) snap.responseWrite = { from: (plan.lines || [1, 1])[0], to: (plan.lines || [1, 1])[1] };
  if (stateFailed(state, plan.comment)) {
    return writeError(`Google Docs did not save the change (commentUpdateState ${state}). ${RETRY_NEXT}`, `${plan.title}: not saved`);
  }
  snap.comments = null; // the comments were changed: read them again whether or not the revision moved
  let after = null;
  let verifyNote = '';
  try { after = await fetchComments(snap); } catch (e) {
    verifyNote = `\nNote: the comments could not be read again to check the change (${e.message}).`;
  }
  const expect = plan.expect(after || { comments: [], suggestions: [] }, replies, before || { comments: [], suggestions: [] });
  if (after) {
    const problems = commentProblems(after, expect);
    if (problems.length) return writeError(`Google Docs answered, but ${problems.join('; ')}. ${RETRY_NEXT}`, `${plan.title}: not verified`);
  }
  const journal = plan.journal(replies);
  const m = snap.model;
  let report = '';
  if (plan.changesText && !readError) {
    const r = plan.lines || [1, 1];
    const n = m.lines.length;
    const a = Math.min(r[0], n);
    report = `\n${linesReport(m, a, Math.min(Math.max(a, r[1]), n))}\nThe document has ${n} lines.`;
  } else if (plan.changesText) {
    report = `\nThe document could not be read again (${readError.message}); read it again before the next edit.`;
  }
  const edit = journal ? { id, docId: model.docId, tabId: model.tabId, kind: 'comment', title: plan.title, undone: false, anchor: false, lines: plan.lines, ...journal } : undefined;
  return { content: `Done: ${plan.done()}${report}${verifyNote}`, _ok: true, _message: plan.title, ...(edit ? { _edit: edit } : {}), _cardLabel: 'Comment' };
}

// ---- The tool ------------------------------------------------------------------------------------------------------
async function runComment(name, args, snap, ui, call) {
  const action = String((args && args.action) || '');
  if (!COMMENT_ACTIONS.includes(action)) return writeError(`action must be one of ${COMMENT_ACTIONS.join(', ')}.`, 'comment: invalid action');
  if (snap.docFormat !== 'docs-api' || !snap.model) return writeError('comments need the Google Docs API, which is not available for this message.', 'comment: no Docs API');
  let data;
  try { data = await fetchComments(snap); } catch (e) {
    return writeError(`could not read the comments (${e.message}); nothing was changed. Try again once; if it fails again, tell the user.`, 'comment: comments not read');
  }
  const plan = planComment(action, args || {}, snap, data);
  if (plan.error) return writeError(plan.error, plan.short);
  if (plan.reply) return plan.reply;
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  return commitComment(snap, plan, call.id);
}

// add anchors on lines only when it gives no old_text (old_text wins, as planComment reads them).
function commentUsesLines(name, args) {
  const a = args || {};
  return String(a.action || '') === 'add' && !(typeof a.old_text === 'string' && a.old_text.trim()) && a.lines != null && String(a.lines).trim() !== '';
}

function commentSummary(name, args) {
  const a = String((args && args.action) || '');
  if (a === 'add') return args.lines ? `add on lines ${args.lines}` : `add on «${clipText(args.old_text, 40)}»`;
  const ids = commentIds(args && args.ids);
  return `${a}${ids.length ? ' ' + clipText(ids.join(', '), 60) : ''}`;
}

registerTools(COMMENT_TOOL, {
  offer: commentOffered,
  reading: false,
  pending: 'Updating comments…',
  status: 'Updating comments…',
  summary: commentSummary,
  usesLines: commentUsesLines,
  gate: (name, plan) => plan.gate,
  prompt: [{ section: 'edit', line: '- Comments and suggested changes: read them with read_document include ["comments"], then reply, resolve, accept or reject with comment; never type a comment into the text, and delete only when the user asks.' }],
  docNote: commentDocNote,
  run: runComment,
});

// ---- Undo ------------------------------------------------------------------------------------------------------------
// The inverse requests in one batch (add → deleteComment, reply → deleteCommentReply, resolve ↔ reopen), then the
// comments read again to check them. The text is untouched: the report shows the comment's lines.
async function undoComment(edit) {
  if (edit.undoable === false || !(edit.inverse || []).length) throw new Error('that comment change cannot be undone from the panel.');
  const res = await docsApi(batchPath(edit.docId), { method: 'POST', body: { requests: edit.inverse } });
  const state = res && res.commentUpdateState;
  if (stateFailed(state, true)) throw new Error(`Google Docs did not save the undo (commentUpdateState ${state}); check the comment in Google Docs.`);
  const model = await fetchDocModel(edit.docId, edit.tabId);
  let note = edit.undoNote || '';
  try {
    const problems = commentProblems(await fetchComments({ model }), edit.undoExpect || {});
    if (problems.length) throw new Error(`Google Docs answered, but ${problems.join('; ')}; check the comment in Google Docs.`);
  } catch (e) {
    if (/^Google Docs answered/.test(e.message)) throw e;
    note = [note, `Note: the comments could not be read again to check the undo (${e.message}).`].filter(Boolean).join('\n');
  }
  const n = model.lines.length;
  const r = edit.lines || [1, 1];
  const a = Math.min(r[0], n);
  return { model, restored: '', lostObjects: false, range: [a, Math.min(Math.max(a, r[1]), n)], what: edit.undoWhat || `undid "${edit.title}"`, note: note || undefined };
}
registerUndoHandler('comment', undoComment);

// ---- Self-test ---------------------------------------------------------------------------------------------------------
// Add a comment on «lazy dog», reply, resolve, read them back; then undo the three (reopen, the reply deleted, the
// thread deleted) and check the thread is gone. Runs on the real document of /test: the API calls are the real ones.
const ST_COMMENT = 'Self-test comment';
const ST_REPLY = 'Self-test reply';
async function stComments(ctx) {
  ctx.snap.commentOffer = true; // offered in this check whatever the document holds
  const add = await stWrite(ctx, 'comment', { action: 'add', ids: null, text: ST_COMMENT, old_text: 'lazy dog', lines: null, assignee: null });
  const m = /\[id ([^\]]+)\]/.exec(add.content);
  if (!m) return stFail('comment add did not name the new thread', stClip(add.content, 300));
  const id = m[1];
  await stWrite(ctx, 'comment', { action: 'reply', ids: [id], text: ST_REPLY, old_text: null, lines: null, assignee: null });
  await stWrite(ctx, 'comment', { action: 'resolve', ids: [id], text: null, old_text: null, lines: null, assignee: null });
  const r = await stTool(ctx, 'read_document', { scope: 'all', include: ['comments'], doc: null });
  const got = String(r.content || '');
  if (!got.includes(`[id ${id}] resolved`) || !got.includes(ST_COMMENT) || !got.includes(ST_REPLY)) return stFail('read_document comments does not show the resolved thread with its reply', stClip(got, 400));
  for (let i = 0; i < 3; i++) await stWrite(ctx, 'undo_last_edit', {});
  const back = await stTool(ctx, 'read_document', { scope: 'all', include: ['comments'], doc: null });
  if (String(back.content || '').includes(`[id ${id}]`)) return stFail(`after three undo_last_edit the thread ${id} is still there`, stClip(back.content, 400));
  return stPass(`comment ${id} on «lazy dog» added, answered, resolved and read back; undone three times (reopened, reply deleted, thread deleted)`);
}
registerSelfTestRows([{ name: 'Write: comments', run: (ctx) => stWriteStep(stComments)(ctx) }]);
