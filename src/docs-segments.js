'use strict';
// Module docs-segments.js: footnotes, header and footer (the page_parts tool) on top of the line model's
// model.segments and model.toc: read lists them (a reading call), set_text replaces the whole text of the default
// header, the default footer or footnote N (creating a missing header or footer: two batches), add_footnote puts a
// footnote after an exact body passage (createFootnote, then its text: two batches with rollback), delete_footnote
// deletes a footnote's mark. Undo: the built-in kinds ('replace', 'insert', 'multi', 'requests') plus
// 'footnote-restore' (registered here) for a deleted footnote. A self-test row and the turn-context note.
/* global ambiguousError, anchorMatches, apiEditing, commitEdit, commitSequence, docsBatchUpdate, fetchDocModel, findFlexible,
   findOldText, finishEdit, gateEdit, indexRange, lineAtIndex, linesReport, modelInsertText, multiJournal,
   notFoundError, OBJECT_CHAR, rangeLabel, registerSelfTestRows, registerTools, registerUndoHandler, relocateEdit,
   replacePlan, reqDelete, reqInsert, reqLocation, sanitizeInsertText, segmentModel, showText, stClip, stFail, stPass,
   stQuote, stTool, stWarn, stWrite, stWriteStep, writeError */
/* exported PAGE_PARTS_DEF, pagePartsNote */

const PAGE_PARTS_DEF = { type: 'function', function: {
  name: 'page_parts',
  description: 'Header, footer, footnotes and table of contents: they are not in the numbered lines. read lists them (part null = all). set_text replaces the whole text of the header, the footer or footnote N (a missing header or footer is created). add_footnote adds a footnote with text right after after_text, an exact passage of the body. delete_footnote removes footnote N. The table of contents can only be read.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'set_text', 'add_footnote', 'delete_footnote'] },
    part: { anyOf: [{ type: 'string', enum: ['header', 'footer', 'footnote', 'toc'] }, { type: 'null' }], description: 'Which part; null with read = all; add_footnote: null.' },
    number: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Footnote number (part footnote).' },
    text: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'New plain text (set_text, add_footnote).' },
    after_text: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'add_footnote: exact body text, occurring once, that the footnote mark follows.' },
  }, required: ['action', 'part', 'number', 'text', 'after_text'], additionalProperties: false },
} };

// Removing this many characters from a header, footer or footnote asks first (the gate's "large").
const PART_GATE_CHARS = 300;
// read output cap (many long footnotes); the rest is named so the model can read it footnote by footnote.
const PART_READ_MAX_CHARS = 8000;
const TOC_ERROR = 'Error: the table of contents cannot be changed through the Google Docs API; it is updated in Google Docs (click the table of contents → Update).';
const KIND_ERROR = 'Error: page_parts changes only the default header and footer (part "header" or "footer"); a first-page or even-page header or footer cannot be created or changed here. Change it in Google Docs.';
const PART_ERROR = 'Error: part must be "header", "footer", "footnote" (with number) or "toc".';
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
const clipStart = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const pluralOf = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// { action, part, number } of the arguments, or { error }. 'footnote 2' and 'table of contents' are accepted.
function parseArgs(a) {
  const action = String(a.action == null ? '' : a.action).trim().toLowerCase();
  let part = a.part == null ? '' : String(a.part).trim().toLowerCase();
  let number = a.number == null || a.number === '' ? null : Number(a.number);
  const m = /^footnote\s*#?\s*(\d+)$/.exec(part);
  if (m) { part = 'footnote'; number = Number(m[1]); }
  if (part === 'table of contents' || part === 'contents') part = 'toc';
  if (/\b(first|even)\b/.test(part)) return { action, error: KIND_ERROR };
  if (part && !['header', 'footer', 'footnote', 'toc'].includes(part)) return { action, error: PART_ERROR };
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
  if (out.some((l) => l.includes(OBJECT_CHAR))) out.push(OBJECT_NOTE);
  return out.join('\n');
}

// ---- Plans ----------------------------------------------------------------------------------------------
// Every plan: { requests? | steps, journal, title, done, cardText, cardLabel, region, affected, keepsLines, report?,
// gateInfo (editGateInfo of the gate) }. keepsLines: no body line moves (a mark is one character inside a line).
// The report of a segment ("In the footer:\nLines 1-1 now: …"), read on the model after the edit.
function segReport(model, segmentId, label) {
  const seg = segmentModel(model, segmentId);
  if (!seg) return `The ${label} could not be found after the edit; read it with page_parts.`;
  return `In the ${seg.label}:\n${linesReport(seg, 1, seg.lines.length)}`;
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
    if (!newText) return { error: `Error: the document has no ${part}; nothing to empty.` };
    return planCreate(model, part, newText);
  }
  const lead = fnLead(seg);
  const oldText = seg.text.slice(lead);
  const label = seg.label;
  if (oldText === newText) return { error: `Error: the ${label} already reads that; nothing to change.` };
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
    report: (m) => segReport(m, seg.segmentId, label),
    gateInfo: { large: removed.length >= PART_GATE_CHARS, what: `replaces the text of the ${label} (${pluralOf(removed.length, 'character')} removed)`,
      range: Label, excerptLabel: 'Removed text', excerpt: clipStart(removed, 300) },
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
    reportFor: (replies) => (m) => segReport(m, idOf(replies), part),
    journal: {},
    gateInfo: { large: false, what: `creates the ${part}`, range: Name, excerptLabel: `${Name} text`, excerpt: clipStart(newText, 300) },
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
    return { error: 'Error: ' + notFoundError(model, oldText, 'after_text must match the body text exactly (without the "N: " line-number prefixes); read it with read_lines or find_in_document and try again.').replace(/^old_text/, 'after_text') };
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
        report: (mm) => `${linesReport(mm, l, l)}\n${segReport(mm, idOf(replies), `footnote ${n}`)}`,
      };
    },
    gateInfo: { large: false, what: 'adds a footnote', range: `Line ${line}`, excerptLabel: 'Footnote text', excerpt: clipStart(newText, 300) },
  };
}

// delete_footnote: deleting the mark deletes the footnote (Docs keeps no footnote without a mark).
function planDeleteFootnote(model, number) {
  const f = pickFootnote(model, number);
  if (f.error) return f;
  const seg = f.seg;
  if (seg.refIndex == null) return { error: `Error: footnote ${seg.n} has no mark in the body, so it cannot be deleted here; delete it in Google Docs.` };
  const text = partText(seg);
  const line = seg.refLine;
  return {
    requests: [reqDelete(model, seg.refIndex, seg.refIndex + 1)], region: [line, line], keepsLines: true, notes: [],
    affected: (m) => { const l = lineOfIndex(m, seg.refIndex); return l ? [l.line, l.line] : [line, line]; },
    journal: { kind: 'footnote-restore', index: seg.refIndex, text: '', restore: text },
    title: `Footnote ${seg.n} deleted`, done: `deleted footnote ${seg.n} (its text was ${quote(clipStart(text, 200))})`,
    cardText: showText(text), cardLabel: 'Deleted footnote text',
    report: (m) => {
      const l = lineOfIndex(m, seg.refIndex);
      const kept = segmentModel(m, seg.segmentId) ? '\nNote: Google Docs kept the footnote text without its mark; delete it in Google Docs.' : '';
      return (l ? linesReport(m, l.line, l.line) : linesReport(m, line, line)) + kept;
    },
    gateInfo: { large: true, what: `deletes footnote ${seg.n}`, range: `Line ${line}`, excerptLabel: 'Footnote text', excerpt: clipStart(text, 300) },
  };
}

// ---- Running ----------------------------------------------------------------------------------------------
async function runPageParts(name, args, snap, ui, call) {
  const a = args || {};
  const model = snap.model;
  if (!model) return 'Error: page_parts needs the Google Docs API (a connected Google account).';
  const p = parseArgs(a);
  if (p.action === 'read') return readParts(model, a);
  if (!['set_text', 'add_footnote', 'delete_footnote'].includes(p.action)) return 'Error: action must be "read", "set_text", "add_footnote" or "delete_footnote".';
  if (p.error) return p.error;
  if (p.part === 'toc') return TOC_ERROR;
  let plan;
  if (p.action === 'set_text') plan = planSetText(model, p.part, p.number, a.text);
  else if (p.action === 'add_footnote') {
    if (p.part && p.part !== 'footnote') return `Error: add_footnote adds a footnote to the body; pass part null (a ${p.part} cannot get one).`;
    plan = planAddFootnote(model, a);
  } else {
    if (p.part && p.part !== 'footnote') return `Error: delete_footnote deletes footnotes only; to empty the ${p.part} use set_text with text "".`;
    plan = planDeleteFootnote(model, p.number);
  }
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
  const ctrlZ = 'Use Undo (Ctrl+Z) in Google Docs instead.';
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
// "Page parts: header, footer, 3 footnotes, a table of contents before line 2; read them with page_parts." or ''.
function pagePartsNote(snap) {
  const m = snap && snap.model;
  if (!m) return '';
  const names = [...new Set((m.segments || []).filter((s) => s.type !== 'footnote').map((s) => (s.kind ? s.label : s.type)))];
  const fns = segsOf(m, 'footnote').length;
  if (fns) names.push(pluralOf(fns, 'footnote'));
  if (m.toc) names.push(`a table of contents before line ${m.toc.beforeLine}`);
  return names.length ? `Page parts: ${names.join(', ')}; read them with page_parts.` : '';
}

// ---- Registration ----------------------------------------------------------------------------------------
const offersPageParts = (mode, snap) => !!snap && snap.docFormat === 'docs-api' && !!snap.model;
const isPartsRead = (name, args) => String((args && args.action) || '').trim().toLowerCase() === 'read';
const partName = (a) => (a.part == null ? '' : String(a.part)) + (a.number != null && a.number !== '' ? ` ${a.number}` : '');
registerTools([PAGE_PARTS_DEF], {
  offer: offersPageParts,
  reading: isPartsRead,
  run: runPageParts,
  icon: '📎',
  pending: 'Changing a page part…',
  summary: (name, a) => {
    const act = String(a.action || '');
    if (act === 'add_footnote') return `add_footnote after «${clipEnd(String(a.after_text || '').replace(/\s+/g, ' '), 40)}»`;
    return `${act} ${partName(a)}`.trim();
  },
  gate: (name, plan) => (plan && plan.gateInfo) || null,
  prompt: [
    { section: 'reading', line: '- page_parts(action "read", part, number): the header, footer, footnotes (with the line of each mark) and the table of contents; they are not in the numbered lines.' },
    { section: 'edit', when: (mode, snap) => apiEditing(mode, snap), line: '- page_parts(action, part, number, text, after_text): set_text replaces the whole text of the header, the footer or footnote N (a missing header or footer is created); add_footnote adds a footnote with text right after after_text (exact body text); delete_footnote removes footnote N. The table of contents is read-only.' },
  ],
  docNote: pagePartsNote,
});
registerUndoHandler('footnote-restore', undoFootnoteRestore);

// ---- Self-test (Docs API mode, after "Write: lists": the two test lines are in the document) ---------------
const ST_FOOTER = 'Munin self-test footer';
const ST_FOOTNOTE = 'Munin self-test footnote';
const stPartsArgs = (over) => ({ action: 'read', part: null, number: null, text: null, after_text: null, ...over });
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
