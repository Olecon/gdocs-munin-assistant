'use strict';
// Module docs-undo.js: undo of Docs API edits (undoEdit with the journal kinds, 'multi' and 'requests' among them,
// and the kinds of registerUndoHandler; edits in headers, footers and footnotes through their segment model;
// undoLastEditTool, the Undo and Undo all buttons on edit cards: undoFromButton, undoAllFromButton with its dry
// run and confirmation card (previewUndoAll, undoAllCard), answerEdits, refreshEditCard).
/* global addError, addNotice, anchorMatches, confirmOpen, changedLinesReport, commonEdges, disjointHits, docsBatchUpdate,
   docStatusText, fetchDocModel, findFlexible, formatNote, hitLines, indexAtOffset, indexRange, lineAtIndex, lineAtOffset,
   lineList, linesReport, markedText, OBJECT_CHAR, oneLine, rangeLabel, renderHistory, reqDelete, reqInsert,
   reqStyle, readChatForTurn, sanitizeInsertText, saveHistory, segmentModel, setSnapModel, setStatus, state, toolCard, toolCardFor,
   tryChatLock, undoHandler, UNDO_ALL_PENDING_TEXT, UNDO_RUNNING_TEXT, useDocModel, writeError */
/* exported latestUndoable, undoLastEditTool, editCards, undoFromButton, answerEdits, undoAllFromButton, undoingNotice, withOwnedChat */

// ---- Undo ------------------------------------------------------------------------------------------
// The edit journal is the chat history itself: every successful write keeps its inverse in the tool
// message (_edit: index, text to remove, restore = text to put back, paragraph styles, context anchor).
// Undo reverts the most recent edit that is not undone yet; an undo is not journaled, so it cannot be
// undone in turn (Ctrl+Z in Google Docs still can). Embedded objects and character formatting of
// removed text cannot be restored.
// An edit with undoable: false (journaled for the record, e.g. a deleted comment thread) is skipped.
const isUndoable = (m) => m.role === 'tool' && m._ok && !!m._edit && !m._edit.undone && m._edit.undoable !== false;
function latestUndoable(messages = state.messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUndoable(messages[i])) return messages[i];
  }
  return null;
}

// Reads the document and checks that the edit can still be undone (its context anchor is unchanged).
// When text was inserted or deleted above the edit after it (its index moved), the edit is looked for by
// its anchor: anchor.before + its text + anchor.after occurring exactly once (exact match) gives the new
// position. Returns { model, at } (at: the edit with its current index); throws a readable Error otherwise.
// An edit in a header, footer or footnote (segmentId) is checked in that segment: model is its segment model.
async function undoableModel(edit) {
  const model = await editModel(edit);
  return { model, at: undoableAt(model, edit) };
}
// The check of undoableModel on a model already read (also the dry run of Undo all): the edit itself when its
// anchor matches, else the relocated edit; throws the refusal otherwise.
function undoableAt(model, edit) {
  if (anchorMatches(model, edit)) return edit;
  const moved = relocateEdit(model, edit);
  if (moved) return moved;
  throw notUndoableError(edit);
}
const notUndoableError = (edit) => new Error(edit.anchor
  ? 'the document changed near that edit after it was made, so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.'
  : 'that edit could not be verified after it was made, so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.');
// The document read for undoing edit: the body model, or the segment model of its segmentId.
async function editModel(edit) {
  return editSegment(await fetchDocModel(edit.docId, edit.tabId), edit);
}
function editSegment(full, edit) {
  const model = segmentModel(full, edit.segmentId);
  if (!model) throw new Error('the header, footer or footnote of that edit no longer exists, so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.');
  return model;
}

// The edit moved to where its anchor context occurs exactly once now, or null. Its index (and for a
// format edit the range and the inverse requests: every index, startIndex and endIndex in them, such as a range,
// an insertText location or a table start) are shifted by the same amount.
function relocateEdit(model, edit) {
  const a = edit.anchor;
  if (!a) return null;
  const hits = findFlexible(model.text, a.before + (edit.text || '') + a.after, { normalize: false });
  if (hits.length !== 1) return null;
  const index = indexAtOffset(model, hits[0].at + a.before.length);
  const d = index - edit.index;
  const move = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'index' || k === 'startIndex' || k === 'endIndex') && typeof v === 'number') o[k] = v + d;
      else move(v);
    }
  };
  const shift = (rq) => { const out = JSON.parse(JSON.stringify(rq)); move(out); return out; };
  const moved = { ...edit, index };
  if (edit.end != null) moved.end = edit.end + d;
  if (edit.requests) moved.requests = edit.requests.map(shift);
  return anchorMatches(model, moved) ? moved : null;
}

// Reverts one journaled edit on the current document. Returns { model, lostObjects }. Throws a readable
// Error when the document around the edit changed after it (context anchor; for a replace_all the
// occurrence count, see undoReplaceAll) or it cannot be mapped. An edit found at a new position (see
// undoableModel) keeps that position (index) afterwards.
// res.model is always the body model (the panel's document); an edit in a segment reports its lines through
// segmentModel(res.model, edit.segmentId). Registered kinds (registerUndoHandler) come first.
async function undoEdit(edit) {
  const custom = undoHandler(edit.kind);
  if (custom) return custom(edit);
  if (edit.kind === 'multi') return undoMulti(edit);
  if (edit.kind === 'requests') return undoRequests(edit);
  if (edit.kind === 'replace-all') return undoReplaceAll(edit);
  if (edit.kind === 'format') return undoFormat(edit);
  const { model, at } = await undoableModel(edit);
  if (at !== edit) edit.index = at.index;
  const raw = edit.restore || '';
  const restore = restoredText(edit);
  const requests = [];
  const len = (edit.text || '').length;
  if (len) requests.push(reqDelete(model, edit.index, edit.index + len));
  if (restore) requests.push(reqInsert(model, edit.index, restore));
  const nlPos = [];
  for (let i = restore.indexOf('\n'); i >= 0; i = restore.indexOf('\n', i + 1)) nlPos.push(i);
  for (const p of edit.paras || []) {
    if (!p.style || (p.nl >= 0 && p.nl >= nlPos.length)) continue;
    const at = p.nl < 0 ? edit.index : edit.index + nlPos[p.nl] + 1;
    requests.push(reqStyle(model, at, at + 1, p.style));
  }
  if (!requests.length) throw new Error('there is nothing to undo for that edit.');
  await docsBatchUpdate(model, requests);
  return { model: await fetchDocModel(edit.docId, edit.tabId), restored: restore, lostObjects: raw.includes(OBJECT_CHAR) };
}
// The text an undo puts back: the removed text without embedded objects (they cannot be re-inserted).
const restoredText = (edit) => sanitizeInsertText(edit.restore || '').split(OBJECT_CHAR).join('');

// Undo of a replace_all (journal: find = its new_text, replace = its old_text, count). Its occurrences
// are spread over the document, so there is no context anchor (undoableModel is not used): the
// occurrence count is the safety check instead. The undo applies only when find occurs exactly count
// times, all on plain lines; otherwise the document changed since (or new_text also occurred
// elsewhere) and which occurrences to revert is unknown. An empty new_text left nothing to find.
// Returns { model, restored, lostObjects, lines } (lines: the reverted lines; numbering unchanged).
const REPLACE_ALL_CTRL_Z = 'so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.';
async function undoReplaceAll(edit) {
  const ctrlZ = REPLACE_ALL_CTRL_Z;
  if (!edit.find) throw replaceAllNoFindError(edit);
  const model = await editModel(edit);
  const hits = replaceAllHits(model.text, edit);
  const lines = replaceAllLines(model, hits);
  const requests = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const r = indexRange(model, hits[i].at, hits[i].at + hits[i].text.length);
    if (r.error) throw new Error(`that edit cannot be reverted on line ${lineAtOffset(model, hits[i].at).line}, ${ctrlZ}`); // single-line text on checked lines: not expected
    // Only the differing middle changes back (as the edit changed only that).
    const back = edit.replaces ? edit.replaces[i] : edit.replace;
    const { p, q } = commonEdges(hits[i].text, back);
    const S = r.start + p;
    const E = r.end - q;
    const mid = back.slice(p, back.length - q);
    if (E > S) requests.push(reqDelete(model, S, E));
    if (mid) requests.push(reqInsert(model, S, mid));
  }
  await docsBatchUpdate(model, requests);
  return { model: await fetchDocModel(edit.docId, edit.tabId), restored: edit.replace, lostObjects: false, lines };
}
// The checks of undoReplaceAll without a request (also the dry run of Undo all): the occurrences of new_text in
// text when they are exactly the ones the edit inserted, and the lines they are on when those are plain.
const replaceAllNoFindError = (edit) => new Error(`that edit deleted every occurrence of "${oneLine(edit.replace, 60)}" and where they were is not recorded, ${REPLACE_ALL_CTRL_Z}`);
function replaceAllHits(text, edit) {
  if (!edit.find) throw replaceAllNoFindError(edit);
  const hits = disjointHits(findFlexible(text, edit.find, { normalize: false }));
  if (hits.length !== edit.count) {
    throw new Error(`"${oneLine(edit.find, 60)}" now occurs ${hits.length} time${hits.length === 1 ? '' : 's'} in the document instead of the ${edit.count} inserted by that edit (the text changed since, or it also occurs elsewhere), ${REPLACE_ALL_CTRL_Z}`);
  }
  return hits;
}
function replaceAllLines(model, hits) {
  const lines = hitLines(model, hits);
  const bad = lines.filter((n) => model.lines[n - 1].suggested || !model.lines[n - 1].exact);
  if (bad.length) throw new Error(`${bad.length === 1 ? 'line' : 'lines'} ${lineList(bad)} with the replaced text now contain${bad.length === 1 ? 's' : ''} suggested changes or cannot be mapped exactly, ${REPLACE_ALL_CTRL_Z}`);
  return lines;
}

// Undo of a format_text (journal: index..end, the matched text, inverse requests with their tabId). The
// text is unchanged by formatting, so the usual context anchor applies; it fails when the text was edited
// or shifted. Returns { model, restored: '', lostObjects: false, range: [from, to] } (lines of the range).
async function undoFormat(edit) {
  if (edit.groups) return undoFormatGroups(edit);
  const { model, at } = await undoableModel(edit);
  if (at !== edit) Object.assign(edit, { index: at.index, end: at.end, requests: at.requests });
  if (!(edit.requests || []).length) throw new Error('there is nothing to undo for that edit.');
  await docsBatchUpdate(model, edit.requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  return { model: now, restored: '', lostObjects: false, range: indexLines(segmentModel(now, edit.segmentId), edit.index, edit.end) };
}
// Undo of a format_lines across table cells (journal: groups [{ index, end, text, lines, requests, anchor }], one per
// stretch of lines between cell boundaries). Each group is checked and relocated on its own (undoableAt), and the
// inverse requests of the groups found are sent in one batch. A group that is not found is not restored: the groups
// found are restored and marked (group.undone; their inverse only sets prior values, so repeating it is harmless),
// and the error starts "only part of that edit was undone" with the groups restored and not, so the entry stays
// undoable. No group found at all: the usual refusal.
async function undoFormatGroups(edit) {
  const model = await editModel(edit);
  const found = [];
  const missing = [];
  for (const g of edit.groups) {
    if (g.undone) continue;
    let at = null;
    try { at = undoableAt(model, { ...g, segmentId: edit.segmentId }); } catch (e) { /* not restored, reported below */ }
    if (at) found.push([g, at]); else missing.push(g);
  }
  if (!found.length && !edit.groups.some((g) => g.undone)) throw notUndoableError(edit);
  // Back to front, as the edit sent them (bullet requests insert tabs that Docs removes again).
  const requests = found.slice().reverse().flatMap(([, at]) => at.requests || []);
  if (requests.length) await docsBatchUpdate(model, requests);
  for (const [g, at] of found) Object.assign(g, { index: at.index, end: at.end, requests: at.requests, undone: true });
  const now = await fetchDocModel(edit.docId, edit.tabId);
  if (missing.length) throw groupsPartlyError(edit.groups.filter((g) => g.undone), missing);
  const seg = segmentModel(now, edit.segmentId);
  const spans = found.map(([, at]) => indexLines(seg, at.index, at.end));
  const range = spans.length ? [Math.min(...spans.map((r) => r[0])), Math.max(...spans.map((r) => r[1]))] : [1, 1];
  return { model: now, restored: '', lostObjects: false, range };
}
// Group line numbers are those of the edit (formatting moves no line; text typed since may have).
const groupsLabel = (gs) => gs.map((g) => rangeLabel(g.lines[0], g.lines[1])).join(', ');
const groupsPartlyError = (done, missing, dry) => new Error(`only part of that edit ${dry ? 'would be' : 'was'} undone: the formatting of ${groupsLabel(done)} ${dry ? 'can be' : 'was'} restored, `
  + `but the text of ${groupsLabel(missing)} changed after the edit, so ${missing.length === 1 ? 'that part' : 'those parts'} cannot be restored automatically. Use Undo (Ctrl+Z) in Google Docs instead.`);

// The lines [from, to] of API range [s, e) in model ([1, 1] when unknown).
function indexLines(model, s, e) {
  const a = model && typeof s === 'number' ? lineAtIndex(model, s) : null;
  const b = (a && typeof e === 'number' && lineAtIndex(model, e - 1)) || a;
  return a ? [a.line, Math.max(a.line, b.line)] : [1, 1];
}

// Undo of a 'requests' entry ({ kind: 'requests', requests: [inverse requests], index?, end?, text?, segmentId?,
// anchor? }): with an index the anchor is checked (and the requests moved with relocateEdit) like a format edit;
// anchor: false applies the requests unchecked (for inverses that address by ID, such as deleteHeader, whose
// module checked the document itself). Returns { model, restored: '', lostObjects: false, range }.
async function undoRequests(edit) {
  let model;
  if (edit.anchor === false) model = await editModel(edit);
  else {
    const r = await undoableModel(edit);
    model = r.model;
    if (r.at !== edit) Object.assign(edit, { index: r.at.index, end: r.at.end, requests: r.at.requests });
  }
  if (!(edit.requests || []).length) throw new Error('there is nothing to undo for that edit.');
  await docsBatchUpdate(model, edit.requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  return { model: now, restored: '', lostObjects: false, range: indexLines(segmentModel(now, edit.segmentId), edit.index, edit.end) };
}

// Undo of a 'multi' entry (multiJournal): its parts newest first, each through undoEdit (with the entry's docId,
// tabId, id and title). A part that is undone is marked (part.undone), so when a later one fails the entry stays
// undoable and the next undo continues with the parts left; the error then says that only part was undone.
// Returns the last part's result with every part's note and lost objects.
async function undoMulti(edit) {
  const parts = edit.parts || [];
  let res = null;
  let lost = false;
  const notes = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.undone) continue;
    try {
      res = await undoEdit({ docId: edit.docId, tabId: edit.tabId, id: edit.id, title: edit.title, ...p });
    } catch (e) {
      if (parts.some((x) => x.undone)) throw new Error(`only part of that edit was undone: ${e.message}`);
      throw e;
    }
    p.undone = true;
    lost = lost || !!res.lostObjects;
    if (res.note) notes.push(res.note);
  }
  if (!res) throw new Error('there is nothing to undo for that edit.');
  return { ...res, lostObjects: lost, note: notes.join('\n') || undefined };
}

const LOST_OBJECTS_NOTE ='Embedded objects (images, chips, page breaks) in the removed text could not be restored.';
// For the user only (the tool result keeps LOST_OBJECTS_NOTE): where the lost objects still are.
const LOST_OBJECTS_HINT = ' Copy them back from File > Version history in Google Docs.';
// A format_lines undo that touched lists (journal: lists) re-creates them; what Docs keeps per list is lost.
const LIST_UNDO_NOTE = 'Note: the list was re-created; numbering, custom bullets or ticks may differ.';

// Lines to report after an undo: around the restored text.
function undoAffected(model, edit, restored) {
  const a = lineAtIndex(model, edit.index) || lineAtIndex(model, edit.index - 1);
  const b = lineAtIndex(model, edit.index + Math.max(restored.length - 1, 0)) || a;
  return a ? [a.line, Math.max(a.line, b.line)] : [1, 1];
}

async function undoLastEditTool(snap) {
  const m = latestUndoable();
  if (!m) return writeError('there is no edit to undo in this chat (an undo itself cannot be undone).', 'Nothing to undo');
  const edit = m._edit;
  let res;
  try { res = await undoEdit(edit); } catch (e) { return writeError(e.message, 'Undo failed: ' + e.message); }
  edit.undone = true;
  if (snap.model && snap.model.docId === res.model.docId && snap.model.tabId === res.model.tabId) setSnapModel(snap, res.model);
  useDocModel(res.model);
  // The lines are reported in the edit's segment (a header, footer or footnote) when it has one.
  const rm = segmentModel(res.model, edit.segmentId) || res.model;
  const [from, to] = res.lines ? [res.lines[0], res.lines[res.lines.length - 1]] : res.range || undoAffected(rm, edit, res.restored);
  snap.responseWrite = { from, to };
  refreshEditCard(edit.id);
  const lost = (res.lostObjects ? `\n${LOST_OBJECTS_NOTE}` : '') + (edit.lists ? `\n${LIST_UNDO_NOTE}` : '') + (res.note ? `\n${res.note}` : '');
  const what = res.what ? res.what : edit.kind === 'replace-all'
    ? `undid replace_all: ${edit.count} occurrence${edit.count === 1 ? '' : 's'} of "${oneLine(edit.find, 60)}" changed back to "${oneLine(edit.replace, 60)}"`
    : edit.kind === 'format' ? `undid formatting of ${rangeLabel(from, to)}`
    : `undid "${edit.title}"`;
  const lines = res.lines ? changedLinesReport(rm, res.lines)
    : edit.kind === 'format' ? `${formatNote(rm)}\n${linesReport(rm, from, to, markedText)}`
    : linesReport(rm, from, to);
  const report = rm !== res.model ? `In the ${rm.label}:\n${lines}` : lines;
  return {
    content: `Done: ${what}.${lost}\n${report}\nThe document now has ${res.model.lines.length} lines.`,
    _ok: true, _message: 'Undid: ' + edit.title, _icon: '↩️', _detail: res.lostObjects ? LOST_OBJECTS_NOTE : undefined,
  };
}

// Cards of journaled edits shown in the chat (edit id -> element), so an undo can update its card.
const editCards = new Map();
function refreshEditCard(editId) {
  const old = editCards.get(editId);
  if (!old || !old.isConnected) return;
  let tc = { id: editId, type: 'function', function: { name: '', arguments: '' } };
  for (const m of state.messages) for (const c of m.tool_calls || []) if (c.id === editId) tc = c;
  const r = state.messages.find((x) => x.role === 'tool' && x.tool_call_id === editId);
  if (!r) return;
  old.replaceWith(toolCardFor(tc, r));
}

// An Undo / Undo all click owns the chat like a turn does (tryChatLock): it is refused while another tab
// answers in the chat (or undoes there), and runs on the stored history (readChatForTurn), so the edit it
// undoes and the journal it marks are the current ones. Returns run()'s result, or false when refused.
async function withOwnedChat(button, run) {
  if (state.busy || state.undoing) { addNotice(`Wait until the current answer is finished, then click ${button} again.`); return false; }
  const { docId, chatId } = state;
  state.undoing = true; // set before the first await: a second click is refused above
  let release = null;
  try {
    release = docId && chatId ? await tryChatLock(docId, chatId) : null;
    if (!release) { addNotice(`Another tab is answering in this chat. Click ${button} again when that answer is finished.`); return false; }
    if (!(await readChatForTurn(docId, chatId))) return false; // deleted in another tab
    return await run();
  } finally {
    if (release) release();
    state.undoing = false;
  }
}

// "Undo" button on the card of the most recent edit (outside a running request).
function undoFromButton(editId, btn) {
  return withOwnedChat('Undo', () => undoEditOf(editId, btn));
}

async function undoEditOf(editId, btn) {
  const m = state.messages.find((x) => x.role === 'tool' && x._edit && x._edit.id === editId);
  if (!m || m !== latestUndoable()) { addNotice('Only the most recent edit can be undone here. Use Ctrl+Z in Google Docs for older ones.'); return false; }
  if (btn) btn.disabled = true;
  setStatus('Undoing the edit…');
  try {
    const res = await undoEdit(m._edit);
    m._edit.undone = true;
    m.content += '\n[Later the user undid this edit with the Undo button.]';
    useDocModel(res.model);
    await saveHistory();
    renderHistory();
    addNotice('↩️ Undid: ' + m._edit.title + (res.lostObjects ? ' ' + LOST_OBJECTS_NOTE + LOST_OBJECTS_HINT : '') + (m._edit.lists ? ' ' + LIST_UNDO_NOTE : '') + (res.note ? ' ' + res.note : ''), { sticky: res.lostObjects || !!res.note });
    return true;
  } catch (e) {
    if (btn) btn.disabled = false;
    addError('Undo failed: ' + e.message);
    return false;
  } finally {
    setStatus(docStatusText(), state.docText == null);
  }
}

// The undoable edits of the answer that made the most recent undoable edit, newest first, when editId is
// that edit (an answer: the messages after the last user message). Otherwise [].
function answerEdits(editId, messages = state.messages) {
  const latest = latestUndoable(messages);
  if (!latest || latest._edit.id !== editId) return [];
  const out = [];
  // An automatic continuation (_auto) belongs to the answer it continues, as in lastUserIndex.
  for (let i = messages.indexOf(latest); i >= 0 && (messages[i].role !== 'user' || messages[i]._auto); i--) {
    if (isUndoable(messages[i])) out.push(messages[i]);
  }
  return out;
}

// "Undo all" button on the most recent edit card of an answer with two or more edits: a dry run on one read of
// the document first (previewUndoAll), a card that lists what can be undone and what is blocked, and only after
// the user confirms it the undo: newest to oldest, each edit checked again (the document may change while the
// card waits), stopping at the first one that cannot be undone; a card tells what was undone and what not.
function undoAllFromButton(editId, btn) {
  return withOwnedChat('Undo all', () => undoAnswerOf(editId, btn));
}

// True while the Undo all card waits for the user's click (state.undoing is set too).
let undoAllWaiting = false;
// The refusal text for leaving or answering in the chat while an undo owns it (state.undoing).
const undoingNotice = () => (undoAllWaiting ? UNDO_ALL_PENDING_TEXT : UNDO_RUNNING_TEXT);

async function undoAnswerOf(editId, btn) {
  const list = answerEdits(editId);
  if (list.length < 2) { addNotice('Only the edits of the answer with the most recent edit can be undone together. Use Ctrl+Z in Google Docs for older ones.'); return false; }
  if (btn) btn.disabled = true;
  let go = false;
  try {
    setStatus(`Checking ${list.length} edits…`);
    let items;
    try { items = await previewUndoAll(list); } catch (e) {
      addError(`Undo all failed: the document could not be read (${e.message}). Nothing was undone; try again.`);
      return false;
    }
    const ui = {};
    undoAllWaiting = true;
    let d;
    try { d = await confirmOpen(undoAllCard(items), null, ui); } finally { undoAllWaiting = false; }
    if (ui.card) ui.card.remove();
    go = d === 'accept';
  } finally {
    if (!go) {
      if (btn) btn.disabled = false;
      setStatus(docStatusText(), state.docText == null);
    }
  }
  return go ? applyUndoAll(list, btn) : false;
}

async function applyUndoAll(list, btn) {
  setStatus(`Undoing ${list.length} edits…`);
  const undone = [];
  let failed = null;
  let lost = false;
  const notes = [];
  let model = null;
  try {
    for (const m of list) {
      try {
        const res = await undoEdit(m._edit);
        m._edit.undone = true;
        m.content += '\n[Later the user undid this edit with the Undo all button.]';
        undone.push(m._edit.title);
        lost = lost || res.lostObjects;
        for (const n of [m._edit.lists ? LIST_UNDO_NOTE : '', res.note || '']) if (n && !notes.includes(n)) notes.push(n);
        model = res.model;
      } catch (e) {
        failed = { title: m._edit.title, message: e.message };
        break;
      }
    }
    if (model) useDocModel(model);
    if (undone.length) { await saveHistory(); renderHistory(); }
    // A multi-part edit that failed halfway is partly undone (undoMulti) and stays undoable.
    const partly = failed && /^only part of that edit was undone/.test(failed.message);
    const kept = list.slice(undone.length).map((m, i) => m._edit.title + (partly && i === 0 ? ' (partly undone)' : ''));
    const lines = [`Undone (newest first):${undone.length ? '' : ' none'}`, ...undone.map((t) => '- ' + t)];
    if (kept.length) lines.push('Not undone (still in the document):', ...kept.map((t) => '- ' + t));
    const detail = [failed ? `Stopped at "${failed.title}": ${failed.message}` : '', lost ? LOST_OBJECTS_NOTE + LOST_OBJECTS_HINT : '', ...notes].filter(Boolean).join(' ');
    if (failed) toolCard('fail', `Undid ${undone.length} of ${list.length} edits of this answer`, lines.join('\n'), detail, { label: 'Details' });
    else toolCard('ok', `Undid all ${list.length} edits of this answer`, lines.join('\n'), detail || undefined, { label: 'Details', icon: '↩️' });
    if (btn && !undone.length) btn.disabled = false;
    return !failed;
  } finally {
    setStatus(docStatusText(), state.docText == null);
  }
}

// ---- Undo all: the dry run --------------------------------------------------------------------------------------
// The edits of the list (newest first) checked on one read of the document with the checks of undoEdit (undoableAt,
// relocateEdit, replaceAllHits / replaceAllLines, editSegment), without a request. An older edit is checked on the
// text as undoing the newer ones would leave it: each checked undo is simulated on the text of its segment (its
// text taken out, the removed text put back), and an edit is then found at its position moved by those changes, or
// by its context occurring exactly once (as relocateEdit). Registered kinds (table, footnote-restore, cite) and
// unanchored 'requests' entries check while they apply, so they are not checked here ('unchecked'), and neither is
// anything older (what they change is not simulated). The apply loop checks every edit again: this is a forecast.
// Returns [{ title, status: 'ok' | 'blocked' | 'unchecked' | 'stop', reason? }] ('stop': after a blocked edit,
// where Undo all stops). Throws when the document cannot be read.
async function previewUndoAll(list) {
  const reads = new Map(); // docId|tabId -> body model, read once
  for (const m of list) {
    const key = m._edit.docId + '|' + m._edit.tabId;
    if (!reads.has(key)) reads.set(key, await fetchDocModel(m._edit.docId, m._edit.tabId));
  }
  const dry = { reads, views: new Map(), unknown: false };
  const out = [];
  let blocked = false;
  for (const m of list) {
    const item = { title: m._edit.title, status: 'ok' };
    if (blocked) item.status = 'stop';
    else if (dry.unknown) item.status = 'unchecked';
    else {
      try { item.status = dryUndo(m._edit, dry); } catch (e) { item.status = 'blocked'; item.reason = e.message; blocked = true; }
    }
    out.push(item);
  }
  return out;
}

// One edit of the dry run: 'ok', or 'unchecked' (dry.unknown is then set); throws the refusal undoEdit would give.
function dryUndo(edit, dry) {
  if (undoHandler(edit.kind) || (edit.kind === 'requests' && edit.anchor === false)) { dry.unknown = true; return 'unchecked'; }
  if (edit.kind === 'multi') { // its parts newest first, as undoMulti
    const parts = edit.parts || [];
    let some = parts.some((x) => x.undone);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].undone) continue;
      let r;
      try { r = dryUndo({ docId: edit.docId, tabId: edit.tabId, id: edit.id, title: edit.title, ...parts[i] }, dry); } catch (e) {
        throw some ? new Error(`only part of that edit would be undone: ${e.message}`) : e;
      }
      if (r === 'unchecked') return r;
      some = true;
    }
    return 'ok';
  }
  const v = dryView(edit, dry);
  if (edit.kind === 'format' && edit.groups) { // as undoFormatGroups: every group that is left must be found
    const done = edit.groups.filter((g) => g.undone);
    const missing = [];
    for (const g of edit.groups) {
      if (g.undone) continue;
      try { dryOffset(v, { ...g, segmentId: edit.segmentId }); done.push(g); } catch (e) { missing.push(g); }
    }
    if (!missing.length) return 'ok';
    if (done.length) throw groupsPartlyError(edit.groups.filter((g) => done.includes(g)), missing, true);
    throw notUndoableError(edit);
  }
  if (edit.kind === 'replace-all') {
    const hits = replaceAllHits(v.text, edit);
    if (!v.changes.length) replaceAllLines(v.model, hits); // the line checks need the text as read
    for (let i = hits.length - 1; i >= 0; i--) dryChange(v, hits[i].at, hits[i].text.length, edit.replaces ? edit.replaces[i] : edit.replace);
    return 'ok';
  }
  const at = dryOffset(v, edit);
  if (edit.kind === 'requests') dry.unknown = true; // checked, but what its requests change is not simulated
  else if (edit.kind !== 'format') dryChange(v, at, (edit.text || '').length, restoredText(edit));
  return 'ok';
}

// The simulated text of the edit's segment: { model (as read), text, changes: [{ at, removed, inserted }] }.
function dryView(edit, dry) {
  const key = `${edit.docId}|${edit.tabId}|${edit.segmentId || ''}`;
  if (!dry.views.has(key)) {
    const model = editSegment(dry.reads.get(edit.docId + '|' + edit.tabId), edit); // throws when the segment is gone
    dry.views.set(key, { model, text: model.text, changes: [] });
  }
  return dry.views.get(key);
}
function dryChange(v, at, removed, inserted) {
  v.text = v.text.slice(0, at) + inserted + v.text.slice(at + removed);
  v.changes.push({ at, removed, inserted: inserted.length });
}
// The text offset of the edit in v.text, or throws the refusal. Text as read: the real check (undoableAt).
function dryOffset(v, edit) {
  const offsetOf = (idx) => { const l = lineAtIndex(v.model, idx); return l ? l.off + (idx - l.start) : null; };
  if (!v.changes.length) return offsetOf(undoableAt(v.model, edit).index);
  const a = edit.anchor;
  if (!a) throw notUndoableError(edit);
  const t = edit.text || '';
  const needle = a.before + t + a.after;
  let o = offsetOf(edit.index);
  for (const c of v.changes) {
    if (o == null) break;
    if (c.at + c.removed <= o) o += c.inserted - c.removed;
    else if (c.at < o) o = null; // a change across the position: found by its context below
  }
  if (o != null && o >= a.before.length && v.text.slice(o - a.before.length, o + t.length + a.after.length) === needle) return o;
  const hits = findFlexible(v.text, needle, { normalize: false });
  if (hits.length !== 1) throw notUndoableError(edit);
  return hits[0].at + a.before.length;
}

// The confirmation card of Undo all (gate.js confirmOpen, kind 'undo-all'): one line per edit, newest first, with
// the reason for a blocked one. confirm: the label of the confirm button, or null when nothing would be undone.
function undoAllCard(items) {
  const n = items.length;
  const blockedAt = items.findIndex((x) => x.status === 'blocked');
  const unchecked = items.filter((x) => x.status === 'unchecked').length;
  const why = [
    blockedAt === 0 ? 'The newest edit cannot be undone, so Undo all would undo nothing.'
      : blockedAt > 0 ? `${blockedAt} of ${n} edits can be undone; Undo all stops at the blocked one, which stays in the document with the older ones.`
        : `All ${n} edits can be undone, newest first.`,
    unchecked ? `${unchecked === 1 ? '1 edit' : `${unchecked} edits`} (a table, footnote or citation, or an edit older than one) could not be checked in advance.` : '',
    blockedAt === 0 ? '' : 'Each edit is checked again right before it is undone.',
  ].filter(Boolean).join(' ');
  return {
    tool: 'Undo all', kind: 'undo-all', icon: '↩️', title: `Undo all ${n} edits of this answer?`, why,
    items: items.map((x) => ({
      title: x.title,
      mark: { ok: '↩️', unchecked: '❔', blocked: '⛔', stop: '⏸️' }[x.status],
      note: x.status === 'blocked' ? `Blocked: ${x.reason}`
        : x.status === 'stop' ? 'Not undone: Undo all stops at the blocked edit above.'
          : x.status === 'unchecked' ? 'Not checked in advance; checked when it is undone.' : '',
    })),
    confirm: blockedAt === 0 ? null : blockedAt > 0 ? `Undo ${blockedAt}` : 'Undo all',
  };
}
