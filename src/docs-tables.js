'use strict';
// Module docs-tables.js: tables (the table tool: insert, rows, columns, column widths) on top of the line
// model's model.tables, registered through src/registry.js: the cell notation (TABLE_LINE_DECORATOR), the tool
// with its gate, prompt line and action-log summary, the 'table' undo kind and the self-test rows.
// Tables are named T1, T2… (model.tables[].n, reading order); rows and columns are 1-based in the arguments, as
// the notation shows them, and 0-based in the API. Only outer tables of the body are changed; cell text is
// edited with the usual text tools (replace_text, insert_after_line work inside a cell).
/* global apiEditing, commitSequence, docsBatchUpdate, fetchDocModel, finishEdit, gateEdit, gateExcerpt, lineAtIndex,
   changedLinesReport, modelInsertText, OBJECT_CHAR, ptDimension, registerLineDecorator,
   registerSelfTestRows, registerTools, registerUndoHandler, reqDelete, reqInsert, reqLocation, sanitizeInsertText,
   TABLE_LINE_DECORATOR, writeError, stWriteStep, stWrite, stTool, stPass, stFail, stClip, showText */
/* exported TABLE_TOOL, planTable, planInsertTable, undoTable, tableSignature, tableAt, TABLE_LIMITS */

registerLineDecorator(TABLE_LINE_DECORATOR);

const TABLE_LIMITS = { rows: 20, cols: 10, gateCells: 50, minWidth: 5, maxWidth: 600 };
const TABLE_ACTIONS = ['insert', 'add_row', 'add_column', 'delete_row', 'delete_column', 'set_width'];
const orNull = (type, description, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }], description });
const TABLE_TOOL = { type: 'function', function: {
  name: 'table',
  description: 'Insert a table or change its structure: insert a new table after a line (with cell texts); add_row / add_column after row or column N of table Tn (0 = before the first); delete_row / delete_column; set_width of a column in pt. Tables, rows and columns are numbered as read_lines shows them ([table T1 …], [r1c2]). Cell text is edited with replace_text / insert_after_line. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: TABLE_ACTIONS },
      line: orNull('integer', 'insert: the line after which the table goes (0 = at the beginning).'),
      table: orNull('string', 'The table to change, e.g. "T1" (not for insert).'),
      row: orNull('integer', 'add_row: the new row goes after this row (0 = above row 1); delete_row: the row to delete.'),
      column: orNull('integer', 'Like row, for add_column / delete_column; set_width: the column.'),
      rows: orNull('integer', `insert: number of rows (1-${TABLE_LIMITS.rows}).`),
      columns: orNull('integer', `insert: number of columns (1-${TABLE_LIMITS.cols}).`),
      cells: orNull('array', 'Plain cell texts row by row: insert [["A","B"],["C","D"]]; add_row [[the new row]]; add_column [[the new column, top to bottom]]; null = empty.', { items: { type: 'array', items: { type: 'string' } } }),
      width: orNull('number', `set_width: the width in pt (${TABLE_LIMITS.minWidth}-${TABLE_LIMITS.maxWidth}); 0 = automatic.`),
    },
    required: ['action', 'line', 'table', 'row', 'column', 'rows', 'columns', 'cells', 'width'],
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
  return action.startsWith('add_') ? planAdd(model, t, action, args, grid) : planRemove(model, t, action, args);
}

function pickTable(model, ref, action) {
  const tables = model.tables || [];
  const n = tableNumber(ref);
  const which = tables.length ? `the document has ${tables.length === 1 ? 'table T1' : `tables T1–T${tables.length}`} (read_lines shows each as a [table Tn …] line)` : 'the document has no tables';
  if (ref == null || ref === '') return { error: `table is required for ${action}, e.g. "T1"; ${which}`, short: 'table: no table given' };
  const t = n ? tables.find((x) => x.n === n) : null;
  if (!t) return { error: `there is no table ${tableRef(ref)}; ${which}`, short: `table: no table ${tableRef(ref)}` };
  if (t.nested) return { error: `table T${t.n} is inside a cell of another table; nested tables can only be changed in Google Docs`, short: 'table: nested table' };
  return t;
}

const BLOCKERS = (l) => (!l.exact ? `the positions in line ${l.line} cannot be mapped exactly` : l.suggested ? `line ${l.line} contains suggested changes (suggesting mode); accept or reject them in Google Docs first` : '');

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
    gate: { large: rows * cols > L.gateCells, what: `inserts a table of ${rows * cols} cells`, range: n === 0 ? 'At the beginning' : `After line ${n}`,
      excerptLabel: 'Cells', excerpt: gateExcerpt(gridText(grid) || '(empty)') },
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
    gate: { large: false, what: `adds a table ${what}`, range: `Table T${t.n}`, excerptLabel: 'Cells', excerpt: gateExcerpt(gridText(fill) || '(empty)') },
    steps: [(m) => ({ requests: [insert(m)], rollback: (now) => (tableAt(now, t.start) ? [remove(now)] : []) })],
    finish: (m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the edit');
      plan.journal = { kind: 'table', action, anchor: false, start: nt.start, index: at, sig: tableSignature(m, nt) };
      plan.done = `added ${what} ${at + 1} to table T${nt.n}`;
      const nums = isRow ? rowLineNums(m, nt, at) : colLineNums(m, nt, at);
      plan.affected = () => [nums[0] || nt.firstLine, nums[nums.length - 1] || nt.lastLine];
      plan.report = (mm) => changedLinesReport(mm, nums);
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
    return { error: `the table has merged cells in ${what} ${k}; Google Docs would delete every ${what} they span. Unmerge them in Google Docs first`, short: 'table: merged cells' };
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
    gate: { large: chars > 0, what: chars ? `deletes a table ${what} with ${chars} character${chars === 1 ? '' : 's'} of text; undo restores plain text only` : `deletes an empty table ${what}`,
      range: `Table T${t.n}, ${what} ${k}`, excerptLabel: 'Removed text', excerpt: gateExcerpt(shown || '(empty)') },
    steps: [(m) => ({ requests: [isRow ? reqDeleteRow(m, t.start, i) : reqDeleteCol(m, t.start, i)] })],
    finish: (m) => {
      const nt = tableAt(m, t.start);
      if (!nt) throw new Error('the table was not found after the edit');
      plan.journal = { kind: 'table', action, anchor: false, start: nt.start, index: i, texts, sig: tableSignature(m, nt) };
      plan.done = `deleted ${what} ${k} of table T${nt.n}${shown ? ` (its text: «${tableClip(shown)}»)` : ''}`;
      const j = Math.min(i, (isRow ? nt.rows : nt.cols) - 1);
      const nums = isRow ? rowLineNums(m, nt, j) : colLineNums(m, nt, j);
      plan.affected = () => [nt.firstLine, nt.lastLine];
      plan.report = (mm) => changedLinesReport(mm, nums);
    },
  };
  return plan;
}
const tableClip = (t, n = 200) => (t.length > n ? t.slice(0, n) + '…' : t);

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
    gate: { large: false, what: 'changes a column width', range: `Table T${t.n}, column ${k}`, excerptLabel: 'Width', excerpt: how },
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

// ---- The tool ---------------------------------------------------------------------------------------------
async function runTable(name, args, snap, ui, call) {
  if (String(args.action) === 'insert' && snap.responseWrite) {
    return writeError('line numbers changed after the previous edit in this response, so this table insert was not applied; re-read with read_lines and call it again with the current numbers.', 'table: line numbers changed by the previous edit; not applied');
  }
  const plan = planTable(snap.model, args);
  if (plan.error) return writeError(plan.error, plan.short);
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  const res = await commitSequence(snap, plan, call.id, plan.steps);
  if (res.fail) return res.fail;
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
  return String(a || '');
}

registerTools(TABLE_TOOL, {
  offer: (mode, snap) => apiEditing(mode, snap),
  reading: false,
  icon: '▦',
  pending: 'Changing a table…',
  summary: tableSummary,
  gate: (name, plan) => plan.gate,
  run: runTable,
  prompt: [{ section: 'edit', line: '- table(action, line, table, row, column, rows, columns, cells, width): insert a table after a line (with cell texts); add_row / add_column after row or column N of table Tn (0 = before the first); delete_row / delete_column; set_width of a column in pt. Edit cell text with replace_text.' }],
});

// ---- Undo ---------------------------------------------------------------------------------------------------
// The table of a journal entry as the edit left it: at its start with the same size and cell texts, or else the
// only outer table with that signature (text was inserted or deleted above it since). Throws otherwise.
const TABLE_CTRL_Z = 'so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.';
function journaledTable(model, edit) {
  const outer = (model.tables || []).filter((t) => !t.nested);
  const at = outer.find((t) => t.start === edit.start);
  if (at && tableSignature(model, at) === edit.sig) return at;
  const same = outer.filter((t) => tableSignature(model, t) === edit.sig);
  if (same.length === 1) return same[0];
  throw new Error(`the table of that edit changed after it (or is gone), ${TABLE_CTRL_Z}`);
}
const RESTORED_NOTE = (what) => `Note: the ${what} was re-created with its plain text; formatting and images in it were not restored.`;

// undoEdit for kind 'table': insert -> the table deleted; add_row / add_column -> deleted; delete_row /
// delete_column -> re-inserted with the plain text of each cell (lossy); set_width -> the previous width.
async function undoTable(edit) {
  const read = () => fetchDocModel(edit.docId, edit.tabId);
  let model = await read();
  const t = journaledTable(model, edit);
  const isRow = /_row$/.test(edit.action);
  let note;
  if (edit.action === 'insert') {
    // Joining the paragraphs around the table must not join text: the one insertTable made must still be empty.
    const side = edit.atStart ? lineAtIndex(model, t.start - 1) : lineAtIndex(model, t.end);
    if (!side || side.text !== '') throw new Error(`the empty line ${edit.atStart ? 'before' : 'after'} the table is no longer empty, ${TABLE_CTRL_Z}`);
    const line = lineAtIndex(model, t.start - 1);
    await docsBatchUpdate(model, [reqDeleteTable(model, t)]);
    const now = await read();
    const back = lineAtIndex(now, t.start - 1) || line;
    return { model: now, restored: '', lostObjects: false, range: back ? [back.line, back.line] : [1, 1] };
  }
  if (edit.action === 'set_width') {
    await docsBatchUpdate(model, [reqWidth(model, t.start, edit.index, edit.prev)]);
  } else if (edit.action === 'add_row' || edit.action === 'add_column') {
    if ((isRow ? t.rows : t.cols) < 2) throw new Error(`that ${isRow ? 'row' : 'column'} is the only one left, ${TABLE_CTRL_Z}`);
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
        throw new Error(`the ${isRow ? 'row' : 'column'} could not be filled with its text again (${e.message}), ${TABLE_CTRL_Z}`);
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
const ST_TABLE_ARGS = { action: null, line: null, table: null, row: null, column: null, rows: null, columns: null, cells: null, width: null };
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
  const r = await stTool(ctx, 'read_lines', { start: n + 1, end: t.lastLine + 1 });
  const head = `[table T1: 2 rows × 2 columns, lines ${t.firstLine}–${t.lastLine}]`;
  if (!r.content.includes(`${head}\n${t.firstLine} [r1c1]: A\n${t.firstLine + 1} [r1c2]: B`)) return stFail('read_lines does not show the table in notation', stClip(r.content, 600));
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
  // The row holds text, so the gate would ask; the self-test allows its own edit (the gate has unit tests).
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
