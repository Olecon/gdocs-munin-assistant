'use strict';
// Module docs-write.js: writing through documents.batchUpdate: request builders, edit plans
// (planReplaceText, planReplaceAll, planReplaceSection, planInsert, planDelete, planFormat, planFormatLines, and
// planEditDocument, which puts several of them in one batch), commitEdit, runWriteTool and the
// replace_selection path through the API (planApiSelection, apiReplaceSelection).
/* global ambiguousError, ANCHOR_CHARS, headingLevel, headingName, apiColor, capFirst, citationsInRanges, commonEdges, disjointHits, docsApi, fetchDocModel,
   findFlexible, FORMAT_KEYS, formatNote, gateEdit, HEADING_STYLES, hitLines, parseHeading, indexRange, inexactLine, isClosing, knownFont, lineAtIndex, lineList,
   linesReport, markedText, MARKERS_NOTE, FOLDED_NOTE, NORMALIZED_NOTE, notFoundError, numText, OBJECT_CHAR, oneLine, parseColor,
   parsePt, parseSize, ptDimension, rangeLabel, regionNote, renderSelection, showText, SOFT_BREAK_MARK, spanDefault, state, stripMarkers,
   TEXT_STYLE_API_FIELDS, textAtIndexRange, undoLastEditTool, useDocModel, lineAtOffset, withLock */
/* global errorWords, errorClause, rawError */
/* global apiEditing, confirmOpen, editPreview, noteDenied, EDIT_DENIED_TEXT, EDIT_STOPPED_TEXT, registerPromptLine, textLang */
/* global pickByContext, selectionContextOf */
/* global newParagraphSheetRequests, newParaStyle, priorParaStyle, BOX_FIELDS, boxKind, boxParagraphStyle, parseBox, numberedHeadingIndent, numbersNote, sameIndent, typedNumberOnly, sheetEntry, sheetLineRequests, sheetLineChanges, sheetLinesMiss,
   sheetNumbersNotes, styleSheetFor, namedStyleValues, turnNamedStyles, knowUnmarkedFont, unmarkedDefault */
/* global DOCS_GREY_STYLES, namedColor, styleColorNote, turnNamedKnown */
/* exported lineDriftError, reqDelete, reqInsert, reqStyle, restyle, rangeStyles, restoredStyles, styleAfterDelete, sanitizeInsertText, docsBatchUpdate, setSnapModel, anchorMatches,
   writeError, formatArgsText, formatLinesArgsText, runWriteTool, planApiSelection, apiReplaceSelection,
   reqLocation, reqRange, reqEndOfSegment, reqTextStyle, reqParaStyle, reqBulletsOn, reqBulletsOff, modelInsertText,
   commitSequence, finishEdit, findOldText, replacePlan, makeAnchor, multiJournal, storedTextNote,
   withDocWrite, rereadForAgent, agentStaleError, planEditDocument, shiftIndices, writeOps, noteDroppedOps, chipText, finishChips, personGate,
   suggestPreference, suggestOn, suggestOverlapError, suggestionSpans, SUGGEST_UNDO_ADVICE, suggestState, refusedInSuggest */
/* global segmentModel, fetchDocRevision, registerTurnHook */

// ---- Writing (documents.batchUpdate) ------------------------------------------------------------
// The request builders take the model the indices belong to: a body model, or a segment model (a header,
// footer or footnote from model.segments; segmentModel / findSegment), whose segmentId they add. So a plan
// built on a segment model (replacePlan included) addresses that segment without hand-made locations.
const withTab = (model, o) => {
  const r = model.tabId ? { ...o, tabId: model.tabId } : o;
  return model.segmentId ? { ...r, segmentId: model.segmentId } : r;
};
// A Location ({ index, segmentId?, tabId? }), a Range, and an EndOfSegmentLocation of the model's segment.
const reqLocation = (model, index) => withTab(model, { index });
const reqRange = (model, s, e) => withTab(model, { startIndex: s, endIndex: e });
const reqEndOfSegment = (model) => withTab(model, {});
const reqDelete = (model, s, e) => ({ deleteContentRange: { range: withTab(model, { startIndex: s, endIndex: e }) } });
const reqInsert = (model, at, text) => ({ insertText: { location: withTab(model, { index: at }), text } });
const reqStyle = (model, s, e, style) => ({ updateParagraphStyle: { range: withTab(model, { startIndex: s, endIndex: e }), paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } });
// A namedStyleType write that changes no paragraph's style clears the text styles (bold, fonts, sizes, colors) of every
// paragraph in its range in Google Docs; one that changes the style clears what covers the whole line. So the plans send
// a named style only where it differs from the one Docs leaves (styleAfterDelete): restyle gives [] or [reqStyle].
const sameNamedStyle = (a, b) => (a || 'NORMAL_TEXT') === (b || 'NORMAL_TEXT');
const restyle = (model, s, e, style, now) => (style && (now == null || !sameNamedStyle(style, now)) ? [reqStyle(model, s, e, style)] : []);
// The named style of the paragraph at S after [S, E) is deleted (E = S: nothing): a merge keeps the paragraph the range
// starts in when some of its text stays before S, else the one the range ends in; the paragraphs an insertText at S then
// makes copy it (Google Docs, real-docs.js facts 7d, 7e). null when S is on no line.
function styleAfterDelete(model, S, E) {
  const a = lineAtIndex(model, S);
  if (!a) return null;
  const b = E > S && S === a.start ? lineAtIndex(model, E) : null;
  return ((b || a).style) || 'NORMAL_TEXT';
}
// fields: the attributes to change; one listed in fields but absent from textStyle is reset (inherited).
const reqTextStyle = (model, s, e, textStyle, fields) => ({ updateTextStyle: { range: withTab(model, { startIndex: s, endIndex: e }), textStyle, fields: fields.join(',') } });

// The Docs API strips C0 control characters (except tab, newline, vertical tab) and private-use
// characters from inserted text; removing them first keeps the recorded lengths exact.
// eslint-disable-next-line no-control-regex -- strips the C0 controls the Docs API drops
const sanitizeInsertText = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000C-\u001F\uE000-\uF8FF]/g, '');
// Text from the model for insertion: the soft-break mark becomes a real soft break.
const modelInsertText = (t) => sanitizeInsertText(String(t == null ? '' : t).split(SOFT_BREAK_MARK).join('\u000b'));
// Applies requests to the document the model was read from. writeControl.requiredRevisionId makes the
// API refuse the edit when the document changed after it was read (someone typed meanwhile).
function docsBatchUpdate(model, requests) {
  const body = { requests };
  if (model.revisionId) body.writeControl = { requiredRevisionId: model.revisionId };
  return docsApi(`${encodeURIComponent(model.docId)}:batchUpdate`, { method: 'POST', body });
}

// Re-reads the document after a write and puts the new model into the turn snapshot and the panel state.
async function refreshSnapModel(snap) {
  const model = await fetchDocModel(snap.model.docId, snap.model.tabId);
  setSnapModel(snap, model);
  useDocModel(model);
  return model;
}
function setSnapModel(snap, model) {
  snap.model = model;
  snap.docText = model.text;
  snap.docFormat = 'docs-api';
  snap.lines = null;
}

// The phase of the running write for the live bubble (the tool loop sets snap.onWritePhase): 'writing' while a
// batchUpdate is sent, 'verifying' while the document is re-read to check it. Display only: a throwing hook is ignored.
function writePhase(snap, phase) {
  if (typeof snap.onWritePhase !== 'function') return;
  try { snap.onWritePhase(phase); } catch (e) { /* display only */ }
}

// Text offset of API index idx, or null.
function offsetAtIndex(model, idx) {
  const l = lineAtIndex(model, idx);
  return l ? l.off + (idx - l.start) : null;
}

// Context of an edit for undo: the text right before index and right after index + len in the model
// read right after the edit (and its revision). An undo is applied only where this context is found
// unchanged, so a later change near the edit (typing, a pasted replacement) blocks it.
function makeAnchor(model, index, text) {
  const o1 = offsetAtIndex(model, index);
  if (o1 == null) return null;
  const o2 = o1 + text.length;
  if (text && textAtIndexRange(model, index, index + text.length) !== text) return null;
  return { before: model.text.slice(Math.max(0, o1 - ANCHOR_CHARS), o1), after: model.text.slice(o2, o2 + ANCHOR_CHARS), revision: model.revisionId };
}
function anchorMatches(model, edit) {
  if (!edit.anchor) return false;
  const now = makeAnchor(model, edit.index, edit.text || '');
  return !!now && now.before === edit.anchor.before && now.after === edit.anchor.after;
}

// Paragraph styles for undo, relative to the restored text: nl -1 is the paragraph containing the
// edit's index, nl j the paragraph that starts after the j-th newline of the restored text.
const paraStyles = (model, a, b, firstNl) => {
  const out = [];
  for (let i = a; i <= b; i++) out.push({ nl: firstNl + (i - a), style: model.lines[i - 1].style || '' });
  return out;
};

// commonEdges of a document text and its replacement. loose (a normalized match): the unchanged edges
// may differ in characters that normalize alike, so the document keeps its NBSPs, curly quotes and dashes
// there; when that leaves nothing to change (the replacement only changes such characters), exact edges.
function editEdges(oldText, newText, loose) {
  const e = loose ? commonEdges(oldText, newText, { loose: true }) : null;
  return e && (e.p + e.q < oldText.length || e.p + e.q < newText.length) ? e : commonEdges(oldText, newText);
}

// commonEdges cut back to whole paragraphs (replace_section: oldText and newText start with the heading's newline): the
// kept beginning ends after a newline and the kept end starts with one, so every paragraph that changes is rewritten
// whole and gets the formatting sheet, never half old, half new.
function paragraphEdges(oldText, newText) {
  const e = commonEdges(oldText, newText);
  const p = Math.max(oldText.lastIndexOf('\n', e.p - 1) + 1, oldText[0] === '\n' && newText[0] === '\n' ? 1 : 0);
  const tail = oldText.slice(oldText.length - e.q);
  const k = tail.indexOf('\n');
  const q = k < 0 ? 0 : e.q - k;
  return { p: Math.min(p, e.p), q: Math.max(0, Math.min(q, oldText.length - p, newText.length - p)) };
}

// URLs of the links on text in API range [S, E) (the runs of the line model), in order, unique.
function linksInRange(model, S, E) {
  const out = [];
  if (E <= S) return out;
  const a = lineAtIndex(model, S);
  const b = lineAtIndex(model, E - 1) || a;
  if (!a) return out;
  for (let i = a.line; i <= b.line; i++) {
    const l = model.lines[i - 1];
    for (const run of l.runs || []) {
      if (run.link && l.start + run.s < E && l.start + run.e > S && !out.includes(run.link)) out.push(run.link);
    }
  }
  return out;
}
// format_text takes a URL link (run.link holds only URLs), so the way back is named.
const linkNote = (links) => `Note: the replaced text contained a link (${links.join(', ')}); if the new text should keep it, set it with format_text link.`;

// Applies a planned edit: batchUpdate, journal entry (_edit, its inverse for undo), re-read, report.
// plan: { requests, journal: {kind, index, text, restore, paras, segmentId?}, title, cardText, cardLabel,
//         region: [from, to] (lines before the edit), affected(model) -> [from, to] (lines after it),
//         optional done (result sentence instead of the title), report(model) (instead of linesReport),
//         removed ([[start, end)] text offsets the edit deletes; runWriteTool checks them for citations) }
// Any failure re-reads the document and shows the current text of the region, so old line numbers are
// never implied to be valid. _notSent marks failures where certainly nothing changed (paste fallback).
async function commitEdit(snap, plan, id) {
  if (plan.suggest) return commitSuggestion(snap, plan, id); // suggest mode (the end of this file)
  try {
    writePhase(snap, 'writing');
    await docsBatchUpdate(snap.model, plan.requests);
  } catch (e) {
    return batchFailure(snap, plan, id, e);
  }
  return finishEdit(snap, plan, id, null);
}

// The tool fields of a failed batchUpdate of plan (commitEdit, the first batch of commitSequence): the document
// is re-read and the current text of the plan's region shown, so old line numbers are never implied to be valid.
async function batchFailure(snap, plan, id, e) {
  const before = snap.model;
  if (e.preSend) return { ...writeError(`the edit was not sent: ${errorClause(e)}.`, 'Edit not sent'), _notSent: true, _rawError: rawError(e) };
  let now = null;
  try { now = await refreshSnapModel(snap); } catch (e2) { /* state unknown */ }
  const changed = !!now && now.revisionId !== before.revisionId;
  const [rf, rt] = plan.region;
  // The document changed (or its state is unknown): line numbers the model saw before this call are
  // stale for the rest of this response.
  if (changed || !now) snap.responseWrite = { from: rf, to: rt };
  if (e.network) {
    if (now && !changed) return { ...writeError(`${errorWords(e)} The edit was not applied.${regionNote(now, rf, rt)}`, 'Edit failed: no connection'), _notSent: true, _rawError: rawError(e) };
    const j = plan.journal;
    const jm = now && segmentModel(now, j.segmentId);
    // Formatting leaves the text as it was, so the text cannot show whether it arrived.
    if (jm && j.text && j.kind !== 'format' && typeof j.index === 'number' && textAtIndexRange(jm, j.index, j.index + j.text.length) === j.text) return finishEdit(snap, plan, id, now);
    return { ...writeError(`${errorWords(e)} The connection failed while the edit was being sent and it is unclear whether it was applied; check the text before editing again.${regionNote(now, rf, rt)}`, 'Edit failed: no connection'), _rawError: rawError(e) };
  }
  if (e.status === 400 && changed) {
    return writeError(`the document changed after it was read (you or a collaborator edited it), so the edit was not applied.${regionNote(now, rf, rt)}\nCheck the text and retry with the current line numbers.`, 'The document changed meanwhile; edit not applied');
  }
  return { ...writeError(`the Google Docs API rejected the edit: ${errorWords(e)}${regionNote(now, rf, rt)}`, 'Edit failed: ' + errorClause(e)), _notSent: e.status === 401 || e.status === 403, _rawError: rawError(e) };
}

// An edit that needs several batchUpdates, each built on the document as the previous one left it (the Docs API
// cannot, for example, insert a table and fill its cells, or create a header and write into it, in one batch).
// steps: [(model, replies) => ({ requests, rollback?: (model, replies) => requests, applied?: (model) => bool })]:
// model is snap.model for the first step, then the document re-read after the previous batch; replies: the replies
// of the batches so far (replies[k][i]: request i of batch k, e.g. replies[0][0].createHeader.headerId). A later
// batch that fails rolls back the earlier ones (their rollback, newest first, each on a fresh read). When its outcome
// is unclear (unclearFailure: the response was lost), the document is re-read once first: a batch that arrived is
// rolled back too (its rollback then gets replies without its own, which was lost); whether it arrived is
// step.applied(model), else whether the revision moved (requiredRevisionId refuses a batch on a document someone
// changed meanwhile, so a new revision is this batch). A re-read that fails rolls nothing back (which steps are in
// the document is unknown). A step without a rollback relies on the earlier ones' (deleting a new table, header or
// footnote removes what was written into it). Returns { model, replies } (snap.model is the final read: pass it to
// finishEdit(snap, plan, id, model)) or { fail: tool fields (an "Error:" result; the first batch fails like
// commitEdit) }. plan: { region, journal } for the error reports.
async function commitSequence(snap, plan, id, steps) {
  const replies = [];
  const done = [];
  let model = snap.model;
  for (let k = 0; k < steps.length; k++) {
    let step = null;
    let sending = false;
    try {
      step = steps[k](model, replies);
      sending = true;
      writePhase(snap, 'writing');
      const res = await docsBatchUpdate(model, step.requests);
      sending = false;
      replies.push((res && res.replies) || []);
      done.push(step);
      writePhase(snap, 'verifying');
      model = await refreshSnapModel(snap);
    } catch (e) {
      if (!done.length) return { fail: await batchFailure(snap, plan, id, e) };
      if (sending && unclearFailure(e)) return { fail: await unclearRollBack(snap, plan, done, step, model, replies, e) };
      return { fail: await rollBack(snap, plan, done, replies, e) };
    }
  }
  return { model, replies };
}
// A failed batchUpdate that may have been applied all the same: the connection failed, or Google answered 5xx.
// A 4xx is a refusal, so nothing of that batch was applied.
const unclearFailure = (e) => !e.preSend && (!!e.network || e.status >= 500);
// The rollback of commitSequence after an unclear failure of the batch of step (sent on model, the read before it).
async function unclearRollBack(snap, plan, done, step, model, replies, e) {
  let now = null;
  try { now = await refreshSnapModel(snap); } catch (e2) { /* state unknown */ }
  if (!now) {
    snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
    return { ...writeError(`the edit failed halfway (${errorClause(e)}): its first ${done.length === 1 ? 'part was' : `${done.length} parts were`} applied, and whether the rest arrived is unknown because the document could not be read again. The edit may be partly applied; check the document before editing again.`,
      'The edit may be partly applied; check the document'), _rawError: rawError(e) };
  }
  const arrived = step.applied ? !!step.applied(now) : now.revisionId !== model.revisionId;
  return rollBack(snap, plan, arrived ? [...done, step] : done, replies, e, now);
}
// Undoes the applied steps of a failed commitSequence, newest first (the first on read when given). Returns the
// tool fields of the failure.
async function rollBack(snap, plan, done, replies, e, read = null) {
  snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
  writePhase(snap, 'writing'); // the rollback batches write again
  try {
    for (let k = done.length - 1; k >= 0; k--) {
      const model = k === done.length - 1 && read ? read : await refreshSnapModel(snap);
      const requests = done[k].rollback ? done[k].rollback(model, replies) : [];
      if (requests && requests.length) await docsBatchUpdate(model, requests);
    }
    const now = await refreshSnapModel(snap);
    return { ...writeError(`the edit failed halfway (${errorClause(e)}) and its first part was rolled back, so the document is as it was.${regionNote(now, plan.region[0], plan.region[1])}`, 'Edit failed and was rolled back: ' + errorClause(e)), _rawError: rawError(e) };
  } catch (e2) {
    let now = null;
    try { now = await refreshSnapModel(snap); } catch (e3) { /* state unknown */ }
    return { ...writeError(`the edit failed halfway (${errorClause(e)}) and rolling back its first part failed too (${errorClause(e2)}): the document may hold part of the edit; check it before editing again.${regionNote(now, plan.region[0], plan.region[1])}`, 'Edit failed halfway: ' + errorClause(e)), _rawError: `${rawError(e)} / ${rawError(e2)}` };
  }
}

// A journal entry made of parts, undone newest first (docs-undo.js undoMulti): each part is any journal entry
// (kind 'replace' / 'insert' / 'delete' with index, text, restore, paras; 'format'; 'requests' with its inverse
// requests; a registered kind), optionally with segmentId (a header, footer or footnote). finishEdit anchors
// every part on the document read after the whole edit, so a part whose context the later parts change sets
// anchor: false and is checked by its own registered kind instead. title: the card and journal title.
const multiJournal = (parts, extra = {}) => ({ kind: 'multi', parts, ...extra });

// ---- edit_document (several edits of any kind in one call) ------------------------------------------------------------
// edit_document({operations: [{op, …}, …]}): replace, insert, delete, format_text, format_lines and number_headings
// entries, each planned like its single tool on the frozen snapshot, so the line numbers and texts the model read stay
// valid. Their spans (API index ranges) must not overlap, except a format_lines with a format_text or a replace inside
// one paragraph (mayOverlap); an insert may share its place with the operation that starts there (its text goes before
// it). The requests go in ONE batchUpdate from the bottom up, so no operation moves one
// still to come (the operation right after an insert at the same place is shifted by that insert); one re-read
// verifies the whole (expectText: the text the edit should leave) and the parts' own checks run on it; ONE 'multi'
// journal entry holds the parts top-down as the edit leaves them, undone bottom-up. A part's undo context is the text
// as it is when that part is undone (the parts above in place, those below already undone), so neighbouring parts
// still undo. A bad entry refuses the whole call with the entry named. Earlier versions had batch fields on five tools
// (replace_text edits, insert_after_line inserts, delete_lines ranges, format_text items, format_lines ranges); their
// journals ('multi' of text parts, 'format' with groups) are undone by the same code.
const BATCH_MAX = 50;
const batchGiven = (r) => (Array.isArray(r) ? r.length > 0 : typeof r === 'string' && !looseNull(r) && r.trim() !== '[]');
// The list of a batch argument (an array, or an array sent as JSON text), or null.
function batchList(raw) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = null; } }
  return Array.isArray(list) ? list : null;
}
// The batch fields of the single tools of earlier versions: a call that still sends one is refused with the way to do it.
const OLD_BATCH_FIELDS = { replace_text: 'edits', insert_after_line: 'inserts', delete_lines: 'ranges', format_text: 'items', format_lines: 'ranges' };
const EDIT_OPS = ['replace', 'insert', 'delete', 'format_text', 'format_lines', 'number_headings'];
// The operations that address lines (refused after an earlier edit of the same response, like insert_after_line); a
// replace or format_text with line (and replace_text, format_text with line) too.
const LINE_OPS = ['insert', 'delete', 'format_lines', 'number_headings'];
const TEXT_LINE_OPS = { replace: 'replace_text', format_text: 'format_text' };
const usesLineNumbers = (name, args) => LINE_NUMBER_TOOLS.includes(name)
  || (Object.values(TEXT_LINE_OPS).includes(name) && !!args && !looseNull(args.line))
  || (name === 'edit_document' && (batchList(args && args.operations) || []).some((e) => {
    const op = e ? String(e.op || '').trim().toLowerCase() : '';
    return LINE_OPS.includes(op) || (!!TEXT_LINE_OPS[op] && !looseNull(e.line));
  }));

// A deep copy of o (requests, or a journal) with every API index in it moved by d (index, startIndex, endIndex, and a
// journal's end).
const INDEX_KEYS = ['index', 'startIndex', 'endIndex', 'end'];
function shiftIndices(o, d) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = d && INDEX_KEYS.includes(k) && typeof v === 'number' ? v + d : walk(v);
    return out;
  };
  return walk(o);
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : o[k]]));
// The calls whose plans compare existing lines with the formatting sheet (sheetLineChanges): format_lines (a style
// change, apply_sheet, numbers) and edit_document with format_lines or number_headings.
const comparesLines = (name, args) => name === 'format_lines' || (name === 'edit_document'
  && (batchList(args && args.operations) || []).some((e) => e && ['format_lines', 'number_headings'].includes(String(e.op || '').trim().toLowerCase())));
// format_text and edit_document with format_text: their check reads the named styles when it would report a miss.
const formatsText = (name, args) => name === 'format_text' || (name === 'edit_document'
  && (batchList(args && args.operations) || []).some((e) => e && String(e.op || '').trim().toLowerCase() === 'format_text'));
const LINE_FORMAT_KEYS = ['style', 'align', 'list', 'indent_start', 'indent_first_line', 'indent_end', 'space_above', 'space_below', 'line_spacing', 'box', 'page_break_before'];
// "operation 2 (insert after line 4)": how errors and notes name an entry.
function opName(k, op, e) {
  const quote = (t) => ` «${oneLine(String(t == null ? '' : t), 40)}»`;
  const lines = () => (looseNull(e.end) || Number(e.end) === Number(e.start) ? ` line ${JSON.stringify(e.start)}` : ` lines ${JSON.stringify(e.start)}–${JSON.stringify(e.end)}`);
  const what = op === 'replace' || op === 'format_text' ? quote(e.old_text) : op === 'insert' ? ` after line ${JSON.stringify(e.line)}` : EDIT_OPS.includes(op) ? lines() : '';
  return `operation ${k + 1} (${op || 'no op'}${what})`;
}

// An operation whose plan changes nothing ({ reply: "No change: …" }): "operation 2 (…): line 3 is already bold" (the
// call's result says "No change:" once).
const noopOf = (name, p) => ({ noop: `${name}: ${p.reply.content.split('\n')[0].replace(/^No change: /, '').replace(/\.$/, '')}` });
// One entry planned on the frozen model: a part { op, name, kind: 'text' | 'format' | 'numbers', span, region,
// requests, journal, edits: [{off, rem, ins}] (its text changes in offsets of model.text), … the single plan's fields },
// { noop: the "No change" text }, or { error, short }.
function planOperation(model, e, k) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: `operation ${k + 1} must be an object like {"op":"replace","old_text":"…","new_text":"…", …}` };
  const op = String(e.op == null ? '' : e.op).trim().toLowerCase();
  const name = opName(k, op, e);
  const fail = (p) => ({ error: `${name}: ${p.error}`, short: `edit_document: ${p.short || p.error}` });
  const lineSpan = (a, b) => [model.lines[a - 1].start, model.lines[b - 1].end + 1];
  const textEdit = (j) => {
    const off = offsetAtIndex(model, j.index);
    return off == null ? null : [{ off, rem: j.restore || '', ins: j.text || '' }];
  };
  let p;
  switch (op) {
    case 'replace':
      p = planReplaceText(model, { old_text: e.old_text, new_text: e.new_text, line: e.line });
      if (p.error) return fail(p);
      if (p.reply) return noopOf(name, p);
      return { ...p, op, name, kind: 'text', edits: textEdit(p.journal), label: `replaced ${rangeLabel(p.from, p.to)}`, given: { old_text: String(e.old_text), new_text: String(e.new_text) } };
    case 'insert':
      p = insertPart(model, { line: e.line, text: e.text, style: e.style, fill: e.fill });
      if (p.error) return fail(p);
      return { ...p, op, name, kind: 'text', insert: true, span: [p.at, p.at], region: [Math.max(1, p.n), Math.max(1, p.n)], edits: textEdit(p.journal),
        notes: p.notes || [] };
    case 'delete':
      p = planDelete(model, { start: e.start, end: looseNull(e.end) ? e.start : e.end });
      if (p.error) return fail(p);
      return { ...p, op, name, kind: 'text', edits: textEdit(p.journal), label: `deleted ${rangeLabel(p.region[0], p.region[1])}` };
    case 'format_text': {
      // all: true becomes one part per occurrence, so the other operations may lie between them (each part keeps its
      // own place in the bottom-up batch and in the undo); allCount: the occurrences of the operation (the edit gate).
      const t = formatTarget(model, { old_text: e.old_text, line: e.line, all: e.all, ...pick(e, FORMAT_PROPS) });
      p = t.error || t.reply ? t : t.all ? formatAllParts(model, t) : formatHitPlan(model, t.hits[0], t, null);
      if (p.error) return fail(p);
      if (p.reply) return noopOf(name, p);
      const asPart = (x) => ({ ...x, op, name, kind: 'format', span: [x.journal.index, x.journal.end], edits: [], label: x.done });
      if (!p.parts) return asPart(p);
      const extra = p.skipped ? [`Note: for ${name}, ${p.skipped} other occurrence${p.skipped === 1 ? ' already had' : 's already had'} this formatting.`] : [];
      return { parts: p.parts.map((x, i) => ({ ...asPart(x), allCount: p.parts.length, notes: [...x.notes, ...(i ? [] : extra)] })) };
    }
    case 'format_lines': {
      if (!looseNull(e.numbers)) return fail({ error: 'numbers belongs to the op number_headings' });
      const a = Number(e.start);
      p = planFormatLines(model, { start: e.start, end: looseNull(e.end) ? e.start : e.end, ...pick(e, LINE_FORMAT_KEYS), numbers: null }, null);
      if (p.error) return fail(p);
      if (p.reply) return noopOf(name, p);
      return { ...p, op, name, kind: 'format', span: lineSpan(a, p.region[1]), edits: [], label: p.done };
    }
    case 'number_headings': {
      const whole = looseNull(e.start) && looseNull(e.end);
      p = planNumberHeadings(model, { action: e.numbers, start_line: whole ? null : e.start, end_line: whole ? null : (looseNull(e.end) ? e.start : e.end), prefix: e.prefix });
      if (p.error) return fail(p);
      if (p.reply) return noopOf(name, p);
      const after = typeof p.expectText === 'string' ? p.expectText : model.text;
      const { p: s, q } = commonEdges(model.text, after);
      const edits = after === model.text ? [] : [{ off: s, rem: model.text.slice(s, model.text.length - q), ins: after.slice(s, after.length - q) }];
      return { ...p, op, name, kind: 'numbers', span: lineSpan(p.region[0], p.region[1]), edits, label: p.done, setNumbers: String(e.numbers).trim().toLowerCase() === 'set' };
    }
    default:
      return fail({ error: `op must be one of ${EDIT_OPS.join(', ')}`, short: 'invalid op' });
  }
}

// Two parts' API spans overlap (an insert's is empty: it overlaps a span it lies strictly inside).
const spansOverlap = (a, b) => a.span[0] < b.span[1] && b.span[0] < a.span[1];
// Parts sent right after a format_lines whose lines they share (planEditDocument): a format_text (its text values then
// win over the sheet values a style change writes) and a replace inside one paragraph (no newline replaced or written,
// so every line keeps its number and paragraph; the format_lines is sent on the text as it was, then the replace).
const linesMate = (p) => p.op === 'format_text' || (p.op === 'replace' && !`${p.journal.restore || ''}${p.journal.text || ''}`.includes('\n'));
// a comes before b in document order. A replace must start inside the format_lines (undo then finds the lines' text as
// the format_lines left it); a format_text may also start above it.
const mayOverlap = (a, b) => (a.op === 'format_lines' && linesMate(b)) || (b.op === 'format_lines' && a.op === 'format_text');
// Operation numbers, three or more in a row as a run: "1–11, 14", "3, 4".
const opNumbers = (ks) => {
  const s = [...new Set(ks)].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    if (j - i >= 2) out.push(`${s[i]}–${s[j]}`); else out.push(...s.slice(i, j + 1).map(String));
    i = j + 1;
  }
  return out.join(', ');
};
// Every pair of operations whose parts overlap (top: the parts in document order), in one error with the way forward
// (the later operation of each pair in a second call), or ''. A replace that only takes a typed number off a heading
// number_headings set numbers is not needed: set removes typed numbers itself (a saved chat sent eleven).
function overlapError(top) {
  const pairs = new Map();
  for (let j = 1; j < top.length; j++) {
    const b = top[j];
    for (let i = 0; i < j; i++) {
      const a = top[i];
      const over = b.span[0] < a.span[1] || (b.span[0] === a.span[0] && !(a.insert && !b.insert));
      if (!over || a.k === b.k || mayOverlap(a, b)) continue;
      const [x, y] = a.k < b.k ? [a, b] : [b, a];
      pairs.set(`${x.k} ${y.k}`, [x, y]);
    }
  }
  if (!pairs.size) return '';
  const needless = new Map(); // replace k -> the number_headings part
  const rest = [];
  for (const [x, y] of pairs.values()) {
    const [r, nh] = x.op === 'replace' && y.setNumbers ? [x, y] : y.op === 'replace' && x.setNumbers ? [y, x] : [null, null];
    if (r && typedNumberOnly(r.given.old_text, r.given.new_text)) needless.set(r.k, nh); else rest.push([x, y]);
  }
  const drop = [...needless.keys()].map((k) => k + 1);
  const many = (ks) => (ks.length === 1 ? `operation ${ks[0]}` : `operations ${opNumbers(ks)}`);
  const head = drop.length ? `${[...new Set(needless.values())].map((p) => p.name).join(', ')} removes typed heading numbers itself, so ${many(drop)} ${drop.length === 1 ? 'is' : 'are'} not needed` : '';
  const live = rest.filter(([x, y]) => !needless.has(x.k) && !needless.has(y.k));
  if (!live.length) return `${head}: send this call without ${drop.length === 1 ? 'it' : 'them'}`;
  // One clause per later operation, the earlier ones it overlaps as numbers.
  const byLater = new Map();
  for (const [x, y] of live.sort((p, q) => p[1].k - q[1].k || p[0].k - q[0].k)) byLater.set(y.k, [...(byLater.get(y.k) || [y]), x]);
  const clauses = [...byLater.values()].map(([y, ...xs]) => `${y.name} overlaps ${xs.length === 1 ? xs[0].name : many(xs.map((x) => x.k + 1))}`);
  const later = [...byLater.keys()].map((k) => k + 1);
  return `${head ? `${head}. ` : ''}${clauses.join('; ')}. Send this call without ${many([...drop, ...later])}, then ${later.length === 1 ? `operation ${later[0]}` : 'those'} in a second edit_document call`;
}

function planEditDocument(model, args) {
  const bad = (error, short = 'edit_document: invalid operations') => ({ error, short });
  const list = batchList(args.operations);
  if (!list || !list.length) return bad('operations must be a non-empty list like [{"op":"replace","old_text":"teh","new_text":"the", …}, {"op":"insert","line":4,"text":"…","style":null, …}]');
  if (list.length > BATCH_MAX) return bad(`at most ${BATCH_MAX} operations per call (got ${list.length})`);
  const parts = [];
  const noops = [];
  for (let k = 0; k < list.length; k++) {
    const p = planOperation(model, list[k], k);
    // The batch is one edit: a model told only what is wrong with one operation resent that one alone (a saved chat).
    if (p.error) return bad(list.length > 1 ? `${p.error.replace(/\.$/, '')}. No operation was applied; send all ${list.length} again with this one fixed` : p.error, p.short);
    for (const x of p.parts || (p.noop ? [] : [p])) x.k = k;
    if (p.noop) noops.push(p.noop); else if (p.parts) parts.push(...p.parts); else parts.push(p);
  }
  if (!parts.length) return { reply: { content: `No change: ${noops.join('; ')}.`, _ok: true, _message: 'No change' } };
  // Document order; an insert goes before the operation that starts where it inserts, a format_lines before a format_text
  // that starts where it does.
  const top = parts.slice().sort((x, y) => x.span[0] - y.span[0] || (y.insert ? 1 : 0) - (x.insert ? 1 : 0)
    || (y.op === 'format_lines' ? 1 : 0) - (x.op === 'format_lines' ? 1 : 0));
  for (let i = 1; i < top.length; i++) {
    const a = top[i - 1];
    const b = top[i];
    if (a.insert && b.insert && a.span[0] === b.span[0]) return bad(`${b.name} goes where ${a.name} goes; put both texts in one insert`);
  }
  const clash = overlapError(top);
  if (clash) return bad(clash);
  // The text as the parts leave it, top-down: each part's journal moved to the document as the edit leaves it, its
  // undo context taken from the text with the parts above applied and those below not (as at its undo).
  let text = model.text;
  let shift = 0;
  let lineShift = 0;
  let exact = true;
  const anchorAt = (o, len) => ({ before: text.slice(Math.max(0, o - ANCHOR_CHARS), o), after: text.slice(o + len, o + len + ANCHOR_CHARS) });
  const journals = top.map((p) => {
    p.di = shift;
    p.dl = lineShift;
    const j = shiftIndices(p.journal, shift);
    let delta = 0;
    if (!p.edits) exact = false;
    for (const e of p.edits || []) {
      const o = e.off + shift + delta;
      text = text.slice(0, o) + e.ins + text.slice(o + e.rem.length);
      if (p.kind === 'text') j.anchor = anchorAt(o, e.ins.length);
      delta += e.ins.length - e.rem.length;
      lineShift += (e.ins.match(/\n/g) || []).length - (e.rem.match(/\n/g) || []).length;
    }
    if (p.kind === 'format') { // the text is unchanged: the context of the entry and of each group, as the parts above leave it
      const ctx = (x) => { const o = offsetAtIndex(model, x.index); return o == null ? null : anchorAt(o + shift, (x.text || '').length); };
      j.anchor = ctx(p.journal);
      (p.journal.groups || []).forEach((g, gi) => { j.groups[gi].anchor = ctx(g); });
    }
    p.delta = delta;
    if (p.insert) p.first = p.first + p.dl; // the new lines are first + 1 … first + count after the edit
    shift += delta;
    return j;
  });
  // Bottom-up; the operation right after an insert at the same place goes after it, moved by its text. A format_text or
  // replace on the lines of a format_lines above it goes right after that format_lines (linesMate), still bottom-up among
  // themselves; nothing between them moves an index (the format_lines' list tabs are removed by Docs again).
  const requests = [];
  const after = new Map(); // a format_lines (its index in top) -> the parts sent after it
  for (let i = top.length - 1; i >= 0; i--) {
    const p = top[i];
    const h = linesMate(p) ? top.findIndex((q, j) => j < i && q.op === 'format_lines' && spansOverlap(q, p)) : -1;
    if (h >= 0) { after.set(h, [...(after.get(h) || []), p]); continue; }
    const ins = i > 0 && top[i - 1].insert && !p.insert && top[i - 1].span[0] === p.span[0] ? top[i - 1] : null;
    const d = ins ? ins.delta : 0;
    if (ins) requests.push(...ins.requests);
    for (const q of [p, ...(after.get(i) || [])]) requests.push(...shiftIndices(q.requests, d));
    if (ins) i--;
  }
  const n = new Set(top.map((p) => p.name)).size; // the operations (a format_text with all: true has a part per occurrence)
  const from = Math.min(...top.map((p) => p.region[0]));
  const to = Math.max(...top.map((p) => p.region[1]));
  const labels = top.map((p) => (p.insert ? `inserted ${p.fill ? `at line ${p.n}` : p.n === 0 ? 'at the beginning' : `after line ${p.n}`} (now ${rangeLabel(p.first + 1, p.first + p.count)})` : p.label));
  const moved = top.some((p) => p.dl) || lineShift !== 0;
  const texts = (ops, f) => top.filter((p) => ops.includes(p.op)).map(f);
  const numbering = top.filter((p) => p.kind === 'numbers' && p.check);
  return {
    requests, region: [from, to], noNow: true, ...(exact ? { expectText: text } : {}),
    keepsLines: top.every((p) => p.kind !== 'text'),
    journal: multiJournal(journals, top.some((p) => p.journal.lists) ? { lists: true } : {}),
    removed: top.flatMap((p) => (p.kind === 'text' ? p.removed || [] : [])),
    notes: [...new Set(top.flatMap((p) => p.notes || [])), ...(noops.length ? [`Note: no change for ${noops.join('; ')}.`] : [])],
    title: `Made ${n} edit${n === 1 ? '' : 's'}`, done: `made ${n} edit${n === 1 ? '' : 's'}${moved ? ' (line numbers as before this edit)' : ''}: ${labels.join('; ')}`,
    cardText: top.map((p) => p.cardText).filter(Boolean).join('\n'), cardLabel: 'Changes',
    ops: top, // the edit gate (gate.js) sums the parts
    ...(top.some((p) => p.people) ? { people: [...new Set(top.flatMap((p) => p.people || []))] } : {}),
    batchTexts: { // the writing and provenance checks: the replaced and the new texts; pairs: each replace's own (prose-lint.js)
      oldText: texts(['replace'], (p) => p.given.old_text).join('\n\n'),
      newText: [...texts(['replace'], (p) => p.given.new_text), ...texts(['insert'], (p) => p.raw)].join('\n\n'),
      pairs: texts(['replace'], (p) => ({ oldText: p.given.old_text, newText: p.given.new_text })),
    },
    affected: (m) => [from, Math.min(m.lines.length, Math.max(from, to + lineShift))],
    // The numbering parts' checks make one note (seven numbering operations gave seven notes in a saved chat).
    report: (m, retried = false) => legendOnce(m, [...top.map((p) => (p.insert ? insertCheck(m, p, p.first) : p.verify ? p.verify(m, p.dl, p.di) : '')),
      numbersNote(numbering.map((p) => p.check(m, p.dl)), retried)].filter(Boolean).join('\n')),
    repair: (m) => { const rq = numbering.filter((p) => p.repair).map((p) => p.repair(m, p.dl)).filter(Boolean); return rq.length ? rq.flat() : null; },
  };
}

// ---- Operations a retry left out (per turn) ------------------------------------------------------------------------
// A model that retries a refused edit_document call may leave operations out without a word (a saved chat: half of
// them). The operations of a refused or failed call (snap.editRefused, until the next successful edit_document) are
// compared with that call's, and those it lacks are named in one note on its result. A later call that still sends them
// makes the note moot (it is not held back to the end of the turn). An operation is matched, one to one, by an operation
// of the same kind that addresses the same text (old_text, the text of its lines: numbers shift after a re-read), else
// writes the same (a retry that fixed old_text after "not found"). The single tools' writes take theirs off the list,
// and an operation that landed this turn (snap.editLanded) is never named.
const SINGLE_OP_OF = { replace_text: 'replace', insert_after_line: 'insert', delete_lines: 'delete', format_text: 'format_text', format_lines: 'format_lines' };
const DROPPED_MAX = 6;
// The operations of a writing call as [{ kind, label, target, payload, key }], or null (another tool, no list). model:
// the one its line numbers address.
function writeOps(name, args, model) {
  const a = args && typeof args === 'object' ? args : {};
  const list = name === 'edit_document' ? batchList(a.operations) : SINGLE_OP_OF[name] ? [{ ...a, op: SINGLE_OP_OF[name] }] : null;
  if (!list) return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  const lines = (s, e) => { // the text of lines s..e, or the numbers when the lines are empty or out of range
    const x = Number(s);
    const y = looseNull(e) ? x : Number(e);
    const ls = (model && model.lines) || [];
    const t = Number.isInteger(x) && Number.isInteger(y) && x >= 1 && y >= x && y <= ls.length ? ls.slice(x - 1, y).map((l) => l.text).join('\n') : '';
    return t.trim() ? t : `#${s}-${e}`;
  };
  return list.filter((e) => e && typeof e === 'object').map((e) => {
    let kind = String(e.op == null ? '' : e.op).trim().toLowerCase();
    if (name === 'format_lines' && !looseNull(e.numbers)) kind = 'number_headings';
    const quoted = kind === 'replace' || kind === 'format_text';
    const span = looseNull(e.end) || Number(e.end) === Number(e.start) ? `${e.start}` : `${e.start}–${e.end}`;
    const label = quoted ? `${kind} «${oneLine(str(e.old_text), 40)}»` : kind === 'insert' ? `insert after line ${e.line}`
      : kind === 'number_headings' && looseNull(e.start) ? kind : `${kind} ${span}`;
    const target = quoted ? str(e.old_text).trim() : kind === 'insert' ? lines(e.line, null) : lines(e.start, e.end);
    const payload = kind === 'replace' ? str(e.new_text) : kind === 'insert' ? str(e.text)
      : kind === 'format_text' ? JSON.stringify(pick(e, FORMAT_PROPS)) : kind === 'format_lines' ? JSON.stringify(pick(e, LINE_FORMAT_KEYS))
      : kind === 'number_headings' ? `${e.numbers} ${e.prefix}` : '';
    return { kind, label, target, payload, key: `${kind}\u0000${target}\u0000${payload}` };
  }).filter((o) => EDIT_OPS.includes(o.kind)); // an invalid op was the refusal's own subject
}
// Two targets alike enough to be one corrected (a typo fixed in old_text): their common start and end cover 60% of the
// longer one. Formatting alone does not tell two operations apart (bold on two words), a new text or an insert does.
function nearText(a, b) {
  if (!a || !b) return false;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return p + q >= 0.6 * Math.max(a.length, b.length);
}
const WRITES_TEXT = ['replace', 'insert'];
// The operations of refused that now does not carry.
function missingOps(refused, now) {
  const left = refused.slice();
  const free = now.slice();
  for (const f of ['target', 'payload']) {
    for (const o of left.slice()) {
      const j = free.findIndex((x) => x.kind === o.kind && !!x[f] && x[f] === o[f] && (f === 'target' || WRITES_TEXT.includes(o.kind) || nearText(x.target, o.target)));
      if (j < 0) continue;
      free.splice(j, 1);
      left.splice(left.indexOf(o), 1);
    }
  }
  return left;
}
// After a writing call (executeTool), with its writeOps: a refused or failed edit_document keeps its operations; a
// successful one gets the note of those it lacks. denied: the user denied or stopped the call (no to its operations).
function noteDroppedOps(name, ops, r, snap, denied) {
  if (!ops || !r || !snap || denied || typeof r.content !== 'string' || r.content === 'Error: cancelled by the user.') return;
  const landed = snap.editLanded || (snap.editLanded = new Set());
  if (!r._ok) {
    if (name !== 'edit_document') return;
    const kept = snap.editRefused || [];
    snap.editRefused = kept.concat(ops.filter((o) => !landed.has(o.key) && !kept.some((k) => k.key === o.key)));
    return;
  }
  for (const o of ops) landed.add(o.key);
  if (!snap.editRefused || !snap.editRefused.length) return;
  const left = missingOps(snap.editRefused, ops);
  snap.editRefused = name === 'edit_document' ? null : left;
  if (name !== 'edit_document' || !left.length) return;
  const more = left.length > DROPPED_MAX ? `; and ${left.length - DROPPED_MAX} more` : '';
  r.content += `\nNote: not in this call, from the refused one: ${left.slice(0, DROPPED_MAX).map((o) => o.label).join('; ')}${more}. Send them in another call or tell the user they were left out.`;
}

// Undo anchors of a journal entry, on the model read right after the edit: the entry's own (an entry with a
// numeric index, in its segment), for kind 'multi' those of its parts, each in its own segment, and those of the
// groups of a format_lines across table cells. An entry or part may set anchor itself (or false: none); one whose
// segment is gone gets none.
function anchorJournal(model, entry) {
  if (entry.kind === 'multi') for (const p of entry.parts || []) anchorJournal(model, p);
  for (const g of entry.groups || []) anchorJournal(model, Object.assign(g, entry.segmentId ? { segmentId: entry.segmentId } : {}));
  if (entry.anchor !== undefined && entry.anchor !== null) return;
  const m = typeof entry.index === 'number' ? segmentModel(model, entry.segmentId) : null;
  entry.anchor = m ? makeAnchor(m, entry.index, entry.text || '') : null;
}

// The result for the model is one compact line: what was done, where the new lines are (when they moved) and the
// new line count. The text itself goes only to the card (_cardText): it comes back to the model only where the
// document, read again, differs from what was sent (Docs normalized it; storedTextNote). plan.report(model): a note
// after that line, '' for none (formatting that did not take, a header or footnote that reads differently).
const NO_NOW_KINDS = ['delete', 'replace-all', 'cite'];
async function finishEdit(snap, plan, id, readModel) {
  const before = snap.model;
  const edit = { id, docId: before.docId, tabId: before.tabId, ...plan.journal, title: plan.title, undone: false, anchor: plan.journal.anchor === undefined ? null : plan.journal.anchor };
  let report;
  try {
    if (!readModel) writePhase(snap, 'verifying');
    let model = readModel || await refreshSnapModel(snap);
    let check = plan.report ? plan.report(model) : '';
    if (check && plan.knowNamed && (await plan.knowNamed())) check = plan.report(model);
    // Heading numbers Docs drew otherwise (plan.repair: the lists made again on the re-read document): one second try.
    const fix = check && plan.repair ? plan.repair(model) : null;
    if (fix && fix.length) {
      try {
        writePhase(snap, 'writing');
        await docsBatchUpdate(model, fix);
        model = await refreshSnapModel(snap);
        check = plan.report(model, true);
      } catch (e) { console.warn('Munin: the second try of a numbering failed:', rawError(e)); }
    }
    anchorJournal(model, edit);
    const [from, to] = plan.affected(model);
    if (!plan.keepsLines) snap.responseWrite = { from, to }; // formatting moves no line: later line numbers stay valid
    const [rf, rt] = plan.region || [from, to];
    const moved = !plan.keepsLines && !plan.noNow && !NO_NOW_KINDS.includes(plan.journal.kind) && rangeLabel(from, to) !== rangeLabel(rf, rt);
    const extra = [bodyTextNote(before, model, plan.journal, plan.expectText), legendOncePerTurn(snap, model, check)].filter(Boolean);
    report = `${moved ? `; now ${rangeLabel(from, to)}` : ''}; the document has ${model.lines.length} lines.${extra.map((x) => '\n' + x).join('')}`;
  } catch (e) {
    snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
    console.warn('Munin: the document could not be read again after an edit:', rawError(e));
    report = `.\nThe document could not be read again (${errorClause(e)}); the reading tools still show the text before this edit, so read it again before the next edit. This edit cannot be undone from the panel.`;
  }
  const notes = (plan.notes || []).map((n) => '\n' + n).join('');
  // Tracked citations the edit removed (plan.citations): named in the row's detail, so an edit that asked no one (Auto)
  // still shows them.
  const cites = plan.citations || [];
  return {
    content: `Done: ${plan.done || plan.title.charAt(0).toLowerCase() + plan.title.slice(1)}${report}${notes}`,
    _ok: true, _message: plan.title, _edit: edit, _cardText: plan.cardText, _cardLabel: plan.cardLabel,
    ...(cites.length ? { _detail: `Removed citation${cites.length === 1 ? '' : 's'} ${cites.join(', ')}.` } : {}),
  };
}

// A note naming only the part where the document's text (got) differs from what the edit sent (want), or '' when
// they agree. where(p): "on line 4" for the offset p of the difference in got, or a fixed phrase ("in the footer").
const STORED_NOTE_CHARS = 200;
const clipQuote = (t) => (t ? `«${oneLine(showText(t), STORED_NOTE_CHARS)}»` : 'nothing');
function storedTextNote(want, got, where) {
  if (want === got) return '';
  const { p, q } = commonEdges(want, got);
  const at = typeof where === 'function' ? where(p) : where;
  return `Note: Google Docs stored the text differently ${at}: it reads ${clipQuote(got.slice(p, got.length - q))} where you sent ${clipQuote(want.slice(p, want.length - q))}.`;
}
// The body check of an edit: the text before it with the journal's change applied (or expect, the plan's own
// expectation: replace_all) against the text read after it. Only replace / insert / delete entries of the body are
// checked this way; formatting and headers, footers and footnotes check in plan.report.
function bodyTextNote(before, after, j, expect) {
  let want = typeof expect === 'string' ? expect : null;
  if (want == null) {
    if (!['replace', 'insert', 'delete'].includes(j.kind) || typeof j.index !== 'number' || j.segmentId || before.segmentId) return '';
    const o = offsetAtIndex(before, j.index);
    if (o == null) return '';
    want = before.text.slice(0, o) + (j.text || '') + before.text.slice(o + (j.restore || '').length);
  }
  return storedTextNote(want, after.text, (p) => (after.lines.length ? `on line ${lineAtOffset(after, Math.min(p, Math.max(0, after.text.length - 1))).line}` : 'in the document'));
}

function writeError(text, short) {
  return { content: 'Error: ' + text, _ok: false, _message: short || capFirst(text.length > 160 ? text.slice(0, 160) + '…' : text) };
}

// Plan of a replacement of model.text[s, s + oldText.length) by newText (replace_text, replace_selection).
// Deleting and inserting across paragraph ends merges and splits paragraphs; every resulting paragraph gets its
// style in the same batch where it differs from the one Docs leaves (styleAfterDelete; restyle: a named style
// sent where it does not change would clear the text styles): the last one (new text after its last newline + the rest of the paragraph that contains
// the end of the range, which is the NEXT line when old_text ends with a newline) gets that
// paragraph's style; the first one (the head of the first line + new text before its first newline)
// gets the first line's style, unless both are empty and it is the surviving paragraph itself; the
// paragraphs in between are normal text, and so is the last one when new paragraphs are only appended at
// the end of a heading. Undo restores the styles of all lines from the first line to the surviving one.
// Only the part that differs is replaced (commonEdges: the common prefix and suffix of the old and new
// text stay in the document with their formatting, links and comments); the paragraph rules above apply
// to that middle part, which may be empty on one side (a pure insertion or deletion). The journal records
// exactly the middle, so undo reverts exactly that. from/to: the lines of the whole match (the title);
// mid: the replaced middle { oldText, newText }; notes: result notes (a link inside the deleted part).
// loose: oldText was found by normalized matching (see editEdges).
function replacePlan(model, s, oldText, newText, loose = false, wholeParagraphs = false) {
  const r = indexRange(model, s, s + oldText.length);
  if (r.error) return { error: r.error };
  // Inside a checked range, text offsets and API indices advance together.
  const { p, q } = wholeParagraphs ? paragraphEdges(oldText, newText) : editEdges(oldText, newText, loose);
  const oldMid = oldText.slice(p, oldText.length - q);
  const newMid = newText.slice(p, newText.length - q);
  const S = r.start + p;
  const E = r.end - q;
  const requests = [];
  if (E > S) requests.push(reqDelete(model, S, E));
  if (newMid) requests.push(reqInsert(model, S, newMid));
  const nls = [];
  for (let i = newMid.indexOf('\n'); i >= 0; i = newMid.indexOf('\n', i + 1)) nls.push(i);
  const firstLine = lineAtIndex(model, S) || model.lines[r.from - 1];
  const lastLine = lineAtIndex(model, E) || model.lines[r.to - 1]; // the paragraph that survives the end
  const toLine = E > S ? (lineAtIndex(model, E - 1) || firstLine).line : firstLine.line;
  const multi = oldMid.includes('\n') || nls.length > 0;
  // New paragraphs appended at the end of a heading ("Conclusions" -> "Conclusions\nText"): the heading stays whole
  // in the first paragraph, so the new ones are body text, not copies of the heading.
  const afterHeading = !oldMid && firstLine.heading && S === firstLine.end && S > firstLine.start;
  if (multi) {
    const headEmpty = S === firstLine.start;
    const now = styleAfterDelete(model, S, E); // every paragraph from S has it after the delete and the insert
    if (!nls.length) {
      requests.push(...restyle(model, S, S + 1, headEmpty && !newMid ? lastLine.style : firstLine.style, now));
    } else {
      requests.push(...restyle(model, S, S + 1, firstLine.style, now));
      nls.forEach((nl, k) => {
        const style = k === nls.length - 1 && !afterHeading ? lastLine.style : 'NORMAL_TEXT';
        requests.push(...restyle(model, S + nl + 1, S + nl + 2, style, now));
      });
    }
  }
  const paras = multi ? paraStyles(model, firstLine.line, Math.max(toLine, lastLine.line), -1) : [];
  const links = linksInRange(model, S, E);
  const notes = links.length ? [linkNote(links)] : [];
  const styles = rangeStyles(model, S, E);
  // The permission card (gate.js) shows the changed paragraphs whole, as they read before and after the edit.
  const a = model.lines[r.from - 1];
  const b = model.lines[r.to - 1];
  const cardOld = model.text.slice(a.off, b.off + b.text.length);
  const cardNew = cardOld.slice(0, s - a.off) + newText + cardOld.slice(s + oldText.length - a.off);
  return {
    requests, from: r.from, to: r.to, region: [r.from, r.to], span: [r.start, r.end], mid: { oldText: oldMid, newText: newMid }, notes, cardOld, cardNew,
    removed: [[s + p, s + oldText.length - q]],
    journal: { kind: 'replace', index: S, text: newMid, restore: oldMid, paras, ...(styles.length ? { restoreStyles: styles } : {}), ...(model.segmentId ? { segmentId: model.segmentId } : {}) },
    affected: (m) => {
      const a = lineAtIndex(m, r.start) || lineAtIndex(m, r.start - 1);
      const b = lineAtIndex(m, r.start + Math.max(newText.length - 1, 0)) || a;
      return a ? [a.line, Math.max(a.line, b.line)] : [r.from, r.from];
    },
  };
}

// ---- Smart chips in new text -------------------------------------------------------------------------------------
// A placeholder in the new text of replace_text, insert_after_line, replace_section and edit_document becomes a chip:
// {@name@example.com} a person (insertPerson), {date:2026-11-12} a date (insertDate: the browser's time zone, the
// document's language), {link:https://…} a rich link (insertRichLink) for Google Drive, YouTube and Calendar URLs
// (another URL is written as plain text, with a note). chipText swaps each placeholder for a chip mark, a Unicode
// noncharacter (U+FDD0…: never in a document, kept by sanitizeInsertText) that takes one position like the chip, so
// the plans count it as one character and never match it against document text. finishChips then turns each
// insertText carrying marks into the text without them plus one insert request per chip, in text order right after
// it (chip k at location + its offset: the chips before it are in place by then), and every mark elsewhere in the plan
// (the journal, the expected text) into "￼", which is how the re-read document shows the chip; so verification and
// undo (deleting the range) treat a chip like a character. A person mention may notify that person: personGate asks.
const CHIP_RE = /\{(@|date:|link:)([^{}\n]*)\}/g;
const CHIP_MAX = 20;
const CHIP_MARK_RE = /[﷐-﷯]/g;
const CHIP_MARKS = new Map(); // mark -> { kind, shown, request(location) }
let chipSeq = 0;
const EMAIL_RE = /^[^\s@{}<>()"',;]+@[^\s@{}<>()"',;]+\.[^\s@{}<>()"',;.]+$/;
const RICH_LINK_HOST_RE = /^(?:(?:docs|drive|calendar)\.google\.com|(?:www\.|m\.)?youtube\.com|youtu\.be)$/i;
// The browser's time zone (CLDR id) and the noon of date ymd there, as an RFC 3339 timestamp: noon keeps the day the
// same whatever the zone's offset or a daylight-saving change.
const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };
function zoneNoon(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d, 12);
  try {
    const v = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const offset = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour) % 24, Number(v.minute)) - guess;
    return new Date(guess - offset).toISOString().replace('.000Z', 'Z');
  } catch (e) {
    return new Date(guess).toISOString().replace('.000Z', 'Z');
  }
}
// One placeholder (kind '@' | 'date:' | 'link:', value) -> { chip } | { plain: text, note } | { error }.
function parseChip(kind, raw, model) {
  const v = raw.trim();
  const shown = `{${kind}${raw}}`;
  if (kind === '@') {
    if (!EMAIL_RE.test(v)) return { error: `${shown} is not an email address; write a person chip as {@name@example.com}` };
    return { chip: { kind: 'person', shown, email: v, request: (location) => ({ insertPerson: { personProperties: { email: v }, location } }) } };
  }
  if (kind === 'date:') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const ok = m && (() => { const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3]; })();
    if (!ok) return { error: `${shown} is not a valid date; write a date chip as {date:YYYY-MM-DD}, for example {date:2026-11-12}` };
    const timeZoneId = browserTimeZone();
    const locale = typeof textLang === 'function' && model ? textLang(model.text) : 'en';
    const props = { timestamp: zoneNoon(+m[1], +m[2], +m[3], timeZoneId), timeZoneId, locale, timeFormat: 'TIME_FORMAT_DISABLED' };
    return { chip: { kind: 'date', shown, request: (location) => ({ insertDate: { dateElementProperties: { ...props }, location } }) } };
  }
  let url = null;
  try { url = new URL(v); } catch (e) { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) return { error: `${shown} is not a web address; write a link chip as {link:https://…}` };
  if (!RICH_LINK_HOST_RE.test(url.hostname)) return { plain: v, note: `Note: ${shown} is not a Google Drive, YouTube or Calendar address, so it was written as plain text.` };
  return { chip: { kind: 'link', shown, request: (location) => ({ insertRichLink: { richLinkProperties: { uri: v }, location } }) } };
}
// text with its placeholders as chip marks: { text, chips: count, notes } or { error }. A text without "{" is returned
// as it is (also a text that already carries marks: replace_section hands its text on to planInsert).
function chipText(text, model) {
  const src = String(text == null ? '' : text);
  if (!src.includes('{')) return { text: src, chips: 0, notes: [] };
  const notes = [];
  let chips = 0;
  let error = null;
  const out = src.replace(CHIP_RE, (all, kind, raw) => {
    if (error) return all;
    const r = parseChip(kind, raw, model);
    if (r.error) { error = r.error; return all; }
    if (r.plain != null) { notes.push(r.note); return r.plain; }
    if (++chips > CHIP_MAX) { error = `at most ${CHIP_MAX} chips per text`; return all; }
    const mark = String.fromCharCode(0xFDD0 + (chipSeq++ % 32));
    CHIP_MARKS.set(mark, r.chip);
    return mark;
  });
  return error ? { error } : { text: out, chips, notes: [...new Set(notes)] };
}
const hasChipMarks = (t) => typeof t === 'string' && /[﷐-﷯]/.test(t);
// The plan with its chips: insertText requests split (see above), marks elsewhere as "￼" (in cardText, cardNew and
// insertedText, shown to the user, as the placeholder typed), people: the emails mentioned (personGate). Mutates
// nested objects in place, so a journal shared with a part object changes with it.
function finishChips(plan, chip = null) {
  if (!plan || plan.error || plan.reply) return plan;
  const people = [...(plan.people || [])];
  const requests = [];
  for (const r of plan.requests || []) {
    const it = r && r.insertText;
    if (!it || !hasChipMarks(it.text) || !it.location) { requests.push(r); continue; }
    const plain = it.text.replace(CHIP_MARK_RE, '');
    if (plain) requests.push({ insertText: { ...it, text: plain } });
    for (let k = 0; k < it.text.length; k++) {
      const c = CHIP_MARKS.get(it.text[k]);
      if (!c) continue;
      requests.push(c.request({ ...it.location, index: it.location.index + k }));
      if (c.kind === 'person' && !people.includes(c.email)) people.push(c.email);
    }
  }
  const seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o) || (Array.isArray(o.lines) && typeof o.text === 'string')) return; // never a model
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'requests') continue;
      if (hasChipMarks(v)) {
        o[k] = k === 'cardText' || k === 'cardNew' || k === 'insertedText'
          ? v.replace(CHIP_MARK_RE, (m) => (CHIP_MARKS.get(m) || {}).shown || OBJECT_CHAR)
          : v.replace(CHIP_MARK_RE, OBJECT_CHAR);
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(plan);
  plan.requests = requests;
  if (people.length) plan.people = people;
  if (chip && chip.notes && chip.notes.length) plan.notes = [...(plan.notes || []), ...chip.notes];
  return plan;
}
const chipError = (tool, r) => ({ error: r.error, short: `${tool}: invalid chip placeholder` });

// A write that mentions a person may notify them (Docs can email a mentioned person), which no Undo takes back: it asks
// in every mode, after the edit gate (gate.js) when that did not ask already (Manual: its card names the people). The
// card shows the whole change, as the edit gate's does. "Allow all in this turn" covers it.
async function personGate(name, plan, snap, ui = {}) {
  const people = (plan && plan.people) || [];
  if (!people.length || ui.decision === 'accepted') return null;
  if (snap.editAll) { ui.decision = 'accepted-all'; return null; }
  const who = people.slice(0, 5).join(', ') + (people.length > 5 ? ', …' : '');
  const why = `It mentions ${who}; Google Docs may notify ${people.length === 1 ? 'this person' : 'these people'}.`;
  const d = await confirmOpen(editPreview(name, plan, snap, { why }), snap.signal, ui);
  if (d === 'accept' || d === 'accept-all') {
    if (d === 'accept-all') snap.editAll = true;
    ui.decision = 'accepted';
    return null;
  }
  ui.decision = d === 'stop' ? 'stopped' : 'rejected';
  if (d !== 'stop') noteDenied(name, snap, ui); // gateEdit answers the identical call without a card
  return d === 'stop'
    ? { content: EDIT_STOPPED_TEXT, _ok: false, _message: 'Edit not applied: stopped' }
    : { content: EDIT_DENIED_TEXT, _ok: false, _message: 'Edit not allowed' };
}
const CHIP_PROMPT_LINE = '- In new text, {@email} writes a person chip, {date:YYYY-MM-DD} a date chip, {link:URL} a Drive, YouTube or Calendar link chip.';
registerPromptLine({ section: 'edit', line: CHIP_PROMPT_LINE, when: (mode, snap) => !!snap && apiEditing(mode, snap), names: 'smart chips' });

// Hits of old_text; when there are none, of old_text without markdown markers and wrapping quotes
// (stripMarkers), so "**lazy dog**" or "'lazy dog'" still finds lazy dog. stripped: the second search was used.
function findOldText(model, oldText) {
  const hits = findFlexible(model.text, oldText);
  const plain = hits.length ? null : stripMarkers(oldText);
  const alt = plain ? findFlexible(model.text, plain) : [];
  return alt.length ? { hits: alt, oldText: plain, stripped: true } : { hits, oldText, stripped: false };
}
// line (replace_text, format_text and their edit_document operations): when it is a number, only the hits that start on
// that line count (line numbers as read before the call), so the model can pick one of several identical occurrences.
// Returns { hits, line } (line: the number, or null when not given), or { error, short }.
function hitsOnLine(model, hits, line, tool) {
  if (looseNull(line)) return { hits, line: null };
  const n = typeof line === 'boolean' ? NaN : Number(line);
  const total = model.lines.length;
  if (!Number.isInteger(n) || n < 1 || n > total) {
    return { error: `line must be the number of the line (1 to ${total}) where old_text occurs, or null; got ${describeValue(line)}`, short: `${tool}: invalid line` };
  }
  const on = hits.filter((h) => lineAtOffset(model, h.at).line === n);
  if (on.length) return { hits: on, line: n };
  const where = hitLines(model, hits);
  return { error: `old_text was not found on line ${n}; it occurs on ${where.length === 1 ? 'line' : 'lines'} ${lineList(where)}. Pass the line where it occurs (as read before this call), or null when it occurs once`,
    short: `${tool}: the text is not on line ${n}` };
}
// The refusal of several hits of old_text with the ways out of tool (replace_text or format_text): line picks one
// occurrence, replace_all or all: true takes every one, more surrounding text where one line holds it twice. on: the line
// given (all the hits are on it).
function ambiguousOldText(model, hits, tool, on) {
  const fmt = tool === 'format_text';
  if (on) {
    return `old_text occurs ${hits.length} times on line ${on}. Include more of the surrounding text so that it occurs once on that line${fmt ? ', or add all: true to format every occurrence on it' : ''}`;
  }
  const lines = hits.map((h) => lineAtOffset(model, h.at).line);
  const every = fmt ? 'all: true to format every occurrence' : 'call replace_all to replace every occurrence';
  const twice = [...new Set(lines.filter((n, i) => lines.indexOf(n) !== i))];
  if (new Set(lines).size === 1) return ambiguousError(model, hits, 'old_text', `Include more of the surrounding text so that it occurs exactly once, or ${every}`);
  const more = twice.length ? ` On ${twice.length === 1 ? 'line' : 'lines'} ${lineList(twice)} it occurs more than once: include more of the surrounding text there.` : '';
  return ambiguousError(model, hits, 'old_text', `Add line: N to pick the occurrence on line N (one call or operation per occurrence), or ${every}.${more}`).replace(/\.$/, '');
}

// replace_text({old_text, new_text})
function planReplaceText(model, args) {
  if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') return { error: 'invalid arguments. Expected {"old_text": string, "new_text": string}', short: 'Invalid tool arguments' };
  const given = args.old_text.replace(/\r\n?/g, '\n');
  if (!given) return { error: 'old_text is empty. To add text use insert_after_line', short: 'replace_text: old_text is empty' };
  const chip = chipText(args.new_text, model);
  if (chip.error) return chipError('replace_text', chip);
  if (chip.text !== args.new_text) args = { ...args, new_text: chip.text };
  const { hits: found, oldText, stripped } = findOldText(model, given);
  // The same markers or quotes around new_text would be written into the document literally.
  const newText = modelInsertText(stripped ? stripMarkers(args.new_text) || args.new_text : args.new_text);
  const objectError = { error: `the text contains an embedded object (shown as "${OBJECT_CHAR}": an image, chip or break), which replace_text cannot re-create. Edit only the text before or after it`, short: 'replace_text: the text contains an embedded object' };
  if (newText.split(OBJECT_CHAR).length > oldText.split(OBJECT_CHAR).length) return objectError;
  if (!found.length) {
    return { error: notFoundError(model, oldText, NOT_FOUND_ADVICE), short: 'replace_text: the text was not found' };
  }
  const picked = hitsOnLine(model, found, args.line, 'replace_text');
  if (picked.error) return picked;
  const { hits } = picked;
  if (hits.length > 1) {
    return { error: ambiguousOldText(model, hits, 'replace_text', picked.line), short: `replace_text: the text occurs ${hits.length} times` };
  }
  // (a model that wanted another look for the line sent its own text back)
  if (hits[0].text === newText) return noChangeReply(`«${oneLine(showText(newText), 60)}» already reads that; its look: format_text or format_lines`);
  const plan = replacePlan(model, hits[0].at, hits[0].text, newText, !!hits[0].normalized);
  if (plan.error) return { error: plan.error, short: 'replace_text: ' + plan.error };
  // An embedded object may stay in the unchanged prefix or suffix, but not in the replaced part.
  if (plan.mid.oldText.includes(OBJECT_CHAR) || plan.mid.newText.includes(OBJECT_CHAR)) return objectError;
  const notes = [...(stripped ? [MARKERS_NOTE] : []), ...(hits[0].normalized ? [hits[0].folded ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...plan.notes];
  return finishChips({ ...plan, notes, title: `Replaced ${rangeLabel(plan.from, plan.to)}`, cardText: showText(newText), cardLabel: newText ? 'New text' : '' }, chip);
}

// The last sentence of a "not found" error (notFoundError) when nothing similar is in the document.
const NOT_FOUND_ADVICE = 'old_text must match the document text (without the "N: " line-number prefixes); read the exact text with read_document or find_in_document and try again';
// A write that would change nothing: an ok "No change" result like the format tools' (an error would count for the repeat
// guard, which then tells the model to change the arguments or tell the user).
const noChangeReply = (what) => ({ reply: { content: `No change: ${what}.`, _ok: true, _message: 'No change' } });

// replace_all({old_text, new_text}): every non-overlapping occurrence, in one batch. Both texts lie
// within one paragraph, so no paragraph is merged or split (no styles to set) and line numbers do not
// shift. The requests go back to front, so the indices of the earlier occurrences stay valid. Nothing
// is replaced when any occurrence cannot be (suggested changes, unmappable line). Undo: undoReplaceAll.
// The journal's text is empty (no single range to check), so a network failure of unclear outcome is
// reported as unclear rather than recognized as applied.
function planReplaceAll(model, args) {
  if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') return { error: 'invalid arguments. Expected {"old_text": string, "new_text": string}', short: 'Invalid tool arguments' };
  const oldText = args.old_text.replace(/\r\n?/g, '\n');
  const newText = modelInsertText(args.new_text);
  if (!oldText) return { error: 'old_text is empty. To add text use insert_after_line', short: 'replace_all: old_text is empty' };
  const chip = chipText(args.new_text, model);
  if (chip.error || chip.chips) return { error: 'replace_all cannot insert chips; use replace_text (or edit_document) for each place', short: 'replace_all: chips are not supported' };
  // eslint-disable-next-line no-control-regex -- U+000B is the Docs soft line break
  if (/[\n\u000b]/.test(oldText) || oldText.includes(SOFT_BREAK_MARK) || /[\n\u000b]/.test(newText)) {
    return { error: 'replace_all replaces text within paragraphs only: old_text and new_text must not contain newlines or soft line breaks. For text spanning several lines use replace_text, one occurrence at a time', short: 'replace_all: the text spans several lines' };
  }
  if (oldText.includes(OBJECT_CHAR) || newText.includes(OBJECT_CHAR)) {
    return { error: `the text contains an embedded object (shown as "${OBJECT_CHAR}": an image, chip or break), which replace_all cannot re-create. Replace only the text before or after it`, short: 'replace_all: the text contains an embedded object' };
  }
  const found = disjointHits(findFlexible(model.text, oldText));
  if (!found.length) {
    return { error: notFoundError(model, oldText, NOT_FOUND_ADVICE), short: 'replace_all: the text was not found' };
  }
  // A look-alike (folded) match is unambiguous only when every hit is one real spelling: "сасhе" must not
  // replace both a Latin "cache" and a mixed-script "сache" (replace_text refuses the same as 2+ hits).
  const spellings = found.some((h) => h.folded) ? [...new Set(found.map((h) => h.text))] : [];
  if (spellings.length > 1) {
    const where = lineList(hitLines(model, found));
    return { error: `old_text matched only after normalizing look-alike Cyrillic/Latin letters, and the document spells it ${spellings.length} different ways (lines ${where}): ${spellings.map((t) => `"${oneLine(t, 40)}"`).join(', ')}. Nothing was replaced. Copy old_text exactly from the document to replace one spelling, or use replace_text for each occurrence`, short: 'replace_all: look-alike spellings differ' };
  }
  // Normalized hits may differ from each other; those already equal to new_text need no change.
  const hits = found.filter((h) => h.text !== newText);
  if (newText === oldText || !hits.length) return noChangeReply(`${found.length === 1 ? 'the only occurrence' : `all ${found.length} occurrences`} of «${oneLine(showText(oldText), 60)}» already ${found.length === 1 ? 'reads' : 'read'} that`);
  const lines = hitLines(model, hits);
  const sugg = model.suggestMode ? [] : lines.filter((n) => model.lines[n - 1].suggested); // suggest mode: indexRange checks each hit
  if (sugg.length) {
    const one = sugg.length === 1;
    return { error: `old_text occurs on ${one ? 'line' : 'lines'} ${lineList(sugg)}, which contain${one ? 's' : ''} suggested changes (suggesting mode), so nothing was replaced. Ask the user to accept or reject the suggestions in Google Docs first, or replace the other occurrences one at a time with replace_text`, short: 'replace_all: an occurrence is on a line with suggested changes' };
  }
  const ranges = [];
  for (const h of hits) {
    const r = indexRange(model, h.at, h.at + h.text.length);
    if (r.error) return { error: `${r.error}. Nothing was replaced; replace the other occurrences one at a time with replace_text`, short: 'replace_all: ' + r.error };
    ranges.push(r);
  }
  // Per occurrence only the differing middle (commonEdges), back to front.
  const requests = [];
  const links = [];
  const removed = [];
  const styles = []; // per occurrence, the removed middle's text styles (rangeStyles): the undo puts them back
  let expectText = model.text; // the document text the replacements should leave (finishEdit compares)
  for (let i = ranges.length - 1; i >= 0; i--) {
    const t = hits[i].text;
    const { p, q } = commonEdges(t, newText); // exact edges: every occurrence must read new_text afterwards (undo finds it)
    const S = ranges[i].start + p;
    const E = ranges[i].end - q;
    const mid = newText.slice(p, newText.length - q);
    styles[i] = rangeStyles(model, S, E);
    if (E > S) requests.push(reqDelete(model, S, E));
    if (mid) requests.push(reqInsert(model, S, mid));
    for (const u of linksInRange(model, S, E)) if (!links.includes(u)) links.push(u);
    removed.unshift([hits[i].at + p, hits[i].at + t.length - q]);
    expectText = expectText.slice(0, hits[i].at + p) + mid + expectText.slice(hits[i].at + t.length - q);
  }
  const n = hits.length;
  const [from, to] = [lines[0], lines[lines.length - 1]];
  // replace: the original text of the occurrences (replaces: per occurrence, when they differ).
  const texts = hits.map((h) => h.text);
  const same = texts.every((t) => t === texts[0]);
  const notes = [...(hits.some((h) => h.normalized) ? [hits.some((h) => h.folded) ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...(links.length ? [linkNote(links.slice().reverse())] : [])];
  return {
    requests, region: [from, to], notes, removed,
    journal: { kind: 'replace-all', index: ranges[0].start, text: '', restore: texts[0], paras: [], find: newText, replace: texts[0], ...(same ? {} : { replaces: texts }), count: n,
      ...(styles.some((s) => s.length) ? { restoreStyles: styles } : {}) },
    title: `Replaced ${n} × "${oneLine(oldText, 40)}"`,
    done: `replaced ${n} occurrence${n === 1 ? '' : 's'} on ${lines.length === 1 ? 'line' : 'lines'} ${lineList(lines)}`,
    cardText: showText(newText), cardLabel: newText ? 'New text' : '',
    affected: () => [from, to],
    expectText,
  };
}

// insert_after_line({line, text, style}). After line N the text goes in as "\n" + text at N's newline, so the new
// paragraphs copy N's paragraph properties; line 0 inserts text + "\n" at the start of line 1 (copying line 1's).
// Their named style is then set to style (title, subtitle, h1…h6, normal), Normal text by default, so a paragraph
// inserted after a heading is never a stray heading; a list item's bullet stays (the new lines continue the list)
// unless a heading style is asked for. A heading after a list item goes in before line N + 1 instead ("text\n" at its
// start), so the bullet removal never touches line N and undo (deleting the inserted text) leaves N as it was.
// Trailing newlines of text are dropped (no empty paragraph). The lines come back only when the re-read document
// shows another style on them.
// style "outline" inserts a structure: a line starting with "# ", "## " … "###### " becomes a heading of that level (the
// marker stripped), every other line Normal text, all in the same batch and one undo, so an article skeleton is one
// call instead of an insert and a format_lines per heading. The result names the headings it made.
// fill: true writes the text into line N, which must be empty (an empty document: line 1), instead of after it: no
// newline before or after the text, so its first paragraph takes the empty line's place and no empty line stays. The
// model chooses it; without fill an empty line is an ordinary anchor. Undo deletes the text and gives the paragraph its
// style and sheet values back, which leaves exactly the one empty paragraph.
const OUTLINE_MARK = /^(#{1,6})[ \t]+/;
const isOutline = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'outline';
// The outline's lines without their markers and the style key of each (h1…h6 or normal).
function outlineRows(text) {
  const rows = text.split('\n').map((l) => {
    const m = OUTLINE_MARK.exec(l);
    return m ? { key: 'h' + m[1].length, text: l.slice(m[0].length) } : { key: 'normal', text: l };
  });
  return { text: rows.map((r) => r.text).join('\n'), keys: rows.map((r) => r.key) };
}
function planInsert(model, args) {
  const p = insertPart(model, args);
  if (p.error) return p;
  const { n, count } = p;
  return {
    requests: p.requests, region: [Math.max(1, n), Math.max(1, n)], journal: p.journal, ...(p.people ? { people: p.people } : {}), ...(p.notes ? { notes: p.notes } : {}),
    title: p.fill ? `Inserted at line ${n}` : n === 0 ? 'Inserted at the beginning' : `Inserted after line ${n}`,
    cardText: p.cardText, cardLabel: 'Inserted text', place: p.place, ...(p.outline ? { insertedText: p.text } : {}), styles: p.wants,
    affected: () => [p.first + 1, p.first + count],
    report: (m) => insertCheck(m, p, p.first),
  };
}

// One insert of insert_after_line on the frozen model: { n, first (the lines before the new ones: n, or n - 1 when fill),
// fill (the text goes into the empty line n), text, count, wants (the style of each new line), at (its index),
// ins (the text sent), requests, journal }, or { error, short }.
function insertPart(model, args) {
  const chip = chipText(args.text, model);
  if (chip.error) return chipError('insert_after_line', chip);
  if (chip.text !== args.text) args = { ...args, text: chip.text, raw: args.raw == null ? args.text : args.raw };
  return finishChips(insertPartPlan(model, args), chip);
}
function insertPartPlan(model, args) {
  const total = model.lines.length;
  const n = Number(args.line);
  const outline = isOutline(args.style) ? outlineRows(modelInsertText(args.text).replace(/\n+$/, '')) : null;
  const text = outline ? outline.text : modelInsertText(args.text).replace(/\n+$/, '');
  if (!Number.isInteger(n) || n < 0 || n > total) return { error: `line must be an integer from 0 to ${total}`, short: 'insert_after_line: invalid line' };
  if (!text.replace(/\n/g, '')) return { error: 'text is empty', short: 'insert_after_line: empty text' };
  if (text.includes(OBJECT_CHAR)) return { error: `text must not contain "${OBJECT_CHAR}"`, short: 'insert_after_line: invalid text' };
  if (!total) return { error: 'the document has no lines to insert next to', short: 'insert_after_line: empty document' };
  const fill = flagValue(args.fill);
  if (fill === undefined) return { error: `fill must be true, false or null; got ${describeValue(args.fill)}`, short: 'insert_after_line: invalid fill' };
  if (fill && n === 0) return { error: 'fill writes into line N, so line must be from 1 (an empty document: line 1)', short: 'insert_after_line: fill with line 0' };
  if (fill && model.lines[n - 1].text) return { error: `line ${n} is not empty; fill writes into an empty line only. Leave fill out to insert after line ${n}`, short: 'insert_after_line: fill on a line with text' };
  // An outline with a heading counts as a heading style below (it ends a list it follows).
  const key = outline ? (outline.keys.some((k) => k !== 'normal') ? 'outline' : 'normal') : looseNull(args.style) ? 'normal' : parseHeading(args.style);
  if (!key) return { error: `style must be one of title, subtitle, h1…h6, normal, outline (got ${JSON.stringify(args.style)})`, short: 'insert_after_line: invalid style' };
  const count = text.split('\n').length;
  const wants = outline ? outline.keys.map((k) => HEADING_STYLES[k]) : Array(count).fill(HEADING_STYLES[key]);
  const anchor = n === 0 ? model.lines[0] : model.lines[n - 1];
  if (anchor.suggested && !model.suggestMode) return { error: `line ${anchor.line} contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs), or insert elsewhere`, short: 'insert_after_line: the line has suggested changes' };
  if (!anchor.exact) return { error: inexactLine(anchor.line, 'insert after another line, or tell the user to add the text in Google Docs'), short: 'insert_after_line: unmappable line' };
  // A heading style into an empty list item would remove its bullet, which undo cannot bring back.
  if (fill && key !== 'normal' && anchor.list) return { error: `line ${n} is an empty list item; fill writes headings into a line outside a list only. Fill it with style normal, or call format_lines on the line with list none first`, short: 'insert_after_line: fill a list item with a heading' };
  const unlist = !fill && key !== 'normal' && n > 0 && !!anchor.list;
  const next = unlist ? model.lines[n] : null; // a heading after a list item goes in before line N + 1
  if (unlist && (!next || isClosing(model, n - 1) || !next.exact || next.suggested)) {
    return { error: `line ${n} is a list item at the end of its part of the document, so a ${key === 'outline' ? 'heading' : key} cannot be inserted right after it. Insert the text with style normal, then call format_lines on it with the style and list none`, short: 'insert_after_line: a heading cannot follow this list item' };
  }
  const before = n === 0 || !!next;
  const base = next || anchor; // the paragraph whose properties the new ones copy
  const at = fill || n === 0 ? anchor.start : next ? next.start : anchor.end;
  const atLine = model.suggestMode ? lineAtIndex(model, at) : null;
  if (atLine && pointInSuggestion(model, atLine, at - atLine.start)) return { error: suggestOverlapError(atLine.line), short: 'insert_after_line: the place is in a suggested change' };
  const ins = fill ? text : before ? text + '\n' : '\n' + text;
  const newStart = fill || before ? at : at + 1;
  const newEnd = newStart + text.length;
  const requests = [reqInsert(model, at, ins)];
  if (outline) { // one style request per run of lines with the same style, each with its paragraph end (an empty line too)
    let off = newStart;
    const lens = text.split('\n').map((l) => l.length);
    for (let i = 0; i < count;) {
      let j = i;
      let end = off + lens[i];
      while (j + 1 < count && wants[j + 1] === wants[i]) { j++; end += 1 + lens[j]; }
      requests.push(...restyle(model, off, end + 1, wants[i], base.style));
      off = end + 1;
      i = j + 1;
    }
  } else requests.push(...restyle(model, newStart, newEnd, wants[0], base.style));
  if (key !== 'normal' && base.list) requests.push(reqBulletsOff(model, newStart, newEnd), reqParaStyle(model, newStart, newEnd, {}, ['indentStart', 'indentFirstLine']));
  // The formatting sheet: each new paragraph gets the values of its type (a list item that continues a list keeps the
  // list's indents).
  const listed = key === 'normal' && !!base.list;
  const paras = [];
  let off = newStart;
  text.split('\n').forEach((l, i) => { paras.push({ s: off, e: off + l.length, style: wants[i], list: listed, cell: !!base.cell }); off += l.length + 1; });
  const sheetRequests = newParagraphSheetRequests(model, model.sheet, paras);
  // New paragraphs start plain: what Docs gives them from the text next to the index (bold, a font) is reset, right after
  // the insert, unless the sheet writes that field on all of them anyway.
  const covered = (f) => paras.every((p) => p.e === p.s || sheetRequests.some((q) => q.updateTextStyle && q.updateTextStyle.range.startIndex <= p.s
    && q.updateTextStyle.range.endIndex >= p.e && q.updateTextStyle.fields.split(',').includes(f)));
  const inherited = (fill ? [] : inheritedFields(model, at)).filter((f) => !covered(f));
  if (inherited.length && newEnd > newStart) requests.splice(1, 0, reqTextStyle(model, newStart, newEnd, {}, inherited));
  requests.push(...sheetRequests);
  // After line N the inserted newline ends N, so undo (deleting it with the text) leaves N the newline that ended the
  // new text, with its style: N's own is restored explicitly, and so are the paragraph values the sheet gave it.
  // When fill, the last new paragraph is line N itself: the same restore (an unset style restored as Normal text).
  const sheetPara = !next ? lastParaSheet(model, paras[paras.length - 1], anchor) : null;
  const restoreStyle = fill ? anchor.style || 'NORMAL_TEXT' : anchor.style || '';
  return {
    n, first: fill ? n - 1 : n, ...(fill ? { fill } : {}), text, count, wants, at, ins, outline: !!outline, requests, raw: String(args.raw != null ? args.raw : args.text == null ? '' : args.text), cardText: showText(text),
    place: fill ? `at line ${n}` : n === 0 ? 'at the beginning' : `after line ${n}`, // the permission card's (gate.js)
    journal: { kind: 'insert', index: at, text: ins, restore: '', paras: next && !fill ? [] : [{ nl: -1, style: restoreStyle, ...(sheetPara ? { para: sheetPara } : {}) }] },
  };
}

// The paragraph values the sheet writes on the last new paragraph p of an insert after line N, whose newline is N's own:
// { style, fields } with N's values before the edit (undo puts them back on N), or null when the sheet writes none.
function lastParaSheet(model, p, anchor) {
  const v = sheetEntry(model.sheet, p.style);
  const ps = v ? newParaStyle(model, v, p) : null;
  const fields = ps ? ps.fields : [];
  if (!fields.length) return null;
  return { style: priorParaStyle(anchor.para, fields), fields };
}

// The check of an insert on the re-read document, whose lines first + 1 … first + count are the new ones: a note with
// the lines when one shows another style; for an outline the headings it made ("Headings made: line 3 (h1), 5 (h2).").
const HEADINGS_LISTED = 20;
function insertCheck(m, p, first) {
  const got = m.lines.slice(first, first + p.count);
  const out = [];
  if (p.outline) {
    const hs = [];
    p.wants.forEach((w, i) => { if (w !== 'NORMAL_TEXT') hs.push(`${first + i + 1} (${headingName(w)})`); });
    if (hs.length) out.push(`Headings made: line${hs.length === 1 ? '' : 's'} ${hs.slice(0, HEADINGS_LISTED).join(', ')}${hs.length > HEADINGS_LISTED ? ', …' : ''}.`);
  }
  const lack = [...new Set(p.wants.filter((w, i) => !got[i] || (got[i].style || 'NORMAL_TEXT') !== w).map((w) => headingName(w) || (w === 'NORMAL_TEXT' ? 'normal' : w.toLowerCase())))];
  if (lack.length) out.push(formatMissNote(m, first + 1, first + p.count, `style ${lack.join(', ')}`));
  const stray = strayHeadingsNote(p, got, first);
  if (stray) out.push(stray);
  return out.join('\n');
}
// A heading style styles every line of an insert: a section inserted with it (a heading, its paragraph, an empty line) gets
// body text made headings (a saved chat). The lines made headings that are empty or read like a sentence (end with a period,
// or more than 12 words), with the ways out, or ''. An outline styles its lines one by one: never named.
function strayHeadingsNote(p, got, first) {
  const w = p.wants[0];
  if (p.outline || p.count < 2 || w === 'NORMAL_TEXT') return '';
  const empty = [];
  const body = [];
  got.forEach((l, i) => {
    if (!l || (l.style || 'NORMAL_TEXT') !== w) return;
    const t = l.text.trim();
    if (!t) empty.push(first + i + 1);
    else if (/\.$/.test(t) || t.split(/\s+/).length > 12) body.push(first + i + 1);
  });
  if (!empty.length && !body.length) return '';
  const lines = (ls) => `line${ls.length === 1 ? '' : 's'} ${lineList(ls)}`;
  const what = [...(empty.length ? [`${lines(empty)} ${empty.length === 1 ? 'is' : 'are'} empty`] : []),
    ...(body.length ? [`${lines(body)} read${body.length === 1 ? 's' : ''} like body text`] : [])].join(' and ');
  return `Note: ${what}, yet ${headingName(w)} now: format_lines style normal, or undo_last_edit and insert with style outline.`;
}

// delete_lines({start, end}). Whole paragraphs with their newlines; when the last one ends a cell, a
// table neighbour or the document, the newline before the range is deleted instead, and when there is
// none either, the lines are emptied (one empty paragraph has to stay).
function planDelete(model, args) {
  const total = model.lines.length;
  const a = Number(args.start);
  const b = Number(args.end);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) {
    return { error: `start and end must be integers with 1 <= start <= end <= ${total}`, short: 'delete_lines: invalid range' };
  }
  for (let i = a; i < b; i++) {
    if (isClosing(model, i - 1)) return { error: `lines ${i} and ${i + 1} are in different parts of the document (for example a table cell and the text after it); delete them separately`, short: 'delete_lines: the range crosses a table boundary' };
  }
  for (let i = a; i <= b; i++) {
    const l = model.lines[i - 1];
    if (!l.exact) return { error: inexactLine(i, 'delete the other lines, or tell the user to delete it in Google Docs'), short: 'delete_lines: unmappable line' };
    if (touchesSuggestion(model, l)) return { error: model.suggestMode ? suggestOverlapError(i) : `line ${i} contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs)`, short: 'delete_lines: the line has suggested changes' };
  }
  const first = model.lines[a - 1];
  const last = model.lines[b - 1];
  const joined = model.text.slice(first.off, last.off + last.text.length);
  let S, E, restore, paras;
  const requests = [];
  if (!isClosing(model, b - 1)) {
    S = first.start; E = last.end + 1; restore = joined + '\n';
    paras = paraStyles(model, a, b, -1);
    requests.push(reqDelete(model, S, E));
  } else if (a > 1 && !isClosing(model, a - 2)) {
    const prev = model.lines[a - 2];
    // The newline of the line before goes too, so that line must be writable as well.
    if (!prev.exact) return { error: `deleting ${rangeLabel(a, b)} also removes the end of line ${a - 1}, and ${inexactLine(a - 1, 'tell the user to delete the lines in Google Docs')}`, short: 'delete_lines: unmappable line' };
    if (touchesSuggestion(model, prev, prev.text.length)) return { error: `deleting ${rangeLabel(a, b)} also removes the end of line ${a - 1}, which contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs)`, short: 'delete_lines: the line has suggested changes' };
    S = prev.end; E = last.end; restore = '\n' + joined;
    paras = [{ nl: -1, style: prev.style || '' }, ...paraStyles(model, a, b, 0)];
    requests.push(reqDelete(model, S, E));
    requests.push(...restyle(model, prev.start, prev.start + 1, prev.style, styleAfterDelete(model, S, E))); // an empty prev takes the deleted line's
  } else {
    S = first.start; E = last.end; restore = joined;
    if (S === E) return { error: `line ${a} is empty and is the last paragraph of its part of the document (a table cell or the document), so it cannot be removed`, short: 'delete_lines: nothing to delete' };
    paras = paraStyles(model, a, b, -1);
    requests.push(reqDelete(model, S, E));
  }
  const styles = rangeStyles(model, S, E);
  return {
    requests, region: [a, b], span: [S, E], removed: [[first.off, last.off + last.text.length]],
    journal: { kind: 'delete', index: S, text: '', restore, paras, ...(styles.length ? { restoreStyles: styles } : {}) },
    title: `Deleted ${rangeLabel(a, b)}`, cardText: showText(joined), cardLabel: 'Deleted text',
    affected: (m) => [Math.max(1, a - 1), Math.min(m.lines.length, a)],
  };
}

// replace_section({heading, new_text}): the body of a section (the lines after its heading up to the next heading
// of the same or a higher level, or the end of the document) becomes new_text; the heading stays. The heading is
// a case-insensitive exact match among the headings outside tables. Built on the other plans, so undo needs nothing
// new: a body with text is replaced like replace_text (the heading's newline + body against newline + new_text,
// so only the differing middle is rewritten; journal 'replace'), an empty new_text deletes the body lines like
// delete_lines, a section without body lines gets new_text inserted after the heading like insert_after_line.
// Always gated (editGateInfo); plan.section names the section for the card.
const SECTION_CLOSEST_MAX = 5;
const headingKey = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
function planReplaceSection(model, args) {
  if (typeof args.heading !== 'string' || typeof args.new_text !== 'string') return { error: 'invalid arguments. Expected {"heading": string, "new_text": string}', short: 'Invalid tool arguments' };
  const want = headingKey(args.heading);
  if (!want) return { error: 'heading is empty. Pass the heading text as the outline shows it', short: 'replace_section: heading is empty' };
  const heads = model.lines.filter((l) => l.heading && !l.cell && l.text.trim());
  if (!heads.length) return { error: 'the document has no headings, so there is no section to replace. Use replace_text', short: 'replace_section: no headings' };
  const found = heads.filter((l) => headingKey(l.text) === want);
  const quoted = (l) => `"${oneLine(l.text.trim(), 80)}" (line ${l.line})`;
  if (!found.length) {
    const words = want.split(' ');
    const score = (l) => { const k = headingKey(l.text); return (k.includes(want) || want.includes(k) ? 100 : 0) + words.filter((w) => k.split(' ').includes(w)).length; };
    const near = heads.map((l) => ({ l, s: score(l) })).sort((x, y) => y.s - x.s || x.l.line - y.l.line).slice(0, SECTION_CLOSEST_MAX);
    return { error: `no heading reads "${oneLine(args.heading, 80)}". Closest headings: ${near.map((x) => quoted(x.l)).join(', ')}. Pass the heading text exactly as the outline shows it (case does not matter)`, short: 'replace_section: heading not found' };
  }
  if (found.length > 1) {
    return { error: `${found.length} headings read "${oneLine(args.heading, 80)}": ${found.slice(0, 10).map(quoted).join(', ')}. Pass more of the heading or edit with replace_text`, short: `replace_section: ${found.length} headings match` };
  }
  const h = found[0];
  let last = h.line;
  for (let n = h.line + 1; n <= model.lines.length; n++) {
    const l = model.lines[n - 1];
    if (l.heading && !l.cell && l.text.trim() && l.heading <= h.heading) break;
    last = n;
  }
  const name = oneLine(h.text.trim(), 80);
  const body = model.lines.slice(h.line, last);
  if (body.some((l) => l.cell)) return { error: `the section «${name}» contains a table, which replace_section cannot rewrite. Edit the text around it with replace_text`, short: 'replace_section: the section contains a table' };
  const chip = chipText(args.new_text, model);
  if (chip.error) return chipError('replace_section', chip);
  const newText = modelInsertText(chip.text).replace(/\n+$/, '');
  const objectError = { error: `the section «${name}» contains an embedded object (shown as "${OBJECT_CHAR}": an image, chip, footnote or break), which replace_section cannot re-create. Edit the text before or after it with replace_text`, short: 'replace_section: the section contains an embedded object' };
  if (newText.includes(OBJECT_CHAR)) return { error: `new_text must not contain "${OBJECT_CHAR}"`, short: 'replace_section: invalid new_text' };
  const oldBody = body.length ? model.text.slice(body[0].off, body[body.length - 1].off + body[body.length - 1].text.length) : '';
  let plan;
  if (!body.length) {
    if (!newText) return noChangeReply(`the section «${name}» is already empty`);
    plan = planInsert(model, { line: h.line, text: newText });
  } else if (!newText) {
    if (oldBody.includes(OBJECT_CHAR)) return objectError;
    plan = planDelete(model, { start: h.line + 1, end: last });
  } else {
    if (oldBody === newText) return noChangeReply(`the section «${name}» already reads that`);
    plan = replacePlan(model, h.off + h.text.length, '\n' + oldBody, '\n' + newText, false, true);
    if (!plan.error && (plan.mid.oldText.includes(OBJECT_CHAR) || plan.mid.newText.includes(OBJECT_CHAR))) return objectError;
    if (!plan.error) plan.requests.push(...newParagraphSheetRequests(model, model.sheet, replaceNewParas(model, plan)));
  }
  if (plan.error) return { error: plan.error, short: 'replace_section: ' + plan.error };
  const label = rangeLabel(h.line, last);
  const inner = plan.affected;
  return finishChips({
    ...plan, region: [h.line, last], section: { name, from: h.line, to: last, removed: oldBody }, removed: plan.removed || [],
    title: `${newText ? 'Replaced' : 'Emptied'} the section «${name}» (${label})`, cardText: showText(newText), cardLabel: newText ? 'New text' : '',
    // The report starts at the heading, so the model sees the section as it reads now.
    affected: (m) => { const [, b] = inner(m); return [h.line, Math.max(h.line, b)]; },
  }, chip);
}

// The paragraphs a replacement (replacePlan) creates whole, for the formatting sheet: [{ s, e, style, noPara }] in API
// indices after the edit. A paragraph between two newlines of the new text is new; the first one only when the
// replacement starts at a paragraph start, the last one (whose newline is the old paragraph's: noPara, text values
// only) only when nothing of the old paragraph follows. Text inside an existing paragraph keeps that paragraph's
// formatting (it is never restyled). list / cell: Docs gives a paragraph made by an inserted newline the bullet of the
// paragraph it splits, so a new paragraph counts as a list item (the sheet leaves its alignment, spacing and indents
// alone) when the first or the last paragraph of the replaced range is one; the first and the last take their own.
const listCell = (...ls) => ({ list: ls.some((l) => l && !!l.list), cell: ls.some((l) => l && !!l.cell) });
function replaceNewParas(model, plan) {
  const mid = plan.mid.newText;
  if (!mid.includes('\n')) return [];
  const S = plan.journal.index;
  const E = S + plan.mid.oldText.length;
  const firstLine = lineAtIndex(model, S);
  const lastLine = lineAtIndex(model, E);
  const segs = mid.split('\n');
  const out = [];
  let off = 0;
  segs.forEach((t, i) => {
    const s = S + off;
    off += t.length + 1;
    if (i === 0 && !(firstLine && firstLine.start === S)) return;
    if (i === segs.length - 1) {
      if (lastLine && lastLine.end === E) out.push({ s, e: s + t.length, style: lastLine.style || 'NORMAL_TEXT', noPara: true, ...listCell(lastLine) });
      return;
    }
    const from = i === 0 ? listCell(firstLine) : listCell(firstLine, lastLine);
    out.push({ s, e: s + t.length, style: i === 0 ? (firstLine.style || 'NORMAL_TEXT') : 'NORMAL_TEXT', ...from });
  });
  return out;
}

// A format_text flag as true / false / null; undefined when invalid. Some servers' tool-call parsers
// (Qwen-style XML calls) deliver booleans as strings, and weaker models write yes/no or 1/0, so those
// are accepted too.
function flagValue(v) {
  if (v === undefined || v === null || typeof v === 'boolean') return v === undefined ? null : v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  return s === 'null' || s === '' ? null : undefined;
}
// A received argument for an error message, with its type, so the string "true" and true are told apart.
const describeValue = (v) => (typeof v === 'string' ? `the string ${JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v)}`
  : `${JSON.stringify(v)} (${Array.isArray(v) ? 'array' : typeof v})`);

// "bold on, underline off"
const formatFlagsText = (flags) => flags.map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ');

// ---- format_text: arguments ---------------------------------------------------------------------
const FORMAT_PROPS = ['bold', 'italic', 'underline', 'font', 'size', 'color', 'highlight', 'script', 'link'];
const FORMAT_EXAMPLE = '{"old_text":"lazy dog","bold":true,"italic":null,"underline":null,"font":null,"size":null,"color":null,"highlight":null,"script":null,"link":null}';
// script: a superscript or subscript (baselineOffset); "none" (or a word for the baseline) puts the text back on it.
const SCRIPT_WORDS = { super: 'super', superscript: 'super', sup: 'super', sub: 'sub', subscript: 'sub' };
const SCRIPT_OFFSETS = { super: 'SUPERSCRIPT', sub: 'SUBSCRIPT' };
const RESET_WORDS = ['default', 'none', 'reset', 'inherit', 'normal', 'auto'];
const UNLINK_WORDS = ['', 'none', 'remove', 'unlink', 'no link', 'off'];
// A string property left out: null, missing, "" or the string "null" (link: "" removes, see below).
const looseNull = (v) => v === undefined || v === null || (typeof v === 'string' && ['', 'null'].includes(v.trim().toLowerCase()));
const isResetWord = (v) => typeof v === 'string' && RESET_WORDS.includes(v.trim().toLowerCase());
const colorError = (k, v) => ({ error: `${k} ${JSON.stringify(v)} is not a color: use "#RRGGBB" (e.g. "#C00000") or one of red, orange, yellow, green, blue, purple, gray, black, white; "none" resets`, short: `format_text: invalid ${k}` });

// The changes a format_text call asks for, in FORMAT_PROPS order: [[prop, value]] with booleans for
// bold/italic/underline and, for the others, the value or null for a reset: font {name, known}, size
// (pt), color/highlight '#RRGGBB', script 'super' | 'sub', link the URL. Returns { changes, notes } or { error, short }.
function formatChanges(args) {
  const changes = [];
  const notes = [];
  for (const k of FORMAT_PROPS) {
    const v = args[k];
    if (FORMAT_KEYS.includes(k)) {
      const f = flagValue(v);
      if (f === undefined) return { error: `${k} must be true, false or null (JSON booleans); got ${describeValue(v)}`, short: `format_text: invalid ${k}` };
      if (f !== null) changes.push([k, f]);
      continue;
    }
    if (k === 'link') {
      if (v === undefined || v === null || (typeof v === 'string' && v.trim().toLowerCase() === 'null')) continue;
      const s = typeof v === 'string' ? v.trim() : null;
      if (s !== null && UNLINK_WORDS.includes(s.toLowerCase())) { changes.push([k, null]); continue; }
      // javascript:, relative paths and bare domains are refused alike: Docs needs a full URL.
      if (s === null || s.length > 2000 || !/^(https?:\/\/[^\s/]\S*|mailto:\S+)$/i.test(s)) {
        return { error: `link must be a full URL starting with https://, http:// or mailto: (got ${JSON.stringify(v)}); "none" removes the link`, short: 'format_text: invalid link' };
      }
      changes.push([k, s]);
      continue;
    }
    if (looseNull(v)) continue;
    if (k === 'script') {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (isResetWord(s) || s === 'baseline') { changes.push([k, null]); continue; }
      if (!SCRIPT_WORDS[s]) return { error: `script must be "super", "sub" or "none"; got ${describeValue(v)}`, short: 'format_text: invalid script' };
      changes.push([k, SCRIPT_WORDS[s]]);
    } else if (k === 'font') {
      const bad = { error: 'font must be a font family name such as "Arial" or "Times New Roman"; "default" resets', short: 'format_text: invalid font' };
      if (typeof v !== 'string') return bad;
      if (isResetWord(v)) { changes.push([k, null]); continue; }
      const f = knownFont(v);
      if (!f || f.name.length > 100 || /[{}<>"\n]/.test(f.name)) return bad;
      if (!f.known) notes.push(`Note: "${f.name}" is not a common Docs font; Google Docs shows unknown fonts as Arial.`);
      changes.push([k, f]);
    } else if (k === 'size') {
      // 0 resets; a tiny size that rounds to 0 is an error, not a reset.
      if (isResetWord(v) || parsePt(v) === 0) { changes.push([k, null]); continue; }
      const n = parseSize(v);
      if (n == null || n < 1 || n > 400) return { error: 'size must be a number of points from 1 to 400 (e.g. 11, 14); 0 resets to the default', short: 'format_text: invalid size' };
      changes.push([k, n]);
    } else {
      const c = parseColor(v);
      if (!c) return colorError(k, v);
      changes.push([k, c.none ? null : c.hex]);
    }
  }
  return { changes, notes };
}

// "bold on, size 14, color #FF0000, link removed" (the Done sentence).
const changeText = ([k, v]) => (FORMAT_KEYS.includes(k) ? formatFlagsText([[k, v]])
  : v == null ? (k === 'link' || k === 'highlight' || k === 'script' ? `${k} removed` : `${k} default`)
  : `${k} ${k === 'font' ? v.name : k === 'size' ? numText(v) : v}`);
// "bold, size 14" (the No change sentence: what the text already is).
const stateText = ([k, v]) => ({
  bold: v ? 'bold' : 'not bold', italic: v ? 'italic' : 'not italic', underline: v ? 'underlined' : 'not underlined',
  font: v ? `in ${v && v.name}` : 'in the default font', size: v != null ? `size ${numText(v)}` : 'at the default size',
  color: v ? `colored ${v}` : 'in the default color', highlight: v ? `highlighted ${v}` : 'not highlighted',
  script: v ? `${v}script` : 'on the baseline', link: v ? `linked to ${v}` : 'not a link',
})[k];
// The action-log summary of format_text arguments as received ("bold on, size 14, color red"); never fails.
function formatArgsText(args) {
  const out = [];
  for (const k of FORMAT_PROPS) {
    const v = args[k];
    if (FORMAT_KEYS.includes(k)) { const f = flagValue(v); if (f != null) out.push(formatFlagsText([[k, f]])); continue; }
    if (k === 'link' && typeof v === 'string' && UNLINK_WORDS.includes(v.trim().toLowerCase())) { out.push('link removed'); continue; }
    if (!looseNull(v)) out.push(`${k} ${typeof v === 'string' ? v.trim() : JSON.stringify(v)}`);
  }
  return out.join(', ');
}

// A formatting write that the re-read document does not fully show: what it lacks (missing: the values in words) and the
// lines in the notation, so the model sees what took.
const formatMissNote = (m, a, b, missing) => `Note: Google Docs did not apply all of it${missing ? ` (not shown: ${missing})` : ''}; `
  + `${rangeLabel(a, b)} now read${a === b ? 's' : ''}:\n${formatNote(m)}\n${linesReport(m, a, b, markedText)}`;
// The notes of several checks with the notation legend (formatNote) kept only where it first appears.
function legendOnce(m, text) {
  const legend = formatNote(m);
  let seen = false;
  return text.split('\n').filter((l) => {
    if (l !== legend) return true;
    if (seen) return false;
    seen = true;
    return true;
  }).join('\n');
}
// The same across the write results of a turn (snap.legendShown: the legend last shown, which stays in the context: only
// reading results are stubbed); a legend that differs (another "Unmarked text:") is shown again.
function legendOncePerTurn(snap, m, text) {
  const legend = formatNote(m);
  if (!text || !text.split('\n').includes(legend)) return text;
  if (snap.legendShown !== legend) { snap.legendShown = legend; return legendOnce(m, text); }
  return text.split('\n').filter((l) => l !== legend).join('\n');
}
// What text of a line shows for format_text property k where its run sets nothing, when the model knows it, else
// undefined: the line's named style (model.named: read for the calls with format_lines, and for format_text once its check
// finds a miss), else, for body text, the Normal text style last read for the document; color: the named style's (its own,
// else Normal text's, else black), and while the named styles are unread black except on the styles Docs greys. The
// re-read of a write that asked for an inherited value may show no explicit value (verification counts it as applied).
function inheritedText(model, line, k) {
  const style = (line && line.style) || 'NORMAL_TEXT';
  const named = model.named || null;
  const normal = { ...(unmarkedDefault({ docId: model.docId, tabId: model.tabId, textDefault: null }) || {}), ...((named && named.NORMAL_TEXT) || {}) };
  const own = style === 'NORMAL_TEXT' ? normal : named ? { ...normal, ...(named[style] || {}) } : {};
  if (k === 'color') return namedColor(named, style) || (DOCS_GREY_STYLES.includes(style) ? undefined : normal.color || '#000000');
  return own[k] == null ? undefined : own[k];
}

// ---- format_text: prior values (undo, no-op check) ----------------------------------------------
// The value of updateTextStyle field f in the run (undefined = absent, i.e. inherited); a link is the
// raw API object, so heading, bookmark and tab links survive an undo.
function runFieldValue(run, f) {
  if (!run) return undefined;
  switch (f) {
    case 'weightedFontFamily': return run.font ? { fontFamily: run.font, weight: run.weight || 400 } : undefined;
    case 'fontSize': return run.size != null ? ptDimension(run.size) : undefined;
    case 'foregroundColor': return run.color ? apiColor(run.color) : undefined;
    case 'backgroundColor': return run.bg ? apiColor(run.bg) : undefined;
    case 'baselineOffset': return run.script ? SCRIPT_OFFSETS[run.script] : undefined;
    case 'link': return run.linkRaw ? JSON.parse(JSON.stringify(run.linkRaw)) : run.link ? { url: run.link } : undefined;
    default: return run[f] ? true : undefined; // bold, italic, underline: the model sees explicit true only
  }
}
// Whether the run already has the requested value of format_text property k. inh: the value the run inherits where it
// sets none (inheritedText), or undefined when unknown; given only by the re-read check, so a write still makes a value
// explicit.
function runHas(run, k, v, inh) {
  const r = run || {};
  if (FORMAT_KEYS.includes(k)) return !!r[k] === v || (v === true && !r[`${k}Off`] && inh === true);
  const cur = k === 'font' ? r.font : k === 'size' ? r.size : k === 'color' ? r.color : k === 'highlight' ? r.bg : k === 'script' ? r.script : r.link;
  if (v == null) return cur == null && !(k === 'link' && r.linkRaw);
  const want = k === 'font' ? v.name : v;
  return cur === want || (cur == null && inh !== undefined && inh === want);
}
// The run of each index of API range r ({ idx, run | null, line }). A paragraph newline inside the range counts
// with the character before it (an empty line's newline as plain).
function rangeRuns(model, r) {
  const out = [];
  for (let n = r.from; n <= r.to; n++) {
    const l = model.lines[n - 1];
    const at = (i) => (l.runs || []).find((x) => x.s <= i && i < x.e) || null;
    for (let idx = Math.max(r.start, l.start); idx < Math.min(r.end, l.end + 1); idx++) {
      out.push({ idx, run: idx < l.end ? at(idx - l.start) : l.end > l.start ? at(l.end - l.start - 1) : null, line: l });
    }
  }
  return out;
}
// Docs gives inserted text the text style of the character before the index in its paragraph (at a paragraph's start the
// one at the index); a link does not pass on, nor its underline and color (real-docs.js facts 7b, 7e). inheritedFields:
// the fields text inserted at index at takes that way ([] when it stays plain).
const RESTORED_FIELDS = ['bold', 'italic', 'underline', 'weightedFontFamily', 'fontSize', 'foregroundColor', 'backgroundColor', 'baselineOffset', 'link'];
function inheritedFields(model, at) {
  const l = lineAtIndex(model, at);
  const off = l ? (at > l.start ? at - l.start - 1 : 0) : -1;
  const r = l && off < l.text.length ? (l.runs || []).find((x) => x.s <= off && off < x.e) : null;
  if (!r) return [];
  return RESTORED_FIELDS.filter((f) => f !== 'link' && !(r.link && (f === 'underline' || f === 'foregroundColor')) && runFieldValue(r, f) !== undefined);
}
// The styled stretches of API range [S, E) as [[s, e, run]] relative to S (a newline with the character before it): the
// journal keeps them, so an undo puts removed text back with its own text styles (restoredStyles).
function rangeStyles(model, S, E) {
  const a = E > S ? lineAtIndex(model, S) : null;
  const b = a ? lineAtIndex(model, E - 1) : null;
  if (!b) return [];
  const out = [];
  for (const { idx, run } of rangeRuns(model, { from: a.line, to: b.line, start: S, end: E })) {
    if (!run) continue;
    const st = Object.fromEntries(Object.entries(run).filter(([k]) => k !== 's' && k !== 'e'));
    const last = out[out.length - 1];
    if (last && last[1] === idx - S && JSON.stringify(last[2]) === JSON.stringify(st)) last[1]++; else out.push([idx - S, idx - S + 1, st]);
  }
  return out;
}
// The updateTextStyle requests that give text restored at index (len characters) the styles of its stretches (rangeStyles;
// plain elsewhere), or [] when it is plain and takes nothing from its neighbour.
function restoredStyles(model, index, len, stretches) {
  if (!len || (!(stretches || []).length && !inheritedFields(model, index).length)) return [];
  const runs = Array.from({ length: len }, (_, i) => ({ idx: index + i, run: ((stretches || []).find(([s, e]) => s <= i && i < e) || [])[2] || null }));
  return inverseTextStyles(model, runs, RESTORED_FIELDS);
}
// Inverse updateTextStyle requests: one per stretch of equal prior values of the fields, all fields listed
// (an absent value resets).
function inverseTextStyles(model, runs, fields) {
  const prior = runs.map(({ idx, run }) => {
    const style = {};
    for (const f of fields) { const v = runFieldValue(run, f); if (v !== undefined) style[f] = v; }
    return { idx, style, key: JSON.stringify(style) };
  });
  const out = [];
  for (let i = 0; i < prior.length;) {
    let j = i + 1;
    while (j < prior.length && prior[j].idx === prior[j - 1].idx + 1 && prior[j].key === prior[i].key) j++;
    out.push(reqTextStyle(model, prior[i].idx, prior[j - 1].idx + 1, prior[i].style, fields));
    i = j;
  }
  return out;
}

// format_text({old_text, line, all, bold, italic, underline, font, size, color, highlight, script, link}): one updateTextStyle
// over the unique match (line: the one on that line); null leaves a property as it is. The text does not change, so line
// numbers stay valid (keepsLines). Embedded objects inside the range are allowed. Font keeps the prior weight and the
// prior bold (Docs drops bold on a weightedFontFamily write, so bold is sent again after it); resets
// leave the key out of textStyle while listing it in fields. Docs underlines and colors a new link itself,
// so removing a link resets underline and color too, and the undo of any link write restores them. Undo:
// inverse requests built from the runs before the edit, one per stretch of equal prior values; a prior
// false is restored as a reset (the model only sees explicit true).
// Nothing is sent when the text already has every requested value: "No change", or, when this very call
// already succeeded in this turn (snap.formatDone), "Already done" so the model stops repeating it.
// all: true formats every occurrence (planFormatAll).
function planFormat(model, args, snap) {
  const t = formatTarget(model, args);
  if (t.error || t.reply) return t;
  if (t.all) return planFormatAll(model, t);
  return formatHitPlan(model, t.hits[0], t, snap);
}

// The arguments of format_text checked and its hits found: { changes, notes (of the values), hits, oldText, stripped,
// all, line }, or { error, short }. all: every non-overlapping hit (on line, when given); else exactly one.
function formatTarget(model, args) {
  if (!args || typeof args.old_text !== 'string') return { error: `invalid arguments. Example: ${FORMAT_EXAMPLE}`, short: 'Invalid tool arguments' };
  const parsed = formatChanges(args);
  if (parsed.error) return parsed;
  const { changes } = parsed;
  if (!changes.length) return { error: `pass at least one property that is not null (${FORMAT_PROPS.join(', ')}). Example: ${FORMAT_EXAMPLE}`, short: 'format_text: no formatting given' };
  const all = flagValue(args.all);
  if (all === undefined) return { error: `all must be true, false or null; got ${describeValue(args.all)}`, short: 'format_text: invalid all' };
  const given = args.old_text.replace(/\r\n?/g, '\n');
  if (!given) return { error: 'old_text is empty. Pass the exact text to format', short: 'format_text: old_text is empty' };
  // eslint-disable-next-line no-control-regex -- U+000B is the Docs soft line break
  if (all && (/[\n\u000b]/.test(given) || given.includes(SOFT_BREAK_MARK))) {
    return { error: 'all: true formats text within paragraphs only: old_text must not contain newlines or soft line breaks. For text spanning several lines format one occurrence at a time (line: N)', short: 'format_text: all with text spanning lines' };
  }
  const { hits: found, oldText, stripped } = findOldText(model, given);
  if (!found.length) {
    return { error: notFoundError(model, oldText, 'old_text must match the document text (without the "N: " line-number prefixes and without formatting markers); read the exact text with read_document or find_in_document and try again',
      'Copy old_text exactly from the current text above, without the "N: " prefixes or formatting markers.'), short: 'format_text: the text was not found' };
  }
  const picked = hitsOnLine(model, all ? disjointHits(found) : found, args.line, 'format_text');
  if (picked.error) return picked;
  const { hits } = picked;
  if (!all && hits.length > 1) {
    return { error: ambiguousOldText(model, hits, 'format_text', picked.line), short: `format_text: the text occurs ${hits.length} times` };
  }
  return { changes, notes: parsed.notes, hits: all ? hits : [wholeLineHit(model, hits[0], changes)], oldText, stripped, all: !!all, line: picked.line };
}
// A hit that is a line's whole text but its leading or trailing spaces means the line (a saved chat: the word got the
// font, a leading space kept the old one, and the line still read as the old font): it widens to the line (wide: the result
// says so). Not for underline, highlight and link, which show on a space.
const LINE_EDGE_SPACE = /^[ \t\u00a0]*$/;
function wholeLineHit(model, h, changes) {
  if (changes.some(([k]) => ['underline', 'highlight', 'link'].includes(k)) || !h.text.trim()) return h;
  const l = lineAtOffset(model, h.at);
  const a = h.at - l.off;
  const b = a + h.text.length;
  if (b > l.text.length || b - a === l.text.length) return h;
  return LINE_EDGE_SPACE.test(l.text.slice(0, a)) && LINE_EDGE_SPACE.test(l.text.slice(b)) ? { ...h, at: l.off, text: l.text, wide: true } : h;
}

// The plan of format_text over one hit (t: formatTarget's result). snap: for "Already done" (null: never).
function formatHitPlan(model, hit, t, snap) {
  const { changes } = t;
  const r = indexRange(model, hit.at, hit.at + hit.text.length);
  if (r.error) return { error: r.error, short: 'format_text: ' + r.error };
  const label = rangeLabel(r.from, r.to);
  const runs = rangeRuns(model, r);
  const markersNote = t.stripped ? [MARKERS_NOTE] : [];
  const doneKey = JSON.stringify([r.start, r.end, changes]);
  if (runs.every(({ run }) => changes.every(([k, v]) => runHas(run, k, v)))) {
    const lines = linesReport(model, r.from, r.to, markedText);
    if (snap && snap.formatDone && snap.formatDone.has(doneKey)) {
      const now = r.from === r.to ? `${label} now reads: ${markedText(model.lines[r.from - 1], spanDefault(model))}` : `${label} now read:\n${lines}`;
      return { reply: { content: `Already done in this message: ${now}\nDo not call format_text again for this.`, _ok: true, _message: `Already done (${label})` } };
    }
    const quoted = showText(hit.text.length > 60 ? hit.text.slice(0, 60) + '…' : hit.text).replace(/\n/g, ' ⏎ ');
    return { reply: { content: [`No change: «${quoted}» on ${label} is already ${changes.map(stateText).join(', ')}.`, lines, ...markersNote].join('\n'), _ok: true, _message: `No change (${label})` } };
  }
  const { requests, inverse } = textStyleRequests(model, r, runs, changes);
  return {
    requests, region: [r.from, r.to], keepsLines: true,
    journal: { kind: 'format', index: r.start, end: r.end, text: hit.text, restore: '', paras: [], requests: inverse },
    title: `Formatted ${label}`, done: `formatted ${hit.wide ? 'the whole ' : ''}${label} (${changes.map(changeText).join(', ')})`,
    cardText: showText(hit.text), cardLabel: 'Formatted text', how: changes.map(changeText).join(', '), // how: the permission card's
    affected: () => [r.from, r.to], notes: [...markersNote, ...(hit.normalized ? [hit.folded ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...t.notes],
    hitRange: r,
    // Called once the edit is applied and re-read: from then on an identical call is "Already done". The lines come
    // back only when the re-read text lacks a requested value (the text does not move, so r still addresses it).
    report: (m) => {
      if (snap) (snap.formatDone || (snap.formatDone = new Set())).add(doneKey);
      return took(m);
    },
    // The same check with the range moved by dl lines and di indices (edit_document: the parts above changed the text).
    verify: (m, dl = 0, di = 0) => took(m, dl, di),
  };
  function took(m, dl = 0, di = 0) {
    const at = { start: r.start + di, end: r.end + di, from: r.from + dl, to: r.to + dl };
    if (m.lines.length < at.to) return formatMissNote(m, at.from, at.to, changes.map(changeText).join(', '));
    const runs = rangeRuns(m, at);
    const lack = changes.filter(([k, v]) => !runs.every(({ run, line }) => runHas(run, k, v, inheritedText(model, line, k))));
    return lack.length ? formatMissNote(m, at.from, at.to, lack.map(changeText).join(', ')) : '';
  }
}

// The updateTextStyle requests of changes over range r (runs: its runs before the edit) and their inverse.
function textStyleRequests(model, r, runs, changes) {
  const textStyle = {};
  const fields = [];
  for (const [k, v] of changes) {
    const f = TEXT_STYLE_API_FIELDS[k];
    fields.push(f);
    if (FORMAT_KEYS.includes(k)) textStyle[f] = v;
    else if (v == null) continue; // a reset: listed in fields, absent from textStyle
    else if (k === 'font') {
      const first = runs.find(({ run }) => run && run.font);
      textStyle[f] = { fontFamily: v.name, weight: (first && first.run.weight) || 400 };
    } else if (k === 'size') textStyle[f] = ptDimension(v);
    else if (k === 'color' || k === 'highlight') textStyle[f] = apiColor(v);
    else if (k === 'script') textStyle[f] = SCRIPT_OFFSETS[v];
    else textStyle[f] = { url: v };
  }
  const linkWrite = changes.some(([k]) => k === 'link');
  const linkStyle = ['underline', 'foregroundColor'].filter((f) => !fields.includes(f));
  const sentFields = linkWrite && changes.find(([k]) => k === 'link')[1] == null ? [...fields, ...linkStyle] : [...fields];
  // Docs drops bold when weightedFontFamily is written (the weight replaces the rendered weight; a bold in the
  // same request is applied after it): a font change without a bold argument re-applies bold where it was
  // (in the same request when the whole range is bold, else one request per bold stretch), and its undo
  // lists bold too.
  const keepBold = fields.includes('weightedFontFamily') && !fields.includes('bold');
  const bolds = keepBold ? runs.filter(({ run }) => run && run.bold) : [];
  const allBold = bolds.length > 0 && bolds.length === runs.length;
  if (allBold) { textStyle.bold = true; sentFields.push('bold'); }
  const boldRuns = bolds.length && !allBold ? inverseTextStyles(model, bolds, ['bold']) : [];
  // Docs also stores the font the text shows on a bold write (real-docs.js fact 7b): the undo resets it where the text had
  // none, so the text follows its named style's font again.
  const boldOn = changes.some(([k, v]) => k === 'bold' && v === true) && !fields.includes('weightedFontFamily');
  const undoFields = [...fields, ...(linkWrite ? linkStyle : []), ...(keepBold ? ['bold'] : []), ...(boldOn ? ['weightedFontFamily'] : [])];
  return { requests: [reqTextStyle(model, r.start, r.end, textStyle, sentFields), ...boldRuns], inverse: inverseTextStyles(model, runs, undoFields) };
}

// format_text with all: true: every non-overlapping occurrence of old_text (within paragraphs; on line, when given),
// with the rules of replace_all: hits spelled two or more ways after look-alike folding, or one on a line with suggested
// changes or not mappable exactly, refuse the whole call. The occurrences that already have every value are left out.
// One batch (formatting moves no index); ONE 'format' journal entry whose groups are the occurrences, so one Undo
// restores them all (docs-undo.js undoFormatGroups); the re-read checks every occurrence. count: the occurrences
// formatted (the edit gate: GATE_REPLACE_ALL_COUNT). The parts (formatAllParts) are also edit_document's parts.
function planFormatAll(model, t) {
  const r = formatAllParts(model, t);
  if (r.error || r.reply) return r;
  const { parts, skipped } = r;
  const n = parts.length;
  const lines = [...new Set(parts.flatMap((p) => [p.hitRange.from, p.hitRange.to]))].sort((x, y) => x - y);
  const [from, to] = [lines[0], lines[lines.length - 1]];
  const groups = parts.map(({ journal: j, hitRange: hr }) => ({ index: j.index, end: j.end, text: j.text, lines: [hr.from, hr.to], requests: j.requests }));
  const g0 = groups[0];
  const where = `${lines.length === 1 ? 'line' : 'lines'} ${lineList(lines)}`;
  const skipNote = skipped ? [`Note: ${skipped} other occurrence${skipped === 1 ? ' already had' : 's already had'} this formatting.`] : [];
  return {
    requests: parts.flatMap((p) => p.requests), region: [from, to], keepsLines: true, count: n,
    journal: { kind: 'format', index: g0.index, end: g0.end, text: g0.text, restore: '', paras: [], requests: parts.flatMap((p) => p.journal.requests), ...(n > 1 ? { groups } : {}) },
    title: `Formatted ${n} × "${oneLine(t.oldText, 40)}"`,
    done: `formatted ${n} occurrence${n === 1 ? '' : 's'} on ${where} (${t.changes.map(changeText).join(', ')})`,
    cardText: showText(parts[0].journal.text), cardLabel: `Formatted text (${n} occurrence${n === 1 ? '' : 's'})`, how: t.changes.map(changeText).join(', '),
    affected: () => [from, to], notes: [...new Set(parts.flatMap((p) => p.notes))].concat(skipNote),
    report: (m) => verifyAll(m), verify: (m, dl = 0, di = 0) => verifyAll(m, dl, di),
  };
  function verifyAll(m, dl, di) {
    return legendOnce(m, [...new Set(parts.map((p) => p.verify(m, dl, di)).filter(Boolean))].join('\n'));
  }
}
// The occurrences of a format_text with all: true as single plans (formatHitPlan): { parts, skipped (already formatted) },
// a reply when every occurrence already has the values, or { error, short } (nothing is formatted).
function formatAllParts(model, t) {
  const { hits } = t;
  // A look-alike (folded) match is unambiguous only when every hit is one real spelling (as replace_all).
  const spellings = hits.some((h) => h.folded) ? [...new Set(hits.map((h) => h.text))] : [];
  if (spellings.length > 1) {
    return { error: `old_text matched only after normalizing look-alike Cyrillic/Latin letters, and the document spells it ${spellings.length} different ways (lines ${lineList(hitLines(model, hits))}): ${spellings.map((x) => `"${oneLine(x, 40)}"`).join(', ')}. Nothing was formatted. Copy old_text exactly from the document to format one spelling, or format each occurrence with line: N`, short: 'format_text: look-alike spellings differ' };
  }
  const sugg = hitLines(model, hits).filter((n) => model.lines[n - 1].suggested);
  if (sugg.length) {
    const one = sugg.length === 1;
    return { error: `old_text occurs on ${one ? 'line' : 'lines'} ${lineList(sugg)}, which contain${one ? 's' : ''} suggested changes (suggesting mode), so nothing was formatted. Ask the user to accept or reject the suggestions in Google Docs first, or format the other occurrences one at a time with line: N`, short: 'format_text: an occurrence is on a line with suggested changes' };
  }
  const parts = [];
  let skipped = 0;
  for (const h of hits) {
    const p = formatHitPlan(model, h, t, null);
    if (p.error) return { error: `${p.error}. Nothing was formatted; format the other occurrences one at a time with line: N`, short: p.short };
    if (p.reply) skipped++; else parts.push(p);
  }
  if (!parts.length) {
    const lines = hitLines(model, hits);
    const n = hits.length;
    return { reply: { content: `No change: ${n === 1 ? 'the only occurrence' : `all ${n} occurrences`} of «${oneLine(showText(t.oldText), 60)}» (${lines.length === 1 ? 'line' : 'lines'} ${lineList(lines)}) ${n === 1 ? 'is' : 'are'} already ${t.changes.map(stateText).join(', ')}.`, _ok: true, _message: 'No change' } };
  }
  return { parts, skipped };
}

// ---- format_lines -------------------------------------------------------------------------------------
/* global alignToApi, lineSpacingPercent, LIST_PRESETS, parseAlign, parseLineSpacing, parseListKind, planNumberHeadings */
const reqParaStyle = (model, s, e, paragraphStyle, fields) => ({ updateParagraphStyle: { range: withTab(model, { startIndex: s, endIndex: e }), paragraphStyle, fields: fields.join(',') } });
const reqBulletsOn = (model, s, e, bulletPreset) => ({ createParagraphBullets: { range: withTab(model, { startIndex: s, endIndex: e }), bulletPreset } });
const reqBulletsOff = (model, s, e) => ({ deleteParagraphBullets: { range: withTab(model, { startIndex: s, endIndex: e }) } });
const FORMAT_LINES_EXAMPLE = '{"start":3,"end":3,"style":"h1","align":null,"list":null,"indent_start":null,"indent_first_line":null,"space_above":null,"space_below":null,"line_spacing":null,"numbers":null,"ranges":null}';
// format_lines point properties: [argument, paragraphStyle field, maximum].
const LINE_DIMS = [['indent_start', 'indentStart', 600], ['indent_first_line', 'indentFirstLine', 600], ['indent_end', 'indentEnd', 600], ['space_above', 'spaceAbove', 200], ['space_below', 'spaceBelow', 200]];
// indent_start / indent_first_line "style": the paragraph's own value is removed (the field in the mask, no value), so it
// inherits again (a list item its level's, else its named style's), as a line the user never indented.
const INHERIT = 'style';
const INHERITABLE = ['indentStart', 'indentFirstLine'];
const PARA_FIELD_ORDER = ['namedStyleType', 'alignment', 'indentStart', 'indentFirstLine', 'indentEnd', 'spaceAbove', 'spaceBelow', 'lineSpacing', 'pageBreakBefore', ...BOX_FIELDS];
const LIST_WORDS = { bullet: 'bulleted list', number: 'numbered list', checklist: 'checklist', none: 'no list' };
const LIST_ALREADY = { bullet: 'a bulleted list', number: 'a numbered list', checklist: 'a checklist', none: 'not in a list' };
const ALIGN_WORDS = { left: 'left-aligned', center: 'centered', right: 'right-aligned', justify: 'justified' };

// The format_lines properties as { v: {style, align, list, indentStart, indentFirstLine, indentEnd, spaceAbove, spaceBelow,
// lineSpacing (multiplier), box (shaded / bordered / none), pageBreakBefore} (only the given ones), notes }, or { error, short }.
function formatLinesValues(args) {
  const v = {};
  const notes = [];
  const bad = (error, k) => ({ error, short: `format_lines: invalid ${k}` });
  if (!looseNull(args.style) && !(v.style = parseHeading(args.style))) return bad(`style must be one of title, subtitle, h1…h6, normal (got ${JSON.stringify(args.style)})`, 'style');
  if (!looseNull(args.align) && !(v.align = parseAlign(args.align))) return bad('align must be left, center, right or justify', 'align');
  if (!looseNull(args.list) && !(v.list = parseListKind(args.list))) return bad('list must be bullet, number, checklist or none', 'list');
  for (const [k, f, max] of LINE_DIMS) {
    if (looseNull(args[k])) continue;
    const reset = INHERITABLE.includes(f);
    if (reset && typeof args[k] === 'string' && args[k].trim().toLowerCase() === INHERIT) { v[f] = INHERIT; continue; }
    const n = typeof args[k] === 'boolean' ? null : parsePt(args[k]);
    if (n == null || n < 0 || n > max) return bad(`${k} must be a number of points from 0 to ${max}${reset ? ' or "style" (remove the line\'s own value)' : ''}`, k);
    v[f] = n;
  }
  if (!looseNull(args.line_spacing)) {
    const p = typeof args.line_spacing === 'boolean' ? null : parseLineSpacing(args.line_spacing);
    if (!p || p.value < 0.5 || p.value > 5) return bad('line_spacing must be a multiplier from 0.5 to 5 (1 = single, 1.5, 2)', 'line_spacing');
    v.lineSpacing = p.value;
    if (p.percent) notes.push(`Note: line_spacing ${String(args.line_spacing).trim()} was read as a percent (${numText(p.value)}).`);
  }
  if (!looseNull(args.box) && !(v.box = parseBox(args.box))) return bad('box must be shaded, bordered or none', 'box');
  if (!looseNull(args.page_break_before)) {
    const f = flagValue(args.page_break_before);
    if (typeof f !== 'boolean') return bad(`page_break_before must be true, false or null; got ${describeValue(args.page_break_before)}`, 'page_break_before');
    v.pageBreakBefore = f;
  }
  return { v, notes };
}
// "h2, centered, space above 12"
function formatLinesHow(v) {
  const out = [];
  if (v.style) out.push(v.style === 'normal' ? 'normal text' : v.style);
  if (v.list) out.push(LIST_WORDS[v.list]);
  if (v.align) out.push(ALIGN_WORDS[v.align]);
  if (v.indentStart != null) out.push(v.indentStart === INHERIT ? 'own indent removed' : `indent ${numText(v.indentStart)}`);
  if (v.indentFirstLine != null) out.push(v.indentFirstLine === INHERIT ? 'own first-line indent removed' : `first line at ${numText(v.indentFirstLine)}`);
  if (v.indentEnd != null) out.push(`right indent ${numText(v.indentEnd)}`);
  if (v.spaceAbove != null) out.push(`space above ${numText(v.spaceAbove)}`);
  if (v.spaceBelow != null) out.push(`space below ${numText(v.spaceBelow)}`);
  if (v.lineSpacing != null) out.push(`line spacing ${numText(v.lineSpacing)}`);
  if (v.box) out.push(v.box === 'none' ? 'no box' : v.box);
  if (v.pageBreakBefore != null) out.push(v.pageBreakBefore ? 'page break before' : 'no page break before');
  return out.join(', ');
}
// The format_lines arguments as words for the action log ("numbered list, centered"), '' when invalid.
function formatLinesArgsText(args) {
  const r = formatLinesValues(args || {});
  const nums = args && typeof args.numbers === 'string' ? { set: 'heading numbers', typed: 'typed heading numbers', clear: 'heading numbers removed' }[args.numbers.trim().toLowerCase()] : '';
  const sheet = args && flagValue(args.apply_sheet) === true ? 'formatting sheet' : '';
  return [nums, sheet, r.error ? '' : formatLinesHow(r.v)].filter(Boolean).join(', ');
}
// The given values v (formatLinesValues) that line l lacks, as a v of their own ({} when it has them all).
function lineFormatLack(l, v) {
  const p = l.para || {};
  const has = {
    style: () => (l.style || 'NORMAL_TEXT') === HEADING_STYLES[v.style],
    align: () => p.align === v.align,
    lineSpacing: () => p.lineSpacing === lineSpacingPercent(v.lineSpacing),
    box: () => boxKind(p) === (v.box === 'none' ? '' : v.box),
    pageBreakBefore: () => !!p.pageBreakBefore === v.pageBreakBefore,
    list: () => (v.list === 'none' ? !l.list : !!l.list && l.list.kind === v.list),
  };
  for (const [, f] of LINE_DIMS) has[f] = () => (v[f] === INHERIT ? p[f] == null : p[f] === v[f]);
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => x != null && has[k] && !has[k]()));
}
// The line already has every given value (nothing to send for it).
const lineHasFormat = (l, v) => !Object.keys(lineFormatLack(l, v)).length;
// One updateParagraphStyle per stretch of lines (contiguous) for which pick(line) gives the same paragraphStyle and
// fields(line) the same mask (fields: an array for every line, or a function of the line; an empty mask sends nothing).
function paraStyleRuns(model, lines, pick, fields, out) {
  const maskOf = typeof fields === 'function' ? fields : () => fields;
  const keyOf = (l) => JSON.stringify([pick(l), maskOf(l)]);
  for (let i = 0; i < lines.length;) {
    const key = keyOf(lines[i]);
    let j = i + 1;
    while (j < lines.length && keyOf(lines[j]) === key) j++;
    const mask = maskOf(lines[i]);
    if (mask.length) out.push(reqParaStyle(model, lines[i].start, lines[j - 1].end + 1, pick(lines[i]), mask));
    i = j;
  }
}
// The text fields a named style change clears on a line where they cover the whole line (Google Docs; restyle).
const NAMED_CLEARED_FIELDS = ['bold', 'italic', 'underline', 'weightedFontFamily', 'fontSize', 'foregroundColor', 'backgroundColor'];
// Bullets over [s, e) that keep nesting: tabs for the levels first (Docs reads leading tabs as the level and
// removes them, so the indices end as before), back to front. items: [[line, level], ...].
// First an explicit 0/0 indent on the lines: createParagraphBullets counts a paragraph's first-line indent as nesting too,
// and a removed bullet leaves level × 36 pt (real-docs.js facts num1–num4; headings.js). Docs counts the levels from the
// shallowest line of the range: when that is deeper than 0, anchor (a plain line right before s, from the caller) is
// listed with them and loses its bullet again, its own indents back.
const LIST_INDENTS = ['indentStart', 'indentFirstLine'];
function bulletRequests(model, s, e, items, preset, out, anchor = null) {
  const a = anchor && Math.min(...items.map(([, level]) => level)) > 0 ? anchor : null;
  const from = a ? a.start : s;
  out.push(reqParaStyle(model, from, e, { indentStart: ptDimension(0), indentFirstLine: ptDimension(0) }, LIST_INDENTS));
  let tabs = 0;
  for (const [l, level] of items.slice().reverse()) {
    if (level > 0) { out.push(reqInsert(model, l.start, '\t'.repeat(level))); tabs += level; }
  }
  out.push(reqBulletsOn(model, from, e + tabs, preset));
  if (a) out.push(reqBulletsOff(model, a.start, a.end + 1), reqParaStyle(model, a.start, a.end + 1, priorParaStyle(a.para || {}, LIST_INDENTS), LIST_INDENTS));
}
// A plain line right before line l to lend itself as bulletRequests' anchor, or null.
function listAnchor(model, l) {
  const b = model.lines[l.line - 2];
  return b && !b.cell && !b.list && b.exact && !b.suggested && !b.text.startsWith('\t') && b.end + 1 === l.start ? b : null;
}

// format_lines({start, end, style, align, list, indent_start, indent_first_line, space_above, space_below,
// line_spacing}): paragraph formatting of whole lines; null leaves a property, an indent "style" removes the line's own
// value (INHERIT). The text does not change, so
// line numbers stay valid (keepsLines). Lines are grouped by contiguous index ranges (a table cell ends a
// group); per group, back to front: the bullet requests (a list kind: delete the old bullets, tabs for the
// levels the lines had, create; none: delete, and reset the indents Docs leaves unless given), then one
// updateParagraphStyle with every given field, after the bullets so explicit indents win. Undo: inverse
// requests built now from the lines before the edit (bullets per former list, then the prior values of the
// touched fields per stretch; absent = reset); list identity, custom glyphs and ticks are not restored.
// Nothing to change, or the same call already done in this turn with nothing written since (snap.formatLinesDone:
// key -> the revision after it): a reply without a write.
function planFormatLines(model, args, snap) {
  const total = model.lines.length;
  const sheetCall = !looseNull(args.apply_sheet) && flagValue(args.apply_sheet) !== false;
  if (sheetCall) {
    if (flagValue(args.apply_sheet) !== true) return { error: `apply_sheet must be true or null; got ${describeValue(args.apply_sheet)}`, short: 'format_lines: invalid apply_sheet' };
    const others = LINE_FORMAT_KEYS.filter((k) => k !== 'style' && !looseNull(args[k]));
    if (others.length) return { error: `apply_sheet goes with style and numbers only: call format_lines once without ${others.join(', ')}, then once with ${others.join(', ')} alone`, short: 'format_lines: apply_sheet with other properties' };
    const whole = looseNull(args.start) && looseNull(args.end);
    const [a, b] = whole ? [1, total] : [Number(args.start), Number(looseNull(args.end) ? args.start : args.end)];
    if (!looseNull(args.style) || !looseNull(args.numbers)) return planFormatNumbers(model, args, a, b, true);
    return planApplySheet(model, a, b);
  }
  const a = Number(args.start);
  const b = Number(args.end);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) {
    return { error: `start and end must be integers with 1 <= start <= end <= ${total}`, short: 'format_lines: invalid range' };
  }
  const parsed = formatLinesValues(args);
  if (parsed.error) return parsed;
  const { v, notes } = parsed;
  // Heading numbers (headings.js); with a style or other paragraph values: those first (planFormatNumbers). The numbering
  // writes the headings' list and indents itself.
  if (!looseNull(args.numbers)) {
    const owned = ['list', 'indent_start', 'indent_first_line'].filter((k) => !looseNull(args[k]));
    if (owned.length) return { error: `numbers writes the headings' list and indents itself: send the call without ${owned.join(', ')}`, short: 'format_lines: numbers with list or indents' };
    if (Object.keys(v).length) return planFormatNumbers(model, args, a, b, false);
    return planNumberHeadings(model, { action: args.numbers, start_line: a, end_line: b, prefix: args.prefix });
  }
  if (!Object.keys(v).length) {
    return { error: `pass at least one of style, align, list, numbers, indent_start, indent_first_line, indent_end, space_above, space_below, line_spacing, box, page_break_before (null leaves it unchanged). Example: ${FORMAT_LINES_EXAMPLE}`, short: 'format_lines: no formatting given' };
  }
  const lines = model.lines.slice(a - 1, b);
  const refused = formatLinesRefusal(lines, v);
  if (refused) return refused;
  const label = rangeLabel(a, b);
  const how = formatLinesHow(v);
  const shown = (m) => `${formatNote(m)}\n${linesReport(m, a, b, markedText)}`;
  const doneKey = `${a}-${b} ${JSON.stringify(v)}`;
  const noop = lines.every((l) => lineHasFormat(l, v));
  const doneAt = snap && snap.formatLinesDone ? snap.formatLinesDone.get(doneKey) : undefined;
  // The same call after a success in this turn, with nothing written since (or nothing left to change).
  if (doneAt !== undefined && (doneAt === model.revisionId || noop)) {
    return { reply: { content: `Already done in this message: formatted ${label} (${how}). Do not call format_lines again for this.\n${shown(model)}`, _ok: true, _message: `Already done: formatted ${label}` } };
  }
  if (noop) {
    const isAre = a === b ? 'is' : 'are';
    const what = Object.keys(v).length === 1 && v.list ? LIST_ALREADY[v.list] : `formatted like this (${how})`;
    return { reply: { content: `No change: ${label} ${isAre} already ${what}.\n${shown(model)}`, _ok: true, _message: `No change: ${label}` } };
  }
  // A line whose paragraph style changes gets the formatting sheet's values of its new type, except the paragraph
  // values the call sets itself (a list owns the indents).
  const want = v.style ? HEADING_STYLES[v.style] : null;
  const entry = want ? sheetEntry(model.sheet, want) : null;
  const sheetItems = entry ? lines.filter((l) => (l.style || 'NORMAL_TEXT') !== want).map((l) => ({ l, v: entry, style: want })) : [];
  const explicit = [...(v.align ? ['alignment'] : []), ...(v.lineSpacing != null ? ['lineSpacing'] : []),
    ...(v.spaceAbove != null ? ['spaceAbove'] : []), ...(v.spaceBelow != null ? ['spaceBelow'] : []),
    ...(v.indentFirstLine != null || v.list ? ['indentFirstLine'] : []), ...(v.pageBreakBefore != null ? ['pageBreakBefore'] : [])];
  const { groups, requests, inverse, groupInverse, listsTouched } = formatLinesRequests(model, lines, v, { items: sheetItems, explicit });
  const first = lines[0];
  const last = lines[lines.length - 1];
  const groupText = (g) => model.text.slice(g[0].off, g[g.length - 1].off + g[g.length - 1].text.length);
  // A range across a table cell is not one stretch of text, so each group gets its own anchor (finishEdit) and
  // is relocated and checked on its own at undo time (docs-undo.js undoFormatGroups); the entry's own anchor is
  // the first group's.
  const parts = groups.length > 1 ? { groups: groups.map((g, k) => ({ index: g[0].start, end: g[g.length - 1].end + 1, text: groupText(g),
    lines: [g[0].line, g[g.length - 1].line], requests: groupInverse[k] })) } : {};
  return {
    requests, region: [a, b], keepsLines: true, listSet: !!v.list,
    styles: want && lines.some((l) => (l.style || 'NORMAL_TEXT') !== want) ? [want] : [], // the style colour note (runWriteTool)
    journal: { kind: 'format', index: first.start, end: last.end + 1, text: groupText(groups[0]), restore: '', paras: [], requests: inverse, ...parts, ...(listsTouched ? { lists: true } : {}) },
    title: `Formatted ${label}`, done: `formatted ${label} (${how})`,
    cardText: showText(lines.map((l) => l.text).join('\n')), cardLabel: 'Formatted lines', how, // how: the permission card's
    affected: () => [a, b], notes,
    // Called once the edit is applied and re-read: an identical call is "Already done" while nothing else is written.
    // The lines come back only when one of them lacks a requested value.
    report: (m) => {
      if (snap) (snap.formatLinesDone || (snap.formatLinesDone = new Map())).set(doneKey, m.revisionId);
      return verify(m);
    },
    verify, // edit_document: the lines moved by dl
  };
  function verify(m, dl = 0) {
    const lack = m.lines.length >= b + dl ? Object.assign({}, ...m.lines.slice(a - 1 + dl, b + dl).map((l) => lineFormatLack(l, v))) : v;
    return Object.keys(lack).length ? formatMissNote(m, a + dl, b + dl, formatLinesHow(lack)) : '';
  }
}

// format_lines with numbers together with a style (and other paragraph values) or apply_sheet, or apply_sheet with a style:
// the formatting first, then the sheet, then the numbers, each planned on the lines as the step before leaves them (a
// style changes no index), in one batch. One 'multi' journal entry, undone from the numbers back, so the formatting parts
// find their text with its typed numbers again: their anchors are taken on the text as it is now.
function planFormatNumbers(model, args, a, b, sheetCall) {
  const parts = [];
  const quiet = []; // the steps with nothing to change
  const take = (p) => { if (p.error) return p; if (p.reply) quiet.push(p.reply.content.split('\n')[0].replace(/^No change: /, '').replace(/\.$/, '')); else parts.push(p); return null; };
  const fmt = { ...args, start: a, end: b, numbers: null, apply_sheet: null };
  let after = model;
  if (LINE_FORMAT_KEYS.some((k) => !looseNull(args[k]))) {
    const bad = take(planFormatLines(model, fmt, null));
    if (bad) return bad;
    const { v } = formatLinesValues(fmt);
    const want = v.style ? HEADING_STYLES[v.style] : null;
    if (want) after = { ...model, lines: model.lines.map((l) => (l.line >= a && l.line <= b ? { ...l, style: want, heading: headingLevel(want) } : l)) };
  }
  const sheetBad = sheetCall ? take(planApplySheet(after, a, b)) : null;
  if (sheetBad) return sheetBad;
  const formatting = parts.slice(); // the parts checked by their verify
  let n = null;
  if (!looseNull(args.numbers)) {
    const before = parts.length;
    const numBad = take(planNumberHeadings(after, { action: args.numbers, start_line: a, end_line: b, prefix: args.prefix }));
    if (numBad) return numBad;
    if (parts.length > before) n = parts[parts.length - 1];
  }
  if (!parts.length) return { reply: { content: `No change: ${quiet.join('; ')}.`, _ok: true, _message: 'No change' } };
  const notes = [...new Set(parts.flatMap((p) => p.notes || [])), ...(quiet.length ? [`Note: no change for ${quiet.join('; ')}.`] : [])];
  if (parts.length === 1) return { ...parts[0], notes };
  const ctx = (x) => {
    const o = offsetAtIndex(model, x.index);
    const len = (x.text || '').length;
    return o == null ? null : { before: model.text.slice(Math.max(0, o - ANCHOR_CHARS), o), after: model.text.slice(o + len, o + len + ANCHOR_CHARS) };
  };
  const anchored = (j) => (j.kind === 'format' ? { ...j, anchor: ctx(j), ...(j.groups ? { groups: j.groups.map((g) => ({ ...g, anchor: ctx(g) })) } : {}) } : j);
  const lo = Math.min(...parts.map((p) => p.region[0]));
  const hi = Math.max(...parts.map((p) => p.region[1]));
  return {
    requests: parts.flatMap((p) => p.requests), region: [lo, hi], keepsLines: true, ...(n && typeof n.expectText === 'string' ? { expectText: n.expectText } : {}),
    journal: multiJournal(parts.map((p) => anchored(p.journal)), parts.some((p) => p.journal.lists) ? { lists: true } : {}),
    title: parts.map((p) => p.title).join('; '), done: parts.map((p) => p.done).join('; '),
    cardText: (n || parts[0]).cardText, cardLabel: (n || parts[0]).cardLabel, notes,
    styles: parts.flatMap((p) => p.styles || []), // the formatting part's: the style colour note (runWriteTool)
    affected: () => [lo, hi],
    ...(n && n.repair ? { repair: n.repair } : {}),
    report: (m, retried = false) => [...formatting.map((p) => p.verify(m)), n && n.report ? n.report(m, retried) : ''].filter(Boolean).join('\n'),
  };
}

// format_lines apply_sheet: every paragraph of lines a..b gets the formatting sheet's values of its type (text values on
// the whole paragraph, paragraph values on the paragraph), in one batch. Table cells keep their formatting; title and
// subtitle follow the sheet only when it names them; a line with suggested changes or unmappable positions is left out
// with a note. A numbered heading (numbers: set) gets the indents of the sheet's numbers entry again. Undo: the prior
// value of every touched field, per group of contiguous lines (as format_lines). Nothing differs: "No change".
function planApplySheet(model, a, b) {
  const total = model.lines.length;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) {
    return { error: `start and end must be integers with 1 <= start <= end <= ${total} (both null: the whole document)`, short: 'format_lines: invalid range' };
  }
  const label = rangeLabel(a, b);
  const skipped = [];
  const items = [];
  for (const l of model.lines.slice(a - 1, b)) {
    const v = l.cell ? null : sheetEntry(model.sheet, l.style || 'NORMAL_TEXT');
    const want = numberedHeadingIndent(model, l);
    const ind = want && !sameIndent(l, want) ? want : null;
    const ch = v ? sheetLineChanges(model, l, v) : {};
    if (!ch.text && !ch.para && !ind) continue;
    if (!l.exact || l.suggested) { skipped.push(l.line); continue; }
    items.push({ l, v, ind });
  }
  const skipNote = [...(skipped.length ? [`Note: ${skipped.length === 1 ? 'line' : 'lines'} ${lineList(skipped)} ${skipped.length === 1 ? 'has' : 'have'} suggested changes or unmappable positions and ${skipped.length === 1 ? 'was' : 'were'} left out.`] : []),
    ...sheetNumbersNotes(model.sheet)];
  if (!items.length) {
    return { reply: { content: [`No change: ${label} already ${a === b ? 'follows' : 'follow'} the formatting sheet.`, ...skipNote].join('\n'), _ok: true, _message: `No change: ${label}` } };
  }
  const groups = [];
  // Lines between two items belong to their group when the text and the indices advance together (no table between).
  items.forEach((x, k) => { const p = k && items[k - 1].l; if (p && x.l.start - p.start === x.l.off - p.off) groups[groups.length - 1].push(x); else groups.push([x]); });
  const requests = [];
  const inverse = [];
  const parts = groups.map((g) => {
    const r = sheetLineRequests(model, g.filter((x) => x.v));
    // The numbering indents (a list line: the sheet's own paragraph values leave its indents alone).
    for (const { l, ind } of g.filter((x) => x.ind)) {
      const p = l.para || {};
      const fields = ['indentStart', 'indentFirstLine'];
      r.requests.push(reqParaStyle(model, l.start, l.end + 1, { indentStart: ptDimension(ind.indentStart), indentFirstLine: ptDimension(ind.indentFirstLine) }, fields));
      const prior = {};
      for (const f of fields) if (p[f] != null) prior[f] = ptDimension(p[f]);
      r.inverse.push(reqParaStyle(model, l.start, l.end + 1, prior, fields));
    }
    requests.push(...r.requests);
    inverse.push(...r.inverse);
    const first = g[0].l;
    const last = g[g.length - 1].l;
    return { index: first.start, end: last.end + 1, text: model.text.slice(first.off, last.off + last.text.length), lines: [first.line, last.line], requests: r.inverse };
  });
  const lines = items.map((x) => x.l.line);
  const n = lines.length;
  const where = `${n === 1 ? 'line' : 'lines'} ${lineList(lines)}`;
  return {
    requests, region: [lines[0], lines[n - 1]], keepsLines: true,
    journal: { kind: 'format', index: parts[0].index, end: parts[0].end, text: parts[0].text, restore: '', paras: [], requests: inverse, ...(parts.length > 1 ? { groups: parts } : {}) },
    title: `Applied the formatting sheet to ${n} line${n === 1 ? '' : 's'}`, done: `applied the formatting sheet to ${where}`,
    cardText: showText(items.map((x) => x.l.text).join('\n')), cardLabel: 'Formatted lines', cardWhat: `applies the formatting sheet to ${where}`,
    affected: () => [lines[0], lines[n - 1]], notes: skipNote,
    report: (m) => verify(m), verify,
  };
  function verify(m, dl = 0) {
    const miss = sheetLinesMiss(m, items.filter((x) => x.v), dl, [], model.named);
    for (const { l, ind } of items) {
      const now = ind && m.lines[l.line - 1 + dl];
      if (ind && (!now || !sameIndent(now, ind)) && !miss.includes(l.line + dl)) miss.push(l.line + dl);
    }
    miss.sort((x, y) => x - y);
    return miss.length ? `Note: Google Docs did not apply all of the formatting sheet; ${miss.length === 1 ? 'line' : 'lines'} ${lineList(miss)} still differ${miss.length === 1 ? 's' : ''}. Check them with read_document, include "formatting".` : '';
  }
}

// Lines format_lines cannot write with the values v: { error, short }, or null.
function formatLinesRefusal(lines, v) {
  for (const l of lines) {
    if (!l.exact) return { error: inexactLine(l.line, 'format the other lines, or tell the user to format it in Google Docs'), short: 'format_lines: unmappable line' };
    if (l.suggested) return { error: `line ${l.line} contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs)`, short: 'format_lines: the line has suggested changes' };
    if ((v.pageBreakBefore != null || v.box) && l.cell) return { error: `line ${l.line} is in a table cell: box and page_break_before work on lines outside tables; leave it out`, short: 'format_lines: box or page break in a table' };
  }
  const making = !!v.list && v.list !== 'none';
  const tabbed = making && lines.find((l) => l.text.startsWith('\t'));
  if (tabbed) {
    return { error: `line ${tabbed.line} starts with a tab, which Google Docs turns into list nesting and deletes. Remove the tab first with replace_text, or leave that line out.`, short: 'format_lines: a line starts with a tab' };
  }
  return null;
}

// The requests of a format_lines plan and their inverse (see planFormatLines) for lines (contiguous, checked) and
// the values v: { groups (the lines split at table cells and other breaks in index space), requests, inverse,
// groupInverse (inverse split per group, in document order), listsTouched }.
function formatLinesRequests(model, lines, v, sheet = { items: [], explicit: [] }) {
  const making = !!v.list && v.list !== 'none';
  const groups = [];
  lines.forEach((l, k) => { if (!k || isClosing(model, l.line - 2)) groups.push([l]); else groups[groups.length - 1].push(l); });
  const given = (f) => (f === 'namedStyleType' ? !!v.style : f === 'alignment' ? !!v.align : BOX_FIELDS.includes(f) ? !!v.box : v[f] != null);
  const isIndent = (f) => f === 'indentStart' || f === 'indentFirstLine';
  // Undo restores every touched field; a list write also moves the indents.
  const touched = PARA_FIELD_ORDER.filter((f) => given(f) || (!!v.list && isIndent(f)));
  // A line that has the style already gets no namedStyleType (restyle: Docs would clear its text styles), forward or back.
  const restyled = (l) => !!v.style && !sameNamedStyle(l.style, HEADING_STYLES[v.style]);
  const maskFor = (fields) => (l) => (restyled(l) ? fields : fields.filter((f) => f !== 'namedStyleType'));
  const forward = (l) => {
    const ps = {};
    if (restyled(l)) ps.namedStyleType = HEADING_STYLES[v.style];
    if (v.align) ps.alignment = alignToApi(v.align, (l.para || {}).direction);
    for (const [, f] of LINE_DIMS) if (v[f] != null && v[f] !== INHERIT) ps[f] = ptDimension(v[f]); // INHERIT: masked, no value
    if (v.lineSpacing != null) ps.lineSpacing = lineSpacingPercent(v.lineSpacing);
    if (v.pageBreakBefore != null) ps.pageBreakBefore = v.pageBreakBefore;
    if (v.box) Object.assign(ps, boxParagraphStyle(v.box).paragraphStyle);
    return ps;
  };
  const prior = (l) => {
    const p = l.para || {};
    const ps = {};
    for (const f of touched) {
      if (f === 'namedStyleType') { if (restyled(l)) ps.namedStyleType = l.style || 'NORMAL_TEXT'; } else Object.assign(ps, priorParaStyle(p, [f]));
    }
    return ps;
  };
  const requests = [];
  const inverse = [];
  const groupInverse = []; // per group (document order): its part of inverse
  let listsTouched = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const inv = groupInverse[gi] = [];
    const gs = g[0].start;
    const ge = g[g.length - 1].end + 1;
    const inList = g.some((l) => l.list);
    const unlisting = v.list === 'none' && inList;
    if (making) {
      if (inList) requests.push(reqBulletsOff(model, gs, ge));
      bulletRequests(model, gs, ge, g.map((l) => [l, l.list ? l.list.level : 0]), LIST_PRESETS[v.list], requests, listAnchor(model, g[0]));
    } else if (unlisting) requests.push(reqBulletsOff(model, gs, ge));
    // Docs leaves a removed list's indent on the lines: reset (to the named style's) what is not given.
    const fields = PARA_FIELD_ORDER.filter((f) => given(f) || (unlisting && isIndent(f)));
    if (fields.length) paraStyleRuns(model, g, forward, maskFor(fields), requests);
    if (making || unlisting) {
      listsTouched = true;
      if (making) inv.push(reqBulletsOff(model, gs, ge));
      // The former lists again: one run per stretch of consecutive lines of one listId.
      const runs = [];
      g.forEach((l, k) => {
        if (!l.list) return;
        const run = runs[runs.length - 1];
        if (run && run[run.length - 1] === g[k - 1] && g[k - 1].list.listId === l.list.listId) run.push(l); else runs.push([l]);
      });
      for (const run of runs.reverse()) {
        bulletRequests(model, run[0].start, run[run.length - 1].end + 1, run.map((l) => [l, l.list.level]), LIST_PRESETS[run[0].list.kind] || LIST_PRESETS.bullet, inv, listAnchor(model, run[0]));
      }
    }
    if (touched.length) paraStyleRuns(model, g, prior, maskFor(touched), inv);
    const sh = sheetLineRequests(model, sheet.items.filter((x) => g.includes(x.l)), sheet.explicit);
    requests.push(...sh.requests);
    inv.push(...sh.inverse);
    // The style change cleared the text styles that covered a whole line; undo writes the line's text styles back, last (a
    // font write of the sheet's inverse would drop a bold written before it).
    for (const l of g.filter((x) => restyled(x) && x.end > x.start)) inv.push(...inverseTextStyles(model, rangeRuns(model, { from: l.line, to: l.line, start: l.start, end: l.end }), NAMED_CLEARED_FIELDS));
    inverse.push(...inv);
  }
  return { groups, requests, inverse, groupInverse, listsTouched };
}

const LINE_NUMBER_TOOLS = ['insert_after_line', 'delete_lines', 'format_lines'];

// Executes replace_text / replace_all / replace_section / format_text / format_lines / insert_after_line / delete_lines /
// edit_document / undo_last_edit for the turn snapshot.
// A registered writing tool (registerTools) plans and commits through the same pieces: its plan on snap.model
// or a segment model, gateEdit, then commitEdit (one batch) or commitSequence + finishEdit (several).
// Returns the tool message fields (content for the model, "_" fields for the UI and the journal).
// snap.responseWrite: set by a successful write, reset by the tool loop for every model response; a
// later line-number write of the same response is refused (its numbers predate the edit).
// ui: the tool call's card holder, which a gate card takes over (see gateEdit).
// The refusal of a line-numbered call after a write in the same response (snap.responseWrite): its numbers predate
// that edit. Also used by runExtraTool for registered tools whose spec.usesLines says the call takes line numbers.
function lineDriftError(name, snap) {
  const w = snap.responseWrite;
  return writeError(`line numbers changed after the previous edit in this response (or the document was re-read because it changed), so this ${name} call was not applied; re-read with read_document and call it again with the current numbers.\nThe text around the previous edit now reads:\n${linesReport(snap.model, w.from - 2, w.to + 2)}\nThe document has ${snap.model.lines.length} lines.`,
    `${name}: line numbers changed by the previous edit; not applied`);
}
async function runWriteTool(name, args, snap, id, ui = {}) {
  return withDocWrite(writeDocId(snap), () => runWriteToolLocked(name, args, snap, id, ui));
}
async function runWriteToolLocked(name, args, snap, id, ui) {
  // An agent's write plans on the document as it is now: another edit may have landed since its snapshot.
  if (snap.agent && name !== 'undo_last_edit' && (await rereadForAgent(snap)) && usesLineNumbers(name, args)) return agentStaleError(name, snap);
  // The batch fields of earlier versions are gone from the schemas; a call that still sends one learns the way.
  const oldBatch = OLD_BATCH_FIELDS[name];
  if (oldBatch && args && batchGiven(args[oldBatch])) {
    return writeError(`${name} makes one edit; ${oldBatch} is not a parameter. For several edits at once call edit_document with operations [{"op": …}, …].`, `${name}: ${oldBatch} is not a parameter`);
  }
  if (usesLineNumbers(name, args) && snap.responseWrite) return lineDriftError(name, snap);
  if (name === 'undo_last_edit') return undoLastEditTool(snap);
  // The plans read the formatting sheet of the turn (DOC.md, MAIN.md, the default) from the model they plan on, and the
  // ones that compare existing lines with it the document's named styles (what a paragraph value it does not set inherits).
  // Suggest mode (DOC.md "Edits: suggest"): text changes go as suggestions; the plans then refuse only text inside one.
  const suggest = suggestOn(snap) ? suggestScope(name, args) : null;
  const model = { ...snap.model, sheet: styleSheetFor(snap), ...(suggest === 'suggest' ? { suggestMode: true } : {}) };
  if (comparesLines(name, args)) model.named = namedStyleValues((await turnNamedStyles(snap)) || {});
  const planIt = () => (name === 'replace_text' ? planReplaceText(model, args)
    : name === 'replace_all' ? planReplaceAll(model, args)
    : name === 'format_text' ? planFormat(model, args, snap)
    : name === 'format_lines' ? planFormatLines(model, args, snap)
    : name === 'replace_section' ? planReplaceSection(model, args)
    : name === 'edit_document' ? planEditDocument(model, args)
    : name === 'insert_after_line' ? planInsert(model, args) : planDelete(model, args));
  let plan = planIt();
  // format_text's "No change" or "Already done" shows the formatting: planned again once Normal text's font is known.
  if (plan.reply && (name === 'format_text' || name === 'edit_document') && (await knowUnmarkedFont(snap, false))) plan = planIt();
  if (plan.error) return writeError(plan.error, plan.short);
  if (plan.reply) return plan.reply; // nothing to send (format_text, format_lines: no change, already done)
  if (suggest === 'mixed') return writeError(SUGGEST_MIXED_ERROR, 'edit_document: suggestions and formatting in one call');
  if (suggest === 'suggest') plan.suggest = true;
  else if (suggest === 'direct') plan.notes = [...(plan.notes || []), SUGGEST_DIRECT_NOTE];
  // An in-text citation the References store tracks (references.js; [] when it is off): the edit card names it and, in
  // Manual, asks even after "Allow all in this turn"; Auto asks nothing and the write's row names it.
  if (plan.removed && plan.removed.length) {
    try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; }
  }
  // In Manual every write waits for Allow / Deny (gate.js gateEdit); a person mention asks in every mode (personGate).
  const refused = (await gateEdit(name, plan, snap, ui)) || (await personGate(name, plan, snap, ui));
  if (refused) return refused;
  // Docs stores no text value equal to the one the line's named style gives, so the re-read check counts such a value as
  // applied only with the named styles known: a check that finds a miss reads them (once per turn) and checks again
  // (finishEdit), so the note names only a real miss.
  if (!model.named && formatsText(name, args)) {
    plan.knowNamed = async () => {
      const raw = await turnNamedStyles(snap);
      if (raw) model.named = namedStyleValues(raw);
      return !!raw;
    };
  }
  const { _notSent, ...res } = await commitEdit(snap, plan, id);
  // Lines given a named style that colours its text (Docs greys Heading 3-6): the result names the colour once, when the
  // named styles are known in this turn (no read for it).
  const note = res._ok && res._edit ? styleColorNote(stylesGiven(plan), model.named || turnNamedKnown(snap)) : '';
  if (note) res.content += `\n${note}`;
  return res;
}
// The named styles a write gives lines (format_lines style on lines of another style, an insert's new lines; edit_document:
// its parts').
const stylesGiven = (plan) => (plan.ops || [plan]).flatMap((p) => p.styles || p.wants || []);

// ---- The document write lock ------------------------------------------------------------------------------
// Agents run in the background, so an agent and a turn (or two agents, or another tab) may write at the same time.
// Every write (plan, gate, batchUpdate and the verification re-read; the paste; an Undo click) runs under the Web Lock
// "munin:write:<docId>" (chats.js withLock: across tabs; without navigator.locks a queue in this panel). The frozen
// snapshots stay as they are: a write planned on an older read fails on its required revision and reports the current
// text, as before. Not re-entrant: only the outermost write path takes it (runWriteTool, replaceSelectionCall and the
// registered writing tools in turn.js, withOwnedChat in docs-undo.js).
const writeLockName = (docId) => 'munin:write:' + docId;
const writeDocId = (snap) => (snap && snap.model && snap.model.docId) || state.docId;
function withDocWrite(docId, fn) {
  return docId ? withLock(writeLockName(docId), fn) : fn();
}
// Inside the lock, before an agent plans a write: the document is read again, so the plan addresses the text as it is
// now. Returns true when the document changed since the agent's last read (its line numbers are stale).
async function rereadForAgent(snap) {
  if (!snap.model || !snap.model.docId) return false;
  const before = snap.model.revisionId;
  try {
    const now = await refreshSnapModel(snap);
    return !!before && now.revisionId !== before;
  } catch (e) {
    return false; // the write itself reports what is wrong
  }
}
const agentStaleError = (name, snap) => writeError(`the document changed since you last read it (another edit landed while you worked), so this ${name} call was not applied; re-read with read_document and call it again with the current numbers. The document has ${snap.model.lines.length} lines.`,
  `${name}: the document changed meanwhile; not applied`);

// Plan of a replace_selection through the API: only when the selection occurs exactly once in the
// text, or its surroundings in Docs (state.selectionCtx, request.js pickByContext) clearly point to one of its
// occurrences; null means it is pasted instead.
function planApiSelection(text, snap) {
  const sel = String(state.selection || '').replace(/\n+$/, '');
  const newText = modelInsertText(text);
  if (!sel || newText.includes(OBJECT_CHAR)) return null;
  const hits = findFlexible(snap.model.text, sel);
  const hit = hits.length === 1 ? hits[0] : selectionHitByContext(snap.model.text, hits);
  if (!hit || hit.text === newText) return null; // the same text: nothing to send (pasted)
  const suggest = suggestOn(snap);
  const plan = replacePlan(suggest ? { ...snap.model, suggestMode: true } : snap.model, hit.at, hit.text, newText, !!hit.normalized);
  if (plan.error) return null;
  return { ...plan, title: `Replaced the selection (${rangeLabel(plan.from, plan.to)})`, cardText: showText(newText), cardLabel: 'Inserted text', ...(suggest ? { suggest: true } : {}) };
}
// Of several occurrences of the selection in the model text, the one its surroundings in Docs point to, or null.
function selectionHitByContext(text, hits) {
  const ctx = selectionContextOf(state.selection, state.selectionCtx);
  if (!ctx || hits.length < 2) return null;
  const c = pickByContext(text, hits.map((h, i) => ({ group: i, from: h.at, to: h.at + h.text.length, hit: h })), ctx, 'docs-api');
  return c ? c.hit : null;
}

// Applies a planApiSelection plan. Returns null to fall back to pasting: only when nothing was sent or
// the edit certainly did not happen; any other failure (the document changed meanwhile, an unclear
// network failure) is reported instead.
async function apiReplaceSelection(plan, snap, id) {
  const { _notSent, ...res } = await commitEdit(snap, plan, id);
  if (!res._ok) return _notSent ? null : res;
  state.selection = '';
  snap.selection = '';
  renderSelection();
  return res;
}

// ---- Suggest mode (experiment) ------------------------------------------------------------------------------------
// A DOC.md line "Edits: suggest" (suggestPreference; the last "Edits:" line wins, "Edits: direct" turns it off) writes the
// text changes of replace_text, replace_all, insert_after_line, delete_lines, replace_section, the replace / insert /
// delete operations of edit_document and replace_selection through the API as suggested changes:
// writeControl.writeMode SUGGEST, which applies every request of the batch as a suggestion. Formatting (format_text,
// format_lines, edit_document with formatting operations only) stays a direct write, and its result says so; an
// edit_document that mixes both is refused (one batch has one write mode). Tables, page parts, named styles, comments and
// footnotes are other modules' writes and never get the mode, and neither does a batch holding a request Google refuses
// in suggest mode (SUGGEST_REFUSED_REQUESTS: checked before sending). A suggested deletion leaves its text in the
// document (marked, indices unchanged), so the plans' requests address the same places as for a direct edit (the
// deletion first, the insertion at its start: the new text goes before the deleted one). The write is verified by
// suggestion ids, not text: the re-read document must carry ids that the pre-write model did not, on inserted text as
// long as what was inserted and on deleted text as long as what was deleted. The journal entry (kind 'suggest') holds
// the ids; undo removes them with deleteSuggestion (docs-undo.js). Unverified (real Chrome): whether writeMode combines
// with requiredRevisionId (a 400 naming the write control retries once without it, after a revision check, and the
// session remembers: suggestState), whether the reply's suggestionResponses carry the new ids, how Docs groups the ids.
const SUGGEST_LINE_RE = /^\s*(?:[-*•]\s*)?edits\s*:\s*(suggest\w*|direct\w*)/i;
function suggestPreference(text) {
  let on = false;
  for (const l of String(text == null ? '' : text).split('\n')) {
    const m = SUGGEST_LINE_RE.exec(l);
    if (m) on = /^suggest/i.test(m[1]);
  }
  return on;
}
// Suggest mode applies to this snapshot: the Docs API model and the preference in its DOC.md.
const suggestOn = (snap) => !!snap && snap.docFormat === 'docs-api' && !!snap.model
  && suggestPreference(snap.docInstructions != null ? snap.docInstructions : state.docInstructions);
const SUGGEST_TOOLS = ['replace_text', 'replace_all', 'insert_after_line', 'delete_lines', 'replace_section'];
const SUGGEST_OPS = ['replace', 'insert', 'delete'];
// How a write goes in suggest mode: 'suggest', 'direct' (formatting) or 'mixed' (edit_document with both kinds).
function suggestScope(name, args) {
  if (SUGGEST_TOOLS.includes(name)) return 'suggest';
  if (name !== 'edit_document') return 'direct';
  const ops = (batchList(args && args.operations) || []).map((e) => String((e && e.op) || '').trim().toLowerCase());
  const text = ops.filter((o) => SUGGEST_OPS.includes(o)).length;
  return !text ? 'direct' : text === ops.length ? 'suggest' : 'mixed';
}
const SUGGEST_DIRECT_NOTE = 'Note: formatting is applied directly, not as a suggestion ("Edits: suggest" covers text changes only).';
const SUGGEST_MIXED_ERROR = 'edits are written as suggestions in this document (DOC.md "Edits: suggest"), and formatting is written directly, so one edit_document call cannot hold both. Call edit_document once with the replace, insert and delete operations and once with the formatting operations';
const SUGGEST_UNDO_ADVICE = 'reject the suggestion in Google Docs or with the comment tool';
// The refusal of a write into a suggested change (indexRange in docs-model.js, the insert and delete plans).
const suggestOverlapError = (n) => `line ${n} has a suggested change at that place, which cannot be edited until it is accepted or rejected: accept or reject it with the comment tool (its id from read_document include ["comments"]) or in Google Docs, or edit text outside the suggested change`;
// Whether text offsets [a, b) of line l (b up to l.text.length + 1: its newline) touch a suggested change: any part of a
// line with suggestions outside suggest mode, or one without the ids recorded.
const touchesSuggestion = (model, l, a = 0, b = l.text.length + 1) => !!l.suggested && (!model.suggestMode || !l.sugg || l.sugg.some((x) => x.s < b && a < x.e));
// An insertion point p (offset in line l) at or inside a suggested change.
const pointInSuggestion = (model, l, p) => !!l.suggested && (!model.suggestMode || !l.sugg || l.sugg.some((x) => x.s <= p && p < x.e));

// The requests Google refuses in suggest mode (the suggestions how-to), and updateDocumentStyle fields it refuses.
const SUGGEST_REFUSED_REQUESTS = ['addDocumentTab', 'createNamedRange', 'deleteFooter', 'deleteHeader', 'deleteNamedRange', 'deleteTab',
  'updateDocumentTabProperties', 'updateTableColumnProperties'];
const SUGGEST_REFUSED_STYLE_RE = /documentFormat|useEvenPageHeaderFooter|useFirstPageHeaderFooter/;
// The first request of requests that suggest mode refuses (its name), or ''.
function refusedInSuggest(requests) {
  for (const r of requests || []) {
    const k = Object.keys(r || {})[0] || '';
    if (SUGGEST_REFUSED_REQUESTS.includes(k)) return k;
    if (k === 'updateDocumentStyle' && SUGGEST_REFUSED_STYLE_RE.test(String(r.updateDocumentStyle.fields || ''))) return k;
  }
  return '';
}
// noRevision: Google refused writeMode together with requiredRevisionId once in this session.
const suggestState = { noRevision: false };
const WRITE_CONTROL_RE = /write_?control|write_?mode|required_?revision/i;
// documents.batchUpdate with writeMode SUGGEST and requiredRevisionId. A 400 naming the write control on a document whose
// revision is still the model's (so not a stale read) means the combination is refused: sent once more without the
// revision, as every later suggestion of the session is, each after a revision check instead.
async function suggestBatchUpdate(model, requests) {
  const bad = refusedInSuggest(requests);
  if (bad) { const e = new Error(`${bad} cannot be written as a suggestion; nothing was sent.`); e.preSend = true; throw e; }
  const send = (rev) => docsApi(`${encodeURIComponent(model.docId)}:batchUpdate`, { method: 'POST',
    body: { requests, writeControl: { writeMode: 'SUGGEST', ...(rev ? { requiredRevisionId: model.revisionId } : {}) } } });
  if (!model.revisionId) return send(false);
  if (suggestState.noRevision) {
    await sameRevision(model);
    return send(false);
  }
  try { return await send(true); } catch (e) {
    if (e.status !== 400 || !WRITE_CONTROL_RE.test(`${e.serverMessage || ''} ${e.message || ''}`)) throw e;
    await sameRevision(model, e);
    suggestState.noRevision = true;
    try { return await send(false); } catch (e2) { e2.suggestRefused = true; throw e2; }
  }
}
// Throws when the document's revision is no longer the model's (a 400 like a stale requiredRevisionId), or err (or a
// preSend error) when it cannot be read.
async function sameRevision(model, err = null) {
  let rev;
  try { rev = await fetchDocRevision(model.docId); } catch (e) {
    if (err) throw err;
    e.preSend = true;
    throw e;
  }
  if (rev !== model.revisionId) {
    if (err) throw err;
    const e = new Error('the document changed after it was read.');
    e.status = 400;
    throw e;
  }
}

// The suggested changes of a body model: [{ line, s, e (API indices), text (the newline as "\n"), ins, del }].
function suggestionSpans(model) {
  const out = [];
  for (const l of (model && model.lines) || []) {
    for (const x of l.sugg || []) out.push({ line: l.line, s: l.start + x.s, e: l.start + x.e, text: (l.text + '\n').slice(x.s, x.e), ins: x.ins, del: x.del });
  }
  return out;
}
const spanIds = (spans) => new Set(spans.flatMap((x) => [...x.ins, ...x.del]));
// The created ids of a batchUpdate reply (suggestionResponses[].createdSuggestionIds), in order, unique.
// Only the text requests' (requests: the batch's, in the reply's order): a style request makes a suggested style change of
// its own, which the document's text does not show (real-docs.js fact 8m).
const SUGGESTED_TEXT_KINDS = ['insertText', 'deleteContentRange', 'insertPerson', 'insertRichLink', 'insertDate'];
const createdIds = (res, requests = []) => [...new Set(((res && res.suggestionResponses) || [])
  .flatMap((r, i) => (r && (!requests[i] || SUGGESTED_TEXT_KINDS.includes(Object.keys(requests[i])[0])) && r.createdSuggestionIds) || []))];
// What the requests should leave as suggestions: { ins, del }: [{ text (null: not plain line text), len }] inserted and
// deleted (a chip counts as "￼").
function suggestExpect(model, requests) {
  const ins = [];
  const del = [];
  for (const r of requests) {
    if (r.insertText) ins.push({ text: r.insertText.text, len: r.insertText.text.length });
    else if (r.insertPerson || r.insertRichLink || r.insertDate) ins.push({ text: OBJECT_CHAR, len: 1 });
    else if (r.deleteContentRange) {
      const { startIndex: s, endIndex: e } = r.deleteContentRange.range;
      del.push({ text: textAtIndexRange(model, s, e), len: e - s });
    }
  }
  return { ins, del };
}
// A note when the new suggestions do not read like the requests ('' when they do): the same total length per kind, and
// every inserted or deleted piece found in the suggested text of its kind.
function suggestMismatch(want, spans) {
  const out = [];
  for (const [kind, label] of [['ins', 'insertion'], ['del', 'deletion']]) {
    const got = spans.filter((x) => x[kind].length).map((x) => x.text).join('');
    const sent = want[kind].map((x) => x.text || '').join('');
    const fits = got.length === want[kind].reduce((n, x) => n + x.len, 0) && want[kind].every((x) => x.text == null || got.includes(x.text));
    if (!fits) out.push(`the suggested ${label} reads ${clipQuote(got)} where the edit ${kind === 'ins' ? 'inserts' : 'deletes'} ${clipQuote(sent)}`);
  }
  return out.length ? `Note: Google Docs stored the suggestion differently: ${out.join('; ')}.` : '';
}
// "replace «a» with «b»", "insert «b»", "delete lines 4-5": what a journal entry suggests.
const SUGGEST_QUOTE_CHARS = 80;
function suggestWhat(j, region) {
  const q = (t) => `«${oneLine(showText(String(t || '').replace(/\n+$/, '').replace(/^\n+/, '')), SUGGEST_QUOTE_CHARS)}»`;
  if (j.kind === 'multi') return (j.parts || []).map((p) => suggestWhat(p, null)).join('; ');
  if (j.kind === 'replace-all') return `replace ${j.count} × «${oneLine(j.replace, 40)}» with «${oneLine(j.find, 40)}»`;
  if (j.kind === 'delete') return region ? `delete ${rangeLabel(region[0], region[1])}` : `delete ${q(j.restore)}`;
  if (!j.restore) return `insert ${q(j.text)}`;
  if (!j.text) return `delete ${q(j.restore)}`;
  return `replace ${q(j.restore)} with ${q(j.text)}`;
}
// A line's text with the given suggestions marked: [-deleted-] and [+inserted+] ("¶" for a newline in one).
function markSuggestions(l, ids) {
  const text = l.text + '\n';
  const marks = (l.sugg || []).map((x) => ({ ...x, kind: x.del.some((i) => ids.has(i)) ? 'del' : x.ins.some((i) => ids.has(i)) ? 'ins' : '' }))
    .filter((x) => x.kind).sort((a, b) => a.s - b.s);
  let out = '';
  let at = 0;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    let e = m.e;
    while (i + 1 < marks.length && marks[i + 1].kind === m.kind && marks[i + 1].s === e) e = marks[++i].e;
    const [open, close] = m.kind === 'del' ? ['[-', '-]'] : ['[+', '+]'];
    out += text.slice(at, m.s) + open + text.slice(m.s, e).replace(/\n/g, '¶') + close;
    at = e;
  }
  return showText(out + text.slice(at, l.text.length));
}

// commitEdit for plan.suggest: the suggested batch, the re-read and the check by suggestion ids. A failure is reported
// like a direct edit's (batchFailure), except that an unclear network failure is never taken as applied by its text.
async function commitSuggestion(snap, plan, id) {
  const before = snap.model;
  let res;
  try {
    writePhase(snap, 'writing');
    res = await suggestBatchUpdate(before, plan.requests);
  } catch (e) {
    const r = await batchFailure(snap, { ...plan, journal: { ...plan.journal, text: '' } }, id, e);
    if (e.suggestRefused) r.content += '\nGoogle Docs refused the edit as a suggestion (DOC.md "Edits: suggest"). Tell the user; removing that line from DOC.md writes edits directly.';
    return r;
  }
  return finishSuggestion(snap, plan, id, before, res);
}
async function finishSuggestion(snap, plan, id, before, res) {
  const title = `${plan.title} (suggested)`;
  const entry = (ids, lines) => ({ id, docId: before.docId, tabId: before.tabId, kind: 'suggest', ids, title, undone: false, anchor: false, lines,
    ...(ids.length ? {} : { undoable: false }) });
  const notes = (plan.notes || []).map((n) => '\n' + n).join('');
  const done = (content, ids, lines) => ({ content, _ok: true, _message: title, _edit: entry(ids, lines), _cardText: plan.cardText, _cardLabel: plan.cardLabel });
  const what = suggestWhat(plan.journal, plan.region);
  const replied = createdIds(res, plan.requests);
  let model;
  try {
    writePhase(snap, 'verifying');
    model = await refreshSnapModel(snap);
  } catch (e) {
    snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
    return done(`Done: suggested: ${what}.\nThe document could not be read again (${errorClause(e)}), so the suggestion is not verified; read it again before the next edit.${replied.length ? '' : ` It cannot be undone from the panel: ${SUGGEST_UNDO_ADVICE}.`}${notes}`, replied, plan.region);
  }
  const old = spanIds(suggestionSpans(before));
  // Google merges a suggested change next to an earlier one of the same author into it (the reply's
  // updatedSummarySuggestionIds; real-docs.js fact 8s): that earlier id now holds this edit too.
  const merged = mergedSuggestions(suggestionSpans(before), suggestionSpans(model), old, res);
  const mine = (i) => !old.has(i) || merged.includes(i);
  const spans = suggestionSpans(model).map((x) => ({ ...x, ins: x.ins.filter(mine), del: x.del.filter(mine) }))
    .filter((x) => x.ins.length || x.del.length);
  const found = spanIds(spans);
  const ids = [...new Set([...replied.filter((i) => found.has(i)), ...found])]; // the reply's order (the requests') first
  if (!spans.length) {
    // Google wrote the edit directly (writeMode ignored): it is a direct edit, journaled and undone like one.
    const j = plan.journal;
    const checkable = typeof plan.expectText === 'string' || (['replace', 'insert', 'delete'].includes(j.kind) && typeof j.index === 'number');
    if (model.revisionId !== before.revisionId && checkable && !bodyTextNote(before, model, j, plan.expectText)) {
      const direct = await finishEdit(snap, { ...plan, notes: [...(plan.notes || []), 'Note: Google Docs applied this edit directly, not as a suggestion; tell the user.'] }, id, model);
      return direct;
    }
    snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
    return done(`Done: sent as a suggestion (${what}), but the document read again shows no new suggested change, so it is not verified and cannot be undone from the panel (${SUGGEST_UNDO_ADVICE} if it is there).${regionNote(model, plan.region[0], plan.region[1])}${notes}`, [], plan.region);
  }
  const from = Math.min(...spans.map((x) => x.line));
  const to = Math.max(...spans.map((x) => x.line));
  snap.responseWrite = { from, to };
  const idSet = new Set(ids);
  const report = linesReport(model, from, to, (l) => markSuggestions(l, idSet));
  // A merged id also holds the earlier change, so its text is not this edit's alone: no length check, and no undo (deleting
  // the suggestion would withdraw the earlier change too).
  const check = merged.length ? '' : suggestMismatch(suggestExpect(before, plan.requests), spans);
  const missing = replied.filter((i) => !idSet.has(i));
  const mergeNote = merged.length ? `\n${SUGGEST_MERGED_NOTE(merged)}` : '';
  const res2 = done(`Done: suggested: ${what}; the lines now read (the deletion still visible; [-…-] is suggested for deletion, [+…+] for insertion):\n${report}\nThe document has ${model.lines.length} lines. Suggestion ${ids.join(', ')}: a co-author accepts or rejects it.`
    + `${check ? '\n' + check : ''}${missing.length ? `\nNote: the reply named suggestion ${missing.join(', ')}, which the document does not show.` : ''}${mergeNote}${notes}`, merged.length ? [] : ids, [from, to]);
  if (merged.length) res2._edit.merged = merged;
  return res2;
}
const SUGGEST_MERGED_NOTE = (ids) => `Note: Google Docs merged this edit into the earlier suggestion ${ids.join(', ')} next to it, so the panel cannot undo it on its own.`;
// The earlier suggestions (ids in old) that a suggested batch merged into: named in the reply's updatedSummarySuggestionIds,
// or holding other text than before. before, after: suggestionSpans of the document before and after the batch.
function mergedSuggestions(before, after, old, res) {
  const textOf = (spans, id) => spans.filter((x) => x.ins.includes(id) || x.del.includes(id)).map((x) => `${x.ins.includes(id) ? '+' : '-'}${x.text}`).join('|');
  const named = ((res && res.suggestionResponses) || []).flatMap((r) => (r && r.updatedSummarySuggestionIds) || []);
  const grown = [...old].filter((id) => textOf(before, id) !== textOf(after, id) && textOf(after, id));
  return [...new Set([...named.filter((i) => old.has(i)), ...grown])];
}

// The document block of the turn context names the mode.
registerTurnHook('beforeTurn', (mode, snap) => (snap && apiEditing(mode, snap) && suggestOn(snap)
  ? '[Edits are written as suggestions (DOC.md "Edits: suggest"): text changes become suggested changes that co-authors accept or reject; formatting, tables and the other parts are written directly.]' : ''));
