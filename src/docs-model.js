'use strict';
// Module docs-model.js: reading through the Docs API: fetchDocModel, the line model (buildLineModel,
// paragraphLine, index/offset helpers; table cells and model.tables, the headers / footers / footnotes as segment
// models (segmentModels, segmentModel, findSegment), the table of contents), formatting notation (markedText,
// showText; the table notation TABLE_LINE_DECORATOR), flexible search (findFlexible with its normalized fallback,
// disjointHits, closestMatch / notFoundError, commonEdges) and line reports (linesReport, changedLinesReport,
// regionNote).
/* global alignName, dimensionPt, docsApi, DOCS_GET_FIELDS, EDIT_REPORT_MAX_CHARS, EDIT_REPORT_MAX_LINES,
   hexFromOptionalColor, lineDecorations, lineTag, listKind, OBJECT_CHAR, SOFT_BREAK_MARK, spanAttrs, state,
   markDocRead, SUGGESTED_NOTE, unmarkedNote */
/* exported docsTabFromUrl, fetchDocModel, fetchDocRevision, useDocModel, FORMAT_KEYS, TEXT_STYLE_KEYS, isPlainStyle, sameStyle,
   isClosing, lineAtOffset, lineAtIndex, indexRange, textAtIndexRange, showText, FORMAT_NOTE, formatNote, markedText,
   textDefault, findFlexible, disjointHits, rangeLabel, capFirst, linesReport, lineList, changedLinesReport,
   regionNote, indexAtOffset, normalizeForMatch, NORMALIZED_NOTE, FOLDED_NOTE, notFoundError, commonEdges, stripMarkers,
   MARKERS_NOTE, hitLines, ambiguousError, segmentModel, findSegment, cellLabel, tableOfLine, tableNote, TABLE_LINE_DECORATOR, decorated */

// The Docs tab ("?tab=t.xxx") open in the browser tab, if any.
function docsTabFromUrl(url) {
  const m = /[?&#]tab=([^&#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

// GET documents/{id} with includeTabsContent=true (only the fields of DOCS_GET_FIELDS) and the line
// model of the requested Docs tab.
// strict: a tabId that does not exist (any more) is an error (re-reads after an edit, undo); otherwise
// (the tab from the URL) the first tab is used. The suggestions view mode is the default
// (SUGGESTIONS_INLINE): only its indices are valid for writes; lines with suggestions are flagged.
async function fetchDocModel(docId, tabId, strict = true) {
  const doc = await docsApi(`${encodeURIComponent(docId)}?includeTabsContent=true&fields=${DOCS_GET_FIELDS}`);
  return buildLineModel(doc, tabId, docId, strict);
}

// The document's current revisionId alone (GET documents/{id}?fields=revisionId): the live document line's cheap
// change check (src/doc-live.js); no content is transferred.
async function fetchDocRevision(docId) {
  const doc = await docsApi(`${encodeURIComponent(docId)}?fields=revisionId`);
  return (doc && doc.revisionId) || '';
}

// Applies a freshly read model to the panel state (document text, format, status).
function useDocModel(model) {
  if (state.docId && model.docId !== state.docId) return;
  state.docModel = model;
  state.docText = model.text;
  state.docFormat = 'docs-api';
  state.docError = '';
  markDocRead();
}

// ---- Line model -------------------------------------------------------------------------------
// One line per paragraph of the chosen Docs tab, in reading order (paragraphs inside table cells
// too, cell by cell; tables of contents, section breaks, headers, footers and footnotes are left out of the
// lines: model.toc and model.segments hold them):
//   { line (1-based), start, end, text, heading, style, off, exact, closing, suggested, runs, para, list,
//     segment ('body'), cell (inside a table: { t, r, c }) }
// start/end: API indices of the paragraph content: text = document[start, end), "end" is the index of
// the paragraph's newline. Indices count UTF-16 code units, like JS string indices. heading: 0, or
// the level of a TITLE (1), SUBTITLE (2) or HEADING_n (n) style; style: the namedStyleType. off: offset
// of the line in model.text (the lines joined with "\n"), so text offset off + k is API index start + k
// and the "\n" after a line is its paragraph's newline. exact: the element ranges add up (always,
// unless the API returns something unexpected; edits refuse inexact lines). suggested: the paragraph
// contains suggested insertions or deletions (suggesting mode); its text shows both, and edits refuse it.
// Soft line breaks stay U+000B in the text (one index unit); tool output shows them as SOFT_BREAK_MARK.
// Tabs: documents may have several tabs (tabs[].documentTab.body, child tabs nested). The model uses
// the tab open in the browser (the "tab" URL parameter) and otherwise the first tab; all edits carry
// that tabId. para: the paragraph fields set explicitly on the paragraph (paraFields); list: its bullet
// ({ listId, level, kind }) or null. model.textDefault: the most common font, size and color (textDefault).
function flattenTabs(tabs, out = []) {
  for (const t of tabs || []) { out.push(t); flattenTabs(t.childTabs, out); }
  return out;
}

function headingLevel(style) {
  if (style === 'TITLE') return 1;
  if (style === 'SUBTITLE') return 2;
  const m = /^HEADING_([1-6])$/.exec(style || '');
  return m ? Number(m[1]) : 0;
}

// Inline style of a text run as kept in the line model: FORMAT_KEYS (booleans), link (the URL or null),
// font (fontFamily) and weight, size (pt), color and bg (#RRGGBB) or null, linkRaw (the API link object,
// so heading, bookmark and tab links survive an undo) or null. TEXT_STYLE_KEYS: all of them.
const FORMAT_KEYS = ['bold', 'italic', 'underline'];
const TEXT_STYLE_KEYS = [...FORMAT_KEYS, 'link', 'font', 'weight', 'size', 'color', 'bg', 'linkRaw'];
function runStyle(ts = {}) {
  const wff = ts.weightedFontFamily && ts.weightedFontFamily.fontFamily ? ts.weightedFontFamily : null;
  return {
    bold: !!ts.bold, italic: !!ts.italic, underline: !!ts.underline, link: (ts.link && ts.link.url) || null,
    font: wff ? wff.fontFamily : null, weight: wff && wff.weight ? wff.weight : null,
    size: ts.fontSize && typeof ts.fontSize.magnitude === 'number' ? ts.fontSize.magnitude : null,
    color: hexFromOptionalColor(ts.foregroundColor), bg: hexFromOptionalColor(ts.backgroundColor),
    linkRaw: ts.link && typeof ts.link === 'object' && Object.keys(ts.link).length ? JSON.parse(JSON.stringify(ts.link)) : null,
  };
}
const sameValue = (k, a, b) => (k === 'linkRaw' ? JSON.stringify(a || null) === JSON.stringify(b || null) : (a ?? null) === (b ?? null));
const sameStyle = (a, b) => TEXT_STYLE_KEYS.every((k) => sameValue(k, a[k], b[k]));
const isPlainStyle = (st) => TEXT_STYLE_KEYS.every((k) => (FORMAT_KEYS.includes(k) ? !st[k] : st[k] == null));

// Explicit paragraph fields of a paragraphStyle (absent keys are inherited from the named style):
// { align: 'left'|'center'|'right'|'justify' (visual, RTL-aware), direction: 'LEFT_TO_RIGHT'|'RIGHT_TO_LEFT',
//   indentStart, indentFirstLine, spaceAbove, spaceBelow (pt), lineSpacing (percent, 100 = single) }.
function paraFields(ps = {}) {
  const out = {};
  const align = alignName(ps.alignment, ps.direction);
  if (align) out.align = align;
  if (ps.direction) out.direction = ps.direction;
  for (const k of ['indentStart', 'indentFirstLine', 'spaceAbove', 'spaceBelow']) {
    const v = dimensionPt(ps[k]);
    if (v != null) out[k] = v;
  }
  if (typeof ps.lineSpacing === 'number') out.lineSpacing = ps.lineSpacing;
  return out;
}
// The bullet of a paragraph as { listId, level (0-based), kind: 'bullet'|'number'|'checklist' }, or null.
function listOf(bullet, lists) {
  if (!bullet || !bullet.listId) return null;
  const level = bullet.nestingLevel || 0;
  const def = lists && lists[bullet.listId];
  const levels = def && def.listProperties && def.listProperties.nestingLevels;
  return { listId: bullet.listId, level, kind: listKind(levels ? levels[level] : null) };
}

// runs: [{ s, e, ...runStyle }] with s/e offsets in the line's text (e exclusive), only for formatted text
// (an embedded object by its element's textStyle), adjacent equal styles merged. Booleans are true only
// for an explicit true in textStyle, and the other keys are set only when explicit (formatting inherited
// from the paragraph style, such as a bold heading style or the document font, is not seen).
function paragraphLine(se, lists) {
  const p = se.paragraph;
  let text = '';
  const runs = [];
  for (const pe of p.elements || []) {
    // Other elements (inline objects, chips, breaks) carry their textStyle in their own field.
    const inner = pe.textRun || Object.values(pe).find((v) => v && typeof v === 'object' && v.textStyle) || {};
    const content = pe.textRun ? pe.textRun.content || '' : OBJECT_CHAR.repeat(Math.max(0, (pe.endIndex || 0) - (pe.startIndex || 0)));
    const st = runStyle(inner.textStyle);
    const prev = runs[runs.length - 1];
    if (content && !isPlainStyle(st)) {
      if (prev && prev.e === text.length && sameStyle(prev, st)) prev.e += content.length;
      else runs.push({ s: text.length, e: text.length + content.length, ...st });
    }
    text += content;
  }
  if (text.endsWith('\n')) text = text.slice(0, -1);
  for (const r of runs) r.e = Math.min(r.e, text.length);
  while (runs.length && runs[runs.length - 1].e <= runs[runs.length - 1].s) runs.pop(); // a run of the newline only
  const start = se.startIndex || 0;
  const end = Math.max(start, (se.endIndex || 0) - 1);
  const style = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || '';
  const hasIds = (v) => !!v && typeof v === 'object' && ((v.suggestedInsertionIds || []).length > 0 || (v.suggestedDeletionIds || []).length > 0);
  const suggested = (p.elements || []).some((pe) => Object.values(pe).some(hasIds));
  return { start, end, text, heading: headingLevel(style), style, exact: text.length === end - start, suggested, runs,
    para: paraFields(p.paragraphStyle), list: listOf(p.bullet, lists) };
}

// closing: the paragraph's newline cannot be deleted (the last paragraph of a table cell or of the
// body, or the paragraph right before a table or a section break).
// ctx (optional): { segment: 'body' | 'header' | 'footer' | 'footnote', tables: [] (model.tables, filled in
// reading order), refs: [] (footnote references: { id, number, index, at: index of the line in out }), toc
// (set by a table of contents), cell (the innermost table cell of these lines: { t, r, c }), depth }.
// Every line gets segment (ctx.segment) and, inside a table, cell: { t (the table's n in model.tables),
// r, c (0-based row and column) } of the innermost cell.
const newLineCtx = (segment) => ({ segment, tables: [], refs: [], toc: null, depth: 0 });
function collectLines(content, out, lists, ctx = newLineCtx('body')) {
  const list = content || [];
  list.forEach((se, i) => {
    if (se.paragraph) {
      const l = paragraphLine(se, lists);
      const next = list[i + 1];
      l.closing = !next || !next.paragraph;
      l.segment = ctx.segment;
      if (ctx.cell) l.cell = { ...ctx.cell };
      for (const pe of se.paragraph.elements || []) {
        const ref = pe.footnoteReference;
        if (ref && ref.footnoteId) ctx.refs.push({ id: ref.footnoteId, number: Number(ref.footnoteNumber) || null, index: pe.startIndex || 0, at: out.length });
      }
      out.push(l);
    } else if (se.table) {
      collectTable(se, out, lists, ctx);
    } else if (se.tableOfContents && !ctx.depth && ctx.segment === 'body' && !ctx.toc) {
      // Read-only: its paragraphs are not lines (Docs regenerates them; the API cannot update a TOC).
      const lines = collectLines(se.tableOfContents.content, [], lists, { ...newLineCtx('toc'), depth: 1 });
      ctx.toc = { start: se.startIndex || 0, end: se.endIndex || 0, at: out.length, lines: lines.map((l) => l.text) };
    }
  });
  return out;
}

// One table into the lines (cell by cell) and ctx.tables: { n (1-based, reading order; nested tables
// included), start, end (API indices of the table element), rows, cols, firstLine, lastLine (its 1-based lines,
// nested tables included; set by lineSet), nested (inside another table's cell), merged ([{ r, c, rowSpan,
// colSpan }] of cells that span others; read for outer tables), widths (outer tables, when Docs returns column
// properties: [{ type: widthType, pt: the width in pt or null }]) }.
function collectTable(se, out, lists, ctx) {
  const tb = se.table;
  const rows = tb.tableRows || [];
  const t = { n: ctx.tables.length + 1, start: se.startIndex || 0, end: se.endIndex || 0, rows: rows.length,
    cols: tb.columns || rows.reduce((m, r) => Math.max(m, (r.tableCells || []).length), 0), nested: !!ctx.cell, merged: [], at: out.length };
  // The fields mask reads widths, spans and the column count of outer tables only (a nested one: from its cells).
  const outer = !t.nested;
  if (!outer) t.cols = rows.reduce((m, r) => Math.max(m, (r.tableCells || []).length), 0);
  const props = outer && tb.tableStyle && tb.tableStyle.tableColumnProperties;
  if (Array.isArray(props) && props.length) t.widths = props.map((p) => ({ type: p.widthType || null, pt: dimensionPt(p.width) }));
  ctx.tables.push(t);
  rows.forEach((row, r) => (row.tableCells || []).forEach((cell, c) => {
    const st = (outer && cell.tableCellStyle) || {};
    if ((st.rowSpan || 1) > 1 || (st.columnSpan || 1) > 1) t.merged.push({ r, c, rowSpan: st.rowSpan || 1, colSpan: st.columnSpan || 1 });
    collectLines(cell.content, out, lists, { ...ctx, cell: { t: t.n, r, c }, depth: ctx.depth + 1 });
  }));
  t.after = out.length;
}

// The model: { docId, title, revisionId, tabId, tabTitle, tabCount, lines, text, textDefault, tables, segments,
// toc }. tables: see collectTable. segments: the tab's headers, footers and footnotes (segmentModels). toc: the
// table of contents { start, end, beforeLine (the body line right after it), lines: [text] } or null. Body lines,
// their numbers and model.text do not depend on tables, segments or the TOC.
function buildLineModel(doc, wantedTab, docId, strict = false) {
  const tabs = flattenTabs(doc.tabs);
  let tab = tabs.find((t) => t.tabProperties && t.tabProperties.tabId === wantedTab) || null;
  if (!tab && wantedTab && tabs.length && strict) {
    throw new Error(`the Docs tab "${wantedTab}" of this document no longer exists (it was deleted or the document changed).`);
  }
  if (!tab) tab = tabs[0] || null;
  const dt = (tab && tab.documentTab) || {};
  const ctx = newLineCtx('body');
  const lines = collectLines((dt.body || {}).content, [], dt.lists || null, ctx);
  const base = {
    docId: doc.documentId || docId, title: doc.title || '', revisionId: doc.revisionId || '',
    tabId: tab && tab.tabProperties ? tab.tabProperties.tabId || null : null,
    tabTitle: tab && tab.tabProperties ? tab.tabProperties.title || '' : '', tabCount: tabs.length,
  };
  const model = { ...base, ...lineSet(lines, ctx.tables) };
  model.segments = segmentModels(dt, base, ctx.refs, lines);
  model.toc = ctx.toc ? { start: ctx.toc.start, end: ctx.toc.end, beforeLine: ctx.toc.at + 1, lines: ctx.toc.lines } : null;
  return model;
}
// Numbers the lines (line, off) and gives { lines, text, textDefault, tables } (the tables with their line range).
function lineSet(lines, tables = []) {
  let off = 0;
  lines.forEach((l, i) => { l.line = i + 1; l.off = off; off += l.text.length + 1; });
  for (const t of tables) { t.firstLine = t.at + 1; t.lastLine = t.after; delete t.at; delete t.after; }
  return { lines, text: lines.map((l) => l.text).join('\n'), textDefault: textDefault(lines), tables };
}

// ---- Segments: headers, footers, footnotes ------------------------------------------------------------
// Each is a segment model with the shape of a body model (lines numbered from 1 within the segment, text,
// textDefault, tables, docId, revisionId, tabId), so the line helpers, matching, replacePlan, the request
// builders (they add its segmentId) and the undo anchors work on it unchanged, plus { type: 'header' | 'footer'
// | 'footnote', kind ('default' | 'first' | 'even', or null for a header or footer that documentStyle does not
// name, and for footnotes), n (footnote number), segmentId, label ('header', 'first-page header', 'even-page
// header', 'footer', …, 'footnote 3'), refIndex and refLine (footnotes: the body index of the reference mark and
// its body line; null when no mark refers to it) }. Indices are the segment's own, as Docs returns them (a header
// starts at 0). Order: headers (default, first page, even pages, others), footers, then footnotes by number.
// Their lines carry segment (the type), segmentId and, in a footnote, footnote (its n).
const SEGMENT_KIND_LABEL = { default: '', first: 'first-page ', even: 'even-page ' };
function segmentModels(dt, base, refs, bodyLines) {
  const ds = dt.documentStyle || {};
  const out = [];
  const add = (type, id, seg, extra) => {
    const ctx = newLineCtx(type);
    const lines = collectLines((seg && seg.content) || [], [], dt.lists || null, ctx);
    for (const l of lines) { l.segmentId = id; if (type === 'footnote') l.footnote = extra.n; }
    out.push({ ...base, type, kind: null, segmentId: id, ...extra, ...lineSet(lines, ctx.tables), segments: [], toc: null });
  };
  for (const [type, key, Name] of [['header', 'headers', 'Header'], ['footer', 'footers', 'Footer']]) {
    const kindOf = (id) => (id === ds[`default${Name}Id`] ? 'default' : id === ds[`firstPage${Name}Id`] ? 'first' : id === ds[`evenPage${Name}Id`] ? 'even' : null);
    const order = (k) => ['default', 'first', 'even'].indexOf(k) + 1 || 4;
    Object.keys(dt[key] || {}).map((id) => ({ id, kind: kindOf(id) })).sort((a, b) => order(a.kind) - order(b.kind))
      .forEach(({ id, kind }) => add(type, id, dt[key][id], { kind, label: kind ? SEGMENT_KIND_LABEL[kind] + type : `${type} ${id}` }));
  }
  // Footnotes in the order of their marks, with the number Docs renders (else the position); unreferenced ones last.
  const ids = Object.keys(dt.footnotes || {});
  const marked = refs.filter((r, i) => ids.includes(r.id) && refs.findIndex((x) => x.id === r.id) === i);
  marked.forEach((r, i) => {
    const n = r.number || i + 1;
    add('footnote', r.id, dt.footnotes[r.id], { n, label: `footnote ${n}`, refIndex: r.index, refLine: bodyLines[r.at] ? r.at + 1 : null });
  });
  ids.filter((id) => !marked.some((r) => r.id === id)).forEach((id, i) => {
    const n = marked.length + i + 1;
    add('footnote', id, dt.footnotes[id], { n, label: `footnote ${n}`, refIndex: null, refLine: null });
  });
  return out;
}
// The model a segment id is edited in: the body model for none (''/null/undefined), else that segment model,
// or null when the segment no longer exists.
const segmentModel = (model, segmentId) => (!segmentId ? model : ((model && model.segments) || []).find((s) => s.segmentId === segmentId) || null);
// A segment by its label ('header', 'footnote 2', …; case-insensitive), or null.
const findSegment = (model, label) => ((model && model.segments) || []).find((s) => s.label.toLowerCase() === String(label || '').trim().toLowerCase()) || null;

// ---- Table notation -----------------------------------------------------------------------------------
// The cell label of a line ("[r1c2]", 1-based) or '', the table a line is in (innermost) or null, and the
// unnumbered line shown before a table's first line. TABLE_LINE_DECORATOR puts them into the reading output
// once a module registers it (registerLineDecorator); stripMarkers removes both from a copied old_text.
const cellLabel = (line) => (line && line.cell ? `[r${line.cell.r + 1}c${line.cell.c + 1}]` : '');
const tableOfLine = (model, line) => (line && line.cell && model && model.tables ? model.tables.find((t) => t.n === line.cell.t) || null : null);
const tableNote = (t) => `[table T${t.n}: ${t.rows} row${t.rows === 1 ? '' : 's'} × ${t.cols} column${t.cols === 1 ? '' : 's'}, ${rangeLabel(t.firstLine, t.lastLine)}]`;
const TABLE_LINE_DECORATOR = {
  label: (line) => cellLabel(line),
  // Every table starting at this line, outermost first (a nested table can start at its outer table's first line).
  before: (line, model) => (model.tables || []).filter((t) => t.firstLine === line.line && t.lastLine >= t.firstLine).map(tableNote).join('\n'),
  note: ' marked [rNcM] (row N, column M), under a [table Tn …] line',
};
// " [r1c2]" (the registered labels with a leading space) and the unnumbered lines before the line, or ''.
const decorated = (model, l) => (model && l ? lineDecorations(l, model) : { label: '', before: '' });

// The document default of the inline notation: the most common explicit font, size and color by
// characters ({ font, size, color }, each null when unformatted text is the most common). Spans leave
// these out and the read_formatting header names them once.
function textDefault(lines) {
  const out = {};
  for (const k of ['font', 'size', 'color']) {
    const count = new Map();
    for (const l of lines) {
      let styled = 0;
      for (const r of l.runs || []) {
        const n = r.e - r.s;
        styled += n;
        count.set(r[k] ?? null, (count.get(r[k] ?? null) || 0) + n);
      }
      count.set(null, (count.get(null) || 0) + l.text.length - styled);
    }
    let best = null;
    let most = -1;
    for (const [v, n] of count) if (n > most) { best = v; most = n; }
    out[k] = best;
  }
  return out;
}

// The newline after line i (0-based) cannot be deleted (or crossed) when the line ends a cell, a run of
// body paragraphs or the document, or when the next line does not follow directly in index space.
const isClosing = (model, i) => i >= model.lines.length - 1 || !!model.lines[i].closing || model.lines[i].end + 1 !== model.lines[i + 1].start;

// Line containing text offset off (0 <= off <= text length).
function lineAtOffset(model, off) {
  const ls = model.lines;
  let lo = 0;
  let hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid].off <= off) lo = mid; else hi = mid - 1; }
  return ls[lo];
}
function indexAtOffset(model, off) {
  const l = lineAtOffset(model, off);
  return l.start + (off - l.off);
}
// Line whose content or newline is at API index idx, or null (structural positions, other tabs).
function lineAtIndex(model, idx) {
  const ls = model.lines;
  if (!ls.length || idx < ls[0].start) return null;
  let lo = 0;
  let hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid].start <= idx) lo = mid; else hi = mid - 1; }
  return idx <= ls[lo].end ? ls[lo] : null;
}

// API index range [start, end) of model.text[s, e) (e > s), with the 1-based lines it touches, or
// { error } when it would cross a table / cell / section boundary or delete a required paragraph end.
function indexRange(model, s, e) {
  const a = lineAtOffset(model, s);
  const b = lineAtOffset(model, e - 1);
  for (let i = a.line - 1; i <= b.line - 1; i++) {
    const l = model.lines[i];
    if (!l.exact) return { error: `the positions in line ${l.line} cannot be mapped exactly; edit a different part of the text` };
    if (l.suggested) return { error: `line ${l.line} contains suggested changes (suggesting mode); accept or reject them in Google Docs first, or edit other lines` };
    const nl = l.off + l.text.length;
    if (nl >= s && nl < e && isClosing(model, i)) {
      return { error: `the text crosses the end of line ${l.line}, which ends a table cell, a table neighbour or a section; edit each part separately` };
    }
  }
  return { start: indexAtOffset(model, s), end: indexAtOffset(model, e - 1) + 1, from: a.line, to: b.line };
}

// Current text of API range [S, E), or null when the range is not plain line text.
function textAtIndexRange(model, S, E) {
  if (E <= S) return '';
  const a = lineAtIndex(model, S);
  const b = lineAtIndex(model, E - 1);
  if (!a || !b) return null;
  for (let i = a.line - 1; i < b.line - 1; i++) if (isClosing(model, i)) return null;
  return model.text.slice(a.off + (S - a.start), b.off + (E - 1 - b.start) + 1);
}

// Tool output: soft breaks as a visible mark.
// eslint-disable-next-line no-control-regex -- U+000B is the Docs soft line break
const showText = (t) => String(t).replace(/\u000b/g, SOFT_BREAK_MARK);

// Formatting notation (read_formatting, format_text results): a line's tag (lineTag: style, list,
// alignment, indent, spacing) and its text with the runs as markers, nested in a fixed order (link
// outermost, then the {text}(font= size= color= bg=) span, bold, italic, underline; no underline inside a
// link); a marker pair closes only where its attribute (or an outer one) changes. def: the document
// default (model.textDefault), left out of spans; without it every explicit font, size and color is shown.
const FORMAT_NOTE = 'Markers are notation, not document text (never copy them into old_text): **bold** *italic* __underline__ [text](url) {text}(font= size= color= bg=); [tags] give a line\'s style, list, alignment, indent and spacing (pt), line spacing.';
// FORMAT_NOTE with the model's default font ("Unmarked text: Arial 11.") when it has one.
const formatNote = (model) => FORMAT_NOTE + unmarkedNote(model && model.textDefault);
const MARKER_LEVELS = [
  { has: (st) => !!st.link, same: (a, b) => a.link === b.link, open: () => '[', close: (st) => `](${st.link})` },
  { has: (st, def) => spanAttrs(st, def) !== '', same: (a, b, def) => spanAttrs(a, def) === spanAttrs(b, def), open: () => '{', close: (st, def) => `}(${spanAttrs(st, def)})` },
  ...[['bold', '**'], ['italic', '*']].map(([k, m]) => ({ has: (st) => st[k], same: (a, b) => a[k] === b[k], open: () => m, close: () => m })),
  // Docs underlines links by itself: inside a link the underline is not shown (like its color).
  { has: (st) => st.underline && !st.link, same: (a, b) => (a.underline && !a.link) === (b.underline && !b.link), open: () => '__', close: () => '__' },
];
function markedText(line, def) {
  const tag = lineTag(line);
  const body = markedInline(line, def);
  return tag ? `[${tag}]` + (body ? ' ' + body : '') : body;
}
function markedInline(line, def) {
  const t = line.text;
  const plain = { bold: false, italic: false, underline: false, link: null };
  const segs = [];
  let at = 0;
  for (const r of line.runs || []) {
    if (r.s > at) segs.push({ text: t.slice(at, r.s), st: plain });
    segs.push({ text: t.slice(r.s, r.e), st: r });
    at = r.e;
  }
  if (at < t.length) segs.push({ text: t.slice(at), st: plain });
  let out = '';
  let cur = plain;
  const closeFrom = (k) => { for (let i = MARKER_LEVELS.length - 1; i >= k; i--) if (MARKER_LEVELS[i].has(cur, def)) out += MARKER_LEVELS[i].close(cur, def); };
  for (const sg of [...segs, { text: '', st: plain }]) {
    const k = MARKER_LEVELS.findIndex((lv) => !lv.same(cur, sg.st, def));
    if (k >= 0) {
      closeFrom(k);
      for (let i = k; i < MARKER_LEVELS.length; i++) if (MARKER_LEVELS[i].has(sg.st, def)) out += MARKER_LEVELS[i].open(sg.st, def);
      cur = sg.st;
    }
    out += showText(sg.text);
  }
  return out;
}

// Matches of needle in hay (overlapping), where a newline (or the soft-break mark) in the needle also
// matches a soft line break (U+000B) in the document. Returns [{ at, text }] with the actual text.
// When there is no exact match (and normalize is not false), the normalized texts are compared instead
// (normalizeForMatch); such hits carry normalized: true and still give the real document text and
// offsets. Only when that finds nothing either, a last pass also folds look-alike Cyrillic/Greek letters
// (FOLD_MAP); its hits also carry folded: true. Running it last leaves every earlier hit (and its
// ambiguity) as it was, and 2+ folded hits are refused by the callers like any ambiguity (replace_all: 2+
// different spellings among them). Undo matches
// exactly only (normalize: false).
function findFlexible(hay, needle, { normalize = true } = {}) {
  const n = String(needle).split(SOFT_BREAK_MARK).join('\n');
  if (!n) return [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(n.split('\n').map(esc).join('[\\n\\u000b]'), 'g');
  const out = [];
  for (let m = re.exec(hay); m; m = re.exec(hay)) { out.push({ at: m.index, text: m[0] }); re.lastIndex = m.index + 1; }
  if (out.length || !normalize) return out;
  const loose = findNormalized(hay, n);
  return loose.length ? loose : findNormalized(hay, n, { fold: true });
}

// ---- Normalized matching ----------------------------------------------------------------------
// Text as compared when the exact text is not found: runs of Unicode whitespace (NBSP, thin spaces,
// tabs, ...) become one space, whitespace at the end of a line is dropped, soft hyphens, zero-width
// characters and BOMs are dropped, typographic quotes become ' and ", hyphen and dash variants "-",
// the ellipsis "...", and a soft line break is a newline. start[k] / end[k]: the range of the original
// text that normalized character k comes from; head[k] / tail[k]: k is the first / last character of
// that range's replacement (the ellipsis gives three), so a hit never starts or ends inside one.
const NORM_DROP_RE = /[\u00AD\u200B-\u200D\uFEFF]/;
const NORM_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u00AB': '"', '\u00BB': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2026': '...',
};
// Homoglyphs folded to Latin by the last-resort pass (fold: true): Cyrillic and Greek letters that look
// like a Latin one in common fonts, which a model re-typing mixed Russian/English text confuses. Small on
// purpose: every extra pair can make two genuinely different words equal.
const FOLD_MAP = {
  // Cyrillic lowercase: а е о р с у х к і ј ѕ
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k',
  'і': 'i', 'ј': 'j', 'ѕ': 's',
  // Cyrillic capitals: А В Е К М Н О Р С Т Х У І Ј Ѕ
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  // Greek: ο and the capitals Α Β Ε Η Ι Κ Μ Ν Ο Ρ Τ Χ Υ Ζ
  'ο': 'o', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'Ζ': 'Z',
};
const isBreakChar = (c) => c === '\n' || c === '\u000b';
// The character classes of the loop below by UTF-16 code (charCodeAt, no regex per character): NORM_DROP_RE,
// a line break (newline or soft break), and JavaScript's \s.
const isDropCode = (c) => c === 0xAD || (c >= 0x200B && c <= 0x200D) || c === 0xFEFF;
const isBreakCode = (c) => c === 0x0A || c === 0x0B;
const isSpaceCode = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0D) || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
  c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
// fold: also map the FOLD_MAP letters. They are one character to one and pass through the loop unchanged, so the
// folded form is the plain one with its text folded (the offset map is shared).
function normalizeForMatch(str, { fold = false } = {}) {
  const n = normalizePlain(String(str));
  return fold ? foldNormalized(n) : n;
}
function normalizePlain(s) {
  let text = '';
  const start = [];
  const end = [];
  const head = [];
  const tail = [];
  const push = (c, a, b, h, t) => { text += c; start.push(a); end.push(b); head.push(h); tail.push(t); };
  for (let i = 0; i < s.length;) {
    const code = s.charCodeAt(i);
    if (code > 0x20 && code < 0x7F) { push(s[i], i, i + 1, true, true); i++; continue; } // printable ASCII: as it is
    if (isDropCode(code)) { i++; continue; }
    if (isBreakCode(code)) { push('\n', i, i + 1, true, true); i++; continue; }
    if (isSpaceCode(code)) {
      let j = i + 1;
      while (j < s.length && !isBreakCode(s.charCodeAt(j)) && (isSpaceCode(s.charCodeAt(j)) || isDropCode(s.charCodeAt(j)))) j++;
      if (j < s.length && isBreakCode(s.charCodeAt(j))) { i = j; continue; } // whitespace at the end of a line
      push(' ', i, j, true, true);
      i = j;
      continue;
    }
    const m = NORM_MAP[s[i]];
    if (m) { for (let k = 0; k < m.length; k++) push(m[k], i, i + 1, k === 0, k === m.length - 1); i++; continue; }
    push(s[i], i, i + 1, true, true);
    i++;
  }
  return { text, start, end, head, tail };
}
const FOLD_RE = new RegExp(`[${Object.keys(FOLD_MAP).join('')}]`, 'g');
const foldNormalized = (n) => ({ ...n, text: n.text.replace(FOLD_RE, (c) => FOLD_MAP[c]) });
// The last document text normalized, plain and folded (the searches of one tool call share it; the folded form
// is made from the plain one).
const normCache = { src: null, plain: null, folded: null };
function normalizedHay(hay, fold = false) {
  const c = normCache;
  if (c.src !== hay) Object.assign(c, { src: hay, plain: normalizePlain(String(hay)), folded: null });
  if (!fold) return c.plain;
  if (!c.folded) c.folded = foldNormalized(c.plain);
  return c.folded;
}
const isHighSurrogate = (code) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;
// Offset i of t lies between the two halves of a surrogate pair.
const splitsPair = (t, i) => i > 0 && i < t.length && isHighSurrogate(t.charCodeAt(i - 1)) && isLowSurrogate(t.charCodeAt(i));

function findNormalized(hay, needle, { fold = false } = {}) {
  const N = normalizeForMatch(needle, { fold }).text;
  if (!N.trim()) return [];
  const H = normalizedHay(hay, fold);
  const out = [];
  for (let k = H.text.indexOf(N); k >= 0; k = H.text.indexOf(N, k + 1)) {
    const last = k + N.length - 1;
    if (!H.head[k] || !H.tail[last]) continue;
    const at = H.start[k];
    const e = H.end[last];
    if (splitsPair(hay, at) || splitsPair(hay, e)) continue;
    out.push({ at, text: hay.slice(at, e), normalized: true, ...(fold ? { folded: true } : {}) });
  }
  return out;
}

// Appended to a result whose old_text was found by normalized matching.
const NORMALIZED_NOTE = 'Note: old_text matched after normalizing whitespace/quotes/dashes (the document has slightly different characters there).';
// The note for a hit with folded: true, instead of NORMALIZED_NOTE (docs-write.js: `h.folded ? FOLDED_NOTE :
// NORMALIZED_NOTE`).
const FOLDED_NOTE = 'Note: old_text matched after normalizing look-alike Cyrillic/Latin letters (the document\'s characters differ there).';

// ---- Markers and quotes in old_text -----------------------------------------------------------
// Models copy old_text from read_formatting with its notation (**bold**, [t](u), {t}(size=14), "3: " line
// numbers, "[h1] " line tags) or with the quotes of the request ('lazy dog'). stripMarkers removes leading
// line numbers and line tags (on every line), links and spans (their text stays), paired ** / __ anywhere
// and wrapping single * / _ and quotes, or returns null when there is nothing to remove. Callers try it
// only after the literal text was not found, so a literal * or quote that the document has still matches first.
const WRAP_PAIRS = [['*', '*'], ['_', '_'], ["'", "'"], ['"', '"'], ['\u00AB', '\u00BB'], ['\u201C', '\u201D'], ['\u2018', '\u2019'], ['\u201E', '\u201C']];
// A table's "[table T1: …]" line (registerLineDecorator) is removed whole; a cell label may follow the number.
const TABLE_NOTE_LINE_RE = /^\[table T\d+\b[^\]\n]*\](?:\n|$)/gm;
const LINE_PREFIX_RE = /^(?:\d+(?: \[r\d+c\d+\])*: )?(?:\[(?:title|subtitle|h[1-6]|bullet|number|checklist|center|right|justify|left|indent|space|line)\b[^\]\n]*\] ?)?/gm;
const NOTATION_SPAN_RE = /\{([^{}\n]*)\}\((?:font|size|color|bg)=[^()\n]*\)/g;
const NOTATION_LINK_RE = /\[([^[\]\n]+)\]\([^()\s]+\)/g;
function stripMarkers(text) {
  const src = String(text);
  let t = src.replace(TABLE_NOTE_LINE_RE, '').replace(LINE_PREFIX_RE, '').replace(NOTATION_SPAN_RE, '$1').replace(NOTATION_LINK_RE, '$1').replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1').replace(/__(?=\S)([\s\S]*?\S)__/g, '$1');
  for (let again = true; again;) {
    again = false;
    const s = t.trim();
    for (const [a, b] of WRAP_PAIRS) {
      if (s.length > a.length + b.length && s.startsWith(a) && s.endsWith(b)) { t = s.slice(a.length, s.length - b.length); again = true; break; }
    }
  }
  return t && t.trim() && t !== src ? t : null;
}
// Appended to a result whose old_text was found only after stripMarkers.
const MARKERS_NOTE = 'Note: formatting markers/quotes were removed from old_text to find it; pass the plain document text next time.';
// The fix named in a "not found" error when the text without markers or quotes is close to the document.
const MARKERS_ADVICE = 'old_text contains formatting markers or quotes that are not in the document; pass the plain text.';

// Where old_text comes closest to the document, for a "not found" error: the longest prefix or suffix
// of the normalized needle that occurs in the normalized document (its first occurrence). Returns
// { at, end, diff, expected, actual, side } with offsets in hay (at..end: the region the needle would
// cover, diff: where it stops matching; side "after": the prefix matched, the difference follows it,
// "before": the suffix matched), or null when not even a few characters match.
const CLOSEST_MIN_CHARS = 4;
const CLOSEST_SHOW_CHARS = 30;
function closestMatch(hay, needle) {
  const N = normalizeForMatch(String(needle).split(SOFT_BREAK_MARK).join('\n')).text;
  const H = normalizedHay(hay);
  if (!N || !H.text) return null;
  const longest = (ok) => {
    let lo = 0;
    let hi = N.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ok(mid)) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const P = longest((k) => H.text.includes(N.slice(0, k)));
  const S = longest((k) => H.text.includes(N.slice(N.length - k)));
  if (Math.max(P, S) < CLOSEST_MIN_CHARS) return null;
  const orig = (k) => (k >= H.text.length ? hay.length : H.start[Math.max(0, k)]);
  const max = CLOSEST_SHOW_CHARS;
  if (P >= S) {
    const k = H.text.indexOf(N.slice(0, P));
    const diff = orig(k + P);
    const nl = hay.indexOf('\n', diff);
    const lineEnd = nl < 0 ? hay.length : nl;
    // The document side: the rest of the differing line (or its newline), at most max characters.
    const to = Math.min(nl === diff ? diff + 1 : lineEnd, diff + max);
    return { at: orig(k), end: Math.max(diff, Math.min(orig(Math.min(H.text.length, k + N.length)), lineEnd)), diff, side: 'after',
      expected: N.slice(P, P + max) + (N.length > P + max ? '…' : ''),
      actual: diff >= hay.length ? '' : hay.slice(diff, to) + (to < lineEnd && nl !== diff ? '…' : '') };
  }
  const k = H.text.indexOf(N.slice(N.length - S));
  const diff = orig(k);
  const lineStart = hay.lastIndexOf('\n', diff - 1) + 1;
  const from = Math.max(lineStart === diff && diff > 0 ? diff - 1 : lineStart, diff - max);
  return { at: orig(Math.max(0, k - (N.length - S))), end: orig(k + S), diff, side: 'before',
    expected: (N.length - S > max ? '…' : '') + N.slice(Math.max(0, N.length - S - max), N.length - S),
    actual: (from > lineStart ? '…' : '') + hay.slice(from, diff) };
}
// A fragment quoted in an error message: soft breaks as the mark, newlines as "\n".
const quoteFragment = (t) => `«${showText(t).replace(/\n/g, '\\n')}»`;
// Model-facing "not found" error for old_text: the closest region, the point where it differs and the
// current lines there; the plain advice when nothing similar occurs. advice: the tool's own last sentence.
function notFoundError(model, needle, advice) {
  // Markers and quotes would stop the search at the first character; compare the plain text instead.
  const plain = stripMarkers(needle);
  const cp = plain && closestMatch(model.text, plain);
  const c = cp || closestMatch(model.text, needle);
  if (!c) return `old_text was not found in the document, and no similar text either. ${advice}`;
  if (cp) advice = `${MARKERS_ADVICE} ${advice}`;
  const a = lineAtOffset(model, c.at);
  const b = lineAtOffset(model, Math.max(c.at, c.end - 1));
  const where = lineAtOffset(model, Math.min(c.diff, Math.max(0, model.text.length - 1))).line;
  const excerpt = model.text.slice(c.at, Math.min(c.end, c.at + 60)) + (c.end - c.at > 60 ? '…' : '');
  const act = c.actual ? quoteFragment(c.actual) : '(the end of the document)';
  const lines = linesReport(model, a.line, b.line).replace(/^Lines (\d+)-(\d+) now:\n/, 'Current text of lines $1-$2:\n');
  return `old_text not found. Closest match at line ${where}: ${quoteFragment(excerpt)}; differs at ${quoteFragment(c.expected)} (old_text) vs ${act} (document).\n${lines}\n${advice}`;
}

// Common prefix p and suffix q of a and b (p + q <= the shorter length): only a[p, a.length - q) has to be
// replaced by b[p, b.length - q). Both shrink so that no surrogate pair is split and no word is cut (the
// changed part starts and ends at word boundaries), so the edit replaces whole words. loose (for a
// normalized match): characters that normalize alike (a space and an NBSP, a curly and a straight quote,
// dashes) count as equal, so the document keeps its own characters outside the changed part.
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const cpBefore = (t, i) => (splitsPair(t, i - 1) ? t.codePointAt(i - 2) : t.charCodeAt(i - 1));
const insideWord = (t, i) => i > 0 && i < t.length && WORD_CHAR_RE.test(String.fromCodePoint(cpBefore(t, i))) && WORD_CHAR_RE.test(String.fromCodePoint(t.codePointAt(i)));
const looseChar = (c) => (c !== undefined && !isBreakChar(c) && /\s/.test(c) && !NORM_DROP_RE.test(c) ? ' ' : NORM_MAP[c] && NORM_MAP[c].length === 1 ? NORM_MAP[c] : c);
function commonEdges(a, b, { loose = false } = {}) {
  const same = loose ? (x, y) => x === y || looseChar(x) === looseChar(y) : (x, y) => x === y;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && same(a[p], b[p])) p++;
  if (splitsPair(a, p) || splitsPair(b, p)) p--;
  while (p > 0 && (insideWord(a, p) || insideWord(b, p))) p -= splitsPair(a, p - 1) ? 2 : 1;
  let q = 0;
  while (q < max - p && same(a[a.length - 1 - q], b[b.length - 1 - q])) q++;
  if (splitsPair(a, a.length - q) || splitsPair(b, b.length - q)) q--;
  while (q > 0 && (insideWord(a, a.length - q) || insideWord(b, b.length - q))) q -= splitsPair(a, a.length - q + 1) ? 2 : 1;
  return { p, q };
}
// The non-overlapping matches among findFlexible's, left to right (as String.replaceAll would take them).
function disjointHits(hits) {
  const out = [];
  let end = -1;
  for (const h of hits) if (h.at >= end) { out.push(h); end = h.at + h.text.length; }
  return out;
}

// The lines of hits ({ at }: text offsets), unique, in the order of the hits.
const hitLines = (model, hits) => [...new Set(hits.map((h) => lineAtOffset(model, h.at).line))];
// The refusal of an ambiguous match ("old_text occurs 3 times (lines 4, 9). Include more …"; at most 10 lines named).
const ambiguousError = (model, hits, what = 'old_text') => `${what} occurs ${hits.length} times (lines ${hitLines(model, hits).slice(0, 10).join(', ')}). Include more of the surrounding text so that it occurs exactly once`;

const rangeLabel = (a, b) => (a === b ? `line ${a}` : `lines ${a}–${b}`);
const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// "Lines a-b now:" report of the current text (capped), with suggestion marks. render: a line's text
// as shown (markedText for formatting reports).
function linesReport(model, from, to, render = (l) => showText(l.text)) {
  const total = model.lines.length;
  if (!total) return 'The document is now empty.';
  const a = Math.max(1, Math.min(from, total));
  const b = Math.max(a, Math.min(to, total));
  const out = [];
  let chars = 0;
  let last = a - 1;
  for (let i = a; i <= b && out.length < EDIT_REPORT_MAX_LINES; i++) {
    const d = decorated(model, model.lines[i - 1]);
    const l = `${d.before ? d.before + '\n' : ''}${i}${d.label}: ${render(model.lines[i - 1], model.textDefault)}${model.lines[i - 1].suggested ? SUGGESTED_NOTE : ''}`;
    if (out.length && chars + l.length > EDIT_REPORT_MAX_CHARS) break;
    out.push(l);
    chars += l.length + 1;
    last = i;
  }
  const more = last < b ? `\n[... lines ${last + 1}-${b} not shown; use read_lines]` : '';
  return `Lines ${a}-${last} now:\n${out.join('\n')}${more}`;
}
// "4, 9, 12" (at most 15 numbers, then "…").
const lineList = (nums) => nums.slice(0, 15).join(', ') + (nums.length > 15 ? ', …' : '');
// "Lines 4, 9 now:" report of the given lines only (sorted, unique, unchanged numbering), capped like linesReport.
function changedLinesReport(model, nums) {
  const out = [];
  const shown = [];
  let chars = 0;
  for (const n of nums) {
    if (n < 1 || n > model.lines.length || out.length >= EDIT_REPORT_MAX_LINES) break;
    const l = `${n}${decorated(model, model.lines[n - 1]).label}: ${showText(model.lines[n - 1].text)}${model.lines[n - 1].suggested ? SUGGESTED_NOTE : ''}`;
    if (out.length && chars + l.length > EDIT_REPORT_MAX_CHARS) break;
    out.push(l);
    shown.push(n);
    chars += l.length + 1;
  }
  if (!out.length) return linesReport(model, nums[0] || 1, nums[0] || 1);
  const rest = nums.length - shown.length;
  const more = rest ? `\n[... ${rest} more changed line${rest === 1 ? '' : 's'} not shown; use find_in_document or read_lines]` : '';
  return `Lines ${shown.join(', ')} now:\n${out.join('\n')}${more}`;
}
// The current text around lines from..to (two lines of context), for refusals.
const regionNote = (model, from, to) => (model
  ? `\nThe document was read again; current text with the CURRENT line numbers:\n${linesReport(model, from - 2, to + 2)}\nThe document has ${model.lines.length} lines.`
  : '');
