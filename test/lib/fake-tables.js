'use strict';
// Table plugin of the fake Docs server (test/lib/fake-docs.js): the structural table requests with the API's
// field names and index semantics (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request):
//   insertTableRow { tableCellLocation { tableStartLocation { index, tabId? }, rowIndex, columnIndex }, insertBelow }
//   insertTableColumn { tableCellLocation, insertRight }
//   deleteTableRow / deleteTableColumn { tableCellLocation } (the last row / column deletes the whole table)
//   updateTableColumnProperties { tableStartLocation, columnIndices (none: every column), tableColumnProperties
//     { widthType, width }, fields } (a fixed width under 5 pt is a 400)
//   pinTableHeaderRows { tableStartLocation, pinnedHeaderRowsCount } (0..rows; the pinned rows render tableHeader)
//   updateTableCellStyle { tableCellStyle, fields, tableRange { tableCellLocation, rowSpan, columnSpan } | tableStartLocation }
//     (exactly one of the two; backgroundColor, the four borders, paddings, contentAlignment or "*"; rowSpan and
//     columnSpan are read-only: a 400; a border set needs color, width and dashStyle; a listed field absent from the
//     style is reset; a border is applied right, left, bottom, top and also changes the neighbouring cell's shared one)
//   mergeTableCells { tableRange } (a 400 when the range leaves the table, holds one cell or cuts a merged cell; the
//     texts of the non-empty cells are joined in the head cell as its paragraphs, the other cells keep one empty one)
//   unmergeTableCells { tableRange } (every merged cell overlapping the range; the text stays in the head cell)
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

// ---- Header rows, cell styles, merged cells ----
const CELL_STYLE_FIELDS = ['backgroundColor', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'contentAlignment'];
const BORDER_ORDER = ['borderRight', 'borderLeft', 'borderBottom', 'borderTop'];
const OPPOSITE = { borderTop: ['borderBottom', -1, 0], borderBottom: ['borderTop', 1, 0], borderLeft: ['borderRight', 0, -1], borderRight: ['borderLeft', 0, 1] };
// The 0-based range { r, c, rs, cs } of a tableRange, checked against the table's rows.
function rangeOf(api, rows, tr) {
  const tcl = (tr && tr.tableCellLocation) || {};
  const [r, c] = checkCell(api, rows, tcl);
  const rs = tr.rowSpan;
  const cs = tr.columnSpan;
  if (!Number.isInteger(rs) || !Number.isInteger(cs) || rs < 1 || cs < 1 || r + rs > rows.length || c + cs > colCount(rows)) api.fail('Invalid table range: it reaches outside the table.');
  return { r, c, rs, cs };
}
const spanRegions = (rows) => rows.flatMap((row, r) => row.map((cell, c) => (cell.span ? { r, c, rs: cell.span[0], cs: cell.span[1] } : null))).filter(Boolean);
const overlap = (a, b) => a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs;
const within = (a, b) => a.r >= b.r && a.c >= b.c && a.r + a.rs <= b.r + b.rs && a.c + a.cs <= b.c + b.cs;
const tableChars = (api, c, t) => api.layout(c).tables.find((x) => x.block === t.block);

registerFakeRequest('pinTableHeaderRows', (body, api) => {
  const { t } = tableAt(api, body.tableStartLocation);
  const n = body.pinnedHeaderRowsCount || 0;
  if (!Number.isInteger(n) || n < 0 || n > t.block.rows.length) api.fail(`Invalid pinnedHeaderRowsCount: ${n}`);
  t.block.pinned = n;
});

registerFakeRequest('updateTableCellStyle', (body, api) => {
  if (!!body.tableRange === !!body.tableStartLocation) api.fail('Exactly one of tableRange and tableStartLocation must be set.');
  const start = body.tableRange ? (body.tableRange.tableCellLocation || {}).tableStartLocation : body.tableStartLocation;
  const { t } = tableAt(api, start);
  const rows = t.block.rows;
  const g = body.tableRange ? rangeOf(api, rows, body.tableRange) : { r: 0, c: 0, rs: rows.length, cs: colCount(rows) };
  const keys = String(body.fields || '').split(',').map((k) => k.trim()).filter(Boolean);
  const bad = keys.filter((k) => k !== '*' && !CELL_STYLE_FIELDS.includes(k));
  if (!keys.length || bad.length) api.fail(`Invalid field mask for updateTableCellStyle: ${bad.join(', ') || '(empty)'}`);
  const list = keys.includes('*') ? CELL_STYLE_FIELDS : keys;
  const st = body.tableCellStyle || {};
  if ('rowSpan' in st || 'columnSpan' in st) api.fail('rowSpan and columnSpan are read-only.');
  for (const k of list) {
    const b = st[k];
    if (k.startsWith('border') && b && !(b.color && b.color.color && b.color.color.rgbColor && b.width && b.dashStyle)) api.fail(`Invalid ${k}: a border needs color, width and dashStyle.`);
  }
  const cellAt = (r, c) => (rows[r] || [])[c];
  const set = (cell, k, v) => { if (!cell) return; cell.style = cell.style || {}; if (v === undefined) delete cell.style[k]; else cell.style[k] = api.clone(v); };
  const each = (fn) => { for (let r = g.r; r < g.r + g.rs; r++) for (let c = g.c; c < g.c + g.cs; c++) fn(cellAt(r, c), r, c); };
  for (const k of list.filter((x) => !x.startsWith('border'))) each((cell) => set(cell, k, st[k]));
  for (const k of BORDER_ORDER.filter((x) => list.includes(x))) {
    const [o, dr, dc] = OPPOSITE[k];
    each((cell, r, c) => { set(cell, k, st[k]); set(cellAt(r + dr, c + dc), o, st[k]); });
  }
});

registerFakeRequest('mergeTableCells', (body, api) => {
  const tr = body.tableRange || {};
  const { c: box, t } = tableAt(api, (tr.tableCellLocation || {}).tableStartLocation);
  const rows = t.block.rows;
  const g = rangeOf(api, rows, tr);
  if (g.rs * g.cs < 2) api.fail('Invalid table range: merging needs at least two cells.');
  if (spanRegions(rows).some((m) => overlap(m, g) && !within(m, g))) api.fail('The table range is not rectangular: it cuts a merged cell.');
  const before = tableChars(api, box, t);
  const head = rows[g.r][g.c];
  const isEmpty = (cell) => cell.paras.length === 1 && cell.paras[0].text === '';
  let paras = isEmpty(head) ? [] : head.paras;
  for (let r = g.r; r < g.r + g.rs; r++) for (let c = g.c; c < g.c + g.cs; c++) {
    const cell = rows[r][c];
    delete cell.span;
    if (cell === head) continue;
    if (!isEmpty(cell)) paras = [...paras, ...cell.paras];
    cell.paras = [api.emptyPara()];
  }
  head.paras = paras.length ? paras : [api.emptyPara()];
  head.span = [g.rs, g.cs];
  const after = tableChars(api, box, t);
  // The paragraphs moved inside the table: listeners hear the net change at the table's end (approximate).
  if (after.end !== before.end) api.shifted((tr.tableCellLocation || {}).tableStartLocation, before.end, after.end - before.end);
});

registerFakeRequest('unmergeTableCells', (body, api) => {
  const tr = body.tableRange || {};
  const { t } = tableAt(api, (tr.tableCellLocation || {}).tableStartLocation);
  const rows = t.block.rows;
  const g = rangeOf(api, rows, tr);
  for (const m of spanRegions(rows)) if (overlap(m, g)) delete rows[m.r][m.c].span;
});

module.exports = { MIN_WIDTH_PT };
