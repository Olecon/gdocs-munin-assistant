'use strict';
// Module style-sheet.js: the formatting sheet, the fonts, sizes and paragraph values each paragraph type gets from
// code. A sheet is one text line, "Formatting: body Times New Roman 12; h1 16; …", in DOC.md or MAIN.md (the
// built-in default otherwise): parseStyleSheet reads it, styleSheetFor(snap) resolves the precedence (DOC.md over
// MAIN.md over the default, field by field), and the request builders give the write path (docs-write.js, headings.js)
// the updateTextStyle / updateParagraphStyle requests of new or restyled paragraphs, with their inverse for undo.
// detectFormattingLine (the first-run pass, doc-init.js) measures the fonts and sizes a document already uses.
/* global alignName, alignToApi, apiEditing, dimensionPt, docsApi, headingName, HEADING_STYLES, hexFromOptionalColor, inverseTextStyles,
   knownFont, lineSpacingPercent, numText, parseAlign,
   numberIndent, numberedHeadingIndent, parseHeading, parseLength, parseLineSpacing, parseSize, PARA_CONTROL_KEYS, priorParaStyle, ptDimension, rangeRuns,
   registerPromptLine, reqParaStyle, reqTextStyle, sameIndent, state */
/* exported DEFAULT_FORMATTING_LINE, SHEET_TYPES, parseStyleSheet, resolveStyleSheet, styleSheetFor, sheetEntry,
   newParagraphSheetRequests, sheetParaStyle, newParaStyle, sheetLineChanges, sheetLineRequests, sheetLinesMiss, detectFormattingLine,
   fetchNamedStyles, fetchNamedStylesRaw, namedStyleValues, unmarkedDefault, DOCS_NAMED_DEFAULTS, FORMATTING_PROMPT_LINE, hasFormattingLine, parseNumbersEntry, sheetNumbersNotes,
   inheritedPara, inheritedIndent, turnNamedStyles, knowUnmarkedFont, parsePageEntry, pageWords, PAGE_SIZES, CONTROL_WORDS,
   DOCS_GREY_STYLES, namedColor, styleColors, styleColorNote, turnNamedKnown, unmarkedColors */

// The standard: Times New Roman everywhere (a heading without a font takes the body's), the heading sizes, justified body
// text without paragraph spacing, headings with space above only (scaled to their size); the weight stays as the document
// has it (bold or regular can still be written in a sheet).
// Headings keep with the next paragraph (Docs' own heading styles do too, so this writes nothing on most documents).
const DEFAULT_FORMATTING_LINE = 'Formatting: body Times New Roman 12 justify space 0/0; h1 16 space 18/0 keep-with-next; h2 14 space 14/0 keep-with-next; h3 12 space 12/0 keep-with-next; h4 12 space 12/0 keep-with-next; h5 12 space 12/0 keep-with-next; h6 12 space 12/0 keep-with-next';
// Sheet types -> namedStyleType.
const SHEET_TYPES = { body: 'NORMAL_TEXT', title: 'TITLE', subtitle: 'SUBTITLE', h1: 'HEADING_1', h2: 'HEADING_2', h3: 'HEADING_3',
  h4: 'HEADING_4', h5: 'HEADING_5', h6: 'HEADING_6' };
const FORMATTING_RE = /^\s*formatting\s*:/i;
const hasFormattingLine = (text) => String(text || '').split('\n').some((l) => FORMATTING_RE.test(l));

// ---- Parsing ----------------------------------------------------------------------------------------------------------
// The type word(s) at the start of an entry: [type, words used] or null. "body", "normal text", "H1", "heading 2", "Title".
function sheetType(words) {
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const k = parseHeading(words.slice(0, n).join(' '));
    if (k) return [k === 'normal' ? 'body' : k, n];
  }
  return null;
}
const isNumber = (w) => /^\d+(?:\.\d+)?(?:pt)?$/i.test(w);
// The paragraph-control words of an entry -> [ParagraphStyle field, value] ("h1 page-break", "h2 keep-with-next").
const CONTROL_WORDS = {
  'page-break': ['pageBreakBefore', true], 'page-break-before': ['pageBreakBefore', true], 'no-page-break': ['pageBreakBefore', false],
  'keep-with-next': ['keepWithNext', true], 'keep-next': ['keepWithNext', true], 'no-keep-with-next': ['keepWithNext', false], 'no-keep-next': ['keepWithNext', false],
  'keep-lines': ['keepLinesTogether', true], 'keep-lines-together': ['keepLinesTogether', true], 'no-keep-lines': ['keepLinesTogether', false],
  'widow-control': ['avoidWidowAndOrphan', true], 'no-widow-control': ['avoidWidowAndOrphan', false],
};
// A font name the sheet accepts: a common Docs font in any case, or a name whose words start with a capital or a digit
// ("Linux Libertine"); a lower-case unknown word is more likely a typo ("blod") and makes the entry invalid.
function sheetFont(words) {
  const f = knownFont(words.join(' '));
  if (!f || f.name.length > 100 || /[{}<>"]/.test(f.name)) return null;
  return f.known || words.every((w) => /^[\p{Lu}\d]/u.test(w)) ? f.name : null;
}
// One entry ("h1 Arial 16 bold align center") -> { type, values } or null when it is not valid (an unknown type, a
// value out of range, an unknown lower-case word). values holds only the fields the entry names.
function parseSheetEntry(raw) {
  const words = String(raw).trim().split(/\s+/).filter(Boolean);
  const t = sheetType(words);
  if (!t) return null;
  const [type, used] = t;
  const v = {};
  const font = [];
  const num = (w, min, max) => { const n = parseSize(w); return n != null && n >= min && n <= max ? n : null; };
  for (let i = used; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    const next = words[i + 1];
    if (CONTROL_WORDS[lw]) { const [f, b] = CONTROL_WORDS[lw]; v[f] = b; } else if (lw === 'bold') v.bold = true;
    else if (lw === 'regular') v.bold = false;
    else if (lw === 'italic') v.italic = true;
    else if (lw === 'upright') v.italic = false;
    else if (lw === 'pt' && i > used && isNumber(words[i - 1])) continue;
    else if (lw === 'spacing') {
      const p = next != null ? parseLineSpacing(next) : null;
      if (!p || p.value < 0.5 || p.value > 5) return null;
      v.lineSpacing = p.value; i++;
    } else if (lw === 'align') {
      const a = next != null ? parseAlign(next) : null;
      if (!a) return null;
      v.align = a; i++;
    } else if (lw === 'space') {
      // "space 12/6": pt above / pt below, the notation of the formatting view's tag.
      const m = next != null ? /^(\d+(?:\.\d+)?)(?:pt)?\/(\d+(?:\.\d+)?)(?:pt)?$/i.exec(next) : null;
      if (!m || Number(m[1]) > 200 || Number(m[2]) > 200) return null;
      v.spaceAbove = Number(m[1]); v.spaceBelow = Number(m[2]); i++;
    } else if (lw === 'first-line' || lw === 'firstline' || (lw === 'first' && String(next).toLowerCase() === 'line')) {
      if (lw === 'first') i++;
      const n = words[i + 1] != null ? num(words[i + 1], 0, 600) : null;
      if (n == null) return null;
      v.firstLine = n; i++;
    } else if (isNumber(w)) {
      const n = num(w, 1, 400);
      if (n == null) return null;
      v.size = n;
    } else if (['left', 'center', 'centre', 'centered', 'right', 'justify', 'justified'].includes(lw)) v.align = parseAlign(lw);
    else font.push(w);
  }
  if (font.length) {
    const f = sheetFont(font);
    if (!f) return null;
    v.font = f;
  }
  return { type, values: v };
}
// The numbers entry: where the heading text starts when format_lines numbers: set numbers the headings ("numbers
// 0.6/0.9/1.2": the text position in cm per level, h1/h2/h3 from the top level, the number at the margin; "numbers docs":
// Google Docs' own list indents). rest: the words after "numbers" -> { value: { docs: true } | { starts: [pt, pt, pt] } }
// or { error }. Points are rounded to half points (1 cm = 28.35 pt).
const CM_PT = 28.35;
const NUMBERS_HINT = 'write numbers 0.6/0.9/1.2 (where the heading text starts, in cm, for levels 1/2/3) or numbers docs (Google Docs\' list indents)';
function parseNumbersEntry(rest) {
  const t = String(rest || '').trim().toLowerCase().replace(/\s*cm$/, '');
  if (t === 'docs') return { value: { docs: true } };
  const parts = t.split('/').map((x) => x.trim().replace(/\s*cm$/, ''));
  const cm = parts.map((x) => (/^\d+(?:[.,]\d+)?$/.test(x) ? Number(x.replace(',', '.')) : NaN));
  if (cm.length !== 3 || cm.some((n) => !(n >= 0 && n <= 10))) return { error: `"numbers ${String(rest || '').trim()}" is ignored: ${NUMBERS_HINT}` };
  return { value: { starts: cm.map((n) => Math.round(n * CM_PT * 2) / 2) } };
}
// The page entry: the page setup (updateDocumentStyle; document_styles apply and page set it, nothing else does). rest:
// the words after "page" -> { value: { size: { name?, w, h } (pt, portrait order), orientation, marginTop, marginBottom,
// marginLeft, marginRight, marginHeader, marginFooter (pt), pageNumberStart, useFirstPageHeaderFooter, documentMode } (only
// the fields it names) } or { error }. Lengths in cm (the default), mm, in or pt; commas separate words like spaces.
const PAGE_SIZES = { a3: ['A3', 841.89, 1190.55], a4: ['A4', 595.28, 841.89], a5: ['A5', 419.53, 595.28], letter: ['Letter', 612, 792],
  legal: ['Legal', 612, 1008], tabloid: ['Tabloid', 792, 1224] };
const PAGE_HINT = 'write e.g. page A4 landscape, margins 2.5 cm, first page number 3, different first page (sizes A3, A4, A5, Letter, Legal, Tabloid or 21x29.7 cm; margins: one value, top-bottom/left-right or top/right/bottom/left; lengths in cm, mm, in or pt; header, footer, top, bottom, left, right N; pageless or pages)';
const MAX_MARGIN_PT = 567; // 20 cm
const MAX_HEADER_PT = 283.5; // 10 cm
function parsePageEntry(rest) {
  const raw = String(rest || '').trim();
  const fail = (why) => ({ error: `"page ${raw}" is ignored: ${why}; ${PAGE_HINT}` });
  const v = {};
  let t = ` ${raw.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').replace(/[,]/g, ' ').replace(/×/g, 'x')} `;
  t = t.replace(/(\d)\s+(cm|mm|inches|inch|in|pt)(?=[\s/x])/g, '$1$2').replace(/(\d(?:cm|mm|in|pt)?)\s*x\s*(\d)/g, '$1x$2')
    .replace(/(\d(?:cm|mm|in|pt)?)\s*\/\s*(?=\d)/g, '$1/');
  const phrase = (re, fn) => { t = t.replace(re, (...m) => { fn(m); return ' '; }); };
  phrase(/\s(?:no header on (?:the )?first page|different first page(?: header)?|first-page-header)(?=\s)/g, () => { v.useFirstPageHeaderFooter = true; });
  phrase(/\s(?:same first page(?: header)?|header on (?:the )?first page)(?=\s)/g, () => { v.useFirstPageHeaderFooter = false; });
  let badStart = '';
  phrase(/\s(?:first[ -]page[ -]number|page[ -]numbers? (?:start(?:s at)?|from)|page-number-start)\s+(\S+)(?=\s)/g, (m) => {
    if (/^\d{1,4}$/.test(m[1])) v.pageNumberStart = Number(m[1]); else badStart = m[1];
  });
  if (badStart) return fail(`the first page number must be a whole number (got "${badStart}")`);
  const words = t.trim().split(/\s+/).filter(Boolean);
  const len = (w, max, def = 'cm') => { const n = parseLength(w, def); return n != null && n <= max ? n : null; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    let m;
    if (PAGE_SIZES[w]) { const [name, pw, ph] = PAGE_SIZES[w]; v.size = { name, w: pw, h: ph }; } else if ((m = /^([\d.]+(?:cm|mm|in|pt)?)x([\d.]+)(cm|mm|in|pt)?$/.exec(w))) {
      const unit = m[3] || (/[a-z]+$/.exec(m[1]) || ['cm'])[0];
      const a = parseLength(m[1], unit);
      const b = parseLength(m[2] + (m[3] || ''), unit);
      if (a == null || b == null || Math.min(a, b) < 72 || Math.max(a, b) > 1700) return fail(`the page size "${w}" is out of range (2.54 to 60 cm a side)`);
      v.size = { w: Math.min(a, b), h: Math.max(a, b) };
    } else if (w === 'portrait' || w === 'landscape') v.orientation = w;
    else if (w === 'pageless') v.documentMode = 'PAGELESS';
    else if (w === 'pages' || w === 'paged') v.documentMode = 'PAGES';
    else if (w === 'margins' || w === 'margin') {
      const parts = String(next || '').split('/');
      const unit = (/(cm|mm|in|pt)$/.exec(parts[parts.length - 1]) || ['cm'])[0];
      const n = parts.map((x) => len(x, MAX_MARGIN_PT, unit));
      if (!next || ![1, 2, 4].includes(n.length) || n.some((x) => x == null)) return fail(`margins needs one, two or four lengths up to 20 cm (got "${next || ''}")`);
      const [top, right = top, bottom = top, left = right] = n.length === 2 ? [n[0], n[1], n[0], n[1]] : n;
      Object.assign(v, { marginTop: top, marginRight: right, marginBottom: bottom, marginLeft: left });
      i++;
    } else if (['top', 'bottom', 'left', 'right', 'header', 'footer'].includes(w)) {
      const field = `margin${w.charAt(0).toUpperCase()}${w.slice(1)}`;
      const max = w === 'header' || w === 'footer' ? MAX_HEADER_PT : MAX_MARGIN_PT;
      const n = next != null ? len(next, max) : null;
      if (n == null) return fail(`${w} needs a length up to ${max === MAX_HEADER_PT ? 10 : 20} cm (got "${next || ''}")`);
      v[field] = n; i++;
    } else return fail(`unknown word "${w}"`);
  }
  if (!Object.keys(v).length) return fail('it names no setting');
  return { value: v };
}
// Points as the sheet writes them: cm with at most two decimals.
const cmText = (pt) => numText(pt / (72 / 2.54));
// A page value (parsePageEntry's, or the document's) in the sheet's words: "A4 landscape margins 2.5 cm header 1.27 cm …".
function pageWords(v) {
  const w = [];
  if (v.size) {
    const named = Object.values(PAGE_SIZES).find(([, pw, ph]) => Math.abs(pw - v.size.w) < 1 && Math.abs(ph - v.size.h) < 1);
    w.push(v.size.name || (named ? named[0] : `${cmText(v.size.w)}x${cmText(v.size.h)} cm`));
  }
  if (v.orientation) w.push(v.orientation);
  const m = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].map((k) => v[k]);
  if (m.every((x) => x != null)) {
    const c = m.map(cmText);
    w.push(`margins ${c.every((x) => x === c[0]) ? c[0] : c[0] === c[2] && c[1] === c[3] ? `${c[0]}/${c[1]}` : c.join('/')} cm`);
  } else for (const [k, word] of [['marginTop', 'top'], ['marginBottom', 'bottom'], ['marginLeft', 'left'], ['marginRight', 'right']]) if (v[k] != null) w.push(`${word} ${cmText(v[k])} cm`);
  if (v.marginHeader != null) w.push(`header ${cmText(v.marginHeader)} cm`);
  if (v.marginFooter != null) w.push(`footer ${cmText(v.marginFooter)} cm`);
  if (v.pageNumberStart != null) w.push(`first page number ${v.pageNumberStart}`);
  if (v.useFirstPageHeaderFooter != null) w.push(v.useFirstPageHeaderFooter ? 'different first page' : 'same first page');
  if (v.documentMode) w.push(v.documentMode === 'PAGELESS' ? 'pageless' : 'pages');
  return w.join(' ');
}
// The Formatting: lines of a text (DOC.md, MAIN.md) -> { entries: { type: values }, ignored: [raw entries], numbers
// (parseNumbersEntry's value, or null), page (parsePageEntry's value, or null), errors: [messages of an invalid numbers or
// page entry] }, or null when the text has no Formatting: line. Later lines and later entries win field by field.
function parseStyleSheet(text) {
  const lines = String(text || '').split('\n').filter((l) => FORMATTING_RE.test(l));
  if (!lines.length) return null;
  const entries = {};
  const ignored = [];
  const errors = [];
  let numbers = null;
  let page = null;
  for (const line of lines) {
    for (const raw of line.replace(FORMATTING_RE, '').split(';')) {
      if (!raw.trim()) continue;
      const nm = /^\s*numbers(?:\s+|$)(.*)$/i.exec(raw);
      if (nm) {
        const n = parseNumbersEntry(nm[1]);
        if (n.error) { ignored.push(raw.trim()); errors.push(n.error); } else numbers = n.value;
        continue;
      }
      const pm = /^\s*page(?:\s+|$)(.*)$/i.exec(raw);
      if (pm) {
        const n = parsePageEntry(pm[1]);
        if (n.error) { ignored.push(raw.trim()); errors.push(n.error); } else page = { ...(page || {}), ...n.value };
        continue;
      }
      const e = parseSheetEntry(raw);
      if (!e) { ignored.push(raw.trim()); continue; }
      entries[e.type] = { ...(entries[e.type] || {}), ...e.values };
    }
  }
  return { entries, ignored, numbers, page, errors };
}

// ---- Precedence -------------------------------------------------------------------------------------------------------
// The sheet in force: the default, then MAIN.md's line, then DOC.md's, field by field; a heading, title or subtitle
// without a font takes the body's. Title and subtitle are in the sheet only when a line names them. Returns
// { types: { type: values }, source: 'DOC.md' | 'MAIN.md' | 'default' (the highest layer with a line), numbers (the
// numbers entry of the highest layer that sets one, or null: the standard of headings.js), page (the page entries merged
// field by field, or null: the default sets none), errors: [messages] }.
function resolveStyleSheet(docText, mainText) {
  const types = {};
  let source = 'default';
  let numbers = null;
  let page = null;
  const errors = [];
  for (const [name, text] of [['default', DEFAULT_FORMATTING_LINE], ['MAIN.md', mainText], ['DOC.md', docText]]) {
    const s = parseStyleSheet(text);
    if (!s) continue;
    if (name !== 'default') source = name;
    for (const [t, v] of Object.entries(s.entries)) types[t] = { ...(types[t] || {}), ...v };
    if (s.numbers) numbers = s.numbers;
    if (s.page) page = { ...(page || {}), ...s.page };
    errors.push(...s.errors.map((m) => `in the Formatting line of ${name}, ${m}`));
  }
  const body = types.body || {};
  for (const [t, v] of Object.entries(types)) if (t !== 'body' && v.font == null && body.font) v.font = body.font;
  return { types, source, numbers, page, errors };
}
// The result notes of a write that uses the numbers entry: the invalid entries, so the model can correct the line.
const sheetNumbersNotes = (sheet) => ((sheet && sheet.errors) || []).map((m) => `Note: ${m.charAt(0).toUpperCase()}${m.slice(1)}.`);
// The sheet of a turn: its frozen DOC.md and MAIN.md (the panel's when the snapshot has none).
function styleSheetFor(snap) {
  const s = snap || {};
  const doc = s.docInstructions != null ? s.docInstructions : state.docInstructions;
  const main = s.mainInstructions != null ? s.mainInstructions : state.mainInstructions;
  return resolveStyleSheet(doc, main);
}
// The sheet's values for a namedStyleType (NORMAL_TEXT and an unset style are body), or null.
function sheetEntry(sheet, namedStyle) {
  if (!sheet || !sheet.types) return null;
  const type = Object.keys(SHEET_TYPES).find((k) => SHEET_TYPES[k] === (namedStyle || 'NORMAL_TEXT'));
  const v = type ? sheet.types[type] : null;
  return v && Object.keys(v).length ? v : null;
}

// ---- Requests ---------------------------------------------------------------------------------------------------------
// The updateTextStyle of an entry: { textStyle, fields } for font, size, bold and italic, or null. The font is written
// with the weight its bold implies (Docs reads weightedFontFamily before bold, so bold in the same request survives).
function sheetTextStyle(v) {
  const textStyle = {};
  const fields = [];
  if (v.font) { textStyle.weightedFontFamily = { fontFamily: v.font, weight: v.bold ? 700 : 400 }; fields.push('weightedFontFamily'); }
  if (v.size != null) { textStyle.fontSize = ptDimension(v.size); fields.push('fontSize'); }
  if (v.bold != null) { textStyle.bold = v.bold; fields.push('bold'); }
  if (v.italic != null) { textStyle.italic = v.italic; fields.push('italic'); }
  return fields.length ? { textStyle, fields } : null;
}
// The updateParagraphStyle of an entry for a paragraph: { paragraphStyle, fields } for alignment, paragraph spacing, line
// spacing, the first-line indent and the paragraph controls (pageBreakBefore, keepWithNext, keepLinesTogether,
// avoidWidowAndOrphan), without the fields the call set itself (explicit: paragraphStyle field names), without the
// first-line indent on a list item (the list owns its indents) and without alignment, spacing and the controls on a body
// list item or a table cell (they keep the look of their list or table; Docs refuses a page break in a cell); or null.
function sheetParaStyle(v, line, explicit = []) {
  const ps = {};
  const fields = [];
  const dir = line && line.para ? line.para.direction : undefined;
  const own = !(line && (line.cell || (line.list && (line.style || 'NORMAL_TEXT') === 'NORMAL_TEXT')));
  if (v.align && own && !explicit.includes('alignment')) { ps.alignment = alignToApi(v.align, dir); fields.push('alignment'); }
  for (const f of ['spaceAbove', 'spaceBelow']) if (v[f] != null && own && !explicit.includes(f)) { ps[f] = ptDimension(v[f]); fields.push(f); }
  if (v.lineSpacing != null && !explicit.includes('lineSpacing')) { ps.lineSpacing = lineSpacingPercent(v.lineSpacing); fields.push('lineSpacing'); }
  if (v.firstLine != null && !explicit.includes('indentFirstLine') && !(line && line.list)) { ps.indentFirstLine = ptDimension(v.firstLine); fields.push('indentFirstLine'); }
  for (const f of PARA_CONTROL_KEYS) {
    if (v[f] == null || explicit.includes(f) || !own) continue;
    ps[f] = v[f]; fields.push(f);
  }
  return fields.length ? { paragraphStyle: ps, fields } : null;
}

// The requests that give new paragraphs their sheet values: paras [{ s, e, style, list?, noPara? }] (API indices of each
// new paragraph's text, e exclusive, without its newline; style its namedStyleType; list: it continues a list, so the
// list keeps its indents; noPara: text values only, its newline is an old paragraph's), in document order. One updateTextStyle
// per run of adjacent paragraphs with equal values (the newlines between them included), one updateParagraphStyle per
// paragraph with paragraph values (cell: inside a table cell). Undo of an insert deletes the text, so these need no inverse.
function newParagraphSheetRequests(model, sheet, paras) {
  const out = [];
  if (!sheet) return out;
  const ts = paras.map((p) => { const v = sheetEntry(sheet, p.style); return v ? sheetTextStyle(v) : null; });
  for (let i = 0; i < paras.length;) {
    let j = i + 1;
    const key = JSON.stringify(ts[i]);
    while (j < paras.length && JSON.stringify(ts[j]) === key && paras[j].s === paras[j - 1].e + 1) j++;
    const s = paras[i].s;
    const e = paras[j - 1].e;
    if (ts[i] && e > s) out.push(reqTextStyle(model, s, e, ts[i].textStyle, ts[i].fields));
    i = j;
  }
  for (const p of paras) {
    const v = p.noPara ? null : sheetEntry(sheet, p.style);
    const ps = v ? newParaStyle(model, v, p) : null;
    if (ps) out.push(reqParaStyle(model, p.s, Math.max(p.e, p.s + 1), ps.paragraphStyle, ps.fields));
  }
  return out;
}

// sheetParaStyle for a new paragraph p ({ list, cell, style }) without the controls it inherits already (a new heading keeps
// with the next paragraph through Docs' own heading style), so the default sheet adds no request to an insert.
function newParaStyle(model, v, p) {
  const ps = sheetParaStyle(v, { list: p.list, cell: p.cell, style: p.style });
  if (!ps) return null;
  const inh = inheritedPara(model && model.named, p.style || 'NORMAL_TEXT');
  const fields = ps.fields.filter((f) => !PARA_CONTROL_KEYS.includes(f) || !!inh[f] !== ps.paragraphStyle[f]);
  for (const f of ps.fields) if (!fields.includes(f)) delete ps.paragraphStyle[f];
  return fields.length ? { paragraphStyle: ps.paragraphStyle, fields } : null;
}
// The paragraph values a paragraph of namedStyleType style shows where it sets none: its named style's, else Normal
// text's, else Docs' defaults ({ align, spaceAbove, spaceBelow, lineSpacing (percent) }). named: namedStyleValues, or
// null when the named styles were not read (Docs' defaults then).
function inheritedPara(named, style) {
  const nm = named || {};
  const normal = { ...DOCS_NAMED_DEFAULTS.NORMAL_TEXT, ...(nm.NORMAL_TEXT || {}) }; // the controls: false when unset
  if (!style || style === 'NORMAL_TEXT') return normal;
  return { ...normal, spaceAbove: 0, spaceBelow: 0, ...(DOCS_NAMED_DEFAULTS[style] || {}), ...(nm[style] || {}) };
}
// The indents a paragraph of namedStyleType style draws where it sets none: its named style's, else Normal text's, else 0
// ({ indentStart, indentFirstLine }, pt), or null when the named styles were not read. A list item inherits no indent
// from its list level: Docs copies the level's indents onto the paragraph when the bullet is made, and a list item without
// an indent of its own is drawn at its named style's (chrome-check line-starts).
function inheritedIndent(named, style) {
  if (!named) return null;
  const own = named[style || 'NORMAL_TEXT'] || {};
  const normal = named.NORMAL_TEXT || {};
  return { indentStart: own.indentStart ?? normal.indentStart ?? 0, indentFirstLine: own.indentFirstLine ?? normal.indentFirstLine ?? 0 };
}
// The text values a run of a paragraph of namedStyleType style shows where it sets none ({ font, size, bold, italic }): its
// named style's, else Normal text's (bold, italic: false), or {} when the named styles were not read.
function inheritedTextValues(named, style) {
  if (!named || !named.NORMAL_TEXT) return {};
  const v = { ...named.NORMAL_TEXT, ...(named[style || 'NORMAL_TEXT'] || {}) };
  return { font: v.font, size: v.size, bold: !!v.bold, italic: !!v.italic };
}
// What an existing line lacks of its sheet entry v: { text: bool (a text value differs on some character), para: bool,
// controls: [the paragraph controls of v the line has already] }.
// style: the namedStyleType the line has or gets. A value the line does not set is compared with the one it inherits
// (model.named, the document's named styles read for the write; unread: a text value counts as missing): Docs does not
// store a text value equal to the inherited one (11 pt, black), so it counts as applied, and "left" is written where
// Normal text is justified and "spacing 1" where it has 1.15, and nothing where the inherited value matches already.
function sheetLineChanges(model, line, v, explicit = [], style = line.style) {
  const runs = line.text.length ? rangeRuns(model, { from: line.line, to: line.line, start: line.start, end: line.end }) : [];
  const it = inheritedTextValues(model && model.named, style || 'NORMAL_TEXT');
  const flag = (r, k) => (r[k] ? true : r[`${k}Off`] ? false : it[k] ?? false);
  const textDiff = runs.some(({ run }) => {
    const r = run || {};
    return (v.font && (r.font ?? it.font) !== v.font) || (v.size != null && (r.size ?? it.size) !== v.size)
      || (v.bold != null && flag(r, 'bold') !== v.bold) || (v.italic != null && flag(r, 'italic') !== v.italic);
  });
  const p = line.para || {};
  const ps = sheetParaStyle(v, line, explicit);
  const want = ps ? ps.fields : [];
  const inh = inheritedPara(model && model.named, style || 'NORMAL_TEXT');
  const differs = (f) => {
    if (f === 'alignment') return (p.align || inh.align || 'left') !== v.align;
    if (f === 'spaceAbove' || f === 'spaceBelow') return (p[f] ?? inh[f] ?? 0) !== v[f];
    if (f === 'lineSpacing') return (p.lineSpacing ?? inh.lineSpacing ?? 100) !== lineSpacingPercent(v.lineSpacing);
    if (PARA_CONTROL_KEYS.includes(f)) return !!(p[f] ?? inh[f]) !== v[f];
    return (p.indentFirstLine ?? inh.indentFirstLine ?? 0) !== v.firstLine;
  };
  const paraDiff = want.some(differs);
  // controls: the paragraph controls already as the sheet wants (left out of a write that changes other values)
  return { text: textDiff, para: paraDiff, controls: want.filter((f) => PARA_CONTROL_KEYS.includes(f) && !differs(f)) };
}

// The requests and their inverse that give existing lines (each { l, v, style?, glyphAt? } with its entry v; style: the
// named style the line gets, when the same edit changes it) their sheet values:
// the text style over the whole paragraph (its newline too, which carries a list's number), the paragraph values the
// call did not set (explicit). A font written without a bold value keeps the bold stretches the text had (Docs drops
// bold on a weightedFontFamily write). fill (number_headings, sheetFillText): the text values only where a run sets
// none itself, and the newline the style of the text at glyphAt. Returns { requests, inverse (restores every touched field
// exactly), filled: [{ line, fields }] (fill: the text fields written on the text from glyphAt) }.
function sheetLineRequests(model, items, explicit = [], fill = false) {
  const requests = [];
  const inverse = [];
  const filled = [];
  for (const { l, v, style, glyphAt } of items) {
    const ch = sheetLineChanges(model, l, v, explicit, style || l.style);
    const ts = !fill && ch.text ? sheetTextStyle(v) : null;
    if (ts) {
      const r = { from: l.line, to: l.line, start: l.start, end: l.end + 1 };
      const runs = rangeRuns(model, r);
      requests.push(reqTextStyle(model, r.start, r.end, ts.textStyle, ts.fields));
      const keepBold = ts.fields.includes('weightedFontFamily') && !ts.fields.includes('bold');
      const bolds = keepBold ? runs.filter(({ run }) => run && run.bold) : [];
      if (bolds.length) requests.push(...inverseTextStyles(model, bolds, ['bold']));
      inverse.push(...inverseTextStyles(model, runs, keepBold ? [...ts.fields, 'bold'] : ts.fields));
    }
    if (fill) {
      const f = sheetFillText(model, l, v, glyphAt ?? l.start);
      requests.push(...f.requests);
      inverse.push(...f.inverse);
      if (f.fields.length) filled.push({ line: l.line, fields: f.fields });
    }
    const ps = ch.para ? sheetParaStyle(v, l, [...explicit, ...ch.controls]) : null;
    if (ps) {
      requests.push(reqParaStyle(model, l.start, l.end + 1, ps.paragraphStyle, ps.fields));
      inverse.push(reqParaStyle(model, l.start, l.end + 1, priorParaStyle(l.para, ps.fields), ps.fields));
    }
  }
  return { requests, inverse, filled };
}

// The updateTextStyle fields a sheet entry can write (sheetTextStyle); whether a line-model run sets one itself (the line
// model keeps an explicit false bold or italic as boldOff / italicOff) and its value there.
const SHEET_TEXT_FIELDS = ['weightedFontFamily', 'fontSize', 'bold', 'italic'];
const sheetRunSets = (r, f) => !!r && (f === 'weightedFontFamily' ? r.font != null : f === 'fontSize' ? r.size != null
  : f === 'bold' ? !!(r.bold || r.boldOff) : !!(r.italic || r.italicOff));
const sheetRunValue = (r, f) => (f === 'weightedFontFamily' ? { fontFamily: r.font, weight: r.weight || 400 } : f === 'fontSize' ? ptDimension(r.size) : !!r[f]);
// The text of a heading Docs numbers (number_headings): the sheet's text values only where a run sets none of its own (the
// user's explicit formatting stays), and the newline, which carries the number Docs draws, the style of the text's run at
// glyphAt (its first character after a typed number that goes): its own values, else the sheet's, so number and text
// match. One request per stretch of equal values; a font written without bold keeps the bold stretches.
// Returns { requests, inverse, fields (the text fields written on the text from glyphAt) }.
function sheetFillText(model, l, v, glyphAt) {
  const ts = sheetTextStyle(v) || { textStyle: {}, fields: [] };
  const runs = rangeRuns(model, { from: l.line, to: l.line, start: l.start, end: l.end + 1 });
  const glyph = (runs.find(({ idx }) => idx >= glyphAt && idx < l.end) || runs[0] || {}).run || null;
  const want = runs.map(({ idx, run }) => {
    const nl = idx === l.end;
    const fields = SHEET_TEXT_FIELDS.filter((f) => (nl ? sheetRunSets(glyph, f) || ts.fields.includes(f) : ts.fields.includes(f) && !sheetRunSets(run, f)));
    const style = {};
    for (const f of fields) style[f] = nl && sheetRunSets(glyph, f) ? sheetRunValue(glyph, f) : ts.textStyle[f];
    return { idx, run, fields, style, key: JSON.stringify([fields, style]) };
  });
  const out = { requests: [], inverse: [], fields: [] };
  for (let i = 0; i < want.length;) {
    let j = i + 1;
    while (j < want.length && want[j].key === want[i].key) j++;
    const { fields, style } = want[i];
    const part = want.slice(i, j);
    i = j;
    if (!fields.length) continue;
    out.requests.push(reqTextStyle(model, part[0].idx, part[part.length - 1].idx + 1, style, fields));
    const keepBold = fields.includes('weightedFontFamily') && !fields.includes('bold');
    const bolds = keepBold ? part.filter(({ run }) => run && run.bold) : [];
    if (bolds.length) out.requests.push(...inverseTextStyles(model, bolds, ['bold']));
    out.inverse.push(...inverseTextStyles(model, part, keepBold ? [...fields, 'bold'] : fields));
    for (const f of fields) if (!out.fields.includes(f) && part.some(({ idx }) => idx >= glyphAt && idx < l.end)) out.fields.push(f);
  }
  return out;
}
// The lines of items ({ l, v } as planned; dl: lines moved) that the re-read model m still shows without their sheet
// values: [line numbers]. named: the named styles the plan compared with (the planning model's), so an inherited value
// counts the same way as when the plan was made.
function sheetLinesMiss(m, items, dl = 0, explicit = [], named = null) {
  const out = [];
  const mm = named && !m.named ? { ...m, named } : m;
  for (const { l, v } of items) {
    const now = m.lines[l.line - 1 + dl];
    if (!now) { out.push(l.line + dl); continue; }
    const ch = sheetLineChanges(mm, now, v, explicit);
    if (ch.text || ch.para) out.push(now.line);
  }
  return out;
}

// ---- The first-run detection ------------------------------------------------------------------------------------------
// Google Docs' own defaults (a new document's named styles), for text that inherits from a named style the read lacks.
const DOCS_NAMED_DEFAULTS = { NORMAL_TEXT: { font: 'Arial', size: 11, align: 'left', spaceAbove: 0, spaceBelow: 0, lineSpacing: 115 },
  HEADING_1: { size: 20, spaceAbove: 20, spaceBelow: 6, keepWithNext: true }, HEADING_2: { size: 16, spaceAbove: 18, spaceBelow: 6, keepWithNext: true },
  HEADING_3: { size: 14, spaceAbove: 16, spaceBelow: 4, keepWithNext: true }, HEADING_4: { size: 12, spaceAbove: 14, spaceBelow: 4, keepWithNext: true },
  HEADING_5: { size: 11, spaceAbove: 12, spaceBelow: 4, keepWithNext: true }, HEADING_6: { size: 11, spaceAbove: 12, spaceBelow: 4, keepWithNext: true } };
const NAMED_STYLES_FIELDS = 'namedStyles(styles(namedStyleType,textStyle(bold,italic,fontSize,weightedFontFamily,foregroundColor),paragraphStyle(alignment,direction,spaceAbove,spaceBelow,lineSpacing,'
  + 'indentStart,indentFirstLine,pageBreakBefore,keepWithNext,keepLinesTogether,avoidWidowAndOrphan)))';
const DETECT_MIN_BODY = 3;
const DETECT_MIN_HEADINGS = 2;
// The named styles of the document's tab as the API gives them: { namedStyleType: { textStyle, paragraphStyle } }.
// One small documents.get (the turn's read leaves the named styles out). Every read also refreshes the Normal text
// font, size and colour the formatting view's header falls back to (unmarkedDefault) and the styles' colours it names
// (unmarkedColors).
const namedNormalSeen = new Map(); // `${docId}|${tabId}` -> { font, size, color } of NORMAL_TEXT, colors: styleColors
async function fetchNamedStylesRaw(docId, tabId) {
  const tab = (d) => `tabProperties(tabId),documentTab(${NAMED_STYLES_FIELDS})` + (d > 1 ? `,childTabs(${tab(d - 1)})` : '');
  const doc = await docsApi(`${encodeURIComponent(docId)}?includeTabsContent=true&fields=${encodeURIComponent(`tabs(${tab(3)})`)}`);
  const flat = [];
  const walk = (ts) => { for (const t of ts || []) { flat.push(t); walk(t.childTabs); } };
  walk(doc && doc.tabs);
  const t = flat.find((x) => x.tabProperties && x.tabProperties.tabId === tabId) || flat[0];
  const out = {};
  const styles = (t && t.documentTab && t.documentTab.namedStyles && t.documentTab.namedStyles.styles) || [];
  for (const s of styles) if (s && s.namedStyleType) out[s.namedStyleType] = { textStyle: s.textStyle || {}, paragraphStyle: s.paragraphStyle || {} };
  const nm = namedStyleValues(out);
  const n = nm.NORMAL_TEXT || {};
  const nc = namedColor(nm, 'NORMAL_TEXT');
  namedNormalSeen.set(`${docId}|${tabId || ''}`, { font: n.font || null, size: n.size != null ? n.size : null,
    color: nc && nc !== BLACK ? nc : null, colors: styleColors(nm) });
  return out;
}
// fetchNamedStylesRaw's styles as { namedStyleType: { font, size, bold, italic, color ('#RRGGBB'), align, spaceAbove,
// spaceBelow, indentStart, indentFirstLine (pt), lineSpacing (percent), pageBreakBefore, keepWithNext, keepLinesTogether,
// avoidWidowAndOrphan } } (only the values the style sets; align read with the style's direction, else Normal text's).
// The color is read for what a heading shows (Docs greys Heading 3-6 and Subtitle); the sheet has none, so nothing
// compares or writes it.
function namedStyleValues(raw) {
  const out = {};
  for (const [type, s] of Object.entries(raw || {})) {
    const ts = s.textStyle || {};
    const wff = ts.weightedFontFamily && ts.weightedFontFamily.fontFamily;
    const color = hexFromOptionalColor(ts.foregroundColor);
    const ps = s.paragraphStyle || {};
    const align = alignName(ps.alignment, namedDirection(raw, type));
    const space = {};
    for (const k of ['spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine']) if (ps[k]) space[k] = dimensionPt(ps[k]);
    out[type] = { ...(wff ? { font: wff } : {}), ...(ts.fontSize ? { size: dimensionPt(ts.fontSize) } : {}), ...(ts.bold != null ? { bold: !!ts.bold } : {}),
      ...(ts.italic != null ? { italic: !!ts.italic } : {}), ...(color ? { color } : {}), ...(align ? { align } : {}), ...space,
      ...(typeof ps.lineSpacing === 'number' ? { lineSpacing: ps.lineSpacing } : {}),
      ...Object.fromEntries(PARA_CONTROL_KEYS.filter((k) => typeof ps[k] === 'boolean').map((k) => [k, ps[k]])) };
  }
  return out;
}
// The writing direction of a named style in fetchNamedStylesRaw's raw: its own, else Normal text's (undefined: left to right).
const namedDirection = (raw, type) => (((raw || {})[type] || {}).paragraphStyle || {}).direction
  || (((raw || {}).NORMAL_TEXT || {}).paragraphStyle || {}).direction;
const BLACK = '#000000';
// The named styles Docs colours in a new document (Heading 3 #434343, the others #666666): what a heading's colour is
// guessed to be while the document's named styles are unread.
const DOCS_GREY_STYLES = ['SUBTITLE', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];
// The colour text of namedStyleType type shows where it sets none: its named style's, else Normal text's, else black; null
// when the named styles were not read (named without Normal text). A style without a colour inherits Normal text's: the
// API leaves the field out (Title), it does not mean Docs' grey.
const namedColor = (named, type) => (named && named.NORMAL_TEXT ? (named[type || 'NORMAL_TEXT'] || {}).color || named.NORMAL_TEXT.color || BLACK : null);
// The styles whose text shows another colour than Normal text's: { namedStyleType: '#RRGGBB' } in HEADING_STYLES order
// ({} when unread).
function styleColors(named) {
  const out = {};
  const base = namedColor(named, 'NORMAL_TEXT');
  if (!base) return out;
  for (const type of Object.values(HEADING_STYLES)) if (namedColor(named, type) !== base) out[type] = namedColor(named, type);
  return out;
}
// The note of a write that gives lines the named styles types (namedStyleTypes) where one shows another colour than Normal
// text's, so the model knows why the text turned grey ("Note: the named style makes h4 text #666666."); '' when none
// does or named is unread.
function styleColorNote(types, named) {
  const colors = styleColors(named);
  const hit = Object.keys(colors).filter((t) => types.includes(t));
  if (!hit.length) return '';
  return `Note: the named style${hit.length > 1 ? 's make' : ' makes'} ${hit.map((t) => `${headingName(t)} text ${colors[t]}`).join(', ')}.`;
}
// The named styles the turn of snap has read already (turnNamedStyles), as namedStyleValues, or null (no new read).
function turnNamedKnown(snap) {
  const m = snap && snap.model;
  return m && snap.namedRaw && snap.namedRaw.key === `${m.docId}|${m.tabId || ''}` ? namedStyleValues(snap.namedRaw.raw) : null;
}
// The document's named styles for a turn (raw, as fetchNamedStylesRaw gives them), read once per turn and kept on the
// snapshot (snap.namedRaw; document_styles apply refreshes it), or null when the read fails or there is no Docs API model.
async function turnNamedStyles(snap) {
  const m = snap && snap.model;
  if (!m || !m.docId || snap.docFormat !== 'docs-api') return null;
  const key = `${m.docId}|${m.tabId || ''}`;
  if (snap.namedRaw && snap.namedRaw.key === key) return snap.namedRaw.raw;
  try {
    const raw = await fetchNamedStylesRaw(m.docId, m.tabId);
    snap.namedRaw = { key, raw };
    return raw;
  } catch (e) { return null; }
}
const fetchNamedStyles = async (docId, tabId) => namedStyleValues(await fetchNamedStylesRaw(docId, tabId));
// Before a formatting view of snap: reads the named styles (turnNamedStyles, once per turn) when the view needs Normal
// text's font: unformatted text is the most common and some run sets a font (Docs stores the font the text shows on a bold
// write), so the spans can leave out a font equal to it (docs-model.js spanDefault). colors: also when the document has a
// line of a style Docs greys and its named styles were not read in this panel session (the header names the styles'
// colours: unmarkedColors). Returns whether Normal text's font is known now.
async function knowUnmarkedFont(snap, colors = true) {
  const m = snap && snap.model;
  if (!m || snap.docFormat !== 'docs-api') return false;
  const font = !(m.textDefault && m.textDefault.font) && (m.lines || []).some((l) => (l.runs || []).some((r) => r.font));
  const grey = colors && !!m.docId && !namedNormalSeen.has(`${m.docId}|${m.tabId || ''}`) && (m.lines || []).some((l) => DOCS_GREY_STYLES.includes(l.style));
  if (!font && !grey) return false;
  const raw = await turnNamedStyles(snap);
  return font && !!raw;
}
// The formatting view's "Unmarked text:" values: the model's most common explicit font, size and colour, and where
// unformatted text is the most common, the Normal text style last read for the document (so the header follows a
// named-style update; its colour only when not black).
function unmarkedDefault(model) {
  const def = (model && model.textDefault) || null;
  const n = model && namedNormalSeen.get(`${model.docId}|${model.tabId || ''}`);
  if (!n) return def;
  const d = def || {};
  return { ...d, font: d.font || n.font, size: d.size != null ? d.size : n.size, color: d.color || n.color || null };
}
// The styles of model's lines whose text shows another colour than Normal text's, by the named styles last read for the
// document (styleColors): [[namedStyleType, '#RRGGBB']], [] when none or unread. The whole document's, so the formatting
// header is the same for every view and write result of a turn.
function unmarkedColors(model) {
  const n = model && namedNormalSeen.get(`${model.docId}|${model.tabId || ''}`);
  const colors = (n && n.colors) || {};
  if (!Object.keys(colors).length) return [];
  const present = new Set((model.lines || []).map((l) => l.style || 'NORMAL_TEXT'));
  return Object.keys(colors).filter((t) => present.has(t)).map((t) => [t, colors[t]]);
}
// The numbers entry of the numbering indents a document uses, or '' when they follow numbers (the entry of the sheet in
// force without DOC.md) or no heading is numbered by Docs. A numbered heading: h1–h6 outside tables in a nested numbered
// list, levels 0–2. Indents equal to the list level's own read as "docs"; otherwise the most frequent text position per
// level, in cm (a level without a heading takes the standard's). An indent a heading does not set is its named style's
// (inheritedIndent; named: namedStyleValues, Docs' defaults when null), not its list level's.
function detectNumbersEntry(model, numbers, named = null) {
  const heads = ((model && model.lines) || []).filter((l) => !l.cell && /^HEADING_[1-6]$/.test(l.style || '') && l.list && l.list.nested && l.list.level <= 2);
  if (!heads.length) return '';
  const nm = named || {};
  const start = (l) => ((l.para || {}).indentStart ?? inheritedIndent(nm, l.style).indentStart);
  const first = (l) => ((l.para || {}).indentFirstLine ?? inheritedIndent(nm, l.style).indentFirstLine);
  const isDocs = (l) => !!l.list.indent && start(l) === (l.list.indent.start || 0) && first(l) === (l.list.indent.first || 0);
  // The standard (no numbers entry; written out "numbers 0/0/0"): the number at the body text's edge (headings.js).
  const stdModel = { ...model, sheet: { numbers: null }, named: nm };
  const isStd = (l) => sameIndent(l, numberedHeadingIndent(stdModel, l), nm);
  const wants = (l) => (numbers.docs ? isDocs(l) : numbers.starts && !numbers.starts.some(Boolean) ? isStd(l) : sameIndent(l, numberIndent(l.list.level, numbers), nm));
  if (heads.every(wants)) return '';
  const own = heads.filter((l) => !isDocs(l));
  if (own.length * 2 <= heads.length) return numbers.docs ? '' : 'numbers docs';
  const std = !numbers.docs && !(numbers.starts || []).some(Boolean);
  if (own.every(isStd)) return std ? '' : 'numbers 0/0/0';
  const starts = [0, 1, 2].map((k) => {
    const counts = new Map();
    for (const l of own.filter((x) => x.list.level === k)) counts.set(start(l), (counts.get(start(l)) || 0) + 1);
    const v = counts.size ? mostOf(counts) : numberIndent(k, null).indentStart;
    return numText(Math.round((v / CM_PT) * 100) / 100);
  });
  const entry = `numbers ${starts.join('/')}`;
  return entry === 'numbers 0/0/0' && std ? '' : entry; // all at 0: written out like the standard, which applies already
}
// The most frequent value of a Map value -> count, or null.
const mostOf = (counts) => { let best = null; let n = -1; for (const [k, c] of counts) if (c > n) { best = k; n = c; } return best; };
// The Formatting: line of the fonts and sizes a document uses (the most frequent value by characters per type, body
// and h1–h6, outside tables; a run's own value, else its named style's, else Docs' default), or '' when the document
// has too little text (fewer than 3 body paragraphs or 2 headings) or follows the sheet that applies without DOC.md
// (mainText's line over the default) already; the weight, the alignment and the paragraph spacing count only where that
// sheet sets them (alignment and spacing outside lists: the sheet leaves list items alone), and the line then records
// the document's own alignment and spacing, so a left-aligned document is not justified by the next insert. The numbering indents
// count only when MAIN.md sets numbers (the standard does not make a document with other indents differ); when only
// they differ, the line has the numbers entry alone. named: fetchNamedStyles' result.
function detectFormattingLine(model, named, mainText) {
  const nm = named || {};
  const base = { ...DOCS_NAMED_DEFAULTS.NORMAL_TEXT, ...(nm.NORMAL_TEXT || {}) };
  const stats = {};
  let bodies = 0;
  let heads = 0;
  for (const l of (model && model.lines) || []) {
    if (l.cell || !l.text.trim()) continue;
    const style = l.style || 'NORMAL_TEXT';
    const type = Object.keys(SHEET_TYPES).find((k) => SHEET_TYPES[k] === style);
    if (!type || type === 'title' || type === 'subtitle') continue;
    if (type === 'body') bodies++; else heads++;
    const own = { ...base, bold: false, ...(DOCS_NAMED_DEFAULTS[style] || {}), ...(nm[style] || {}) };
    const st = stats[type] || (stats[type] = { font: new Map(), size: new Map(), bold: new Map(), align: new Map(), space: new Map() });
    const at = (i) => (l.runs || []).find((r) => r.s <= i && i < r.e) || {};
    const add = (k, val, n = 1) => st[k].set(val, (st[k].get(val) || 0) + n);
    for (let i = 0; i < l.text.length; i++) {
      const r = at(i);
      add('font', r.font || own.font);
      add('size', r.size != null ? r.size : own.size);
      add('bold', !!(r.bold || own.bold));
    }
    if (!l.list || type !== 'body') { // by characters, as the text values
      const p = l.para || {};
      add('align', p.align || own.align || 'left', l.text.length);
      add('space', `${numText(p.spaceAbove ?? own.spaceAbove ?? 0)}/${numText(p.spaceBelow ?? own.spaceBelow ?? 0)}`, l.text.length);
    }
  }
  if (bodies < DETECT_MIN_BODY || heads < DETECT_MIN_HEADINGS) return '';
  const sheetNow = resolveStyleSheet('', mainText);
  const now = sheetNow.types;
  const nums = sheetNow.numbers ? detectNumbersEntry(model, sheetNow.numbers, nm) : '';
  const order = ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].filter((t) => stats[t]);
  const found = order.map((t) => ({ t, font: mostOf(stats[t].font), size: mostOf(stats[t].size), bold: mostOf(stats[t].bold),
    align: mostOf(stats[t].align), space: mostOf(stats[t].space) }));
  const sheetSpace = (s) => (s.spaceAbove != null ? `${numText(s.spaceAbove)}/${numText(s.spaceBelow)}` : null);
  const same = found.every((f) => {
    const s = now[f.t] || {};
    return s.font === f.font && s.size === f.size && (f.t === 'body' || s.bold == null || !!s.bold === f.bold)
      && (!s.align || !f.align || s.align === f.align) && (!sheetSpace(s) || !f.space || sheetSpace(s) === f.space);
  });
  if (same) return nums ? `Formatting: ${nums}` : '';
  const entry = (f) => {
    const s = now[f.t] || {};
    return [f.t, f.font, numText(f.size), f.t === 'body' ? '' : f.bold ? 'bold' : 'regular',
      s.align && f.align ? f.align : '', sheetSpace(s) && f.space ? `space ${f.space}` : ''].filter(Boolean).join(' ');
  };
  return 'Formatting: ' + [...found.map(entry), ...(nums ? [nums] : [])].join('; ');
}

// ---- The head ---------------------------------------------------------------------------------------------------------
const FORMATTING_PROMPT_LINE = '- New paragraphs get the document\'s formatting sheet (Formatting: line in DOC.md or MAIN.md, e.g. "body Times New Roman 12 justify space 0/0; h1 16 space 18/0") by default; format_lines apply_sheet normalizes a range.';
registerPromptLine({ section: 'edit', line: FORMATTING_PROMPT_LINE, when: (mode, snap) => !!snap && apiEditing(mode, snap), names: 'formatting sheet' });
