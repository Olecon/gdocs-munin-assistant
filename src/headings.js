'use strict';
// Module headings.js: heading numbers and the outline check (Docs API documents, no model call).
// - Heading numbers (format_lines numbers: set | typed | clear, planNumberHeadings). set: Google Docs' own numbering, a
//   NUMBERED_DECIMAL_NESTED list ("1.", "1.1.", "1.1.1.") on the headings h1–h3 (title and subtitle never, nor a heading
//   used as the title: headingDepths) that renumbers itself when sections move; typed numbers in the heading texts are
//   stripped in the same batch, and the headings get the formatting sheet's text values they do not set themselves; the
//   headings Docs numbered before outside the range join the list (one numbering); the number starts at the body text's
//   left edge (numberingIndents). typed: hierarchical numbers ("1 ", "2.1 ") written into the texts, replacing leading
//   numbers they already have ("1.", "2.1.", "I.", "A."); with a prefix ("S1 ", "S1.1 ", "A.1 ") a numbering of the range
//   alone. clear: removes both (typed numbers with a prefix when the call gives it). One batchUpdate, verified by the
//   re-read (a list drawn otherwise is made again once: repair), one journal entry ('heading-list' for the list,
//   'number-headings' for typed numbers), undone in one batch.
// - The structure check: at 'finish' of a turn that edited the document, the outline as the turn left it is compared
//   with the outline at its start; what is new among duplicated or skipped heading numbers (typed, or the list numbers of
//   headings in a nested list; a number typed in a body line in between is named as such), level jumps (H1 → H3), body
//   text left in a heading style right after a heading (empty headings between are passed over) and empty headings
//   becomes a row of the turn for the user (two findings, all of them in its fold) and one line in the next turn's
//   context (beforeTurn), while it is still true. Numbers Docs draws in its lists are not checked for gaps.
/* global addTurnRow, docsBatchUpdate, fetchDocModel, inexactLine, inheritedIndent, inheritedTextValues, journalEntries, lineList, LIST_PRESETS, NOT_UNDONE,
   oneLine, ptDimension, rangeStyles, registerTurnHook, registerUndoHandler, reqBulletsOff, reqBulletsOn, reqDelete, reqInsert, reqParaStyle, reqTextStyle,
   restoredStyles, sheetEntry, sheetLineRequests, sheetNumbersNotes, showText, turnStartIndex */
/* exported HEADING_NUMBER_RE, headingDepths, docTitleHeading, listNumbers, planNumberHeadings, undoNumberHeadings, undoHeadingList, numberIndent,
   numberedHeadingIndent, numberingShown, numbersNote, sameIndent, typedNumberOnly,
   structureFindings, structureFinish, structureLine, structureNotice */

// A leading heading number with the spaces after it: "2", "2.1", "2.1." (at most two digits per part, so a year such
// as "2020 in review" stays), "1)", a Roman numeral up to 39 with "." or ")", one capital letter with "." or ")".
const HEADING_NUMBER_RE = /^(?:\d{1,2}(?:\.\d{1,2})*\.?|\d{1,2}\)|(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})[.)]|[A-ZА-Я][.)])[ \t\u00a0]+/u;
// prefix: the letters typed numbers carry ("S" for S1, S1.1; "A." for A.1), given by the call; a number with it is
// recognised only then, so a heading such as "T1 relaxation" is never taken for a number on a guess.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function headingNumberOf(text, prefix = '') {
  const m = (prefix && new RegExp(`^${escapeRe(prefix)}\\d{1,2}(?:\\.\\d{1,2})*\\.?[ \\t\\u00a0]+`, 'u').exec(text)) || HEADING_NUMBER_RE.exec(text);
  return m ? m[0] : '';
}
const HEADING_STYLE_RE = /^HEADING_([1-6])$/;

// The numbered headings of a model: the lines styled h1–h6 outside tables with text, each with its depth (1 = the
// highest heading level the document uses, so a document whose top headings are h2 numbers them 1, 2, …). A title (the
// only heading of the top level, before all the others) is no numbering level: depth 0, never numbered, and the
// levels below it start at 1, so the sections under an h1 title number 1, 2, … and not 1.1, 1.2, …. a..b: only the
// headings of those lines, with the depths among them (a numbering of its own: typed numbers with a prefix).
function headingDepths(model, a = 1, b = Infinity) {
  const heads = model.lines.filter((l) => !l.cell && l.line >= a && l.line <= b && HEADING_STYLE_RE.test(l.style || '') && l.text.trim());
  const levelOf = (l) => Number(HEADING_STYLE_RE.exec(l.style)[1]);
  let top = Math.min(...heads.map(levelOf));
  const title = heads.length > 1 && levelOf(heads[0]) === top && heads.filter((l) => levelOf(l) === top).length === 1 ? heads[0] : null;
  if (title) top = Math.min(...heads.slice(1).map(levelOf));
  return heads.map((l) => ({ l, depth: l === title ? 0 : levelOf(l) - top + 1 }));
}

// The heading line that is the document's title (headingDepths' depth 0), or null; a document with a Title paragraph has
// its title there. The reading views name it ("[H1 title]"), so "the other headings" are the sections.
function docTitleHeading(model) {
  if (!model || !model.lines || model.lines.some((l) => l.style === 'TITLE' && l.text.trim())) return null;
  const top = headingDepths(model).find((h) => h.depth === 0);
  return top ? top.l : null;
}

// Heading numbers ({action: set | typed | clear, levels, start_line, end_line, prefix}; levels: the depth, for set and typed 1–3
// (default 3), for clear 1–6 (default all); format_lines passes its start and end and no levels; prefix: the letters of
// typed numbers, which typed writes and typed and clear recognise). Returns a plan for commitEdit, { reply } when nothing
// changes, or { error, short }.
function planNumberHeadings(model, args) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!['set', 'typed', 'clear'].includes(action)) return { error: 'action must be set, typed or clear', short: 'format_lines: invalid action' };
  const isNull = (v) => v === undefined || v === null || v === '' || v === 'null';
  const prefix = isNull(args.prefix) ? '' : args.prefix;
  if (prefix !== '') {
    // eslint-disable-next-line no-control-regex -- U+000B is the Docs soft line break
    if (typeof prefix !== 'string' || prefix.length > 12 || /[\n\t\u000b]|^\s|\d$/.test(prefix)) return { error: 'prefix must be the letters before the numbers, such as "S" (S1, S1.1) or "A." (A.1), not ending with a digit', short: 'format_lines: invalid prefix' };
    if (action === 'set') return { error: 'Google Docs numbering takes no prefix: use numbers typed with the prefix', short: 'format_lines: prefix with numbers set' };
  }
  const total = model.lines.length;
  const max = action === 'clear' ? 6 : 3;
  let levels = max;
  if (!isNull(args.levels)) {
    levels = Number(args.levels);
    if (!Number.isInteger(levels) || levels < 1 || levels > max) return { error: `levels must be an integer from 1 to ${max}`, short: 'format_lines: invalid levels' };
  }
  const a = isNull(args.start_line) ? 1 : Number(args.start_line);
  const b = isNull(args.end_line) ? total : Number(args.end_line);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) return { error: `start_line and end_line must be integers with 1 <= start_line <= end_line <= ${total}, or null for the whole document`, short: 'format_lines: invalid range' };
  const where = a === 1 && b === total ? 'the document' : a === b ? `line ${a}` : `lines ${a}–${b}`;
  if (action === 'set') return planListNumbers(model, a, b, levels, where);
  // clear removes the list numbering where a heading has it, otherwise the typed numbers alone.
  if (action === 'clear' && headingDepths(model).some(({ l, depth }) => depth <= levels && l.line >= a && l.line <= b && l.list)) return planListClear(model, a, b, levels, where, prefix);
  return planTypedNumbers(model, action === 'typed' ? 'set' : 'clear', a, b, levels, where, prefix);
}

const noHeadings = (where, levels, action) => ({ error: `${where} has no headings (h1–h6${levels < 6 ? `, the top ${levels} level${levels === 1 ? '' : 's'}` : ''}) to ${action === 'clear' ? 'clear' : 'number'}. Title and subtitle are never numbered; set heading styles with format_lines first`, short: 'format_lines: no headings' });
const unmappable = (l) => ({ error: inexactLine(l.line, 'give a range without it, or tell the user to change it in Google Docs'), short: 'format_lines: unmappable line' });
const suggestedLine = (l) => ({ error: `line ${l.line} contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs)`, short: 'format_lines: the line has suggested changes' });

// Typed numbers (action set: write, clear: remove). The numbers count every heading of the document (so a range inside
// section 2 numbers its subsections 2.1, 2.2, …); only the headings in the range are written. A level that is skipped
// counts as 0 ("1.0.1"); the structure check names the jump. A title (depth 0) loses a number it has (one an earlier
// numbering gave it) and gets none. With a prefix the range is a numbering of its own (supporting information S1, S2
// after the paper's sections; an appendix's A.1, A.2), counted from 1 with the depths and the title of the range alone.
function planTypedNumbers(model, action, a, b, levels, where, prefix = '') {
  const heads = prefix ? headingDepths(model, a, b) : headingDepths(model);
  const counters = [];
  const changes = [];
  let inRange = 0;
  for (const { l, depth } of heads) {
    if (depth > levels) continue;
    if (depth) {
      counters.length = depth;
      for (let k = 0; k < depth; k++) counters[k] = counters[k] || 0;
      counters[depth - 1]++;
    }
    if (l.line < a || l.line > b) continue;
    const old = headingNumberOf(l.text, prefix);
    if (!l.text.slice(old.length).trim()) continue; // only a number: nothing to number
    if (depth || action === 'clear') inRange++;
    const now = action === 'set' && depth ? prefix + counters.join('.') + ' ' : '';
    if (old === now) continue;
    if (!l.exact) return unmappable(l);
    if (l.suggested) return suggestedLine(l);
    changes.push({ l, old, now });
  }
  if (!inRange) return noHeadings(where, levels, action);
  if (!changes.length) {
    const what = action === 'set' ? 'already numbered this way' : 'not numbered';
    return { reply: { content: `No change: the ${inRange} heading${inRange === 1 ? ' in ' + where + ' is' : 's in ' + where + ' are'} ${what}.`, _ok: true, _message: 'No change: headings' } };
  }
  // Back to front, so the indices of the earlier headings stay valid; the journal keeps each heading's index in the
  // document as the edit leaves it (the changes before it shift it).
  const requests = [];
  for (const c of changes.slice().reverse()) {
    if (c.old) requests.push(reqDelete(model, c.l.start, c.l.start + c.old.length));
    if (c.now) requests.push(reqInsert(model, c.l.start, c.now));
  }
  let shift = 0;
  let expectText = '';
  let from = 0;
  const parts = changes.map((c) => {
    const after = c.now + c.l.text.slice(c.old.length);
    const st = c.old ? rangeStyles(model, c.l.start, c.l.start + c.old.length) : [];
    const part = { index: c.l.start + shift, text: c.now, restore: c.old, after, line: c.l.line, ...(st.length ? { restoreStyles: st } : {}) };
    shift += c.now.length - c.old.length;
    expectText += model.text.slice(from, c.l.off) + c.now;
    from = c.l.off + c.old.length;
    return part;
  });
  expectText += model.text.slice(from);
  const lines = changes.map((c) => c.l.line);
  // set: the title whose number goes is named apart from the numbered headings
  const titleLine = action === 'set' ? (changes.find((c) => !c.now) || {}).l : null;
  const numbered = titleLine ? lines.filter((k) => k !== titleLine.line) : lines;
  const n = numbered.length;
  const noun = `${n} heading${n === 1 ? '' : 's'}`;
  const setDone = [n ? `numbered ${noun} on ${n === 1 ? 'line' : 'lines'} ${lineList(numbered)}` : '',
    titleLine ? `removed the number of the title on line ${titleLine.line}` : ''].filter(Boolean).join('; ');
  return {
    requests, region: [lines[0], lines[lines.length - 1]], keepsLines: true, expectText,
    journal: { kind: 'number-headings', changes: parts, anchor: false },
    title: action === 'set' ? (n ? `Numbered ${noun}` : 'Removed the number of the title') : `Removed the numbers of ${noun}`,
    done: action === 'set' ? setDone : `removed the numbers of ${noun} on ${n === 1 ? 'line' : 'lines'} ${lineList(lines)}`,
    cardText: showText(parts.map((p) => p.after).join('\n')), cardLabel: 'Headings',
    affected: () => [lines[0], lines[lines.length - 1]],
  };
}

// Undo of a 'number-headings' entry: every changed heading must still read as the edit left it, at its index or, when
// text above it moved, as the only heading line with that text; then one batch puts the old numbers back with their own
// text styles (restoreStyles; Docs would give them the heading text's).
const NUMBERS_CTRL_Z = `the headings of that edit changed after it, ${NOT_UNDONE}`;
async function undoNumberHeadings(edit) {
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const found = (edit.changes || []).map((c) => {
    let l = model.lines.find((x) => x.start === c.index && x.text === c.after && x.heading);
    if (!l) { const same = model.lines.filter((x) => x.text === c.after && x.heading && !x.cell); if (same.length === 1) l = same[0]; }
    if (!l || !l.exact || l.suggested) throw new Error(NUMBERS_CTRL_Z);
    return { l, c };
  });
  if (!found.length || new Set(found.map((f) => f.l.line)).size !== found.length) throw new Error(NUMBERS_CTRL_Z);
  const requests = [];
  for (const { l, c } of found.slice().sort((x, y) => y.l.start - x.l.start)) {
    if (c.text) requests.push(reqDelete(model, l.start, l.start + c.text.length));
    if (c.restore) requests.push(reqInsert(model, l.start, c.restore), ...restoredStyles(model, l.start, c.restore.length, c.restoreStyles));
  }
  await docsBatchUpdate(model, requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const n = found.length;
  return { model: now, restored: '', lostObjects: false, lines: found.map((f) => f.l.line).sort((x, y) => x - y),
    what: `undid the heading numbers of ${n} heading${n === 1 ? '' : 's'}` };
}

registerUndoHandler('number-headings', undoNumberHeadings);

// ---- Google Docs numbering (a nested list on the headings) ------------------------------------------------------------
// What the API does (development/tools/real-docs.js facts num1–num4, on the real API): createParagraphBullets makes one
// list of the paragraphs of its range, a new list per request unless the paragraph right before the range is an item of
// a list with the same preset (the range then joins that list, its levels counted from that item's). A paragraph's
// nesting level is its depth, its leading tabs (which Docs deletes) plus its first-line indent (its own, else its named
// style's) in whole steps of 36 pt, counted from the shallowest paragraph of the range: two adjacent H3s alone become
// level 0. A paragraph that has a bullet already keeps it (and its tabs) and draws the plain ones of the range into its
// list. deleteParagraphBullets leaves level × 36 pt on the paragraph, so a heading numbered before added its old level to
// the new one (a saved chat: H3s at L3, H4s at L5). So every list here is made over one span of paragraphs without a
// bullet (theirs go first), each with an explicit 0/0 indent (a reset falls back to the named style's, which counts too),
// the levels as tabs, and a paragraph at depth 0 in the range: when the levels start deeper, a plain line next to it (an
// anchor) is numbered with it and loses its bullet again. The other paragraphs of the span lose the bullet the request
// gave them and get their tabs back; a list that was in the span (bullets between the headings) is made again with its
// kind and levels (as a new list, as format_lines undo does). The indents come last: the headings' numbering indents, the
// others their own, one without an indent of its own an explicit 0 (Docs keeps a list's indent when the field is only reset).
const NESTED_PRESET = 'NUMBERED_DECIMAL_NESTED';
const NEW_LIST = 'new';
const leadTabs = (t) => /^\t*/.exec(t)[0].length;
const presetOf = (list) => (list.nested ? NESTED_PRESET : LIST_PRESETS[list.kind] || LIST_PRESETS.bullet);
const priorList = (l) => (l.list ? { key: l.list.listId, level: l.list.level, preset: presetOf(l.list) } : null);
const paraIndent = (l) => ({ indentStart: (l.para || {}).indentStart ?? null, indentFirstLine: (l.para || {}).indentFirstLine ?? null });
// The indents a paragraph of the span that ends without a bullet gets back: its own, an unset one as an explicit 0.
const bodyIndent = (l) => ({ indentStart: (l.para || {}).indentStart ?? 0, indentFirstLine: (l.para || {}).indentFirstLine ?? 0 });
const INDENT_FIELDS = ['indentStart', 'indentFirstLine'];
// The updateParagraphStyle fields of indents v: the values given, the others reset (null).
const indentStyle = (v) => Object.fromEntries(INDENT_FIELDS.filter((f) => v[f] != null).map((f) => [f, ptDimension(v[f])]));
// A heading Docs numbers in a nested list ("1.", "1.1."), the kind numbers: set makes.
const isNumberedHeading = (l) => !l.cell && HEADING_STYLE_RE.test(l.style || '') && !!l.list && l.list.kind === 'number' && !!l.list.nested;

// The indents of a numbered heading, the product's standard: the number starts at the left edge of the body text and the
// heading text follows it after half an em. Docs draws a list number with its END at the first-line indent and the text
// at the start indent (chrome-check line-starts), so per level the first-line indent is the body's start plus the width
// of the level's longest number at its size, estimated from the advance widths of digits and periods. numbers: the
// formatting sheet's numbers entry ({ starts: [pt, pt, pt] }: the text position per level, the number ending at the
// margin; { docs: true }: Google Docs' own list indents, written explicitly so a former indent does not stay). std: the
// standard's indents per level (numberingIndents); a level without them: 0/0. "numbers 0/0/0" is the standard written out.
const docsListIndent = (level) => ({ indentStart: 36 + 36 * level, indentFirstLine: 18 + 36 * level });
function numberIndent(level, numbers, std = []) {
  if (numbers && numbers.docs) return docsListIndent(level);
  if (numbers && numbers.starts && numbers.starts.some(Boolean)) return { indentStart: numbers.starts[Math.min(level, numbers.starts.length - 1)], indentFirstLine: 0 };
  return std[level] || { indentStart: 0, indentFirstLine: 0 };
}
// Advance widths in em of a digit and of the period (digits are tabular in these fonts); any other font: Arial's, which
// errs wide, so its number stays inside the text column.
const NUMBER_EM = { 'Times New Roman': [0.5, 0.25], Arial: [0.556, 0.278], Calibri: [0.507, 0.252], Roboto: [0.562, 0.263], 'Courier New': [0.6, 0.6] };
const NUMBER_GAP_EM = 0.5;
const DOCS_HEADING_SIZES = { HEADING_1: 20, HEADING_2: 16, HEADING_3: 14, HEADING_4: 12, HEADING_5: 11, HEADING_6: 11 };
const halfUp = (x) => Math.ceil(x * 2 - 1e-6) / 2;
// The font and size of the number Docs draws on heading l (its newline's, which number_headings gives the style of the
// text at offset at): the run's own, else the sheet's, else the named style's, else Docs' defaults.
function numberFace(model, l, at = 0) {
  const r = (l.runs || []).find((x) => x.s <= at && at < x.e) || {};
  const v = sheetEntry(model.sheet, l.style) || {};
  const inh = inheritedTextValues(model.named, l.style);
  return { font: r.font || v.font || inh.font || 'Arial', size: r.size || v.size || inh.size || DOCS_HEADING_SIZES[l.style] || 11 };
}
// The left edge of the body text: the start indent most body paragraphs draw (own, else inherited); 0 without any.
function bodyStart(model) {
  const inh = inheritedIndent(model.named, 'NORMAL_TEXT');
  const counts = new Map();
  for (const l of model.lines || []) {
    if (l.cell || l.list || l.heading || (l.style && l.style !== 'NORMAL_TEXT') || !l.text.trim()) continue;
    const v = (l.para || {}).indentStart ?? (inh ? inh.indentStart : 0);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = 0;
  let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}
// The standard indents per level 0–2 of the numbered headings items ([{ l, level, number: as Docs draws it ("2.1."), at:
// the offset of the heading text in l.text }]): [{ indentFirstLine, indentStart } or null (no heading at that level)].
function numberingIndents(model, items) {
  const base = bodyStart(model);
  return [0, 1, 2].map((k) => {
    const xs = items.filter((x) => x.level === k);
    if (!xs.length) return null;
    let w = 0;
    let size = 0;
    for (const x of xs) {
      const f = numberFace(model, x.l, x.at || 0);
      const [digit, other] = NUMBER_EM[f.font] || NUMBER_EM.Arial;
      const digits = x.number.replace(/\D/g, '').length;
      w = Math.max(w, f.size * (digits * digit + (x.number.length - digits) * other));
      size = Math.max(size, f.size);
    }
    const first = halfUp(base + w);
    return { indentFirstLine: first, indentStart: halfUp(first + size * NUMBER_GAP_EM) };
  });
}
// The standard indents of a document's numbered headings as they are (their list numbers), cached per model.
const docIndents = new WeakMap();
function docNumberingIndents(model) {
  if (!docIndents.has(model)) {
    const nums = listNumbers(model);
    const items = (model.lines || []).filter((l) => isNumberedHeading(l) && l.list.level <= 2 && nums.has(l.line))
      .map((l) => ({ l, level: l.list.level, number: `${nums.get(l.line).join('.')}.` }));
    docIndents.set(model, numberingIndents(model, items));
  }
  return docIndents.get(model);
}
// Whether line l draws the indents want: its own, else its named style's (inheritedIndent with named, or with want.named
// that numberedHeadingIndent adds), never its list level's (Docs draws a list item without an indent of its own at its
// named style's). Named styles not read: an unset indent matches nothing, so the caller writes the indent it wants.
const sameIndent = (l, want, named = want.named) => {
  const p = l.para || {};
  const inh = inheritedIndent(named, l.style) || {};
  return (p.indentStart ?? inh.indentStart) === want.indentStart && (p.indentFirstLine ?? inh.indentFirstLine) === want.indentFirstLine;
};
// The indents the sheet wants on a heading line that Docs numbers (a heading in a nested numbered list, levels 0–2,
// outside tables; with numbers docs the list level's own indents, written on the line; without a numbers entry the
// standard of the document's numbering), or null for any other line; with the model's named styles (model.named) for
// sameIndent. For apply_sheet and the formatting view.
function numberedHeadingIndent(model, l) {
  if (!isNumberedHeading(l) || l.list.level > 2) return null;
  const numbers = model.sheet && model.sheet.numbers;
  const want = numbers && numbers.docs && l.list.indent ? { indentStart: l.list.indent.start || 0, indentFirstLine: l.list.indent.first || 0 }
    : numberIndent(l.list.level, numbers, docNumberingIndents(model));
  return { ...want, named: model.named || null };
}
// Line l of model for the formatting view: a numbered heading whose own indents are the numbering's (numberedHeadingIndent)
// is marked numberIndent, so its tag leaves them out ("h2 number", not "h2 number indent 17.5/10.5").
function numberingShown(model, l) {
  const p = l.para || {};
  if (!model || p.indentStart == null || p.indentFirstLine == null) return l;
  const want = numberedHeadingIndent(model, l);
  return want && sameIndent(l, want) ? { ...l, numberIndent: true } : l;
}
// The paragraph values a numbered heading keeps as they are (the numbering owns the indents); the sheet's text values,
// alignment and paragraph spacing apply.
const NUMBER_SHEET_EXPLICIT = ['lineSpacing', 'indentFirstLine'];

// Lines split where the indices are not contiguous (a table, a cell boundary, a line left out).
function indexGroups(lines) {
  const out = [];
  lines.forEach((l, k) => { if (k && lines[k - 1].end + 1 === l.start) out[out.length - 1].push(l); else out.push([l]); });
  return out;
}

// The requests that give the lines of span (consecutive lines of model, the text unchanged) the lists target(l) names
// ({ key, level, preset } or null) and the indents indent(l) gives ({ indentStart, indentFirstLine }, null = the named
// style's). The lines whose key is spanKey become ONE list over their span; the other lists are made per run of
// consecutive lines. near(n): line n of model (the same objects as span's), for an anchor. Every request keeps the
// indices as they were (the tabs inserted for the levels are deleted by Docs again, the tabs Docs deletes are inserted
// again).
function listStateRequests(model, span, target, spanKey, indent, near = () => null) {
  const out = [];
  for (const g of indexGroups(span)) if (g.some((l) => l.list)) out.push(reqBulletsOff(model, g[0].start, g[g.length - 1].end + 1));
  // An explicit 0/0 on every line first: an indent left by a bullet, or a named style's, would add to the levels.
  for (const g of indexGroups(span)) out.push(reqParaStyle(model, g[0].start, g[g.length - 1].end + 1, indentStyle({ indentStart: 0, indentFirstLine: 0 }), INDENT_FIELDS));
  const inSpan = new Set(span);
  const lent = []; // anchors outside the span: their indents back at the end
  // A plain line right before or after range (no bullet when the request runs, no tab), not after an item of a nested
  // list (the range would join that list).
  const anchorFor = (range) => {
    const first = range[0];
    const last = range[range.length - 1];
    const free = (l) => (inSpan.has(l) ? !target(l) : !l.list);
    for (const [l, next] of [[near(first.line - 1), first], [near(last.line + 1), null]]) {
      if (!l || l.cell || !l.exact || l.suggested || leadTabs(l.text) || !free(l)) continue;
      if (next ? l.end + 1 !== next.start : last.end + 1 !== l.start) continue;
      const b = next ? near(l.line - 1) : null;
      if (b && !inSpan.has(b) && b.list && b.list.nested) continue;
      return l;
    }
    return null;
  };
  // The levels as tabs (back to front, so the earlier indices stay), then one createParagraphBullets over range;
  // level(l) null: a line of the range that is not an item (its own tabs are its depth). Returns the anchor taken in.
  const bullets = (range, level, preset) => {
    const a = Math.min(...range.map((l) => level(l) ?? leadTabs(l.text))) > 0 ? anchorFor(range) : null;
    if (a && !inSpan.has(a)) { out.push(reqParaStyle(model, a.start, a.end + 1, indentStyle({ indentStart: 0, indentFirstLine: 0 }), INDENT_FIELDS)); lent.push(a); }
    const lines = !a ? range : a.line < range[0].line ? [a, ...range] : [...range, a];
    let tabs = 0;
    for (const l of lines.slice().reverse()) {
      const lv = l === a ? 0 : level(l);
      if (lv > 0) { out.push(reqInsert(model, l.start, '\t'.repeat(lv))); tabs += lv; }
    }
    out.push(reqBulletsOn(model, lines[0].start, lines[lines.length - 1].end + 1 + tabs, preset));
    return a;
  };
  const members = spanKey == null ? [] : span.filter((l) => { const t = target(l); return !!t && t.key === spanKey; });
  if (members.length) {
    const inner = span.slice(span.indexOf(members[0]), span.indexOf(members[members.length - 1]) + 1);
    const isMember = new Set(members);
    const a = bullets(inner, (l) => (isMember.has(l) ? target(l).level : null), target(members[0]).preset);
    const others = inner.filter((l) => !isMember.has(l));
    let removed = 0;
    const back = [];
    for (const l of others) { const n = leadTabs(l.text); if (n) back.push([l.start - removed, n]); removed += n; }
    for (const [at, n] of back.reverse()) out.push(reqInsert(model, at, '\t'.repeat(n)));
    for (const g of indexGroups(a ? [...others, a].sort((x, y) => x.start - y.start) : others)) out.push(reqBulletsOff(model, g[0].start, g[g.length - 1].end + 1));
  }
  const runs = [];
  span.forEach((l, k) => {
    const t = target(l);
    if (!t || t.key === spanKey) return;
    const run = runs[runs.length - 1];
    const p = span[k - 1];
    if (run && run[run.length - 1] === p && target(p).key === t.key && p.end + 1 === l.start) run.push(l); else runs.push([l]);
  });
  for (const run of runs.reverse()) {
    const a = bullets(run, (l) => target(l).level, target(run[0]).preset);
    if (a) out.push(reqBulletsOff(model, a.start, a.end + 1));
  }
  // The indents last, so they win over the ones the bullets set; one request per stretch of equal indents.
  for (const g of indexGroups(span)) {
    for (let i = 0; i < g.length;) {
      const v = indent(g[i]);
      const key = JSON.stringify(v);
      let j = i + 1;
      while (j < g.length && JSON.stringify(indent(g[j])) === key) j++;
      if (v) out.push(reqParaStyle(model, g[i].start, g[j - 1].end + 1, indentStyle(v), INDENT_FIELDS));
      i = j;
    }
  }
  for (const a of lent) out.push(reqParaStyle(model, a.start, a.end + 1, indentStyle(paraIndent(a)), INDENT_FIELDS));
  return out;
}

// The list a group of headings shares before an edit (the most frequent listId among them), or null.
function headingListKey(lines) {
  const n = new Map();
  for (const l of lines) if (l.list) n.set(l.list.listId, (n.get(l.list.listId) || 0) + 1);
  let best = null;
  for (const [k, c] of n) if (best === null || c > n.get(best)) best = k;
  return best;
}

// The text of model with the typed numbers of strips ([{ l, old }] in document order) removed, from offset from to to.
function textWithout(model, strips, from = 0, to = model.text.length) {
  let out = '';
  for (const x of strips) { out += model.text.slice(from, x.l.off); from = x.l.off + x.old.length; }
  return out + model.text.slice(from, to);
}

// The journal of a 'heading-list' edit: the span (index and text as the edit leaves them) and per line its offset in
// that text and its list and indents before the edit; numbers: the typed numbers the edit stripped ({ rel, text,
// restoreStyles: their own text styles, rangeStyles }).
function headingListJournal(model, span, strips) {
  const cut = new Map(strips.map((x) => [x.l.line, x.old.length]));
  let removed = 0;
  const rel = new Map();
  const lines = span.map((l) => {
    rel.set(l.line, l.off - span[0].off - removed);
    removed += cut.get(l.line) || 0;
    return { rel: rel.get(l.line), list: priorList(l), indent: paraIndent(l) };
  });
  const last = span[span.length - 1];
  return { kind: 'heading-list', index: span[0].start, text: textWithout(model, strips, span[0].off, last.off + last.text.length), lines,
    spanKey: headingListKey(span.filter((l) => l.heading)), anchor: false,
    numbers: strips.map((x) => { const st = rangeStyles(model, x.l.start, x.l.start + x.old.length); return { rel: rel.get(x.l.line), text: x.old, ...(st.length ? { restoreStyles: st } : {}) }; }) };
}

// The sheet's values for the headings heads (lines of model) and their undo: { requests (on model's indices),
// undo: [{ line (offset of the heading in the journal text, as headingListJournal's rel), styles: [{ s, e, textStyle,
// fields }] (offsets in the heading's text after its typed number is gone), paras: [{ paragraphStyle, fields }] (the
// prior paragraph values) }], filled: the done text's words for the text values written, or '' }. A heading's text
// keeps the values it sets itself (the user's formatting) and its number follows the text (sheetLineRequests fill).
function sheetUndoParts(model, heads, strips) {
  const cut = new Map(strips.map((x) => [x.l.line, x.old.length]));
  const requests = [];
  const undo = [];
  const filled = new Map(); // namedStyleType -> the text fields written on its headings
  for (const l of heads) {
    const v = sheetEntry(model.sheet, l.style);
    if (!v) continue;
    const d = l.start + (cut.get(l.line) || 0);
    const r = sheetLineRequests(model, [{ l, v, glyphAt: d }], NUMBER_SHEET_EXPLICIT, true);
    if (!r.requests.length) continue;
    requests.push(...r.requests);
    const fields = r.filled.flatMap((x) => x.fields);
    if (fields.length) filled.set(l.style, new Set([...(filled.get(l.style) || []), ...fields]));
    const styles = r.inverse.map((q) => q.updateTextStyle).filter(Boolean)
      .map((u) => ({ s: Math.max(0, u.range.startIndex - d), e: u.range.endIndex - d, textStyle: u.textStyle, fields: u.fields.split(',') }))
      .filter((x) => x.e > x.s);
    const paras = r.inverse.map((q) => q.updateParagraphStyle).filter(Boolean).map((u) => ({ paragraphStyle: u.paragraphStyle, fields: u.fields.split(',') }));
    if (styles.length || paras.length) undo.push({ heading: l.line, styles, paras });
  }
  return { requests, undo, filled: filledText(model.sheet, filled) };
}

// The done text's words for the sheet's text values number_headings wrote (filled: namedStyleType -> fields), by heading
// type as the Formatting line names them, a font all of them got named once: "formatting sheet values added where the
// heading text had none: Times New Roman, h1 16 pt, h2 14 pt".
function filledText(sheet, filled) {
  const words = { weightedFontFamily: (v) => v.font, fontSize: (v) => `${v.size} pt`, bold: (v) => (v.bold ? 'bold' : 'regular'), italic: (v) => (v.italic ? 'italic' : 'upright') };
  const all = [...filled].sort(([a], [b]) => a.localeCompare(b)).map(([style, fields]) => ({ style, fields, v: sheetEntry(sheet, style) }));
  const fonts = new Set(all.map((x) => (x.fields.has('weightedFontFamily') ? x.v.font : null)));
  const font = fonts.size === 1 && !fonts.has(null) ? [...fonts][0] : '';
  const parts = all.map(({ style, fields, v }) => {
    const w = Object.keys(words).filter((f) => fields.has(f) && !(font && f === 'weightedFontFamily')).map((f) => words[f](v));
    return w.length ? `h${HEADING_STYLE_RE.exec(style)[1]} ${w.join(' ')}` : '';
  });
  const list = [font, ...parts].filter(Boolean);
  return list.length ? `formatting sheet values added where the heading text had none: ${list.join(', ')}` : '';
}

// A heading-list journal with the sheet's undo (sheetUndo: [{ rel (the heading's offset in the journal text), styles, paras }]).
function withSheetUndo(journal, undo, firstLine) {
  if (!undo.length) return journal;
  return { ...journal, sheetUndo: undo.map((u) => ({ rel: journal.lines[u.heading - firstLine].rel, styles: u.styles, paras: u.paras })) };
}

// The typed number of a heading Google Docs is to number, with the spaces and tabs around it ("2.1 ", " 3.\t"), or its
// leading spaces and tabs alone: Docs draws the number and a tab before the text, and a leading tab would count as a level.
function numberStrip(text) {
  const ws = /^[^\S\v]*/.exec(text)[0]; // spaces, tabs, no-break spaces; not a soft line break (\v)
  return ws + headingNumberOf(text.slice(ws.length));
}
// Whether a replace of oldText by newText only takes a typed heading number off ("2.1 Methods" -> "Methods", "3." -> ""),
// which numbers set does itself.
function typedNumberOnly(oldText, newText) {
  const o = String(oldText == null ? '' : oldText);
  const cut = numberStrip(o);
  if (cut.trim() && o.slice(cut.length).trim() === String(newText == null ? '' : newText).trim()) return true;
  return /^\s*\d{1,2}(?:\.\d{1,2})*\.?\s*$/.test(o) && !String(newText == null ? '' : newText).trim();
}
// The lines of model as the deletions of strips ([{ l, old }]: the first old.length characters of line l) leave them:
// start, end and text moved (a line without a strip only moved), the other fields as they are.
function strippedLines(model, strips) {
  const cut = new Map(strips.map((x) => [x.l.line, x.old.length]));
  let before = 0;
  return model.lines.map((l) => {
    const c = cut.get(l.line) || 0;
    const v = c || before ? { ...l, start: l.start - before, end: l.end - before - c, text: l.text.slice(c) } : l;
    before += c;
    return v;
  });
}

// One note for the re-read checks cs of numbering parts (planListNumbers' check: { wrong: [{ line, want, got: level, null
// (no number) or 'other' (another list) }], stray, flat, title }; planListClear's: { kept }): per line what Docs drew
// against the plan, and the one next step; '' when all is as planned. retried: after finishEdit's second try (repair).
const NUMBERS_NOTE_MAX = 8;
function numbersNote(cs, retried = false) {
  const parts = [];
  let levels = false;
  for (const c of cs) {
    for (const w of c.wrong || []) {
      parts.push(`line ${w.line} ${w.got == null ? 'has no number' : w.got === 'other' ? 'is in another list' : `is at L${w.got + 1}`} (planned L${w.want + 1})`);
      levels = levels || typeof w.got === 'number';
    }
    for (const k of c.stray || []) parts.push(`line ${k} got a number too`);
    if (c.title) parts.push(`the title on line ${c.title} kept its number`);
    for (const k of c.kept || []) parts.push(`line ${k} kept its number`);
    for (const k of c.flat || []) parts.push(`line ${k} lacks the number indent`);
  }
  if (!parts.length) return '';
  const shown = parts.slice(0, NUMBERS_NOTE_MAX).join('; ') + (parts.length > NUMBERS_NOTE_MAX ? `; and ${parts.length - NUMBERS_NOTE_MAX} more` : '');
  return `Note: Google Docs numbered the headings differently from the plan${retried ? ', also after a second try' : ''}: ${shown}. Tell the user to correct ${parts.length === 1 ? 'it' : 'them'} in Google Docs${levels ? ' (Tab or Shift+Tab at the start of a heading changes its level)' : ''}.`;
}

// numbers: set. The headings h1–h3 (levels) among lines a..b become one NUMBERED_DECIMAL_NESTED list; their typed
// numbers go, with the spaces and tabs around them. The headings outside the range that Docs numbers already in a nested
// list (an earlier numbering) are numbered with them, so the document keeps one numbering (a list of the range alone would
// start at 1 again); the other headings outside the range stay as they are. A title (depth 0) with a number, in the range
// or in such a list, loses it. The batch: the sheet's text values on the headings and the typed numbers deleted (on the
// indices as read), then the lists (listStateRequests) on the text as that leaves it.
function planListNumbers(model, a, b, levels, where) {
  const depths = headingDepths(model);
  const inRange = (l) => l.line >= a && l.line <= b;
  const fits = ({ l, depth }) => depth && depth <= levels && l.text.slice(numberStrip(l.text).length).trim();
  const own = depths.filter((h) => fits(h) && inRange(h.l));
  if (!own.length) return noHeadings(where, levels, 'set');
  const joined = depths.filter((h) => fits(h) && !inRange(h.l) && isNumberedHeading(h.l));
  const heads = [...own, ...joined].sort((x, y) => x.l.line - y.l.line);
  const t = depths.find(({ depth }) => !depth);
  const typedTitle = (l) => headingNumberOf(l.text) && l.text.slice(headingNumberOf(l.text).length).trim();
  const title = t && (inRange(t.l) ? (t.l.list && t.l.list.kind === 'number') || typedTitle(t.l) : joined.length && isNumberedHeading(t.l)) ? t.l : null;
  const first = (title || heads[0].l).line;
  const last = heads[heads.length - 1].l.line;
  const span = model.lines.slice(first - 1, last);
  const level = new Map(heads.map(({ l, depth }) => [l.line, depth - 1]));
  // The lists of the headings numbered before: the other lines of the span leave them.
  const old = new Set(heads.filter(({ l }) => isNumberedHeading(l)).map(({ l }) => l.list.listId));
  const isTitle = (l) => !!title && l.line === title.line;
  for (const l of [...(title ? [title] : []), ...heads.map((h) => h.l)]) {
    if (!l.exact) return unmappable(l);
    if (l.suggested) return suggestedLine(l);
  }
  for (const l of span) {
    if (level.has(l.line) || isTitle(l) || !leadTabs(l.text)) continue;
    if (!l.exact) return unmappable(l);
    if (l.list && !old.has(l.list.listId)) return { error: `line ${l.line} is a list item that starts with a tab, which Google Docs would delete when it numbers the headings. Remove the tab first with replace_text, or use numbers typed.`, short: 'format_lines: a list item starts with a tab' };
  }
  const strips = [...(title ? [{ l: title, old: headingNumberOf(title.text) }] : []), ...heads.map(({ l }) => ({ l, old: numberStrip(l.text) }))].filter((x) => x.old);
  const numbers = model.sheet && model.sheet.numbers;
  const notes = sheetNumbersNotes(model.sheet);
  // The numbers Docs will draw (the card, the indents).
  const counters = [];
  const items = heads.map(({ l, depth }) => {
    counters.length = depth;
    for (let k = 0; k < depth; k++) counters[k] = counters[k] || 0;
    counters[depth - 1]++;
    return { l, level: depth - 1, number: `${counters.join('.')}.`, at: numberStrip(l.text).length };
  });
  const std = numberingIndents(model, items);
  const wantIndent = (k) => numberIndent(k, numbers, std);
  const key = heads[0].l.list && heads[0].l.list.nested ? heads[0].l.list.listId : null;
  // Numbered already, with the indents wanted (a changed numbers entry or a longer number numbers them again).
  const done = key && !title && !strips.length && heads.every(({ l, depth }) => l.list && l.list.listId === key && l.list.level === depth - 1
    && sameIndent(l, wantIndent(depth - 1), model.named)) && span.every((l) => level.has(l.line) || !l.list || l.list.listId !== key);
  const n = heads.length;
  const noun = `${n} heading${n === 1 ? '' : 's'}`;
  if (done) return { reply: { content: [`No change: the ${n === 1 ? 'heading in ' + where + ' is' : noun + ' in ' + where + ' are'} already numbered by Google Docs.`, ...notes].join('\n'), _ok: true, _message: 'No change: headings' } };
  const target = (l) => (level.has(l.line) ? { key: NEW_LIST, level: level.get(l.line), preset: NESTED_PRESET }
    : isTitle(l) || (l.list && old.has(l.list.listId)) ? null : priorList(l));
  const indentOf = (l) => (level.has(l.line) ? wantIndent(level.get(l.line)) : target(l) ? paraIndent(l) : bodyIndent(l));
  // The formatting sheet's text values of their level on the headings where their text sets none, and the typed numbers
  // deleted, on the indices as read; then the lists on the text as that leaves it.
  const sheet = sheetUndoParts(model, heads.map(({ l }) => l), strips);
  const requests = [...sheet.requests];
  for (const x of strips.slice().reverse()) requests.push(reqDelete(model, x.l.start, x.l.start + x.old.length));
  const view = strippedLines(model, strips);
  const vSpan = view.slice(first - 1, last);
  requests.push(...listStateRequests(model, vSpan, target, NEW_LIST, indentOf, (k) => view[k - 1] || null));
  const lines = heads.map(({ l }) => l.line);
  const withOld = joined.length ? `, one list with the ${joined.length} numbered before outside ${where}` : '';
  const doneText = [`numbered ${noun} on ${n === 1 ? 'line' : 'lines'} ${lineList(lines)} (Google Docs numbering${withOld})`,
    ...(title ? [`removed the number of the title on line ${title.line}`] : []), ...(sheet.filled ? [sheet.filled] : [])].join('; ');
  // The re-read: every heading in one list at its level with its indents, no other line of the span in that list, the
  // title without a number. dl: the lines moved by the parts above it in an edit_document call.
  const check = (m, dl = 0) => {
    const now = heads.map(({ l, depth }) => ({ l: m.lines[l.line - 1 + dl], want: depth - 1, line: l.line + dl }));
    const id = headingListKey(now.map((x) => x.l).filter(Boolean));
    const wrong = now.filter(({ l, want }) => !id || !l || !l.list || l.list.listId !== id || l.list.level !== want)
      .map(({ l, want, line }) => ({ line, want, got: !l || !l.list ? null : l.list.listId !== id ? 'other' : l.list.level }));
    const stray = id ? m.lines.slice(first - 1 + dl, last + dl).filter((l) => !level.has(l.line - dl) && l.list && l.list.listId === id).map((l) => l.line) : [];
    const flat = now.filter(({ l, want, line }) => l && !wrong.some((w) => w.line === line) && !sameIndent(l, wantIndent(want), model.named)).map((x) => x.line);
    const tl = title ? m.lines[title.line - 1 + dl] : null;
    return { wrong, stray, flat, title: tl && tl.list && tl.list.kind === 'number' && !stray.includes(tl.line) ? tl.line : null };
  };
  // A second try when Docs drew it otherwise: the same lists made again, cleanly, on the document as re-read (m); null
  // when all is as planned or the span's text is not as this edit left it.
  const repair = (m, dl = 0) => {
    const c = check(m, dl);
    if (!c.wrong.length && !c.stray.length && !c.flat.length && !c.title) return null;
    const mSpan = m.lines.slice(first - 1 + dl, last + dl);
    if (mSpan.length !== vSpan.length || mSpan.some((l, k) => l.text !== vSpan[k].text || !l.exact || l.suggested)) return null;
    const ids = new Set(mSpan.filter((l) => level.has(l.line - dl) && l.list).map((l) => l.list.listId));
    const tgt = (l) => (level.has(l.line - dl) ? { key: NEW_LIST, level: level.get(l.line - dl), preset: NESTED_PRESET }
      : (title && l.line - dl === title.line) || (l.list && (ids.has(l.list.listId) || old.has(l.list.listId))) ? null : priorList(l));
    return listStateRequests(m, mSpan, tgt, NEW_LIST, (l) => (level.has(l.line - dl) ? wantIndent(level.get(l.line - dl)) : tgt(l) ? paraIndent(l) : bodyIndent(l)),
      (k) => m.lines[k - 1] || null);
  };
  return {
    requests, region: [first, last], keepsLines: true, expectText: textWithout(model, strips),
    journal: withSheetUndo(headingListJournal(model, span, strips), sheet.undo, first),
    title: `Numbered ${noun}`, done: doneText,
    cardText: showText(items.map((x) => `${x.number} ${x.l.text.slice(x.at)}`).join('\n')), cardLabel: 'Headings', notes,
    affected: () => [first, last],
    check, repair,
    report: (m, retried = false) => numbersNote([check(m)], retried),
  };
}

// numbers: clear on headings with list numbering: their bullets go (with the indent the list gave them) and so do their
// typed numbers (with the prefix, when given). The other headings of their lists stay numbered, and Docs counts them
// anew (a section cleared from the middle moves the ones after it up): the result names those whose number changes. The
// journal covers the span from the first to the last of them, so undo can make the list again.
function planListClear(model, a, b, levels, where, prefix = '') {
  const numberOf = (l) => headingNumberOf(l.text, prefix);
  const heads = headingDepths(model).filter(({ l, depth }) => depth <= levels && l.line >= a && l.line <= b && (l.list || numberOf(l))
    && l.text.slice(numberOf(l).length).trim()).map((h) => h.l);
  if (!heads.length) return noHeadings(where, levels, 'clear');
  for (const l of heads) {
    if (!l.exact) return unmappable(l);
    if (l.suggested) return suggestedLine(l);
  }
  const span = model.lines.slice(heads[0].line - 1, heads[heads.length - 1].line);
  const strips = heads.map((l) => ({ l, old: numberOf(l) })).filter((x) => x.old);
  const requests = [];
  for (const l of heads.filter((x) => x.list)) {
    requests.push(reqBulletsOff(model, l.start, l.end + 1));
    requests.push(reqParaStyle(model, l.start, l.end + 1, {}, INDENT_FIELDS));
  }
  for (const x of strips.slice().reverse()) requests.push(reqDelete(model, x.l.start, x.l.start + x.old.length));
  const lines = heads.map((l) => l.line);
  const n = heads.length;
  const noun = `${n} heading${n === 1 ? '' : 's'}`;
  const cleared = new Set(heads.filter((l) => l.list).map((l) => l.line));
  const was = listNumbers(model);
  const will = listNumbers({ lines: model.lines.map((l) => (cleared.has(l.line) ? { ...l, list: null } : l)) });
  const moved = [...will].filter(([k, x]) => was.has(k) && was.get(k).join('.') !== x.join('.')).map(([k]) => k);
  const check = (m, dl = 0) => ({ kept: lines.map((k) => k + dl).filter((k) => m.lines[k - 1] && m.lines[k - 1].list) });
  return {
    requests, region: [lines[0], lines[n - 1]], keepsLines: true, expectText: textWithout(model, strips),
    journal: headingListJournal(model, span, strips),
    title: `Removed the numbers of ${noun}`,
    done: `removed the numbers of ${noun} on ${n === 1 ? 'line' : 'lines'} ${lineList(lines)}${moved.length ? `; the numbers of the other headings change (${moved.length === 1 ? 'line' : 'lines'} ${lineList(moved)})` : ''}`,
    cardText: showText(heads.map((l) => l.text.slice(numberOf(l).length)).join('\n')), cardLabel: 'Headings',
    affected: () => [lines[0], lines[n - 1]],
    check, report: (m, retried = false) => numbersNote([check(m)], retried),
  };
}

// Undo of a 'heading-list' entry: the span must read as the edit left it (at its index, or as the only place with that
// text); then one batch gives every line its former list and indents back and puts the typed numbers back.
async function undoHeadingList(edit) {
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const text = edit.text || '';
  let first = model.lines.find((l) => l.start === edit.index && model.text.startsWith(text, l.off));
  if (!first) { const same = model.lines.filter((l) => model.text.startsWith(text, l.off)); if (same.length === 1) first = same[0]; }
  if (!first) throw new Error(NUMBERS_CTRL_Z);
  const at = new Map(model.lines.map((l) => [l.off, l]));
  const span = (edit.lines || []).map((x) => at.get(first.off + x.rel));
  if (!span.length || span.some((l, k) => !l || l.line !== first.line + k)) throw new Error(NUMBERS_CTRL_Z);
  const saved = new Map(span.map((l, k) => [l, edit.lines[k]]));
  for (const l of span) {
    const was = saved.get(l).list;
    if ((was || l.list) && (!l.exact || l.suggested)) throw new Error(NUMBERS_CTRL_Z);
    if (was && leadTabs(l.text)) throw new Error(NUMBERS_CTRL_Z);
  }
  // A line that loses its bullet and had no indent of its own gets an explicit 0 (a reset keeps the list's indent).
  const indentOf = (l) => { const s = saved.get(l); return !s.list && l.list ? { indentStart: s.indent.indentStart ?? 0, indentFirstLine: s.indent.indentFirstLine ?? 0 } : s.indent; };
  const requests = listStateRequests(model, span, (l) => saved.get(l).list, edit.spanKey, indentOf, (k) => model.lines[k - 1] || null);
  // The text and paragraph values the formatting sheet changed on the headings, before the typed numbers go back (on these indices).
  for (const u of edit.sheetUndo || []) {
    const l = at.get(first.off + u.rel);
    if (!l) throw new Error(NUMBERS_CTRL_Z);
    for (const x of u.styles) requests.push(reqTextStyle(model, l.start + x.s, Math.min(l.start + x.e, l.end + 1), x.textStyle, x.fields));
    for (const x of u.paras || []) requests.push(reqParaStyle(model, l.start, l.end + 1, x.paragraphStyle, x.fields));
  }
  // The typed numbers with their own text styles (Docs would give them the heading text's).
  for (const x of (edit.numbers || []).slice().reverse()) {
    const i = at.get(first.off + x.rel).start;
    requests.push(reqInsert(model, i, x.text), ...restoredStyles(model, i, x.text.length, x.restoreStyles));
  }
  await docsBatchUpdate(model, requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const [p, q] = [span[0].line, span[span.length - 1].line];
  return { model: now, restored: '', lostObjects: false, lines: [p, q], what: `undid the heading numbering of ${p === q ? `line ${p}` : `lines ${p}–${q}`}` };
}

registerUndoHandler('heading-list', undoHeadingList);

// The list numbers of the headings in a numbered list: Map line -> [1, 2] ("1.2."), counted per list in document order
// as Docs draws them on the headings (a nested list carries the numbers of the levels above, a deeper level restarts
// after a shallower one; another numbered list only at its first level). The structure check reads them, as they are
// not in the text. Only headings h1–h6 outside tables count: a body paragraph the API still reports in the heading list
// (a placeholder line between numbered headings) would otherwise shift every number after it.
function listNumbers(model) {
  const out = new Map();
  const counters = new Map();
  for (const l of (model && model.lines) || []) {
    if (!l.list || l.list.kind !== 'number' || l.cell || !l.heading || !HEADING_STYLE_RE.test(l.style || '')) continue;
    const c = counters.get(l.list.listId) || [];
    counters.set(l.list.listId, c);
    const k = Math.max(0, Number(l.list.level) || 0);
    c.length = k + 1;
    for (let i = 0; i < k; i++) c[i] = c[i] || 0;
    c[k] = (c[k] || 0) + 1;
    if (l.list.nested) out.set(l.line, c.slice());
    else if (k === 0) out.set(l.line, [c[0]]);
  }
  return out;
}

// ---- The structure check ------------------------------------------------------------------------------------------
const STRUCTURE_MAX = 5; // findings named in the next turn's context line
const STRUCTURE_NOTICE_MAX = 2; // findings named in the chat notice (the rest in its tooltip)
const HEAD_QUOTE = 40;
const quoteHead = (t) => `«${oneLine(String(t).trim(), HEAD_QUOTE)}»`;
// Text that reads as a sentence, not a heading: ends like one, or is long.
const bodyLike = (t) => { const s = t.trim(); return /[.!?…;]$/.test(s) || s.length > 100 || s.split(/\s+/).length > 14; };
const numberParts = (t) => { const m = /^(\d{1,2}(?:\.\d{1,2})*)\.?[ \t\u00a0]/.exec(t); return m ? m[1].split('.').map(Number) : null; };

// The outline problems of a model: [{ key, text }]. key leaves line numbers out, so a problem the document had before
// the turn is recognised after lines moved.
function structureFindings(model) {
  const out = [];
  if (!model || !model.lines) return out;
  const heads = model.lines.filter((l) => l.heading && !l.cell);
  let prev = null; // the previous heading with text (h1–h6)
  let prevNum = null;
  const seen = new Map();
  const listed = listNumbers(model);
  for (const l of heads) {
    const text = l.text.trim();
    const m = HEADING_STYLE_RE.exec(l.style || '');
    if (!text) {
      out.push({ key: `empty|${prev ? prev.text.trim() : ''}`, text: `line ${l.line} is an empty heading` });
      continue;
    }
    // The heading line before it, over empty headings (a sentence after an empty heading is still a stray one).
    let b = l.line - 2;
    while (b > 0 && model.lines[b].heading && !model.lines[b].cell && !model.lines[b].text.trim()) b--;
    const before = model.lines[b];
    if (before && before.heading && !before.cell && before.style === l.style && before.text.trim() && bodyLike(text)) {
      out.push({ key: `body|${text.slice(0, 60)}`, text: `${quoteHead(text)} after ${quoteHead(before.text)} is still a heading (line ${l.line})` });
    }
    if (!m) continue; // title and subtitle: no levels, no numbers
    const level = Number(m[1]);
    if (prev && level > prev.level + 1) {
      out.push({ key: `jump|${text}|${prev.level}|${level}`, text: `${quoteHead(text)} (line ${l.line}) is H${level} right after H${prev.level} ${quoteHead(prev.text)}` });
    }
    prev = { text: l.text, level };
    const fromList = listed.has(l.line);
    const parts = listed.get(l.line) || numberParts(text);
    if (!parts) continue;
    const num = parts.join('.');
    // Two numbers Docs draws in its lists cannot skip or repeat by mistake (a second list restarts on purpose): only a
    // typed number on either side can.
    const bothListed = fromList && prevNum && prevNum.fromList;
    const dup = seen.has(num) && !(fromList && seen.get(num).fromList);
    if (dup) out.push({ key: `dup|${num}`, text: `heading ${num} appears twice (lines ${seen.get(num).line} and ${l.line})` });
    else if (!seen.has(num)) seen.set(num, { line: l.line, fromList });
    if (prevNum && !dup && !bothListed) {
      // What may follow 2.1: 2.2 (same depth), 2.1.1 (one deeper) or 3 (shallower, the next number there).
      const k = parts.length;
      const from = prevNum.join('.');
      const expected = k <= prevNum.length ? [...prevNum.slice(0, k - 1), prevNum[k - 1] + 1] : k === prevNum.length + 1 ? [...prevNum, 1] : null;
      if (!expected) out.push({ key: `seq|${from}|${num}`, text: `heading ${num} follows ${from} (a level is skipped)` });
      else if (expected.join('.') !== num) {
        const want = expected.join('.');
        const skipped = parts.slice(0, -1).join('.') === expected.slice(0, -1).join('.') && parts[k - 1] > expected[k - 1];
        // The number typed at the start of a body line in between: "missing" would be false and invite restructuring.
        const typed = model.lines.slice(prevNum.line, l.line - 1).find((x) => !x.heading && !x.cell && (numberParts(x.text.trim()) || []).join('.') === want);
        const why = typed ? `${want} is body text on line ${typed.line}` : skipped ? `${want} is missing` : `expected ${want}`;
        out.push({ key: `seq|${from}|${num}`, text: `heading ${num} follows ${from} (${why})` });
      }
    }
    prevNum = Object.assign(parts.slice(), { fromList, line: l.line });
  }
  return out;
}

// The new problems of a finished turn that edited the document through the Docs API: [text] (none when the turn made no
// edit, or the document is not a Docs API model).
function structureFinish(userMsg, snap, chatCtx) {
  const start = snap && snap.promptView && snap.promptView.model;
  const end = snap && snap.docFormat === 'docs-api' ? snap.model : null;
  if (!start || !end || start.docId !== end.docId) return [];
  const msgs = (chatCtx && chatCtx.messages) || [];
  const from = userMsg ? turnStartIndex(msgs, userMsg) : -1;
  const turn = from >= 0 ? msgs.slice(from) : [];
  if (!journalEntries(turn).some((m) => m && m.role === 'tool' && m._ok && m._edit && m._edit.kind !== 'remember')) return [];
  const had = new Set(structureFindings(start).map((f) => f.key));
  return structureFindings(end).filter((f) => !had.has(f.key));
}

// Findings waiting for the next turn of the document: docId -> [{ key, text }].
const structurePending = new Map();
const structureText = (fs) => fs.slice(0, STRUCTURE_MAX).map((f) => f.text).join('; ') + (fs.length > STRUCTURE_MAX ? `; and ${fs.length - STRUCTURE_MAX} more` : '');
// The chat notice of a turn's findings: { text (at most STRUCTURE_NOTICE_MAX of them, then "and N more"), title (the
// full list, one per line, for the tooltip; empty when the text names them all) }.
function structureNotice(fs) {
  const shown = fs.slice(0, STRUCTURE_NOTICE_MAX).map((f) => f.text).join('; ');
  const more = fs.length - STRUCTURE_NOTICE_MAX;
  return { text: `Structure check: ${shown}${more > 0 ? `; and ${more} more` : ''}.`, title: more > 0 ? fs.map((f) => f.text).join('\n') : '' };
}
// The turn context line: the findings of the previous turn that the document (as this turn starts) still has, and what
// they are for: a line that said nothing more pulled a turn that asked for fonts into restructuring (and a deletion).
const STRUCTURE_LINE_END = 'Mention it in a sentence if relevant; restructure only if the user asks.';
function structureLine(snap) {
  if (!snap || !snap.docId) return '';
  const pending = structurePending.get(snap.docId);
  if (!pending) return '';
  structurePending.delete(snap.docId);
  let still = pending;
  if (snap.docFormat === 'docs-api' && snap.model) {
    const now = new Map(structureFindings(snap.model).map((f) => [f.key, f]));
    still = pending.filter((f) => now.has(f.key)).map((f) => now.get(f.key));
  }
  return still.length ? `After the last edits: ${structureText(still)}. ${STRUCTURE_LINE_END}` : '';
}

registerTurnHook('finish', (userMsg, snap, chatCtx) => {
  if (!snap || !snap.docId) return;
  const found = structureFinish(userMsg, snap, chatCtx);
  if (!found.length) return;
  const docId = snap.docId;
  structurePending.set(docId, found);
  const { text, title } = structureNotice(found);
  // A row of the turn on its last message (the turn saves and draws it); all findings in its fold when some are cut.
  const msgs = (chatCtx && chatCtx.messages) || [];
  if (msgs.length) addTurnRow(text, { at: msgs[msgs.length - 1], detail: title });
});
registerTurnHook('beforeTurn', (mode, snap) => structureLine(snap));
