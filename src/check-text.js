'use strict';
// Module check-text.js: the deterministic checks of /check (no model call, no network), pure functions over the lines
// of the document: ckDocument builds { lines, sections, titleBlock, bib } from the Docs API line model or the export
// text, and checkDocument runs the checks: acronyms (ckAcronyms: Schwartz–Hearst "Long Form (LF)" definitions, used
// before the definition, defined twice, never defined), pointers (ckPointers: Fig./Table/Eq./Section numbers without a
// caption or heading, captions never mentioned or numbered out of order), references (ckReferences: citation markers
// through claimItems against the parsed entries, ckParseEntry), word budgets (ckBudgetLine, ckBudgets), placeholders
// (ckPlaceholders), blind-review leftovers (ckBlind) and readability (ckReadability: Flesch, Oborneva for Russian).
// A finding: { group, kind, severity ('error' | 'warning' | 'note'), line, at, len, text } (at/len: the characters of
// the line it is about). check.js shows them; check-refs.js checks the parsed entries against Crossref and OpenAlex.
/* global claimItems, countWords, OBJECT_CHAR, parseDoi, sentenceSpans, textLang, textWords */
/* exported ckDocument, checkDocument, ckAcronyms, ckPointers, ckReferences, ckParseEntry, ckEntries, ckBudgetLine, ckBudgets,
   ckPlaceholders, ckBlind, ckReadability, ckFlesch, ckSyllables, ckAllowLine, CK_GROUPS, ckNormName, ckSortFindings */

// The report's groups, in report order.
const CK_GROUPS = [
  { id: 'acronyms', title: 'Acronyms' },
  { id: 'pointers', title: 'Figures, tables and cross-references' },
  { id: 'references', title: 'Citations and the reference list' },
  { id: 'reflist', title: 'Reference list against Crossref and OpenAlex' },
  { id: 'budgets', title: 'Word budgets' },
  { id: 'placeholders', title: 'Placeholders' },
  { id: 'blind', title: 'Blind review' },
  { id: 'readability', title: 'Readability' },
];
const CK_SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };
const ckSortFindings = (list) => list.slice().sort((a, b) => (CK_SEVERITY_ORDER[a.severity] - CK_SEVERITY_ORDER[b.severity]) || ((a.line || 0) - (b.line || 0)));
const ckPlural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const ckClip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// Names compared without case, diacritics and the ё / е difference.
const ckNormName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ё/g, 'е').replace(/й/g, 'и');

// ---- The document as lines ------------------------------------------------------------------------------------------
// A section heading's title without its numbering and final colon, lowercased.
const ckNormTitle = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/^\s*(?:\d+(?:\.\d+)*\.?|[ivx]+\.)\s+/, '')
  .replace(/[:.]\s*$/, '').replace(/\s+/g, ' ').trim();
const CK_BIB_TITLES = ['references', 'bibliography', 'literature', 'works cited', 'literature cited', 'references and notes', 'cited literature',
  'список литературы', 'литература', 'список использованной литературы', 'библиографический список', 'библиография', 'список источников'];
const CK_ABSTRACT_TITLES = ['abstract', 'summary', 'аннотация', 'реферат', 'резюме'];
// Back matter that may follow the reference list (a plain-text export has no heading styles to end the list).
const CK_BACK_MATTER_RE = /^(?:appendix|appendices|supplementary|supporting information|figure (?:legends|captions)|tables?|приложени\p{L}*)\b/iu;
// Markdown of the export: headings, emphasis, links and images to plain text.
function ckPlainMarkdown(s) {
  return String(s).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\((?:https?:|mailto:|#)[^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '').replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2').replace(/^\s*>\s?/, '');
}
// A plain-text line that reads like a heading: short, no final sentence mark, starts with a capital or a number.
function ckLooksLikeHeading(t) {
  const s = String(t).trim();
  // A comma: an author or affiliation line of the title block, not a heading.
  if (s.length < 2 || s.length > 80 || /[.,;!?…]$/.test(s) || s.includes(',') || !/^[\p{Lu}\d]/u.test(s) || !/\p{L}/u.test(s)) return false;
  if (CK_CAPTION_RE.figure.test(s) || CK_CAPTION_RE.table.test(s)) return false;
  return s.split(/\s+/).length <= 10;
}

// { lines: [{ line, text, heading, title, suggested, cell, list }], sections, titleBlock: [from, to], bib, format }.
// src: { model (the Docs API line model) } or { text, format: 'markdown' | 'text' }. Line numbers are those of the reading
// tools (model.lines, or the export text split at "\n").
function ckDocument(src) {
  const format = src.model ? 'docs-api' : src.format === 'markdown' ? 'markdown' : 'text';
  let lines;
  if (src.model) {
    lines = src.model.lines.map((l) => ({
      line: l.line, text: String(l.text || '').replaceAll('\u000b', ' ').replace(new RegExp(OBJECT_CHAR, 'g'), ' '),
      heading: l.heading || 0, title: l.style === 'TITLE' || l.style === 'SUBTITLE', suggested: !!l.suggested, cell: !!l.cell,
      list: l.list ? l.list.kind : null,
    }));
  } else {
    let inFence = false;
    lines = String(src.text || '').split('\n').map((raw, i) => {
      const out = { line: i + 1, text: raw, heading: 0, title: false, suggested: false, cell: false, list: null };
      if (format !== 'markdown') return out;
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; out.text = ''; return out; }
      if (inFence) return out;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (m) { out.heading = m[1].length; out.text = ckPlainMarkdown(m[2]); } else out.text = ckPlainMarkdown(raw);
      if (/^\s*\|.*\|\s*$/.test(raw)) out.cell = true; // a Markdown table row
      return out;
    });
    if (format === 'text') {
      // No heading styles: the first line is the title, short lines without a final mark are headings, and inside the
      // reference list only back-matter headings end it.
      const first = lines.find((l) => l.text.trim());
      if (first) first.title = true;
      let inBib = false;
      for (const l of lines) {
        if (l === first || !ckLooksLikeHeading(l.text)) continue;
        const t = ckNormTitle(l.text);
        if (inBib && !CK_BACK_MATTER_RE.test(t)) continue;
        const num = /^\s*(\d+(?:\.\d+)*)\.?\s/.exec(l.text);
        l.heading = num ? Math.min(6, num[1].split('.').length) : 1; // "1.1 Background" is a level-2 heading
        inBib = CK_BIB_TITLES.includes(t);
      }
    } else {
      // A first line that is a level-1 heading, with more headings after it, is the document title.
      const first = lines.find((l) => l.text.trim());
      if (first && first.heading === 1 && lines.some((l) => l.heading && l !== first)) first.title = true;
    }
  }
  const heads = lines.filter((l) => l.heading && !l.title && l.text.trim());
  const sections = heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.heading <= h.heading);
    const nextAny = heads[k + 1];
    return { title: h.text.trim(), norm: ckNormTitle(h.text), level: h.heading, line: h.line,
      from: h.line + 1, to: next ? next.line - 1 : lines.length, ownTo: nextAny ? nextAny.line - 1 : lines.length };
  });
  const firstHead = heads[0];
  const titleBlock = [1, firstHead ? firstHead.line - 1 : Math.min(1, lines.length)];
  const bibSec = sections.find((s) => CK_BIB_TITLES.includes(s.norm)) || null;
  const doc = { format, lines, sections, titleBlock, bib: bibSec };
  doc.inTitle = (n) => n >= titleBlock[0] && n <= titleBlock[1];
  doc.inBib = (n) => !!bibSec && n > bibSec.line && n <= bibSec.to;
  doc.body = lines.filter((l) => l.text.trim() && !doc.inTitle(l.line) && !doc.inBib(l.line) && !(bibSec && l.line === bibSec.line));
  doc.sectionOf = (n) => { let s = null; for (const x of sections) if (x.line <= n) s = x; else break; return s; };
  doc.inAbstract = (n) => { const s = doc.sectionOf(n); return !!s && CK_ABSTRACT_TITLES.includes(s.norm); };
  return doc;
}

const ckFinding = (group, kind, severity, l, at, len, text) => ({ group, kind, severity, line: l ? l.line : 0, at: at || 0, len: len == null ? (l ? l.text.length : 0) : len, text });

// ---- Acronyms -----------------------------------------------------------------------------------------------------------
// 2–6 capitals (Latin or Cyrillic), digits allowed, a plural "s" allowed; not a Roman numeral (меди(II)), a mutation
// (C87S), a chemical formula (H2O: a digit before a capital) or a word of an all-caps line (a heading).
const CK_ACRO_RE = /(?<![\p{L}\p{N}_])(\p{Lu}[\p{Lu}\p{N}]{1,7})s?(?![\p{L}\p{N}_])/gu;
const CK_ROMAN_RE = /^X{0,3}(?:IX|IV|V?I{0,3})$/;
// Well known ones and units in capitals; a document-instructions line "acronyms: ABC, XYZ" adds more (ckAllowLine).
const CK_ACRO_ALLOW = new Set(['DNA', 'RNA', 'MRNA', 'PCR', 'USA', 'UK', 'EU', 'UN', 'WHO', 'NASA', 'UNESCO', 'NATO', 'ATP', 'ADP', 'NADH',
  'NADPH', 'HIV', 'AIDS', 'COVID', 'SARS', 'CO2', 'CH4', 'NO2', 'SO2', 'O2', 'N2', 'H2', 'UV', 'IR', 'AM', 'PM', 'BC', 'AD', 'CE', 'BCE', 'UTC', 'GMT',
  'ID', 'OK', 'TV', 'PC', 'PDF', 'HTML', 'URL', 'DOI', 'ISBN', 'ISSN', 'GB', 'MB', 'KB', 'TB', 'PPM', 'PPB', 'RPM', 'DPI', 'CV',
  'ДНК', 'РНК', 'СССР', 'США', 'РФ', 'ООН', 'РАН', 'ВОЗ', 'СНГ', 'ЕС', 'АТФ', 'ГБ', 'МБ', 'КБ']);
const ckAcroKey = (t) => t.toUpperCase().replace(/Ё/g, 'Е');
// "acronyms: ABC, XYZ" lines of the document instructions: the extra allowed acronyms (keys).
function ckAllowLine(instructions) {
  const out = new Set();
  for (const m of String(instructions || '').matchAll(/^\s*acronyms?\s*:\s*(.+)$/gimu)) {
    for (const t of m[1].split(/[,;\s]+/)) if (t.trim()) out.add(ckAcroKey(t.trim()));
  }
  return out;
}
const ckValidAcronym = (tok) => {
  const caps = (tok.match(/\p{Lu}/gu) || []).length;
  return caps >= 2 && caps <= 6 && !CK_ROMAN_RE.test(tok) && !/^\p{Lu}\d+\p{Lu}$/u.test(tok) && !/\d\p{Lu}/u.test(tok);
};
// Schwartz & Hearst (2003), findBestLongForm: the shortest end of lf whose characters match sf's from the right, the
// first character of sf at the start of a word. null when none.
function ckLongForm(sf, lf) {
  const low = (c) => (c || '').toLowerCase().replace('ё', 'е');
  const alnum = (c) => /[\p{L}\p{N}]/u.test(c || '');
  let s = sf.length - 1;
  let l = lf.length - 1;
  for (; s >= 0; s--) {
    const c = low(sf[s]);
    if (!alnum(c)) continue;
    while ((l >= 0 && low(lf[l]) !== c) || (s === 0 && l > 0 && alnum(lf[l - 1]))) l--;
    if (l < 0) return null;
    l--;
  }
  const start = lf.lastIndexOf(' ', l) + 1;
  const out = lf.slice(start).trim();
  return out.length > sf.length ? out : null;
}
// The definitions "long form (SF)" of one line: [{ key, sf, lf, at, len, strict }]; at/len: the SF in the brackets.
// strict: the long form was found (Schwartz–Hearst); otherwise a bracketed acronym right after a word still counts as a
// definition (a Russian long form of an English acronym), but only when nothing defined it before.
function ckDefinitions(text) {
  const out = [];
  for (const m of text.matchAll(/\(([^()]{1,60})\)/g)) {
    const inner = m[1].replace(/^\s*(?:hereafter|hereinafter|далее)\s*[-–—:]?\s*/iu, '');
    const sfm = /^\s*(\p{Lu}[\p{Lu}\p{N}]{1,7})s?\s*(?:[,;]|$)/u.exec(inner);
    if (!sfm || !ckValidAcronym(sfm[1])) continue;
    const before = text.slice(0, m.index);
    if (!/[\p{L}\p{N}][\s\u00a0]*$/u.test(before)) continue;
    const sf = sfm[1];
    const words = before.replace(/[\s\u00a0]+$/, '').split(/\s+/);
    const cand = words.slice(-Math.min(sf.length + 5, sf.length * 2)).join(' ');
    const lf = ckLongForm(sf, cand.replace(/^.*[.;:!?]\s+/u, ''));
    const at = m.index + 1 + m[1].indexOf(sf);
    out.push({ key: ckAcroKey(sf), sf, lf, at, len: sf.length, strict: !!lf });
  }
  return out;
}
// The acronym findings of the body (the title block and the reference list are not read).
function ckAcronyms(doc, { allow = new Set() } = {}) {
  const acr = new Map(); // key -> { sf, uses: [{ l, at, len }], defs: [{ l, at, len, lf, strict }] }
  const entry = (key, sf) => { if (!acr.has(key)) acr.set(key, { sf, uses: [], defs: [] }); return acr.get(key); };
  for (const l of doc.body) {
    if (!/\p{Ll}/u.test(l.text)) continue; // an all-caps line (a heading)
    const defs = ckDefinitions(l.text);
    const defAt = new Set(defs.map((d) => d.at));
    for (const d of defs) entry(d.key, d.sf).defs.push({ l, at: d.at, len: d.len, lf: d.lf, strict: d.strict });
    for (const m of l.text.matchAll(CK_ACRO_RE)) {
      if (defAt.has(m.index) || !ckValidAcronym(m[1])) continue;
      entry(ckAcroKey(m[1]), m[1]).uses.push({ l, at: m.index, len: m[1].length });
    }
  }
  const out = [];
  const pos = (x) => x.l.line * 1e6 + x.at;
  for (const [key, a] of acr) {
    if (CK_ACRO_ALLOW.has(key) || allow.has(key)) continue;
    const first = a.defs.find((d) => d.strict) || a.defs[0];
    // A loose definition after a strict one, or a second loose one, is a use.
    const defs = a.defs.filter((d) => d === first || d.strict);
    for (const d of a.defs) if (!defs.includes(d)) a.uses.push(d);
    a.uses.sort((x, y) => pos(x) - pos(y));
    if (!defs.length) {
      const u = a.uses[0];
      out.push(ckFinding('acronyms', 'acronym-undefined', 'warning', u.l, u.at, u.len,
        `${a.sf} is never defined (${a.uses.length === 1 ? 'used once' : `used ${a.uses.length} times`}).`));
      continue;
    }
    defs.sort((x, y) => pos(x) - pos(y));
    const def = defs[0];
    const early = a.uses.filter((u) => pos(u) < pos(def));
    if (early.length) {
      const u = early[0];
      out.push(ckFinding('acronyms', 'acronym-before-definition', 'warning', u.l, u.at, u.len,
        `${a.sf} is used before its definition on line ${def.l.line}${def.lf ? ` (${ckClip(def.lf, 50)})` : ''}.`));
    }
    // Defined again: fine once in the abstract and once in the main text.
    let bodyAllowed = doc.inAbstract(def.l.line);
    for (const d of defs.slice(1)) {
      if (bodyAllowed && !doc.inAbstract(d.l.line)) { bodyAllowed = false; continue; }
      out.push(ckFinding('acronyms', 'acronym-twice', 'note', d.l, d.at, d.len, `${a.sf} is defined again (first on line ${def.l.line}).`));
    }
  }
  return out;
}

// ---- Pointers: figures, tables, equations, sections ----------------------------------------------------------------------
const CK_NUM_LIST = '(S?\\d+[A-Za-zА-Яа-я]?(?:\\s*(?:[,;–—-]|and|&|и)\\s*S?\\d+[A-Za-zА-Яа-я]?)*)';
const CK_POINTER_RE = {
  figure: new RegExp(`(?<![\\p{L}])(?:fig(?:ure)?s?\\.?|рис(?:\\.|ун\\p{L}*))\\s*${CK_NUM_LIST}`, 'giu'),
  table: new RegExp(`(?<![\\p{L}])(?:tables?|tab\\.|табл(?:\\.|иц\\p{L}*))\\s*${CK_NUM_LIST}`, 'giu'),
  equation: /(?<![\p{L}])(?:eqs?\.|equations?|ур\.|уравнени\p{L}*|формул\p{L}*)\s*(\(?\s*\d+\s*\)?(?:\s*(?:[,–—-]|and|и)\s*\(?\s*\d+\s*\)?)*)/giu,
  section: /(?<![\p{L}])(?:sections?|sect\.|sec\.|§|разд\.|раздел\p{L}*)\s*(\d+(?:\.\d+)*(?:\s*(?:,|and|и)\s*\d+(?:\.\d+)*)*)/giu,
};
// Captions at a line start: "Figure 2." / "Fig. 2:" / "Рис. 2." / "Рисунок 2 –", "Table 1" (alone or before a mark).
const CK_CAPTION_RE = {
  figure: /^\s*(?:figure|fig\.?|рис\.|рисунок)\s*(\d+)[a-zа-я]?\s*(?:[.:|—–-]|$)/iu,
  table: /^\s*(?:table|tab\.|таблица|табл\.)\s*(\d+)\s*(?:[.:|—–-]|$)/iu,
};
const CK_EQ_LINE_RE = /\(\s*(\d+)\s*\)\s*[.,;]?\s*$/;
const CK_NUMBERED_HEADING_RE = /^\s*(\d+(?:\.\d+)*)\.?\s+\p{L}/u;
const CK_KIND_LABEL = { figure: 'Figure', table: 'Table', equation: 'Equation', section: 'Section' };
const CK_KIND_LABEL_RU = { figure: 'Рис.', table: 'Таблица', equation: 'Equation', section: 'Section' };
// The numbers of a pointer's list: "2–4" → 2, 3, 4; "2 and 5"; supplementary ones (S2) left out.
function ckPointerNumbers(list, sectionKind) {
  const out = [];
  const parts = String(list).replace(/[()]/g, ' ').split(/\s*(?:[,;]|\band\b|&|(?<!\p{L})и(?!\p{L}))\s*/u);
  for (const p of parts) {
    const t = p.trim();
    if (!t || /^S/i.test(t)) continue;
    if (sectionKind) { if (/^\d+(?:\.\d+)*$/.test(t)) out.push(t); continue; }
    const r = /^(\d+)[a-zа-я]?\s*[–—-]\s*(\d+)[a-zа-я]?$/iu.exec(t);
    if (r && Number(r[2]) > Number(r[1]) && Number(r[2]) - Number(r[1]) <= 20) { for (let n = Number(r[1]); n <= Number(r[2]); n++) out.push(String(n)); continue; }
    const n = /^(\d+)/.exec(t);
    if (n) out.push(String(Number(n[1])));
  }
  return out;
}
function ckPointers(doc) {
  const captions = { figure: [], table: [] };
  const targets = { figure: new Set(), table: new Set(), equation: new Set(), section: new Set() };
  const mentions = { figure: new Map(), table: new Map(), equation: new Map(), section: new Map() };
  const out = [];
  for (const l of doc.body) {
    for (const kind of ['figure', 'table']) {
      const m = CK_CAPTION_RE[kind].exec(l.text);
      if (m) { captions[kind].push({ n: String(Number(m[1])), l, len: m[0].trimEnd().length }); targets[kind].add(String(Number(m[1]))); }
    }
    const eq = CK_EQ_LINE_RE.exec(l.text);
    if (eq && (/[=≈<>≤≥]/.test(l.text) || l.cell || l.text.trim().length < 30)) targets.equation.add(String(Number(eq[1])));
    if (l.heading) { const h = CK_NUMBERED_HEADING_RE.exec(l.text); if (h) targets.section.add(h[1]); }
  }
  const autoNumbered = doc.lines.some((l) => l.heading && !l.title && l.list === 'number');
  for (const l of doc.body) {
    const capKind = ['figure', 'table'].find((k) => CK_CAPTION_RE[k].test(l.text));
    for (const kind of Object.keys(CK_POINTER_RE)) {
      for (const m of l.text.matchAll(CK_POINTER_RE[kind])) {
        if (capKind === kind && m.index <= l.text.search(/\S/)) continue; // the caption's own number
        for (const n of ckPointerNumbers(m[1], kind === 'section')) {
          if (!mentions[kind].has(n)) mentions[kind].set(n, []);
          mentions[kind].get(n).push({ l, at: m.index, len: m[0].length });
        }
      }
    }
  }
  for (const kind of Object.keys(mentions)) {
    if (kind === 'section' && autoNumbered) continue; // the heading numbers are list numbers, not text
    for (const [n, list] of mentions[kind]) {
      if (targets[kind].has(n)) continue;
      const u = list[0];
      const ru = /\p{Script=Cyrillic}/u.test(u.l.text.substr(u.at, u.len));
      const label = ru ? CK_KIND_LABEL_RU[kind] : CK_KIND_LABEL[kind];
      const where = kind === 'section' ? `no heading numbered ${n}` : kind === 'equation' ? `no equation numbered (${n})` : `no caption "${label} ${n}." at a line start`;
      out.push(ckFinding('pointers', `dangling-${kind}`, 'error', u.l, u.at, u.len,
        `${CK_KIND_LABEL[kind]} ${n} is mentioned${list.length > 1 ? ` ${list.length} times` : ''} but there is ${where}.`));
    }
  }
  for (const kind of ['figure', 'table']) {
    let prev = 0;
    const seen = new Set();
    for (const c of captions[kind]) {
      const n = Number(c.n);
      if (!mentions[kind].has(c.n)) out.push(ckFinding('pointers', `${kind}-unmentioned`, 'warning', c.l, 0, c.len, `${CK_KIND_LABEL[kind]} ${n} is never mentioned in the text.`));
      if (seen.has(n)) out.push(ckFinding('pointers', 'caption-order', 'warning', c.l, 0, c.len, `${CK_KIND_LABEL[kind]} ${n} has a second caption.`));
      else if (n !== prev + 1) out.push(ckFinding('pointers', 'caption-order', 'warning', c.l, 0, c.len,
        prev ? `${CK_KIND_LABEL[kind]} ${n} follows ${CK_KIND_LABEL[kind]} ${prev}: captions out of order.` : `The first ${kind} caption is ${CK_KIND_LABEL[kind]} ${n}, not ${CK_KIND_LABEL[kind]} 1.`));
      seen.add(n);
      prev = Math.max(prev, n);
    }
  }
  return out;
}

// ---- References -----------------------------------------------------------------------------------------------------------
const CK_ENTRY_NUM_RE = /^\s*(?:\[(\d+)\]|(\d+)[.)])\s*/;
const CK_YEAR_RE = /(?<!\d)((?:1[6-9]|20)\d\d)([a-zа-я])?(?!\d)/u;
const CK_NAME = "\\p{Lu}[\\p{L}'’-]+";
// An author list at the start of an entry (Vancouver and similar: "Smith J, Lee KM, et al." / "Smith, J., Lee, K."),
// up to the period before the title.
const CK_INITIALS = "(?:\\p{Lu}(?:\\.|\\p{Lu}{0,2}(?!\\p{L}))\\s*){1,3}";
const CK_AUTHORS_RE = new RegExp(`^(?:(?:${CK_NAME}(?:,?\\s+|,\\s*)${CK_INITIALS}|${CK_INITIALS}${CK_NAME})(?:\\s*(?:,|and|&|и)\\s*)*)+` +
  '(?:et al\\.?|и др\\.?)?\\s*[.,]?\\s*', 'u');
// Books, theses, preprints, proceedings and web pages: often not in Crossref or OpenAlex.
const CK_NOT_INDEXED_RE = /\b(?:thesis|dissertation|phd|preprint|arxiv|biorxiv|medrxiv|chemrxiv|ssrn|press|publishers?|edition|ed\.|eds\.|isbn|proceedings|conference|symposium|report|retrieved|available at|https?:\/\/)|(?:диссертаци|автореферат|монографи|изд\.|издательств|учебн|сборник|материалы конф|тезисы|[МЛ]\.:|СПб\.:|ГОСТ)/iu;
// One reference entry: { n (its number or null), surname, key ("surname year" as claimItems makes it), year, doi, title,
// venue, notIndexed, text }.
function ckParseEntry(raw, listNumber = null) {
  let text = String(raw || '').replace(/^\s*[-*•]\s+/, '').trim();
  const num = CK_ENTRY_NUM_RE.exec(text);
  const n = num ? Number(num[1] || num[2]) : listNumber;
  if (num) text = text.slice(num[0].length).trim();
  const doi = parseDoi(text);
  const yearM = /\(\s*((?:1[6-9]|20)\d\d)([a-zа-я])?\s*\)/u.exec(text) || CK_YEAR_RE.exec(text);
  const year = yearM ? yearM[1] : null;
  const suffix = yearM && yearM[2] ? yearM[2] : '';
  // "Surname, I." / "Surname I. I." / "Фамилия И.И." / "Surname IJ," (Vancouver) / "I. Surname"
  let surname = null;
  const lead = new RegExp(`^(?:(?:\\p{Lu}\\.\\s*){1,3})(${CK_NAME})`, 'u').exec(text) || new RegExp(`^(${CK_NAME})(?=[,\\s])`, 'u').exec(text);
  if (lead) surname = lead[1];
  // The title: in quotes (IEEE); after "(2020)."; else after the author list (Vancouver: "Smith J, Lee K. Title.").
  let cand = '';
  const quoted = /[“"«]([^”"»]{8,})[”"»]/u.exec(text);
  const afterYear = /\(\s*(?:1[6-9]|20)\d\d[a-zа-я]?\s*\)\.?\s*(.+)/u.exec(text);
  const afterAuthors = CK_AUTHORS_RE.exec(text);
  if (quoted) cand = quoted[1];
  else if (afterYear) cand = afterYear[1];
  else if (afterAuthors) cand = text.slice(afterAuthors[0].length);
  const cut = /([.?!])(?=\s+[\p{Lu}\d]|\s*$)/u.exec(cand);
  const title = (cut ? cand.slice(0, cut.index + (cut[1] === '.' ? 0 : 1)) : cand).replace(/[,.\s]+$/, '').trim();
  // The venue: what follows the title, up to the volume numbers.
  let venue = '';
  const at = title ? text.indexOf(title) : -1;
  const rest = at >= 0 ? text.slice(at + title.length).replace(/^[\s.?!,”"»]+/u, '') : '';
  const v = /^([^\d(]{3,120}?)(?=[\s,.;]*(?:\d|\(|$))/u.exec(rest);
  if (v) venue = v[1].replace(/^(?:in:?\s+)/i, '').replace(/[\s,.;:]+$/, '').trim();
  return {
    n, surname, year, doi, title, venue, text, notIndexed: CK_NOT_INDEXED_RE.test(text) && !doi,
    key: surname && year ? `${ckNormName(surname)} ${year}${suffix}` : null,
  };
}
// The entries of the reference list: one per non-empty line ([{ ...ckParseEntry, l }]); a numbered Docs list gives its
// numbers (they are not in the text).
function ckEntries(doc) {
  if (!doc.bib) return [];
  const out = [];
  let k = 0;
  for (const l of doc.lines) {
    if (l.line <= doc.bib.line || l.line > doc.bib.to || !l.text.trim()) continue;
    if (l.heading && CK_BACK_MATTER_RE.test(ckNormTitle(l.text))) break;
    const listNumber = l.list === 'number' ? ++k : null;
    out.push({ ...ckParseEntry(l.text, listNumber), l });
  }
  return out;
}
// Where a citation of claimItems is in its line: [at, len].
function ckLocateCitation(text, c) {
  if (/^\[\d+\]$/.test(c.key)) {
    const n = Number(c.key.slice(1, -1));
    for (const m of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
      const has = m[1].split(',').some((p) => { const r = p.trim().split(/\s*[–-]\s*/).map(Number); return r.length === 2 ? n >= r[0] && n <= r[1] : r[0] === n; });
      if (has) return [m.index, m[0].length];
    }
    return [0, text.length];
  }
  const [name, year] = c.key.split(' ');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc(name)}[^()\\n]{0,80}?${esc(year)}`, 'iu').exec(text);
  return m ? [m.index, m[0].length] : [0, text.length];
}
function ckReferences(doc, entries = ckEntries(doc)) {
  const out = [];
  const cites = [];
  for (const l of doc.body) {
    for (const c of claimItems(l.text).citations) {
      if (!/^\[\d+\]$/.test(c.key) && !/^\S+ \d{4}[a-zа-я]?$/u.test(c.key)) continue; // a DOI in the text is its own reference
      const [at, len] = ckLocateCitation(l.text, c);
      cites.push({ key: /^\[/.test(c.key) ? c.key : ckNormName(c.key), text: c.text, l, at, len });
    }
  }
  if (!doc.bib) {
    if (cites.length) out.push(ckFinding('references', 'no-reference-list', 'warning', cites[0].l, cites[0].at, cites[0].len,
      `${ckPlural(cites.length, 'citation marker')} but no References section (a heading "References", "Bibliography", "Список литературы"…).`));
    return out;
  }
  const byNum = new Map();
  const byKey = new Map();
  for (const e of entries) {
    if (e.n != null) byNum.set(`[${e.n}]`, e);
    if (e.key) { byKey.set(e.key, e); if (!byKey.has(e.key.replace(/[a-zа-я]$/u, ''))) byKey.set(e.key.replace(/[a-zа-я]$/u, ''), e); }
  }
  const cited = new Set();
  const reported = new Set();
  for (const c of cites) {
    const e = byNum.get(c.key) || byKey.get(c.key) || byKey.get(c.key.replace(/[a-zа-я]$/u, ''));
    if (e) { cited.add(e); continue; }
    const id = c.key + '@' + c.l.line;
    if (reported.has(id)) continue;
    reported.add(id);
    const shown = /^\[/.test(c.key) ? c.key : c.l.text.substr(c.at, c.len);
    out.push(ckFinding('references', 'unknown-citation', 'error', c.l, c.at, c.len, `${ckClip(shown, 60)} matches no entry of the reference list.`));
  }
  const unparsed = [];
  for (const e of entries) {
    if (cited.has(e)) continue;
    if (e.n == null && !e.key) { unparsed.push(e); continue; }
    out.push(ckFinding('references', 'uncited-reference', 'warning', e.l, 0, e.l.text.length,
      `${e.n != null ? `[${e.n}] ` : ''}${ckClip(e.surname || e.text, 30)}${e.year ? ` (${e.year})` : ''} is never cited in the text.`));
  }
  if (unparsed.length) out.push(ckFinding('references', 'unparsed-entry', 'note', unparsed[0].l, 0, unparsed[0].l.text.length,
    `${ckPlural(unparsed.length, 'entry', 'entries')} without a number or an author and year: not matched to citations.`));
  return out;
}

// ---- Word budgets -----------------------------------------------------------------------------------------------------------
// "budget: abstract 250, introduction 800, total 6000 (source: https://…)" in the document instructions:
// { limits: [{ name, words }], total, source } or null.
function ckBudgetLine(instructions) {
  const m = /^\s*(?:word\s+)?budgets?\s*:\s*(.+)$/imu.exec(String(instructions || ''));
  if (!m) return null;
  let rest = m[1];
  let source = '';
  const s = /\(?\s*source\s*:\s*([^\s)]+)\s*\)?\s*$/iu.exec(rest);
  if (s) { source = s[1]; rest = rest.slice(0, s.index); }
  const limits = [];
  let total = null;
  for (const part of rest.split(/[,;]/)) {
    const p = /^\s*(.+?)\s*[:=]?\s*(\d[\d\s\u00a0]*)\s*(?:words?|слов\p{L}*)?\s*$/iu.exec(part);
    if (!p) continue;
    const name = p[1].trim().toLowerCase().replace(/ё/g, 'е');
    const words = Number(p[2].replace(/\D/g, ''));
    if (!words) continue;
    if (/^(?:total|whole|document|всего|итого|весь текст)$/u.test(name)) total = words;
    else limits.push({ name, words });
  }
  return limits.length || total ? { limits, total, source } : null;
}
const ckWords = (lines) => lines.reduce((n, l) => n + countWords(l.text), 0);
function ckBudgets(doc, budget) {
  const out = [];
  if (!budget) return out;
  const src = budget.source ? ` (source: ${budget.source})` : '';
  const say = (sec, name, words, limit) => (words > limit
    ? ckFinding('budgets', 'over-budget', 'warning', sec, 0, null, `${name}: ${words.toLocaleString('en-US')} words, ${(words - limit).toLocaleString('en-US')} over the budget of ${limit.toLocaleString('en-US')}${src}.`)
    : ckFinding('budgets', 'within-budget', 'note', sec, 0, null, `${name}: ${words.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} words.`));
  for (const b of budget.limits) {
    const sec = doc.sections.find((s) => s.norm === b.name) || doc.sections.find((s) => s.norm.startsWith(b.name) || s.norm.includes(b.name));
    if (!sec) { out.push(ckFinding('budgets', 'budget-no-section', 'note', null, 0, 0, `No section matches "${b.name}" of the budget line.`)); continue; }
    const lines = doc.lines.filter((l) => l.line >= sec.from && l.line <= sec.to && !(l.heading && !l.title));
    const head = doc.lines[sec.line - 1];
    out.push(say(head, sec.title, ckWords(lines), b.words));
  }
  if (budget.total) {
    const words = ckWords(doc.body.filter((l) => !l.heading));
    out.push(say(null, 'Whole document (without the title block and the reference list)', words, budget.total));
  }
  return out;
}

// ---- Placeholders ------------------------------------------------------------------------------------------------------------
const CK_PLACEHOLDER_RE = /\[\[\s*(?:\?|todo\b[^\]\n]*)\s*\]\]/giu;
function ckPlaceholders(doc) {
  const out = [];
  for (const l of doc.lines) for (const m of l.text.matchAll(CK_PLACEHOLDER_RE)) out.push(ckFinding('placeholders', 'placeholder', 'error', l, m.index, m[0].length, `Open placeholder ${ckClip(m[0], 40)}.`));
  return out;
}

// ---- Blind review ----------------------------------------------------------------------------------------------------------------
const CK_SELF_RE = [
  /\bour (?:own )?(?:lab|laboratory|group|team|institute|department|university|centre|center)\b/giu,
  /(?<=\b(?:in|from|of|see) )our (?:previous|earlier|prior|recent) (?:work|works|study|studies|paper|papers|report|reports|publication|publications)\b/giu,
  /(?<!\p{L})(?:наш(?:а|ей|ем|у|его|их|ими|ем)?|в нашей|нашей)\s+(?:лаборатори\p{L}*|групп\p{L}*|коллектив\p{L}*|институт\p{L}*|кафедр\p{L}*)/giu,
  /(?<!\p{L})(?:в наших (?:предыдущих|ранних|прежних|недавних) работах|(?:нами ранее|ранее нами) (?:было )?(?:показано|установлено|описано|получено))/giu,
];
const CK_AFFIL_RE = /\b(?:University|Institute|College|Academy) of \p{Lu}|\b\p{Lu}\p{L}+ (?:University|Institute)\b/u;
const CK_ACK_HEAD_RE = /^\s*(?:acknowledg(?:e)?ments?|funding|financial support|conflicts? of interest|author contributions|благодарност\p{L}*|финансировани\p{L}*|вклад авторов)\s*[:.]?\s*$/iu;
const CK_ACK_RE = /\b(?:this (?:work|study|research|project) was (?:supported|funded|financed)|(?:is|was) funded by|grant (?:no\.|number|#)|we (?:thank|are grateful to|acknowledge))\b|(?<!\p{L})(?:работа выполнена (?:при|в рамках)|при (?:финансовой )?поддержке|авторы благодарят|выражаем благодарность)/iu;
const CK_NAME_STOP = new Set(['and', 'the', 'of', 'for', 'department', 'university', 'institute', 'school', 'faculty', 'college', 'center', 'centre',
  'laboratory', 'email', 'corresponding', 'author', 'authors', 'и', 'кафедра', 'университет', 'институт', 'факультет', 'лаборатория']);
// Surnames from the title block (the lines after the title, before the first heading): lines of capitalized words
// without an affiliation or an e-mail.
function ckAuthorNames(doc) {
  const names = new Map();
  for (const l of doc.lines) {
    if (!doc.inTitle(l.line) || l.title || !l.text.trim()) continue;
    if (doc.lines.findIndex((x) => x.text.trim()) === l.line - 1) continue; // the first line is the title
    const t = l.text;
    if (/@|https?:|\b(?:University|Institute|Department|Faculty|School|Laboratory|Universit\p{L}*|Institut\p{L}*)\b|университет|институт|кафедр|факультет/iu.test(t) || t.length > 300) continue;
    const words = t.replace(/[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹⁰,;]+/gu, ' ').split(/\s+/).filter(Boolean);
    const caps = words.filter((w) => /^\p{Lu}/u.test(w));
    if (words.length > 20 || caps.length < Math.ceil(words.length * 0.6)) continue;
    for (const w of caps) {
      const name = w.replace(/[.'’]+$/u, '');
      if (name.length < 3 || /\.$/.test(w) || CK_NAME_STOP.has(name.toLowerCase())) continue;
      if (!names.has(name)) names.set(name, l.line);
    }
  }
  return names;
}
// opts.model: the Docs API was used (suggestions are known); opts.comments: [{ line, text }] of the open comment threads,
// or { error } when they could not be read; absent on the export path.
function ckBlind(doc, { comments = null } = {}) {
  const out = [];
  for (const l of doc.body) {
    for (const re of CK_SELF_RE) for (const m of l.text.matchAll(re)) out.push(ckFinding('blind', 'blind-self', 'warning', l, m.index, m[0].length, `Self-identifying phrase «${m[0]}».`));
    if (/\b(?:we|our|us)\b/iu.test(l.text)) {
      for (const sp of sentenceSpans(l.text)) {
        const a = CK_AFFIL_RE.exec(sp.text);
        if (a && /\b(?:we|our|us)\b/iu.test(sp.text)) out.push(ckFinding('blind', 'blind-self', 'warning', l, sp.start + a.index, a[0].length, `An affiliation next to "we" or "our": «${ckClip(a[0], 40)}».`));
      }
    }
    if (CK_ACK_HEAD_RE.test(l.text)) out.push(ckFinding('blind', 'blind-ack', 'warning', l, 0, null, `${ckClip(l.text.trim(), 40)}: remove from the anonymized copy.`));
    else {
      const a = CK_ACK_RE.exec(l.text);
      if (a) out.push(ckFinding('blind', 'blind-ack', 'warning', l, a.index, a[0].length, `Acknowledgement or funding line «${ckClip(a[0], 40)}».`));
    }
  }
  const names = ckAuthorNames(doc);
  for (const [name, from] of names) {
    const re = new RegExp(`(?<![\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u');
    for (const l of doc.body) {
      const m = re.exec(l.text);
      if (m) { out.push(ckFinding('blind', 'blind-author', 'warning', l, m.index, m[0].length, `Author name «${name}» (title block, line ${from}) appears in the text.`)); break; }
    }
  }
  if (doc.format === 'docs-api') {
    const sug = doc.lines.filter((l) => l.suggested);
    for (const l of sug.slice(0, 20)) out.push(ckFinding('blind', 'suggestion', 'warning', l, 0, null, 'Unresolved suggested change.'));
    if (sug.length > 20) out.push(ckFinding('blind', 'suggestion', 'warning', null, 0, 0, `${sug.length - 20} more lines with suggested changes.`));
  }
  if (comments && comments.error) out.push(ckFinding('blind', 'comments-unread', 'note', null, 0, 0, `Could not read the comments: ${comments.error}`));
  else if (Array.isArray(comments)) {
    for (const c of comments.slice(0, 30)) {
      const l = c.line ? doc.lines[c.line - 1] : null;
      out.push(ckFinding('blind', 'open-comment', 'warning', l, 0, null, `Open comment${c.text ? `: «${ckClip(c.text, 50)}»` : ''}${l ? '' : ` (${c.where || 'not anchored to a body line'})`}.`));
    }
    if (comments.length > 30) out.push(ckFinding('blind', 'open-comment', 'warning', null, 0, 0, `${comments.length - 30} more open comments.`));
  } else if (doc.format !== 'docs-api') {
    out.push(ckFinding('blind', 'no-api', 'note', null, 0, 0, 'Suggested changes and comments are checked only with a Google account (Docs API).'));
  }
  return out;
}

// ---- Readability ---------------------------------------------------------------------------------------------------------------
// Syllables: Russian, the vowels; English, vowel groups with a silent final "e" and "-es" / "-ed" dropped (at least one).
function ckSyllables(word, lang) {
  const w = String(word).toLowerCase();
  if (lang === 'ru') return (w.match(/[аеёиоуыэюя]/g) || []).length;
  let s = w.replace(/[^a-z]/g, '');
  if (!s) return 0;
  if (s.length <= 3) return 1;
  s = s.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]).replace(/^y/, '');
  return Math.max(1, (s.match(/[aeiouy]{1,2}/g) || []).length);
}
// Flesch reading ease (English: 206.835 − 1.015·ASL − 84.6·ASW) or Oborneva's adaptation for Russian (206.835 −
// 1.3·ASL − 60.1·ASW); ASL: words per sentence, ASW: syllables per word. { score, words, sentences, lang } or null.
function ckFlesch(text, lang = textLang(text)) {
  const sentences = sentenceSpans(text, lang).filter((s) => /\p{L}/u.test(s.text));
  const words = textWords(text).filter((w) => /\p{L}/u.test(w));
  if (!sentences.length || !words.length) return null;
  const syll = words.reduce((n, w) => n + ckSyllables(w, lang), 0);
  const asl = words.length / sentences.length;
  const asw = syll / words.length;
  const score = lang === 'ru' ? 206.835 - 1.3 * asl - 60.1 * asw : 206.835 - 1.015 * asl - 84.6 * asw;
  return { score: Math.round(score * 10) / 10, words: words.length, sentences: sentences.length, lang };
}
const ckBand = (s) => (s >= 70 ? 'easy' : s >= 50 ? 'standard' : s >= 30 ? 'difficult' : 'dense');
const CK_READ_MIN_WORDS = 40;
function ckReadability(doc) {
  const out = [];
  for (const sec of doc.sections) {
    if (doc.bib && sec === doc.bib) continue;
    const text = doc.lines.filter((l) => l.line >= sec.from && l.line <= sec.ownTo && !l.cell && l.text.trim()).map((l) => l.text).join('\n');
    if (countWords(text) < CK_READ_MIN_WORDS) continue;
    const r = ckFlesch(text);
    if (!r) continue;
    out.push(ckFinding('readability', 'readability', 'note', doc.lines[sec.line - 1], 0, null,
      `${sec.title}: ${r.score} (${ckBand(r.score)}; ${r.lang === 'ru' ? 'Oborneva' : 'Flesch'}, ${r.words} words, ${(r.words / r.sentences).toFixed(1)} per sentence).`));
  }
  return out;
}

// ---- All checks ----------------------------------------------------------------------------------------------------------------
// doc: ckDocument; opts: { instructions, comments }. { groups: { id: [findings] }, entries, budget }.
function checkDocument(doc, { instructions = '', comments } = {}) {
  const entries = ckEntries(doc);
  const budget = ckBudgetLine(instructions);
  const groups = {
    acronyms: ckAcronyms(doc, { allow: ckAllowLine(instructions) }),
    pointers: ckPointers(doc),
    references: ckReferences(doc, entries),
    reflist: [],
    budgets: ckBudgets(doc, budget),
    placeholders: ckPlaceholders(doc),
    blind: ckBlind(doc, { comments }),
    readability: ckReadability(doc),
  };
  if (!budget) groups.budgets.push(ckFinding('budgets', 'no-budget', 'note', null, 0, 0, 'No budget line in the document instructions, for example: budget: abstract 250, total 6000 (source: https://…).'));
  for (const id of Object.keys(groups)) groups[id] = ckSortFindings(groups[id]);
  return { groups, entries, budget };
}
