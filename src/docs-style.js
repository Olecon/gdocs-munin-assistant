'use strict';
// Module docs-style.js: formatting vocabularies and pure helpers shared by the line model (docs-model.js)
// and the formatting tools: names <-> Docs API values (headings, alignment, lists, colors, fonts), loose
// value parsers for tool arguments, and the read_formatting notation pieces (line tags, span attributes).
// Constants and pure functions only; loaded right after constants.js.
/* exported HEADING_STYLES, headingName, ALIGN_API, alignToApi, alignName, LIST_PRESETS, NUMBER_GLYPH_TYPES,
   listKind, COLOR_NAMES, LINK_COLOR, KNOWN_FONTS, knownFont, parseColor, hexFromRgbColor, hexFromOptionalColor,
   apiColor, dimensionPt, ptDimension, parsePt, parseSize, lineSpacingPercent, lineSpacingMultiplier,
   parseLineSpacing, parseHeading, parseAlign, parseListKind, TEXT_STYLE_API_FIELDS, numText, lineTag, spanAttrs,
   unmarkedNote */

// ---- Vocabularies ------------------------------------------------------------------------------
// Paragraph style names of format_lines -> namedStyleType.
const HEADING_STYLES = {
  title: 'TITLE', subtitle: 'SUBTITLE', h1: 'HEADING_1', h2: 'HEADING_2', h3: 'HEADING_3',
  h4: 'HEADING_4', h5: 'HEADING_5', h6: 'HEADING_6', normal: 'NORMAL_TEXT',
};
// namedStyleType -> its tag name ("h2", "title"), '' for normal text and unknown styles.
const headingName = (style) => {
  const k = Object.keys(HEADING_STYLES).find((n) => HEADING_STYLES[n] === style);
  return k && k !== 'normal' ? k : '';
};
// Alignment names -> Docs API values for a left-to-right paragraph (START/END follow the direction).
const ALIGN_API = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };
const RTL = 'RIGHT_TO_LEFT';
// Alignment name -> API value for a paragraph of the given direction (left/right swap in RTL text).
const alignToApi = (name, direction) => {
  const rtl = direction === RTL;
  if (rtl && name === 'left') return 'END';
  if (rtl && name === 'right') return 'START';
  return ALIGN_API[name] || null;
};
// API alignment (+ paragraph direction) -> the visual name, or null when unknown/absent.
const alignName = (alignment, direction) => {
  const rtl = direction === RTL;
  if (alignment === 'START') return rtl ? 'right' : 'left';
  if (alignment === 'END') return rtl ? 'left' : 'right';
  if (alignment === 'CENTER') return 'center';
  if (alignment === 'JUSTIFIED') return 'justify';
  return null;
};
// List kinds -> createParagraphBullets presets ("none" is deleteParagraphBullets).
const LIST_PRESETS = { bullet: 'BULLET_DISC_CIRCLE_SQUARE', number: 'NUMBERED_DECIMAL_ALPHA_ROMAN', checklist: 'BULLET_CHECKBOX' };
// glyphType values of numbered nesting levels.
const NUMBER_GLYPH_TYPES = ['DECIMAL', 'ZERO_DECIMAL', 'ALPHA', 'UPPER_ALPHA', 'ROMAN', 'UPPER_ROMAN'];
// Kind of a list nesting level (lists[id].listProperties.nestingLevels[level]): a numeric glyphType is a
// numbered list, a glyphSymbol a bulleted one, anything else a checklist; an unknown level counts as bullet.
const listKind = (level) => {
  if (!level || typeof level !== 'object') return 'bullet';
  if (NUMBER_GLYPH_TYPES.includes(level.glyphType)) return 'number';
  if (level.glyphSymbol) return 'bullet';
  return 'checklist';
};
// Color names accepted by the tools (lower case) -> #RRGGBB.
const COLOR_NAMES = {
  black: '#000000', white: '#FFFFFF', gray: '#808080', grey: '#808080', red: '#FF0000', orange: '#FF9900',
  yellow: '#FFFF00', green: '#00B050', blue: '#0000FF', purple: '#9900FF', 'dark red': '#C00000', 'light yellow': '#FFF2CC',
};
// The color Google Docs gives a link it styles itself; not shown in spans on links (noise).
const LINK_COLOR = '#1155CC';
// Common Google Docs fonts; a font name matching one of these (case-insensitively) takes its spelling.
const KNOWN_FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Helvetica', 'Impact',
  'Lato', 'Lora', 'Merriweather', 'Montserrat', 'Open Sans', 'Oswald', 'Playfair Display', 'Raleway', 'Roboto',
  'Roboto Mono', 'Source Code Pro', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Garamond', 'EB Garamond',
  'Noto Sans', 'Noto Serif', 'PT Sans', 'PT Serif', 'Inter', 'Consolas', 'Courier Prime'];
// Trimmed font name in its known spelling: { name, known } (known: false for fonts not in KNOWN_FONTS),
// or null for an empty name.
const knownFont = (name) => {
  const t = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const k = KNOWN_FONTS.find((f) => f.toLowerCase() === t.toLowerCase());
  return { name: k || t, known: !!k };
};

// ---- Colors ------------------------------------------------------------------------------------
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
// A color argument -> { hex: '#RRGGBB', r, g, b } (0-255), { none: true } for "none"/"default"/"transparent",
// or null when it is not a color. Accepts #RGB, #RRGGBB (with or without #), rgb(r, g, b) and COLOR_NAMES.
function parseColor(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (['none', 'default', 'transparent', 'reset', 'auto'].includes(s)) return { none: true };
  let hex = COLOR_NAMES[s] || COLOR_NAMES[s.replace(/-/g, ' ')] || null;
  let m;
  if (!hex && (m = /^#?([0-9a-f]{3})$/.exec(s))) hex = '#' + m[1].split('').map((c) => c + c).join('');
  if (!hex && (m = /^#?([0-9a-f]{6})$/.exec(s))) hex = '#' + m[1];
  if (!hex && (m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s))) {
    if ([m[1], m[2], m[3]].some((x) => Number(x) > 255)) return null;
    hex = '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]);
  }
  if (!hex) return null;
  hex = hex.toUpperCase();
  return { hex, r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}
// API rgbColor ({red, green, blue} in 0..1, a missing component is 0) -> '#RRGGBB'.
const hexFromRgbColor = (rgb = {}) => '#' + ['red', 'green', 'blue'].map((k) => hex2((Number(rgb[k]) || 0) * 255)).join('');
// API OptionalColor ({color: {rgbColor}}) -> '#RRGGBB', or null when absent or transparent (no color).
const hexFromOptionalColor = (oc) => (oc && oc.color && oc.color.rgbColor ? hexFromRgbColor(oc.color.rgbColor) : null);
// '#RRGGBB' -> the API OptionalColor {color: {rgbColor: {red, green, blue}}} (zero components left out, as the API does).
const apiColor = (hex) => {
  const c = parseColor(hex);
  const rgbColor = {};
  if (c && !c.none) [['red', c.r], ['green', c.g], ['blue', c.b]].forEach(([k, n]) => { if (n) rgbColor[k] = n / 255; });
  return { color: { rgbColor } };
};

// ---- Sizes, dimensions, spacing ----------------------------------------------------------------
// API Dimension -> points (a Dimension with a unit but no magnitude is 0), or null when absent.
const dimensionPt = (d) => (d && typeof d === 'object' ? (typeof d.magnitude === 'number' ? d.magnitude : 0) : null);
// Points -> API Dimension.
const ptDimension = (n) => ({ magnitude: n, unit: 'PT' });
// A number of points: 14, "14", "14pt", "14 pt" -> 14; anything else -> null.
const parsePt = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:pt|points?)?\s*$/i.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
};
// A font size argument -> points rounded to 0.5, or null when not a number (range checks: the caller).
const parseSize = (v) => { const n = parsePt(v); return n == null ? null : Math.round(n * 2) / 2; };
// Line spacing: multiplier (1.15) <-> API percent (115).
const lineSpacingPercent = (mult) => Math.round(mult * 100);
const lineSpacingMultiplier = (pct) => Math.round(pct) / 100;
// A line_spacing argument -> { value: multiplier, percent: true when it was given as a percent (>= 50) }, or null.
const parseLineSpacing = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(%)?\s*$/.exec(typeof v === 'number' ? String(v) : String(v == null ? '' : v));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] || n >= 50 ? { value: n / 100, percent: true } : { value: n, percent: false };
};

// ---- Loose names -------------------------------------------------------------------------------
const looseKey = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
// A style argument -> a HEADING_STYLES key or null. Accepts "Heading 1", "heading1", "H1", "#", "##",
// "Title", "Normal text", "paragraph", and the API names (HEADING_1, NORMAL_TEXT).
function parseHeading(v) {
  const s = looseKey(v);
  if (/^#{1,6}$/.test(s)) return 'h' + s.length;
  const m = /^(?:h|heading|header) ?([1-6])$/.exec(s);
  if (m) return 'h' + m[1];
  if (s === 'title' || s === 'subtitle') return s;
  if (['normal', 'normal text', 'paragraph', 'body', 'body text', 'text', 'plain'].includes(s)) return 'normal';
  return null;
}
// An align argument -> left / center / right / justify, or null. Also "centre", "justified", "start", "end".
function parseAlign(v) {
  const s = looseKey(v);
  const map = { left: 'left', start: 'left', center: 'center', centre: 'center', centered: 'center', middle: 'center',
    right: 'right', end: 'right', justify: 'justify', justified: 'justify', both: 'justify' };
  return map[s] || null;
}
// A list argument -> bullet / number / checklist / none, or null. Also "bulleted", "numbered", "ordered",
// "checkbox", "todo", "remove".
function parseListKind(v) {
  const s = looseKey(v);
  const map = { bullet: 'bullet', bullets: 'bullet', bulleted: 'bullet', unordered: 'bullet', disc: 'bullet',
    number: 'number', numbers: 'number', numbered: 'number', ordered: 'number', numeric: 'number',
    checklist: 'checklist', checkbox: 'checklist', checkboxes: 'checklist', todo: 'checklist', 'to do': 'checklist', check: 'checklist',
    none: 'none', remove: 'none', off: 'none', no: 'none', plain: 'none' };
  return map[s] || null;
}

// format_text property -> the updateTextStyle field it writes.
const TEXT_STYLE_API_FIELDS = { bold: 'bold', italic: 'italic', underline: 'underline', font: 'weightedFontFamily',
  size: 'fontSize', color: 'foregroundColor', highlight: 'backgroundColor', link: 'link' };

// ---- Notation ----------------------------------------------------------------------------------
// A number as shown in tags and spans: at most two decimals, no trailing zeros.
const numText = (n) => String(Math.round(n * 100) / 100);
// The line tag of read_formatting (without brackets), '' for a plain left-aligned paragraph. line: a line
// of the model ({style, list, para}). Order: style, list (L2.. for nesting), alignment, indent start/first
// (not on list lines), space above/below ("-" = inherited), line spacing.
function lineTag(line) {
  const out = [];
  const h = headingName(line.style);
  if (h) out.push(h);
  if (line.list) out.push(line.list.kind + (line.list.level > 0 ? ` L${line.list.level + 1}` : ''));
  const p = line.para || {};
  if (p.align && p.align !== 'left') out.push(p.align);
  const show = (v) => (v == null ? '-' : numText(v));
  if (!line.list && (p.indentStart || p.indentFirstLine)) out.push(`indent ${show(p.indentStart)}/${show(p.indentFirstLine)}`);
  if (p.spaceAbove || p.spaceBelow) out.push(`space ${show(p.spaceAbove)}/${show(p.spaceBelow)}`);
  if (p.lineSpacing != null) out.push(`line ${numText(lineSpacingMultiplier(p.lineSpacing))}`);
  return out.join(' ');
}
// The attributes of a {text}(…) span: the run's font, size, color and background that differ from the
// document default def ({font, size, color}, missing = none); '' when nothing is to be shown.
function spanAttrs(run, def) {
  const d = def || {};
  const out = [];
  if (run.font && run.font !== d.font) out.push(`font=${run.font}`);
  if (run.size != null && run.size !== d.size) out.push(`size=${numText(run.size)}`);
  if (run.color && run.color !== d.color && !(run.link && run.color === LINK_COLOR)) out.push(`color=${run.color}`);
  if (run.bg) out.push(`bg=${run.bg}`);
  return out.join(' ');
}
// " Unmarked text: Arial 11." for the read_formatting header, '' without a default.
function unmarkedNote(def) {
  if (!def) return '';
  const parts = [];
  if (def.font) parts.push(def.font);
  if (def.size != null) parts.push(def.font ? numText(def.size) : `size ${numText(def.size)}`);
  if (def.color) parts.push(def.color);
  return parts.length ? ` Unmarked text: ${parts.join(' ')}.` : '';
}
