'use strict';
// Module named-styles.js: the document's named styles (Normal text, Heading 1–6, Title, Subtitle) against the formatting
// sheet (style-sheet.js). The tool document_styles reads them (action read) or sets them to the sheet in force (action
// apply: one batchUpdate of updateNamedStyle requests, like Docs' "Update 'Normal text' to match", so text the user types
// later follows the sheet; journal kind 'named-styles', undone by its exact inverse). They never change by themselves:
// only on the user's request, or after the model proposed it and the user agreed (ask_user). When the first write of a
// visible turn that adds or formats paragraphs finds them differing from the sheet in a document without a recorded
// Formatting line, the write's result gets one note that says so (namedStylesNote, called by executeTool after the
// write). Google never announced updateNamedStyle: a 403, or a 400 that says the request is unknown, marks it
// unavailable for the panel session (no retries); the per-paragraph sheet values of the writes stay as they are either way. Only the tab the panel reads (the
// document's first tab, or the one open in the browser) is changed.
// The page setup (the sheet's page entry: size, orientation, margins, first page number, first-page header, pageless) goes
// the same way through updateDocumentStyle: document_styles apply sets it with the named styles, action page sets the
// values of one call; undone by the exact inverse request, in the same journal entry.
/* global alignToApi, batchList, canEdit, CONTROL_WORDS, onDemandOffer, sheetRecorded, styleAsked, detectFormattingLine, dimensionPt, docsApi, DOCS_NAMED_DEFAULTS, fetchDocModel, fetchNamedStylesRaw, gateEdit,
   hasFormattingLine, namedStyleValues, NOT_UNDONE, numText, pageWords, PARA_CONTROL_KEYS, parsePageEntry, ptDimension, registerTools, registerUndoHandler,
   setSnapModel, SHEET_TYPES, state, styleSheetFor, turnNamedStyles, useDocModel, writeError */
/* exported DOCUMENT_STYLES_TOOL, DOCUMENT_STYLES_READ_TOOL, planNamedStyles, namedStylesText, namedStylesNote, undoNamedStyles, namedStylesSession, planPage, pageNow,
   fetchDocumentStyle */

// The sheet words a control is written with (CONTROL_WORDS has the synonyms too).
const CONTROL_NAMES = { 'page-break': 1, 'no-page-break': 1, 'keep-with-next': 1, 'no-keep-with-next': 1, 'keep-lines': 1, 'no-keep-lines': 1,
  'widow-control': 1, 'no-widow-control': 1 };
const NAMED_ORDER = ['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6', 'TITLE', 'SUBTITLE'];
const namedLabel = (type) => (type === 'NORMAL_TEXT' ? 'Normal text' : type === 'TITLE' ? 'Title' : type === 'SUBTITLE' ? 'Subtitle'
  : `Heading ${type.slice(-1)}`);
// Docs' own title and subtitle (DOCS_NAMED_DEFAULTS has the body and the headings).
const TITLE_DEFAULTS = { TITLE: { size: 26, spaceAbove: 0, spaceBelow: 3 }, SUBTITLE: { size: 15, spaceAbove: 0, spaceBelow: 16 } };

// The panel session's state: unavailable once Google refused the request (its message).
const namedStylesSession = { unavailable: '' };

// The values a style shows (its own, else the Normal text's, else Docs' defaults): { font, size, bold, italic, align,
// spaceAbove, spaceBelow }. nm: namedStyleValues.
function effectiveNamed(nm, type) {
  const normal = { ...DOCS_NAMED_DEFAULTS.NORMAL_TEXT, bold: false, italic: false, ...(nm.NORMAL_TEXT || {}) };
  if (type === 'NORMAL_TEXT') return normal;
  return { ...normal, spaceAbove: 0, spaceBelow: 0, ...(DOCS_NAMED_DEFAULTS[type] || TITLE_DEFAULTS[type] || {}), ...(nm[type] || {}) };
}
// Sheet words for values v ("Times New Roman 12 bold justify space 0/0 keep-with-next"); font: false leaves the font out;
// effective (a style as it shows): no "regular" / "upright", no line spacing or first line, of the controls only a page break;
// color: a colour other than black ("color #666666", document_styles read: not a sheet value).
function styleWords(v, { font = true, effective = false, color = false } = {}) {
  const w = [];
  if (font && v.font) w.push(v.font);
  if (v.size != null) w.push(numText(v.size));
  if (v.bold === true) w.push('bold'); else if (v.bold === false && !effective) w.push('regular');
  if (v.italic === true) w.push('italic'); else if (v.italic === false && !effective) w.push('upright');
  if (color && v.color && v.color !== '#000000') w.push(`color ${v.color}`);
  if (v.align) w.push(v.align);
  if (v.spaceAbove != null || v.spaceBelow != null) w.push(`space ${numText(v.spaceAbove || 0)}/${numText(v.spaceBelow || 0)}`);
  if (!effective && v.lineSpacing != null) w.push(`spacing ${numText(v.lineSpacing)}`);
  if (!effective && v.firstLine != null) w.push(`first-line ${numText(v.firstLine)}`);
  for (const [word, [f, b]] of Object.entries(CONTROL_WORDS)) {
    if (v[f] === b && CONTROL_NAMES[word] && (!effective || (f === 'pageBreakBefore' && b))) w.push(word);
  }
  return w.join(' ');
}
// The sheet's types as namedStyleTypes, in NAMED_ORDER: [[type, values]].
const sheetNamed = (sheet) => NAMED_ORDER.map((type) => {
  const k = Object.keys(SHEET_TYPES).find((x) => SHEET_TYPES[x] === type);
  const v = k && sheet && sheet.types ? sheet.types[k] : null;
  return v && Object.keys(v).length ? [type, v] : null;
}).filter(Boolean);
// A sheet entry in words, a heading's font left out when it is the body's (the sheet's own notation).
const sheetEntryWords = (sheet, type, v) => {
  const body = (sheet.types && sheet.types.body) || {};
  return styleWords(v, { font: type === 'NORMAL_TEXT' || v.font !== body.font });
};

// The changes that give one style the sheet's values v: { textStyle, paragraphStyle, tf, pf } (tf / pf: the API field
// names), empty lists when it matches. A font is written with the weight its bold implies; a style that is bold keeps
// its bold on a font change (Docs may drop bold on a weight write, as it does on text).
function typeChanges(nm, type, v, dir) {
  const cur = effectiveNamed(nm, type);
  const ts = {};
  const ps = {};
  const tf = [];
  const pf = [];
  const bold = v.bold != null ? v.bold : !!cur.bold;
  if (v.font && cur.font !== v.font) {
    ts.weightedFontFamily = { fontFamily: v.font, weight: bold ? 700 : 400 }; tf.push('weightedFontFamily');
    if (bold) { ts.bold = true; tf.push('bold'); }
  }
  if (v.size != null && cur.size !== v.size) { ts.fontSize = ptDimension(v.size); tf.push('fontSize'); }
  if (v.bold != null && !!cur.bold !== v.bold && !tf.includes('bold')) { ts.bold = v.bold; tf.push('bold'); }
  if (v.italic != null && !!cur.italic !== v.italic) { ts.italic = v.italic; tf.push('italic'); }
  if (v.align && (cur.align || 'left') !== v.align) { ps.alignment = alignToApi(v.align, dir); pf.push('alignment'); }
  for (const f of ['spaceAbove', 'spaceBelow']) if (v[f] != null && (cur[f] || 0) !== v[f]) { ps[f] = ptDimension(v[f]); pf.push(f); }
  for (const f of PARA_CONTROL_KEYS) if (v[f] != null && !!cur[f] !== v[f]) { ps[f] = v[f]; pf.push(f); }
  return { textStyle: ts, paragraphStyle: ps, tf, pf };
}
// One updateNamedStyle. The mask names namedStyleType (the reference: "at least named_style_type must be specified") and
// each leaf field: a parent ("textStyle") in the mask would reset the style's other fields (its color, for one).
function reqNamedStyle(type, textStyle, paragraphStyle, tf, pf, tabId) {
  const namedStyle = { namedStyleType: type };
  if (tf.length) namedStyle.textStyle = textStyle;
  if (pf.length) namedStyle.paragraphStyle = paragraphStyle;
  const fields = ['namedStyleType', ...tf.map((f) => `textStyle.${f}`), ...pf.map((f) => `paragraphStyle.${f}`)].join(',');
  return { updateNamedStyle: { namedStyle, fields, ...(tabId ? { tabId } : {}) } };
}
const namedDir = (raw, type) => (((raw || {})[type] || {}).paragraphStyle || {}).direction
  || (((raw || {}).NORMAL_TEXT || {}).paragraphStyle || {}).direction;
const pickFields = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(o[k]))]));

// What setting the named styles to the sheet takes: { requests, inverse (the former values: a field the style did not
// set is reset, so it inherits again), set: { type: { font, size, … } } (the values written, for undo's check),
// types: [changed types] }. raw: fetchNamedStylesRaw. The other styles inherit Normal text's alignment, so when it
// changes, a style without an alignment of its own or in the sheet gets its former one written (a heading keeps the
// alignment it has, as the sheet's rule for paragraphs says). An alignment is written in the style's direction (its
// own, else Normal text's), so "left" in a right-to-left document is END, as it was read.
function planNamedStyles(raw, sheet, tabId) {
  const nm = namedStyleValues(raw);
  const want = new Map(sheetNamed(sheet));
  const normal = effectiveNamed(nm, 'NORMAL_TEXT');
  const body = want.get('NORMAL_TEXT');
  const alignMoves = !!(body && body.align && (normal.align || 'left') !== body.align);
  const requests = [];
  const inverse = [];
  const set = {};
  const types = [];
  for (const type of NAMED_ORDER) {
    const v = want.get(type);
    const dir = namedDir(raw, type);
    const c = typeChanges(nm, type, v || {}, dir);
    if (alignMoves && type !== 'NORMAL_TEXT' && !(nm[type] && nm[type].align) && !(v && v.align)) {
      c.paragraphStyle.alignment = alignToApi(normal.align || 'left', dir); c.pf.push('alignment');
    }
    if (!c.tf.length && !c.pf.length) continue;
    const own = raw[type] || {};
    requests.push(reqNamedStyle(type, c.textStyle, c.paragraphStyle, c.tf, c.pf, tabId));
    inverse.push(reqNamedStyle(type, pickFields(own.textStyle, c.tf), pickFields(own.paragraphStyle, c.pf), c.tf, c.pf, tabId));
    set[type] = namedStyleValues({ [type]: { textStyle: pickFields(c.textStyle, c.tf), paragraphStyle: pickFields(c.paragraphStyle, c.pf) } })[type];
    types.push(type);
  }
  return { requests, inverse, set, types };
}

// The sheet in force as one Formatting line, and where it comes from.
function sheetLine(sheet) {
  const entries = Object.keys(SHEET_TYPES).filter((k) => sheet.types[k] && Object.keys(sheet.types[k]).length)
    .map((k) => `${k} ${sheetEntryWords(sheet, SHEET_TYPES[k], sheet.types[k])}`.trim());
  if (sheet.page) entries.push(`page ${pageWords(sheet.page)}`);
  return `Formatting: ${entries.join('; ')} (${sheet.source === 'default' ? 'the default' : `from ${sheet.source}`})`;
}
// The styles the sheet names, compared: [{ type, v (the sheet's values), now (the values the style shows), differs }].
function namedComparison(raw, sheet) {
  const nm = namedStyleValues(raw);
  return sheetNamed(sheet).map(([type, v]) => {
    const c = typeChanges(nm, type, v, namedDir(raw, type));
    return { type, v, now: effectiveNamed(nm, type), differs: !!(c.tf.length || c.pf.length) };
  });
}
// The read action's text: one line per style with the values it shows (its colour when not black: a heading's grey),
// " (differs)" where the sheet would change it, then the sheet in force once (its entries are what a differing style would
// get). ds: the documentStyle (fetchDocumentStyle), or undefined to leave the page line out.
function namedStylesText(raw, sheet, ds) {
  const nm = namedStyleValues(raw);
  const cmp = new Map(namedComparison(raw, sheet).map((x) => [x.type, x]));
  const lines = NAMED_ORDER.map((type) => {
    const c = cmp.get(type);
    return `${namedLabel(type)}: ${styleWords(effectiveNamed(nm, type), { effective: true, color: true })}${c && c.differs ? ' (differs)' : ''}`;
  });
  if (ds !== undefined) {
    const differs = sheet.page && planPage(ds || {}, sheet.page).fields.length;
    lines.push(`Page: ${pageWords(pageNow(ds || {}))}${differs ? ' (differs)' : ''}`);
  }
  return `${lines.join('\n')}\nSheet in force: ${sheetLine(sheet)}`;
}
const changedText = (sheet, types) => types.filter((t) => new Map(sheetNamed(sheet)).has(t)).map((t) => `${namedLabel(t)}: ${sheetEntryWords(sheet, t, new Map(sheetNamed(sheet)).get(t))}`).join('; ');

// ---- Page setup -------------------------------------------------------------------------------------------
// The documentStyle fields the page setup reads and writes (the model's own read takes documentStyle whole, but keeps only
// the header and footer ids, so the page setup has its own small documents.get).
const PAGE_FIELDS = 'pageSize,flipPageOrientation,marginTop,marginBottom,marginLeft,marginRight,marginHeader,marginFooter,pageNumberStart,useFirstPageHeaderFooter,documentFormat';
const MARGIN_KEYS = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHeader', 'marginFooter'];
// Docs' values where documentStyle sets none: Letter, 1 inch margins, header and footer 0.5 inch, numbering from 1.
const PAGE_DEFAULTS = { w: 612, h: 792, marginTop: 72, marginBottom: 72, marginLeft: 72, marginRight: 72, marginHeader: 36, marginFooter: 36, pageNumberStart: 1 };
const PAGE_FIELD_WORDS = { pageSize: 'page size', flipPageOrientation: 'orientation', marginTop: 'top margin', marginBottom: 'bottom margin',
  marginLeft: 'left margin', marginRight: 'right margin', marginHeader: 'header margin', marginFooter: 'footer margin',
  pageNumberStart: 'first page number', useFirstPageHeaderFooter: 'first-page header', documentFormat: 'pageless mode' };
const LEN_EPS = 0.05; // pt: the sheet rounds to 0.01 pt; Docs' A4 is 595.2756 pt
// The documentStyle of the tab the panel reads ({} when the tab has none).
async function fetchDocumentStyle(docId, tabId) {
  const tab = (d) => `tabProperties(tabId),documentTab(documentStyle(${PAGE_FIELDS}))` + (d > 1 ? `,childTabs(${tab(d - 1)})` : '');
  const doc = await docsApi(`${encodeURIComponent(docId)}?includeTabsContent=true&fields=${encodeURIComponent(`tabs(${tab(3)})`)}`);
  const flat = [];
  const walk = (ts) => { for (const t of ts || []) { flat.push(t); walk(t.childTabs); } };
  walk(doc && doc.tabs);
  const t = flat.find((x) => x.tabProperties && x.tabProperties.tabId === tabId) || flat[0];
  return (t && t.documentTab && t.documentTab.documentStyle) || {};
}
// The page setup a documentStyle shows, as a page value (parsePageEntry's shape; size in portrait order, the orientation
// from the size and flipPageOrientation together, a first-page header and pageless only when on).
function pageNow(ds) {
  const len = (x, def) => (x ? dimensionPt(x) : def);
  const ps = ds.pageSize || {};
  const w = len(ps.width, PAGE_DEFAULTS.w);
  const h = len(ps.height, PAGE_DEFAULTS.h);
  const v = { size: { w: Math.min(w, h), h: Math.max(w, h) }, orientation: (w > h) !== !!ds.flipPageOrientation ? 'landscape' : 'portrait' };
  for (const k of MARGIN_KEYS) v[k] = len(ds[k], PAGE_DEFAULTS[k]);
  v.pageNumberStart = typeof ds.pageNumberStart === 'number' ? ds.pageNumberStart : PAGE_DEFAULTS.pageNumberStart;
  if (ds.useFirstPageHeaderFooter) v.useFirstPageHeaderFooter = true;
  if (ds.documentFormat && ds.documentFormat.documentMode === 'PAGELESS') v.documentMode = 'PAGELESS';
  return v;
}
const copyOf = (o) => JSON.parse(JSON.stringify(o));
// What gives the document the page value want: { request (one updateDocumentStyle, null when nothing differs), inverse
// (the former values of the same fields; one the document did not set is reset), fields (API names), check (the values
// of want the request writes, for undo's check) }. A size that changes is written in portrait order with
// flipPageOrientation for landscape; an orientation alone flips the page; a size without an orientation keeps the
// document's orientation.
function planPage(ds, want, tabId) {
  const now = pageNow(ds);
  const ps = ds.pageSize || {};
  const rawW = ps.width ? dimensionPt(ps.width) : PAGE_DEFAULTS.w;
  const rawH = ps.height ? dimensionPt(ps.height) : PAGE_DEFAULTS.h;
  const flip = !!ds.flipPageOrientation;
  const orient = want.orientation || now.orientation;
  const out = {};
  const inv = {};
  const fields = [];
  const check = {};
  let tw = rawW; let th = rawH; let tflip = flip;
  const sameSize = !want.size || (Math.abs(now.size.w - want.size.w) < 1 && Math.abs(now.size.h - want.size.h) < 1);
  if (!sameSize) { tw = want.size.w; th = want.size.h; tflip = orient === 'landscape'; } else if (orient !== now.orientation) tflip = !flip;
  if (tw !== rawW || th !== rawH) {
    out.pageSize = { width: ptDimension(tw), height: ptDimension(th) }; fields.push('pageSize');
    if (ds.pageSize) inv.pageSize = copyOf(ds.pageSize);
    check.size = want.size;
  }
  if (tflip !== flip) { out.flipPageOrientation = tflip; if (ds.flipPageOrientation != null) inv.flipPageOrientation = flip; fields.push('flipPageOrientation'); }
  if (fields.length) check.orientation = orient;
  for (const k of MARGIN_KEYS) {
    if (want[k] == null || Math.abs(now[k] - want[k]) <= LEN_EPS) continue;
    out[k] = ptDimension(want[k]); fields.push(k); check[k] = want[k];
    if (ds[k]) inv[k] = copyOf(ds[k]);
  }
  if (want.pageNumberStart != null && now.pageNumberStart !== want.pageNumberStart) {
    out.pageNumberStart = want.pageNumberStart; fields.push('pageNumberStart'); check.pageNumberStart = want.pageNumberStart;
    if (typeof ds.pageNumberStart === 'number') inv.pageNumberStart = ds.pageNumberStart;
  }
  if (want.useFirstPageHeaderFooter != null && !!ds.useFirstPageHeaderFooter !== want.useFirstPageHeaderFooter) {
    out.useFirstPageHeaderFooter = want.useFirstPageHeaderFooter;
    if (ds.useFirstPageHeaderFooter != null) inv.useFirstPageHeaderFooter = !!ds.useFirstPageHeaderFooter;
    fields.push('useFirstPageHeaderFooter'); check.useFirstPageHeaderFooter = want.useFirstPageHeaderFooter;
  }
  if (want.documentMode && (now.documentMode || 'PAGES') !== want.documentMode) {
    out.documentFormat = { documentMode: want.documentMode }; fields.push('documentFormat'); check.documentMode = want.documentMode;
    inv.documentFormat = ds.documentFormat ? copyOf(ds.documentFormat) : { documentMode: 'PAGES' };
  }
  const req = (documentStyle) => ({ updateDocumentStyle: { documentStyle, fields: fields.join(','), ...(tabId ? { tabId } : {}) } });
  return { request: fields.length ? req(out) : null, inverse: fields.length ? req(inv) : null, fields, check };
}
const pageMissNote = (fields) => (fields.length ? `\nNote: Google Docs did not apply all of the page setup; the ${fields.map((f) => PAGE_FIELD_WORDS[f] || f).join(', ')} still ${fields.length === 1 ? 'differs' : 'differ'}. Check with document_styles read.` : '');
// The model read again after a write that moved the revision (the next write would otherwise find it stale).
async function rereadModel(snap) {
  const m = snap.model;
  try {
    const model = await fetchDocModel(m.docId, m.tabId);
    setSnapModel(snap, model);
    useDocModel(model);
  } catch (e) { /* the next write finds the revision moved and reports the current text */ }
}
// Sends the page plan for want, verifies it by reading documentStyle again. A request Docs refuses (HTTP 400) while it
// sets the pageless mode is sent again without it, with a note (the mode is not known to be writable). Returns { plan
// (the plan that was applied), note } or throws.
async function sendPage(snap, ds, want, plan) {
  const m = snap.model;
  const post = (p) => docsApi(`${encodeURIComponent(m.docId)}:batchUpdate`, { method: 'POST', body: { requests: [p.request] } });
  let note = '';
  try { await post(plan); } catch (e) {
    if (e.network || e.preSend || e.status !== 400 || !plan.fields.includes('documentFormat')) throw e;
    const why = String(e.serverMessage || e.message || '').slice(0, 160);
    const mode = want.documentMode === 'PAGELESS' ? 'pageless' : 'pages';
    const msg = `Google Docs did not accept the ${mode} setting (${why}); the user can switch it in File > Page setup`;
    const rest = { ...want };
    delete rest.documentMode;
    plan = planPage(ds, rest, m.tabId);
    if (!plan.fields.length) { const err = new Error(msg); err.pageless = true; throw err; }
    await post(plan);
    note = `\nNote: ${msg}.`;
  }
  await rereadModel(snap);
  let miss = [];
  try { miss = planPage(await fetchDocumentStyle(m.docId, m.tabId), plan.check, m.tabId).fields; } catch (e) { /* not verified */ }
  return { plan, note: note + pageMissNote(miss) };
}
// document_styles page (runs under the write lock): the page setup of one call, in the sheet's page words.
async function pageTool(name, args, snap, ui, id) {
  const text = String((args && args.page) || '').trim();
  if (!text) return writeError('page needs the page setup in the formatting sheet\'s words, e.g. "A4 landscape margins 2.5 cm"', 'document_styles: no page given');
  const parsed = parsePageEntry(text.replace(/^page\s+/i, ''));
  if (parsed.error) return writeError(parsed.error.replace(/^"page /, '"'), 'document_styles: invalid page');
  const want = parsed.value;
  const m = snap.model;
  const ds = await fetchDocumentStyle(m.docId, m.tabId);
  const plan = planPage(ds, want, m.tabId);
  const words = pageWords(want);
  if (!plan.fields.length) return { content: `No change: the page setup is already ${words}.`, _ok: true, _message: 'No change: page setup' };
  const summary = `Page: ${words}`;
  const gp = { region: [1, 1], journal: { kind: 'named-styles' }, summary };
  const refused = await gateEdit(name, gp, snap, ui);
  if (refused) return refused;
  let res;
  try { res = await sendPage(snap, ds, want, plan); } catch (e) {
    return writeError(e.pageless ? e.message : `the page setup was not changed: ${e.message}. Check it with document_styles read.`, 'Page setup not changed: ' + e.message);
  }
  return {
    content: `Done: set the page setup (${words}).${res.note}`, _ok: true, _message: PAGE_TITLE,
    _edit: { ...namedJournal(id, m, { set: {}, inverse: [] }), title: PAGE_TITLE, page: { inverse: res.plan.inverse, check: res.plan.check } },
    _cardText: summary, _cardLabel: 'Page',
  };
}
const PAGE_TITLE = 'Set the page setup';

// ---- Writing --------------------------------------------------------------------------------------------------
// Whether a failed request means Google does not take updateNamedStyle here: not permitted (403), or a 400 whose message
// says the request or a field of it is unknown to the API. Any other 400 (a malformed request of ours, a value Docs
// refuses) is an ordinary error and leaves the request available.
const UNKNOWN_REQUEST_RE = /Unknown name|Invalid JSON payload|Cannot find field/i;
const refusedByGoogle = (e) => !!e && !e.network && !e.preSend
  && (e.status === 403 || (e.status === 400 && UNKNOWN_REQUEST_RE.test(String(e.serverMessage || e.message || ''))));
const UNAVAILABLE_TAIL = 'The sheet is still applied to each paragraph the assistant writes.';
const unavailableText = (why) => `Not available: Google Docs did not accept the named-style update (${why}). ${UNAVAILABLE_TAIL}`;
// Sends a plan and reads the document again (the revision moved; the text did not). No writeControl: a named style has
// no index that a concurrent edit could move. Returns { model, miss: [labels still differing] } or throws.
async function sendNamedStyles(snap, plan, sheet) {
  const m = snap.model;
  try {
    await docsApi(`${encodeURIComponent(m.docId)}:batchUpdate`, { method: 'POST', body: { requests: plan.requests } });
  } catch (e) {
    if (refusedByGoogle(e)) namedStylesSession.unavailable = String(e.serverMessage || e.message).slice(0, 200);
    throw e;
  }
  await rereadModel(snap);
  let miss = [];
  try {
    const raw = await fetchNamedStylesRaw(m.docId, m.tabId);
    snap.namedRaw = { key: `${m.docId}|${m.tabId || ''}`, raw }; // the turn's later writes compare with the new styles
    miss = planNamedStyles(raw, sheet, m.tabId).types.map(namedLabel);
  } catch (e) { snap.namedRaw = null; /* not verified */ }
  return { miss };
}
const missNote = (miss) => (miss.length ? `\nNote: Google Docs did not apply all of it; ${miss.join(', ')} still ${miss.length === 1 ? 'differs' : 'differ'}. Check with document_styles read.` : '');
const NAMED_TITLE = 'Set the document styles to the formatting sheet';
const namedJournal = (id, m, plan) => ({ id, docId: m.docId, tabId: m.tabId, kind: 'named-styles', set: plan.set, requests: plan.inverse,
  title: NAMED_TITLE, undone: false, anchor: false });

// document_styles apply (runs under the write lock, runExtraTool): the named styles, then the sheet's page entry (a
// batch of its own, so a refused page setup leaves the styles set and says so). One journal entry for both.
async function applyNamedStylesTool(name, snap, ui, id) {
  const m = snap.model;
  const sheet = styleSheetFor(snap);
  const unavailable = namedStylesSession.unavailable;
  if (unavailable && !sheet.page) return { content: unavailableText(unavailable), _ok: false, _message: 'Named styles not available' };
  const plan = unavailable ? { requests: [], inverse: [], set: {}, types: [] } : planNamedStyles(await fetchNamedStylesRaw(m.docId, m.tabId), sheet, m.tabId);
  const ds = sheet.page ? await fetchDocumentStyle(m.docId, m.tabId) : null;
  const page = sheet.page ? planPage(ds, sheet.page, m.tabId) : null;
  const pageOn = !!(page && page.fields.length);
  if (!plan.types.length && !pageOn) {
    if (unavailable) return { content: `No change: the page setup already follows the formatting sheet.\nNote: ${unavailableText(unavailable)}`, _ok: true, _message: 'No change: page setup' };
    return { content: 'No change: the document\'s styles already follow the formatting sheet.', _ok: true, _message: 'No change: document styles' };
  }
  const pageText = pageOn ? `Page: ${pageWords(sheet.page)}` : '';
  const summary = [changedText(sheet, plan.types), pageText].filter(Boolean).join('; ');
  plan.region = [1, 1];
  plan.journal = { kind: 'named-styles' };
  plan.summary = summary;
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  let res = { miss: [] };
  if (plan.types.length) {
    try { res = await sendNamedStyles(snap, plan, sheet); } catch (e) {
      if (refusedByGoogle(e)) return { content: unavailableText(namedStylesSession.unavailable), _ok: false, _message: 'Named styles not available' };
      return writeError(`the named styles were not changed: ${e.message}. Check them with document_styles read; if apply fails again, tell the user (the paragraphs the assistant writes still get the sheet).`,
        'Document styles not changed: ' + e.message);
    }
  }
  let pageRes = null;
  let pageNote = '';
  if (pageOn) {
    try { pageRes = await sendPage(snap, ds, sheet.page, page); pageNote = pageRes.note; } catch (e) {
      if (!plan.types.length) return writeError(e.pageless ? e.message : `the page setup was not changed: ${e.message}. Check it with document_styles read.`, 'Page setup not changed: ' + e.message);
      pageNote = `\nNote: the page setup was not changed: ${e.message}.`;
    }
  }
  const done = [plan.types.length ? changedText(sheet, plan.types) : '', pageRes ? pageText : ''].filter(Boolean).join('; ');
  const edit = namedJournal(id, m, plan);
  if (pageRes) edit.page = { inverse: pageRes.plan.inverse, check: pageRes.plan.check };
  return {
    content: `Done: set the document's ${plan.types.length ? 'styles' : 'page setup'} to the formatting sheet (${done}).${missNote(res.miss)}${pageNote}${unavailable ? `\nNote: ${unavailableText(unavailable)}` : ''}`,
    _ok: true, _message: NAMED_TITLE, _edit: edit, _cardText: done, _cardLabel: 'Styles',
  };
}

// The note after a successful write r of tool name in a visible main-chat turn (executeTool): when the document has no
// formatting of its own (no Formatting line in DOC.md, and the first-run measure, detectFormattingLine, finds none to
// record: a short or new document, a numbers entry alone does not count) and its named styles differ from the sheet,
// the result gets one line, once per turn
// (snap.namedStylesNoted), so the model can ask the user before document_styles apply. The styles themselves are never
// changed here. The named styles come from the turn's read (turnNamedStyles: one documents.get per turn). Only a write
// that puts the formatting sheet on paragraphs gets it (sheetWrite: new paragraphs, formatted lines); after a replace or
// a text-only format the difference does not show, and the note would invite a pointless question about styles.
async function namedStylesNote(name, r, snap, args) {
  try { await namedStylesNoteNow(name, r, snap, args); } catch (e) { /* best effort: the write's own result stands */ }
}
const NOTE_TAIL = 'Do not change them unasked; if the user may want them aligned, ask with ask_user first, then document_styles apply.';
// The writes that give paragraphs the sheet's values: an insert (an outline too), a section rewritten with text,
// format_lines (a style, apply_sheet, numbers, alignment, spacing), and edit_document with such an operation.
const SHEET_OPS = ['insert', 'format_lines', 'number_headings'];
function sheetWrite(name, args) {
  const a = args || {};
  if (name === 'insert_after_line' || name === 'format_lines') return true;
  if (name === 'replace_section') return typeof a.new_text === 'string' && !!a.new_text.trim();
  return name === 'edit_document' && (batchList(a.operations) || []).some((e) => e && SHEET_OPS.includes(String(e.op || '').trim().toLowerCase()));
}
async function namedStylesNoteNow(name, r, snap, args) {
  if (!r || !r._ok || !r._edit || typeof r.content !== 'string' || !sheetWrite(name, args)) return;
  if (!snap || !snap.readFirst || snap.agent || snap.side || snap.namedStylesNoted || namedStylesSession.unavailable || snap.docFormat !== 'docs-api') return;
  const m = snap.model;
  if (!m || !m.docId) return;
  const doc = snap.docInstructions != null ? snap.docInstructions : state.docInstructions;
  if (hasFormattingLine(doc)) return;
  const raw = await turnNamedStyles(snap);
  if (!raw) return;
  snap.namedStylesNoted = true;
  const main = snap.mainInstructions != null ? snap.mainInstructions : state.mainInstructions;
  const own = detectFormattingLine(m, namedStyleValues(raw), main);
  if (own && !/^Formatting: numbers\b[^;]*$/.test(own)) return;
  const diff = namedComparison(raw, styleSheetFor(snap)).filter((x) => x.differs);
  if (!diff.length) return;
  const first = `${namedLabel(diff[0].type)}: ${styleWords(diff[0].now, { effective: true })}`;
  const more = diff.length > 1 ? `; ${diff.length - 1} more` : '';
  r.content += `\nNote: the document's ${NOTE_MARK} (${first}${more}). ${NOTE_TAIL}`;
}

// ---- Undo -------------------------------------------------------------------------------------------------------
// The former values come back exactly, while every style still has the values the edit wrote (a style the user
// changed since in Docs is not overwritten). Text edits since do not matter.
// The page setup (edit.page: { inverse, check }) the same way: refused when the document's page setup no longer has the
// values the edit wrote; both go back in one batch.
async function undoNamedStyles(edit) {
  const types = Object.keys(edit.set || {});
  if (types.length) {
    const now = namedStyleValues(await fetchNamedStylesRaw(edit.docId, edit.tabId));
    const changed = Object.entries(edit.set || {}).filter(([type, v]) => Object.entries(v).some(([k, x]) => (now[type] || {})[k] !== x)).map(([t]) => namedLabel(t));
    if (changed.length) throw new Error(`the named style${changed.length === 1 ? '' : 's'} ${changed.join(', ')} changed after that edit, ${NOT_UNDONE}`);
  }
  if (edit.page && planPage(await fetchDocumentStyle(edit.docId, edit.tabId), edit.page.check, edit.tabId).fields.length) {
    throw new Error(`the page setup changed after that edit, ${NOT_UNDONE}`);
  }
  const requests = [...(edit.requests || []), ...(edit.page && edit.page.inverse ? [edit.page.inverse] : [])];
  if (!requests.length) throw new Error('there is nothing to undo for that edit.');
  await docsApi(`${encodeURIComponent(edit.docId)}:batchUpdate`, { method: 'POST', body: { requests } });
  if (types.length) try { await fetchNamedStylesRaw(edit.docId, edit.tabId); } catch (e) { /* the header's fallback only */ }
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const what = [types.length ? `the document's named styles (${types.map(namedLabel).join(', ')})` : '', edit.page ? 'the page setup' : ''].filter(Boolean).join(' and ');
  return { model, restored: '', lostObjects: false, range: [1, 1], what: `restored ${what}` };
}
registerUndoHandler('named-styles', undoNamedStyles);

// ---- The tool ---------------------------------------------------------------------------------------------------
const DOCUMENT_STYLES_TOOL = { type: 'function', function: {
  name: 'document_styles',
  description: 'The document\'s named styles (Normal text, Heading 1-6, Title, Subtitle) and page setup. read: as they are now. apply: set them to the formatting sheet (one edit; Undo restores); only if the user asked or agreed in ask_user. page: set the page setup given in page ("A4 landscape, margins 2 cm, first page number 3, pageless").',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['read', 'apply', 'page'] }, page: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    required: ['action', 'page'],
    additionalProperties: false,
  },
} };
// Plan and the read-only chat turn (registerTools defsFor): read only.
const DOCUMENT_STYLES_READ_TOOL = { type: 'function', function: {
  name: 'document_styles',
  description: 'The document\'s named styles (Normal text, Heading 1-6, Title, Subtitle) and page setup as they are now, against the formatting sheet.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read'] } }, required: ['action'], additionalProperties: false },
} };
async function runDocumentStyles(name, args, snap, ui, call) {
  const action = String(args && args.action);
  if (action === 'read') {
    const m = snap.model;
    let ds = null;
    try { ds = await fetchDocumentStyle(m.docId, m.tabId); } catch (e) { ds = undefined; /* the styles still answer */ }
    return namedStylesText(await fetchNamedStylesRaw(m.docId, m.tabId), styleSheetFor(snap), ds);
  }
  if (action === 'page') return pageTool(name, args, snap, ui, call.id);
  if (action !== 'apply') return writeError('action must be "read", "apply" or "page"', 'document_styles: invalid action');
  return applyNamedStylesTool(name, snap, ui, call.id);
}
// On demand on Munin and custom servers (request.js onDemandOffer): when the message is about formatting or the page
// setup, MAIN.md or DOC.md has a Formatting: line, or the named-styles note was given in this turn or the one before (the
// user's "yes" to aligning the styles must find the tool).
const PAGE_SETUP_RE = /\b(?:pages?|landscape|portrait|margins?|a4|letter|pageless)\b|страниц|альбомн|книжн|пол[яей]\b/i;
const NOTE_MARK = 'named styles differ from the formatting sheet';
function namedNoteRecent(snap) {
  if (snap.namedStylesNoted) return true;
  const msgs = (snap.chatCtx && snap.chatCtx.messages) || [];
  let users = 0;
  for (let i = msgs.length - 1; i >= 0 && users < 2; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && !m._auto) users++;
    else if (m && m.role === 'tool' && typeof m.content === 'string' && m.content.includes(NOTE_MARK)) return true;
  }
  return false;
}
const namedStylesRuns = (mode, snap) => !!snap && snap.docFormat === 'docs-api' && !!snap.model && !!snap.model.docId;
registerTools(DOCUMENT_STYLES_TOOL, {
  // Wherever the document was read through the Docs API (read-only agents and Plan too: apply is a writing call, refused
  // outside an editing turn like every write).
  offer: (mode, snap) => namedStylesRuns(mode, snap) &&
    onDemandOffer(snap, (t) => styleAsked(t) || PAGE_SETUP_RE.test(t), sheetRecorded(snap) || namedNoteRecent(snap)),
  runs: namedStylesRuns,
  defsFor: (mode) => [canEdit(mode) ? DOCUMENT_STYLES_TOOL : DOCUMENT_STYLES_READ_TOOL],
  reading: (name, args) => !args || !['apply', 'page'].includes(args.action),
  pending: 'Setting the document styles…',
  summary: (name, args) => (args && args.action === 'apply' ? 'apply the formatting sheet' : args && args.action === 'page' ? `page ${String(args.page || '').slice(0, 60)}` : 'read'),
  // A document-wide formatting change like format_lines apply_sheet, undone from the panel (kind 'named-styles'): the
  // card asks in Manual only (the model asks the user before apply: a tool and prompt rule, not this gate).
  gate: (name, plan) => ({ what: 'changes the document\'s named styles or page setup', range: 'Named styles', excerptLabel: 'Styles', excerpt: (plan && plan.summary) || '' }),
  run: runDocumentStyles,
});
