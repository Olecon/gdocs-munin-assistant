'use strict';
// Table plugin of the fake Docs server (test/lib/fake-docs.js): the structural table requests with the API's
// field names and index semantics (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request):
//   insertTableRow { tableCellLocation { tableStartLocation { index, tabId? }, rowIndex, columnIndex }, insertBelow }
//   insertTableColumn { tableCellLocation, insertRight }
//   deleteTableRow / deleteTableColumn { tableCellLocation } (the last row / column deletes the whole table)
//   updateTableColumnProperties { tableStartLocation, columnIndices (none: every column), tableColumnProperties
//     { widthType, width }, fields } (a fixed width under 5 pt is a 400)
// and deleteContentRange extended to a whole table: [start, end) or [start - 1, end) (with the newline before it,
// which joins the paragraphs around the table); a range that cuts a table otherwise is a 400. A new row or column
// has one empty paragraph per cell (a cell takes one index, its paragraph's newline one). srv.onShift listeners
// hear every change of length (per row for a column). Merged cells are kept on their cells but not adjusted.
// Requiring this file registers the plugin for every server of the test process.
const { registerFakeRequest } = require('./fake-docs');

const MIN_WIDTH_PT = 5;
const WIDTH_TYPES = ['EVENLY_DISTRIBUTED', 'FIXED_WIDTH', 'WIDTH_TYPE_UNSPECIFIED'];

// The table starting at loc.index in the addressed container: { c, t: { start, end, block, at }, el (rendered) }.
function tableAt(api, loc) {
  if (!loc || typeof loc.index !== 'number') api.fail('Invalid table start location');
  const { c } = api.target(loc);
  const lay = api.layout(c);
  const t = lay.tables.find((x) => x.start === loc.index);
  if (!t) api.fail(`Invalid table start location: no table starts at index ${loc.index}`);
  const el = lay.content.find((e) => e.table && e.startIndex === t.start);
  return { c, t, el };
}
const colCount = (rows) => rows.reduce((m, row) => Math.max(m, row.length), 0);
const emptyCells = (api, n) => Array.from({ length: n }, () => ({ paras: [api.emptyPara()] }));
function checkCell(api, rows, tcl) {
  const r = tcl.rowIndex;
  const k = tcl.columnIndex;
  if (!Number.isInteger(r) || r < 0 || r >= rows.length) api.fail(`Invalid row index: ${r}`);
  if (!Number.isInteger(k) || k < 0 || k >= rows[r].length) api.fail(`Invalid column index: ${k}`);
  return [r, k];
}
// Removes a table block and joins the runs around it (dropNl: the newline before the table goes too, so the last
// paragraph before it and the first after it become one; the surviving newline is the latter's).
function removeTable(api, c, at, dropNl) {
  const prev = c.blocks[at - 1];
  const next = c.blocks[at + 1];
  const isRun = (b) => b && b.type === 'run';
  if (!isRun(prev) || !isRun(next)) {
    if (dropNl) api.fail('Invalid deletion range: no paragraph around the table to join');
    c.blocks.splice(at, 1);
    return;
  }
  let paras = [...prev.paras, ...next.paras];
  if (dropNl) {
    const a = prev.paras[prev.paras.length - 1];
    const b = next.paras[0];
    const merged = { ...b, ...api.propsOf(b), text: a.text + b.text, chars: [...api.pchars(a), ...api.pchars(b)], suggest: false };
    paras = [...prev.paras.slice(0, -1), merged, ...next.paras.slice(1)];
  }
  c.blocks.splice(at - 1, 3, { type: 'run', paras });
}

registerFakeRequest('insertTableRow', (body, api) => {
  const tcl = body.tableCellLocation || {};
  const { t, el } = tableAt(api, tcl.tableStartLocation);
  const rows = t.block.rows;
  const [r] = checkCell(api, rows, tcl);
  const n = colCount(rows);
  const row = el.table.tableRows[r];
  const index = body.insertBelow ? row.endIndex : row.startIndex;
  rows.splice(body.insertBelow ? r + 1 : r, 0, emptyCells(api, n));
  api.shifted(tcl.tableStartLocation, index, 1 + 2 * n);
});

registerFakeRequest('insertTableColumn', (body, api) => {
  const tcl = body.tableCellLocation || {};
  const { t, el } = tableAt(api, tcl.tableStartLocation);
  const rows = t.block.rows;
  const [, k] = checkCell(api, rows, tcl);
  const at = body.insertRight ? k + 1 : k;
  // Bottom row first: the indices of the rows above stay those the listeners know.
  for (let r = rows.length - 1; r >= 0; r--) {
    const cells = el.table.tableRows[r].tableCells;
    const i = Math.min(at, rows[r].length);
    const index = i < cells.length ? cells[i].startIndex : el.table.tableRows[r].endIndex;
    rows[r].splice(i, 0, ...emptyCells(api, 1));
    api.shifted(tcl.tableStartLocation, index, 2);
  }
  if (t.block.widths) t.block.widths.splice(at, 0, { type: 'EVENLY_DISTRIBUTED' });
});

registerFakeRequest('deleteTableRow', (body, api) => {
  const tcl = body.tableCellLocation || {};
  const { c, t, el } = tableAt(api, tcl.tableStartLocation);
  const rows = t.block.rows;
  const [r] = checkCell(api, rows, tcl);
  if (rows.length === 1) { removeTable(api, c, t.at, false); api.shifted(tcl.tableStartLocation, t.start, t.start - t.end); return; }
  const row = el.table.tableRows[r];
  rows.splice(r, 1);
  api.shifted(tcl.tableStartLocation, row.startIndex, row.startIndex - row.endIndex);
});

registerFakeRequest('deleteTableColumn', (body, api) => {
  const tcl = body.tableCellLocation || {};
  const { c, t, el } = tableAt(api, tcl.tableStartLocation);
  const rows = t.block.rows;
  const [, k] = checkCell(api, rows, tcl);
  if (colCount(rows) === 1) { removeTable(api, c, t.at, false); api.shifted(tcl.tableStartLocation, t.start, t.start - t.end); return; }
  for (let r = rows.length - 1; r >= 0; r--) {
    const cell = el.table.tableRows[r].tableCells[k];
    if (!cell) continue;
    rows[r].splice(k, 1);
    api.shifted(tcl.tableStartLocation, cell.startIndex, cell.startIndex - cell.endIndex);
  }
  if (t.block.widths) t.block.widths.splice(k, 1);
});

registerFakeRequest('updateTableColumnProperties', (body, api) => {
  const { t } = tableAt(api, body.tableStartLocation);
  const keys = String(body.fields || '').split(',').map((k) => k.trim()).filter(Boolean);
  const all = keys.includes('*');
  const bad = keys.filter((k) => !['widthType', 'width', '*'].includes(k));
  if (!keys.length || bad.length) api.fail(`Invalid field mask for updateTableColumnProperties: ${bad.join(', ') || '(empty)'}`);
  const p = body.tableColumnProperties || {};
  if (p.widthType && !WIDTH_TYPES.includes(p.widthType)) api.fail(`Invalid widthType: ${p.widthType}`);
  const pt = p.width && typeof p.width.magnitude === 'number' ? p.width.magnitude : null;
  if ((all || keys.includes('width')) && p.widthType === 'FIXED_WIDTH' && (pt == null || pt < MIN_WIDTH_PT)) api.fail(`The column width must be at least ${MIN_WIDTH_PT} points.`);
  const n = colCount(t.block.rows);
  const idx = body.columnIndices && body.columnIndices.length ? body.columnIndices : Array.from({ length: n }, (_, i) => i);
  for (const i of idx) if (!Number.isInteger(i) || i < 0 || i >= n) api.fail(`Invalid column index: ${i}`);
  const widths = t.block.widths || Array.from({ length: n }, () => ({ type: 'EVENLY_DISTRIBUTED' }));
  for (const i of idx) {
    const w = { ...widths[i] };
    if (all || keys.includes('widthType')) w.type = p.widthType || 'EVENLY_DISTRIBUTED';
    if (all || keys.includes('width')) { if (pt == null) delete w.pt; else w.pt = pt; }
    if (w.type !== 'FIXED_WIDTH') delete w.pt; // only a fixed column has a width of its own
    widths[i] = w;
  }
  t.block.widths = widths;
});

// deleteContentRange: a whole table (optionally with the newline before it); everything else as the server does it.
registerFakeRequest('deleteContentRange', (body, api) => {
  const range = body.range;
  const { c } = api.target(range);
  const { startIndex: s, endIndex: e } = range;
  if (!(e > s)) api.fail('Invalid range');
  const hit = api.layout(c).tables.find((t) => s < t.end && e > t.start);
  if (hit && !(s > hit.start && e < hit.end)) {
    if (e !== hit.end || (s !== hit.start && s !== hit.start - 1)) api.fail('Invalid deletion range: a table can only be deleted whole.');
    removeTable(api, c, hit.at, s === hit.start - 1);
  } else api.deleteRange(c, s, e);
  api.shifted(range, s, s - e);
});

module.exports = { MIN_WIDTH_PT };
