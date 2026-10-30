'use strict';
// The fake Google Docs API server (fakeDocsServer), the standard test document (docSpec, ORIGINAL,
// ORIGINAL_STYLES) and docsBench: the helpers of the write checks (fresh document, one tool call, ...).

// Tiny in-memory Google Docs API: tabs with paragraphs ({p, style, suggest}) and tables
// ({table: [[cellParas, ...], ...]}). documents.get renders JSON with consistent UTF-16 indices (body
// starts at 1 after the section break; a table, each row and each cell take one index; paragraphs end
// with "\n"). An inline object is written "￼" in the spec and kept internally as OBJ (a private-use
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
// italic, underline, link, font, weight, size, color, bg} with only the set keys, or undefined for plain;
// missing entries are plain); a spec item gives it as fmt: [[s, e, {bold: true, link: 'https://...',
// size: 14, font: 'Arial', color: '#FF0000'}], ...] (offsets in p; colors as #RRGGBB; link: a URL or a raw
// link object such as {headingId}; weight only when not 400). The paragraph newline is always plain:
// updateTextStyle skips it, so its indices stay those of the text. documents.get emits one textRun per
// stretch of equal style in API shapes (an unformatted paragraph: one run with textStyle {}, as before; a
// styled inline object gets inlineObjectElement.textStyle); inserted text is plain; updateTextStyle sets
// the listed fields (a field listed but absent from textStyle is reset). Setting a link also underlines
// the text and colors it LINK_HEX, as Docs does (srv.linkAutoStyle, default true; spec.linkAutoStyle: false).
// Paragraph style: p.style (namedStyleType) and p.pstyle (alignment, lineSpacing, direction, and
// Dimensions for indentStart / indentFirstLine / spaceAbove / spaceBelow; a spec item's pstyle may give
// dimensions as numbers of points); updateParagraphStyle sets or resets the listed fields.
// Lists: p.bullet = {listId, level} and per tab lists {id: {preset, nestingLevels}} (spec: an item's
// bullet: {listId, level, preset}; a tab's lists: {id: preset or {nestingLevels}}). createParagraphBullets
// removes the leading tabs of each paragraph (their count is the nesting level), joins the list of the
// paragraph right before the range when it has the same preset, and sets the level's indents;
// deleteParagraphBullets removes the bullet and keeps the level's indent as a plain indent. Rendered as
// paragraph.bullet {listId, nestingLevel (left out at 0, as the API does)} and documentTab.lists.
// Tables: { table: rows, widths?: [{ type, pt }], spans?: [[r, c, rowSpan, colSpan]] } render with columns,
// tableStyle.tableColumnProperties (EVENLY_DISTRIBUTED per column unless widths) and tableCellStyle (spans);
// insertTable (location or endOfSegmentLocation, body or header/footer; refused in a footnote or a cell) splits
// the paragraph at the index: the table starts at index + 1 and an empty paragraph follows it (Docs' layout).
// A table of contents: { toc: [items] } renders as tableOfContents (one index for the element, then its
// paragraphs; not editable; the real index layout is unverified).
// Segments (per tab): spec headers / footers / footnotes: { id: items } and documentStyle ({ defaultHeaderId, … };
// the first header / footer is the default one when not given). A footnote mark is written "[^id]" in a body
// paragraph (one index, rendered as footnoteReference { footnoteId, footnoteNumber } numbered in reading order;
// a footnote whose mark is deleted is no longer rendered). Segment content starts at index 0. Every request
// takes segmentId in its range / location; createFootnote (body only; content " \n"), createHeader /
// createFooter (DEFAULT; 400 when one exists), deleteHeader / deleteFooter; replies carry the new IDs.
// Plugins (one file per feature under test/lib/): registerFakeRequest(name, handler(body, api) -> reply),
// registerFakeRender(fn(srv, doc, includeTabs)) to add to a documents.get response, registerFakeGet(fn(srv, url,
// params, api) -> response | null) to answer a GET first, registerFakeInit(fn(srv, spec)); srv.onShift
// listeners (tabId, segmentId, index, delta) hear every text insertion and deletion. api: see fakeApi below.
const OBJ = '';
const LINK_HEX = '#1155CC';
// How the fake renders a checklist nesting level (no glyphSymbol, no numeric glyphType). What real Docs
// returns for BULLET_CHECKBOX is still to be confirmed in Chrome; change it here only.
const CHECKBOX_GLYPH = { glyphType: 'GLYPH_TYPE_UNSPECIFIED' };
const PRESET_GLYPHS = {
  BULLET_DISC_CIRCLE_SQUARE: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }, { glyphSymbol: '■' }],
  NUMBERED_DECIMAL_ALPHA_ROMAN: [{ glyphType: 'DECIMAL', glyphFormat: '%0.' }, { glyphType: 'ALPHA', glyphFormat: '%1.' }, { glyphType: 'ROMAN', glyphFormat: '%2.' }],
  BULLET_CHECKBOX: [CHECKBOX_GLYPH],
};
const presetGlyphs = (preset) => PRESET_GLYPHS[preset] || (/^NUMBERED_/.test(preset) ? PRESET_GLYPHS.NUMBERED_DECIMAL_ALPHA_ROMAN
  : /CHECKBOX/.test(preset) ? PRESET_GLYPHS.BULLET_CHECKBOX : /^BULLET_/.test(preset) ? PRESET_GLYPHS.BULLET_DISC_CIRCLE_SQUARE : null);
const dim = (n) => ({ magnitude: n, unit: 'PT' });
// Nine nesting levels like Docs: 36 pt per level, a hanging first line 18 pt left of the text.
const nestingLevels = (preset) => Array.from({ length: 9 }, (_, l) => ({ ...presetGlyphs(preset)[l % presetGlyphs(preset).length],
  indentFirstLine: dim(18 + 36 * l), indentStart: dim(36 + 36 * l) }));
const TEXT_FIELDS = ['bold', 'italic', 'underline', 'link', 'weightedFontFamily', 'fontSize', 'foregroundColor', 'backgroundColor',
  'strikethrough', 'smallCaps', 'baselineOffset']; // the last three are valid but not modelled
const PARA_FIELDS = ['namedStyleType', 'alignment', 'lineSpacing', 'direction', 'spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine',
  'indentEnd', 'spacingMode', 'keepLinesTogether', 'keepWithNext', 'avoidWidowAndOrphan', 'pageBreakBefore'];
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
  for (const k of ['bold', 'italic', 'underline']) if (st[k]) textStyle[k] = true;
  if (st.link) textStyle.link = typeof st.link === 'string' ? { url: st.link } : clone(st.link);
  if (st.font) textStyle.weightedFontFamily = { fontFamily: st.font, weight: st.weight || 400 };
  if (st.size != null) textStyle.fontSize = dim(st.size);
  if (st.color) textStyle.foregroundColor = apiColorOf(st.color);
  if (st.bg) textStyle.backgroundColor = apiColorOf(st.bg);
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
    return;
  }
  if (k === 'fontSize') { if (has && v && typeof v.magnitude === 'number') st.size = v.magnitude; else delete st.size; return; }
  const key = k === 'foregroundColor' ? 'color' : k === 'backgroundColor' ? 'bg' : null;
  if (key) { if (has && v && v.color && v.color.rgbColor) st[key] = hexOf(v.color.rgbColor); else delete st[key]; }
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
const PLUGINS = { requests: {}, renders: [], gets: [], inits: [] };
const registerFakeRequest = (name, handler) => { PLUGINS.requests[name] = handler; };
const registerFakeRender = (fn) => { PLUGINS.renders.push(fn); };
const registerFakeGet = (fn) => { PLUGINS.gets.push(fn); };
const registerFakeInit = (fn) => { PLUGINS.inits.push(fn); };
const FN_MARK_RE = /\[\^([^\]]+)\]/g; // a footnote mark in a spec paragraph
const SEGMENT_KEYS = { header: 'headers', footer: 'footers', footnote: 'footnotes' };

function fakeDocsServer(spec) {
  const srv = {
    documentId: spec.documentId, title: spec.title, revision: 1, token: 'tok-1', log: [], failNext: null, failReads: 0, listSeq: 0,
    linkAutoStyle: spec.linkAutoStyle !== false, segSeq: 0, onShift: [],
  };
  const para = (c, lists) => {
    // "[^id]" footnote marks become one object character whose char style carries the footnote ID (fmt offsets
    // count the mark as one character).
    const marks = [];
    let src = '';
    let last = 0;
    for (const m of c.p.matchAll(FN_MARK_RE)) { src += c.p.slice(last, m.index); marks.push([src.length, m[1]]); src += OBJ; last = m.index + m[0].length; }
    src += c.p.slice(last);
    const text = src.split('￼').join(OBJ);
    const chars = Array(text.length).fill(undefined);
    for (const [s, e, st] of c.fmt || []) for (let i = s; i < e; i++) chars[i] = { ...chars[i], ...st };
    for (const [at, id] of marks) chars[at] = { ...chars[at], _fn: id };
    let bullet = null;
    if (c.bullet) {
      bullet = { listId: c.bullet.listId, level: c.bullet.level || 0 };
      if (!lists[bullet.listId]) { const preset = c.bullet.preset || 'BULLET_DISC_CIRCLE_SQUARE'; lists[bullet.listId] = { preset, nestingLevels: nestingLevels(preset) }; }
    }
    return { text, style: c.style || 'NORMAL_TEXT', suggest: !!c.suggest, chars, pstyle: normPstyle(c.pstyle), bullet };
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
        blocks.push(tableBlock(rows, it.widths ? { widths: clone(it.widths) } : {}));
        continue;
      }
      if (it.toc) { blocks.push({ type: 'toc', paras: it.toc.map((c) => para(c, lists)) }); continue; }
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
  srv.tabs = spec.tabs.map((t) => { const lists = tabLists(t); return { id: t.id, title: t.title, lists, blocks: toBlocks(t.items, lists), ...tabSegments(t, lists) }; });
  // A container holds blocks: a tab (its body: index 1 after the section break) or a segment (index 0).
  const isTab = (c) => srv.tabs.includes(c);
  // fns: footnote marks seen in reading order (the body's layout numbers them).
  const layout = (container, fns = []) => {
    const body = isTab(container);
    let idx = body ? 1 : 0;
    const content = body ? [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }] : [];
    const runs = [];
    const renderRun = (paras, out, editable = true) => {
      const start = idx;
      for (const p of paras) {
        const elements = [];
        let at = idx;
        const str = p.text + '\n';
        const chars = [...pchars(p), undefined];
        for (let i = 0; i < str.length;) {
          if (str[i] === OBJ && chars[i] && chars[i]._fn) {
            fns.push(chars[i]._fn);
            elements.push({ startIndex: at, endIndex: at + 1, footnoteReference: { footnoteId: chars[i]._fn, footnoteNumber: String(fns.length), textStyle: {} } });
            at += 1; i++; continue;
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
          if (p.suggest) run.textRun.suggestedInsertionIds = ['suggest.1'];
          elements.push(run); at += j - i; i = j;
        }
        const paragraph = { elements, paragraphStyle: { namedStyleType: p.style, ...clone(p.pstyle || {}) } };
        if (p.bullet) paragraph.bullet = p.bullet.level ? { listId: p.bullet.listId, nestingLevel: p.bullet.level } : { listId: p.bullet.listId };
        out.push({ startIndex: idx, endIndex: at, paragraph });
        idx = at;
      }
      if (editable) runs.push({ start, end: idx, paras });
    };
    // tables: [{ start, end, block }] for the plugins' structural requests.
    const tables = [];
    container.blocks.forEach((b, bi) => {
      if (b.type === 'run') { renderRun(b.paras, content); return; }
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
        idx++;
        for (const cell of row) {
          const [rowSpan, columnSpan] = cell.span || [1, 1];
          const c = { startIndex: idx, content: [], tableCellStyle: { rowSpan, columnSpan } };
          idx++;
          renderRun(cell.paras, c.content);
          c.endIndex = idx;
          r.tableCells.push(c);
        }
        r.endIndex = idx;
        t.table.tableRows.push(r);
      }
      t.endIndex = idx;
      tables.push({ start: t.startIndex, end: idx, block: b, at: bi });
      content.push(t);
    });
    return { content, runs, tables, fns };
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
  const runChars = (run) => run.paras.flatMap((p) => [...pchars(p), undefined]); // parallel to runText
  // The properties a paragraph's newline carries (copied for a split, kept for the surviving newline of a merge).
  const propsOf = (p) => ({ style: p.style, pstyle: clone(p.pstyle || {}), bullet: clone(p.bullet || null) });
  const setRun = (run, str, props, chars) => {
    const texts = str.split('\n'); texts.pop();
    let at = 0;
    run.paras.splice(0, run.paras.length, ...texts.map((text, i) => {
      const p = { text, ...propsOf(props[i]), suggest: false, chars: chars.slice(at, at + text.length) };
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
    shifted(where.location || where.endOfSegmentLocation || {}, index, 2 + rows * (1 + columns * 2)); // the newline, the table
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
  const apply = (req) => {
    const name = Object.keys(req)[0];
    if (PLUGINS.requests[name]) return PLUGINS.requests[name](req[name], fakeApi());
    if (req.insertTable) return insertTable(req.insertTable);
    if (req.createFootnote) return createFootnote(req.createFootnote);
    if (req.createHeader) return createHeaderFooter('header', req.createHeader);
    if (req.createFooter) return createHeaderFooter('footer', req.createFooter);
    if (req.deleteHeader) return deleteHeaderFooter('header', req.deleteHeader.headerId, req.deleteHeader.tabId);
    if (req.deleteFooter) return deleteHeaderFooter('footer', req.deleteFooter.footerId, req.deleteFooter.tabId);
    if (req.deleteContentRange) {
      const range = req.deleteContentRange.range;
      const { startIndex: s, endIndex: e } = range;
      deleteRange(target(range).c, s, e);
      shifted(range, s, s - e);
    } else if (req.insertText) {
      const loc = req.insertText.location || req.insertText.endOfSegmentLocation;
      // eslint-disable-next-line no-control-regex -- mirrors the Docs API stripping C0 controls
      const text = req.insertText.text.replace(/[\u0000-\u0008\u000C-\u001F-]/g, ''); // stripped by the API
      const { c, index: i } = locate(req.insertText);
      insertAt(c, i, text);
      shifted(loc || {}, i, text.length);
    } else if (req.updateParagraphStyle) {
      const { range, paragraphStyle: ps = {}, fields } = req.updateParagraphStyle;
      const keys = maskFields(fields, PARA_FIELDS, 'updateParagraphStyle');
      for (const { p } of parasIn(rangeTab(range), range.startIndex, range.endIndex)) {
        p.pstyle = p.pstyle || {};
        for (const k of keys) {
          if (k === 'namedStyleType') p.style = ps.namedStyleType || 'NORMAL_TEXT';
          else if (k in ps) p.pstyle[k] = clone(ps[k]);
          else delete p.pstyle[k];
        }
      }
    } else if (req.updateTextStyle) {
      const { range, textStyle, fields } = req.updateTextStyle;
      const { startIndex: s, endIndex: e } = range;
      const { c } = target(range);
      if (e <= s) fail('Invalid range');
      const keys = maskFields(fields, TEXT_FIELDS, 'updateTextStyle');
      for (const run of layout(c).runs) {
        let at = run.start;
        for (const p of run.paras) {
          const chars = pchars(p);
          for (let i = Math.max(s, at); i < Math.min(e, at + p.text.length); i++) {
            const st = { ...chars[i - at] };
            for (const k of keys) setTextField(st, k, textStyle || {}, srv.linkAutoStyle);
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
      // A list right before the range with the same preset is continued (Docs joins adjacent lists).
      const prev = hit[0].run.paras[hit[0].k - 1];
      let listId = prev && prev.bullet && tab.lists[prev.bullet.listId] && tab.lists[prev.bullet.listId].preset === bulletPreset ? prev.bullet.listId : null;
      if (!listId) { listId = `kix.list.${++srv.listSeq}`; tab.lists[listId] = { preset: bulletPreset, nestingLevels: nestingLevels(bulletPreset) }; }
      const levels = tab.lists[listId].nestingLevels;
      for (const { p } of hit) {
        const tabs = /^\t*/.exec(p.text)[0].length; // leading tabs: the nesting level, removed from the text
        p.chars = pchars(p).slice(tabs);
        p.text = p.text.slice(tabs);
        const level = Math.min(tabs, levels.length - 1);
        p.bullet = { listId, level };
        p.pstyle = { ...(p.pstyle || {}), indentStart: clone(levels[level].indentStart), indentFirstLine: clone(levels[level].indentFirstLine) };
      }
    } else if (req.deleteParagraphBullets) {
      const { range } = req.deleteParagraphBullets;
      const c = rangeTab(range);
      const tab = listsTab(range);
      for (const { p } of parasIn(c, range.startIndex, range.endIndex)) {
        if (!p.bullet) continue;
        const list = tab.lists[p.bullet.listId];
        const lv = list && list.nestingLevels[p.bullet.level];
        // The nesting level stays visible as a plain indent (the API keeps the text where it was).
        if (lv) p.pstyle = { ...(p.pstyle || {}), indentStart: clone(lv.indentStart), indentFirstLine: clone(lv.indentStart) };
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
  const renderTab = (t) => {
    const { content, fns } = layout(t);
    return { body: { content }, ...renderLists(t), ...renderSegments(t, fns) };
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
  srv.tables = (tabId) => tabOf(tabId).blocks.filter((b) => b.type === 'table').map((b) => ({
    rows: b.rows.map((row) => row.map((cell) => cell.paras.map((p) => p.text).join('\n'))), widths: clone(b.widths || null),
    spans: b.rows.flatMap((row, r) => row.map((cell, c) => (cell.span ? [r, c, ...cell.span] : null))).filter(Boolean),
  }));
  // Paragraph texts joined with "\n" (objects shown as "￼", like the panel); raw keeps OBJ apart from literal U+FFFC.
  srv.text = (tabId) => paras(tabId).map((p) => p.text.split(OBJ).join('￼')).join('\n');
  srv.raw = (tabId) => paras(tabId).map((p) => p.text).join('\n');
  srv.styles = (tabId) => paras(tabId).map((p) => p.style);
  // Text styles per paragraph: [[s, e, style], ...] for the stretches of equal non-plain style (friendly keys:
  // bold, italic, underline, link, font, weight, size, color, bg).
  srv.fmt = (tabId) => paras(tabId).map((p) => {
    const out = [];
    pchars(p).forEach((st0, i) => {
      const { _fn, ...st } = st0 || {}; // a footnote mark is no text style
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
      return json(200, srv.render(withTabs));
    }
    const body = JSON.parse(init.body);
    const net = srv.failNext && srv.failNext.network ? srv.failNext : null;
    srv.failNext = null;
    if (net && !net.apply) throw new TypeError('Failed to fetch');
    if (body.writeControl && body.writeControl.requiredRevisionId !== 'rev-' + srv.revision) {
      return json(400, { error: { code: 400, message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } });
    }
    // A failed batch changes nothing: srv.backupKeys (plugins add theirs, e.g. comments) are restored.
    const backup = JSON.stringify(Object.fromEntries(srv.backupKeys.map((k) => [k, srv[k]])));
    let replies;
    try { replies = body.requests.map((rq) => apply(rq) || {}); } catch (e) {
      Object.assign(srv, JSON.parse(backup));
      return json(400, { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } });
    }
    srv.revision++;
    if (net) throw new TypeError('Failed to fetch'); // applied, but the response was lost
    return json(200, { documentId: srv.documentId, replies, writeControl: { requiredRevisionId: 'rev-' + srv.revision } });
  };
  srv.backupKeys = ['tabs', 'listSeq', 'segSeq'];
  for (const fn of PLUGINS.inits) fn(srv, spec);
  return srv;
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
const WRITE_SET = ['replace_text', 'replace_all', 'replace_section', 'format_text', 'format_lines', 'insert_after_line', 'delete_lines', 'undo_last_edit'];

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

module.exports = { fakeDocsServer, OC, VT, MARK, docSpec, ORIGINAL, ORIGINAL_STYLES, WRITE_SET, docsBench, CHECKBOX_GLYPH, LINK_HEX,
  registerFakeRequest, registerFakeRender, registerFakeGet, registerFakeInit };
