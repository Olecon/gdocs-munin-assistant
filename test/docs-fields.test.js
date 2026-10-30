'use strict';
// documents.get reads only what the line model uses (the fields mask of fetchDocModel), and a Docs API
// failure in a turn keeps the panel from calling the API again until the next turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, deq, load, installDocTab, installIdentity, tabExportOnly } = require('./lib/sandbox');
const { sseResponse, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
const { parseMask, maskPaths, covers, applyMask } = require('./lib/field-mask');

let env, T, state, sandbox, chrome, ident, routeDocs, fake;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, as: null };

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  sandbox = env.ctx;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ routeDocs } = docsBench(env, ident, ref));
  Object.assign(env.storage, { muninProvider: 'anthropic', anthropicApiKey: 'sk-ant-NEW', anthropicModel: 'claude-opus-5-5' });
  await T.loadSettings();
  installDocTab(env);
  await T.refreshContext({ force: true });
});

// What buildLineModel, collectLines and paragraphLine read (src/docs-model.js), written out by hand.
const DOC_PATHS = ['documentId', 'title', 'revisionId'];
const TAB_PATHS = ['tabProperties.tabId', 'tabProperties.title', 'documentTab.body.content', 'documentTab.lists'];
const STYLE_KEYS = ['bold', 'italic', 'underline', 'link.url', 'link.headingId', 'fontSize', 'weightedFontFamily', 'foregroundColor', 'backgroundColor'];
const PARA_KEYS = ['namedStyleType', 'alignment', 'lineSpacing', 'spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine', 'direction'];
const OTHER_ELEMENTS = ['inlineObjectElement', 'autoText', 'pageBreak', 'columnBreak', 'footnoteReference', 'horizontalRule', 'equation', 'person', 'richLink'];
const ELEMENT_PATHS = [
  'startIndex', 'endIndex', ...PARA_KEYS.map((k) => 'paragraph.paragraphStyle.' + k), 'paragraph.bullet.listId', 'paragraph.bullet.nestingLevel',
  'paragraph.elements.startIndex', 'paragraph.elements.endIndex', 'paragraph.elements.textRun.content',
  ...STYLE_KEYS.map((k) => 'paragraph.elements.textRun.textStyle.' + k),
  'paragraph.elements.textRun.suggestedInsertionIds', 'paragraph.elements.textRun.suggestedDeletionIds',
  ...OTHER_ELEMENTS.flatMap((t) => [...STYLE_KEYS.map((k) => `paragraph.elements.${t}.textStyle.${k}`),
    `paragraph.elements.${t}.suggestedInsertionIds`, `paragraph.elements.${t}.suggestedDeletionIds`]),
];
const TABLE_PATH = 'table.tableRows.tableCells.content';
// Outer tables (model.tables): the column count, the column widths and the cell spans; the table of contents
// (model.toc) whole; the tab's headers, footers and footnotes whole with documentStyle (model.segments).
const OUTER_TABLE_PATHS = ['table.columns', 'table.tableStyle.tableColumnProperties.widthType', 'table.tableStyle.tableColumnProperties.width',
  'table.tableRows.tableCells.tableCellStyle.rowSpan', 'table.tableRows.tableCells.tableCellStyle.columnSpan', 'tableOfContents'];
const SEGMENT_PATHS = ['documentTab.headers', 'documentTab.footers', 'documentTab.footnotes', 'documentTab.documentStyle.defaultHeaderId',
  'documentTab.documentStyle.firstPageHeaderId', 'documentTab.documentStyle.evenPageFooterId'];
// Tabs nest three levels; a table inside a table cell is read (one level).
const TAB_PREFIXES = ['tabs', 'tabs.childTabs', 'tabs.childTabs.childTabs'];

test('the fields mask parses and contains every property path the line model reads', () => {
  const mask = T.DOCS_GET_FIELDS;
  const paths = maskPaths(parseMask(mask));
  const used = [...DOC_PATHS];
  for (const tab of TAB_PREFIXES) {
    used.push(...TAB_PATHS.map((p) => `${tab}.${p}`));
    const c0 = `${tab}.documentTab.body.content`;
    const c1 = `${c0}.${TABLE_PATH}`;
    const c2 = `${c1}.${TABLE_PATH}`;
    for (const c of [c0, c1, c2]) used.push(...ELEMENT_PATHS.map((p) => `${c}.${p}`));
    used.push(`${c0}.${TABLE_PATH}`, `${c1}.${TABLE_PATH}`, ...OUTER_TABLE_PATHS.map((p) => `${c0}.${p}`), ...SEGMENT_PATHS.map((p) => `${tab}.${p}`));
    if (tab !== TAB_PREFIXES[TAB_PREFIXES.length - 1]) used.push(`${tab}.childTabs`);
  }
  for (const p of used) assert.ok(covers(paths, p), 'missing in the mask: ' + p);
  // and nothing the model does not read: the heavy parts of a document stay out
  // (formatting: fonts, colors, paragraph fields, bullets and the tab's lists are read since the formatting tools)
  for (const p of ['body', 'headers', 'footers', 'footnotes', 'inlineObjects', 'lists', 'namedStyles', 'documentStyle', 'positionedObjects',
    'suggestedDocumentStyleChanges', 'tabs.documentTab.inlineObjects', 'tabs.documentTab.namedStyles', 'tabs.documentTab.positionedObjects',
    'tabs.documentTab.suggestedDocumentStyleChanges', 'tabs.tabProperties.index',
    'tabs.documentTab.body.content.paragraph.bullet.textStyle', 'tabs.documentTab.body.content.sectionBreak',
    'tabs.documentTab.body.content.table.tableRows.tableRowStyle', 'tabs.documentTab.body.content.table.tableRows.tableCells.tableCellStyle.backgroundColor',
    'tabs.documentTab.body.content.table.tableStyle.tableColumnProperties.paddingStart',
    'tabs.documentTab.body.content.table.tableRows.tableCells.content.table.tableStyle', 'tabs.documentTab.body.content.table.tableRows.tableCells.content.tableOfContents',
    'tabs.documentTab.body.content.paragraph.elements.textRun.textStyle.strikethrough',
    'tabs.documentTab.body.content.paragraph.elements.textRun.textStyle.baselineOffset',
    'tabs.documentTab.body.content.paragraph.paragraphStyle.headingId', 'tabs.documentTab.body.content.paragraph.paragraphStyle.shading']) {
    assert.ok(!covers(paths, p), 'should not be requested: ' + p);
  }
  // with includeTabsContent=true the legacy doc.body is not filled; the model reads nothing else
  const src = fs.readFileSync(path.join(ROOT, 'src', 'docs-model.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\b(inlineObjects|namedStyles|positionedObjects)\b/.test(src));
  // stays well below the 8 KB URL limit of Google APIs: about 4.7 KB with the formatting fields, 5.1 KB with tables and segments
  assert.ok(mask.length < 5300, 'mask length ' + mask.length);
});

// A documents.get response with everything the model reads plus much it does not (fonts, lists, inline
// object properties, styles, a table of contents, bullets), nested tables and tabs three levels deep.
function richDoc() {
  let at = 1;
  const font = { fontSize: { magnitude: 11, unit: 'PT' }, weightedFontFamily: { fontFamily: 'Arial', weight: 400 }, foregroundColor: { color: { rgbColor: { red: 0.2 } } } };
  const para = (parts, style = 'NORMAL_TEXT', extra = {}) => {
    const start = at;
    const elements = parts.map((p) => {
      const s = at;
      if (p.obj) { at += 1; return { startIndex: s, endIndex: at, [p.obj]: { ...(p.props || {}), textStyle: { ...font, ...(p.st || {}) }, ...(p.sugg ? { suggestedInsertionIds: ['s.1'] } : {}) } }; }
      at += p.text.length;
      return { startIndex: s, endIndex: at, textRun: { content: p.text, textStyle: { ...font, ...(p.st || {}) }, ...(p.sugg ? { suggestedDeletionIds: ['s.2'] } : {}) } };
    });
    return { startIndex: start, endIndex: at, paragraph: { elements, paragraphStyle: { namedStyleType: style, direction: 'LEFT_TO_RIGHT', lineSpacing: 115, headingId: 'h.x' }, ...extra } };
  };
  const table = (rows) => {
    const start = at++;
    const tableRows = rows.map((row) => {
      const rs = at++;
      const tableCells = row.map((cell) => { const cs = at++; const content = cell(); return { startIndex: cs, endIndex: at, content, tableCellStyle: { rowSpan: 1, columnSpan: 1, backgroundColor: {} } }; });
      return { startIndex: rs, endIndex: at, tableCells, tableRowStyle: { minRowHeight: { unit: 'PT' } } };
    });
    return { startIndex: start, endIndex: at, table: { rows: rows.length, columns: rows[0].length, tableRows, tableStyle: { tableColumnProperties: [{ widthType: 'EVENLY_DISTRIBUTED' }] } } };
  };
  const body = (fn) => { at = 1; return { content: [{ endIndex: 1, sectionBreak: { sectionStyle: { columnSeparatorStyle: 'NONE', sectionType: 'CONTINUOUS' } } }, ...fn()] }; };
  const extras = {
    inlineObjects: { 'kix.1': { objectId: 'kix.1', inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: 'https://lh3.example/' + 'x'.repeat(500) } } } } },
    lists: { 'kix.list': { listProperties: { nestingLevels: [{ bulletAlignment: 'START', glyphSymbol: '●' }] } } },
    namedStyles: { styles: [{ namedStyleType: 'NORMAL_TEXT', textStyle: font }] },
    documentStyle: { pageSize: { height: { magnitude: 792 } }, marginTop: { magnitude: 72 }, defaultHeaderId: 'kix.h' },
    headers: { 'kix.h': { headerId: 'kix.h', content: [para([{ text: 'Header\n' }])] } },
    footnotes: { 'kix.f': { footnoteId: 'kix.f', content: [para([{ text: 'Note\n' }])] } },
  };
  const main = body(() => [
    para([{ text: 'Report\n' }], 'TITLE'),
    para([{ text: 'Plain ' }, { text: 'bold', st: { bold: true } }, { text: ' and ' }, { text: 'link', st: { italic: true, link: { url: 'https://example.org', tabId: 't.0' } } }, { text: ' cut', sugg: true }, { text: '\n' }], 'NORMAL_TEXT', { bullet: { listId: 'kix.list', nestingLevel: 0 } }),
    para([{ text: 'Img ' }, { obj: 'inlineObjectElement', props: { inlineObjectId: 'kix.1' }, st: { bold: true } }, { obj: 'person', props: { personId: 'p', personProperties: { email: 'a@example.org', name: 'A' } } },
      { obj: 'richLink', props: { richLinkId: 'r', richLinkProperties: { title: 'File', uri: 'https://drive.example/f' } }, sugg: true }, { obj: 'footnoteReference', props: { footnoteId: 'kix.f', footnoteNumber: '1' } }, { text: '\n' }]),
    table([[() => [para([{ text: 'Cell A\n' }])], () => [para([{ text: 'Cell B\n' }]), table([[() => [para([{ text: 'Deep ', st: { underline: true } }, { text: 'cell\n' }])]]]), para([{ text: 'After\n' }])]]]),
    { startIndex: at, endIndex: (at += 9), tableOfContents: { content: [para([{ text: 'Report\n' }])] } },
    para([{ text: 'Heading two\n' }], 'HEADING_2'),
    para([{ text: 'Last\n' }]),
  ]);
  const child = body(() => [para([{ text: 'Child tab\n' }], 'HEADING_1'), para([{ text: 'Child text\n', st: { bold: true } }])]);
  const grand = body(() => [para([{ text: 'Grandchild\n' }])]);
  const tab = (id, title, b, childTabs) => ({ tabProperties: { tabId: id, title, index: 0, nestingLevel: 0, iconEmoji: '📄' }, documentTab: { body: b, ...extras }, ...(childTabs ? { childTabs } : {}) });
  return {
    documentId: 'DOC123', title: 'Rich', revisionId: 'rev-9', suggestionsViewMode: 'SUGGESTIONS_INLINE',
    tabs: [tab('t.0', 'Main', main), tab('t.p', 'Parent', body(() => [para([{ text: 'Parent\n' }])]), [tab('t.child', 'Child', child, [tab('t.grand', 'Grand', grand)])])],
  };
}

test('a response filtered by the mask gives exactly the same line model as the full response', () => {
  const full = richDoc();
  const masked = applyMask(JSON.parse(JSON.stringify(full)), parseMask(T.DOCS_GET_FIELDS));
  // the inline object properties and styles stay out (headers, footnotes and documentStyle are read since the page parts)
  assert.ok(JSON.stringify(masked).length < JSON.stringify(full).length * 0.8, `${JSON.stringify(masked).length} of ${JSON.stringify(full).length}`);
  assert.strictEqual(masked.tabs[0].documentTab.inlineObjects, undefined);
  assert.strictEqual(masked.tabs[0].documentTab.namedStyles, undefined);
  assert.strictEqual(masked.tabs[0].documentTab.body.content[4].table.tableRows[0].tableRowStyle, undefined);
  deq(masked.tabs[0].documentTab.body.content[4].table.tableRows[0].tableCells[0].tableCellStyle, { rowSpan: 1, columnSpan: 1 });
  deq(masked.tabs[0].documentTab.body.content[2].paragraph.bullet, { listId: 'kix.list', nestingLevel: 0 });
  assert.strictEqual(masked.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle.headingId, undefined);
  for (const tab of [null, 't.0', 't.p', 't.child', 't.grand']) {
    const a = T.buildLineModel(full, tab, 'DOC123', true);
    deq(T.buildLineModel(masked, tab, 'DOC123', true), a, 'tab ' + tab);
  }
  // the comparison is not trivial: the model saw formatting, suggestions, objects, the nested table, the child tabs
  const m = T.buildLineModel(masked, 't.0', 'DOC123');
  deq(m.lines.map((l) => l.text), ['Report', 'Plain bold and link cut', 'Img ￼￼￼￼', 'Cell A', 'Cell B', 'Deep cell', 'After', 'Heading two', 'Last']);
  deq(m.lines.map((l) => l.suggested), [false, true, true, false, false, false, false, false, false]);
  // every run carries the explicit font (Arial 11, color #330000), so only the inline-formatted ones are compared
  const marked = (l) => l.runs.filter((r) => r.bold || r.italic || r.underline || r.link);
  deq(marked(m.lines[1]).map((r) => [r.s, r.e, r.bold, r.italic, r.link]), [[6, 10, true, false, null], [15, 19, false, true, 'https://example.org']]);
  deq(marked(m.lines[1])[1].linkRaw, { url: 'https://example.org', tabId: 't.0' });
  deq(marked(m.lines[2]).map((r) => [r.s, r.e, r.bold]), [[4, 5, true]]);
  deq(marked(m.lines[5]).map((r) => [r.s, r.e, r.underline]), [[0, 5, true]]);
  deq(m.lines[1].runs[0], { s: 0, e: 6, bold: false, italic: false, underline: false, link: null, font: 'Arial', weight: 400, size: 11, color: '#330000', bg: null, linkRaw: null });
  deq(m.textDefault, { font: 'Arial', size: 11, color: '#330000' });
  deq(m.lines[1].list, { listId: 'kix.list', level: 0, kind: 'bullet' });
  deq(m.lines[1].para, { direction: 'LEFT_TO_RIGHT', lineSpacing: 115 });
  assert.strictEqual(m.lines[0].list, null);
  assert.strictEqual(m.revisionId, 'rev-9');
  assert.strictEqual(m.tabCount, 4);
  assert.strictEqual(T.buildLineModel(masked, 't.grand', 'DOC123', true).tabTitle, 'Grand');
  // tables, the table of contents and the page parts come through the mask too
  deq(m.tables.map((t) => [t.n, t.rows, t.cols, t.firstLine, t.lastLine, t.nested]), [[1, 1, 2, 4, 7, false], [2, 1, 1, 6, 6, true]]);
  deq(m.tables[0].widths, [{ type: 'EVENLY_DISTRIBUTED', pt: null }]);
  deq(m.lines.slice(3, 7).map((l) => l.cell), [{ t: 1, r: 0, c: 0 }, { t: 1, r: 0, c: 1 }, { t: 2, r: 0, c: 0 }, { t: 1, r: 0, c: 1 }]);
  deq(m.toc, { start: m.toc.start, end: m.toc.end, beforeLine: 8, lines: ['Report'] });
  deq(m.segments.map((g) => [g.label, g.segmentId, g.text, g.refLine]), [['header', 'kix.h', 'Header', undefined], ['footnote 1', 'kix.f', 'Note', 3]]);
});

test('a Docs API failure in a turn: no second documents.get in that turn (tools, Undo); called again in the next turn', async () => {
  fake = fakeDocsServer(docSpec());
  const tabMsgs = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg.type);
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Exported\n\nexport text\n', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  ident.granted = true;
  state.googleConnected = true;
  state.applyMode = 'auto';
  state.settings.provider = 'anthropic';
  const gets = () => fake.log.filter((x) => x.method === 'GET').length;
  fake.failNext = { status: 500, message: 'Internal error' };
  let during = null;
  let getsDuring = -1;
  sandbox.fetch = tabExportOnly(routeDocs(async () => {
    // inside the turn (the model request): a tool, or anything else, trying the Docs API again
    const n = gets();
    during = await T.fetchDocModel('DOC123', null).then(() => null, (e) => e);
    getsDuring = gets() - n;
    return sseResponse(textRound('Answered from the export.'));
  }));
  T.el.input.value = 'Anything';
  await T.sendMessage();
  assert.strictEqual(gets(), 1); // the failed read only
  assert.ok(tabMsgs.includes('GET_DOC_TEXT')); assert.strictEqual(state.docFormat, 'markdown');
  assert.ok(during && /failed for this message, so it is not called again now/.test(during.message) && during.preSend === true);
  assert.strictEqual(getsDuring, 0);
  // an Undo on that state (it re-reads the document first) does not call it either
  await assert.rejects(() => T.fetchDocModel('DOC123', 't.0'), /tried again with the next message/);
  assert.strictEqual(gets(), 1);
  // the next turn tries again (and works)
  sandbox.fetch = routeDocs(async () => sseResponse(textRound('Now through the API.')));
  T.el.input.value = 'Again';
  await T.sendMessage();
  assert.strictEqual(gets(), 2);
  assert.strictEqual(state.docFormat, 'docs-api');
  assert.strictEqual(state.docsApiFailed, false);
  // Sign out / Sign in also starts fresh
  state.docsApiFailed = true;
  await T.setGoogleConnected(true);
  assert.strictEqual(state.docsApiFailed, false);
});
