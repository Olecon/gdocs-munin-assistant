'use strict';
// Module docs-tables.js: tables (the table tool: insert, rows, columns, column widths, header rows, shading, borders,
// merged cells) on top of the line
// model's model.tables, registered through src/registry.js: the cell notation (TABLE_LINE_DECORATOR), the tool
// with its gate and action-log summary (no prompt line: the definition describes it), the 'table' undo kind and the self-test rows.
// Tables are named T1, T2… (model.tables[].n, reading order); rows and columns are 1-based in the arguments, as
// the notation shows them, and 0-based in the API. Only outer tables of the body are changed; cell text is
// edited with the usual text tools (replace_text, insert_after_line work inside a cell).
/* global apiColor, apiEditing, onDemandOffer, commitSequence, dimensionPt, docsApi, docsBatchUpdate, fetchDocModel, hexFromOptionalColor, parseColor, finishEdit, gateEdit, inexactLine, lineAtIndex,
   modelInsertText, NOT_UNDONE, OBJECT_CHAR, ptDimension, registerLineDecorator,
   registerSelfTestRows, registerTools, registerUndoHandler, reqDelete, reqInsert, reqLocation, sanitizeInsertText,
   TABLE_LINE_DECORATOR, writeError, stWriteStep, stWrite, stTool, stPass, stFail, stClip, showText */
/* exported TABLE_TOOL, planTable, planInsertTable, undoTable, tableSignature, tableAt, TABLE_LIMITS, readTableStyle, TABLE_STYLE_FIELDS */

registerLineDecorator(TABLE_LINE_DECORATOR);

const TABLE_LIMITS = { rows: 20, cols: 10, minWidth: 5, maxWidth: 600 };
const TABLE_ACTIONS = ['insert', 'add_row', 'add_column', 'delete_row', 'delete_column', 'set_width', 'header_rows', 'shade', 'borders', 'merge', 'unmerge'];
const BORDER_STYLES = ['grid', 'horizontal', 'outer', 'none'];
const orNull = (type, description, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }], description });
const TABLE_TOOL = { type: 'function', function: {
  name: 'table',
  description: 'Insert a table after line, or change one: add_row / add_column after row or column N of Tn (0 = before the first), delete_row / delete_column, set_width in pt, header_rows (the first rows repeat on every page), borders, and shade / merge / unmerge the cells from row, column (rows × columns of them; null = all). Tables and cells are numbered as read_document shows them ([table T1 …], [r1c2]); edit cell text with replace_text.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: TABLE_ACTIONS },
      line: orNull('integer', 'insert: after it (0 = at the start)'),
      table: orNull('string', '"T1"'),
      row: orNull('integer', 'the row (add_row: after it, 0 = on top)'),
      column: orNull('integer', 'like row'),
      rows: orNull('integer', `insert: 1-${TABLE_LIMITS.rows}; header_rows, shade, merge: count`),
      columns: orNull('integer', `insert: 1-${TABLE_LIMITS.cols}; else count`),
      cells: orNull('array', 'texts row by row [["A","B"],["C","D"]]; a new column [["top","…"]]', { items: { type: 'array', items: { type: 'string' } } }),
      width: orNull('number', `pt (${TABLE_LIMITS.minWidth}-${TABLE_LIMITS.maxWidth}); 0 = automatic`),
      color: orNull('string', 'light grey, grey, light blue, light yellow, none or #RRGGBB'),
      style: orNull('string', 'grid: all lines; horizontal: rules only; outer: a frame', { enum: BORDER_STYLES }),
    },
    required: ['action', 'line', 'table', 'row', 'column', 'rows', 'columns', 'cells', 'width', 'color', 'style'],
    additionalProperties: false,
  },
} };

// ---- Reading the model -------------------------------------------------------------------------------
const sizeText = (r, c) => `${r} row${r === 1 ? '' : 's'} × ${c} column${c === 1 ? '' : 's'}`;
const tableAt = (model, start) => (model.tables || []).find((t) => t.start === start && !t.nested) || null;
// The lines of cell (r, c) of table t (0-based; the cell's own paragraphs, not those of a table nested in it).
// A table's lines are contiguous (firstLine..lastLine, nested tables included): the lookups below scan only them.
const tableLines = (model, t) => model.lines.slice(t.firstLine - 1, t.lastLine);
const cellLines = (model, t, r, c) => tableLines(model, t).filter((l) => l.cell && l.cell.t === t.n && l.cell.r === r && l.cell.c === c);
const cellText = (model, t, r, c) => cellLines(model, t, r, c).map((l) => l.text).join('\n');
const rowTexts = (model, t, r) => Array.from({ length: t.cols }, (_, c) => cellText(model, t, r, c));
const colTexts = (model, t, c) => Array.from({ length: t.rows }, (_, r) => cellText(model, t, r, c));
const rowLineNums = (model, t, r) => tableLines(model, t).filter((l) => l.cell && l.cell.t === t.n && l.cell.r === r).map((l) => l.line);
const colLineNums = (model, t, c) => tableLines(model, t).filter((l) => l.cell && l.cell.t === t.n && l.cell.c === c).map((l) => l.line);
// A short fingerprint of a table's size and cell texts: undo applies only to the table as the edit left it.
function tableSignature(model, t) {
  const texts = Array.from({ length: t.rows }, (_, r) => rowTexts(model, t, r));
  const s = JSON.stringify(texts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${t.rows}x${t.cols}:${h.toString(16)}`;
}
// "T1" / "t1" / "1" / 1 -> 1, else null.
function tableNumber(v) {
  const m = /^\s*T?(\d+)\s*$/i.exec(v == null ? '' : String(v));
  return m ? Number(m[1]) : null;
}
const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const tableRef = (v) => (tableNumber(v) ? `T${tableNumber(v)}` : String(v));

// ---- Requests --------------------------------------------------------------------------------------------
// tableCellLocation of cell (r, c) of the table starting at start (the foundation's Location for the start).
const cellLocation = (model, start, r, c) => ({ tableStartLocation: reqLocation(model, start), rowIndex: r, columnIndex: c });
const reqInsertRow = (model, start, r, below) => ({ insertTableRow: { tableCellLocation: cellLocation(model, start, r, 0), insertBelow: below } });
const reqInsertCol = (model, start, c, right) => ({ insertTableColumn: { tableCellLocation: cellLocation(model, start, 0, c), insertRight: right } });
const reqDeleteRow = (model, start, r) => ({ deleteTableRow: { tableCellLocation: cellLocation(model, start, r, 0) } });
const reqDeleteCol = (model, start, c) => ({ deleteTableColumn: { tableCellLocation: cellLocation(model, start, 0, c) } });
// width: { type, pt } as model.tables[].widths has it; a fixed width needs pt, anything else is reset to even.
function reqWidth(model, start, c, w) {
  const props = w && w.type === 'FIXED_WIDTH' && w.pt ? { widthType: 'FIXED_WIDTH', width: ptDimension(w.pt) } : { widthType: (w && w.type !== 'FIXED_WIDTH' && w.type) || 'EVENLY_DISTRIBUTED' };
  return { updateTableColumnProperties: { tableStartLocation: reqLocation(model, start), columnIndices: [c], tableColumnProperties: props, fields: 'widthType,width' } };
}
// A table is deleted with deleteContentRange over it plus the newline before it, so the paragraph before the
// table and the one after it join again (one of them is the empty paragraph insertTable made).
const reqDeleteTable = (model, t) => reqDelete(model, t.start - 1, t.end);
// insertText of the texts into the cells of table t: grid[i][j] goes to cell (r0 + i, c0 + j) (or, with byCol,
// grid[0][i] to cell (r0 + i, c0): one column). Each cell is empty (new), so the text goes at its paragraph's
// start; back to front so the indices stay valid. Throws when a cell is missing.
function cellTextRequests(model, t, grid, r0, c0, byCol = false) {
  const out = [];
  (grid || []).forEach((row, i) => (row || []).forEach((txt, j) => {
    const text = sanitizeInsertText(modelInsertText(txt)).split(OBJECT_CHAR).join('');
    if (!text) return;
    const [r, c] = byCol ? [r0 + j, c0] : [r0 + i, c0 + j];
    const l = cellLines(model, t, r, c)[0];
    if (!l) throw new Error(`cell [r${r + 1}c${c + 1}] of the new table was not found after the first step`);
    out.push({ at: l.start, req: reqInsert(model, l.start, text) });
  }));
  return out.sort((a, b) => b.at - a.at).map((x) => x.req);
}

// ---- Plans ----------------------------------------------------------------------------------------------
// planTable(model, args) -> { error, short } or a plan for runTable: { steps (commitSequence), region, title,
// cardText, cardLabel, keepsLines?, gate (editGateInfo), journal (the placeholder until the re-read),
// finish(model) (sets journal, done, affected, report from the document read after the edit) }.
function planTable(model, args) {
  const action = String(args.action || '');
  if (!TABLE_ACTIONS.includes(action)) return { error: `action must be one of ${TABLE_ACTIONS.join(', ')}`, short: 'table: invalid action' };
  const cells = args.cells == null ? null : args.cells;
  if (cells !== null && (!Array.isArray(cells) || !cells.every((r) => Array.isArray(r) && r.every((x) => typeof x === 'string' || typeof x === 'number')))) {
    return { error: 'cells must be a list of rows, each a list of plain texts, e.g. [["A","B"],["C","D"]], or null', short: 'table: invalid cells' };
  }
  const grid = cells && cells.map((r) => r.map(String));
  if (action === 'insert') return planInsertTable(model, args, grid);
  const t = pickTable(model, args.table, action);
  if (t.error) return t;
  if (action === 'set_width') return planWidth(model, t, args);
  if (STYLE_PLANS[action]) return STYLE_PLANS[action](model, t, args);
  return action.startsWith('add_') ? planAdd(model, t, action, args, grid) : planRemove(model, t, action, args);
}

function pickTable(model, ref, action) {
  const tables = model.tables || [];
  const n = tableNumber(ref);
  const which = tables.length ? `the document has ${tables.length === 1 ? 'table T1' : `tables T1–T${tables.length}`} (read_document shows each as a [table Tn …] line)` : 'the document has no tables';
  if (ref == null || ref === '') return { error: `table is required for ${action}, e.g. "T1"; ${which}`, short: 'table: no table given' };
  const t = n ? tables.find((x) => x.n === n) : null;
  if (!t) return { error: `there is no table ${tableRef(ref)}; ${which}`, short: `table: no table ${tableRef(ref)}` };
  if (t.nested) return { error: `table T${t.n} is inside a cell of another table; nested tables can only be changed in Google Docs`, short: 'table: nested table' };
  return t;
}

const BLOCKERS = (l) => (!l.exact ? inexactLine(l.line, 'tell the user to make this table change in Google Docs') : l.suggested ? `line ${l.line} contains suggested changes (suggesting mode); accept or reject them first (the comment tool, or in Google Docs)` : '');

// L: the size limits (the panel's own tables, guidelines.js, allow more rows than the model's table tool).
function planInsertTable(model, args, grid, L = TABLE_LIMITS) {
  const total = model.lines.length;
  const n = intOrNull(args.line);
  if (!Number.isInteger(n) || n < 0 || n > total) return { error: `line must be an integer from 0 to ${total}`, short: 'table: invalid line' };
  if (!total) return { error: 'the document has no lines to insert next to', short: 'table: empty document' };
  const rows = intOrNull(args.rows) ?? (grid ? grid.length : null);
  const cols = intOrNull(args.columns) ?? (grid ? Math.max(0, ...grid.map((r) => r.length)) : null);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || rows > L.rows || cols < 1 || cols > L.cols) {
    return { error: `rows must be 1-${L.rows} and columns 1-${L.cols}`, short: 'table: bad size' };
  }
  if (grid && grid.length > rows) return { error: `cells has ${grid.length} rows but the table has ${rows}; pass at most one list of texts per row`, short: 'table: too many rows in cells' };
  const wide = grid ? grid.findIndex((r) => r.length > cols) : -1;
  if (wide >= 0) return { error: `cells row ${wide + 1} has ${grid[wide].length} texts but the table has ${cols} columns`, short: 'table: too many columns in cells' };
  const anchor = n === 0 ? model.lines[0] : model.lines[n - 1];
  if (anchor.cell) {
    const outer = (model.tables || []).find((t) => !t.nested && t.firstLine <= anchor.line && anchor.line <= t.lastLine);
    const after = outer ? outer.lastLine + 1 : anchor.line + 1;
    return { error: `line ${anchor.line} is inside table T${anchor.cell.t}; tables cannot be nested. Insert after line ${after > total ? total : after} or another line outside a table`, short: 'table: nested tables are not supported' };
  }
  const blocked = BLOCKERS(anchor);
  if (blocked) return { error: blocked, short: 'table: the line cannot be used' };
  // At line L's newline (after L) or at line 1's start (line 0): Docs puts a newline there first, so the table
  // starts one index later and an empty paragraph stays after it (after L) or before it (line 0).
  const index = n === 0 ? anchor.start : anchor.end;
  const start = index + 1;
  const where = n === 0 ? 'at the beginning' : `after line ${n}`;
  const filled = !!grid && grid.some((r) => r.some((x) => x !== ''));
  const plan = {
    action: 'insert', region: [Math.max(1, n), Math.max(1, n)], journal: { kind: 'table', anchor: false },
    title: `Inserted a ${rows}×${cols} table ${where}`, cardText: gridText(grid) || `${sizeText(rows, cols)}, empty`, cardLabel: 'Table',
    gate: { what: `inserts a table of ${rows * cols} cells`, range: n === 0 ? 'At the beginning' : `After line ${n}`,
      excerptLabel: 'Cells', excerpt: gridText(grid) || '(empty)' },
    steps: [(m) => ({
      requests: [{ insertTable: { rows, columns: cols, location: reqLocation(m, index) } }],
      rollback: (now) => { const t = tableAt(now, start); return t ? [reqDeleteTable(now, t)] : []; },
    })],
    finish: (m) => {
      const t = tableAt(m, start);
      if (!t) throw new Error('the new table was not found after inserting it');
      plan.journal = { kind: 'table', action: 'insert', anchor: false, start: t.start, sig: tableSignature(m, t), atStart: n === 0 };
      plan.done = `inserted table T${t.n} (${sizeText(rows, cols)}) ${where}`;
      plan.affected = () => [t.firstLine, Math.min(m.lines.length, t.lastLine + 1)];
    },
  };
  // The API cannot fill the cells of a table inserted in the same batch: a second batch writes them.
  if (filled) {
    plan.steps.push((m) => {
      const t = tableAt(m, start);
      if (!t) throw new Error('the new table was not found after inserting it');
      return { requests: cellTextRequests(m, t, grid, 0, 0) };
    });
  }
  return plan;
}
const gridText = (grid) => (grid || []).map((r) => r.join(' | ')).filter((r) => r.replace(/[ |]/g, '')).join('\n');

function planAdd(model, t, action, args, grid) {
  const isRow = action === 'add_row';
  const what = isRow ? 'row' : 'column';
  const count = isRow ? t.rows : t.cols;
  const k = intOrNull(isRow ? args.row : args.column);
  if (!Number.isInteger(k) || k < 0 || k > count) {
    return { error: `table T${t.n} has ${count} ${what}s; ${what} must be 0-${count} (the new ${what} goes after it; 0 = ${isRow ? 'above row 1' : 'left of column 1'})`, short: `table: invalid ${what}` };
  }
  const fill = grid && grid.length ? grid : null;
  if (fill && fill.length > 1) {
    return { error: isRow ? 'cells must hold one row: the new row\'s texts, e.g. [["E","F"]]' : 'cells must hold one list: the new column\'s texts from top to bottom, e.g. [["x","y"]]', short: 'table: invalid cells' };
  }
  const limit = isRow ? t.cols : t.rows;
  if (fill && fill[0].length > limit) return { error: `cells has ${fill[0].length} texts but the table has ${limit} ${isRow ? 'columns' : 'rows'}`, short: 'table: too many texts in cells' };
  const at = k; // the new row/column's 0-based index
  const ref = k === 0 ? 0 : k - 1;
  const insert = (m) => (isRow ? reqInsertRow(m, t.start, ref, k !== 0) : reqInsertCol(m, t.start, ref, k !== 0));
  const remove = (m) => (isRow ? reqDeleteRow(m, t.start, at) : reqDeleteCol(m, t.start, at));
  const plan = {
    action, region: [t.firstLine, t.lastLine], journal: { kind: 'table', anchor: false },
    title: `Added ${what} ${at + 1} to T${t.n}`, cardText: gridText(fill) || `an empty ${what}`, cardLabel: isRow ? 'New row' : 'New column',
    gate: { what: `adds a table ${what}`, range: `Table T${t.n}`, excerptLabel: 'Cells', excerpt: gridText(fill) || '(empty)' },
    steps: [(m) => ({ requests: [insert(m)], rollback: (now) => (tableAt(now, t.start) ? [remove(now)] : []) })],
    finish: (m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the edit');
      plan.journal = { kind: 'table', action, anchor: false, start: nt.start, index: at, sig: tableSignature(m, nt) };
      plan.done = `added ${what} ${at + 1} to table T${nt.n}`;
      const nums = isRow ? rowLineNums(m, nt, at) : colLineNums(m, nt, at);
      plan.affected = () => [nums[0] || nt.firstLine, nums[nums.length - 1] || nt.lastLine];
    },
  };
  if (fill && fill[0].some((x) => x !== '')) {
    plan.steps.push((m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the first step');
      return { requests: isRow ? cellTextRequests(m, nt, fill, at, 0) : cellTextRequests(m, nt, fill, 0, at, true) };
    });
  }
  return plan;
}

function planRemove(model, t, action, args) {
  const isRow = action === 'delete_row';
  const what = isRow ? 'row' : 'column';
  const count = isRow ? t.rows : t.cols;
  const k = intOrNull(isRow ? args.row : args.column);
  if (!Number.isInteger(k) || k < 1 || k > count) return { error: `table T${t.n} has ${count} ${what}s; ${what} must be 1-${count}`, short: `table: invalid ${what}` };
  if (count === 1) {
    return { error: `${what} ${k} is the only ${what} of table T${t.n}; deleting it would delete the whole table. Tell the user to delete the table in Google Docs`, short: `table: the only ${what}` };
  }
  const i = k - 1;
  const spans = (t.merged || []).filter((g) => (isRow ? g.r <= i && i < g.r + g.rowSpan : g.c <= i && i < g.c + g.colSpan));
  if (spans.length) {
    return { error: `the table has merged cells in ${what} ${k}; Google Docs would delete every ${what} they span. Unmerge them first (action unmerge)`, short: 'table: merged cells' };
  }
  const lines = isRow ? rowLineNums(model, t, i) : colLineNums(model, t, i);
  for (const n of lines) {
    const blocked = BLOCKERS(model.lines[n - 1]);
    if (blocked) return { error: blocked, short: `table: the ${what} cannot be deleted` };
  }
  const texts = isRow ? rowTexts(model, t, i) : colTexts(model, t, i);
  const chars = texts.reduce((s, x) => s + x.length, 0);
  const shown = texts.filter((x) => x).map((x) => showText(x).replace(/\n/g, ' ')).join(' | ');
  const plan = {
    action, region: [t.firstLine, t.lastLine], journal: { kind: 'table', anchor: false },
    title: `Deleted ${what} ${k} of T${t.n}`, cardText: shown || `an empty ${what}`, cardLabel: 'Deleted cells',
    gate: { what: chars ? `deletes a table ${what} with ${chars} character${chars === 1 ? '' : 's'} of text; undo restores plain text only` : `deletes an empty table ${what}`,
      range: `Table T${t.n}, ${what} ${k}`, excerptLabel: 'Removed text', excerpt: shown || '(empty)' },
    steps: [(m) => ({ requests: [isRow ? reqDeleteRow(m, t.start, i) : reqDeleteCol(m, t.start, i)] })],
    finish: (m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the edit');
      plan.journal = { kind: 'table', action, anchor: false, start: nt.start, index: i, texts, sig: tableSignature(m, nt) };
      plan.done = `deleted ${what} ${k} of table T${nt.n}`;
      plan.affected = () => [nt.firstLine, nt.lastLine];
    },
  };
  return plan;
}

function planWidth(model, t, args) {
  const k = intOrNull(args.column);
  if (!Number.isInteger(k) || k < 1 || k > t.cols) return { error: `table T${t.n} has ${t.cols} columns; column must be 1-${t.cols}`, short: 'table: invalid column' };
  const w = intOrNull(args.width);
  const L = TABLE_LIMITS;
  if (typeof w !== 'number' || !Number.isFinite(w) || (w !== 0 && (w < L.minWidth || w > L.maxWidth))) {
    return { error: `width must be ${L.minWidth}-${L.maxWidth} pt, or 0 for an automatic width (Google Docs refuses columns narrower than ${L.minWidth} pt)`, short: 'table: invalid width' };
  }
  const c = k - 1;
  const prev = (t.widths || [])[c] || { type: 'EVENLY_DISTRIBUTED', pt: null };
  const next = w ? { type: 'FIXED_WIDTH', pt: w } : { type: 'EVENLY_DISTRIBUTED', pt: null };
  const how = w ? `${w} pt wide` : 'automatic width';
  const plan = {
    action: 'set_width', region: [t.firstLine, t.lastLine], keepsLines: true, journal: { kind: 'table', anchor: false },
    title: `Column ${k} of T${t.n}: ${w ? `${w} pt` : 'automatic'}`, cardText: `column ${k}: ${how}`, cardLabel: 'Column width',
    gate: { what: 'changes a column width', range: `Table T${t.n}, column ${k}`, excerptLabel: 'Width', excerpt: how },
    steps: [(m) => ({ requests: [reqWidth(m, t.start, c, next)] })],
    finish: (m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the edit');
      plan.journal = { kind: 'table', action: 'set_width', anchor: false, start: nt.start, index: c, prev, sig: tableSignature(m, nt) };
      plan.done = w ? `column ${k} of table T${nt.n} is ${w} pt wide` : `column ${k} of table T${nt.n} has an automatic width`;
      plan.affected = () => [nt.firstLine, nt.lastLine];
      plan.report = () => `Table T${nt.n} column widths: ${widthsText(nt)}.`;
    },
  };
  return plan;
}
const widthsText = (t) => (t.widths || []).map((w, i) => `${i + 1}: ${w.type === 'FIXED_WIDTH' && w.pt ? `${w.pt} pt` : 'auto'}`).join(', ') || 'not reported by Google Docs';

// ---- Header rows, shading, borders, merged cells --------------------------------------------------------------
// Row and cell styles are not in the line model's read (DOCS_GET_FIELDS): readTableStyle reads them for the one
// table being changed, before the change (the old values for undo) and after it (to verify). Merged cells are in the
// model (t.merged). Ranges are 0-based { r, c, rs, cs } (first row and column, how many rows and columns).
const TABLE_STYLE_FIELDS = (() => {
  const cell = 'tableCellStyle(rowSpan,columnSpan,backgroundColor,borderTop,borderBottom,borderLeft,borderRight)';
  const body = `documentTab(body(content(startIndex,table(tableRows(tableRowStyle(tableHeader),tableCells(${cell}))))))`;
  const tab = (depth) => `tabProperties(tabId),${body}` + (depth > 1 ? `,childTabs(${tab(depth - 1)})` : '');
  return `tabs(${tab(3)})`;
})();
const BORDER_SIDES = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'];
// Shading names (Google Docs' light palette) before the general color names of parseColor.
const SHADES = { 'light grey': '#F3F3F3', 'light gray': '#F3F3F3', grey: '#D9D9D9', gray: '#D9D9D9', 'light blue': '#CFE2F3', 'light yellow': '#FFF2CC' };
const BORDER_HEX = '#404040';
const THIN_PT = 0.5; // grid lines and the rule under the header row
const RULE_PT = 1; // the rules above and below the table, the frame
// A border can't be transparent: a hidden one has width 0. The API gets every part of it.
const reqBorder = (pt) => ({ color: apiColor(BORDER_HEX), width: ptDimension(pt), dashStyle: 'SOLID' });

// { header (leading rows with tableHeader), anyHeader, cells: [[tableCellStyle]] } of table t as Docs has it now.
async function readTableStyle(model, t) {
  const doc = await docsApi(`${encodeURIComponent(model.docId)}?includeTabsContent=true&fields=${TABLE_STYLE_FIELDS}`);
  const tabs = [];
  const walk = (list) => (list || []).forEach((x) => { tabs.push(x); walk(x.childTabs); });
  walk(doc && doc.tabs);
  const tab = tabs.find((x) => x.tabProperties && x.tabProperties.tabId === model.tabId) || (model.tabId ? null : tabs[0]);
  const body = tab && tab.documentTab && tab.documentTab.body;
  const el = ((body && body.content) || []).find((e) => e.table && (e.startIndex || 0) === t.start);
  if (!el) throw new Error(`table T${t.n} was not found when reading its styles`);
  const rows = el.table.tableRows || [];
  const isHeader = (row) => !!(row && row.tableRowStyle && row.tableRowStyle.tableHeader);
  let header = 0;
  while (header < rows.length && isHeader(rows[header])) header++;
  return { header, anyHeader: rows.some(isHeader), cells: rows.map((row) => (row.tableCells || []).map((c) => c.tableCellStyle || {})) };
}

const fullRange = (t) => ({ r: 0, c: 0, rs: t.rows, cs: t.cols });
const isFull = (t, g) => g.r === 0 && g.c === 0 && g.rs === t.rows && g.cs === t.cols;
const cellName = (r, c) => `[r${r + 1}c${c + 1}]`;
const rangeName = (g) => (g.rs * g.cs === 1 ? cellName(g.r, g.c) : `${cellName(g.r, g.c)}–${cellName(g.r + g.rs - 1, g.c + g.cs - 1)}`);
const regionOf = (m) => ({ r: m.r, c: m.c, rs: m.rowSpan, cs: m.colSpan });
const cellsOverlap = (a, b) => a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs;
const cellsInside = (a, b) => a.r >= b.r && a.c >= b.c && a.r + a.rs <= b.r + b.rs && a.c + a.cs <= b.c + b.cs;
// Cell (r, c) lies under a merged cell without being its head (the API addresses a merged cell by its head).
const coveredCell = (t, r, c) => (t.merged || []).some((m) => r >= m.r && r < m.r + m.rowSpan && c >= m.c && c < m.c + m.colSpan && (r !== m.r || c !== m.c));
const reqTableRange = (model, start, g) => ({ tableCellLocation: cellLocation(model, start, g.r, g.c), rowSpan: g.rs, columnSpan: g.cs });
// updateTableCellStyle over range g (the whole table: tableStartLocation); fields listed but absent from style reset.
const reqCellStyle = (model, t, g, style, fields) => ({ updateTableCellStyle: {
  ...(isFull(t, g) ? { tableStartLocation: reqLocation(model, t.start) } : { tableRange: reqTableRange(model, t.start, g) }),
  tableCellStyle: style, fields: fields.join(',') } });
const reqPin = (model, start, n) => ({ pinTableHeaderRows: { tableStartLocation: reqLocation(model, start), pinnedHeaderRowsCount: n } });

// The cell range of row, column, rows, columns (1-based; a null row = all rows, a null rows = 1 row from row, or all
// rows when row is null too; the same for columns), or { error }.
function cellRange(t, args) {
  const axis = (start, span, count, what) => {
    const k = intOrNull(start) ?? 1;
    const n = intOrNull(span) ?? (intOrNull(start) === null ? count : 1);
    if (!Number.isInteger(k) || k < 1 || k > count) return { error: `table T${t.n} has ${count} ${what}s; ${what} must be 1-${count} (null = all)` };
    if (!Number.isInteger(n) || n < 1 || k + n - 1 > count) return { error: `${what}s must be 1-${count - k + 1} from ${what} ${k} (table T${t.n} has ${count} ${what}s)` };
    return { k: k - 1, n };
  };
  const a = axis(args.row, args.rows, t.rows, 'row');
  if (a.error) return a;
  const b = axis(args.column, args.columns, t.cols, 'column');
  if (b.error) return b;
  return { r: a.k, rs: a.n, c: b.k, cs: b.n };
}

// Old values of the cells of range g as { vals: [JSON texts], grid: [[index into vals]] } (cells mostly share
// them); pick(tableCellStyle) -> { field: value or null }.
function packCells(cells, g, pick) {
  const vals = [];
  const grid = Array.from({ length: g.rs }, (_, i) => Array.from({ length: g.cs }, (_2, j) => {
    const v = JSON.stringify(pick(((cells[g.r + i] || [])[g.c + j]) || {}));
    let k = vals.indexOf(v);
    if (k < 0) { k = vals.length; vals.push(v); }
    return k;
  }));
  return { vals, grid };
}
const pickShade = (st) => ({ backgroundColor: st.backgroundColor || null });
const pickBorders = (st) => Object.fromEntries(BORDER_SIDES.map((k) => [k, st[k] || null]));
// The requests that set the packed values back on range g: one when they are all equal, else one per cell (the
// head of a merged cell only). A null value resets the field.
function restoreCells(model, t, packed, g) {
  const fields = Object.keys(JSON.parse(packed.vals[0] || '{}'));
  const styleOf = (k) => Object.fromEntries(Object.entries(JSON.parse(packed.vals[k])).filter(([, v]) => v != null));
  if (packed.vals.length === 1) return [reqCellStyle(model, t, g, styleOf(0), fields)];
  const out = [];
  packed.grid.forEach((row, i) => row.forEach((k, j) => {
    const r = g.r + i;
    const c = g.c + j;
    if (r < t.rows && c < t.cols && !coveredCell(t, r, c)) out.push(reqCellStyle(model, t, { r, c, rs: 1, cs: 1 }, styleOf(k), fields));
  }));
  return out;
}

// A plan of the style actions: no line moves (keepsLines) unless set otherwise; prepare(model) reads what undo
// needs before the change, verify(model) compares the result read after it (a note, or '').
function stylePlan(t, action, fields) {
  const plan = { action, region: [t.firstLine, t.lastLine], keepsLines: true, journal: { kind: 'table', anchor: false }, ...fields };
  plan.finish = (m) => {
    const nt = tableAt(m, t.start);
    if (!nt) throw new Error('the table was not found after the edit');
    plan.journal = { kind: 'table', action, anchor: false, start: nt.start, sig: tableSignature(m, nt), ...plan.undoData };
    plan.done = plan.doneText(nt);
    plan.affected = () => [nt.firstLine, nt.lastLine];
  };
  return plan;
}
const tableAfter = (m, t) => { const nt = tableAt(m, t.start); if (!nt) throw new Error('the table was not found after the edit'); return nt; };
const countText = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function planHeaderRows(model, t, args) {
  const n = intOrNull(args.rows);
  const max = Math.max(0, t.rows - 1);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    return { error: `table T${t.n} has ${countText(t.rows, 'row')}; rows must be 0-${max} (how many top rows repeat on every page; 0 = none; the last row cannot be a header)`, short: 'table: invalid rows' };
  }
  const what = n ? `the first ${n === 1 ? 'row repeats' : `${n} rows repeat`} on every page` : 'no header rows';
  const plan = stylePlan(t, 'header_rows', {
    title: `Header rows of T${t.n}: ${n}`, cardText: what, cardLabel: 'Header rows',
    gate: { what: 'changes the header rows of a table', range: `Table T${t.n}`, excerptLabel: 'Header rows', excerpt: what },
    steps: [(m) => ({ requests: [reqPin(m, t.start, n)] })],
    prepare: async (m) => { plan.undoData = { prev: (await readTableStyle(m, t)).header }; },
    verify: async (m) => {
      const s = await readTableStyle(m, tableAfter(m, t));
      if (s.header === n) return '';
      if (n && !s.anyHeader) return 'Note: Google Docs did not report the header rows back; ask the user to check them in Google Docs (Table properties).';
      return `Note: Google Docs reports ${countText(s.header, 'header row')} instead of ${n}.`;
    },
    doneText: (nt) => (n ? `in table T${nt.n} ${what}` : `table T${nt.n} has no header rows`),
  });
  return plan;
}

// A color argument for shading -> { hex } ('#RRGGBB', or null for none), or null.
function shadeColor(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (SHADES[s]) return { hex: SHADES[s] };
  const c = parseColor(s);
  return c ? { hex: c.none ? null : c.hex } : null;
}

function planShade(model, t, args) {
  const color = shadeColor(args.color);
  if (!color) return { error: `color must be light grey, grey, light blue, light yellow, none, or a hex code such as #DDEEFF; got ${JSON.stringify(args.color ?? null)}`, short: 'table: invalid color' };
  const g = cellRange(t, args);
  if (g.error) return { error: g.error, short: 'table: invalid cells' };
  const key = String(args.color).trim().toLowerCase().replace(/\s+/g, ' ');
  const name = !color.hex ? 'no shading' : SHADES[key] ? key : color.hex;
  const where = isFull(t, g) ? 'all cells' : `cells ${rangeName(g)}`;
  const plan = stylePlan(t, 'shade', {
    title: `Shaded ${where} of T${t.n}: ${name}`, cardText: `${where}: ${name}`, cardLabel: 'Shading',
    gate: { what: 'shades table cells', range: `Table T${t.n}, ${where}`, excerptLabel: 'Shading', excerpt: name },
    steps: [(m) => ({ requests: [reqCellStyle(m, t, g, color.hex ? { backgroundColor: apiColor(color.hex) } : {}, ['backgroundColor'])] })],
    prepare: async (m) => { plan.undoData = { range: g, prev: packCells((await readTableStyle(m, t)).cells, g, pickShade) }; },
    verify: async (m) => {
      const nt = tableAfter(m, t);
      const s = await readTableStyle(m, nt);
      const off = [];
      for (let r = g.r; r < g.r + g.rs; r++) for (let c = g.c; c < g.c + g.cs; c++) {
        if (coveredCell(nt, r, c)) continue;
        const got = hexFromOptionalColor(((s.cells[r] || [])[c] || {}).backgroundColor);
        if (got !== color.hex) off.push(`${cellName(r, c)} ${got || 'none'}`);
      }
      return off.length ? `Note: Google Docs reports a different shading in ${off.slice(0, 5).join(', ')}${off.length > 5 ? ` and ${off.length - 5} more` : ''}.` : '';
    },
    doneText: (nt) => `${where} of table T${nt.n} ${color.hex ? `are shaded ${name}` : 'have no shading'}`,
  });
  return plan;
}

// The border width (pt) style gives side k of cell (r, c) in table t with h header rows.
function borderWant(style, t, h, r, c, k) {
  const outerSide = (k === 'borderTop' && r === 0) || (k === 'borderBottom' && r === t.rows - 1) || (k === 'borderLeft' && c === 0) || (k === 'borderRight' && c === t.cols - 1);
  if (style === 'grid') return THIN_PT;
  if (style === 'outer') return outerSide ? RULE_PT : 0;
  if (style === 'horizontal') {
    if ((k === 'borderTop' && r === 0) || (k === 'borderBottom' && r === t.rows - 1)) return RULE_PT;
    if ((k === 'borderBottom' && r === h - 1) || (k === 'borderTop' && r === h)) return THIN_PT;
    return 0;
  }
  return 0;
}
// The requests of a border style: every border of every cell first, then the rules and the frame over ranges (a
// border shared by two cells changes on both).
function borderRequests(model, t, style, h) {
  const all = (pt) => reqCellStyle(model, t, fullRange(t), Object.fromEntries(BORDER_SIDES.map((k) => [k, reqBorder(pt)])), BORDER_SIDES);
  const side = (g, k, pt) => reqCellStyle(model, t, g, { [k]: reqBorder(pt) }, [k]);
  const row = (r) => ({ r, c: 0, rs: 1, cs: t.cols });
  const col = (c) => ({ r: 0, c, rs: t.rows, cs: 1 });
  if (style === 'grid') return [all(THIN_PT)];
  if (style === 'none') return [all(0)];
  const out = [all(0), side(row(0), 'borderTop', RULE_PT), side(row(t.rows - 1), 'borderBottom', RULE_PT)];
  if (style === 'outer') out.push(side(col(0), 'borderLeft', RULE_PT), side(col(t.cols - 1), 'borderRight', RULE_PT));
  else if (h < t.rows) out.push(side(row(h - 1), 'borderBottom', THIN_PT));
  return out;
}
const BORDER_TEXT = { grid: 'all lines', horizontal: 'rules above and below and under the header row', outer: 'a frame only', none: 'no lines' };

function planBorders(model, t, args) {
  const style = String(args.style || '');
  if (!BORDER_STYLES.includes(style)) return { error: `style must be one of ${BORDER_STYLES.join(', ')}`, short: 'table: invalid style' };
  const plan = stylePlan(t, 'borders', {
    title: `Borders of T${t.n}: ${style}`, cardText: BORDER_TEXT[style], cardLabel: 'Borders',
    gate: { what: 'changes the borders of a table', range: `Table T${t.n}`, excerptLabel: 'Borders', excerpt: BORDER_TEXT[style] },
    // The header rows (for the rule under them) are known after prepare; at least one.
    steps: [(m) => ({ requests: borderRequests(m, t, style, plan.header) })],
    prepare: async (m) => {
      const s = await readTableStyle(m, t);
      plan.header = Math.min(Math.max(1, s.header), t.rows);
      plan.undoData = { prev: packCells(s.cells, fullRange(t), pickBorders) };
    },
    verify: async (m) => {
      const nt = tableAfter(m, t);
      const s = await readTableStyle(m, nt);
      const off = [];
      for (let r = 0; r < nt.rows; r++) for (let c = 0; c < nt.cols; c++) {
        if (coveredCell(nt, r, c)) continue;
        const st = (s.cells[r] || [])[c] || {};
        const bad = BORDER_SIDES.filter((k) => Math.abs((dimensionPt(st[k] && st[k].width) ?? -1) - borderWant(style, nt, plan.header, r, c, k)) > 0.01);
        if (bad.length) off.push(cellName(r, c));
      }
      return off.length ? `Note: Google Docs reports other borders on ${off.slice(0, 5).join(', ')}${off.length > 5 ? ` and ${off.length - 5} more cells` : ''}; check the table.` : '';
    },
    doneText: (nt) => `table T${nt.n} has ${BORDER_TEXT[style]}`,
  });
  return plan;
}

// The smallest range around g that cuts no merged cell of t (the range merge would accept).
function mergeHull(t, g) {
  let h = { ...g };
  for (let changed = true; changed;) {
    changed = false;
    for (const m of (t.merged || []).map(regionOf)) {
      if (cellsOverlap(m, h) && !cellsInside(m, h)) {
        const r2 = Math.max(h.r + h.rs, m.r + m.rs);
        const c2 = Math.max(h.c + h.cs, m.c + m.cs);
        h = { r: Math.min(h.r, m.r), c: Math.min(h.c, m.c) };
        h.rs = r2 - h.r; h.cs = c2 - h.c;
        changed = true;
      }
    }
  }
  return h;
}
const rangeArgs = (g) => `row ${g.r + 1}, column ${g.c + 1}, rows ${g.rs}, columns ${g.cs}`;
const MERGE_UNDO_NOTE = 'Note: the cells were unmerged; their text stays joined in the first cell (Google Docs does not split it again).';

function planMerge(model, t, args) {
  const g = cellRange(t, args);
  if (g.error) return { error: g.error, short: 'table: invalid cells' };
  if (g.rs * g.cs < 2) return { error: 'merge needs at least two cells: give rows or columns greater than 1', short: 'table: one cell' };
  const hull = mergeHull(t, g);
  if (hull.rs !== g.rs || hull.cs !== g.cs) {
    return { error: `cells ${rangeName(g)} cut a merged cell, so the range is not rectangular; merge ${rangeName(hull)} instead (${rangeArgs(hull)})`, short: 'table: range cuts a merged cell' };
  }
  const lines = tableLines(model, t).filter((l) => l.cell && l.cell.t === t.n && l.cell.r >= g.r && l.cell.r < g.r + g.rs && l.cell.c >= g.c && l.cell.c < g.c + g.cs);
  for (const l of lines) {
    const blocked = BLOCKERS(l);
    if (blocked) return { error: blocked, short: 'table: the cells cannot be merged' };
  }
  const texts = [];
  for (let r = g.r; r < g.r + g.rs; r++) for (let c = g.c; c < g.c + g.cs; c++) texts.push(cellText(model, t, r, c));
  const filled = texts.filter((x) => x !== '');
  const shown = filled.map((x) => showText(x).replace(/\n/g, ' ')).join(' | ');
  const head = cellName(g.r, g.c);
  const plan = {
    action: 'merge', region: [t.firstLine, t.lastLine], journal: { kind: 'table', anchor: false },
    title: `Merged cells ${rangeName(g)} of T${t.n}`, cardText: shown || 'empty cells', cardLabel: 'Merged cells',
    gate: { what: filled.length > 1 ? `merges ${g.rs * g.cs} cells and joins the text of ${filled.length} of them in ${head}; undo does not split it again` : `merges ${g.rs * g.cs} table cells`,
      range: `Table T${t.n}, cells ${rangeName(g)}`, excerptLabel: 'Joined text', excerpt: shown || '(empty)' },
    steps: [(m) => ({ requests: [{ mergeTableCells: { tableRange: reqTableRange(m, t.start, g) } }] })],
    refusedHint: `Google Docs merges only a rectangular block of cells that cuts no merged cell; check the table with read_document and give row, column, rows and columns of such a block.`,
    finish: (m) => {
      const nt = tableAfter(m, t);
      plan.journal = { kind: 'table', action: 'merge', anchor: false, start: nt.start, sig: tableSignature(m, nt), range: g };
      const ok = (nt.merged || []).some((x) => x.r === g.r && x.c === g.c && x.rowSpan === g.rs && x.colSpan === g.cs);
      plan.done = `merged cells ${rangeName(g)} of table T${nt.n} into ${head}` + (filled.length > 1 ? `; their texts are now joined in ${head}, and undo unmerges the cells but leaves the text joined` : '');
      if (!ok) plan.notes = [...(plan.notes || []), `Note: Google Docs does not report ${head} as a merged cell of ${g.rs} × ${g.cs}; check the table.`];
      const nums = tableLines(m, nt).filter((l) => l.cell && l.cell.t === nt.n && l.cell.r === g.r && l.cell.c === g.c).map((l) => l.line);
      plan.affected = () => [nums[0] || nt.firstLine, nums[nums.length - 1] || nt.lastLine];
    },
  };
  return plan;
}

function planUnmerge(model, t, args) {
  const g = cellRange(t, args);
  if (g.error) return { error: g.error, short: 'table: invalid cells' };
  const regions = (t.merged || []).map(regionOf).filter((m) => cellsOverlap(m, g));
  if (!regions.length) {
    const list = (t.merged || []).map((m) => `${cellName(m.r, m.c)} (${m.rowSpan} × ${m.colSpan})`).join(', ');
    return { error: `there are no merged cells in ${rangeName(g)} of table T${t.n}; ${list ? `its merged cells: ${list}` : 'it has no merged cells'}`, short: 'table: nothing to unmerge' };
  }
  const names = regions.map((m) => cellName(m.r, m.c)).join(', ');
  const plan = {
    action: 'unmerge', region: [t.firstLine, t.lastLine], journal: { kind: 'table', anchor: false },
    title: `Unmerged cells ${rangeName(g)} of T${t.n}`, cardText: `merged cells ${names}`, cardLabel: 'Unmerged cells',
    gate: { what: 'unmerges table cells', range: `Table T${t.n}, cells ${rangeName(g)}`, excerptLabel: 'Merged cells', excerpt: names },
    steps: [(m) => ({ requests: [{ unmergeTableCells: { tableRange: reqTableRange(m, t.start, g) } }] })],
    finish: (m) => {
      const nt = tableAfter(m, t);
      plan.journal = { kind: 'table', action: 'unmerge', anchor: false, start: nt.start, sig: tableSignature(m, nt), regions };
      const left = (nt.merged || []).map(regionOf).filter((x) => cellsOverlap(x, g));
      plan.done = `unmerged ${names} of table T${nt.n}; the text stays in the first cell of each`;
      if (left.length) plan.notes = [...(plan.notes || []), `Note: Google Docs still reports merged cells at ${left.map((x) => cellName(x.r, x.c)).join(', ')}.`];
      plan.affected = () => [nt.firstLine, nt.lastLine];
    },
  };
  return plan;
}
const STYLE_PLANS = { header_rows: planHeaderRows, shade: planShade, borders: planBorders, merge: planMerge, unmerge: planUnmerge };

// ---- The tool ---------------------------------------------------------------------------------------------
async function runTable(name, args, snap, ui, call) {
  if (String(args.action) === 'insert' && snap.responseWrite) {
    return writeError('line numbers changed after the previous edit in this response, so this table insert was not applied; re-read with read_document and call it again with the current numbers.', 'table: line numbers changed by the previous edit; not applied');
  }
  const plan = planTable(snap.model, args);
  if (plan.error) return writeError(plan.error, plan.short);
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  if (plan.prepare) {
    try { await plan.prepare(snap.model); } catch (e) {
      return writeError(`the table's current styles could not be read (${e.message}), so nothing was changed; try again.`, 'table: styles not read; not applied');
    }
  }
  const res = await commitSequence(snap, plan, call.id, plan.steps);
  if (res.fail) {
    // A refusal by the API (merge: a range that is not rectangular) gets the fix appended.
    if (plan.refusedHint && /rejected the edit/.test(res.fail.content || '')) res.fail.content += `\n${plan.refusedHint}`;
    return res.fail;
  }
  if (plan.verify) {
    let note;
    try { note = await plan.verify(res.model); } catch (e) { note = `Note: the result could not be read back to check it (${e.message}).`; }
    if (note) plan.notes = [...(plan.notes || []), note];
  }
  try { plan.finish(res.model); } catch (e) {
    plan.journal = { kind: 'table', anchor: false, undoable: false };
    plan.done = `${plan.title.charAt(0).toLowerCase()}${plan.title.slice(1)} (${e.message}; it cannot be undone from the panel)`;
    plan.affected = () => plan.region;
  }
  return finishEdit(snap, plan, call.id, res.model);
}

function tableSummary(name, args) {
  const T = tableRef(args.table);
  const a = args.action;
  if (a === 'insert') return `insert ${args.rows ?? (args.cells || []).length}×${args.columns ?? '?'} ${Number(args.line) === 0 ? 'at the beginning' : `after line ${args.line}`}`;
  if (a === 'add_row' || a === 'add_column') {
    const w = a === 'add_row' ? 'row' : 'column';
    const k = Number(a === 'add_row' ? args.row : args.column);
    return `add ${w} ${k === 0 ? `before ${w} 1` : `after ${w} ${k}`} of ${T}`;
  }
  if (a === 'delete_row') return `delete row ${args.row} of ${T}`;
  if (a === 'delete_column') return `delete column ${args.column} of ${T}`;
  if (a === 'set_width') return `column ${args.column} of ${T}: ${Number(args.width) ? `${args.width} pt` : 'automatic'}`;
  if (a === 'header_rows') return `header rows of ${T}: ${args.rows ?? '?'}`;
  if (a === 'borders') return `borders of ${T}: ${args.style || '?'}`;
  if (a === 'shade' || a === 'merge' || a === 'unmerge') {
    const g = (t0, n) => (t0 == null ? 'all' : n > 1 ? `${t0}-${Number(t0) + n - 1}` : String(t0));
    const where = args.row == null && args.column == null ? 'all cells' : `rows ${g(args.row, args.rows)}, columns ${g(args.column, args.columns)}`;
    return `${a} ${where} of ${T}${a === 'shade' ? `: ${args.color || '?'}` : ''}`;
  }
  return String(a || '');
}

// On demand on Munin and custom servers (request.js onDemandOffer): when the message is about tables or the document has one.
const TABLE_WORDS_RE = /\b(?:tables?|columns?|rows?|cells?)\b|таблиц|столбц|колонк|ячейк/i;
const docHasTable = (snap) => { const m = (snap.promptView && snap.promptView.model) || snap.model; return !!(m && (m.tables || []).length); };
registerTools(TABLE_TOOL, {
  offer: (mode, snap) => apiEditing(mode, snap) && onDemandOffer(snap, (t) => TABLE_WORDS_RE.test(t), docHasTable(snap)),
  runs: (mode, snap) => apiEditing(mode, snap),
  reading: false,
  pending: 'Changing a table…',
  summary: tableSummary,
  gate: (name, plan) => plan.gate,
  run: runTable,
});

// ---- Undo ---------------------------------------------------------------------------------------------------
// The table of a journal entry as the edit left it: at its start with the same size and cell texts, or else the
// only outer table with that signature (text was inserted or deleted above it since). Throws otherwise.
function journaledTable(model, edit) {
  const outer = (model.tables || []).filter((t) => !t.nested);
  const at = outer.find((t) => t.start === edit.start);
  if (at && tableSignature(model, at) === edit.sig) return at;
  const same = outer.filter((t) => tableSignature(model, t) === edit.sig);
  if (same.length === 1) return same[0];
  throw new Error(`the table of that edit changed after it (or is gone), ${NOT_UNDONE}`);
}
const RESTORED_NOTE = (what) => `Note: the ${what} was re-created with its plain text; formatting and images in it were not restored.`;

// undoEdit for kind 'table': insert -> the table deleted; add_row / add_column -> deleted; delete_row /
// delete_column -> re-inserted with the plain text of each cell (lossy); set_width -> the previous width;
// header_rows -> the previous count pinned; shade / borders -> the cells' previous values (read before the edit);
// merge -> unmerged (lossy: the text stays joined in the head cell); unmerge -> the cells merged again.
async function undoTable(edit) {
  const read = () => fetchDocModel(edit.docId, edit.tabId);
  let model = await read();
  const t = journaledTable(model, edit);
  const isRow = /_row$/.test(edit.action);
  let note;
  if (edit.action === 'insert') {
    // Joining the paragraphs around the table must not join text: the one insertTable made must still be empty.
    const side = edit.atStart ? lineAtIndex(model, t.start - 1) : lineAtIndex(model, t.end);
    if (!side || side.text !== '') throw new Error(`the empty line ${edit.atStart ? 'before' : 'after'} the table is no longer empty, ${NOT_UNDONE}`);
    const line = lineAtIndex(model, t.start - 1);
    await docsBatchUpdate(model, [reqDeleteTable(model, t)]);
    const now = await read();
    const back = lineAtIndex(now, t.start - 1) || line;
    return { model: now, restored: '', lostObjects: false, range: back ? [back.line, back.line] : [1, 1] };
  }
  if (edit.action === 'set_width') {
    await docsBatchUpdate(model, [reqWidth(model, t.start, edit.index, edit.prev)]);
  } else if (edit.action === 'header_rows') {
    await docsBatchUpdate(model, [reqPin(model, t.start, Math.min(edit.prev || 0, Math.max(0, t.rows - 1)))]);
  } else if (edit.action === 'shade' || edit.action === 'borders') {
    await docsBatchUpdate(model, restoreCells(model, t, edit.prev, edit.range || fullRange(t)));
  } else if (edit.action === 'merge') {
    await docsBatchUpdate(model, [{ unmergeTableCells: { tableRange: reqTableRange(model, t.start, edit.range) } }]);
    note = MERGE_UNDO_NOTE;
  } else if (edit.action === 'unmerge') {
    await docsBatchUpdate(model, edit.regions.map((g) => ({ mergeTableCells: { tableRange: reqTableRange(model, t.start, g) } })));
  } else if (edit.action === 'add_row' || edit.action === 'add_column') {
    if ((isRow ? t.rows : t.cols) < 2) throw new Error(`that ${isRow ? 'row' : 'column'} is the only one left, ${NOT_UNDONE}`);
    await docsBatchUpdate(model, [isRow ? reqDeleteRow(model, t.start, edit.index) : reqDeleteCol(model, t.start, edit.index)]);
  } else if (edit.action === 'delete_row' || edit.action === 'delete_column') {
    const i = edit.index;
    const ref = i === 0 ? 0 : i - 1;
    await docsBatchUpdate(model, [isRow ? reqInsertRow(model, t.start, ref, i !== 0) : reqInsertCol(model, t.start, ref, i !== 0)]);
    const texts = edit.texts || [];
    if (texts.some((x) => x)) {
      model = await read();
      const nt = tableAt(model, t.start);
      try {
        if (!nt) throw new Error('the table was not found after re-inserting the ' + (isRow ? 'row' : 'column'));
        const lost = texts.some((x) => x.includes(OBJECT_CHAR));
        await docsBatchUpdate(model, isRow ? cellTextRequests(model, nt, [texts], i, 0) : cellTextRequests(model, nt, [texts], 0, i, true));
        note = RESTORED_NOTE(isRow ? 'row' : 'column') + (lost ? ' Embedded objects (images, chips) were left out.' : '');
      } catch (e) {
        // Not half done: the empty row or column goes again.
        try { const m2 = await read(); const t2 = tableAt(m2, t.start); if (t2) await docsBatchUpdate(m2, [isRow ? reqDeleteRow(m2, t2.start, i) : reqDeleteCol(m2, t2.start, i)]); } catch (e2) { /* reported below */ }
        throw new Error(`the ${isRow ? 'row' : 'column'} could not be filled with its text again (${e.message}), ${NOT_UNDONE}`);
      }
    } else note = RESTORED_NOTE(isRow ? 'row' : 'column');
  } else throw new Error(`there is nothing to undo for that edit.`);
  const now = await read();
  const nt = tableAt(now, t.start);
  return { model: now, restored: '', lostObjects: false, range: nt ? [nt.firstLine, nt.lastLine] : [1, 1], ...(note ? { note } : {}) };
}
registerUndoHandler('table', undoTable);

// ---- Self-test ------------------------------------------------------------------------------------------------
// Write: table (Docs API write cycle, on the two test lines): a 2×2 table with texts after the paragraph, read
// back in notation; a row added, a width set, the row deleted; three undos restore each state, the fourth
// deletes the table: the document reads as before. Whether Docs left the empty paragraph after it is reported.
const ST_TABLE_ARGS = { action: null, line: null, table: null, row: null, column: null, rows: null, columns: null, cells: null, width: null, color: null, style: null };
const stTableArgs = (over) => ({ ...ST_TABLE_ARGS, ...over });
function stTableState(m) {
  const t = (m.tables || [])[0];
  return t ? { rows: t.rows, cols: t.cols, texts: Array.from({ length: t.rows }, (_, r) => rowTexts(m, t, r)), width: (t.widths || [])[0] || null } : null;
}
const stTableRun = (ctx) => stWriteStep(stTableSteps)(ctx);
async function stTableSteps(ctx, ph) {
  const T0 = ctx.snap.model.text;
  const n = ph.line;
  await stWrite(ctx, 'table', stTableArgs({ action: 'insert', line: n, rows: 2, columns: 2, cells: [['A', 'B'], ['C', 'D']] }));
  let m = ctx.snap.model;
  const t = (m.tables || [])[0];
  if (!t || t.rows !== 2 || t.cols !== 2) return stFail(`after the insert the document has no 2×2 table (${(m.tables || []).length} tables)`);
  const r = await stTool(ctx, 'read_document', { scope: { start: n + 1, end: t.lastLine + 1 }, include: ['text'], doc: null });
  const head = `[table T1: 2 rows × 2 columns, lines ${t.firstLine}–${t.lastLine}]`;
  if (!r.content.includes(`${head}\n${t.firstLine} [r1c1]: A\n${t.firstLine + 1} [r1c2]: B`)) return stFail('read_document does not show the table in notation', stClip(r.content, 600));
  const after = m.lines[t.lastLine];
  const tail = after && after.text === '' ? 'Docs left an empty paragraph after the table' : 'no empty paragraph after the table';
  const s1 = JSON.stringify(stTableState(m));
  await stWrite(ctx, 'table', stTableArgs({ action: 'add_row', table: 'T1', row: 2, cells: [['E', 'F']] }));
  const s2 = JSON.stringify(stTableState(ctx.snap.model));
  if (JSON.parse(s2).texts[2].join('|') !== 'E|F') return stFail(`after add_row row 3 reads ${stClip(JSON.parse(s2).texts[2].join(' | '))}`);
  await stWrite(ctx, 'table', stTableArgs({ action: 'set_width', table: 'T1', column: 1, width: 100 }));
  const w = stTableState(ctx.snap.model).width;
  if (!w || w.type !== 'FIXED_WIDTH' || w.pt !== 100) return stFail(`after set_width column 1 reads ${JSON.stringify(w)}, expected FIXED_WIDTH 100 pt`);
  const s3 = JSON.stringify(stTableState(ctx.snap.model));
  // editAll keeps any card away from the self-test's own edit (the gate has unit tests).
  const allowAll = ctx.snap.editAll;
  ctx.snap.editAll = true;
  try { await stWrite(ctx, 'table', stTableArgs({ action: 'delete_row', table: 'T1', row: 3 })); } finally { ctx.snap.editAll = allowAll; }
  if (stTableState(ctx.snap.model).rows !== 2) return stFail('after delete_row the table does not have 2 rows');
  for (const [step, want] of [['undo 1 (delete_row)', s3], ['undo 2 (set_width)', s2], ['undo 3 (add_row)', s1]]) {
    await stWrite(ctx, 'undo_last_edit', {});
    const got = JSON.stringify(stTableState(ctx.snap.model));
    if (got !== want) return stFail(`${step}: the table reads ${stClip(got, 200)}`, `expected: ${want}`);
  }
  await stWrite(ctx, 'undo_last_edit', {});
  m = ctx.snap.model;
  if ((m.tables || []).length || m.text !== T0) return stFail('undo of the insert did not restore the document', `lines: ${stClip(m.lines.map((l) => l.text).join(' / '), 300)}`);
  return stPass(`T1 2×2 after line ${n} reads [r1c1] A…; add_row, set_width 100 pt, delete_row; undone four times: the document is as before · ${tail}`);
}

registerSelfTestRows([
  { name: 'Write: table', run: stTableRun },
]);
