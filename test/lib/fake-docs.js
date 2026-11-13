'use strict';
// The fake Google Docs API server (fakeDocsServer), the standard test document (docSpec, ORIGINAL,
// ORIGINAL_STYLES) and docsBench: the helpers of the write checks (fresh document, one tool call, ...).

// Tiny in-memory Google Docs API: tabs with paragraphs ({p, style, suggest}) and tables
// ({table: [[cellParas, ...], ...]}). documents.get renders JSON with consistent UTF-16 indices (body
// starts at 1 after the section break; a table, each row and each cell take one index, and the table one more at its end
// as in Docs; paragraphs end with "\n"). An inline object is written "￼" in the spec and kept internally as OBJ (a private-use
// character, which the API never inserts); it is rendered as an inlineObjectElement, while a literal
// "￼" that reaches insertText stays a literal character (as in the real API). batchUpdate applies
// deleteContentRange / insertText / updateParagraphStyle / updateTextStyle / createParagraphBullets /
// deleteParagraphBullets to runs of consecutive paragraphs (a body run or a cell) with the API's
// restrictions (no range across runs, the final newline of a run stays), strips the characters the API
// strips from inserted text, carries paragraph properties (named style, paragraph style, bullet) on the
// newlines (an inserted newline copies those of the paragraph it splits) and checks writeControl (its
// error message deliberately does not say "revision"). failNext: { status, message } or { network, apply }.
// failReads: the number of documents.get calls that fail next with a network error (a lost connection).
// A field name that the API does not know in a `fields` mask fails the batch with HTTP 400 "Invalid field mask".
// documents.get without includeTabsContent honors a flat `fields` mask of top-level names (fields=revisionId: the
// live document line's poll gets that field alone); an unknown name is HTTP 400.
// Inline formatting: each paragraph keeps one text style per UTF-16 unit of its text (chars[i]: {bold,
// italic, underline, link, font, weight, size, color, bg, script} with only the set keys, or undefined for plain;
// missing entries are plain); a spec item gives it as fmt: [[s, e, {bold: true, link: 'https://...',
// size: 14, font: 'Arial', color: '#FF0000', script: 'super'}], ...] (offsets in p; colors as #RRGGBB; link: a URL or a raw
// link object such as {headingId}; weight only when not 400; script 'super' | 'sub' is baselineOffset SUPERSCRIPT /
// SUBSCRIPT, and a write of NONE or a reset removes it). The paragraph newline is always plain:
// updateTextStyle skips it, so its indices stay those of the text. documents.get emits one textRun per
// stretch of equal style in API shapes (an unformatted paragraph: one run with textStyle {}, as before; a
// styled inline object gets inlineObjectElement.textStyle); inserted text takes its neighbour's style as in Docs
// (inheritedAt; spec.inheritStyle: false keeps it plain); updateTextStyle sets
// the listed fields (a field listed but absent from textStyle is reset). Writing weightedFontFamily (set or
// reset) drops bold, as the real API does; a bold listed in the same request is applied after it. Setting a link also underlines
// the text and colors it LINK_HEX, as Docs does (srv.linkAutoStyle, default true; spec.linkAutoStyle: false).
// As real Docs (real-docs.js facts 2, 7b): a bold write also stores the font the text shows, weight 400 (srv.boldFont;
// spec.boldFont: false turns it off), and a size or color equal to the paragraph's named style's is not stored
// (srv.dropInherited; spec.dropInherited: false).
// Paragraph style: p.style (namedStyleType) and p.pstyle (alignment, lineSpacing, direction, and
// Dimensions for indentStart / indentFirstLine / spaceAbove / spaceBelow; a spec item's pstyle may give
// dimensions as numbers of points); updateParagraphStyle sets or resets the listed fields.
// Lists: p.bullet = {listId, level} and per tab lists {id: {preset, nestingLevels}} (spec: an item's
// bullet: {listId, level, preset}; a tab's lists: {id: preset or {nestingLevels}}). createParagraphBullets
// gives each plain paragraph a level from its depth (leading tabs, removed, plus its first-line indent in 36 pt steps)
// counted from the shallowest of the range, leaves paragraphs with a bullet as they are (the plain ones join their
// list), joins the list of the paragraph right before the range when it has the same preset, and sets the indents;
// deleteParagraphBullets removes the bullet and leaves level × 36 pt on both indents, stored only where that differs from
// the named style's (real Docs: nothing at level 0). Rendered as
// paragraph.bullet {listId, nestingLevel (left out at 0, as the API does)} and documentTab.lists.
// spec.stickyListIndent: true models what a real Chrome showed: an indent a deleted bullet left survives a reset of the
// field (updateParagraphStyle with the field in the mask and no value); only an explicit value replaces it.
// Tables: { table: rows, widths?: [{ type, pt }], spans?: [[r, c, rowSpan, colSpan]], pinned?: n, cellStyles?: [[r, c,
// tableCellStyle]] } render with columns, tableStyle.tableColumnProperties (EVENLY_DISTRIBUTED per column unless
// widths) and tableCellStyle (spans, plus a cell's own style fields such as backgroundColor and borderTop, API shapes;
// a cell without them renders as before); the first `pinned` rows render tableRowStyle { tableHeader: true } (the
// read-back of pinTableHeaderRows is assumed; other rows render no tableRowStyle). srv.tableStyles(tabId) lists them;
// insertTable (location or endOfSegmentLocation, body or header/footer; refused in a footnote or a cell) splits
// the paragraph at the index: the table starts at index + 1 and an empty paragraph follows it (Docs' layout).
// Sections: a spec item { section: sectionStyle (API shapes, with sectionType) } is a section break between paragraphs
// (one index; the runs around it are separate, so no range crosses it); a tab's sectionStyle is the first section's
// (the break at index 0). insertSectionBreak (body paragraphs only: 400 in a table, footnote, header or footer) puts a
// newline at its index and the break right after it; deleteContentRange takes a break only with the newline before it;
// updateSectionStyle sets its mask's fields (a field without a value is a 400, as the API cannot unset them) on every
// section its range overlaps. srv.sections(tabId) lists them.
// A table of contents: { toc: [items] } renders as tableOfContents (one index for the element, then its
// paragraphs; not editable; the real index layout is unverified).
// Segments (per tab): spec headers / footers / footnotes: { id: items } and documentStyle ({ defaultHeaderId, … };
// the first header / footer is the default one when not given). A footnote mark is written "[^id]" in a body
// paragraph (one index, rendered as footnoteReference { footnoteId, footnoteNumber } numbered in reading order;
// a footnote whose mark is deleted is no longer rendered). Segment content starts at index 0. Every request
// takes segmentId in its range / location; createFootnote (body only; content " \n"), createHeader /
// createFooter (DEFAULT; 400 when one exists), deleteHeader / deleteFooter; replies carry the new IDs.
// A spec paragraph's suggest: true (the id 'suggest.1') or a suggestion id string marks its text as a suggested insertion.
// Suggest mode (writeControl.writeMode SUGGEST): each text request makes one suggestion, id "sugg.N", kept per character
// (chars[i]._ins / _del, the paragraph newline's in p.nl) and rendered as textRun suggestedInsertionIds /
// suggestedDeletionIds: insertText inserts marked text, deleteContentRange keeps the text and marks it for deletion
// (indices do not move), a chip insert is marked too. A text request that touches a suggestion this server made (the
// same author) is merged into it, as Google does: a replace is one suggestion. Style requests apply directly (a
// simplification: the real API makes suggested style changes) but their reply entry names an id "sugg.style.N" all the
// same. The requests Google refuses in suggest mode (SUGGEST_REFUSED) fail with a 400. The response carries
// suggestionResponses (createdSuggestionIds, or updatedSummarySuggestionIds for a merged request). Not modelled: deleting
// one's own suggested insertion removes it (Google), text inserted after a suggested deletion is marked deleted too. spec.suggestNoRevision: a writeControl with both
// writeMode and requiredRevisionId is a 400 naming writeControl (the unverified combination); spec.suggestIgnored: writeMode
// is ignored (direct edits); spec.suggestNoIds: no suggestionResponses. deleteSuggestion { suggestionId } drops one: a
// suggested insertion goes, a suggested deletion stays as plain text; srv.settleSuggestion(id, accept) does what accept /
// reject do. srv.suggested(tabId): [{ id, kind: 'ins' | 'del', text }] in text order (body runs and cells).
// Plugins (one file per feature under test/lib/): registerFakeRequest(name, handler(body, api) -> reply),
// registerFakeResponse(fn(srv, body) -> fields of a successful batchUpdate response),
// registerFakeRender(fn(srv, doc, includeTabs)) to add to a documents.get response, registerFakeGet(fn(srv, url,
// params, api) -> response | null) to answer a GET first, registerFakeInit(fn(srv, spec)); srv.onShift
// listeners (tabId, segmentId, index, delta) hear every text insertion and deletion. api: see fakeApi below.
// Named styles (per tab): Docs' defaults (Normal text Arial 11 black, the headings' sizes and spacing, Heading 3 #434343,
// Heading 4-6 and Subtitle #666666) with spec.namedStyles over them ({ NORMAL_TEXT: { font, size, bold, italic, color
// ('#RRGGBB'; null: none, the style shows Normal text's), alignment, spaceAbove, spaceBelow } }, friendly values, per
// document). documents.get adds documentTab.namedStyles only when its
// fields mask names namedStyles (the panel's own reads leave them out). updateNamedStyle sets or resets each field of
// its mask ("namedStyleType", leaves "textStyle.fontSize", a parent "textStyle" that replaces the whole part unless the mask
// names one of its leaves too (then only the leaves apply, as the real API), "*");
// an unknown namedStyleType or field is a 400; spec.noNamedStyleUpdate: true answers 400 "Unknown name" like an API
// without the request. srv.named(tabId): the friendly values per style.
// Chips and described images: a spec item's objects: [[at, element]] puts an element on its "￼" at offset at (after
// footnote marks): { person: { personProperties: { name, email } } }, { richLink: { richLinkProperties } },
// { dateElement: { dateElementProperties } }, { dropdown: { dropdownProperties } }, or { image: { id, title,
// description, width, height (pt) } } (an inlineObjectElement whose documentTab.inlineObjects entry carries the
// embeddedObject title, description and size). insertPerson / insertRichLink / insertDate put one such element at
// their location (inside a paragraph; 400 without email, uri or timestamp); the date's displayText is "Nov 12, 2026"
// in its time zone, a rich link's title "Linked file". srv.objects(tabId): the elements per paragraph ([[at, kind]]).
const OBJ = '';
// The style requests that make a suggested style change in suggest mode (real-docs.js facts 8t, 8m: the reply names an id).
const STYLE_SUGGESTIONS = ['updateTextStyle', 'updateParagraphStyle', 'createParagraphBullets', 'deleteParagraphBullets'];
// The requests Google refuses in suggest mode (the suggestions how-to).
const SUGGEST_REFUSED = ['addDocumentTab', 'createNamedRange', 'deleteFooter', 'deleteHeader', 'deleteNamedRange', 'deleteTab',
  'updateDocumentTabProperties', 'updateTableColumnProperties'];
const LINK_HEX = '#1155CC';
// How the fake renders a checklist nesting level (no glyphSymbol, no numeric glyphType). What real Docs
// returns for BULLET_CHECKBOX is still to be confirmed in Chrome; change it here only.
const CHECKBOX_GLYPH = { glyphType: 'GLYPH_TYPE_UNSPECIFIED' };
const PRESET_GLYPHS = {
  BULLET_DISC_CIRCLE_SQUARE: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }, { glyphSymbol: '■' }],
  NUMBERED_DECIMAL_ALPHA_ROMAN: [{ glyphType: 'DECIMAL', glyphFormat: '%0.' }, { glyphType: 'ALPHA', glyphFormat: '%1.' }, { glyphType: 'ROMAN', glyphFormat: '%2.' }],
  BULLET_CHECKBOX: [CHECKBOX_GLYPH],
  // Each level carries the numbers of the levels above it: "1.", "1.1.", "1.1.1." (the API reference's example).
  NUMBERED_DECIMAL_NESTED: Array.from({ length: 9 }, (_, l) => ({ glyphType: 'DECIMAL', glyphFormat: Array.from({ length: l + 1 }, (__, k) => `%${k}.`).join('') })),
};
const presetGlyphs = (preset) => PRESET_GLYPHS[preset] || (/^NUMBERED_/.test(preset) ? PRESET_GLYPHS.NUMBERED_DECIMAL_ALPHA_ROMAN
  : /CHECKBOX/.test(preset) ? PRESET_GLYPHS.BULLET_CHECKBOX : /^BULLET_/.test(preset) ? PRESET_GLYPHS.BULLET_DISC_CIRCLE_SQUARE : null);
const dim = (n) => ({ magnitude: n, unit: 'PT' });
// Nine nesting levels like Docs: 36 pt per level, a hanging first line 18 pt left of the text.
const nestingLevels = (preset) => Array.from({ length: 9 }, (_, l) => ({ ...presetGlyphs(preset)[l % presetGlyphs(preset).length],
  indentFirstLine: dim(18 + 36 * l), indentStart: dim(36 + 36 * l) }));
const TEXT_FIELDS = ['bold', 'italic', 'underline', 'link', 'weightedFontFamily', 'fontSize', 'foregroundColor', 'backgroundColor',
  'baselineOffset', 'strikethrough', 'smallCaps']; // the last two are valid but not modelled
const SCRIPT_API = { super: 'SUPERSCRIPT', sub: 'SUBSCRIPT' };
const PARA_FIELDS = ['namedStyleType', 'alignment', 'lineSpacing', 'direction', 'spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine',
  'indentEnd', 'spacingMode', 'keepLinesTogether', 'keepWithNext', 'avoidWidowAndOrphan', 'pageBreakBefore',
  'shading', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderBetween'];
const BORDER_FIELDS = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderBetween'];
// The DocumentStyle fields updateDocumentStyle may name (the header and footer ids and useCustomHeaderFooterMargins are
// read-only and fail like an unknown name).
const DOC_STYLE_FIELDS = ['background', 'useFirstPageHeaderFooter', 'useEvenPageHeaderFooter', 'pageNumberStart', 'marginTop', 'marginBottom',
  'marginRight', 'marginLeft', 'pageSize', 'marginHeader', 'marginFooter', 'flipPageOrientation', 'documentFormat'];
const UNSETTABLE_PAGE = ['marginTop', 'marginBottom', 'marginRight', 'marginLeft', 'marginHeader', 'marginFooter', 'pageSize', 'background'];
// The SectionStyle fields updateSectionStyle may name (sectionType and the header / footer ids are read-only).
const SECTION_FIELDS = ['columnProperties', 'columnSeparatorStyle', 'contentDirection', 'marginTop', 'marginBottom', 'marginRight', 'marginLeft',
  'marginHeader', 'marginFooter', 'useFirstPageHeaderFooter', 'pageNumberStart', 'flipPageOrientation'];
const DIM_FIELDS = ['spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine', 'indentEnd'];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const hexOf = (rgb = {}) => '#' + ['red', 'green', 'blue'].map((k) => Math.round((rgb[k] || 0) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const apiColorOf = (hex) => {
  const rgbColor = {};
  ['red', 'green', 'blue'].forEach((k, i) => { const n = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16); if (n) rgbColor[k] = n / 255; });
  return { color: { rgbColor } };
};
// A friendly char style -> the API textStyle.
const apiStyle = (st = {}) => {
  const textStyle = {};
  // An explicit false (a spec's fmt only: a write of false resets the field) is rendered as Docs does, bold: false.
  for (const k of ['bold', 'italic', 'underline']) if (st[k]) textStyle[k] = true; else if (st[k] === false) textStyle[k] = false;
  if (st.link) textStyle.link = typeof st.link === 'string' ? { url: st.link } : clone(st.link);
  if (st.font) textStyle.weightedFontFamily = { fontFamily: st.font, weight: st.weight || 400 };
  if (st.size != null) textStyle.fontSize = dim(st.size);
  if (st.color) textStyle.foregroundColor = apiColorOf(st.color);
  if (st.bg) textStyle.backgroundColor = apiColorOf(st.bg);
  if (SCRIPT_API[st.script]) textStyle.baselineOffset = SCRIPT_API[st.script];
  return textStyle;
};
// Applies one updateTextStyle field to a friendly char style (in place).
function setTextField(st, k, textStyle, linkAutoStyle) {
  const v = textStyle[k];
  const has = k in textStyle;
  if (['bold', 'italic', 'underline'].includes(k)) { if (has && v) st[k] = true; else delete st[k]; return; }
  if (k === 'link') {
    if (has && v && Object.keys(v).length) {
      st.link = Object.keys(v).length === 1 && v.url ? v.url : clone(v);
      if (linkAutoStyle) { st.underline = true; st.color = LINK_HEX; }
    } else delete st.link;
    return;
  }
  if (k === 'weightedFontFamily') {
    if (has && v && v.fontFamily) { st.font = v.fontFamily; if (v.weight && v.weight !== 400) st.weight = v.weight; else delete st.weight; } else { delete st.font; delete st.weight; }
    delete st.bold; // the weight replaces the rendered weight: Docs drops bold (real API, Chrome /test)
    return;
  }
  if (k === 'fontSize') { if (has && v && typeof v.magnitude === 'number') st.size = v.magnitude; else delete st.size; return; }
  if (k === 'baselineOffset') {
    const s = Object.keys(SCRIPT_API).find((x) => SCRIPT_API[x] === v);
    if (has && s) st.script = s; else delete st.script;
    return;
  }
  const key = k === 'foregroundColor' ? 'color' : k === 'backgroundColor' ? 'bg' : null;
  if (key) { if (has && v && v.color && v.color.rgbColor) st[key] = hexOf(v.color.rgbColor); else delete st[key]; }
}
// What an updateParagraphStyle with namedStyleType in its mask does to the text styles of the paragraphs in its range (the
// real API: development/tools/real-docs.js facts 7b, 7d). When it changes no paragraph's named style, every paragraph in the
// range loses its text styles (a range of one character too); when it changes some, each of those loses the fields whose
// value covers its whole text, and the others keep everything. A link and baselineOffset always stay, and so do the
// underline and color of linked text.
const NAMED_CLEARS = [['bold'], ['italic'], ['underline'], ['font', 'weight'], ['size'], ['color'], ['bg']];
const KEPT_ON_LINKS = ['underline', 'color'];
function namedStyleClears(paras, style) {
  const changed = paras.filter((p) => (p.style || 'NORMAL_TEXT') !== style);
  for (const p of changed.length ? changed : paras) {
    const chars = Array.from({ length: p.text.length }, (_, i) => (p.chars || [])[i] || undefined);
    for (const keys of NAMED_CLEARS) {
      const val = (st) => JSON.stringify(keys.map((k) => st[k]));
      const whole = chars.length > 0 && chars.every((st) => st && st[keys[0]] !== undefined && val(st) === val(chars[0]));
      if (changed.length && !whole) continue;
      chars.forEach((st, i) => {
        if (!st || (st.link && KEPT_ON_LINKS.includes(keys[0]))) return;
        const next = { ...st };
        for (const k of keys) delete next[k];
        chars[i] = Object.keys(next).length ? next : undefined;
      });
    }
    p.chars = chars;
  }
}
// Spec pstyle (dimensions as numbers allowed) -> the stored API shapes.
const normPstyle = (ps = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(ps)) out[k] = DIM_FIELDS.includes(k) && typeof v === 'number' ? dim(v) : clone(v);
  return out;
};
// The field names of a `fields` mask, or an "Invalid field mask" error for names the API does not know.
const maskFields = (fields, known, what) => {
  const keys = String(fields || '').split(',').map((k) => k.trim()).filter(Boolean);
  const bad = keys.filter((k) => !known.includes(k));
  if (!keys.length || bad.length) throw new Error(`Invalid field mask for ${what}: ${bad.length ? bad.join(', ') : '(empty)'}`);
  return keys;
};

// Top-level fields of a Document (documents.get) that a flat mask may name.
const GET_TOP_FIELDS = ['documentId', 'title', 'revisionId', 'suggestionsViewMode', 'body', 'tabs', 'documentStyle',
  'namedStyles', 'lists', 'headers', 'footers', 'footnotes', 'inlineObjects', 'positionedObjects', 'namedRanges',
  'suggestedDocumentStyleChanges', 'suggestedNamedStylesChanges'];

// Feature plugins of the fake (registerFakeRequest, …); shared by every server of the test process.
const PLUGINS = { requests: {}, renders: [], gets: [], inits: [], responses: [] };
const registerFakeRequest = (name, handler) => { PLUGINS.requests[name] = handler; };
const registerFakeRender = (fn) => { PLUGINS.renders.push(fn); };
const registerFakeGet = (fn) => { PLUGINS.gets.push(fn); };
const registerFakeInit = (fn) => { PLUGINS.inits.push(fn); };
// fn(srv, body) -> fields added to a successful batchUpdate response (commentUpdateState), or null.
const registerFakeResponse = (fn) => { PLUGINS.responses.push(fn); };
const NAMED_TYPES = ['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];
// Docs' colours (a real documents.get): Normal text black, set explicitly ({rgbColor: {}}); Heading 3 #434343, Heading 4-6
// and Subtitle #666666; Title and Heading 1-2 none (they show Normal text's).
const GREY = { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } };
const DARK_GREY = { color: { rgbColor: { red: 0.2627451, green: 0.2627451, blue: 0.2627451 } } };
const DOCS_NAMED = () => {
  const h = (size, above, below, grey) => ({ textStyle: { fontSize: dim(size), ...(grey ? { foregroundColor: clone(grey) } : {}) },
    paragraphStyle: { spaceAbove: dim(above), spaceBelow: dim(below), keepWithNext: true } });
  return {
    NORMAL_TEXT: { textStyle: { weightedFontFamily: { fontFamily: 'Arial', weight: 400 }, fontSize: dim(11), foregroundColor: { color: { rgbColor: {} } } },
      paragraphStyle: { alignment: 'START', lineSpacing: 115 } },
    TITLE: h(26, 0, 3), SUBTITLE: h(15, 0, 16, GREY), HEADING_1: h(20, 20, 6), HEADING_2: h(16, 18, 6), HEADING_3: h(14, 16, 4, DARK_GREY),
    HEADING_4: h(12, 14, 4, GREY), HEADING_5: h(11, 12, 4, GREY), HEADING_6: { ...h(11, 12, 4, GREY), textStyle: { fontSize: dim(11), italic: true, foregroundColor: clone(GREY) } },
  };
};
// The text values a paragraph of named style type inherits: { font, size, color } (Normal text's where its own has none;
// color #000000 when neither sets one).
const namedText = (named, type) => {
  const own = ((named || {})[type || 'NORMAL_TEXT'] || {}).textStyle || {};
  const base = ((named || {}).NORMAL_TEXT || {}).textStyle || {};
  const pick = (k) => (own[k] !== undefined ? own[k] : base[k]);
  const wff = pick('weightedFontFamily');
  const fg = pick('foregroundColor');
  return { font: wff ? wff.fontFamily : 'Arial', size: pick('fontSize') ? pick('fontSize').magnitude : 11, color: fg && fg.color ? hexOf(fg.color.rgbColor) : '#000000' };
};
// Friendly named-style values -> the API parts merged over base.
const namedOver = (base, v = {}) => {
  const out = clone(base || { textStyle: {}, paragraphStyle: {} });
  if (v.font) out.textStyle.weightedFontFamily = { fontFamily: v.font, weight: 400 };
  if (v.size != null) out.textStyle.fontSize = dim(v.size);
  if (v.bold != null) out.textStyle.bold = v.bold;
  if (v.italic != null) out.textStyle.italic = v.italic;
  if (v.color) out.textStyle.foregroundColor = apiColorOf(v.color); else if (v.color === null) delete out.textStyle.foregroundColor;
  if (v.alignment) out.paragraphStyle.alignment = v.alignment;
  for (const k of ['spaceAbove', 'spaceBelow']) if (v[k] != null) out.paragraphStyle[k] = dim(v[k]);
  return out;
};
const FN_MARK_RE = /\[\^([^\]]+)\]/g; // a footnote mark in a spec paragraph
const SEGMENT_KEYS = { header: 'headers', footer: 'footers', footnote: 'footnotes' };

// The API element of a chip or described image (spec objects, the insert requests).
function objectElement(o) {
  if (o.image) return { inlineObjectElement: { inlineObjectId: o.image.id || 'kix.img', textStyle: {} } };
  const [kind] = Object.keys(o);
  return { [kind]: { ...clone(o[kind]), textStyle: {} } };
}
const imageObject = (im) => ({ objectId: im.id || 'kix.img', inlineObjectProperties: { embeddedObject: {
  ...(im.title != null ? { title: im.title } : {}), ...(im.description != null ? { description: im.description } : {}),
  ...(im.width ? { size: { width: { magnitude: im.width, unit: 'PT' }, height: { magnitude: im.height, unit: 'PT' } } } : {}),
  imageProperties: { contentUri: 'https://docs.google.com/docs-images-rt/short-lived' } } } }); // the real host (real-docs.js fact 6)
function fakeDocsServer(spec) {
  const srv = {
    documentId: spec.documentId, title: spec.title, revision: 1, token: 'tok-1', log: [], failNext: null, failReads: 0, listSeq: 0,
    linkAutoStyle: spec.linkAutoStyle !== false, stickyListIndent: !!spec.stickyListIndent, segSeq: 0, onShift: [],
    chipSeq: 0, people: { ...(spec.people || {}) },
  };
  const para = (c, lists) => {
    // "[^id]" footnote marks become one object character whose char style carries the footnote ID (fmt offsets
    // count the mark as one character).
    // marks: false (specFromBody) takes the text literally: its footnote marks come as fmt { _fn }.
    const marks = [];
    let src = '';
    let last = 0;
    for (const m of c.marks === false ? [] : c.p.matchAll(FN_MARK_RE)) { src += c.p.slice(last, m.index); marks.push([src.length, m[1]]); src += OBJ; last = m.index + m[0].length; }
    src += c.p.slice(last);
    const text = src.split('￼').join(OBJ);
    const chars = Array(text.length).fill(undefined);
    for (const [s, e, st] of c.fmt || []) for (let i = s; i < e; i++) chars[i] = { ...chars[i], ...st };
    for (const [at, id] of marks) chars[at] = { ...chars[at], _fn: id };
    for (const [at, el] of c.objects || []) {
      if (text[at] !== OBJ) throw new Error(`spec: no "￼" at ${at} of "${c.p}"`);
      chars[at] = { ...chars[at], _obj: clone(el) };
    }
    let bullet = null;
    if (c.bullet) {
      bullet = { listId: c.bullet.listId, level: c.bullet.level || 0 };
      if (!lists[bullet.listId]) { const preset = c.bullet.preset || 'BULLET_DISC_CIRCLE_SQUARE'; lists[bullet.listId] = { preset, nestingLevels: nestingLevels(preset) }; }
    }
    const out = { text, style: c.style || 'NORMAL_TEXT', suggest: c.suggest || false, chars, pstyle: normPstyle(c.pstyle), bullet };
    if (c.nl) out.nl = clone(c.nl); // the newline's suggestion ({ _ins | _del: id }; specFromBody)
    return out;
  };
  // A restored backup (JSON) holds null for plain characters: read as undefined.
  const pchars = (p) => Array.from({ length: p.text.length }, (_, i) => (p.chars || [])[i] || undefined);
  const styleKey = (st) => JSON.stringify(st || {});
  const emptyPara = () => ({ text: '', style: 'NORMAL_TEXT', suggest: false, chars: [], pstyle: {}, bullet: null });
  const tableBlock = (rows, extra = {}) => ({ type: 'table', rows, ...extra });
  const toBlocks = (items, lists) => {
    const blocks = [];
    for (const it of items) {
      if (it.table) {
        const rows = it.table.map((row) => row.map((cell) => ({ paras: cell.map((c) => para(c, lists)) })));
        for (const [r, c, rs, cs] of it.spans || []) rows[r][c].span = [rs, cs];
        for (const [r, c, st] of it.cellStyles || []) rows[r][c].style = clone(st);
        blocks.push(tableBlock(rows, { ...(it.widths ? { widths: clone(it.widths) } : {}), ...(it.pinned ? { pinned: it.pinned } : {}) }));
        continue;
      }
      if (it.toc) { blocks.push({ type: 'toc', paras: it.toc.map((c) => para(c, lists)) }); continue; }
      if (it.section) { blocks.push({ type: 'section', style: clone(it.section) }); continue; }
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'run') last.paras.push(para(it, lists)); else blocks.push({ type: 'run', paras: [para(it, lists)] });
    }
    return blocks;
  };
  const tabLists = (t) => {
    const lists = {};
    for (const [id, v] of Object.entries(t.lists || {})) {
      lists[id] = typeof v === 'string' ? { preset: v, nestingLevels: nestingLevels(v) } : { preset: v.preset || null, nestingLevels: clone(v.nestingLevels) };
    }
    return lists;
  };
  // Segments of a spec tab: { id: { blocks } } per kind, and the documentStyle that names the default ones.
  const tabSegments = (t, lists) => {
    const out = { headers: {}, footers: {}, footnotes: {}, docStyle: clone(t.documentStyle || {}) };
    for (const key of ['headers', 'footers', 'footnotes']) {
      for (const [id, items] of Object.entries(t[key] || {})) out[key][id] = { blocks: toBlocks(items, lists) };
    }
    const first = (key) => Object.keys(out[key])[0];
    if (first('headers') && !out.docStyle.defaultHeaderId) out.docStyle.defaultHeaderId = first('headers');
    if (first('footers') && !out.docStyle.defaultFooterId) out.docStyle.defaultFooterId = first('footers');
    return out;
  };
  const namedOf = () => { const d = DOCS_NAMED(); for (const [k, v] of Object.entries(spec.namedStyles || {})) d[k] = namedOver(d[k], v); return d; };
  srv.tabs = spec.tabs.map((t) => { const lists = tabLists(t); return { id: t.id, title: t.title, lists, blocks: toBlocks(t.items, lists), ...tabSegments(t, lists), named: namedOf(), firstSection: clone(t.sectionStyle || {}) }; });
  // A container holds blocks: a tab (its body: index 1 after the section break) or a segment (index 0).
  const isTab = (c) => srv.tabs.includes(c);
  // fns: footnote marks seen in reading order (the body's layout numbers them).
  const layout = (container, fns = []) => {
    const body = isTab(container);
    let idx = body ? 1 : 0;
    const content = body ? [{ endIndex: 1, sectionBreak: { sectionStyle: clone(container.firstSection || {}) } }] : [];
    const sections = []; // the section breaks after the first: { index, at (block index) }
    const runs = [];
    const renderRun = (paras, out, editable = true, cell = false) => {
      const start = idx;
      for (const p of paras) {
        const elements = [];
        let at = idx;
        const str = p.text + '\n';
        const chars = [...pchars(p), p.nl || undefined];
        for (let i = 0; i < str.length;) {
          if (str[i] === OBJ && chars[i] && chars[i]._fn) {
            fns.push(chars[i]._fn);
            elements.push({ startIndex: at, endIndex: at + 1, footnoteReference: { footnoteId: chars[i]._fn, footnoteNumber: String(fns.length), textStyle: {} } });
            at += 1; i++; continue;
          }
          if (str[i] === OBJ && chars[i] && chars[i]._obj) {
            const el = objectElement(chars[i]._obj);
            const inner = Object.values(el)[0];
            if (chars[i]._ins) inner.suggestedInsertionIds = [chars[i]._ins];
            if (chars[i]._del) inner.suggestedDeletionIds = [chars[i]._del];
            elements.push({ startIndex: at, endIndex: at + 1, ...el }); at += 1; i++; continue;
          }
          if (str[i] === OBJ) {
            const obj = { inlineObjectId: 'kix.obj' };
            if (chars[i]) obj.textStyle = apiStyle(chars[i]); // a styled object only (unformatted output unchanged)
            elements.push({ startIndex: at, endIndex: at + 1, inlineObjectElement: obj }); at += 1; i++; continue;
          }
          let j = i + 1;
          while (j < str.length && str[j] !== OBJ && styleKey(chars[j]) === styleKey(chars[i])) j++;
          const textStyle = apiStyle(chars[i]);
          const run = { startIndex: at, endIndex: at + j - i, textRun: { content: str.slice(i, j), textStyle } };
          if (p.suggest) run.textRun.suggestedInsertionIds = [typeof p.suggest === 'string' ? p.suggest : 'suggest.1'];
          if (chars[i] && chars[i]._ins) run.textRun.suggestedInsertionIds = [chars[i]._ins];
          if (chars[i] && chars[i]._del) run.textRun.suggestedDeletionIds = [chars[i]._del];
          elements.push(run); at += j - i; i = j;
        }
        const paragraph = { elements, paragraphStyle: { namedStyleType: p.style, ...clone(p.pstyle || {}) } };
        if (p.bullet) paragraph.bullet = p.bullet.level ? { listId: p.bullet.listId, nestingLevel: p.bullet.level } : { listId: p.bullet.listId };
        out.push({ startIndex: idx, endIndex: at, paragraph });
        idx = at;
      }
      if (editable) runs.push({ start, end: idx, paras, ...(cell ? { cell: true } : {}) });
    };
    // tables: [{ start, end, block }] for the plugins' structural requests.
    const tables = [];
    container.blocks.forEach((b, bi) => {
      if (b.type === 'run') { renderRun(b.paras, content); return; }
      if (b.type === 'section') {
        content.push({ startIndex: idx, endIndex: idx + 1, sectionBreak: { sectionStyle: clone(b.style) } });
        sections.push({ index: idx, at: bi });
        idx++;
        return;
      }
      if (b.type === 'toc') {
        const t = { startIndex: idx, tableOfContents: { content: [] } };
        idx++;
        renderRun(b.paras, t.tableOfContents.content, false);
        t.endIndex = idx;
        content.push(t);
        return;
      }
      const cols = b.rows.reduce((m, row) => Math.max(m, row.length), 0);
      const widths = b.widths || Array.from({ length: cols }, () => ({ type: 'EVENLY_DISTRIBUTED' }));
      const tableColumnProperties = widths.map((w) => (w && w.pt != null ? { widthType: w.type || 'FIXED_WIDTH', width: dim(w.pt) } : { widthType: (w && w.type) || 'EVENLY_DISTRIBUTED' }));
      const t = { startIndex: idx, table: { rows: b.rows.length, columns: cols, tableRows: [], tableStyle: { tableColumnProperties } } };
      idx++;
      for (const row of b.rows) {
        const r = { startIndex: idx, tableCells: [] };
        if (b.rows.indexOf(row) < (b.pinned || 0)) r.tableRowStyle = { tableHeader: true };
        idx++;
        for (const cell of row) {
          const [rowSpan, columnSpan] = cell.span || [1, 1];
          const c = { startIndex: idx, content: [], tableCellStyle: { rowSpan, columnSpan, ...clone(cell.style || {}) } };
          idx++;
          renderRun(cell.paras, c.content, true, true);
          c.endIndex = idx;
          r.tableCells.push(c);
        }
        r.endIndex = idx;
        t.table.tableRows.push(r);
      }
      idx++; // a real table ends one index after its last cell (real-docs.js, done-w6 divergence 8)
      t.endIndex = idx;
      tables.push({ start: t.startIndex, end: idx, block: b, at: bi });
      content.push(t);
    });
    return { content, runs, tables, fns, sections };
  };
  const tabOf = (tabId) => srv.tabs.find((t) => t.id === tabId) || (tabId ? null : srv.tabs[0]);
  // The container a location or range addresses ({ tab, c: tab or segment, kind: 'body' | 'header' | 'footer' |
  // 'footnote' }); fails like the API for an unknown tab or segment.
  const target = (o = {}) => {
    const tab = tabOf(o.tabId);
    if (!tab) fail('Invalid tab');
    if (!o.segmentId) return { tab, c: tab, kind: 'body' };
    for (const [kind, key] of Object.entries(SEGMENT_KEYS)) if (tab[key][o.segmentId]) return { tab, c: tab[key][o.segmentId], kind };
    return fail(`Invalid segment ID: ${o.segmentId}`);
  };
  const shifted = (o, index, delta) => { for (const fn of srv.onShift) fn(o.tabId || srv.tabs[0].id, o.segmentId || '', index, delta); };
  const runText = (run) => run.paras.map((p) => p.text + '\n').join('');
  const runChars = (run) => run.paras.flatMap((p) => [...pchars(p), p.nl || undefined]); // parallel to runText (p.nl: the newline's suggestion)
  // The properties a paragraph's newline carries (copied for a split, kept for the surviving newline of a merge).
  const propsOf = (p) => ({ style: p.style, pstyle: clone(p.pstyle || {}), bullet: clone(p.bullet || null) });
  const setRun = (run, str, props, chars) => {
    const texts = str.split('\n'); texts.pop();
    let at = 0;
    run.paras.splice(0, run.paras.length, ...texts.map((text, i) => {
      const p = { text, ...propsOf(props[i]), suggest: false, chars: chars.slice(at, at + text.length) };
      if (chars[at + text.length]) p.nl = chars[at + text.length];
      at += text.length + 1;
      return p;
    }));
  };
  const fail = (msg) => { throw new Error(msg); };
  const findRun = (tab, i) => layout(tab).runs.find((r) => r.start <= i && i < r.end);
  // Paragraphs whose content or newline overlaps [s, e): [{ run, k, p }].
  const parasIn = (tab, s, e) => {
    const out = [];
    for (const run of layout(tab).runs) {
      let at = run.start;
      run.paras.forEach((p, k) => {
        const pEnd = at + p.text.length; // newline index
        if (at < e && s <= pEnd) out.push({ run, k, p });
        at = pEnd + 1;
      });
    }
    return out;
  };
  // The container of a range (tab body or segment), checked like the API.
  const rangeTab = (range) => {
    const { c } = target(range);
    if (range.endIndex <= range.startIndex) fail('Invalid range');
    return c;
  };
  // The tab whose lists a container's paragraphs use.
  const listsTab = (range) => target(range).tab;
  // Inserts plain text (chars: its char styles, default plain) at index i of container c.
  const insertAt = (c, i, text, chars = Array(text.length).fill(undefined)) => {
    const run = findRun(c, i);
    if (!run) fail('Invalid insertion index');
    const str = runText(run);
    const li = i - run.start;
    const before = str.slice(0, li).split('\n').length - 1; // the paragraph being split
    const props = [...run.paras];
    props.splice(before, 0, ...Array(text.split('\n').length - 1).fill(run.paras[before]));
    const all = runChars(run);
    all.splice(li, 0, ...chars);
    setRun(run, str.slice(0, li) + text + str.slice(li), props, all);
  };
  const deleteRange = (c, s, e) => {
    const run = findRun(c, s);
    if (!run || e > run.end - 1 || e <= s) fail('Invalid deletion range: the range crosses a structural element or includes the final newline.');
    const str = runText(run);
    const ls = s - run.start;
    const le = e - run.start;
    const props = [];
    let k = 0;
    for (let i = 0; i < str.length; i++) if (str[i] === '\n') { if (i < ls || i >= le) props.push(run.paras[k]); k++; }
    // A merge keeps the paragraph the deletion starts in when some of its text stays before the range (its named style,
    // paragraph style and bullet), else the paragraph the range ends in (real API, real-docs.js facts 7d, 7e).
    const first = str.slice(0, ls).split('\n').length - 1;
    if (str.slice(ls, le).includes('\n') && ls > str.lastIndexOf('\n', ls - 1) + 1) props[first] = run.paras[first];
    const chars = runChars(run);
    chars.splice(ls, le - ls);
    setRun(run, str.slice(0, ls) + str.slice(le), props, chars);
  };
  // The index of a location or endOfSegmentLocation (the last newline of the container: inserting there goes
  // before it) and its container.
  const locate = (body) => {
    if (body.location) return { ...target(body.location), index: body.location.index, o: body.location };
    const o = body.endOfSegmentLocation || {};
    const t = target(o);
    const runs = layout(t.c).runs;
    return { ...t, index: runs[runs.length - 1].end - 1, o };
  };
  // insertTable: splits the paragraph at the index (Docs inserts a newline first), the table goes between
  // the halves, so it starts at index + 1 and an empty paragraph (the rest of the old one) follows it.
  const insertTable = ({ rows, columns, ...where }) => {
    if (!(rows >= 1 && columns >= 1)) fail('Invalid table size');
    const { c, kind, index } = locate(where);
    if (kind === 'footnote') fail('Tables cannot be inserted into footnotes.');
    const run = findRun(c, index);
    const bi = run ? c.blocks.findIndex((b) => b.type === 'run' && b.paras === run.paras) : -1;
    if (bi < 0) fail('The insertion index must be inside the bounds of an existing paragraph (not in a table cell).');
    const str = runText(run);
    const li = index - run.start;
    const k = str.slice(0, li).split('\n').length - 1;
    const p = run.paras[k];
    const off = li - (str.slice(0, li).lastIndexOf('\n') + 1);
    const cs = pchars(p);
    const head = { ...p, ...propsOf(p), text: p.text.slice(0, off), chars: cs.slice(0, off) };
    const tail = { ...p, ...propsOf(p), text: p.text.slice(off), chars: cs.slice(off) };
    const cells = () => Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ paras: [emptyPara()] })));
    const runA = { type: 'run', paras: [...run.paras.slice(0, k), head] };
    const runB = { type: 'run', paras: [tail, ...run.paras.slice(k + 1)] };
    c.blocks.splice(bi, 1, runA, tableBlock(cells()), runB);
    shifted(where.location || where.endOfSegmentLocation || {}, index, 3 + rows * (1 + columns * 2)); // the newline, the table (start, rows, cells, end)
  };
  // insertSectionBreak: like insertTable, a newline goes in at the index first (it ends the paragraph's head), the
  // break follows it (index + 1) and the rest of the paragraph starts at index + 2. Body paragraphs only.
  const insertSectionBreak = ({ sectionType, ...where }) => {
    if (!['NEXT_PAGE', 'CONTINUOUS'].includes(sectionType)) fail(`Invalid sectionType: ${sectionType}`);
    const o = where.location || where.endOfSegmentLocation || {};
    if (o.segmentId) fail('Section breaks can only be inserted inside the body: the segment ID must be empty.');
    const { c, index } = locate(where);
    const run = findRun(c, index);
    if (run && run.cell) fail('Section breaks cannot be inserted inside a table.');
    const bi = run ? c.blocks.findIndex((b) => b.type === 'run' && b.paras === run.paras) : -1;
    if (bi < 0) fail('The insertion index must be inside the bounds of an existing paragraph.');
    const str = runText(run);
    const li = index - run.start;
    const k = str.slice(0, li).split('\n').length - 1;
    const p = run.paras[k];
    const off = li - (str.slice(0, li).lastIndexOf('\n') + 1);
    const cs = pchars(p);
    const head = { ...p, ...propsOf(p), text: p.text.slice(0, off), chars: cs.slice(0, off) };
    const tail = { ...p, ...propsOf(p), text: p.text.slice(off), chars: cs.slice(off) };
    c.blocks.splice(bi, 1, { type: 'run', paras: [...run.paras.slice(0, k), head] }, { type: 'section', style: { sectionType } },
      { type: 'run', paras: [tail, ...run.paras.slice(k + 1)] });
    shifted(o, index, 2);
  };
  // updateSectionStyle: every section the range overlaps (section k: from its break to the next) gets the fields of the
  // mask; a field in the mask without a value is a 400 (the API cannot unset section fields), and so is a read-only one.
  const updateSectionStyle = ({ range = {}, sectionStyle = {}, fields }) => {
    if (range.segmentId) fail('Section styles can only be updated in the body: the segment ID must be empty.');
    const tab = tabOf(range.tabId);
    if (!tab) fail('Invalid tab');
    if (!(range.endIndex > range.startIndex)) fail('Invalid range');
    const keys = maskFields(fields, SECTION_FIELDS, 'updateSectionStyle');
    for (const k of keys) if (!(k in sectionStyle)) fail(`Invalid requests[0].updateSectionStyle: ${k} cannot be unset.`);
    const cols = sectionStyle.columnProperties;
    if (keys.includes('columnProperties') && (!Array.isArray(cols) || !cols.length || cols.length > 3 || cols.some((x) => x && 'width' in x))) fail('Invalid columnProperties: one to three columns, width is read-only.');
    const { sections } = layout(tab);
    const starts = [0, ...sections.map((x) => x.index)];
    const end = layout(tab).runs.reduce((m, r) => Math.max(m, r.end), 1);
    const styles = [tab.firstSection = tab.firstSection || {}, ...sections.map((x) => tab.blocks[x.at].style)];
    starts.forEach((st, i) => {
      const en = i + 1 < starts.length ? starts[i + 1] : end;
      if (range.startIndex < en && st < range.endIndex) for (const k of keys) styles[i][k] = clone(sectionStyle[k]);
    });
  };
  const segmentsOf = (tab, kind) => tab[SEGMENT_KEYS[kind]];
  const createFootnote = (body) => {
    const { c, kind, index, o } = locate(body);
    if (kind !== 'body') fail('Footnote references cannot be inserted inside an equation, header, footer or footnote.');
    const id = `kix.fn${++srv.segSeq}`;
    insertAt(c, index, OBJ, [{ _fn: id }]);
    shifted(o, index, 1);
    // c is the tab here (a body location); the new footnote holds " \n".
    c.footnotes[id] = { blocks: [{ type: 'run', paras: [{ ...emptyPara(), text: ' ', chars: [undefined] }] }] };
    return { createFootnote: { footnoteId: id } };
  };
  const createHeaderFooter = (kind, body) => {
    const tab = tabOf(body.sectionBreakLocation && body.sectionBreakLocation.tabId);
    if (!tab) fail('Invalid tab');
    const Name = kind === 'header' ? 'Header' : 'Footer';
    if (body.type && !['DEFAULT', 'HEADER_FOOTER_TYPE_UNSPECIFIED'].includes(body.type)) fail(`Invalid ${kind} type: ${body.type}`);
    if (tab.docStyle[`default${Name}Id`]) fail(`A ${kind} of the specified type already exists.`);
    const id = `kix.${kind}${++srv.segSeq}`;
    segmentsOf(tab, kind)[id] = { blocks: [{ type: 'run', paras: [emptyPara()] }] };
    tab.docStyle[`default${Name}Id`] = id;
    return { [`create${Name}`]: { [`${kind}Id`]: id } };
  };
  const deleteHeaderFooter = (kind, id, tabId) => {
    const tab = tabOf(tabId);
    if (!tab || !segmentsOf(tab, kind)[id]) fail(`Invalid ${kind} ID: ${id}`);
    delete segmentsOf(tab, kind)[id];
    for (const [k, v] of Object.entries(tab.docStyle)) if (v === id) delete tab.docStyle[k];
  };
  // What a plugin handler gets (registerFakeRequest): the server, the lookups and the edit primitives.
  const fakeApi = () => ({ srv, tabOf, target, layout, findRun, parasIn, runText, runChars, setRun, insertAt, deleteRange, locate,
    pchars, propsOf, emptyPara, tableBlock, fail, clone, dim, shifted, OBJ, json });
  srv.api = fakeApi;
  const updateNamedStyle = (body) => {
    if (srv.noNamedStyleUpdate) fail('Invalid JSON payload received. Unknown name "updateNamedStyle" at \'requests[0]\': Cannot find field.');
    const ns = body.namedStyle || {};
    if (!NAMED_TYPES.includes(ns.namedStyleType)) fail(`Invalid namedStyleType: ${ns.namedStyleType}`);
    const tab = tabOf(body.tabId);
    if (!tab) fail('Invalid tab');
    const keys = String(body.fields || '').split(',').map((k) => k.trim()).filter(Boolean);
    const known = (k) => k === '*' || k === 'namedStyleType' || k === 'textStyle' || k === 'paragraphStyle'
      || (k.startsWith('textStyle.') && TEXT_FIELDS.includes(k.slice(10))) || (k.startsWith('paragraphStyle.') && PARA_FIELDS.includes(k.slice(15)) && k !== 'paragraphStyle.namedStyleType');
    const bad = keys.filter((k) => !known(k));
    if (!keys.length || bad.length) fail(`Invalid field mask for updateNamedStyle: ${bad.join(', ') || '(empty)'}`);
    // The real API refuses a mask without namedStyleType (test/lib/real-docs.js, development/tools/real-docs.js facts 8b).
    if (!keys.includes('namedStyleType') && !keys.includes('*')) fail('Invalid requests[0].updateNamedStyle: Named style type is required.');
    const st = tab.named[ns.namedStyleType];
    // A parent named with one of its leaves does not replace the part: the real API then keeps the other fields (fact 8b).
    const whole = (part) => keys.includes(part) && !keys.some((k) => k.startsWith(part + '.'));
    for (const k of keys) {
      if (k === '*' || (k === 'textStyle' && whole('textStyle'))) st.textStyle = clone(ns.textStyle || {});
      if (k === '*' || (k === 'paragraphStyle' && whole('paragraphStyle'))) st.paragraphStyle = clone(ns.paragraphStyle || {});
      const m = /^(textStyle|paragraphStyle)\.(.+)$/.exec(k);
      if (!m) continue;
      const src = ns[m[1]] || {};
      if (m[2] in src) st[m[1]][m[2]] = clone(src[m[2]]); else delete st[m[1]][m[2]];
    }
  };
  // updateDocumentStyle: sets or resets each field of its flat mask on the tab's documentStyle (rendered with the tab);
  // srv.noPagelessUpdate (spec.noPagelessUpdate) refuses documentFormat with a 400, as an API that does not take it might.
  const updateDocumentStyle = (body) => {
    const tab = tabOf(body.tabId);
    if (!tab) fail('Invalid tab');
    const keys = maskFields(body.fields, DOC_STYLE_FIELDS, 'updateDocumentStyle');
    if (srv.noPagelessUpdate && keys.includes('documentFormat')) fail('Invalid requests[0].updateDocumentStyle: documentMode cannot be changed.');
    const ds = body.documentStyle || {};
    // These cannot be unset: a field without a value is a 400 (real-docs.js fact 10); the others reset.
    const bare = keys.find((k) => !(k in ds) && UNSETTABLE_PAGE.includes(k));
    if (bare) fail(`Invalid requests[0].updateDocumentStyle: A value for ${bare} must be specified in order to update it.`);
    tab.docStyle = tab.docStyle || {};
    for (const k of keys) if (k in ds) tab.docStyle[k] = clone(ds[k]); else delete tab.docStyle[k];
  };
  // The text style inserted text takes (real-docs.js facts 7b, 7e): the character's before the index in its paragraph, at
  // a paragraph's start the one at the index (an empty paragraph's newline: plain here); without the link, and a linked
  // character's underline and color go with it. null for plain.
  // Text inserted where the previous request of the batch deleted text takes the first deleted character's style instead
  // (real-docs.js fact 7f: a whole bold word replaced stays bold): srv.deletedAt { c, i, st }.
  const passedOn = (src) => {
    if (!src) return null;
    const { _fn, _obj, _ins, _del, link, ...st } = src;
    if (link) { delete st.underline; delete st.color; }
    return Object.keys(st).length ? st : null;
  };
  const inheritedAt = (c, i) => {
    const d = srv.deletedAt;
    if (d && d.c === c && d.i === i) return d.st;
    const run = findRun(c, i);
    if (!run) return null;
    const str = runText(run);
    const li = i - run.start;
    return passedOn(runChars(run)[li > 0 && str[li - 1] !== '\n' ? li - 1 : li]);
  };
  // Suggest mode: the suggestion the request being applied makes ({ id }), or null for a direct edit.
  let sugg = null;
  // The suggestion of this server's own making ("sugg.N": the same author) that a text request touches: the character
  // before or after an insertion, before, after or inside a deletion. Google merges the request into it and the reply
  // names it in updatedSummarySuggestionIds (real-docs.js facts 8s, 8t: a replace is one suggestion). A spec's
  // suggestions are another author's and never merged.
  const ownSuggestionNear = (rq) => {
    let c; let s; let e;
    try {
      if (rq.deleteContentRange) { const r = rq.deleteContentRange.range; c = target(r).c; s = r.startIndex; e = r.endIndex; } else {
        const l = locate(rq.insertText || rq.insertPerson || rq.insertRichLink || rq.insertDate);
        c = l.c; s = e = l.index;
      }
    } catch (err) { return null; } // the request fails on its own
    const at = (i) => { const run = findRun(c, i); return run ? runChars(run)[i - run.start] : undefined; };
    for (const i of [s - 1, e, ...Array.from({ length: Math.max(0, e - s) }, (_, k) => s + k)]) {
      const ch = at(i);
      const id = ch && [ch._ins, ch._del].find((x) => typeof x === 'string' && x.startsWith('sugg.'));
      if (id) return id;
    }
    return null;
  };
  const marked = (n, extra = {}) => Array.from({ length: n }, () => ({ ...extra, _ins: sugg.id }));
  // Marks [s, e) of container c for deletion (the text stays; the API's range rules apply as for a deletion).
  const markDeleted = (c, s, e) => {
    const run = findRun(c, s);
    if (!run || e > run.end - 1 || e <= s) fail('Invalid deletion range: the range crosses a structural element or includes the final newline.');
    const chars = runChars(run);
    for (let i = s - run.start; i < e - run.start; i++) chars[i] = { ...(chars[i] || {}), _del: sugg.id };
    setRun(run, runText(run), run.paras.slice(), chars);
  };
  // Settles suggestion id everywhere: drop (true) or keep (false) its inserted and its deleted characters, the mark gone.
  const settleChars = (id, dropIns, dropDel) => {
    let found = false;
    for (const tab of srv.tabs) {
      for (const c of [tab, ...Object.values(SEGMENT_KEYS).flatMap((k) => Object.values(tab[k] || {}))]) {
        for (const run of layout(c).runs) {
          const str = runText(run);
          const chars = runChars(run);
          if (!chars.some((ch) => ch && (ch._ins === id || ch._del === id))) continue;
          found = true;
          let out = '';
          const keep = [];
          const props = [];
          let k = 0;
          for (let i = 0; i < str.length; i++) {
            const ch = chars[i];
            const drop = !!ch && ((ch._ins === id && dropIns) || (ch._del === id && dropDel));
            if (str[i] === '\n') { if (!drop || i === str.length - 1) props.push(run.paras[k]); k++; }
            if (drop && i < str.length - 1) continue;
            let v = ch;
            if (v && (v._ins === id || v._del === id)) {
              v = { ...v };
              if (v._ins === id) delete v._ins;
              if (v._del === id) delete v._del;
              if (!Object.keys(v).length) v = undefined;
            }
            out += str[i];
            keep.push(v);
          }
          setRun(run, out, props, keep);
        }
      }
    }
    return found;
  };
  srv.settleSuggestion = (id, accept) => settleChars(id, !accept, !!accept);
  const apply = (req) => {
    const name = Object.keys(req)[0];
    srv.deletedAt = srv.justDeleted; // only the request right after a deletion sees it
    srv.justDeleted = null;
    if (req.deleteSuggestion) {
      if (!settleChars(req.deleteSuggestion.suggestionId, true, false)) fail(`Suggestion ${req.deleteSuggestion.suggestionId} not found.`);
      return {};
    }
    if (req.updateNamedStyle) return updateNamedStyle(req.updateNamedStyle);
    if (req.updateDocumentStyle) return updateDocumentStyle(req.updateDocumentStyle);
    if (PLUGINS.requests[name]) return PLUGINS.requests[name](req[name], fakeApi());
    if (req.insertTable) return insertTable(req.insertTable);
    if (req.insertSectionBreak) return insertSectionBreak(req.insertSectionBreak);
    if (req.updateSectionStyle) return updateSectionStyle(req.updateSectionStyle);
    if (req.createFootnote) return createFootnote(req.createFootnote);
    if (req.createHeader) return createHeaderFooter('header', req.createHeader);
    if (req.createFooter) return createHeaderFooter('footer', req.createFooter);
    if (req.deleteHeader) return deleteHeaderFooter('header', req.deleteHeader.headerId, req.deleteHeader.tabId);
    if (req.deleteFooter) return deleteHeaderFooter('footer', req.deleteFooter.footerId, req.deleteFooter.tabId);
    if (req.deleteContentRange) {
      const range = req.deleteContentRange.range;
      const { startIndex: s, endIndex: e } = range;
      if (sugg) { markDeleted(target(range).c, s, e); return; }
      const c = target(range).c;
      // (a newline deleted first: its style is the last character's, which Docs gives a newline; the fake keeps it plain)
      const first = findRun(c, s);
      const k = first ? s - first.start : -1;
      const fs = first ? runText(first) : '';
      if (first && srv.inheritStyle) srv.justDeleted = { c, i: s, st: passedOn(runChars(first)[fs[k] === '\n' && k > 0 && fs[k - 1] !== '\n' ? k - 1 : k]) };
      // A section break goes only with the newline before it (the API refuses that newline alone, and the break
      // alone here as well: unverified); the runs around it become one, the range then ends one index earlier.
      const secs = isTab(c) ? layout(c).sections.filter((x) => (s <= x.index && x.index < e) || (s <= x.index - 1 && x.index - 1 < e)) : [];
      if (secs.length) {
        const sec = secs[0];
        const A = c.blocks[sec.at - 1];
        const B = c.blocks[sec.at + 1];
        if (secs.length > 1 || s > sec.index - 1 || e <= sec.index || !A || A.type !== 'run' || !B || B.type !== 'run') fail('Invalid deletion range: a section break is deleted together with the newline before it.');
        c.blocks.splice(sec.at - 1, 3, { type: 'run', paras: [...A.paras, ...B.paras] });
        deleteRange(c, s, e - 1);
      } else deleteRange(c, s, e);
      shifted(range, s, s - e);
    } else if (req.insertText) {
      const loc = req.insertText.location || req.insertText.endOfSegmentLocation;
      // eslint-disable-next-line no-control-regex -- mirrors the Docs API stripping C0 controls
      const text = req.insertText.text.replace(/[\u0000-\u0008\u000C-\u001F\uE000-\uF8FF]/g, ''); // C0 controls and private-use characters, stripped by the API (as sanitizeInsertText)
      const { c, index: i } = locate(req.insertText);
      const inh = srv.inheritStyle ? inheritedAt(c, i) : null;
      insertAt(c, i, text, Array.from({ length: text.length }, () => (sugg || inh ? { ...(inh || {}), ...(sugg ? { _ins: sugg.id } : {}) } : undefined)));
      shifted(loc || {}, i, text.length);
    } else if (req.insertPerson || req.insertRichLink || req.insertDate) {
      const body = req.insertPerson || req.insertRichLink || req.insertDate;
      let el;
      if (req.insertPerson) {
        const pp = body.personProperties || {};
        if (!pp.email) fail('personProperties.email is required');
        el = { person: { personId: 'person.' + (++srv.chipSeq), personProperties: { email: pp.email, ...(srv.people[pp.email] ? { name: srv.people[pp.email] } : {}) } } };
      } else if (req.insertRichLink) {
        const rp = body.richLinkProperties || {};
        if (!rp.uri) fail('richLinkProperties.uri is required');
        el = { richLink: { richLinkId: 'link.' + (++srv.chipSeq), richLinkProperties: { uri: rp.uri, title: 'Linked file' } } };
      } else {
        const dp = body.dateElementProperties || {};
        if (!dp.timestamp) fail('dateElementProperties.timestamp is required');
        const displayText = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: dp.timeZoneId || 'UTC' }).format(new Date(dp.timestamp));
        el = { dateElement: { dateId: 'date.' + (++srv.chipSeq), dateElementProperties: { ...clone(dp), displayText } } };
      }
      const { c, index: i, o } = locate(body);
      const run = findRun(c, i);
      if (!run || i >= run.end) fail('The insertion index must be inside the bounds of an existing paragraph.');
      insertAt(c, i, OBJ, sugg ? marked(1, { _obj: el }) : [{ _obj: el }]);
      shifted(o || {}, i, 1);
    } else if (req.updateParagraphStyle) {
      const { range, paragraphStyle: ps = {}, fields } = req.updateParagraphStyle;
      const keys = maskFields(fields, PARA_FIELDS, 'updateParagraphStyle');
      // A border is written whole (the API takes no partial border).
      for (const k of BORDER_FIELDS) {
        const b = keys.includes(k) && ps[k];
        if (b && !['color', 'width', 'padding', 'dashStyle'].every((f) => f in b)) fail(`${k}: a paragraph border must be given in its entirety`);
      }
      if (ps.pageBreakBefore && parasIn(rangeTab(range), range.startIndex, range.endIndex).some(({ run }) => run.cell)) fail('pageBreakBefore is not supported in a table');
      if (keys.includes('namedStyleType')) namedStyleClears(parasIn(rangeTab(range), range.startIndex, range.endIndex).map((x) => x.p), ps.namedStyleType || 'NORMAL_TEXT');
      for (const { p } of parasIn(rangeTab(range), range.startIndex, range.endIndex)) {
        p.pstyle = p.pstyle || {};
        for (const k of keys) {
          if (k === 'namedStyleType') p.style = ps.namedStyleType || 'NORMAL_TEXT';
          else if (k in ps) { p.pstyle[k] = clone(ps[k]); if (p.listLeft) delete p.listLeft[k]; } else if (srv.stickyListIndent && p.listLeft && k in p.listLeft) p.pstyle[k] = clone(p.listLeft[k]);
          else delete p.pstyle[k];
        }
      }
    } else if (req.updateTextStyle) {
      const { range, textStyle, fields } = req.updateTextStyle;
      const { startIndex: s, endIndex: e } = range;
      const { c } = target(range);
      if (e <= s) fail('Invalid range');
      const keys = maskFields(fields, TEXT_FIELDS, 'updateTextStyle');
      // weightedFontFamily is applied first, then bold (the API reference), so bold survives in the same request.
      keys.sort((a, b) => (b === 'weightedFontFamily') - (a === 'weightedFontFamily'));
      const named = target(range).tab.named;
      for (const run of layout(c).runs) {
        let at = run.start;
        for (const p of run.paras) {
          const chars = pchars(p);
          // srv.dropInherited: a size or color equal to the one the paragraph's named style gives is not stored, as in Docs
          // (real-docs.js fact 2).
          const inh = namedText(named, p.style);
          for (let i = Math.max(s, at); i < Math.min(e, at + p.text.length); i++) {
            const st = { ...chars[i - at] };
            for (const k of keys) setTextField(st, k, textStyle || {}, srv.linkAutoStyle);
            if (srv.dropInherited && keys.includes('fontSize') && st.size === inh.size) delete st.size;
            if (srv.dropInherited && keys.includes('foregroundColor') && st.color === inh.color && !st.link) delete st.color;
            // srv.boldFont (spec.boldFont): a bold write also stores the font the text shows, weight 400, as Docs does (fact 7b).
            if (srv.boldFont && keys.includes('bold') && st.bold && !st.font) st.font = inh.font;
            chars[i - at] = Object.keys(st).length ? st : undefined;
          }
          p.chars = chars;
          at += p.text.length + 1;
        }
      }
    } else if (req.createParagraphBullets) {
      const { range, bulletPreset } = req.createParagraphBullets;
      if (!presetGlyphs(String(bulletPreset || ''))) fail(`Invalid bulletPreset: ${bulletPreset}`);
      const hit = parasIn(rangeTab(range), range.startIndex, range.endIndex);
      const tab = listsTab(range);
      if (!hit.length) fail('Invalid range');
      // As the real API does (development/tools/real-docs.js facts num1–num4): a paragraph that has a bullet keeps it (and
      // its tabs), and the plain paragraphs of the range join its list; else a list right before the range with the same
      // preset is continued; else a new list. A plain paragraph's depth: its leading tabs (removed from the text) plus its
      // first-line indent (its own, else its named style's) in whole steps of 36 pt. Its level: the depth less the
      // shallowest depth of the plain paragraphs of the range, plus the level of the item it follows (the item right
      // before the range, or the nearest item of the range before it). Its indents: its depth's level's in a new list, its
      // level's in a list it joins.
      const plain = hit.filter(({ p }) => !p.bullet);
      const listed = hit.filter(({ p }) => p.bullet);
      const prev = hit[0].run.paras[hit[0].k - 1];
      let listId = listed.length ? listed[0].p.bullet.listId : null;
      let base = 0;
      if (!listId && prev && prev.bullet && tab.lists[prev.bullet.listId] && tab.lists[prev.bullet.listId].preset === bulletPreset) { listId = prev.bullet.listId; base = prev.bullet.level || 0; }
      const joins = !!listId;
      if (!listId && plain.length) { listId = `kix.list.${++srv.listSeq}`; tab.lists[listId] = { preset: bulletPreset, nestingLevels: nestingLevels(bulletPreset) }; }
      const levels = listId ? tab.lists[listId].nestingLevels : [];
      const pt = (v) => (typeof v === 'number' ? v : (v && v.magnitude) || 0);
      const firstLine = (p) => {
        const own = (p.pstyle || {}).indentFirstLine;
        return pt(own != null ? own : (((tab.named || {})[p.style || 'NORMAL_TEXT'] || {}).paragraphStyle || {}).indentFirstLine);
      };
      const depth = new Map(plain.map(({ p }) => [p, /^\t*/.exec(p.text)[0].length + Math.floor(firstLine(p) / 36 + 1e-9)]));
      const min = Math.min(...depth.values());
      let after = base;
      for (const { p } of hit) {
        if (p.bullet) { after = p.bullet.level || 0; continue; }
        const tabs = /^\t*/.exec(p.text)[0].length;
        p.chars = pchars(p).slice(tabs);
        p.text = p.text.slice(tabs);
        const level = Math.min(after + depth.get(p) - min, levels.length - 1);
        const ind = levels[joins ? level : Math.min(depth.get(p), levels.length - 1)];
        p.bullet = { listId, level };
        p.pstyle = { ...(p.pstyle || {}), indentStart: clone(ind.indentStart), indentFirstLine: clone(ind.indentFirstLine) };
        delete p.listLeft;
      }
    } else if (req.deleteParagraphBullets) {
      const { range } = req.deleteParagraphBullets;
      const c = rangeTab(range);
      const tab = listsTab(range);
      for (const { p } of parasIn(c, range.startIndex, range.endIndex)) {
        if (!p.bullet) continue;
        // Docs leaves the nesting level as a plain indent of level × 36 pt on both fields, stored only where it differs
        // from the named style's (real-docs.js fact 1: 0/0 at level 0, so nothing; 36/36 at level 1).
        const v = 36 * (p.bullet.level || 0);
        const named = ((tab.named || {})[p.style] || {}).paragraphStyle || {};
        p.pstyle = { ...(p.pstyle || {}) };
        for (const k of ['indentStart', 'indentFirstLine']) {
          if (v !== ((named[k] && named[k].magnitude) || 0)) p.pstyle[k] = dim(v); else delete p.pstyle[k];
        }
        p.listLeft = { indentStart: dim(v), indentFirstLine: dim(v) };
        p.bullet = null;
      }
    } else fail('Unsupported request');
  };
  const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const renderLists = (t) => {
    const ids = Object.keys(t.lists || {});
    if (!ids.length) return {};
    return { lists: Object.fromEntries(ids.map((id) => [id, { listProperties: { nestingLevels: clone(t.lists[id].nestingLevels) } }])) };
  };
  // headers / footers / footnotes (only footnotes whose mark is in the body) and documentStyle, when the tab has any.
  const renderSegments = (t, fns) => {
    const out = {};
    for (const [kind, key] of Object.entries(SEGMENT_KEYS)) {
      const ids = Object.keys(t[key] || {}).filter((id) => kind !== 'footnote' || fns.includes(id));
      if (ids.length) out[key] = Object.fromEntries(ids.map((id) => [id, { [`${kind}Id`]: id, content: layout(t[key][id]).content }]));
    }
    if (Object.keys(t.docStyle || {}).length) out.documentStyle = clone(t.docStyle);
    return out;
  };
  // documentTab.inlineObjects of the described images of a tab (body and segments), when it has any.
  const renderImages = (t) => {
    const out = {};
    const conts = [t, ...Object.values(SEGMENT_KEYS).flatMap((k) => Object.values(t[k] || {}))];
    for (const c of conts) for (const p of containerParas(c)) for (const ch of pchars(p)) if (ch && ch._obj && ch._obj.image) out[ch._obj.image.id || 'kix.img'] = imageObject(ch._obj.image);
    return Object.keys(out).length ? { inlineObjects: out } : {};
  };
  const renderTab = (t) => {
    const { content, fns } = layout(t);
    return { body: { content }, ...renderLists(t), ...renderSegments(t, fns), ...renderImages(t) };
  };
  srv.render = (includeTabs) => {
    const out = { documentId: srv.documentId, title: srv.title, revisionId: 'rev-' + srv.revision };
    if (includeTabs) out.tabs = srv.tabs.map((t, i) => ({ tabProperties: { tabId: t.id, title: t.title, index: i }, documentTab: renderTab(t) }));
    else out.body = { content: layout(srv.tabs[0]).content };
    for (const fn of PLUGINS.renders) fn(srv, out, includeTabs);
    return out;
  };
  const containerParas = (c) => {
    const out = [];
    for (const b of c.blocks) {
      if (b.type === 'run') out.push(...b.paras);
      else if (b.type === 'table') for (const row of b.rows) for (const cell of row) out.push(...cell.paras);
    }
    return out;
  };
  const paras = (tabId) => containerParas(tabOf(tabId));
  // A segment's paragraph texts joined with "\n" (objects as "￼"); null when it does not exist.
  srv.segText = (segmentId, tabId) => {
    const tab = tabOf(tabId);
    for (const key of Object.values(SEGMENT_KEYS)) if (tab[key][segmentId]) return containerParas(tab[key][segmentId]).map((p) => p.text.split(OBJ).join('￼')).join('\n');
    return null;
  };
  // The segment IDs of a tab: { headers, footers, footnotes (every stored one, marks deleted or not), documentStyle }.
  srv.segments = (tabId) => { const t = tabOf(tabId); return { headers: Object.keys(t.headers), footers: Object.keys(t.footers), footnotes: Object.keys(t.footnotes), documentStyle: clone(t.docStyle) }; };
  // Table blocks of a tab body in order: { rows: [[cell texts]], widths, spans } (structure checks).
  // The section breaks of a tab body in order, the first (index 0) included: [{ index, style (sectionStyle, API shapes) }].
  srv.sections = (tabId) => { const t = tabOf(tabId); return [{ index: 0, style: clone(t.firstSection || {}) }, ...layout(t).sections.map((x) => ({ index: x.index, style: clone(t.blocks[x.at].style) }))]; };
  srv.tables = (tabId) => tabOf(tabId).blocks.filter((b) => b.type === 'table').map((b) => ({
    rows: b.rows.map((row) => row.map((cell) => cell.paras.map((p) => p.text).join('\n'))), widths: clone(b.widths || null),
    spans: b.rows.flatMap((row, r) => row.map((cell, c) => (cell.span ? [r, c, ...cell.span] : null))).filter(Boolean),
  }));
  // Paragraph texts joined with "\n" (objects shown as "￼", like the panel); raw keeps OBJ apart from literal U+FFFC.
  srv.text = (tabId) => paras(tabId).map((p) => p.text.split(OBJ).join('￼')).join('\n');
  srv.raw = (tabId) => paras(tabId).map((p) => p.text).join('\n');
  srv.styles = (tabId) => paras(tabId).map((p) => p.style);
  // Table styles of a tab body in order: { pinned, cells: [[tableCellStyle fields set on the cell, API shapes]] }.
  srv.tableStyles = (tabId) => tabOf(tabId).blocks.filter((b) => b.type === 'table').map((b) => ({
    pinned: b.pinned || 0, cells: b.rows.map((row) => row.map((cell) => clone(cell.style || {}))),
  }));
  srv.objects = (tabId) => paras(tabId).map((p) => pchars(p).map((ch, i) => (ch && ch._obj ? [i, Object.keys(ch._obj)[0]] : null)).filter(Boolean));
  // Text styles per paragraph: [[s, e, style], ...] for the stretches of equal non-plain style (friendly keys:
  // bold, italic, underline, link, font, weight, size, color, bg).
  srv.fmt = (tabId) => paras(tabId).map((p) => {
    const out = [];
    pchars(p).forEach((st0, i) => {
      const { _fn, _obj, _ins, _del, ...st } = st0 || {}; // a footnote mark, a chip or a suggestion is no text style
      if (!st0 || !Object.keys(st).length) return;
      const last = out[out.length - 1];
      const same = last && last[1] === i && JSON.stringify(Object.entries(last[2]).sort()) === JSON.stringify(Object.entries(st).sort());
      if (same) last[1]++; else out.push([i, i + 1, st]);
    });
    return out;
  });
  // Paragraph styles per paragraph (explicit fields only; Dimensions as numbers of points).
  srv.pstyles = (tabId) => paras(tabId).map((p) => Object.fromEntries(Object.entries(p.pstyle || {})
    .map(([k, v]) => [k, v && typeof v === 'object' && 'unit' in v ? v.magnitude || 0 : v])));
  // Bullets per paragraph: null or { listId, level, preset }.
  srv.bullets = (tabId) => paras(tabId).map((p) => (p.bullet ? { ...p.bullet, preset: (tabOf(tabId).lists[p.bullet.listId] || {}).preset || null } : null));
  // An outside edit (the user typing): a new paragraph at position i of the first body run.
  srv.typeParagraph = (i, text) => { srv.tabs[0].blocks[0].paras.splice(i, 0, { text, style: 'NORMAL_TEXT', suggest: false, chars: [], pstyle: {}, bullet: null }); srv.revision++; };
  srv.fetch = async (url, init = {}) => {
    const m = /^https:\/\/docs\.googleapis\.com\/v1\/documents\/([^?:]+)(:batchUpdate)?(\?.*)?$/.exec(url);
    if (!m) return null;
    const method = init.method || 'GET';
    srv.log.push({ method, url, auth: init.headers && init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (srv.failNext && !srv.failNext.network) { const f = srv.failNext; srv.failNext = null; return json(f.status, { error: { code: f.status, message: f.message || 'failure', status: 'FAILED' } }); }
    if (!init.headers || init.headers.Authorization !== 'Bearer ' + srv.token) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    if (decodeURIComponent(m[1]) !== srv.documentId) return json(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
    if (!m[2]) {
      if (srv.failReads > 0) { srv.failReads--; throw new TypeError('Failed to fetch'); }
      const params = new URLSearchParams((m[3] || '').slice(1));
      for (const fn of PLUGINS.gets) { const r = fn(srv, url, params, fakeApi()); if (r) return r; }
      const withTabs = params.get('includeTabsContent') === 'true';
      if (!withTabs && params.has('fields')) {
        let keys;
        try { keys = maskFields(params.get('fields'), GET_TOP_FIELDS, 'documents.get'); } catch (e) {
          return json(400, { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } });
        }
        const doc = srv.render(false);
        return json(200, Object.fromEntries(keys.filter((k) => k in doc).map((k) => [k, doc[k]])));
      }
      const doc = srv.render(withTabs);
      // The named styles only for a read that asks for them (fetchNamedStyles); the model's read never does.
      if (withTabs && /namedStyles/.test(params.get('fields') || '')) {
        doc.tabs.forEach((t, i) => { t.documentTab.namedStyles = { styles: NAMED_TYPES.map((type) => ({ namedStyleType: type, ...clone(srv.tabs[i].named[type]) })) }; });
      }
      return json(200, doc);
    }
    const body = JSON.parse(init.body);
    const net = srv.failNext && srv.failNext.network ? srv.failNext : null;
    srv.failNext = null;
    if (net && !net.apply) throw new TypeError('Failed to fetch');
    const wc = body.writeControl || null;
    const suggest = !!wc && wc.writeMode === 'SUGGEST' && !srv.suggestIgnored;
    if (wc && wc.writeMode && srv.suggestNoRevision && 'requiredRevisionId' in wc) {
      return json(400, { error: { code: 400, message: 'Invalid value at \'write_control\': writeMode cannot be combined with requiredRevisionId.', status: 'INVALID_ARGUMENT' } });
    }
    if (wc && 'requiredRevisionId' in wc && wc.requiredRevisionId !== 'rev-' + srv.revision) {
      return json(400, { error: { code: 400, message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } });
    }
    if (suggest) {
      const bad = body.requests.map((rq) => Object.keys(rq)[0]).find((k) => SUGGEST_REFUSED.includes(k));
      const docFmt = body.requests.some((rq) => rq.updateDocumentStyle && /documentFormat|useEvenPageHeaderFooter|useFirstPageHeaderFooter/.test(rq.updateDocumentStyle.fields || ''));
      if (bad || docFmt) return json(400, { error: { code: 400, message: `${bad || 'updateDocumentStyle'} is not supported in suggestions mode.`, status: 'INVALID_ARGUMENT' } });
    }
    // A failed batch changes nothing: srv.backupKeys (plugins add theirs, e.g. comments) are restored.
    const backup = JSON.stringify(Object.fromEntries(srv.backupKeys.map((k) => [k, srv[k]])));
    srv.justDeleted = null;
    let replies;
    const created = []; // the suggestionResponses entry of each request
    try {
      replies = body.requests.map((rq) => {
        const k = Object.keys(rq)[0];
        const text = suggest && ['insertText', 'deleteContentRange', 'insertPerson', 'insertRichLink', 'insertDate'].includes(k);
        const near = text ? ownSuggestionNear(rq) : null;
        sugg = text ? { id: near || 'sugg.' + (++srv.suggSeq) } : null;
        // A style request is applied directly here, but its reply names a suggested style change of its own, as Google's does.
        const styled = suggest && STYLE_SUGGESTIONS.includes(k) ? { createdSuggestionIds: [`sugg.style.${++srv.styleSuggSeq}`] } : {};
        created.push(!sugg ? styled : near ? { updatedSummarySuggestionIds: [near] } : { createdSuggestionIds: [sugg.id] });
        try { return apply(rq) || {}; } finally { sugg = null; }
      });
    } catch (e) {
      Object.assign(srv, JSON.parse(backup));
      return json(400, { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } });
    }
    srv.revision++;
    if (net) throw new TypeError('Failed to fetch'); // applied, but the response was lost
    const extra = Object.assign({}, ...PLUGINS.responses.map((fn) => fn(srv, body) || {}));
    const suggestionResponses = suggest && !srv.suggestNoIds ? { suggestionResponses: created } : {};
    return json(200, { documentId: srv.documentId, replies, writeControl: { requiredRevisionId: 'rev-' + srv.revision }, ...suggestionResponses, ...extra });
  };
  srv.backupKeys = ['tabs', 'listSeq', 'segSeq', 'suggSeq', 'styleSuggSeq'];
  srv.suggSeq = 0;
  srv.styleSuggSeq = 0;
  srv.suggestNoRevision = !!spec.suggestNoRevision;
  srv.suggestIgnored = !!spec.suggestIgnored;
  srv.suggestNoIds = !!spec.suggestNoIds;
  // The character suggestions of a tab's body (runs and cells) in text order: [{ id, kind: 'ins' | 'del', text }].
  srv.suggested = (tabId) => {
    const out = [];
    let g = 0; // the position in the tab's text (paragraphs joined, each with its newline)
    for (const p of paras(tabId)) {
      const str = p.text.split(OBJ).join('￼') + '\n';
      const chars = [...pchars(p), p.nl || undefined];
      for (let i = 0; i < str.length; i++, g++) {
        for (const kind of ['ins', 'del']) {
          const id = chars[i] && chars[i]['_' + kind];
          if (!id) continue;
          const last = out.filter((x) => x.kind === kind).pop();
          if (last && last.id === id && last.end === g) { last.text += str[i]; last.end++; } else out.push({ id, kind, text: str[i], end: g + 1 });
        }
      }
    }
    return out.map(({ id, kind, text }) => ({ id, kind, text }));
  };
  srv.noNamedStyleUpdate = !!spec.noNamedStyleUpdate;
  srv.inheritStyle = spec.inheritStyle !== false;
  srv.boldFont = spec.boldFont !== false;
  srv.dropInherited = spec.dropInherited !== false;
  srv.noPagelessUpdate = !!spec.noPagelessUpdate;
  // The named styles of a tab as friendly values: { type: { font, size, bold, italic, alignment, spaceAbove, spaceBelow, color } }.
  srv.named = (tabId) => Object.fromEntries(NAMED_TYPES.map((type) => {
    const { textStyle: ts = {}, paragraphStyle: ps = {} } = tabOf(tabId).named[type];
    const v = {};
    if (ts.weightedFontFamily) v.font = ts.weightedFontFamily.fontFamily;
    if (ts.fontSize) v.size = ts.fontSize.magnitude;
    if (ts.bold != null) v.bold = ts.bold;
    if (ts.italic != null) v.italic = ts.italic;
    if (ts.foregroundColor) v.color = hexOf(ts.foregroundColor.color.rgbColor);
    if (ps.alignment) v.alignment = ps.alignment;
    for (const k of ['spaceAbove', 'spaceBelow']) if (ps[k]) v[k] = ps[k].magnitude || 0;
    return [type, v];
  }));
  for (const fn of PLUGINS.inits) fn(srv, spec);
  return srv;
}

// ---- A documents.get body as a spec (the bug bundle replay: test/lib/tool-eval.js) ------------------------------------
// specFromBody(body, over): the spec whose server renders the body back, with its own (recomputed) indices: every tab
// (child tabs flattened; ids and titles kept), paragraphs with their text styles, paragraph styles, bullets and character
// suggestions (the newline's too), the tab's lists, tables (column widths, spans, cell styles, pinned header rows), section
// breaks, the table of contents, headers, footers, footnotes and documentStyle, chips, and images with their inlineObjects
// entry (title, description, size). An element the fake does not model (pageBreak, columnBreak, horizontalRule, autoText,
// equation) is one object character rendered as that element; a table nested in a cell gives its paragraphs to the cell.
// Named styles are Docs' defaults (the panel's own read does not ask for them). over: { documentId, title }.
const BODY_ELEMENT_SKIP = ['textStyle', 'suggestedInsertionIds', 'suggestedDeletionIds', 'suggestedTextStyleChanges'];
const OBJ_SPEC = String.fromCharCode(0xFFFC); // an object in a spec paragraph
const suggOf = (x) => ({ ...(x && Array.isArray(x.suggestedInsertionIds) && x.suggestedInsertionIds.length ? { _ins: x.suggestedInsertionIds[0] } : {}),
  ...(x && Array.isArray(x.suggestedDeletionIds) && x.suggestedDeletionIds.length ? { _del: x.suggestedDeletionIds[0] } : {}) });
const rgbOf = (c) => (c && c.color && c.color.rgbColor ? c.color.rgbColor : null);
// An API textStyle -> a friendly char style (apiStyle's inverse).
function friendlyStyle(ts = {}) {
  const st = {};
  for (const k of ['bold', 'italic', 'underline']) if (ts[k] === true) st[k] = true; else if (ts[k] === false) st[k] = false;
  if (ts.link && Object.keys(ts.link).length) st.link = Object.keys(ts.link).length === 1 && typeof ts.link.url === 'string' ? ts.link.url : clone(ts.link);
  const wff = ts.weightedFontFamily;
  if (wff && wff.fontFamily) { st.font = wff.fontFamily; if (wff.weight && wff.weight !== 400) st.weight = wff.weight; }
  if (ts.fontSize && typeof ts.fontSize.magnitude === 'number') st.size = ts.fontSize.magnitude;
  if (rgbOf(ts.foregroundColor)) st.color = hexOf(rgbOf(ts.foregroundColor));
  if (rgbOf(ts.backgroundColor)) st.bg = hexOf(rgbOf(ts.backgroundColor));
  const script = Object.keys(SCRIPT_API).find((s) => SCRIPT_API[s] === ts.baselineOffset);
  if (script) st.script = script;
  return st;
}
function imageSpec(id, inlineObjects) {
  const io = inlineObjects && inlineObjects[id];
  const eo = (io && io.inlineObjectProperties && io.inlineObjectProperties.embeddedObject) || {};
  const size = eo.size || {};
  const pt = (d) => (d && typeof d.magnitude === 'number' ? d.magnitude : 0);
  return { id, ...(eo.title != null ? { title: eo.title } : {}), ...(eo.description != null ? { description: eo.description } : {}),
    ...(pt(size.width) ? { width: pt(size.width), height: pt(size.height) } : {}) };
}
function specParagraph(p, inlineObjects) {
  let text = '';
  const fmt = [];
  const objects = [];
  let nl = null;
  for (const el of p.elements || []) {
    if (el.textRun) {
      let content = String(el.textRun.content || '');
      const s = suggOf(el.textRun);
      if (content.endsWith('\n')) { content = content.slice(0, -1); if (Object.keys(s).length) nl = s; } // the paragraph's newline
      const st = { ...friendlyStyle(el.textRun.textStyle), ...s };
      if (content && Object.keys(st).length) fmt.push([text.length, text.length + content.length, st]);
      text += content;
      continue;
    }
    const kind = Object.keys(el).find((k) => k !== 'startIndex' && k !== 'endIndex');
    if (!kind) continue;
    const inner = el[kind] || {};
    const at = text.length;
    text += OBJ_SPEC;
    const s = suggOf(inner);
    if (kind === 'footnoteReference') { fmt.push([at, at + 1, { _fn: inner.footnoteId }]); continue; }
    // An inline object without an inlineObjects entry stays the fake's plain object (rendered with the id "kix.obj").
    if (kind === 'inlineObjectElement') { if (inlineObjects && inlineObjects[inner.inlineObjectId]) objects.push([at, { image: imageSpec(inner.inlineObjectId, inlineObjects) }]); }
    else objects.push([at, { [kind]: Object.fromEntries(Object.entries(inner).filter(([k]) => !BODY_ELEMENT_SKIP.includes(k)).map(([k, v]) => [k, clone(v)])) }]);
    if (Object.keys(s).length) fmt.push([at, at + 1, s]);
  }
  const { namedStyleType, ...ps } = p.paragraphStyle || {};
  const item = { p: text, marks: false };
  if (namedStyleType && namedStyleType !== 'NORMAL_TEXT') item.style = namedStyleType;
  if (Object.keys(ps).length) item.pstyle = clone(ps);
  if (fmt.length) item.fmt = fmt;
  if (objects.length) item.objects = objects;
  if (p.bullet && p.bullet.listId) item.bullet = { listId: p.bullet.listId, level: p.bullet.nestingLevel || 0 };
  if (nl) item.nl = nl;
  return item;
}
// The paragraphs of a cell or a table of contents (a nested table's paragraphs join them); a cell has at least one.
const contentParas = (content, io) => (content || []).flatMap((el) => (el.paragraph ? [specParagraph(el.paragraph, io)]
  : el.table ? (el.table.tableRows || []).flatMap((r) => (r.tableCells || []).flatMap((c) => contentParas(c.content, io))) : []));
function specTable(t, io) {
  const trs = t.tableRows || [];
  const it = { table: trs.map((r) => (r.tableCells || []).map((c) => { const ps = contentParas(c.content, io); return ps.length ? ps : [{ p: '', marks: false }]; })) };
  const props = (t.tableStyle && t.tableStyle.tableColumnProperties) || [];
  if (props.some((w) => w && (w.width || (w.widthType && w.widthType !== 'EVENLY_DISTRIBUTED')))) {
    it.widths = props.map((w) => (w && w.width && typeof w.width.magnitude === 'number' ? { type: w.widthType || 'FIXED_WIDTH', pt: w.width.magnitude } : { type: (w && w.widthType) || 'EVENLY_DISTRIBUTED' }));
  }
  const spans = [];
  const cellStyles = [];
  trs.forEach((r, ri) => (r.tableCells || []).forEach((c, ci) => {
    const { rowSpan = 1, columnSpan = 1, ...rest } = c.tableCellStyle || {};
    if (rowSpan !== 1 || columnSpan !== 1) spans.push([ri, ci, rowSpan, columnSpan]);
    if (Object.keys(rest).length) cellStyles.push([ri, ci, clone(rest)]);
  }));
  if (spans.length) it.spans = spans;
  if (cellStyles.length) it.cellStyles = cellStyles;
  let pinned = 0;
  while (pinned < trs.length && trs[pinned].tableRowStyle && trs[pinned].tableRowStyle.tableHeader) pinned++;
  if (pinned) it.pinned = pinned;
  return it;
}
// The items of a body (body: its first section break is the tab's sectionStyle) or a segment.
function specItems(content, io, body) {
  const items = [];
  let sectionStyle = null;
  (content || []).forEach((el, i) => {
    if (el.paragraph) items.push(specParagraph(el.paragraph, io));
    else if (el.sectionBreak) { const st = clone(el.sectionBreak.sectionStyle || {}); if (body && i === 0) sectionStyle = st; else items.push({ section: st }); }
    else if (el.table) items.push(specTable(el.table, io));
    else if (el.tableOfContents) items.push({ toc: contentParas(el.tableOfContents.content, io) });
  });
  return { items: items.length || !body ? items : [{ p: '', marks: false }], sectionStyle };
}
function specTab(t) {
  const dt = t.documentTab || {};
  const io = dt.inlineObjects || {};
  const { items, sectionStyle } = specItems((dt.body || {}).content, io, true);
  const segs = (map) => Object.fromEntries(Object.entries(map || {}).map(([id, s]) => [id, specItems(s.content, io, false).items]));
  const props = t.tabProperties || {};
  return {
    id: props.tabId || 't.0', title: props.title || '', items,
    lists: Object.fromEntries(Object.entries(dt.lists || {}).map(([id, l]) => [id, { nestingLevels: clone((l.listProperties || {}).nestingLevels || []) }])),
    headers: segs(dt.headers), footers: segs(dt.footers), footnotes: segs(dt.footnotes), documentStyle: clone(dt.documentStyle || {}),
    ...(sectionStyle ? { sectionStyle } : {}),
  };
}
function specFromBody(body, over = {}) {
  const flat = (tabs, out = []) => { for (const t of tabs || []) { out.push(t); flat(t.childTabs, out); } return out; };
  const b = body || {};
  // A body read without includeTabsContent (the legacy fields) is one tab.
  const tabs = Array.isArray(b.tabs) ? flat(b.tabs) : [{ tabProperties: { tabId: 't.0', title: '' }, documentTab: { body: b.body, lists: b.lists, headers: b.headers,
    footers: b.footers, footnotes: b.footnotes, documentStyle: b.documentStyle, inlineObjects: b.inlineObjects } }];
  return { documentId: over.documentId || b.documentId || 'DOC123', title: over.title != null ? over.title : b.title || '', tabs: tabs.map(specTab) };
}

const OC = String.fromCharCode(0xFFFC); // embedded-object placeholder
const VT = String.fromCharCode(0x0B); // soft line break
const MARK = String.fromCharCode(0x23CE); // its mark in tool output
const docSpec = (over = {}) => ({
  documentId: 'DOC123', title: 'My Doc',
  tabs: [
    { id: 't.0', title: 'Main', items: over.items || [
      { p: 'Report 📊', style: 'TITLE' },
      { p: 'Intro 😀 text.' },
      { p: 'Methods', style: 'HEADING_1' },
      { p: 'Alpha beta gamma.' },
      { p: 'Alpha beta delta.' },
      { table: [[[{ p: 'Cell A' }], [{ p: 'Cell B' }]]] },
      { p: 'Details', style: 'HEADING_2' },
      { p: 'Image ' + OC + ' done' },
      { p: 'Last line' },
    ] },
    { id: 't.second', title: 'Notes', items: [{ p: 'Second tab', style: 'HEADING_1' }, { p: 'Note text' }] },
  ],
});
const ORIGINAL = ['Report 📊', 'Intro 😀 text.', 'Methods', 'Alpha beta gamma.', 'Alpha beta delta.', 'Cell A', 'Cell B', 'Details', 'Image ' + OC + ' done', 'Last line'];
const ORIGINAL_STYLES = ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT', 'NORMAL_TEXT'];
const WRITE_SET = ['replace_text', 'replace_all', 'replace_section', 'format_text', 'format_lines', 'insert_after_line', 'delete_lines', 'edit_document', 'undo_last_edit'];

// Helpers of the write checks. ref holds the live fake server and turn snapshot of the test file
// ({ fake, as } with getters/setters); fresh() replaces both. exec = one call in its own model response.
function docsBench({ ctx, T, state }, ident, ref) {
  const routeDocs = (other) => async (url, init) => (await ref.fake.fetch(url, init)) || (other ? other(url, init) : (() => { throw new Error('unexpected fetch ' + url); })());
  const exec = (name, args, id, sameResponse) => {
    if (!sameResponse) ref.as.responseWrite = null;
    return T.executeTool({ id: id || 'w_' + name + '_' + Math.random().toString(36).slice(2, 6), function: { name, arguments: JSON.stringify(args) } }, 'edit', ref.as);
  };
  const pushTool = (r) => { state.messages.push(r); return r; };
  const fresh = async (spec) => {
    ref.fake = fakeDocsServer(spec || docSpec());
    ctx.fetch = routeDocs();
    ref.fake.token = ident.token = 'tok-1'; ident.granted = true; ident.forget();
    ref.as = T.takeSnapshot();
    const m = await T.fetchDocModel('DOC123', 't.0');
    state.docModel = m; state.docText = m.text; state.docFormat = 'docs-api'; state.selection = '';
    T.snapshotDocument(ref.as);
    state.messages = [];
  };
  const lastPost = () => ref.fake.log.filter((x) => x.method === 'POST').pop().body;
  return { routeDocs, exec, pushTool, fresh, lastPost };
}

module.exports = { fakeDocsServer, specFromBody, OC, VT, MARK, docSpec, ORIGINAL, ORIGINAL_STYLES, WRITE_SET, docsBench, CHECKBOX_GLYPH, LINK_HEX,
  registerFakeRequest, registerFakeRender, registerFakeGet, registerFakeInit, registerFakeResponse,
  // test/lib/real-docs.js builds the same document through the real API (its named styles, text styles, presets).
  DOCS_NAMED, namedOver, NAMED_TYPES, apiStyle, normPstyle, PRESET_GLYPHS };
