'use strict';
// Module docs-write.js: writing through documents.batchUpdate: request builders, edit plans
// (planReplaceText, planReplaceAll, planReplaceSection, planInsert, planDelete, planFormat, planFormatLines), commitEdit, runWriteTool and the
// replace_selection path through the API (planApiSelection, apiReplaceSelection).
/* global ambiguousError, ANCHOR_CHARS, apiColor, capFirst, changedLinesReport, citationsInRanges, commonEdges, disjointHits, docsApi, fetchDocModel,
   findFlexible, FORMAT_KEYS, formatNote, gateEdit, hitLines, indexRange, isClosing, knownFont, lineAtIndex, lineList,
   linesReport, markedText, MARKERS_NOTE, FOLDED_NOTE, NORMALIZED_NOTE, notFoundError, numText, OBJECT_CHAR, oneLine, parseColor,
   parsePt, parseSize, ptDimension, rangeLabel, regionNote, renderSelection, showText, SOFT_BREAK_MARK, state, stripMarkers,
   TEXT_STYLE_API_FIELDS, textAtIndexRange, undoLastEditTool, useDocModel */
/* exported reqDelete, reqInsert, reqStyle, sanitizeInsertText, docsBatchUpdate, setSnapModel, anchorMatches,
   writeError, formatArgsText, formatLinesArgsText, runWriteTool, planApiSelection, apiReplaceSelection,
   reqLocation, reqRange, reqEndOfSegment, reqTextStyle, reqParaStyle, reqBulletsOn, reqBulletsOff, modelInsertText,
   commitSequence, finishEdit, findOldText, replacePlan, makeAnchor, multiJournal */
/* global segmentModel */

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
const linkNote = (links) => `Note: the replaced text contained a link (${links.join(', ')}); it was removed and cannot be restored by format_text.`;

// Applies a planned edit: batchUpdate, journal entry (_edit, its inverse for undo), re-read, report.
// plan: { requests, journal: {kind, index, text, restore, paras, segmentId?}, title, cardText, cardLabel,
//         region: [from, to] (lines before the edit), affected(model) -> [from, to] (lines after it),
//         optional done (result sentence instead of the title), report(model) (instead of linesReport),
//         removed ([[start, end)] text offsets the edit deletes; runWriteTool checks them for citations) }
// Any failure re-reads the document and shows the current text of the region, so old line numbers are
// never implied to be valid. _notSent marks failures where certainly nothing changed (paste fallback).
async function commitEdit(snap, plan, id) {
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
  if (e.preSend) return { ...writeError(`the edit was not sent: ${e.message}`, 'Edit not sent'), _notSent: true };
  let now = null;
  try { now = await refreshSnapModel(snap); } catch (e2) { /* state unknown */ }
  const changed = !!now && now.revisionId !== before.revisionId;
  const [rf, rt] = plan.region;
  // The document changed (or its state is unknown): line numbers the model saw before this call are
  // stale for the rest of this response.
  if (changed || !now) snap.responseWrite = { from: rf, to: rt };
  if (e.network) {
    if (now && !changed) return { ...writeError(`${e.message} The edit was not applied.${regionNote(now, rf, rt)}`, 'Edit failed: network error'), _notSent: true };
    const j = plan.journal;
    const jm = now && segmentModel(now, j.segmentId);
    // Formatting leaves the text as it was, so the text cannot show whether it arrived.
    if (jm && j.text && j.kind !== 'format' && typeof j.index === 'number' && textAtIndexRange(jm, j.index, j.index + j.text.length) === j.text) return finishEdit(snap, plan, id, now);
    return writeError(`${e.message} The connection failed while the edit was being sent and it is unclear whether it was applied; check the text before editing again.${regionNote(now, rf, rt)}`, 'Edit failed: network error');
  }
  if (e.status === 400 && changed) {
    return writeError(`the document changed after it was read (you or a collaborator edited it), so the edit was not applied.${regionNote(now, rf, rt)}\nCheck the text and retry with the current line numbers.`, 'The document changed meanwhile; edit not applied');
  }
  return { ...writeError(`the Google Docs API rejected the edit: ${e.message}${regionNote(now, rf, rt)}`, 'Edit failed: ' + e.message), _notSent: e.status === 401 || e.status === 403 };
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
    return writeError(`the edit failed halfway (${e.message}): its first ${done.length === 1 ? 'part was' : `${done.length} parts were`} applied, and whether the rest arrived is unknown because the document could not be read again. The edit may be partly applied; check the document before editing again.`,
      'The edit may be partly applied; check the document');
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
    return writeError(`the edit failed halfway (${e.message}) and its first part was rolled back, so the document is as it was.${regionNote(now, plan.region[0], plan.region[1])}`, 'Edit failed and was rolled back: ' + e.message);
  } catch (e2) {
    let now = null;
    try { now = await refreshSnapModel(snap); } catch (e3) { /* state unknown */ }
    return writeError(`the edit failed halfway (${e.message}) and rolling back its first part failed too (${e2.message}): the document may hold part of the edit; check it before editing again.${regionNote(now, plan.region[0], plan.region[1])}`, 'Edit failed halfway: ' + e.message);
  }
}

// A journal entry made of parts, undone newest first (docs-undo.js undoMulti): each part is any journal entry
// (kind 'replace' / 'insert' / 'delete' with index, text, restore, paras; 'format'; 'requests' with its inverse
// requests; a registered kind), optionally with segmentId (a header, footer or footnote). finishEdit anchors
// every part on the document read after the whole edit, so a part whose context the later parts change sets
// anchor: false and is checked by its own registered kind instead. title: the card and journal title.
const multiJournal = (parts, extra = {}) => ({ kind: 'multi', parts, ...extra });

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

async function finishEdit(snap, plan, id, readModel) {
  const before = snap.model;
  const edit = { id, docId: before.docId, tabId: before.tabId, ...plan.journal, title: plan.title, undone: false, anchor: plan.journal.anchor === undefined ? null : plan.journal.anchor };
  let report;
  try {
    if (!readModel) writePhase(snap, 'verifying');
    const model = readModel || await refreshSnapModel(snap);
    anchorJournal(model, edit);
    const [from, to] = plan.affected(model);
    if (!plan.keepsLines) snap.responseWrite = { from, to }; // formatting moves no line: later line numbers stay valid
    report = `${plan.report ? plan.report(model) : linesReport(model, from, to)}\nThe document now has ${model.lines.length} lines.`;
  } catch (e) {
    snap.responseWrite = { from: plan.region[0], to: plan.region[1] };
    report = `The document could not be read again (${e.message}); the reading tools still show the text before this edit, so read it again before the next edit. This edit cannot be undone from the panel.`;
  }
  const notes = (plan.notes || []).map((n) => '\n' + n).join('');
  return {
    content: `Done: ${plan.done || plan.title.charAt(0).toLowerCase() + plan.title.slice(1)}.\n${report}${notes}`,
    _ok: true, _message: plan.title, _edit: edit, _cardText: plan.cardText, _cardLabel: plan.cardLabel,
  };
}

function writeError(text, short) {
  return { content: 'Error: ' + text, _ok: false, _message: short || capFirst(text.length > 160 ? text.slice(0, 160) + '…' : text) };
}

// Plan of a replacement of model.text[s, s + oldText.length) by newText (replace_text, replace_selection).
// Deleting and inserting across paragraph ends merges and splits paragraphs, and which style survives
// a merge is not specified by the API, so every resulting paragraph gets its style explicitly, in the
// same batch: the last one (new text after its last newline + the rest of the paragraph that contains
// the end of the range, which is the NEXT line when old_text ends with a newline) gets that
// paragraph's style; the first one (the head of the first line + new text before its first newline)
// gets the first line's style, unless both are empty and it is the surviving paragraph itself; the
// paragraphs in between are normal text. Undo restores the styles of all lines from the first line to
// the surviving one.
// Only the part that differs is replaced (commonEdges: the common prefix and suffix of the old and new
// text stay in the document with their formatting, links and comments); the paragraph rules above apply
// to that middle part, which may be empty on one side (a pure insertion or deletion). The journal records
// exactly the middle, so undo reverts exactly that. from/to: the lines of the whole match (the title);
// mid: the replaced middle { oldText, newText }; notes: result notes (a link inside the deleted part).
// loose: oldText was found by normalized matching (see editEdges).
function replacePlan(model, s, oldText, newText, loose = false) {
  const r = indexRange(model, s, s + oldText.length);
  if (r.error) return { error: r.error };
  // Inside a checked range, text offsets and API indices advance together.
  const { p, q } = editEdges(oldText, newText, loose);
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
  if (multi) {
    const headEmpty = S === firstLine.start;
    if (!nls.length) {
      const style = headEmpty && !newMid ? lastLine.style : firstLine.style;
      if (style) requests.push(reqStyle(model, S, S + 1, style));
    } else {
      if (firstLine.style) requests.push(reqStyle(model, S, S + 1, firstLine.style));
      nls.forEach((nl, k) => {
        const style = k === nls.length - 1 ? lastLine.style : 'NORMAL_TEXT';
        if (style) requests.push(reqStyle(model, S + nl + 1, S + nl + 2, style));
      });
    }
  }
  const paras = multi ? paraStyles(model, firstLine.line, Math.max(toLine, lastLine.line), -1) : [];
  const links = linksInRange(model, S, E);
  const notes = links.length ? [linkNote(links)] : [];
  return {
    requests, from: r.from, to: r.to, region: [r.from, r.to], mid: { oldText: oldMid, newText: newMid }, notes,
    removed: [[s + p, s + oldText.length - q]],
    journal: { kind: 'replace', index: S, text: newMid, restore: oldMid, paras, ...(model.segmentId ? { segmentId: model.segmentId } : {}) },
    affected: (m) => {
      const a = lineAtIndex(m, r.start) || lineAtIndex(m, r.start - 1);
      const b = lineAtIndex(m, r.start + Math.max(newText.length - 1, 0)) || a;
      return a ? [a.line, Math.max(a.line, b.line)] : [r.from, r.from];
    },
  };
}

// Hits of old_text; when there are none, of old_text without markdown markers and wrapping quotes
// (stripMarkers), so "**lazy dog**" or "'lazy dog'" still finds lazy dog. stripped: the second search was used.
function findOldText(model, oldText) {
  const hits = findFlexible(model.text, oldText);
  const plain = hits.length ? null : stripMarkers(oldText);
  const alt = plain ? findFlexible(model.text, plain) : [];
  return alt.length ? { hits: alt, oldText: plain, stripped: true } : { hits, oldText, stripped: false };
}

// replace_text({old_text, new_text})
function planReplaceText(model, args) {
  if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') return { error: 'invalid arguments. Expected {"old_text": string, "new_text": string}', short: 'Invalid tool arguments' };
  const given = args.old_text.replace(/\r\n?/g, '\n');
  if (!given) return { error: 'old_text is empty. To add text use insert_after_line', short: 'replace_text: old_text is empty' };
  const { hits, oldText, stripped } = findOldText(model, given);
  // The same markers or quotes around new_text would be written into the document literally.
  const newText = modelInsertText(stripped ? stripMarkers(args.new_text) || args.new_text : args.new_text);
  const objectError = { error: `the text contains an embedded object (shown as "${OBJECT_CHAR}": an image, chip or break), which replace_text cannot re-create. Edit only the text before or after it`, short: 'replace_text: the text contains an embedded object' };
  if (newText.split(OBJECT_CHAR).length > oldText.split(OBJECT_CHAR).length) return objectError;
  if (!hits.length) {
    return { error: notFoundError(model, oldText, NOT_FOUND_ADVICE), short: 'replace_text: the text was not found' };
  }
  if (hits.length > 1) {
    return { error: ambiguousError(model, hits), short: `replace_text: the text occurs ${hits.length} times` };
  }
  if (hits[0].text === newText) return { error: 'new_text is the same as old_text; nothing to change', short: 'replace_text: nothing to change' };
  const plan = replacePlan(model, hits[0].at, hits[0].text, newText, !!hits[0].normalized);
  if (plan.error) return { error: plan.error, short: 'replace_text: ' + plan.error };
  // An embedded object may stay in the unchanged prefix or suffix, but not in the replaced part.
  if (plan.mid.oldText.includes(OBJECT_CHAR) || plan.mid.newText.includes(OBJECT_CHAR)) return objectError;
  const notes = [...(stripped ? [MARKERS_NOTE] : []), ...(hits[0].normalized ? [hits[0].folded ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...plan.notes];
  return { ...plan, notes, title: `Replaced ${rangeLabel(plan.from, plan.to)}`, cardText: showText(newText), cardLabel: newText ? 'New text' : '' };
}

// The last sentence of a "not found" error (notFoundError).
const NOT_FOUND_ADVICE = 'old_text must match the document text (without the "N: " line-number prefixes); read the exact text with read_lines or find_in_document and try again';

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
  if (newText === oldText || !hits.length) return { error: 'new_text is the same as old_text; nothing to change', short: 'replace_all: nothing to change' };
  const lines = hitLines(model, hits);
  const sugg = lines.filter((n) => model.lines[n - 1].suggested);
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
  for (let i = ranges.length - 1; i >= 0; i--) {
    const t = hits[i].text;
    const { p, q } = commonEdges(t, newText); // exact edges: every occurrence must read new_text afterwards (undo finds it)
    const S = ranges[i].start + p;
    const E = ranges[i].end - q;
    const mid = newText.slice(p, newText.length - q);
    if (E > S) requests.push(reqDelete(model, S, E));
    if (mid) requests.push(reqInsert(model, S, mid));
    for (const u of linksInRange(model, S, E)) if (!links.includes(u)) links.push(u);
    removed.unshift([hits[i].at + p, hits[i].at + t.length - q]);
  }
  const n = hits.length;
  const [from, to] = [lines[0], lines[lines.length - 1]];
  // replace: the original text of the occurrences (replaces: per occurrence, when they differ).
  const texts = hits.map((h) => h.text);
  const same = texts.every((t) => t === texts[0]);
  const notes = [...(hits.some((h) => h.normalized) ? [hits.some((h) => h.folded) ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...(links.length ? [linkNote(links.slice().reverse())] : [])];
  return {
    requests, region: [from, to], notes, removed,
    journal: { kind: 'replace-all', index: ranges[0].start, text: '', restore: texts[0], paras: [], find: newText, replace: texts[0], ...(same ? {} : { replaces: texts }), count: n },
    title: `Replaced ${n} × "${oneLine(oldText, 40)}"`,
    done: `replaced ${n} occurrence${n === 1 ? '' : 's'} on ${lines.length === 1 ? 'line' : 'lines'} ${lineList(lines)}`,
    cardText: showText(newText), cardLabel: newText ? 'New text' : '',
    affected: () => [from, to],
    report: (m) => changedLinesReport(m, lines),
  };
}

// insert_after_line({line, text}). After line N the text goes in as "\n" + text at N's newline, so
// the new paragraphs take N's paragraph style (a heading's style is reset to normal text); line 0
// inserts text + "\n" at the start of line 1. Trailing newlines of text are dropped (no empty paragraph).
function planInsert(model, args) {
  const total = model.lines.length;
  const n = Number(args.line);
  const text = modelInsertText(args.text).replace(/\n+$/, '');
  if (!Number.isInteger(n) || n < 0 || n > total) return { error: `line must be an integer from 0 to ${total}`, short: 'insert_after_line: invalid line' };
  if (!text) return { error: 'text is empty', short: 'insert_after_line: empty text' };
  if (text.includes(OBJECT_CHAR)) return { error: `text must not contain "${OBJECT_CHAR}"`, short: 'insert_after_line: invalid text' };
  if (!total) return { error: 'the document has no lines to insert next to', short: 'insert_after_line: empty document' };
  const anchor = n === 0 ? model.lines[0] : model.lines[n - 1];
  if (anchor.suggested) return { error: `line ${anchor.line} contains suggested changes (suggesting mode); accept or reject them in Google Docs first, or insert elsewhere`, short: 'insert_after_line: the line has suggested changes' };
  if (!anchor.exact) return { error: `the positions in line ${anchor.line} cannot be mapped exactly`, short: 'insert_after_line: unmappable line' };
  const at = n === 0 ? anchor.start : anchor.end;
  const ins = n === 0 ? text + '\n' : '\n' + text;
  const newStart = n === 0 ? at : at + 1;
  const requests = [reqInsert(model, at, ins)];
  if (anchor.heading) requests.push(reqStyle(model, newStart, newStart + text.length, 'NORMAL_TEXT'));
  const count = text.split('\n').length;
  return {
    requests, region: [Math.max(1, n), Math.max(1, n)],
    journal: { kind: 'insert', index: at, text: ins, restore: '', paras: [{ nl: -1, style: anchor.style || '' }] },
    title: n === 0 ? 'Inserted at the beginning' : `Inserted after line ${n}`,
    cardText: showText(text), cardLabel: 'Inserted text',
    affected: () => [n + 1, n + count],
  };
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
    if (!l.exact) return { error: `the positions in line ${i} cannot be mapped exactly`, short: 'delete_lines: unmappable line' };
    if (l.suggested) return { error: `line ${i} contains suggested changes (suggesting mode); accept or reject them in Google Docs first`, short: 'delete_lines: the line has suggested changes' };
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
    if (!prev.exact) return { error: `deleting ${rangeLabel(a, b)} also removes the end of line ${a - 1}, whose positions cannot be mapped exactly`, short: 'delete_lines: unmappable line' };
    if (prev.suggested) return { error: `deleting ${rangeLabel(a, b)} also removes the end of line ${a - 1}, which contains suggested changes (suggesting mode); accept or reject them in Google Docs first`, short: 'delete_lines: the line has suggested changes' };
    S = prev.end; E = last.end; restore = '\n' + joined;
    paras = [{ nl: -1, style: prev.style || '' }, ...paraStyles(model, a, b, 0)];
    requests.push(reqDelete(model, S, E));
    if (prev.style) requests.push(reqStyle(model, prev.start, prev.start + 1, prev.style)); // keep its style after the merge
  } else {
    S = first.start; E = last.end; restore = joined;
    if (S === E) return { error: `line ${a} is empty and is the last paragraph of its part of the document (a table cell or the document), so it cannot be removed`, short: 'delete_lines: nothing to delete' };
    paras = paraStyles(model, a, b, -1);
    requests.push(reqDelete(model, S, E));
  }
  return {
    requests, region: [a, b], removed: [[first.off, last.off + last.text.length]],
    journal: { kind: 'delete', index: S, text: '', restore, paras },
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
  if (!want) return { error: 'heading is empty. Pass the heading text as get_outline shows it', short: 'replace_section: heading is empty' };
  const heads = model.lines.filter((l) => l.heading && !l.cell && l.text.trim());
  if (!heads.length) return { error: 'the document has no headings, so there is no section to replace. Use replace_text', short: 'replace_section: no headings' };
  const found = heads.filter((l) => headingKey(l.text) === want);
  const quoted = (l) => `"${oneLine(l.text.trim(), 80)}" (line ${l.line})`;
  if (!found.length) {
    const words = want.split(' ');
    const score = (l) => { const k = headingKey(l.text); return (k.includes(want) || want.includes(k) ? 100 : 0) + words.filter((w) => k.split(' ').includes(w)).length; };
    const near = heads.map((l) => ({ l, s: score(l) })).sort((x, y) => y.s - x.s || x.l.line - y.l.line).slice(0, SECTION_CLOSEST_MAX);
    return { error: `no heading reads "${oneLine(args.heading, 80)}". Closest headings: ${near.map((x) => quoted(x.l)).join(', ')}. Pass the heading text exactly as get_outline shows it (case does not matter)`, short: 'replace_section: heading not found' };
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
  const newText = modelInsertText(args.new_text).replace(/\n+$/, '');
  const objectError = { error: `the section «${name}» contains an embedded object (shown as "${OBJECT_CHAR}": an image, chip, footnote or break), which replace_section cannot re-create. Edit the text before or after it with replace_text`, short: 'replace_section: the section contains an embedded object' };
  if (newText.includes(OBJECT_CHAR)) return { error: `new_text must not contain "${OBJECT_CHAR}"`, short: 'replace_section: invalid new_text' };
  const oldBody = body.length ? model.text.slice(body[0].off, body[body.length - 1].off + body[body.length - 1].text.length) : '';
  let plan;
  if (!body.length) {
    if (!newText) return { error: `the section «${name}» is already empty; nothing to change`, short: 'replace_section: nothing to change' };
    plan = planInsert(model, { line: h.line, text: newText });
  } else if (!newText) {
    if (oldBody.includes(OBJECT_CHAR)) return objectError;
    plan = planDelete(model, { start: h.line + 1, end: last });
  } else {
    if (oldBody === newText) return { error: `new_text is the same as the current text of the section «${name}»; nothing to change`, short: 'replace_section: nothing to change' };
    plan = replacePlan(model, h.off + h.text.length, '\n' + oldBody, '\n' + newText);
    if (!plan.error && (plan.mid.oldText.includes(OBJECT_CHAR) || plan.mid.newText.includes(OBJECT_CHAR))) return objectError;
  }
  if (plan.error) return { error: plan.error, short: 'replace_section: ' + plan.error };
  const label = rangeLabel(h.line, last);
  const inner = plan.affected;
  return {
    ...plan, region: [h.line, last], section: { name, from: h.line, to: last, removed: oldBody }, removed: plan.removed || [],
    title: `${newText ? 'Replaced' : 'Emptied'} the section «${name}» (${label})`, cardText: showText(newText), cardLabel: newText ? 'New text' : '',
    // The report starts at the heading, so the model sees the section as it reads now.
    affected: (m) => { const [, b] = inner(m); return [h.line, Math.max(h.line, b)]; },
  };
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
const FORMAT_PROPS = ['bold', 'italic', 'underline', 'font', 'size', 'color', 'highlight', 'link'];
const FORMAT_EXAMPLE = '{"old_text":"lazy dog","bold":true,"italic":null,"underline":null,"font":null,"size":null,"color":null,"highlight":null,"link":null}';
const RESET_WORDS = ['default', 'none', 'reset', 'inherit', 'normal', 'auto'];
const UNLINK_WORDS = ['', 'none', 'remove', 'unlink', 'no link', 'off'];
// A string property left out: null, missing, "" or the string "null" (link: "" removes, see below).
const looseNull = (v) => v === undefined || v === null || (typeof v === 'string' && ['', 'null'].includes(v.trim().toLowerCase()));
const isResetWord = (v) => typeof v === 'string' && RESET_WORDS.includes(v.trim().toLowerCase());
const colorError = (k, v) => ({ error: `${k} ${JSON.stringify(v)} is not a color: use "#RRGGBB" (e.g. "#C00000") or one of red, orange, yellow, green, blue, purple, gray, black, white; "none" resets`, short: `format_text: invalid ${k}` });

// The changes a format_text call asks for, in FORMAT_PROPS order: [[prop, value]] with booleans for
// bold/italic/underline and, for the others, the value or null for a reset: font {name, known}, size
// (pt), color/highlight '#RRGGBB', link the URL. Returns { changes, notes } or { error, short }.
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
    if (k === 'font') {
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
  : v == null ? (k === 'link' || k === 'highlight' ? `${k} removed` : `${k} default`)
  : `${k} ${k === 'font' ? v.name : k === 'size' ? numText(v) : v}`);
// "bold, size 14" (the No change sentence: what the text already is).
const stateText = ([k, v]) => ({
  bold: v ? 'bold' : 'not bold', italic: v ? 'italic' : 'not italic', underline: v ? 'underlined' : 'not underlined',
  font: v ? `in ${v && v.name}` : 'in the default font', size: v != null ? `size ${numText(v)}` : 'at the default size',
  color: v ? `colored ${v}` : 'in the default color', highlight: v ? `highlighted ${v}` : 'not highlighted',
  link: v ? `linked to ${v}` : 'not a link',
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
    case 'link': return run.linkRaw ? JSON.parse(JSON.stringify(run.linkRaw)) : run.link ? { url: run.link } : undefined;
    default: return run[f] ? true : undefined; // bold, italic, underline: the model sees explicit true only
  }
}
// Whether the run already has the requested value of format_text property k.
function runHas(run, k, v) {
  const r = run || {};
  if (FORMAT_KEYS.includes(k)) return !!r[k] === v;
  const cur = k === 'font' ? r.font : k === 'size' ? r.size : k === 'color' ? r.color : k === 'highlight' ? r.bg : r.link;
  if (v == null) return cur == null && !(k === 'link' && r.linkRaw);
  return cur === (k === 'font' ? v.name : v);
}
// The run of each index of API range r ({ idx, run | null }). A paragraph newline inside the range counts
// with the character before it (an empty line's newline as plain).
function rangeRuns(model, r) {
  const out = [];
  for (let n = r.from; n <= r.to; n++) {
    const l = model.lines[n - 1];
    const at = (i) => (l.runs || []).find((x) => x.s <= i && i < x.e) || null;
    for (let idx = Math.max(r.start, l.start); idx < Math.min(r.end, l.end + 1); idx++) {
      out.push({ idx, run: idx < l.end ? at(idx - l.start) : l.end > l.start ? at(l.end - l.start - 1) : null });
    }
  }
  return out;
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

// format_text({old_text, bold, italic, underline, font, size, color, highlight, link}): one updateTextStyle
// over the unique match; null leaves a property as it is. The text does not change, so line numbers stay
// valid (keepsLines). Embedded objects inside the range are allowed. Font keeps the prior weight; resets
// leave the key out of textStyle while listing it in fields. Docs underlines and colors a new link itself,
// so removing a link resets underline and color too, and the undo of any link write restores them. Undo:
// inverse requests built from the runs before the edit, one per stretch of equal prior values; a prior
// false is restored as a reset (the model only sees explicit true).
// Nothing is sent when the text already has every requested value: "No change", or, when this very call
// already succeeded in this turn (snap.formatDone), "Already done" so the model stops repeating it.
function planFormat(model, args, snap) {
  if (!args || typeof args.old_text !== 'string') return { error: `invalid arguments. Example: ${FORMAT_EXAMPLE}`, short: 'Invalid tool arguments' };
  const parsed = formatChanges(args);
  if (parsed.error) return parsed;
  const { changes } = parsed;
  if (!changes.length) return { error: `pass at least one property that is not null (bold, italic, underline, font, size, color, highlight, link). Example: ${FORMAT_EXAMPLE}`, short: 'format_text: no formatting given' };
  const given = args.old_text.replace(/\r\n?/g, '\n');
  if (!given) return { error: 'old_text is empty. Pass the exact text to format', short: 'format_text: old_text is empty' };
  const { hits, oldText, stripped } = findOldText(model, given);
  if (!hits.length) {
    return { error: notFoundError(model, oldText, 'old_text must match the document text (without the "N: " line-number prefixes and without formatting markers); read the exact text with read_lines, read_formatting or find_in_document and try again'), short: 'format_text: the text was not found' };
  }
  if (hits.length > 1) {
    return { error: ambiguousError(model, hits), short: `format_text: the text occurs ${hits.length} times` };
  }
  const hit = hits[0];
  const r = indexRange(model, hit.at, hit.at + hit.text.length);
  if (r.error) return { error: r.error, short: 'format_text: ' + r.error };
  const label = rangeLabel(r.from, r.to);
  const runs = rangeRuns(model, r);
  const markersNote = stripped ? [MARKERS_NOTE] : [];
  const doneKey = JSON.stringify([r.start, r.end, changes]);
  if (runs.every(({ run }) => changes.every(([k, v]) => runHas(run, k, v)))) {
    const lines = linesReport(model, r.from, r.to, markedText);
    if (snap && snap.formatDone && snap.formatDone.has(doneKey)) {
      const now = r.from === r.to ? `${label} now reads: ${markedText(model.lines[r.from - 1], model.textDefault)}` : `${label} now read:\n${lines}`;
      return { reply: { content: `Already done in this message: ${now}\nDo not call format_text again for this.`, _ok: true, _message: `Already done (${label})` } };
    }
    const quoted = showText(hit.text.length > 60 ? hit.text.slice(0, 60) + '…' : hit.text).replace(/\n/g, ' ⏎ ');
    return { reply: { content: [`No change: «${quoted}» on ${label} is already ${changes.map(stateText).join(', ')}.`, lines, ...markersNote].join('\n'), _ok: true, _message: `No change (${label})` } };
  }
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
    else textStyle[f] = { url: v };
  }
  const linkWrite = changes.some(([k]) => k === 'link');
  const linkStyle = ['underline', 'foregroundColor'].filter((f) => !fields.includes(f));
  const sentFields = linkWrite && changes.find(([k]) => k === 'link')[1] == null ? [...fields, ...linkStyle] : fields;
  const undoFields = linkWrite ? [...fields, ...linkStyle] : fields;
  return {
    requests: [reqTextStyle(model, r.start, r.end, textStyle, sentFields)], region: [r.from, r.to], keepsLines: true,
    journal: { kind: 'format', index: r.start, end: r.end, text: hit.text, restore: '', paras: [], requests: inverseTextStyles(model, runs, undoFields) },
    title: `Formatted ${label}`, done: `formatted ${label} (${changes.map(changeText).join(', ')})`,
    cardText: showText(hit.text), cardLabel: 'Formatted text',
    affected: () => [r.from, r.to], notes: [...markersNote, ...(hit.normalized ? [hit.folded ? FOLDED_NOTE : NORMALIZED_NOTE] : []), ...parsed.notes],
    // Called once the edit is applied and re-read: from then on an identical call is "Already done".
    report: (m) => {
      if (snap) (snap.formatDone || (snap.formatDone = new Set())).add(doneKey);
      return `${formatNote(m)}\n${linesReport(m, r.from, r.to, markedText)}`;
    },
  };
}

// ---- format_lines -------------------------------------------------------------------------------------
/* global alignToApi, HEADING_STYLES, lineSpacingPercent, LIST_PRESETS, parseAlign, parseHeading, parseLineSpacing,
   parseListKind */
const reqParaStyle = (model, s, e, paragraphStyle, fields) => ({ updateParagraphStyle: { range: withTab(model, { startIndex: s, endIndex: e }), paragraphStyle, fields: fields.join(',') } });
const reqBulletsOn = (model, s, e, bulletPreset) => ({ createParagraphBullets: { range: withTab(model, { startIndex: s, endIndex: e }), bulletPreset } });
const reqBulletsOff = (model, s, e) => ({ deleteParagraphBullets: { range: withTab(model, { startIndex: s, endIndex: e }) } });
const FORMAT_LINES_EXAMPLE = '{"start":3,"end":3,"style":"h1","align":null,"list":null,"indent_start":null,"indent_first_line":null,"space_above":null,"space_below":null,"line_spacing":null}';
// format_lines point properties: [argument, paragraphStyle field, maximum].
const LINE_DIMS = [['indent_start', 'indentStart', 600], ['indent_first_line', 'indentFirstLine', 600], ['space_above', 'spaceAbove', 200], ['space_below', 'spaceBelow', 200]];
const PARA_FIELD_ORDER = ['namedStyleType', 'alignment', 'indentStart', 'indentFirstLine', 'spaceAbove', 'spaceBelow', 'lineSpacing'];
const LIST_WORDS = { bullet: 'bulleted list', number: 'numbered list', checklist: 'checklist', none: 'no list' };
const LIST_ALREADY = { bullet: 'a bulleted list', number: 'a numbered list', checklist: 'a checklist', none: 'not in a list' };
const ALIGN_WORDS = { left: 'left-aligned', center: 'centered', right: 'right-aligned', justify: 'justified' };

// The format_lines properties as { v: {style, align, list, indentStart, indentFirstLine, spaceAbove, spaceBelow,
// lineSpacing (multiplier)} (only the given ones), notes }, or { error, short }.
function formatLinesValues(args) {
  const v = {};
  const notes = [];
  const bad = (error, k) => ({ error, short: `format_lines: invalid ${k}` });
  if (!looseNull(args.style) && !(v.style = parseHeading(args.style))) return bad(`style must be one of title, subtitle, h1…h6, normal (got ${JSON.stringify(args.style)})`, 'style');
  if (!looseNull(args.align) && !(v.align = parseAlign(args.align))) return bad('align must be left, center, right or justify', 'align');
  if (!looseNull(args.list) && !(v.list = parseListKind(args.list))) return bad('list must be bullet, number, checklist or none', 'list');
  for (const [k, f, max] of LINE_DIMS) {
    if (looseNull(args[k])) continue;
    const n = typeof args[k] === 'boolean' ? null : parsePt(args[k]);
    if (n == null || n < 0 || n > max) return bad(`${k} must be a number of points from 0 to ${max}`, k);
    v[f] = n;
  }
  if (!looseNull(args.line_spacing)) {
    const p = typeof args.line_spacing === 'boolean' ? null : parseLineSpacing(args.line_spacing);
    if (!p || p.value < 0.5 || p.value > 5) return bad('line_spacing must be a multiplier from 0.5 to 5 (1 = single, 1.5, 2)', 'line_spacing');
    v.lineSpacing = p.value;
    if (p.percent) notes.push(`Note: line_spacing ${String(args.line_spacing).trim()} was read as a percent (${numText(p.value)}).`);
  }
  return { v, notes };
}
// "h2, centered, space above 12"
function formatLinesHow(v) {
  const out = [];
  if (v.style) out.push(v.style === 'normal' ? 'normal text' : v.style);
  if (v.list) out.push(LIST_WORDS[v.list]);
  if (v.align) out.push(ALIGN_WORDS[v.align]);
  if (v.indentStart != null) out.push(`indent ${numText(v.indentStart)}`);
  if (v.indentFirstLine != null) out.push(`first line at ${numText(v.indentFirstLine)}`);
  if (v.spaceAbove != null) out.push(`space above ${numText(v.spaceAbove)}`);
  if (v.spaceBelow != null) out.push(`space below ${numText(v.spaceBelow)}`);
  if (v.lineSpacing != null) out.push(`line spacing ${numText(v.lineSpacing)}`);
  return out.join(', ');
}
// The format_lines arguments as words for the action log ("numbered list, centered"), '' when invalid.
function formatLinesArgsText(args) {
  const r = formatLinesValues(args || {});
  return r.error ? '' : formatLinesHow(r.v);
}
// The line already has every given value (nothing to send for it).
function lineHasFormat(l, v) {
  const p = l.para || {};
  if (v.style && (l.style || 'NORMAL_TEXT') !== HEADING_STYLES[v.style]) return false;
  if (v.align && p.align !== v.align) return false;
  if (LINE_DIMS.some(([, f]) => v[f] != null && p[f] !== v[f])) return false;
  if (v.lineSpacing != null && p.lineSpacing !== lineSpacingPercent(v.lineSpacing)) return false;
  if (v.list === 'none') return !l.list;
  return !v.list || (!!l.list && l.list.kind === v.list);
}
// One updateParagraphStyle per stretch of lines (contiguous) for which pick(line) gives the same paragraphStyle.
function paraStyleRuns(model, lines, pick, fields, out) {
  for (let i = 0; i < lines.length;) {
    const ps = pick(lines[i]);
    const key = JSON.stringify(ps);
    let j = i + 1;
    while (j < lines.length && JSON.stringify(pick(lines[j])) === key) j++;
    out.push(reqParaStyle(model, lines[i].start, lines[j - 1].end + 1, ps, fields));
    i = j;
  }
}
// Bullets over [s, e) that keep nesting: tabs for the levels first (Docs reads leading tabs as the level and
// removes them, so the indices end as before), back to front. items: [[line, level], ...].
function bulletRequests(model, s, e, items, preset, out) {
  let tabs = 0;
  for (const [l, level] of items.slice().reverse()) {
    if (level > 0) { out.push(reqInsert(model, l.start, '\t'.repeat(level))); tabs += level; }
  }
  out.push(reqBulletsOn(model, s, e + tabs, preset));
}

// format_lines({start, end, style, align, list, indent_start, indent_first_line, space_above, space_below,
// line_spacing}): paragraph formatting of whole lines; null leaves a property. The text does not change, so
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
  const a = Number(args.start);
  const b = Number(args.end);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) {
    return { error: `start and end must be integers with 1 <= start <= end <= ${total}`, short: 'format_lines: invalid range' };
  }
  const parsed = formatLinesValues(args);
  if (parsed.error) return parsed;
  const { v, notes } = parsed;
  if (!Object.keys(v).length) {
    return { error: `pass at least one of style, align, list, indent_start, indent_first_line, space_above, space_below, line_spacing (null leaves it unchanged). Example: ${FORMAT_LINES_EXAMPLE}`, short: 'format_lines: no formatting given' };
  }
  const lines = model.lines.slice(a - 1, b);
  for (const l of lines) {
    if (!l.exact) return { error: `the positions in line ${l.line} cannot be mapped exactly`, short: 'format_lines: unmappable line' };
    if (l.suggested) return { error: `line ${l.line} contains suggested changes (suggesting mode); accept or reject them in Google Docs first`, short: 'format_lines: the line has suggested changes' };
  }
  const making = !!v.list && v.list !== 'none';
  const tabbed = making && lines.find((l) => l.text.startsWith('\t'));
  if (tabbed) {
    return { error: `line ${tabbed.line} starts with a tab, which Google Docs turns into list nesting and deletes. Remove the tab first with replace_text, or leave that line out.`, short: 'format_lines: a line starts with a tab' };
  }
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
  const { groups, requests, inverse, groupInverse, listsTouched } = formatLinesRequests(model, lines, v);
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
    journal: { kind: 'format', index: first.start, end: last.end + 1, text: groupText(groups[0]), restore: '', paras: [], requests: inverse, ...parts, ...(listsTouched ? { lists: true } : {}) },
    title: `Formatted ${label}`, done: `formatted ${label} (${how})`,
    cardText: showText(lines.map((l) => l.text).join('\n')), cardLabel: 'Formatted lines',
    affected: () => [a, b], notes,
    // Called once the edit is applied and re-read: an identical call is "Already done" while nothing else is written.
    report: (m) => {
      if (snap) (snap.formatLinesDone || (snap.formatLinesDone = new Map())).set(doneKey, m.revisionId);
      return shown(m);
    },
  };
}

// The requests of a format_lines plan and their inverse (see planFormatLines) for lines (contiguous, checked) and
// the values v: { groups (the lines split at table cells and other breaks in index space), requests, inverse,
// groupInverse (inverse split per group, in document order), listsTouched }.
function formatLinesRequests(model, lines, v) {
  const making = !!v.list && v.list !== 'none';
  const groups = [];
  lines.forEach((l, k) => { if (!k || isClosing(model, l.line - 2)) groups.push([l]); else groups[groups.length - 1].push(l); });
  const given = (f) => (f === 'namedStyleType' ? !!v.style : f === 'alignment' ? !!v.align : v[f] != null);
  const isIndent = (f) => f === 'indentStart' || f === 'indentFirstLine';
  // Undo restores every touched field; a list write also moves the indents.
  const touched = PARA_FIELD_ORDER.filter((f) => given(f) || (!!v.list && isIndent(f)));
  const forward = (l) => {
    const ps = {};
    if (v.style) ps.namedStyleType = HEADING_STYLES[v.style];
    if (v.align) ps.alignment = alignToApi(v.align, (l.para || {}).direction);
    for (const [, f] of LINE_DIMS) if (v[f] != null) ps[f] = ptDimension(v[f]);
    if (v.lineSpacing != null) ps.lineSpacing = lineSpacingPercent(v.lineSpacing);
    return ps;
  };
  const prior = (l) => {
    const p = l.para || {};
    const ps = {};
    for (const f of touched) {
      if (f === 'namedStyleType') ps.namedStyleType = l.style || 'NORMAL_TEXT';
      else if (f === 'alignment') { if (p.align) ps.alignment = alignToApi(p.align, p.direction); } else if (p[f] != null) ps[f] = f === 'lineSpacing' ? p[f] : ptDimension(p[f]);
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
      bulletRequests(model, gs, ge, g.map((l) => [l, l.list ? l.list.level : 0]), LIST_PRESETS[v.list], requests);
    } else if (unlisting) requests.push(reqBulletsOff(model, gs, ge));
    // Docs leaves a removed list's indent on the lines: reset (to the named style's) what is not given.
    const fields = PARA_FIELD_ORDER.filter((f) => given(f) || (unlisting && isIndent(f)));
    if (fields.length) paraStyleRuns(model, g, forward, fields, requests);
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
        bulletRequests(model, run[0].start, run[run.length - 1].end + 1, run.map((l) => [l, l.list.level]), LIST_PRESETS[run[0].list.kind] || LIST_PRESETS.bullet, inv);
      }
    }
    if (touched.length) paraStyleRuns(model, g, prior, touched, inv);
    inverse.push(...inv);
  }
  return { groups, requests, inverse, groupInverse, listsTouched };
}

const LINE_NUMBER_TOOLS = ['insert_after_line', 'delete_lines', 'format_lines'];

// Executes replace_text / replace_all / replace_section / format_text / format_lines / insert_after_line / delete_lines / undo_last_edit for the turn snapshot.
// A registered writing tool (registerTools) plans and commits through the same pieces: its plan on snap.model
// or a segment model, gateEdit, then commitEdit (one batch) or commitSequence + finishEdit (several).
// Returns the tool message fields (content for the model, "_" fields for the UI and the journal).
// snap.responseWrite: set by a successful write, reset by the tool loop for every model response; a
// later line-number write of the same response is refused (its numbers predate the edit).
// ui: the tool call's card holder, which a gate card takes over (see gateEdit).
async function runWriteTool(name, args, snap, id, ui = {}) {
  if (LINE_NUMBER_TOOLS.includes(name) && snap.responseWrite) {
    const w = snap.responseWrite;
    return writeError(`line numbers changed after the previous edit in this response (or the document was re-read because it changed), so this ${name} call was not applied; re-read with read_lines and call it again with the current numbers.\nThe text around the previous edit now reads:\n${linesReport(snap.model, w.from - 2, w.to + 2)}\nThe document has ${snap.model.lines.length} lines.`,
      `${name}: line numbers changed by the previous edit; not applied`);
  }
  if (name === 'undo_last_edit') return undoLastEditTool(snap);
  const plan = name === 'replace_text' ? planReplaceText(snap.model, args)
    : name === 'replace_all' ? planReplaceAll(snap.model, args)
    : name === 'format_text' ? planFormat(snap.model, args, snap)
    : name === 'format_lines' ? planFormatLines(snap.model, args, snap)
    : name === 'replace_section' ? planReplaceSection(snap.model, args)
    : name === 'insert_after_line' ? planInsert(snap.model, args) : planDelete(snap.model, args);
  if (plan.error) return writeError(plan.error, plan.short);
  if (plan.reply) return plan.reply; // nothing to send (format_text, format_lines: no change, already done)
  // Removing an in-text citation the References store tracks always asks (references.js; [] when it is off).
  if (plan.removed && plan.removed.length) {
    try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; }
  }
  const refused = await gateEdit(name, plan, snap, ui); // large or risky edits wait for Allow / Deny (gate.js)
  if (refused) return refused;
  const { _notSent, ...res } = await commitEdit(snap, plan, id);
  return res;
}

// Plan of a replace_selection through the API: only when the selection occurs exactly once in the
// text; null means it is pasted instead.
function planApiSelection(text, snap) {
  const sel = String(state.selection || '').replace(/\n+$/, '');
  const newText = modelInsertText(text);
  if (!sel || newText.includes(OBJECT_CHAR)) return null;
  const hits = findFlexible(snap.model.text, sel);
  if (hits.length !== 1 || hits[0].text === newText) return null; // the same text: nothing to send (pasted)
  const plan = replacePlan(snap.model, hits[0].at, hits[0].text, newText, !!hits[0].normalized);
  if (plan.error) return null;
  return { ...plan, title: `Replaced the selection (${rangeLabel(plan.from, plan.to)})`, cardText: showText(newText), cardLabel: 'Inserted text' };
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
