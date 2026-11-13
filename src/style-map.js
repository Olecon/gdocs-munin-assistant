'use strict';
// Module style-map.js: style_map, a reading tool for checking formatting. For one style parameter (or all of them) it
// lists every value the document's lines use and where (all: the properties with one value on one line, the ones whose
// values fall on the same places merged into one section): whole lines merged into ranges, a stretch inside a line with its
// character span (1-based, inclusive, counted in characters as the read_document text shows them). Text values come
// from the line model's runs; text without an explicit value is named after the style it inherits (the document's
// named styles are read once per call, so the defaults are the document's own; an explicit paragraph value equal to
// its named style's own reads "(= h2 style)", else one equal to the formatting sheet's entry "(= h2 sheet)"; an indent a
// line does not set reads "inherited (h2 style)", never its list level's). Docs API only: the export has no formatting.
/* global fetchNamedStylesRaw, hasFormattingLine, headingName, inheritedIndent, onDemandOffer, lineSpacingMultiplier, lineSpacingPercent, namedColor, namedStyleValues, numText, readLimits,
   readScope, registerTools, sheetEntry, styleSheetFor, unmarkedDefault */
/* exported STYLE_MAP_TOOL, STYLE_MAP_PROPS, styleAsked, sheetRecorded, STYLE_MAP_MAX_VALUES, STYLE_MAP_MAX_PLACES, styleMap, runStyleMap */

const STYLE_MAP_TEXT_PROPS = ['font', 'size', 'bold', 'italic', 'underline', 'color', 'background'];
const STYLE_MAP_PARA_PROPS = ['align', 'style', 'list', 'indent', 'space', 'line_spacing'];
const STYLE_MAP_PROPS = [...STYLE_MAP_TEXT_PROPS, ...STYLE_MAP_PARA_PROPS];
const STYLE_MAP_MAX_VALUES = 12; // values listed per property
const STYLE_MAP_MAX_PLACES = 8; // ranges listed per value
const STYLE_MAP_NO_API = 'Not available without the Google Docs API: the export carries no formatting.';
// Under every indent listing with an inherited value, a narrow call on the inheriting line alone too (a live model read
// the other lines in a second call and never saw the note): copying the numbers would draw the same but leave the line
// out of the style (a live model copied them, also onto the title).
const INDENT_INHERIT_NOTE = 'To make a line match an inherited one, set its indent_start and indent_first_line to "style", not the numbers.';
const inheritedIndentValue = (v) => v.includes(', inherited (');

const STYLE_MAP_TOOL = { type: 'function', function: {
  name: 'style_map',
  description: 'Where each value of a style parameter occurs: lines and, inside a line, character positions. For checking formatting. property: font, size, bold, italic, underline, color, background, align, style (named style), list, indent, space, line_spacing or all.',
  parameters: {
    type: 'object',
    properties: {
      property: { type: 'string', enum: [...STYLE_MAP_PROPS, 'all'] },
      scope: { anyOf: [{ type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'], additionalProperties: false },
        { type: 'string', enum: ['all'] }, { type: 'null' }] },
    },
    required: ['property', 'scope'],
    additionalProperties: false,
  },
} };

// ---- Values ------------------------------------------------------------------------------------------------------
const STYLE_KEY = { TITLE: 'title', SUBTITLE: 'subtitle' };
const styleWord = (style) => headingName(style) || STYLE_KEY[style] || 'normal';
const fontSize = (v) => [v.font, v.size != null ? numText(v.size) : ''].filter(Boolean).join(' ');
// The label of text with no explicit value of prop: a heading inherits its named style, normal text the Normal text
// style ("(default: Arial 11)" for font and size, "(none)" for the rest). named: namedStyleValues, or null when unread.
// color, named read: the style's colour when not black ("(h4 style: #666666)", a heading Docs greys), else "(none)".
function unsetText(prop, line, named, normal) {
  const w = styleWord(line.style);
  const two = prop === 'font' || prop === 'size';
  const color = prop === 'color' ? namedColor(named, line.style) : null;
  if (color) return color === '#000000' ? '(none)' : w === 'normal' ? `(default: ${color})` : `(${w} style: ${color})`;
  if (w === 'normal') {
    if (!two) return '(none)';
    const fs = fontSize(normal);
    return fs ? `(default: ${fs})` : '(default)';
  }
  const own = (named && named[line.style]) || {};
  // Bold and italic of a style are read with it; its colour too (above), so an unread one stays "(h2 style)".
  if (prop === 'underline' || prop === 'background') return '(none)';
  if ((prop === 'bold' || prop === 'italic') && named) return own[prop] ? `(${w} style: ${prop})` : '(none)';
  if (!two) return `(${w} style)`;
  const fs = fontSize({ font: own.font || normal.font, size: own.size != null ? own.size : null });
  return fs ? `(${w} style: ${fs})` : `(${w} style)`;
}
// A run's explicit value of a text property, or null.
function runValue(prop, r) {
  if (!r) return null;
  switch (prop) {
    case 'font': return r.font || null;
    case 'size': return r.size != null ? numText(r.size) : null;
    case 'bold': case 'italic': return r[prop] ? prop : r[`${prop}Off`] ? `not ${prop}` : null; // an explicit false is a value
    case 'underline': return r[prop] ? prop : null;
    case 'color': return r.color || null;
    case 'background': return r.bg || null;
    default: return null;
  }
}
const ptPair = (a, b) => `${a == null ? '-' : numText(a)}/${b == null ? '-' : numText(b)} pt`;
// A named style's own value of a paragraph field (a heading inherits what it leaves unset from Normal text), or undefined.
const namedPara = (named, line, k) => {
  const own = (named[line.style] || {})[k];
  return own !== undefined ? own : (named.NORMAL_TEXT || {})[k];
};
// A sheet entry's paragraph values in the line model's units (lineSpacing in percent).
const sheetPara = (v) => ({ align: v.align, spaceAbove: v.spaceAbove, spaceBelow: v.spaceBelow,
  lineSpacing: v.lineSpacing != null ? lineSpacingPercent(v.lineSpacing) : undefined });
// Where an explicit value comes from, so that a heading's own spacing (written explicitly on insertion) is told apart
// from spacing added on top of it: " (= h2 style)" when every field the paragraph sets equals its named style's own
// value, else " (= h2 sheet)" when they equal the formatting sheet's entry for the line's style; '' otherwise.
// named / sheet: null when unread or absent.
function sameAsStyle(keys, line, named, sheet) {
  const p = line.para || {};
  const set = keys.filter((k) => p[k] != null);
  if (!set.length) return '';
  const w = styleWord(line.style);
  if (named && set.every((k) => namedPara(named, line, k) === p[k])) return ` (= ${w} style)`;
  const e = sheet ? sheetEntry(sheet, line.style) : null;
  const sv = e && sheetPara(e);
  if (sv && set.every((k) => sv[k] === p[k])) return ` (= ${w === 'normal' ? 'body' : w} sheet)`;
  return '';
}
// The one value of a paragraph property for a line. A value the paragraph does not set is the named style's: "(style)",
// with the style's alignment or spacing when the named styles were read; an explicit value equal to the style's or the
// sheet's own is marked.
function paraValue(prop, line, named, sheet) {
  const p = line.para || {};
  switch (prop) {
    case 'style': return styleWord(line.style);
    case 'list': return line.list ? line.list.kind + (line.list.level > 0 ? ` L${line.list.level + 1}` : '') : 'none';
    case 'align': {
      if (p.align) return p.align + sameAsStyle(['align'], line, named, sheet);
      const a = named && ((named[line.style] || {}).align || (named.NORMAL_TEXT || {}).align);
      return a ? `${a} (style)` : '(style)';
    }
    case 'indent': return indentValue(line, named);
    case 'space': {
      if (p.spaceAbove != null || p.spaceBelow != null) return ptPair(p.spaceAbove, p.spaceBelow) + sameAsStyle(['spaceAbove', 'spaceBelow'], line, named, sheet);
      const a = named ? namedPara(named, line, 'spaceAbove') : undefined;
      const b = named ? namedPara(named, line, 'spaceBelow') : undefined;
      return a == null && b == null ? '(style)' : `${ptPair(a, b)} (style)`;
    }
    case 'line_spacing': return p.lineSpacing != null
      ? numText(lineSpacingMultiplier(p.lineSpacing)) + sameAsStyle(['lineSpacing'], line, named, sheet) : '(style)';
    default: return '';
  }
}
// A line's indent as Docs draws it: the paragraph's own value, else its named style's, else Normal text's, else 0
// (inheritedIndent: a list item without an indent of its own draws its named style's, not its list level's). The sides
// are named after format_lines' parameters, "start 28.5, first line 21.26 pt": a live model read a bare "28.5/21.26" as
// left/right and set indent_end (read_document's line tags keep "indent 28.5/21.26": one per line, and an end indent
// has a tag of its own there). A value the line does not set is marked, since only a line without an own value inherits a
// change of the style: ", inherited (h2 style)", or "(first line inherited)" when only that side is. Named styles not
// read: an unset value has no number ("no own indent", "start 36 pt (first line: no own indent)").
const indentPair = (s, f) => `start ${numText(s)}, first line ${numText(f)} pt`;
function indentValue(line, named) {
  const p = line.para || {};
  const ownS = p.indentStart != null;
  const ownF = p.indentFirstLine != null;
  const inh = inheritedIndent(named, line.style) || {};
  if (!named && (!ownS || !ownF)) {
    if (!ownS && !ownF) return 'no own indent';
    return ownS ? `start ${numText(p.indentStart)} pt (first line: no own indent)` : `first line ${numText(p.indentFirstLine)} pt (start: no own indent)`;
  }
  const s = ownS ? p.indentStart : inh.indentStart;
  const f = ownF ? p.indentFirstLine : inh.indentFirstLine;
  if (!s && !f) return 'none';
  if (ownS && ownF) return indentPair(s, f);
  if (ownS || ownF) return `${indentPair(s, f)} (${ownS ? 'first line' : 'start'} inherited)`;
  const own = named[line.style] || {};
  return `${indentPair(s, f)}, inherited (${own.indentStart != null || own.indentFirstLine != null ? styleWord(line.style) : 'normal'} style)`;
}
// The stretches of a line by their value of a text property: [{ s, e, v }] (offsets in the line text, e exclusive),
// adjacent equal values merged; an empty line is one stretch.
function textStretches(prop, line, unset) {
  const t = line.text;
  const out = [];
  const push = (s, e, v) => {
    const last = out[out.length - 1];
    if (last && last.v === v && last.e === s) last.e = e;
    else if (e > s) out.push({ s, e, v });
  };
  let at = 0;
  for (const r of line.runs || []) {
    if (r.s > at) push(at, r.s, unset);
    push(r.s, r.e, runValue(prop, r) || unset);
    at = Math.max(at, r.e);
  }
  if (at < t.length) push(at, t.length, unset);
  return out.length ? out : [{ s: 0, e: t.length, v: unset }];
}
// Characters (code points, as read_document shows them) before offset off of text.
const charsBefore = (text, off) => Array.from(text.slice(0, off)).length;

// ---- The map -----------------------------------------------------------------------------------------------------
// values: Map value -> { places: [{ line, spans: null | [[a, b]] }], lines: count } in document order.
function collectValues(prop, lines, from, to, named, normal, sheet) {
  const values = new Map();
  const add = (v, line, span) => {
    if (!values.has(v)) values.set(v, { places: [], lines: 0 });
    const e = values.get(v);
    const last = e.places[e.places.length - 1];
    if (span && last && last.line === line && last.spans) { last.spans.push(span); return; }
    e.places.push({ line, spans: span ? [span] : null });
    e.lines++;
  };
  for (let n = from; n <= to; n++) {
    const l = lines[n - 1];
    if (STYLE_MAP_PARA_PROPS.includes(prop)) { add(paraValue(prop, l, named, sheet), n, null); continue; }
    const parts = textStretches(prop, l, unsetText(prop, l, named, normal));
    if (parts.length === 1) { add(parts[0].v, n, null); continue; }
    for (const p of parts) add(p.v, n, [charsBefore(l.text, p.s) + 1, charsBefore(l.text, p.e)]);
  }
  return values;
}
// "lines 1–40, 41 (chars 3–10), 42" with whole lines merged into ranges, at most STYLE_MAP_MAX_PLACES items.
function placesText(places) {
  const items = [];
  for (const p of places) {
    const last = items[items.length - 1];
    if (!p.spans && last && !last.spans && last.b === p.line - 1) { last.b = p.line; continue; }
    items.push(p.spans ? { a: p.line, b: p.line, spans: p.spans } : { a: p.line, b: p.line });
  }
  const shown = items.slice(0, STYLE_MAP_MAX_PLACES).map((it) => (it.a === it.b ? String(it.a) : `${it.a}–${it.b}`) +
    (it.spans ? ` (chars ${it.spans.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ')})` : ''));
  const more = items.length - shown.length;
  const one = items.length === 1 && items[0].a === items[0].b;
  return `${one ? 'line' : 'lines'} ${shown.join(', ')}${more > 0 ? `, … and ${more} more place${more === 1 ? '' : 's'}` : ''}`;
}
// One property's values, the ones with the most lines first: [{ v, places, lines, i }].
function propertyValues(prop, lines, from, to, named, normal, sheet) {
  return [...collectValues(prop, lines, from, to, named, normal, sheet)].map(([v, e], i) => ({ v, ...e, i }))
    .sort((a, b) => b.lines - a.lines || a.i - b.i);
}
const mapRangeText = (from, to) => (from === to ? `line ${from}` : `lines ${from}–${to}`);
// A section: a header with the property names and the scope, then "- value: places" (values of merged properties
// joined with " / ", in the header's order).
function valuesSection(props, valueLists, from, to) {
  const out = [`${props.join(', ')} (${mapRangeText(from, to)}):`];
  const first = valueLists[0];
  first.slice(0, STYLE_MAP_MAX_VALUES).forEach((x, k) => out.push(`- ${valueLists.map((l) => l[k].v).join(' / ')}: ${placesText(x.places)}`));
  if (first.length > STYLE_MAP_MAX_VALUES) out.push(`- … and ${first.length - STYLE_MAP_MAX_VALUES} more values`);
  return out;
}
const propertySection = (prop, lines, from, to, named, normal, sheet) => valuesSection([prop], [propertyValues(prop, lines, from, to, named, normal, sheet)], from, to);
// property "all": the properties with one value over the scope on one line, then one section per group of properties
// whose values fall on exactly the same lines and characters (a heading's style, size, bold and spacing usually do).
function allSections(lines, from, to, named, normal, sheet) {
  const per = STYLE_MAP_PROPS.map((p) => ({ p, values: propertyValues(p, lines, from, to, named, normal, sheet) }));
  const out = [];
  const uniform = per.filter((x) => x.values.length === 1);
  if (uniform.length) out.push([`Same throughout (${mapRangeText(from, to)}): ${uniform.map((x) => `${x.p} ${x.values[0].v}`).join('; ')}`]);
  const groups = new Map();
  for (const x of per.filter((y) => y.values.length > 1)) {
    const key = JSON.stringify(x.values.map((v) => v.places));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  for (const g of groups.values()) out.push(valuesSection(g.map((x) => x.p), g.map((x) => x.values), from, to));
  return out;
}

// The tool's text for a Docs API model. args: { property, scope }; limit: the per-call character limit; named: the
// document's namedStyleValues (or null); sheet: the turn's formatting sheet (styleSheetFor, or null). Errors start with "Error:".
function styleMap(model, args, limit, named = null, sheet = null) {
  const asked = args ? args.property : null;
  const prop = String(asked == null ? '' : asked).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (prop !== 'all' && !STYLE_MAP_PROPS.includes(prop)) return `Error: property must be one of ${STYLE_MAP_PROPS.join(', ')} or all.`;
  const raw = args ? args.scope : null;
  const scope = raw == null || (typeof raw === 'string' && raw.trim().toLowerCase() === 'null') ? { kind: 'all' } : readScope(raw);
  if (scope.error || scope.kind === 'outline') return 'Error: scope must be {"start":N,"end":M}, "all" or null.';
  const total = model.lines.length;
  let from = 1;
  let to = total;
  if (scope.kind === 'lines') {
    from = Math.max(1, Math.floor(Number(scope.start)) || 1);
    to = Math.floor(Number(scope.end));
    if (!Number.isFinite(to) || to < from) to = from;
    if (from > total) return `Error: the document has only ${total} lines.`;
    to = Math.min(to, total);
  }
  const normal = { ...(unmarkedDefault({ docId: model.docId, tabId: model.tabId, textDefault: null }) || {}), ...((named && named.NORMAL_TEXT) || {}) };
  const sections = prop === 'all' ? allSections(model.lines, from, to, named, normal, sheet) : [propertySection(prop, model.lines, from, to, named, normal, sheet)];
  if ((prop === 'all' || prop === 'indent') && propertyValues('indent', model.lines, from, to, named, normal, sheet).some((x) => inheritedIndentValue(x.v))) {
    sections.push([INDENT_INHERIT_NOTE]);
  }
  const out = [];
  let chars = 0;
  for (const [k, sec] of sections.entries()) {
    if (k > 0) sec.unshift('');
    for (const l of sec) {
      if (out.length && chars + l.length + 1 > limit) {
        out.push(`[Cut at the limit per call. Narrow the scope ({"start":N,"end":M})${prop === 'all' ? ' or ask for one property' : ''}.]`);
        return out.join('\n');
      }
      out.push(l);
      chars += l.length + 1;
    }
  }
  return out.join('\n');
}

// The tool: the turn's frozen model, the named styles read now (a failed read leaves the defaults unnamed) and the
// turn's formatting sheet (the built-in default when DOC.md and MAIN.md have no Formatting: line).
async function runStyleMap(name, args, snap) {
  if (snap.docText == null) return `Error: the document text is unavailable (${snap.docError || 'export failed'}).`;
  const model = snap.docFormat === 'docs-api' ? snap.model : null;
  if (!model || !Array.isArray(model.lines)) return STYLE_MAP_NO_API;
  let named = null;
  if (model.docId) {
    try { named = namedStyleValues(await fetchNamedStylesRaw(model.docId, model.tabId)); } catch (e) { named = null; }
  }
  return styleMap(model, args || {}, readLimits(snap.prov).chars, named, styleSheetFor(snap));
}

// On demand on Munin and custom servers (request.js onDemandOffer): when the message is about formatting, or MAIN.md or
// DOC.md has a Formatting: line (the sheet the document is checked against). document_styles uses the same test.
const STYLE_WORDS_RE = /\b(?:styles?|styling|fonts?|typefaces?|format\w*|headings?|bold|italics?|underlin\w*|spacing|indent\w*|align\w*|justif\w*|colou?rs?|size)\b|стил|шрифт|формат|заголов|жирн|курсив|подчерк|интервал|отступ|выравн|кегл|размер|цвет/i;
const styleAsked = (t) => STYLE_WORDS_RE.test(t);
const sheetRecorded = (snap) => hasFormattingLine(snap.docInstructions) || hasFormattingLine(snap.mainInstructions);
const styleMapRuns = (mode, snap) => !!snap && snap.docFormat === 'docs-api' && !!snap.model;
registerTools(STYLE_MAP_TOOL, {
  // Wherever read_document is when the main document was read through the Docs API (every mode, read-only agents
  // too); a turn on the export does not pay for a tool that could not answer (the run still says why).
  offer: (mode, snap) => styleMapRuns(mode, snap) && onDemandOffer(snap, styleAsked, sheetRecorded(snap)),
  runs: styleMapRuns,
  reading: true,
  summary: (name, args) => String((args && args.property) || ''),
  run: runStyleMap,
});
