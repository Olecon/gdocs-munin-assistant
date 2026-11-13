'use strict';
// Module docs-segments.js: footnotes, header and footer (the page_parts tool) on top of the line model's
// model.segments and model.toc: read lists them (a reading call), set_text replaces the whole text of the default
// header, the default footer or footnote N (creating a missing header or footer: two batches), add_footnote puts a
// footnote after an exact body passage (createFootnote, then its text: two batches with rollback), delete_footnote
// deletes a footnote's mark. Undo: the built-in kinds ('replace', 'insert', 'multi', 'requests') plus
// 'footnote-restore' (registered here) for a deleted footnote. A self-test row and the turn-context note.
// Sections (see "Sections" below): read part "sections", section_break and section_style.
/* global ambiguousError, anchorMatches, canEdit, onDemandOffer, cmText, commitEdit, commitSequence, CTRL_Z_ADVICE, dimensionPt, docsBatchUpdate, fetchDocModel, findFlexible,
   findOldText, finishEdit, gateEdit, indexRange, inexactLine, isClosing, lineAtIndex, modelInsertText, multiJournal, pageWords, parseLength,
   parsePageEntry, ptDimension, reqRange,
   notFoundError, OBJECT_CHAR, rangeLabel, registerSelfTestRows, registerTools, registerUndoHandler, relocateEdit,
   replacePlan, reqDelete, reqInsert, reqLocation, sanitizeInsertText, segmentModel, showText, stClip, stFail, stPass,
   stQuote, stTool, stWarn, stWrite, stWriteStep, storedTextNote, writeError */
/* exported PAGE_PARTS_DEF, PAGE_PARTS_READ_DEF, pagePartsNote */

const PAGE_PARTS_DEF = { type: 'function', function: {
  name: 'page_parts',
  description: 'Header, footer, footnotes, table of contents and sections (not in the numbered lines). read lists them; set_text replaces the whole text of the header, the footer or footnote N (a missing header or footer is created); add_footnote puts a footnote with text right after after_text (exact body text, once); delete_footnote removes footnote N. The table of contents is read-only. section_break starts a new section after line; section_style sets section N (or the one of line) to text (columns, orientation, margins, first page number).',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'set_text', 'add_footnote', 'delete_footnote', 'section_break', 'section_style'] },
    part: { anyOf: [{ type: 'string', enum: ['header', 'footer', 'footnote', 'toc', 'sections'] }, { type: 'null' }], description: 'read: null = all' },
    number: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'footnote or section number' },
    text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    after_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    type: { anyOf: [{ type: 'string', enum: ['next_page', 'continuous'] }, { type: 'null' }], description: 'section_break; null = next_page' },
  }, required: ['action', 'part', 'number', 'text', 'after_text', 'line', 'type'], additionalProperties: false },
} };

// Plan and the read-only chat turn (registerTools defsFor): read only, so the writing actions and their fields are not
// sent.
const PAGE_PARTS_READ_DEF = { type: 'function', function: {
  name: 'page_parts',
  description: 'Read the header, footer, footnotes, table of contents and sections (not in the numbered lines).',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['read'] },
    part: PAGE_PARTS_DEF.function.parameters.properties.part,
    number: PAGE_PARTS_DEF.function.parameters.properties.number,
  }, required: ['action', 'part', 'number'], additionalProperties: false },
} };

// read output cap (many long footnotes); the rest is named so the model can read it footnote by footnote.
const PART_READ_MAX_CHARS = 8000;
const TOC_ERROR = 'Error: the table of contents cannot be changed through the Google Docs API; it is updated in Google Docs (click the table of contents → Update).';
const KIND_ERROR = 'Error: page_parts changes only the default header and footer (part "header" or "footer"); a first-page or even-page header or footer cannot be created or changed here. Tell the user to change it in Google Docs.';
// The way forward of a footnote the tool cannot delete: only the user can.
const FOOTNOTE_BY_USER = 'tell the user to delete it in Google Docs';
const PART_ERROR = 'Error: part must be "header", "footer", "footnote" (with number), "toc" or "sections".';
const BODY_ONLY_ERROR = 'Error: after_text must be body text (footnotes cannot go into a header, footer or footnote).';
const OBJECT_NOTE = `"${OBJECT_CHAR}" marks an embedded element (a page number, image or chip); keep it where it is in set_text.`;
const RESTORE_NOTE = 'Note: the footnote was re-created as plain text; its formatting was not restored.';

// ---- Lookups ----------------------------------------------------------------------------------------
const segsOf = (model, type) => ((model && model.segments) || []).filter((s) => s.type === type);
const defaultSeg = (model, type) => segsOf(model, type).find((s) => s.kind === 'default') || null;
const footnoteSeg = (model, n) => segsOf(model, 'footnote').find((s) => s.n === n) || null;
// A footnote's text as shown and set: without the leading space Docs puts after the number.
const fnLead = (seg) => (seg.type === 'footnote' && seg.text.startsWith(' ') ? 1 : 0);
const partText = (seg) => seg.text.slice(fnLead(seg));
const segStart = (seg) => (seg.lines.length ? seg.lines[0].start : 0);
const quote = (t) => `«${showText(t)}»`;
const clipEnd = (t, n) => (t.length > n ? '…' + t.slice(t.length - n) : t);
const pluralOf = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// { action, part, number } of the arguments, or { error }. 'footnote 2' and 'table of contents' are accepted.
function parseArgs(a) {
  const action = String(a.action == null ? '' : a.action).trim().toLowerCase();
  let part = a.part == null ? '' : String(a.part).trim().toLowerCase();
  let number = a.number == null || a.number === '' ? null : Number(a.number);
  const m = /^footnote\s*#?\s*(\d+)$/.exec(part);
  if (m) { part = 'footnote'; number = Number(m[1]); }
  if (part === 'table of contents' || part === 'contents') part = 'toc';
  if (part === 'section') part = 'sections';
  if (/\b(first|even)\b/.test(part)) return { action, error: KIND_ERROR };
  if (part && !['header', 'footer', 'footnote', 'toc', 'sections'].includes(part)) return { action, error: PART_ERROR };
  if (number !== null && !Number.isInteger(number)) return { action, error: 'Error: number must be a whole footnote number such as 2.' };
  return { action, part: part || null, number };
}
// The footnote of number N, or { error }.
function pickFootnote(model, number) {
  const all = segsOf(model, 'footnote');
  if (!all.length) return { error: 'Error: the document has no footnotes; add one with add_footnote.' };
  if (number === null) return { error: `Error: number is required with part "footnote" (1-${all.length}).` };
  const seg = footnoteSeg(model, number);
  if (!seg) return { error: `Error: the document has ${pluralOf(all.length, 'footnote')}; number must be 1-${all.length}.` };
  return { seg };
}

// ---- read ---------------------------------------------------------------------------------------------
// The body text right before a footnote's mark on its line ("…of the data"), or ''.
function markContext(model, seg) {
  const l = seg.refLine ? model.lines[seg.refLine - 1] : null;
  if (!l) return '';
  return clipEnd(l.text.slice(0, seg.refIndex - l.start), 30);
}
const footnoteRow = (model, seg) => {
  const where = seg.refLine ? `line ${seg.refLine}, after ${quote(markContext(model, seg))}` : 'no mark in the body';
  return `${seg.n} (${where}): ${showText(partText(seg))}`;
};
const NAMES = { default: '', first: 'First-page ', even: 'Even-page ' };
const headerRows = (model, type) => {
  const Name = type === 'header' ? 'Header' : 'Footer';
  const segs = segsOf(model, type);
  if (!segs.length) return [`${Name}: (none)`];
  if (!segs.some((s) => s.kind === 'default')) segs.unshift(null);
  return segs.map((s) => {
    if (!s) return `${Name}: (none)`;
    const name = s.kind ? NAMES[s.kind] + (s.kind === 'default' ? Name : type) : `${Name} ${s.segmentId}`;
    return `${name}: ${s.text ? quote(s.text) : '(empty)'}`;
  });
};
function readParts(model, a) {
  const { part, number, error } = parseArgs(a);
  if (error) return error;
  if (part === 'sections') return readSections(model);
  const out = [];
  if (!part || part === 'header') out.push(...headerRows(model, 'header'));
  if (!part || part === 'footer') out.push(...headerRows(model, 'footer'));
  if (part === 'footnote' && number !== null) {
    const f = pickFootnote(model, number);
    if (f.error) return f.error;
    out.push(`Footnote ${footnoteRow(model, f.seg)}`);
  } else if (!part || part === 'footnote') {
    const fns = segsOf(model, 'footnote');
    out.push(fns.length ? `Footnotes (${fns.length}):` : 'Footnotes: none');
    let chars = out.join('\n').length;
    for (let i = 0; i < fns.length; i++) {
      const row = footnoteRow(model, fns[i]);
      if (chars + row.length > PART_READ_MAX_CHARS) {
        out.push(`[... footnotes ${fns[i].n}-${fns[fns.length - 1].n} not shown; read them with part "footnote" and number]`);
        break;
      }
      out.push(row);
      chars += row.length + 1;
    }
  }
  const toc = model.toc;
  if (toc && (!part || part === 'toc')) out.push(`Table of contents before line ${toc.beforeLine} (read-only): ${toc.lines.filter((t) => t.trim()).map(showText).join(' / ') || '(empty)'}`);
  else if (part === 'toc') out.push('Table of contents: none');
  if (!part && (model.sectionBreaks || []).length > 1) out.push(readSections(model));
  if (out.some((l) => l.includes(OBJECT_CHAR))) out.push(OBJECT_NOTE);
  return out.join('\n');
}

// ---- Plans ----------------------------------------------------------------------------------------------
// Every plan: { requests? | steps, journal, title, done, cardText, cardLabel, region, affected, keepsLines, report?,
// gateInfo (editGateInfo of the gate) }. keepsLines: no body line moves (a mark is one character inside a line).
// The check of a segment read after the edit: '' when its text is the text sent, else a note with the part that
// differs (storedTextNote) or that the part is gone.
function segReport(model, segmentId, label, sent) {
  const seg = segmentModel(model, segmentId);
  if (!seg) return `Note: the ${label} could not be found after the edit; read it with page_parts.`;
  return storedTextNote(sent, partText(seg).replace(/\n+$/, ''), `in the ${seg.label}`);
}
const lineOfIndex = (model, idx) => lineAtIndex(model, idx) || lineAtIndex(model, idx - 1);

// set_text: the whole text of the default header / footer or footnote N; a missing header / footer is created.
function planSetText(model, part, number, text) {
  if (part === 'toc') return { error: TOC_ERROR };
  if (!part) return { error: 'Error: set_text needs part "header", "footer" or "footnote" (with number).' };
  if (typeof text !== 'string') return { error: 'Error: text is required for set_text: the new plain text of the part ("" empties it).' };
  const newText = modelInsertText(text).replace(/\n+$/, '');
  let seg = null;
  if (part === 'footnote') {
    const f = pickFootnote(model, number);
    if (f.error) return f;
    seg = f.seg;
  } else seg = defaultSeg(model, part);
  if (!seg) {
    if (!newText) return { noChange: `No change: the document has no ${part}.` };
    return planCreate(model, part, newText);
  }
  const lead = fnLead(seg);
  const oldText = seg.text.slice(lead);
  const label = seg.label;
  if (oldText === newText) return { noChange: `No change: the ${label} already reads that.` };
  const objectError = { error: `Error: the ${label} contains an embedded element (shown as "${OBJECT_CHAR}": a page number, image or chip) that set_text cannot re-create. Keep "${OBJECT_CHAR}" in text where it is and change only the text around it.` };
  if (newText.split(OBJECT_CHAR).length > oldText.split(OBJECT_CHAR).length) return objectError;
  let plan;
  if (!oldText) {
    const at = segStart(seg) + lead;
    plan = { requests: [reqInsert(seg, at, newText)], journal: { kind: 'insert', index: at, text: newText, restore: '', paras: [], segmentId: seg.segmentId }, notes: [] };
  } else {
    plan = replacePlan(seg, lead, oldText, newText);
    if (plan.error) return { error: `Error: ${plan.error}` };
    if (plan.mid.oldText.includes(OBJECT_CHAR) || plan.mid.newText.includes(OBJECT_CHAR)) return objectError;
  }
  const removed = plan.journal.restore || '';
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  return {
    ...plan, region: [1, 1], affected: () => [1, 1], keepsLines: true, segmentId: seg.segmentId,
    title: `${Label} text set`, done: `set the text of ${seg.type === 'footnote' ? label : 'the ' + label}`, cardText: showText(newText), cardLabel: `${Label} text`,
    report: (m) => segReport(m, seg.segmentId, label, newText),
    // The permission card (gate.js): the part's new text whole, with the word diff (a part emptied: what goes).
    gateInfo: { what: `replaces the text of the ${label} (${pluralOf(removed.length, 'character')} removed)`, range: Label,
      blocks: newText ? [{ label: `${Label} after the edit`, text: showText(newText), ...(oldText ? { diff: { oldText: showText(oldText), newText: showText(newText) } } : {}) }]
        : [{ label: 'Removed text', text: showText(oldText) }] },
  };
}
// A new default header / footer with text: createHeader / createFooter, then the text (rollback: delete it).
function planCreate(model, part, newText) {
  const Name = part === 'header' ? 'Header' : 'Footer';
  const idOf = (replies) => replies[0][0][`create${Name}`][`${part}Id`];
  const del = (m, id) => ({ [`delete${Name}`]: { [`${part}Id`]: id, ...(m.tabId ? { tabId: m.tabId } : {}) } });
  const create = { type: 'DEFAULT', ...(model.tabId ? { sectionBreakLocation: { index: 0, tabId: model.tabId } } : {}) };
  const pos = { at: 0 };
  const steps = [
    () => ({ requests: [{ [`create${Name}`]: create }], rollback: (m, replies) => [del(m, idOf(replies))] }),
    (m, replies) => {
      const seg = segmentModel(m, idOf(replies));
      if (!seg) throw new Error(`the new ${part} was not found after it was created`);
      pos.at = segStart(seg);
      return { requests: [reqInsert(seg, pos.at, newText)] };
    },
  ];
  return {
    steps, region: [1, 1], affected: () => [1, 1], keepsLines: true, notes: [],
    title: `${Name} created`, done: `created the ${part} with the text`, cardText: showText(newText), cardLabel: `${Name} text`,
    // The journal needs the new ID: built after the batches (journalFor).
    journalFor: (replies) => multiJournal([
      { kind: 'requests', requests: [del(model, idOf(replies))], anchor: false },
      { kind: 'insert', index: pos.at, text: newText, restore: '', paras: [], segmentId: idOf(replies) },
    ]),
    reportFor: (replies) => (m) => segReport(m, idOf(replies), part, newText),
    journal: {},
    gateInfo: { what: `creates the ${part}`, range: Name, excerptLabel: `${Name} text`, excerpt: showText(newText) },
  };
}

// add_footnote: the mark right after the unique body passage after_text, then the footnote's text.
function planAddFootnote(model, a) {
  if (typeof a.after_text !== 'string' || !a.after_text.trim()) return { error: 'Error: after_text is required for add_footnote: the exact body text (occurring once) that the footnote mark follows.' };
  if (typeof a.text !== 'string' || !a.text.trim()) return { error: 'Error: text is required for add_footnote: the footnote text.' };
  const newText = modelInsertText(a.text).replace(/^\s+|\s+$/g, '');
  if (newText.includes(OBJECT_CHAR)) return { error: `Error: text cannot contain "${OBJECT_CHAR}" (an embedded element).` };
  const given = a.after_text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const { hits, oldText } = findOldText(model, given);
  if (!hits.length) {
    if ((model.segments || []).some((s) => findFlexible(s.text, oldText).length)) return { error: BODY_ONLY_ERROR };
    return { error: 'Error: ' + notFoundError(model, oldText, 'after_text must match the body text exactly (without the "N: " line-number prefixes); read it with read_document or find_in_document and try again.').replace(/old_text/g, 'after_text') };
  }
  if (hits.length > 1) {
    return { error: `Error: ${ambiguousError(model, hits, 'after_text')}.` };
  }
  const r = indexRange(model, hits[0].at, hits[0].at + hits[0].text.length);
  if (r.error) return { error: `Error: ${r.error}` };
  const at = r.end;
  const line = lineOfIndex(model, at).line;
  const after = clipEnd(hits[0].text.split('\n').pop(), 40);
  const idOf = (replies) => replies[0][0].createFootnote.footnoteId;
  const pos = { textAt: 0 };
  const steps = [
    () => ({
      requests: [{ createFootnote: { location: reqLocation(model, at) } }],
      // Deleting the mark removes the footnote with it.
      rollback: (m, replies) => {
        const seg = segmentModel(m, idOf(replies));
        return seg && seg.refIndex != null ? [reqDelete(m, seg.refIndex, seg.refIndex + 1)] : [];
      },
    }),
    (m, replies) => {
      const seg = segmentModel(m, idOf(replies));
      if (!seg) throw new Error('the new footnote was not found after it was created');
      pos.textAt = segStart(seg) + fnLead(seg); // after the space Docs puts into a new footnote
      return { requests: [reqInsert(seg, pos.textAt, newText)] };
    },
  ];
  return {
    steps, region: [line, line], affected: () => [line, line], keepsLines: true, notes: [], journal: {},
    title: `Footnote added after line ${line}`, cardText: showText(newText), cardLabel: 'Footnote text',
    // Undone newest first: the text (checked in the footnote), then the mark (checked by its body context).
    journalFor: (replies, m) => {
      const seg = segmentModel(m, idOf(replies));
      const mark = seg ? seg.refIndex : at;
      // index (no anchor of its own): the undo result reports the body line of the mark.
      return multiJournal([
        { kind: 'insert', index: mark, text: OBJECT_CHAR, restore: '', paras: [] },
        { kind: 'insert', index: pos.textAt, text: newText, restore: '', paras: [], segmentId: idOf(replies) },
      ], { index: mark, anchor: false });
    },
    finishFor: (replies, m) => {
      const seg = segmentModel(m, idOf(replies));
      const n = seg ? seg.n : '?';
      const l = seg && seg.refLine ? seg.refLine : line;
      return {
        title: `Footnote ${n} added after line ${l}`, done: `added footnote ${n} after ${quote(after)} on line ${l}`,
        report: (mm) => segReport(mm, idOf(replies), `footnote ${n}`, newText),
      };
    },
    gateInfo: { what: 'adds a footnote', range: `Line ${line}`, excerptLabel: 'Footnote text', excerpt: showText(newText) },
  };
}

// delete_footnote: deleting the mark deletes the footnote (Docs keeps no footnote without a mark).
function planDeleteFootnote(model, number) {
  const f = pickFootnote(model, number);
  if (f.error) return f;
  const seg = f.seg;
  if (seg.refIndex == null) return { error: `Error: footnote ${seg.n} has no mark in the body, so it cannot be deleted here; ${FOOTNOTE_BY_USER}.` };
  const text = partText(seg);
  const line = seg.refLine;
  return {
    requests: [reqDelete(model, seg.refIndex, seg.refIndex + 1)], region: [line, line], keepsLines: true, notes: [],
    affected: (m) => { const l = lineOfIndex(m, seg.refIndex); return l ? [l.line, l.line] : [line, line]; },
    journal: { kind: 'footnote-restore', index: seg.refIndex, text: '', restore: text },
    title: `Footnote ${seg.n} deleted`, done: `deleted footnote ${seg.n}`,
    cardText: showText(text), cardLabel: 'Deleted footnote text',
    report: (m) => (segmentModel(m, seg.segmentId) ? `Note: Google Docs kept the footnote text without its mark; ${FOOTNOTE_BY_USER}.` : ''),
    gateInfo: { what: `deletes footnote ${seg.n}`, range: `Line ${line}`, excerptLabel: 'Footnote text', excerpt: showText(text) },
  };
}

// ---- Running ----------------------------------------------------------------------------------------------
const SECTION_ACTIONS = ['section_break', 'section_style'];
const PART_ACTIONS = ['set_text', 'add_footnote', 'delete_footnote', ...SECTION_ACTIONS];
async function runPageParts(name, args, snap, ui, call) {
  const a = args || {};
  const model = snap.model;
  if (!model) return 'Error: page_parts needs the Google Docs API (a connected Google account).';
  const p = parseArgs(a);
  if (p.action === 'read') return readParts(model, a);
  if (!PART_ACTIONS.includes(p.action)) return 'Error: action must be "read", "set_text", "add_footnote", "delete_footnote", "section_break" or "section_style".';
  if (p.error && !SECTION_ACTIONS.includes(p.action)) return p.error;
  if (p.part === 'toc') return TOC_ERROR;
  let plan;
  if (p.action === 'section_break') plan = planSectionBreak(model, a);
  else if (p.action === 'section_style') plan = planSectionStyle(model, a);
  else if (p.part === 'sections') return `Error: ${p.action} does not apply to sections; use section_break or section_style.`;
  else if (p.action === 'set_text') plan = planSetText(model, p.part, p.number, a.text);
  else if (p.action === 'add_footnote') {
    if (p.part && p.part !== 'footnote') return `Error: add_footnote adds a footnote to the body; pass part null (a ${p.part} cannot get one).`;
    plan = planAddFootnote(model, a);
  } else {
    if (p.part && p.part !== 'footnote') return `Error: delete_footnote deletes footnotes only; to empty the ${p.part} use set_text with text "".`;
    plan = planDeleteFootnote(model, p.number);
  }
  if (plan.noChange) return plan.noChange;
  if (plan.error) return writeError(plan.error.replace(/^Error: /, ''), `page_parts: ${plan.error.replace(/^Error: /, '').slice(0, 120)}`);
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  if (!plan.steps) {
    const { _notSent, ...res } = await commitEdit(snap, plan, call.id);
    return res;
  }
  const seq = await commitSequence(snap, plan, call.id, plan.steps);
  if (seq.fail) { const { _notSent, ...res } = seq.fail; return res; }
  const fin = plan.finishFor ? plan.finishFor(seq.replies, seq.model) : {};
  const done = { ...plan, journal: plan.journalFor(seq.replies, seq.model), ...(plan.reportFor ? { report: plan.reportFor(seq.replies) } : {}), ...fin };
  return finishEdit(snap, done, call.id, seq.model);
}

// Undo of a deleted footnote: a new footnote (new ID) at the old mark position, with the old text as plain text.
// The body context around the position must be unchanged (or found once elsewhere: relocateEdit).
async function undoFootnoteRestore(edit) {
  const ctrlZ = CTRL_Z_ADVICE;
  const model = await fetchDocModel(edit.docId, edit.tabId);
  if (!anchorMatches(model, edit)) {
    const moved = relocateEdit(model, edit);
    if (!moved) throw new Error(`the text around the deleted footnote's mark changed, so the footnote cannot be re-created automatically. ${ctrlZ}`);
    edit.index = moved.index;
  }
  const res = await docsBatchUpdate(model, [{ createFootnote: { location: reqLocation(model, edit.index) } }]);
  const fid = res && res.replies && res.replies[0] && res.replies[0].createFootnote && res.replies[0].createFootnote.footnoteId;
  let now = await fetchDocModel(edit.docId, edit.tabId);
  const seg = fid ? segmentModel(now, fid) : null;
  const text = sanitizeInsertText(edit.restore || '').split(OBJECT_CHAR).join('');
  if (seg && text) {
    try {
      await docsBatchUpdate(now, [reqInsert(seg, segStart(seg) + fnLead(seg), text)]);
    } catch (e) {
      // An empty footnote would be worse than none: delete the new mark again.
      try {
        const m = await fetchDocModel(edit.docId, edit.tabId);
        const s = segmentModel(m, fid);
        if (s && s.refIndex != null) await docsBatchUpdate(m, [reqDelete(m, s.refIndex, s.refIndex + 1)]);
      } catch (e2) { /* reported below */ }
      throw new Error(`the footnote's text could not be written back (${e.message}). ${ctrlZ}`);
    }
    now = await fetchDocModel(edit.docId, edit.tabId);
  }
  const back = fid ? segmentModel(now, fid) : null;
  const l = lineOfIndex(now, edit.index);
  return {
    model: now, restored: '', lostObjects: String(edit.restore || '').includes(OBJECT_CHAR), range: l ? [l.line, l.line] : undefined,
    what: `undid "${edit.title}": ${back ? `footnote ${back.n}` : 'the footnote'} re-created${l ? ' on ' + rangeLabel(l.line, l.line) : ''}`,
    note: RESTORE_NOTE,
  };
}

// ---- Turn context ---------------------------------------------------------------------------------------
// "Page parts: header, footer, 3 footnotes, a table of contents before line 2." or ''. What exists, no instruction, and no
// empty header or footer: "read them with page_parts" made a greeting read an empty header.
function pagePartsNote(snap) {
  const m = snap && snap.model;
  if (!m) return '';
  const names = [...new Set((m.segments || []).filter((s) => s.type !== 'footnote' && String(s.text || '').trim()).map((s) => (s.kind ? s.label : s.type)))];
  const fns = segsOf(m, 'footnote').length;
  if (fns) names.push(pluralOf(fns, 'footnote'));
  if (m.toc) names.push(`a table of contents before line ${m.toc.beforeLine}`);
  const brks = (m.sectionBreaks || []).filter((b) => b.n > 1);
  if (brks.length) names.push(`${pluralOf(brks.length + 1, 'section')} (new ones at line${brks.length > 1 ? 's' : ''} ${brks.map((b) => b.firstLine).join(', ')})`);
  return names.length ? `Page parts: ${names.join(', ')}.` : '';
}

// ---- Registration ----------------------------------------------------------------------------------------
const offersPageParts = (mode, snap) => !!snap && snap.docFormat === 'docs-api' && !!snap.model;
const isPartsRead = (name, args) => String((args && args.action) || '').trim().toLowerCase() === 'read';
// section_break always takes a line; section_style only when it names no section number.
const givenArg = (v) => v != null && v !== '';
function partsUsesLines(name, args) {
  const act = String((args && args.action) || '').trim().toLowerCase();
  return act === 'section_break' || (act === 'section_style' && givenArg(args.line) && !givenArg(args.number));
}
const partName = (a) => (a.part == null ? '' : String(a.part)) + (a.number != null && a.number !== '' ? ` ${a.number}` : '');
// On demand on Munin and custom servers (request.js onDemandOffer): when the message names a page part, or the document
// has one (the turn context's "Page parts:" note names it). A section counts only as a layout section (a break, a new
// one, its style): "the Methods section" / "раздел Методы" is a heading's section, the commonest request of all.
const PAGE_WORDS_RE = /\b(?:headers?|footers?|footnotes?|endnotes?|landscape|portrait|pages?|margins?|columns|table of contents|toc)\b|\bsection[\s-]+(?:breaks?|styles?|layout)\b|\bnew section\b|колонтитул|сноск|разрыв\S* раздел|нов\S* раздел|страниц|альбомн|книжн|пол[яей]\b|оглавлени|колонк/i;
const partsNow = (snap) => !!pagePartsNote({ ...snap, ...(snap.promptView || {}) });
registerTools([PAGE_PARTS_DEF], {
  offer: (mode, snap) => offersPageParts(mode, snap) && onDemandOffer(snap, (t) => PAGE_WORDS_RE.test(t), partsNow(snap)),
  runs: offersPageParts,
  defsFor: (mode) => [canEdit(mode) ? PAGE_PARTS_DEF : PAGE_PARTS_READ_DEF],
  reading: isPartsRead,
  run: runPageParts,
  pending: 'Changing a page part…',
  summary: (name, a) => {
    const act = String(a.action || '');
    if (act === 'section_break') return `section_break after line ${a.line}`;
    if (act === 'section_style') return `section_style ${a.number != null ? `section ${a.number}` : `line ${a.line}`}`;
    if (act === 'add_footnote') return `add_footnote after «${clipEnd(String(a.after_text || '').replace(/\s+/g, ' '), 40)}»`;
    return `${act} ${partName(a)}`.trim();
  },
  gate: (name, plan) => (plan && plan.gateInfo) || null,
  usesLines: partsUsesLines,
  docNote: pagePartsNote,
});
registerUndoHandler('footnote-restore', undoFootnoteRestore);

// ---- Sections ---------------------------------------------------------------------------------------------
// model.sectionBreaks (docs-model.js) holds every section break of the body, the one Docs puts at index 0 first.
// read with part "sections" lists the sections with their lines and style; section_break inserts a break after a body
// line (insertSectionBreak puts a newline at its index and the break after it: at the end of the line's text, the
// line keeps its text and style, the break follows, and the empty paragraph the line's own newline now forms is
// deleted when a body line follows directly, so no line changes; before a table or at the end it stays as the new
// section's first line); section_style sets columns, orientation, margins and the first page number of one section
// (updateSectionStyle over the first index of the section, a leaf mask). Undo: 'section-break' (the break and the newline
// before it deleted; the line's paragraph is split again first when the empty line was deleted) and 'section-style' (the
// previous values: SectionStyle fields cannot be unset, so an inherited value is written as it was in effect).
const SEC_TYPES = { next_page: 'NEXT_PAGE', continuous: 'CONTINUOUS' };
const SEC_DEFAULT_PAGE = { w: 612, h: 792, margin: 72 }; // Docs' Letter page with 1 inch margins
const SEC_DEFAULT_SPACING = 36; // Docs' column spacing (0.5 inch)
const SEC_MARGINS = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'];
const SEC_CTX_CHARS = 20;
const SEC_STYLE_HINT = 'write e.g. "2 columns spacing 1 cm separator", "landscape", "portrait margins 2 cm", "first page number 1" (columns 1-3; lengths in cm, mm, in or pt)';
const SEC_SIZE_ERROR = 'Error: a section has no page size of its own in Google Docs (only its orientation: landscape or portrait); the page size is the whole document\'s: document_styles action page.';

// The sections: [{ n, brk (its break), from, to (its lines; to < from when it has none) }].
function sectionList(model) {
  const brks = model.sectionBreaks && model.sectionBreaks.length ? model.sectionBreaks : [{ n: 1, index: 0, firstLine: 1, style: {} }];
  return brks.map((b, i) => ({ n: b.n, brk: b, from: b.firstLine, to: i + 1 < brks.length ? brks[i + 1].firstLine - 1 : model.lines.length }));
}
const sectionOfLine = (model, line) => sectionList(model).filter((s) => s.from <= line).pop() || sectionList(model)[0];
// The values a section shows: { landscape, margins: { marginTop, … } (pt), columns, spacing (pt), separator, pageNumberStart
// (null: the numbering continues) }.
function sectionNow(model, sec) {
  const st = sec.brk.style || {};
  const ps = model.pageStyle || {};
  const size = ps.pageSize || {};
  const w = dimensionPt(size.width) || SEC_DEFAULT_PAGE.w;
  const h = dimensionPt(size.height) || SEC_DEFAULT_PAGE.h;
  const flip = st.flipPageOrientation != null ? !!st.flipPageOrientation : !!ps.flipPageOrientation;
  const margins = {};
  for (const k of SEC_MARGINS) margins[k] = dimensionPt(st[k]) ?? dimensionPt(ps[k]) ?? SEC_DEFAULT_PAGE.margin;
  const cols = st.columnProperties || [];
  const first = sec.n === 1;
  const start = typeof st.pageNumberStart === 'number' ? st.pageNumberStart : first ? (typeof ps.pageNumberStart === 'number' ? ps.pageNumberStart : 1) : null;
  return { landscape: (w > h) !== flip, w, h, margins, columns: Math.max(1, cols.length), spacing: cols.length > 1 ? dimensionPt(cols[0].paddingEnd) || 0 : null,
    separator: st.columnSeparatorStyle === 'BETWEEN_EACH_COLUMN', pageNumberStart: start };
}
function sectionWords(v) {
  const cols = v.columns > 1 ? `${v.columns} columns spacing ${cmText(v.spacing || 0)} cm${v.separator ? ' separator' : ''}` : '1 column';
  const page = pageWords({ orientation: v.landscape ? 'landscape' : 'portrait', ...v.margins, ...(v.pageNumberStart != null ? { pageNumberStart: v.pageNumberStart } : {}) });
  return `${cols}, ${page}`;
}
const sectionLines = (s) => (s.to < s.from ? 'no lines' : rangeLabel(s.from, s.to));
const sectionTypeWord = (b) => (b.style.sectionType === 'CONTINUOUS' ? 'continuous' : 'next page');
function readSections(model) {
  const list = sectionList(model);
  return [`Sections (${list.length}):`, ...list.map((s) => `${s.n}${s.n > 1 ? ` (${sectionTypeWord(s.brk)})` : ''}: ${sectionLines(s)}; ${sectionWords(sectionNow(model, s))}`)].join('\n');
}

// The section of number n or of line `line`, or { error }.
function pickSection(model, a) {
  const list = sectionList(model);
  const n = a.number == null || a.number === '' ? null : Number(a.number);
  const line = a.line == null || a.line === '' ? null : Number(a.line);
  if (n != null) {
    if (!Number.isInteger(n) || n < 1 || n > list.length) return { error: `Error: the document has ${pluralOf(list.length, 'section')}; number must be 1-${list.length} (or give a line of the section).` };
    return { sec: list[n - 1] };
  }
  if (line == null) return { error: 'Error: section_style needs number (the section, as page_parts read part "sections" lists them) or line (a line of the section).' };
  if (!Number.isInteger(line) || line < 1 || line > model.lines.length) return { error: `Error: line must be 1-${model.lines.length}.` };
  return { sec: sectionOfLine(model, line) };
}

// The words of section_style -> { want: { columns?, spacing?, separator?, landscape?, margins?: {…}, pageNumberStart? } }
// or { error }. The orientation, margins and first page number in the formatting sheet's page words (parsePageEntry).
function parseSectionWords(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { error: `Error: section_style needs text: the section's new settings; ${SEC_STYLE_HINT}.` };
  const want = {};
  let t = ` ${raw.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').replace(/[,;]/g, ' ')} `;
  const phrase = (re, fn) => { t = t.replace(re, (...m) => { fn(m); return ' '; }); };
  const numWords = { one: 1, two: 2, three: 3, single: 1 };
  let bad = '';
  phrase(/\s(\d+|one|two|three|single)[ -]columns?(?=\s)/g, (m) => { want.columns = numWords[m[1]] || Number(m[1]); });
  phrase(/\scolumns?\s+(\d+)(?=\s)/g, (m) => { want.columns = Number(m[1]); });
  phrase(/\s(?:no (?:column )?(?:separator|line)s?|without (?:a )?(?:separator|line))(?=\s)/g, () => { want.separator = false; });
  phrase(/\s(?:(?:with )?(?:a )?(?:column )?separator(?: lines?)?|lines? between(?: columns)?)(?=\s)/g, () => { want.separator = true; });
  phrase(/\s(?:column )?(?:spacing|gap)\s+(\S+)(?:\s+(cm|mm|in|inch|inches|pt))?(?=\s)/g, (m) => {
    const n = parseLength(m[1] + (m[2] || ''));
    if (n == null || n > 288) bad = `the column spacing "${m[1]}${m[2] ? ' ' + m[2] : ''}" must be a length up to 10 cm`; else want.spacing = n;
  });
  if (bad) return { error: `Error: ${bad}; ${SEC_STYLE_HINT}.` };
  if (want.columns != null && !(want.columns >= 1 && want.columns <= 3)) return { error: 'Error: a section has 1 to 3 columns in Google Docs.' };
  const rest = t.trim();
  if (rest) {
    const p = parsePageEntry(rest);
    if (p.error) return { error: `Error: ${p.error.replace(/^"page /, '"').replace(/; write e\.g\. page[\s\S]*$/, '')}; ${SEC_STYLE_HINT}.` };
    const v = p.value;
    if (v.size) return { error: SEC_SIZE_ERROR };
    if (v.documentMode || v.marginHeader != null || v.marginFooter != null || v.useFirstPageHeaderFooter != null) {
      return { error: 'Error: section_style sets columns, orientation, margins and the first page number; the header and footer margins, a different first page and pageless mode are the whole document\'s: document_styles action page.' };
    }
    if (v.orientation) want.landscape = v.orientation === 'landscape';
    const m = Object.fromEntries(SEC_MARGINS.filter((k) => v[k] != null).map((k) => [k, v[k]]));
    if (Object.keys(m).length) want.margins = m;
    if (v.pageNumberStart != null) want.pageNumberStart = v.pageNumberStart;
  }
  if (!Object.keys(want).length) return { error: `Error: the text names no section setting; ${SEC_STYLE_HINT}.` };
  return { want };
}
const colProps = (n, spacing) => Array.from({ length: n }, (_, i) => ({ paddingEnd: ptDimension(i < n - 1 ? spacing : 0) }));
const plainCols = (cols) => cols.map((c) => (c && c.paddingEnd ? { paddingEnd: { ...c.paddingEnd } } : { paddingEnd: ptDimension(0) }));
// The update of section sec to want: { style, fields, inverse: { style, fields }, lost: [words] (what the undo cannot write
// back) }; fields is empty when nothing differs.
function sectionUpdate(model, sec, want) {
  const now = sectionNow(model, sec);
  const st = sec.brk.style || {};
  const style = {};
  const inv = {};
  const lost = [];
  if (want.landscape != null && want.landscape !== now.landscape) {
    style.flipPageOrientation = want.landscape !== (now.w > now.h);
    inv.flipPageOrientation = !style.flipPageOrientation;
  }
  for (const k of SEC_MARGINS) {
    const v = want.margins && want.margins[k];
    if (v != null && Math.abs(v - now.margins[k]) >= 0.01) { style[k] = ptDimension(v); inv[k] = ptDimension(now.margins[k]); }
  }
  const n = want.columns != null ? want.columns : now.columns;
  const spacing = want.spacing != null ? want.spacing : now.spacing != null ? now.spacing : SEC_DEFAULT_SPACING;
  if (n !== now.columns || (n > 1 && want.spacing != null && Math.abs(spacing - (now.spacing || 0)) >= 0.01)) {
    style.columnProperties = colProps(n, spacing);
    inv.columnProperties = (st.columnProperties || []).length ? plainCols(st.columnProperties) : colProps(1, 0);
  }
  if (want.separator != null && want.separator !== now.separator) {
    style.columnSeparatorStyle = want.separator ? 'BETWEEN_EACH_COLUMN' : 'NONE';
    inv.columnSeparatorStyle = now.separator ? 'BETWEEN_EACH_COLUMN' : 'NONE';
  }
  if (want.pageNumberStart != null && want.pageNumberStart !== now.pageNumberStart) {
    style.pageNumberStart = want.pageNumberStart;
    if (now.pageNumberStart != null) inv.pageNumberStart = now.pageNumberStart; else lost.push('the page numbering continuing from the section before');
  }
  return { style, fields: Object.keys(style), inverse: { style: inv, fields: Object.keys(inv) }, lost };
}
// updateSectionStyle over the first index after the section's break (a range touching that section only).
const reqSectionStyle = (model, brkIndex, style, fields) => ({ updateSectionStyle: { range: reqRange(model, brkIndex + 1, brkIndex + 2), sectionStyle: style, fields: fields.join(',') } });
// What the read after a section_style still shows differently from want ('' when it took).
function sectionStyleReport(m, brkIndex, want) {
  const sec = sectionList(m).find((s) => s.brk.index === brkIndex);
  if (!sec) return 'Note: the section could not be found after the edit; check it with page_parts read part "sections".';
  const left = sectionUpdate(m, sec, want).fields;
  return left.length ? `Note: Google Docs did not apply all of it (${left.join(', ')} still differ${left.length === 1 ? 's' : ''}); section ${sec.n} reads: ${sectionWords(sectionNow(m, sec))}.` : '';
}

function planSectionStyle(model, a) {
  const p = pickSection(model, a);
  if (p.error) return p;
  const w = parseSectionWords(a.text);
  if (w.error) return w;
  const sec = p.sec;
  const u = sectionUpdate(model, sec, w.want);
  if (!u.fields.length) return { noChange: `No change: section ${sec.n} already reads ${sectionWords(sectionNow(model, sec))}.` };
  const index = sec.brk.index;
  const from = Math.min(sec.from, model.lines.length);
  const words = String(a.text).trim();
  return {
    requests: [reqSectionStyle(model, index, u.style, u.fields)], region: [from, from], affected: () => [from, from], keepsLines: true, notes: [],
    journal: { kind: 'section-style', index, n: sec.n, inverse: u.inverse, lost: u.lost, anchor: false },
    title: `Section ${sec.n} style set`, done: `set section ${sec.n} (${sectionLines(sec)}) to ${words}`, cardText: words, cardLabel: `Section ${sec.n}`,
    report: (m) => sectionStyleReport(m, index, w.want),
    gateInfo: { what: `changes the layout of section ${sec.n}`, range: `Section ${sec.n}`, excerptLabel: 'New settings', excerpt: words },
  };
}

// section_break after body line `line`: { requests (insertSectionBreak at the end of its text, then the empty paragraph
// after the break deleted when a body line follows directly), … } or { error }.
function planSectionBreak(model, a) {
  const n = a.line == null || a.line === '' ? null : Number(a.line);
  if (n == null) return { error: 'Error: section_break needs line: the body line the new section follows.' };
  if (!Number.isInteger(n) || n < 1 || n > model.lines.length) return { error: `Error: line must be 1-${model.lines.length}.` };
  const typeWord = String(a.type == null ? 'next_page' : a.type).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const type = SEC_TYPES[typeWord];
  if (!type) return { error: 'Error: type must be "next_page" or "continuous".' };
  const l = model.lines[n - 1];
  if (l.cell) {
    const t = (model.tables || []).find((x) => !x.nested && x.firstLine <= n && n <= x.lastLine);
    const where = t && t.firstLine > 1 ? ` (line ${t.firstLine - 1} is the line before it)` : '';
    return { error: `Error: line ${n} is in a table cell; a section break cannot go inside a table. Give a body line outside the table${where}.` };
  }
  if (l.suggested) return { error: `Error: line ${n} has suggested changes; accept or reject them first.` };
  if (!l.exact) return { error: `Error: ${inexactLine(n, 'put the break after another line, or tell the user to insert it in Google Docs')}.` };
  const b = l.end + 1; // the break's index after the insert
  if ((model.sectionBreaks || []).some((x) => x.n > 1 && x.index === l.end + 1)) return { error: `Error: a section break already follows line ${n}.` };
  const next = model.lines[n];
  const clean = !!next && !isClosing(model, n - 1) && next.start === l.end + 1;
  const requests = [{ insertSectionBreak: { location: reqLocation(model, l.end), sectionType: type } }];
  if (clean) requests.push(reqDelete(model, l.end + 2, l.end + 3));
  const word = typeWord === 'continuous' ? 'continuous' : 'next page';
  const after = next ? next.text.slice(0, SEC_CTX_CHARS) : '';
  return {
    requests, region: [n, Math.min(n + 1, model.lines.length)], keepsLines: clean, notes: [],
    affected: () => [n, n + 1],
    journal: { kind: 'section-break', index: b, cleaned: clean, before: l.text.slice(-SEC_CTX_CHARS), after: clean ? after : '', anchor: false },
    title: `Section break after line ${n}`, done: `inserted a section break (${word}) after line ${n}`,
    cardText: `Section break (${word}) after line ${n}`, cardLabel: 'Section break',
    report: (m) => sectionBreakReport(model, m, n, b, type, clean),
    gateInfo: { what: `inserts a section break (${word}) after line ${n}`, range: `Line ${n}`, excerptLabel: 'Line', excerpt: showText(l.text) },
  };
}
// The re-read after section_break: the break where it was sent, the lines unchanged (and the empty first line of the new
// section named when it stays).
function sectionBreakReport(before, m, n, b, type, clean) {
  const brk = (m.sectionBreaks || []).find((x) => x.index === b && x.n > 1);
  if (!brk) return `Note: the section break was not found after line ${n} when the document was read again; check it with page_parts read part "sections".`;
  const notes = [];
  const want = before.lines.length + (clean ? 0 : 1);
  const same = m.lines.length === want && m.lines[n - 1].text === before.lines[n - 1].text
    && before.lines.slice(n).every((l, i) => m.lines[n + i + (clean ? 0 : 1)].text === l.text);
  if (!same) notes.push(`Note: the lines around the break read differently than expected; read lines ${n}-${n + 2}.`);
  if ((brk.style.sectionType || type) !== type) notes.push(`Note: Google Docs made it a ${sectionTypeWord(brk)} break.`);
  const head = `Section ${brk.n} starts at line ${brk.firstLine}`;
  notes.unshift(clean ? `${head}.` : `${head}, an empty line Google Docs keeps after the break (write the section's text there).`);
  return notes.join('\n');
}

// Undo of section_break: the break and the newline before it deleted; when the empty line after the break was deleted,
// the line's paragraph is split again first (the inserted newline takes the line's paragraph style), so both lines
// stay as they were. The break is found at its index, else by the text around it (once).
async function undoSectionBreak(edit) {
  const ctrlZ = CTRL_Z_ADVICE;
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const brks = (model.sectionBreaks || []).filter((x) => x.n > 1);
  let brk = brks.find((x) => x.index === edit.index);
  const fits = (x) => {
    const lb = model.lines[x.firstLine - 2];
    const la = model.lines[x.firstLine - 1];
    return !!lb && lb.end === x.index - 1 && lb.text.endsWith(edit.before || '') && (!edit.cleaned || (!!la && la.text.startsWith(edit.after || '')));
  };
  if (!brk || !fits(brk)) {
    const hits = brks.filter(fits);
    if (hits.length !== 1) throw new Error(`the section break is no longer where it was inserted (or the text around it changed), so it cannot be removed automatically. ${ctrlZ}`);
    brk = hits[0];
  }
  const b = brk.index;
  const lb = model.lines[brk.firstLine - 2];
  const la = model.lines[brk.firstLine - 1];
  let requests;
  if (edit.cleaned) requests = [reqInsert(model, b - 1, '\n'), reqDelete(model, b, b + 2)];
  else {
    if (!la || la.text !== '' || la.cell || la.start !== b + 1) throw new Error(`text was written into the empty line after the section break, so removing the break would join it to line ${lb.line}. ${ctrlZ}`);
    requests = [reqDelete(model, b - 1, b + 1)];
  }
  await docsBatchUpdate(model, requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const l = lineAtIndex(now, lb.start) || lb;
  return { model: now, restored: '', lostObjects: false, range: [l.line, Math.min(l.line + 1, now.lines.length)], what: `undid "${edit.title}": the section break after line ${l.line} removed` };
}
// Undo of section_style: the previous values written back on the section that starts at the same break.
async function undoSectionStyle(edit) {
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const list = sectionList(model);
  const sec = list.find((s) => s.brk.index === edit.index);
  if (!sec) throw new Error(`the section that was changed is no longer where it was (text before it changed or its break was removed), so its layout cannot be restored automatically. ${CTRL_Z_ADVICE}`);
  const inv = edit.inverse || {};
  if ((inv.fields || []).length) await docsBatchUpdate(model, [reqSectionStyle(model, sec.brk.index, inv.style, inv.fields)]);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const from = Math.min(sec.from, now.lines.length);
  const lost = edit.lost || [];
  return { model: now, restored: '', lostObjects: false, range: [from, from],
    ...(lost.length ? { note: `Note: ${lost.join(' and ')} could not be restored (Google Docs cannot unset a section's first page number); it can be set in Google Docs (Format > Page numbers) if needed.` } : {}) };
}
registerUndoHandler('section-break', undoSectionBreak);
registerUndoHandler('section-style', undoSectionStyle);

// ---- Self-test (Docs API mode, after "Write: lists": the two test lines are in the document) ---------------
const ST_FOOTER = 'Munin self-test footer';
const ST_FOOTNOTE = 'Munin self-test footnote';
const stPartsArgs = (over) => ({ action: 'read', part: null, number: null, text: null, after_text: null, line: null, type: null, ...over });
async function stPageParts(ctx, ph) {
  const m0 = ctx.snap.model;
  const footer0 = defaultSeg(m0, 'footer');
  const fns0 = segsOf(m0, 'footnote').map((s) => s.segmentId);
  const line0 = m0.lines[ph.line - 1].text;
  await stWrite(ctx, 'page_parts', stPartsArgs({ action: 'set_text', part: 'footer', text: ST_FOOTER }));
  await stWrite(ctx, 'page_parts', stPartsArgs({ action: 'add_footnote', text: ST_FOOTNOTE, after_text: 'lazy dog' }));
  const fn = segsOf(ctx.snap.model, 'footnote').find((s) => !fns0.includes(s.segmentId));
  const r = await stTool(ctx, 'page_parts', stPartsArgs());
  const got = String(r.content || '');
  if (!got.includes(`Footer: «${ST_FOOTER}»`)) return stFail('page_parts read does not show the new footer', stClip(got, 400));
  if (!fn || !got.includes(`${fn.n} (line ${ph.line}, after «`) || !got.includes(`): ${ST_FOOTNOTE}`)) return stFail(`page_parts read does not show the footnote on line ${ph.line}`, stClip(got, 400));
  await stWrite(ctx, 'undo_last_edit', {});
  await stWrite(ctx, 'undo_last_edit', {});
  const m = ctx.snap.model;
  const footer = defaultSeg(m, 'footer');
  if (footer0 ? !footer || footer.text !== footer0.text : !!footer) return stFail(`after two undo_last_edit the footer reads ${footer ? stQuote(footer.text) : '(none)'}, expected ${footer0 ? stQuote(footer0.text) : 'no footer'}`);
  if (m.lines[ph.line - 1].text !== line0) return stFail(`after two undo_last_edit line ${ph.line} reads ${stQuote(m.lines[ph.line - 1].text)} (the footnote mark is still there?)`);
  const kept = segmentModel(m, fn.segmentId);
  const how = `footer ${footer0 ? 'text set' : 'created'}, footnote ${fn.n} after «lazy dog» on line ${ph.line}; both read back; undone twice (${footer0 ? 'footer text restored' : 'footer deleted again'}, mark removed)`;
  if (kept) return stWarn(`${how}, but Docs kept the footnote text after its mark was deleted (delete_footnote and the undo of add_footnote leave it behind)`);
  return stPass(`${how}; deleting the mark removed the footnote`);
}
registerSelfTestRows([{ name: 'Write: page parts', run: (ctx) => stWriteStep(stPageParts)(ctx) }]);
