'use strict';
// The table tool's style actions (src/docs-tables.js): header_rows (pinTableHeaderRows), shade and borders
// (updateTableCellStyle), merge and unmerge (mergeTableCells / unmergeTableCells) against the fake's table plugin
// (test/lib/fake-tables.js): each request's shape, the styles read before the change (with the module's own field
// mask, applied to the fake's answers) and the inverse undo built from them, the verification after the change, the
// lossy undo of a merge, the 400 of a range that is not rectangular and every argument error.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
const { parseMask, maskPaths, applyMask } = require('./lib/field-mask');
require('./lib/fake-tables');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Lines: 1 Title, 2 Alpha, 3 Beta, 4-7 the cells A, B, C, D of T1 (2×2, starts at index 18), 8 After, 9 Last.
const spec = (extra = {}) => docSpec({ items: [
  { p: 'Title', style: 'TITLE' }, { p: 'Alpha' }, { p: 'Beta' },
  { table: [[[{ p: 'A' }], [{ p: 'B' }]], [[{ p: 'C' }], [{ p: 'D' }]]], ...extra },
  { p: 'After' }, { p: 'Last' },
] });
// Line 1 Top, then a 3×3 table starting at index 5 (cells a…i, or empty), then End.
const grid3 = (extra = {}, empty = false) => docSpec({ items: [
  { p: 'Top' },
  { table: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']].map((row) => row.map((x) => [{ p: empty ? '' : x }])), ...extra },
  { p: 'End' },
] });
const NULLS = { action: null, line: null, table: null, row: null, column: null, rows: null, columns: null, cells: null, width: null, color: null, style: null };
const tb = (over) => ({ ...NULLS, table: 'T1', ...over });
const loc = (index) => ({ index, tabId: 't.0' });
const cellLoc = (start, r, c) => ({ tableStartLocation: loc(start), rowIndex: r, columnIndex: c });
const range = (start, r, c, rs, cs) => ({ tableCellLocation: cellLoc(start, r, c), rowSpan: rs, columnSpan: cs });
const posts = () => fake.log.filter((x) => x.method === 'POST').map((x) => x.body.requests);
const undo = async () => pushTool(await exec('undo_last_edit', {}));
const rgb = (hex) => { const o = {}; ['red', 'green', 'blue'].forEach((k, i) => { const n = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16); if (n) o[k] = n / 255; }); return { color: { rgbColor: o } }; };
const border = (pt) => ({ color: rgb('#404040'), width: { magnitude: pt, unit: 'PT' }, dashStyle: 'SOLID' });
const SIDES = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'];
// Border widths of each cell of the first table as [top, bottom, left, right] (null: not set).
const widths = () => fake.tableStyles('t.0')[0].cells.map((row) => row.map((st) => SIDES.map((k) => (st[k] ? st[k].width.magnitude : null))));
// The fake answers documents.get in full; the module's style reads get only what their mask names, as Google does.
function maskStyleReads() {
  const f0 = fake.fetch;
  fake.fetch = async (url, init) => {
    const r = await f0(url, init);
    if (!r || (init && init.method === 'POST') || !url.includes('tableRowStyle(tableHeader)')) return r;
    const masked = applyMask(await r.json(), parseMask(T.TABLE_STYLE_FIELDS));
    return { ...r, json: async () => masked, text: async () => JSON.stringify(masked) };
  };
}
const start = async (s) => { await fresh(s); maskStyleReads(); };
const styleReads = () => fake.log.filter((x) => x.method === 'GET' && x.url.includes('tableRowStyle(tableHeader)')).length;
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, p]] = [...T.pendingPreviews.entries()];
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}

test('the style mask reads the header flags and the cell styles of the body tables in every tab', () => {
  const paths = maskPaths(parseMask(T.TABLE_STYLE_FIELDS));
  for (const p of ['tabs.tabProperties.tabId', 'tabs.documentTab.body.content.startIndex', 'tabs.documentTab.body.content.table.tableRows.tableRowStyle.tableHeader',
    'tabs.documentTab.body.content.table.tableRows.tableCells.tableCellStyle.backgroundColor', 'tabs.documentTab.body.content.table.tableRows.tableCells.tableCellStyle.borderLeft',
    'tabs.childTabs.childTabs.documentTab.body.content.table.tableRows.tableCells.tableCellStyle.rowSpan']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.includes('paragraph')), 'no text');
  const sum = (args) => T.logEntry({ id: 'x', function: { name: 'table', arguments: JSON.stringify(tb(args)) } }, null).summary;
  deq([sum({ action: 'header_rows', rows: 1 }), sum({ action: 'shade', row: 1, color: 'grey' }), sum({ action: 'shade', color: '#ABC' }), sum({ action: 'borders', style: 'horizontal' }),
    sum({ action: 'merge', row: 1, column: 1, columns: 2 }), sum({ action: 'unmerge', row: 2 })],
  ['header rows of T1: 1', 'shade rows 1, columns all of T1: grey', 'shade all cells of T1: #ABC', 'borders of T1: horizontal', 'merge rows 1, columns 1-2 of T1', 'unmerge rows 2, columns all of T1']);
});

test('header_rows: pinTableHeaderRows after reading the old count; verified; undo pins the old count again', async () => {
  await start(spec());
  const w = pushTool(await exec('table', tb({ action: 'header_rows', rows: 1 })));
  assert.ok(w._ok, w.content);
  deq(posts(), [[{ pinTableHeaderRows: { tableStartLocation: loc(18), pinnedHeaderRowsCount: 1 } }]]);
  assert.strictEqual(w.content, 'Done: in table T1 the first row repeats on every page; the document has 9 lines.');
  assert.strictEqual(styleReads(), 2, 'one read before, one after');
  deq([w._edit.kind, w._edit.action, w._edit.prev, fake.tableStyles('t.0')[0].pinned], ['table', 'header_rows', 0, 1]);
  assert.strictEqual(as.responseWrite, null, 'no line moves');
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ pinTableHeaderRows: { tableStartLocation: loc(18), pinnedHeaderRowsCount: 0 } }]);
  assert.strictEqual(fake.tableStyles('t.0')[0].pinned, 0);
  // a pinned row unpinned (0); undo pins it again
  await start(spec({ pinned: 1 }));
  const z = pushTool(await exec('table', tb({ action: 'header_rows', rows: 0 })));
  assert.strictEqual(z.content, 'Done: table T1 has no header rows; the document has 9 lines.');
  await undo();
  deq(posts().pop(), [{ pinTableHeaderRows: { tableStartLocation: loc(18), pinnedHeaderRowsCount: 1 } }]);
  assert.strictEqual(fake.tableStyles('t.0')[0].pinned, 1);
});

test('header_rows: more rows than the table allows, no count, and a Docs that does not report header rows back', async () => {
  await start(spec());
  for (const rows of [2, 5, -1, null]) {
    const r = await exec('table', tb({ action: 'header_rows', rows }));
    assert.strictEqual(r.content, 'Error: table T1 has 2 rows; rows must be 0-1 (how many top rows repeat on every page; 0 = none; the last row cannot be a header)');
  }
  assert.strictEqual(posts().length + styleReads(), 0);
  // the read after the change shows no tableHeader at all: a note, the edit stands
  const f0 = fake.fetch;
  fake.fetch = async (url, init) => {
    const r = await f0(url, init);
    if (!r || (init && init.method === 'POST') || !url.includes('tableRowStyle')) return r;
    const j = await r.json();
    for (const row of j.tabs[0].documentTab.body.content.find((e) => e.table).table.tableRows) delete row.tableRowStyle;
    return { ...r, json: async () => j, text: async () => JSON.stringify(j) };
  };
  const w = pushTool(await exec('table', tb({ action: 'header_rows', rows: 1 })));
  assert.ok(w._ok);
  assert.ok(w.content.endsWith('\nNote: Google Docs did not report the header rows back; ask the user to check them in Google Docs (Table properties).'), w.content);
});

test('shade: a named color over a row (tableRange), verified; undo resets the old (unset) shading in one request', async () => {
  await start(spec());
  const w = pushTool(await exec('table', tb({ action: 'shade', row: 1, color: 'Light  Blue' })));
  assert.ok(w._ok, w.content);
  deq(posts(), [[{ updateTableCellStyle: { tableRange: range(18, 0, 0, 1, 2), tableCellStyle: { backgroundColor: rgb('#CFE2F3') }, fields: 'backgroundColor' } }]]);
  assert.strictEqual(w.content, 'Done: cells [r1c1]–[r1c2] of table T1 are shaded light blue; the document has 9 lines.');
  deq([w._message, w._cardLabel, w._cardText], ['Shaded cells [r1c1]–[r1c2] of T1: light blue', 'Shading', 'cells [r1c1]–[r1c2]: light blue']);
  deq(fake.tableStyles('t.0')[0].cells, [[{ backgroundColor: rgb('#CFE2F3') }, { backgroundColor: rgb('#CFE2F3') }], [{}, {}]]);
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ updateTableCellStyle: { tableRange: range(18, 0, 0, 1, 2), tableCellStyle: {}, fields: 'backgroundColor' } }]);
  deq(fake.tableStyles('t.0')[0].cells, [[{}, {}], [{}, {}]]);
});

test('shade: hex over the whole table (tableStartLocation) and a column; undo restores mixed old colors cell by cell; none resets', async () => {
  await start(spec({ cellStyles: [[0, 0, { backgroundColor: rgb('#FFF2CC') }]] }));
  let w = pushTool(await exec('table', tb({ action: 'shade', color: '#abc' })));
  assert.ok(w._ok, w.content);
  deq(posts().pop(), [{ updateTableCellStyle: { tableStartLocation: loc(18), tableCellStyle: { backgroundColor: rgb('#AABBCC') }, fields: 'backgroundColor' } }]);
  assert.strictEqual(w.content, 'Done: all cells of table T1 are shaded #AABBCC; the document has 9 lines.');
  let u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [
    { updateTableCellStyle: { tableRange: range(18, 0, 0, 1, 1), tableCellStyle: { backgroundColor: rgb('#FFF2CC') }, fields: 'backgroundColor' } },
    { updateTableCellStyle: { tableRange: range(18, 0, 1, 1, 1), tableCellStyle: {}, fields: 'backgroundColor' } },
    { updateTableCellStyle: { tableRange: range(18, 1, 0, 1, 1), tableCellStyle: {}, fields: 'backgroundColor' } },
    { updateTableCellStyle: { tableRange: range(18, 1, 1, 1, 1), tableCellStyle: {}, fields: 'backgroundColor' } },
  ]);
  deq(fake.tableStyles('t.0')[0].cells, [[{ backgroundColor: rgb('#FFF2CC') }, {}], [{}, {}]]);
  // column 1, none: the field reset
  w = pushTool(await exec('table', tb({ action: 'shade', column: 1, color: 'none' })));
  deq(posts().pop(), [{ updateTableCellStyle: { tableRange: range(18, 0, 0, 2, 1), tableCellStyle: {}, fields: 'backgroundColor' } }]);
  assert.strictEqual(w.content, 'Done: cells [r1c1]–[r2c1] of table T1 have no shading; the document has 9 lines.');
  deq(fake.tableStyles('t.0')[0].cells, [[{}, {}], [{}, {}]]);
  u = await undo();
  deq(fake.tableStyles('t.0')[0].cells, [[{ backgroundColor: rgb('#FFF2CC') }, {}], [{}, {}]]);
  // grey and light grey are shading greys, not the general grey of format_text
  w = pushTool(await exec('table', tb({ action: 'shade', row: 2, column: 2, color: 'grey' })));
  deq(posts().pop()[0].updateTableCellStyle.tableCellStyle, { backgroundColor: rgb('#D9D9D9') });
  w = pushTool(await exec('table', tb({ action: 'shade', row: 2, column: 2, color: 'light gray' })));
  deq(posts().pop()[0].updateTableCellStyle.tableCellStyle, { backgroundColor: rgb('#F3F3F3') });
});

test('shade: a Docs that stores another color gets a note; a failed read before the change sends nothing', async () => {
  await start(spec());
  const f0 = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      for (const rq of body.requests) if (rq.updateTableCellStyle) rq.updateTableCellStyle.tableCellStyle = { backgroundColor: rgb('#FFFFFF') };
      init = { ...init, body: JSON.stringify(body) };
    }
    return f0(url, init);
  };
  const w = pushTool(await exec('table', tb({ action: 'shade', row: 1, color: 'light yellow' })));
  assert.ok(w._ok);
  assert.ok(w.content.endsWith('\nNote: Google Docs reports a different shading in [r1c1] #FFFFFF, [r1c2] #FFFFFF.'), w.content);
  await start(spec());
  fake.failReads = 3;
  const r = await exec('table', tb({ action: 'shade', color: 'grey' }));
  assert.ok(!r._ok && r.content.startsWith('Error: the table\'s current styles could not be read ('), r.content);
  assert.ok(r.content.endsWith('so nothing was changed; try again.'), r.content);
  assert.strictEqual(posts().length, 0);
});

test('shade: errors name the fix', async () => {
  await start(spec());
  const err = async (args) => { const r = await exec('table', tb(args)); assert.ok(!r._ok, r.content); return r.content; };
  deq([
    await err({ action: 'shade', color: 'sparkly' }),
    await err({ action: 'shade', color: null }),
    await err({ action: 'shade', row: 3, color: 'grey' }),
    await err({ action: 'shade', row: 2, rows: 2, color: 'grey' }),
    await err({ action: 'shade', column: 1, columns: 0, color: 'grey' }),
    await err({ action: 'borders', style: 'dotted' }),
    await err({ action: 'merge', row: 1, column: 1 }),
  ], [
    'Error: color must be light grey, grey, light blue, light yellow, none, or a hex code such as #DDEEFF; got "sparkly"',
    'Error: color must be light grey, grey, light blue, light yellow, none, or a hex code such as #DDEEFF; got null',
    'Error: table T1 has 2 rows; row must be 1-2 (null = all)',
    'Error: rows must be 1-1 from row 2 (table T1 has 2 rows)',
    'Error: columns must be 1-2 from column 1 (table T1 has 2 columns)',
    'Error: style must be one of grid, horizontal, outer, none',
    'Error: merge needs at least two cells: give rows or columns greater than 1',
  ]);
  assert.strictEqual(posts().length + styleReads(), 0);
});

test('borders: grid, horizontal (rules and the header rule), outer and none; verified; undo restores the old borders', async () => {
  await start(spec());
  const all = (pt) => ({ updateTableCellStyle: { tableStartLocation: loc(18), tableCellStyle: { borderTop: border(pt), borderBottom: border(pt), borderLeft: border(pt), borderRight: border(pt) }, fields: SIDES.join(',') } });
  const side = (r, c, rs, cs, k, pt) => ({ updateTableCellStyle: { tableRange: range(18, r, c, rs, cs), tableCellStyle: { [k]: border(pt) }, fields: k } });
  let w = pushTool(await exec('table', tb({ action: 'borders', style: 'grid' })));
  assert.ok(w._ok, w.content);
  deq(posts().pop(), [all(0.5)]);
  assert.strictEqual(w.content, 'Done: table T1 has all lines; the document has 9 lines.');
  deq(widths(), [[[0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]], [[0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]]);
  w = pushTool(await exec('table', tb({ action: 'borders', style: 'horizontal' })));
  deq(posts().pop(), [all(0), side(0, 0, 1, 2, 'borderTop', 1), side(1, 0, 1, 2, 'borderBottom', 1), side(0, 0, 1, 2, 'borderBottom', 0.5)]);
  assert.strictEqual(w.content, 'Done: table T1 has rules above and below and under the header row; the document has 9 lines.');
  deq(widths(), [[[1, 0.5, 0, 0], [1, 0.5, 0, 0]], [[0.5, 1, 0, 0], [0.5, 1, 0, 0]]]);
  // undo: the grid again (the old borders, one request: all cells had the same)
  let u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [all(0.5)]);
  deq(widths()[0][0], [0.5, 0.5, 0.5, 0.5]);
  // undo: no borders set before the grid: the fields are reset
  u = await undo();
  deq(posts().pop(), [{ updateTableCellStyle: { tableStartLocation: loc(18), tableCellStyle: {}, fields: SIDES.join(',') } }]);
  deq(fake.tableStyles('t.0')[0].cells, [[{}, {}], [{}, {}]]);
  w = pushTool(await exec('table', tb({ action: 'borders', style: 'outer' })));
  deq(posts().pop(), [all(0), side(0, 0, 1, 2, 'borderTop', 1), side(1, 0, 1, 2, 'borderBottom', 1), side(0, 0, 2, 1, 'borderLeft', 1), side(0, 1, 2, 1, 'borderRight', 1)]);
  deq(widths(), [[[1, 0, 1, 0], [1, 0, 0, 1]], [[0, 1, 1, 0], [0, 1, 0, 1]]]);
  assert.ok(!w.content.includes('Note'), w.content);
  w = pushTool(await exec('table', tb({ action: 'borders', style: 'none' })));
  deq(posts().pop(), [all(0)]);
  // undo of none: the outer frame back, cell by cell (the cells differed)
  u = await undo();
  assert.strictEqual(posts().pop().length, 4);
  deq(widths(), [[[1, 0, 1, 0], [1, 0, 0, 1]], [[0, 1, 1, 0], [0, 1, 0, 1]]]);
});

test('borders: two pinned header rows put the header rule under row 2; a mismatch gets a note', async () => {
  await start(docSpec({ items: [{ p: 'Top' }, { table: [['a'], ['b'], ['c']].map((row) => row.map((x) => [{ p: x }])), pinned: 2 }, { p: 'End' }] }));
  pushTool(await exec('table', tb({ action: 'borders', style: 'horizontal' })));
  deq(posts().pop().pop(), { updateTableCellStyle: { tableRange: range(5, 1, 0, 1, 1), tableCellStyle: { borderBottom: border(0.5) }, fields: 'borderBottom' } });
  deq(widths().map((row) => row[0].slice(0, 2)), [[1, 0], [0, 0.5], [0.5, 1]]);
  // a Docs that ignores the rules: the note names the cells
  const f0 = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init && init.method === 'POST') { const body = JSON.parse(init.body); body.requests = body.requests.slice(0, 1); init = { ...init, body: JSON.stringify(body) }; }
    return f0(url, init);
  };
  const w = pushTool(await exec('table', tb({ action: 'borders', style: 'horizontal' })));
  assert.ok(w.content.endsWith('\nNote: Google Docs reports other borders on [r1c1], [r2c1], [r3c1]; check the table.'), w.content);
});

test('merge: mergeTableCells over the range; the Manual card says the texts join; undo unmerges and says the text stays joined; Auto asks nothing', async () => {
  await start(grid3());
  as.askEdits = true;
  const { r: w, html } = await decided(exec('table', tb({ action: 'merge', row: 1, column: 1, columns: 2 })), 'accept');
  pushTool(w);
  assert.ok(w._ok, w.content);
  assert.ok(html.includes('Merges 2 cells and joins the text of 2 of them in [r1c1]; undo does not split it again.') && html.includes('<pre>a | b</pre>'), html);
  deq(posts(), [[{ mergeTableCells: { tableRange: range(5, 0, 0, 1, 2) } }]]);
  assert.ok(w.content.startsWith('Done: merged cells [r1c1]–[r1c2] of table T1 into [r1c1]; their texts are now joined in [r1c1], and undo unmerges the cells but leaves the text joined'), w.content);
  assert.ok(!w.content.includes('Note'), w.content);
  deq(fake.tables('t.0')[0].rows[0], ['a\nb', '', 'c']);
  deq(fake.tables('t.0')[0].spans, [[0, 0, 1, 2]]);
  deq([w._edit.action, w._edit.range], ['merge', { r: 0, c: 0, rs: 1, cs: 2 }]);
  assert.strictEqual(styleReads(), 0, 'merge reads no styles');
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ unmergeTableCells: { tableRange: range(5, 0, 0, 1, 2) } }]);
  assert.ok(u.content.includes('\nNote: the cells were unmerged; their text stays joined in the first cell (Google Docs does not split it again).'), u.content);
  deq(fake.tables('t.0')[0].spans, []);
  deq(fake.tables('t.0')[0].rows[0], ['a\nb', '', 'c']);
  // Auto: no card (cells with text too); a 2×2 block of empty cells
  await start(grid3());
  const joined = pushTool(await exec('table', tb({ action: 'merge', row: 1, column: 1, columns: 2 })));
  assert.ok(joined._ok && joined._decision === undefined && T.pendingPreviews.size === 0, joined.content);
  await start(grid3({}, true));
  const e = pushTool(await exec('table', tb({ action: 'merge', row: 2, rows: 2, column: 2, columns: 2 })));
  assert.ok(e._ok && T.pendingPreviews.size === 0, e.content);
  deq(fake.tables('t.0')[0].spans, [[1, 1, 2, 2]]);
  assert.ok(e.content.startsWith('Done: merged cells [r2c2]–[r3c3] of table T1 into [r2c2]; '), e.content);
});

test('merge: a range that cuts a merged cell is refused with the block that would work; the 400 of Docs gets the same advice', async () => {
  await start(grid3({ spans: [[0, 1, 2, 1]] }, true));
  const r = await exec('table', tb({ action: 'merge', row: 1, column: 1, columns: 2 }));
  assert.strictEqual(r.content, 'Error: cells [r1c1]–[r1c2] cut a merged cell, so the range is not rectangular; merge [r1c1]–[r2c2] instead (row 1, column 1, rows 2, columns 2)');
  assert.strictEqual(posts().length, 0);
  // the fake refuses it as Docs does (the API check behind the plan's own)
  const res = await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' },
    body: JSON.stringify({ requests: [{ mergeTableCells: { tableRange: range(5, 0, 0, 1, 2) } }] }) });
  deq([res.status, (await res.json()).error.message], [400, 'The table range is not rectangular: it cuts a merged cell.']);
  // a 400 from Docs that the plan did not foresee
  await start(grid3({}, true));
  fake.failNext = { status: 400, message: 'Invalid requests[0].mergeTableCells: The table range is not rectangular.' };
  const w = await exec('table', tb({ action: 'merge', row: 1, rows: 2, column: 1 }));
  assert.ok(!w._ok);
  assert.ok(w.content.startsWith('Error: the Google Docs API rejected the edit: The request was malformed: Invalid requests[0].mergeTableCells: The table range is not rectangular.'), w.content);
  assert.ok(w.content.endsWith('\nGoogle Docs merges only a rectangular block of cells that cuts no merged cell; check the table with read_document and give row, column, rows and columns of such a block.'), w.content);
  deq(fake.tables('t.0')[0].spans, []);
});

test('unmerge: unmergeTableCells over the range; undo merges the same cells again (exact)', async () => {
  await start(grid3({ spans: [[0, 0, 1, 2], [1, 2, 2, 1]] }));
  const w = pushTool(await exec('table', tb({ action: 'unmerge', row: 1 })));
  assert.ok(w._ok, w.content);
  deq(posts(), [[{ unmergeTableCells: { tableRange: range(5, 0, 0, 1, 3) } }]]);
  assert.ok(w.content.startsWith('Done: unmerged [r1c1] of table T1; the text stays in the first cell of each;'), w.content);
  deq(fake.tables('t.0')[0].spans, [[1, 2, 2, 1]]);
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ mergeTableCells: { tableRange: range(5, 0, 0, 1, 2) } }]);
  deq(fake.tables('t.0')[0].spans, [[0, 0, 1, 2], [1, 2, 2, 1]]);
  // the whole table: both merged cells, both merged again on undo
  pushTool(await exec('table', tb({ action: 'unmerge' })));
  deq(posts().pop(), [{ unmergeTableCells: { tableRange: range(5, 0, 0, 3, 3) } }]);
  deq(fake.tables('t.0')[0].spans, []);
  await undo();
  deq(posts().pop(), [{ mergeTableCells: { tableRange: range(5, 0, 0, 1, 2) } }, { mergeTableCells: { tableRange: range(5, 1, 2, 2, 1) } }]);
  deq(fake.tables('t.0')[0].spans, [[0, 0, 1, 2], [1, 2, 2, 1]]);
  // nothing merged there
  const r = await exec('table', tb({ action: 'unmerge', row: 3, column: 1 }));
  assert.strictEqual(r.content, 'Error: there are no merged cells in [r3c1] of table T1; its merged cells: [r1c1] (1 × 2), [r2c3] (2 × 1)');
  await start(spec());
  assert.strictEqual((await exec('table', tb({ action: 'unmerge' }))).content, 'Error: there are no merged cells in [r1c1]–[r2c2] of table T1; it has no merged cells');
});

test('undo of a style action refuses a table whose cells changed after it', async () => {
  await start(spec());
  const w = pushTool(await exec('table', tb({ action: 'shade', color: 'grey' })));
  pushTool(await exec('replace_text', { old_text: 'D', new_text: 'Delta' }));
  await assert.rejects(T.undoEdit(w._edit), /the table of that edit changed after it \(or is gone\)/);
});
