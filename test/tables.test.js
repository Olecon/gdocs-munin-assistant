'use strict';
// The table tool (src/docs-tables.js): the schema and its registration (offer, prompt line, icon, summary), every
// action's exact requests against the fake's table plugin (test/lib/fake-tables.js), the two-batch insert and its
// rollback, undo of each action (exact, and lossy for deleted rows and columns) and its refusal, the gate, the
// notation in the reading output, the text tools inside a cell, and every error.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
require('./lib/fake-tables');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Lines: 1 Title, 2 Alpha, 3 Beta, 4-7 the cells A, B, C, D of T1 (2×2, column 1 fixed at 120 pt; the table starts at
// index 18), 8 After, 9 Last.
const spec = () => docSpec({ items: [
  { p: 'Title', style: 'TITLE' }, { p: 'Alpha' }, { p: 'Beta' },
  { table: [[[{ p: 'A' }], [{ p: 'B' }]], [[{ p: 'C' }], [{ p: 'D' }]]], widths: [{ type: 'FIXED_WIDTH', pt: 120 }, { type: 'EVENLY_DISTRIBUTED' }] },
  { p: 'After' }, { p: 'Last' },
] });
const TEXT0 = 'Title\nAlpha\nBeta\nA\nB\nC\nD\nAfter\nLast';
const ROWS0 = [['A', 'B'], ['C', 'D']];
const WIDTHS0 = [{ type: 'FIXED_WIDTH', pt: 120 }, { type: 'EVENLY_DISTRIBUTED' }];
const NULLS = { action: null, line: null, table: null, row: null, column: null, rows: null, columns: null, cells: null, width: null };
const tb = (over) => ({ ...NULLS, ...over });
const loc = (index) => ({ index, tabId: 't.0' });
const cellLoc = (start, r, c) => ({ tableStartLocation: loc(start), rowIndex: r, columnIndex: c });
const ins = (index, text) => ({ insertText: { location: loc(index), text } });
const posts = () => fake.log.filter((x) => x.method === 'POST').map((x) => x.body.requests);
const undo = async () => pushTool(await exec('undo_last_edit', {}));
const assertOriginal = (widths = WIDTHS0) => {
  assert.strictEqual(fake.text('t.0'), TEXT0);
  deq(fake.tables('t.0'), [{ rows: ROWS0, widths, spans: [] }]);
};
// A call that must show the gate card: decides it and returns { r, html }.
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, p]] = [...T.pendingPreviews.entries()];
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}

test('schema, offer, prompt line, icon, pending text and action-log summaries', async () => {
  await fresh(spec());
  const f = T.TABLE_TOOL.function;
  assert.strictEqual(f.name, 'table');
  deq(f.parameters.required, ['action', 'line', 'table', 'row', 'column', 'rows', 'columns', 'cells', 'width']);
  deq(Object.keys(f.parameters.properties), f.parameters.required);
  assert.strictEqual(f.parameters.additionalProperties, false);
  deq(f.parameters.properties.action.enum, ['insert', 'add_row', 'add_column', 'delete_row', 'delete_column', 'set_width']);
  deq(f.parameters.properties.cells.anyOf[0], { type: 'array', items: { type: 'array', items: { type: 'string' } } });
  // offered in Auto with the Docs API only, after the built-in tools
  deq(T.toolsFor('edit', as).map((t) => t.function.name).slice(-7), ['replace_selection', 'ask_user', 'table', 'page_parts', 'read_comments', 'draft', 'revise_section']);
  assert.ok(!T.toolsFor('manual', as).some((t) => t.function.name === 'table'));
  assert.ok(!T.toolsFor('edit', { ...as, docFormat: 'markdown', model: null }).some((t) => t.function.name === 'table'));
  const head = T.buildSystemParts('edit', 1e5, as).head;
  assert.ok(head.includes('\n- table(action, line, table, row, column, rows, columns, cells, width): insert a table after a line (with cell texts); add_row / add_column after row or column N of table Tn (0 = before the first); delete_row / delete_column; set_width of a column in pt. Edit cell text with replace_text.\n'), 'edit line');
  assert.ok(head.includes('(table cells are separate lines marked [rNcM] (row N, column M), under a [table Tn …] line, in reading order)'), 'cell sentence');
  assert.ok(!T.buildSystemParts('manual', 1e5, as).head.includes('- table('));
  deq([T.activityIcon('table'), T.pendingCardText('table'), T.isEditTool('table')], ['▦', 'Changing a table…', true]);
  const sum = (args) => T.logEntry({ id: 'x', function: { name: 'table', arguments: JSON.stringify(tb(args)) } }, null).summary;
  deq([sum({ action: 'insert', line: 7, rows: 3, columns: 2 }), sum({ action: 'insert', line: 0, rows: 1, columns: 1 }), sum({ action: 'delete_row', table: 'T1', row: 2 }),
    sum({ action: 'add_row', table: 't2', row: 0 }), sum({ action: 'add_column', table: '1', column: 3 }), sum({ action: 'delete_column', table: 'T1', column: 1 }),
    sum({ action: 'set_width', table: 'T1', column: 1, width: 120 }), sum({ action: 'set_width', table: 'T1', column: 2, width: 0 })],
  ['insert 3×2 after line 7', 'insert 1×1 at the beginning', 'delete row 2 of T1', 'add row before row 1 of T2', 'add column after column 3 of T1',
    'delete column 1 of T1', 'column 1 of T1: 120 pt', 'column 2 of T1: automatic']);
});

test('notation: read_lines shows the [table …] line and the cell labels; a copied prefix still matches', async () => {
  await fresh(spec());
  const r = await exec('read_lines', { start: 3, end: 8 });
  assert.ok(r.content.includes('3: Beta\n[table T1: 2 rows × 2 columns, lines 4–7]\n4 [r1c1]: A\n5 [r1c2]: B\n6 [r2c1]: C\n7 [r2c2]: D\n8: After'), r.content);
  const f = await exec('find_in_document', { query: 'D' });
  assert.ok(f.content.includes('7 [r2c2]: D'), f.content);
  assert.strictEqual(T.stripMarkers('6 [r2c1]: C'), 'C');
});

test('insert: insertTable at the line\'s newline, then a second batch fills the cells back to front; exact undo', async () => {
  await fresh(spec());
  const w = pushTool(await exec('table', tb({ action: 'insert', line: 3, rows: 2, columns: 2, cells: [['H1', 'H2'], ['x', '']] }), 'ti'));
  assert.ok(w._ok, w.content);
  // the API cannot fill a table in the batch that inserts it: two batches
  deq(posts(), [[{ insertTable: { rows: 2, columns: 2, location: loc(17) } }], [ins(26, 'x'), ins(23, 'H2'), ins(21, 'H1')]]);
  assert.strictEqual(w.content, 'Done: inserted table T1 (2 rows × 2 columns) after line 3.\nLines 4-8 now:\n[table T1: 2 rows × 2 columns, lines 4–7]\n'
    + '4 [r1c1]: H1\n5 [r1c2]: H2\n6 [r2c1]: x\n7 [r2c2]: \n8: \nThe document now has 14 lines.');
  deq([w._message, w._cardLabel, w._cardText], ['Inserted a 2×2 table after line 3', 'Table', 'H1 | H2\nx | ']);
  deq(fake.tables('t.0').map((t) => t.rows), [[['H1', 'H2'], ['x', '']], ROWS0]);
  deq([w._edit.kind, w._edit.action, w._edit.start, w._edit.anchor, w._edit.atStart], ['table', 'insert', 18, false, false]);
  assert.ok(as.responseWrite, 'line numbers moved');
  // the table goes together with the newline before it: the empty paragraph Docs left after it joins line 3 again
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ deleteContentRange: { range: { startIndex: 17, endIndex: 34, tabId: 't.0' } } }]);
  assert.strictEqual(u.content, 'Done: undid "Inserted a 2×2 table after line 3".\nLines 3-3 now:\n3: Beta\nThe document now has 9 lines.');
  assertOriginal();
  deq(fake.styles('t.0').slice(0, 3), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT']);
});

test('insert: at the beginning (line 0), without texts (one batch), rows and columns from cells; undo of each', async () => {
  await fresh(spec());
  let w = pushTool(await exec('table', tb({ action: 'insert', line: 0, rows: 1, columns: 1 })));
  assert.ok(w._ok, w.content);
  deq(posts(), [[{ insertTable: { rows: 1, columns: 1, location: loc(1) } }]]);
  assert.ok(w.content.startsWith('Done: inserted table T1 (1 row × 1 column) at the beginning.\nLines 2-3 now:\n[table T1: 1 row × 1 column, line 2]\n2 [r1c1]: \n3: Title\n'), w.content);
  assert.strictEqual(fake.text('t.0'), '\n\n' + TEXT0); // an empty paragraph, the table's cell, then the old line 1
  let u = await undo();
  assert.ok(u._ok, u.content);
  assertOriginal();
  deq(fake.styles('t.0')[0], 'TITLE');
  // rows and columns may be left out when cells give them
  w = pushTool(await exec('table', tb({ action: 'insert', line: 9, cells: [['k', 'v'], ['1']] })));
  assert.ok(w._ok, w.content);
  deq(fake.tables('t.0')[1].rows, [['k', 'v'], ['1', '']]);
  u = await undo();
  assert.ok(u._ok, u.content);
  assertOriginal();
});

test('insert: a failing cell batch rolls the table back; the result says so', async () => {
  await fresh(spec());
  const fetch0 = fake.fetch;
  let n = 0;
  fake.fetch = async (url, init) => ((init && init.method === 'POST' && ++n === 2) ? { ok: false, status: 500, json: async () => ({ error: { code: 500, message: 'Backend error' } }), text: async () => 'x' } : fetch0(url, init));
  const w = await exec('table', tb({ action: 'insert', line: 3, rows: 1, columns: 2, cells: [['a', 'b']] }));
  fake.fetch = fetch0;
  assert.ok(!w._ok);
  assert.ok(w.content.startsWith('Error: the edit failed halfway (') && w.content.includes('its first part was rolled back, so the document is as it was.'), w.content);
  const p = posts();
  deq([p[0], p[p.length - 1]], [[{ insertTable: { rows: 1, columns: 2, location: loc(17) } }], [{ deleteContentRange: { range: { startIndex: 17, endIndex: 24, tabId: 't.0' } } }]]);
  assertOriginal();
});

test('add_row / add_column: insertTableRow / insertTableColumn at the table start, the texts in a second batch; exact undo', async () => {
  await fresh(spec());
  let w = pushTool(await exec('table', tb({ action: 'add_row', table: 'T1', row: 1, cells: [['E', 'F']] })));
  assert.ok(w._ok, w.content);
  deq(posts(), [[{ insertTableRow: { tableCellLocation: cellLoc(18, 0, 0), insertBelow: true } }], [ins(30, 'F'), ins(28, 'E')]]);
  assert.strictEqual(w.content, 'Done: added row 2 to table T1.\nLines 6, 7 now:\n6 [r2c1]: E\n7 [r2c2]: F\nThe document now has 11 lines.');
  deq(fake.tables('t.0')[0].rows, [['A', 'B'], ['E', 'F'], ['C', 'D']]);
  let u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ deleteTableRow: { tableCellLocation: cellLoc(18, 1, 0) } }]);
  assertOriginal();
  // row 0: above row 1; no texts: one batch
  w = pushTool(await exec('table', tb({ action: 'add_row', table: 'T1', row: 0 })));
  deq(lastPost().requests, [{ insertTableRow: { tableCellLocation: cellLoc(18, 0, 0), insertBelow: false } }]);
  deq(fake.tables('t.0')[0].rows, [['', ''], ...ROWS0]);
  assert.strictEqual(w.content, 'Done: added row 1 to table T1.\nLines 4, 5 now:\n4 [r1c1]: \n5 [r1c2]: \nThe document now has 11 lines.');
  u = await undo();
  deq(posts().pop(), [{ deleteTableRow: { tableCellLocation: cellLoc(18, 0, 0) } }]);
  assertOriginal();
  // a column right of column 2, its texts top to bottom
  w = pushTool(await exec('table', tb({ action: 'add_column', table: 'T1', column: 2, cells: [['x', 'y']] })));
  assert.ok(w._ok, w.content);
  deq(posts().slice(-2), [[{ insertTableColumn: { tableCellLocation: cellLoc(18, 0, 1), insertRight: true } }], [ins(36, 'y'), ins(27, 'x')]]);
  assert.strictEqual(w.content, 'Done: added column 3 to table T1.\nLines 6, 9 now:\n6 [r1c3]: x\n9 [r2c3]: y\nThe document now has 11 lines.');
  deq(fake.tables('t.0')[0].rows, [['A', 'B', 'x'], ['C', 'D', 'y']]);
  u = await undo();
  deq(posts().pop(), [{ deleteTableColumn: { tableCellLocation: cellLoc(18, 0, 2) } }]);
  assertOriginal();
  w = pushTool(await exec('table', tb({ action: 'add_column', table: 1, column: 0 })));
  deq(lastPost().requests, [{ insertTableColumn: { tableCellLocation: cellLoc(18, 0, 0), insertRight: false } }]);
  u = await undo();
  assert.ok(u._ok, u.content);
  assertOriginal([{ type: 'FIXED_WIDTH', pt: 120 }, { type: 'EVENLY_DISTRIBUTED' }]);
});

test('delete_row / delete_column: the gate asks when the cells hold text; undo re-creates them with plain text (lossy note)', async () => {
  await fresh(spec());
  const { r: w, html } = await decided(exec('table', tb({ action: 'delete_row', table: 'T1', row: 2 })), 'accept');
  pushTool(w);
  assert.ok(w._ok, w.content);
  assert.ok(html.includes('Large edit: it deletes a table row with 2 characters of text; undo restores plain text only.') && html.includes('Table T1, row 2') && html.includes('C | D'), html);
  deq(lastPost().requests, [{ deleteTableRow: { tableCellLocation: cellLoc(18, 1, 0) } }]);
  assert.strictEqual(w.content, 'Done: deleted row 2 of table T1 (its text: «C | D»).\nLines 4, 5 now:\n4 [r1c1]: A\n5 [r1c2]: B\nThe document now has 7 lines.');
  deq(w._edit.texts, ['C', 'D']);
  let u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().slice(-2), [[{ insertTableRow: { tableCellLocation: cellLoc(18, 0, 0), insertBelow: true } }], [ins(30, 'D'), ins(28, 'C')]]);
  assert.ok(u.content.startsWith('Done: undid "Deleted row 2 of T1".\nNote: the row was re-created with its plain text; formatting and images in it were not restored.\nLines 4-7 now:\n'), u.content);
  assertOriginal();
  // the first column: its fixed width is not restored (lossy)
  const c = await decided(exec('table', tb({ action: 'delete_column', table: 'T1', column: 1 })), 'accept');
  pushTool(c.r);
  deq(lastPost().requests, [{ deleteTableColumn: { tableCellLocation: cellLoc(18, 0, 0) } }]);
  assert.strictEqual(c.r.content, 'Done: deleted column 1 of table T1 (its text: «A | C»).\nLines 4, 5 now:\n4 [r1c1]: B\n5 [r2c1]: D\nThe document now has 7 lines.');
  u = await undo();
  deq(posts().slice(-2), [[{ insertTableColumn: { tableCellLocation: cellLoc(18, 0, 0), insertRight: false } }], [ins(27, 'C'), ins(21, 'A')]]);
  assert.ok(u.content.includes('Note: the column was re-created with its plain text'), u.content);
  assertOriginal([{ type: 'EVENLY_DISTRIBUTED' }, { type: 'EVENLY_DISTRIBUTED' }]);
  // Deny: nothing sent
  const n = posts().length;
  const d = await decided(exec('table', tb({ action: 'delete_row', table: 'T1', row: 1 })), 'reject');
  assert.ok(!d.r._ok && posts().length === n);
});

test('delete of an empty row passes without a card; undo puts back an empty row', async () => {
  await fresh(docSpec({ items: [{ p: 'Top' }, { table: [[[{ p: 'a' }], [{ p: 'b' }]], [[{ p: '' }], [{ p: '' }]]] }, { p: 'End' }] }));
  const w = pushTool(await exec('table', tb({ action: 'delete_row', table: 'T1', row: 2 })));
  assert.ok(w._ok && T.pendingPreviews.size === 0 && w._decision === undefined, w.content);
  assert.strictEqual(w.content, 'Done: deleted row 2 of table T1.\nLines 2, 3 now:\n2 [r1c1]: a\n3 [r1c2]: b\nThe document now has 4 lines.');
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(posts().pop(), [{ insertTableRow: { tableCellLocation: { tableStartLocation: loc(5), rowIndex: 0, columnIndex: 0 }, insertBelow: true } }]);
  deq(fake.tables('t.0')[0].rows, [['a', 'b'], ['', '']]);
});

test('set_width: updateTableColumnProperties with its field mask; lines stay valid; undo restores the previous width', async () => {
  await fresh(spec());
  let w = pushTool(await exec('table', tb({ action: 'set_width', table: 'T1', column: 2, width: 90 })));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [{ updateTableColumnProperties: { tableStartLocation: loc(18), columnIndices: [1],
    tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, fields: 'widthType,width' } }]);
  assert.strictEqual(w.content, 'Done: column 2 of table T1 is 90 pt wide.\nTable T1 column widths: 1: 120 pt, 2: 90 pt.\nThe document now has 9 lines.');
  assert.strictEqual(as.responseWrite, null, 'a width moves no line');
  let u = await undo();
  assert.ok(u._ok, u.content);
  deq(lastPost().requests[0].updateTableColumnProperties.tableColumnProperties, { widthType: 'EVENLY_DISTRIBUTED' });
  assertOriginal();
  // 0: automatic; undo gives the fixed 120 pt back
  w = pushTool(await exec('table', tb({ action: 'set_width', table: 'T1', column: 1, width: 0 })));
  assert.strictEqual(w.content.split('\n')[0], 'Done: column 1 of table T1 has an automatic width.');
  deq(fake.tables('t.0')[0].widths, [{ type: 'EVENLY_DISTRIBUTED' }, { type: 'EVENLY_DISTRIBUTED' }]);
  u = await undo();
  deq(lastPost().requests[0].updateTableColumnProperties.tableColumnProperties, { widthType: 'FIXED_WIDTH', width: { magnitude: 120, unit: 'PT' } });
  assertOriginal();
});

test('undo refuses a table that changed after the edit, and finds one that moved', async () => {
  await fresh(spec());
  const w = pushTool(await exec('table', tb({ action: 'add_row', table: 'T1', row: 2, cells: [['E', 'F']] })));
  // text typed into the table afterwards: the table is no longer the one the edit left
  pushTool(await exec('replace_text', { old_text: 'E', new_text: 'Echo' }));
  await assert.rejects(T.undoEdit(w._edit), /the table of that edit changed after it \(or is gone\), so it cannot be undone automatically\. Use Undo \(Ctrl\+Z\) in Google Docs instead\./);
  // moved: a paragraph inserted above it; the undo finds the same table by its cells
  await fresh(spec());
  const a = pushTool(await exec('table', tb({ action: 'add_row', table: 'T1', row: 2 })));
  pushTool(await exec('insert_after_line', { line: 1, text: 'New line' }));
  const res = await T.undoEdit(a._edit);
  deq(lastPost().requests, [{ deleteTableRow: { tableCellLocation: cellLoc(27, 2, 0) } }]);
  assert.ok(res.model);
  deq(fake.tables('t.0')[0].rows, ROWS0);
  // an inserted table whose empty line after it got text: joining would merge text, so undo refuses
  await fresh(spec());
  const t = pushTool(await exec('table', tb({ action: 'insert', line: 2, rows: 1, columns: 1 })));
  pushTool(await exec('insert_after_line', { line: 4, text: 'typed' })); // after the empty line 4 that follows the table
  pushTool(await exec('delete_lines', { start: 4, end: 4 })); // the empty line goes: "typed" follows the table
  await assert.rejects(T.undoEdit(t._edit), /the empty line after the table is no longer empty/);
});

test('gate: insert large above 50 cells; add, width and small inserts ask only in a tainted turn', async () => {
  await fresh(spec());
  const info = (args) => T.editGateInfo('table', T.planTable(as.model, tb(args)));
  deq(info({ action: 'insert', line: 1, rows: 5, columns: 10 }), { large: false, what: 'inserts a table of 50 cells', range: 'After line 1', excerptLabel: 'Cells', excerpt: '(empty)' });
  deq(info({ action: 'insert', line: 0, rows: 6, columns: 9 }).large, true);
  deq(info({ action: 'insert', line: 1, cells: [['a', 'b']] }).excerpt, 'a | b');
  deq(info({ action: 'add_row', table: 'T1', row: 1 }), { large: false, what: 'adds a table row', range: 'Table T1', excerptLabel: 'Cells', excerpt: '(empty)' });
  deq(info({ action: 'set_width', table: 'T1', column: 1, width: 50 }), { large: false, what: 'changes a column width', range: 'Table T1, column 1', excerptLabel: 'Width', excerpt: '50 pt wide' });
  deq(info({ action: 'delete_column', table: 'T1', column: 2 }), { large: true, what: 'deletes a table column with 2 characters of text; undo restores plain text only', range: 'Table T1, column 2', excerptLabel: 'Removed text', excerpt: 'B | D' });
  // a big insert asks; a tainted turn asks for a small edit too
  const big = await decided(exec('table', tb({ action: 'insert', line: 1, rows: 6, columns: 9 })), 'reject');
  assert.ok(big.html.includes('Large edit: it inserts a table of 54 cells.'), big.html);
  as.tainted = true;
  const t = await decided(exec('table', tb({ action: 'set_width', table: 'T1', column: 1, width: 50 })), 'reject');
  assert.ok(t.html.includes('This edit changes a column width.'), t.html);
  as.tainted = false;
  assert.strictEqual(posts().length, 0);
});

test('replace_text and insert_after_line work inside a cell and report its label', async () => {
  await fresh(spec());
  let w = pushTool(await exec('replace_text', { old_text: 'C', new_text: 'Charlie' }));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.includes('6 [r2c1]: Charlie'), w.content);
  w = pushTool(await exec('insert_after_line', { line: 4, text: 'A2' }));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.includes('5 [r1c1]: A2'), w.content);
  deq(fake.tables('t.0')[0].rows, [['A\nA2', 'B'], ['Charlie', 'D']]);
  // the table tool sees the cell's two paragraphs as its text
  const p = T.planTable(as.model, tb({ action: 'delete_row', table: 'T1', row: 1 }));
  assert.strictEqual(p.gate.excerpt, 'A A2 | B');
});

test('errors name the fix', async () => {
  await fresh(spec());
  const err = async (args) => { const r = await exec('table', tb(args)); assert.ok(!r._ok, r.content); return r.content; };
  deq([
    await err({ action: 'merge' }),
    await err({ action: 'add_row', row: 1 }),
    await err({ action: 'add_row', table: 'T5', row: 1 }),
    await err({ action: 'delete_row', table: 'T1', row: 3 }),
    await err({ action: 'add_row', table: 'T1', row: 3 }),
    await err({ action: 'delete_column', table: 'T1', column: 0 }),
    await err({ action: 'insert', line: 3, rows: 21, columns: 2 }),
    await err({ action: 'insert', line: 3, rows: 2, columns: 0 }),
    await err({ action: 'insert', line: 10, rows: 1, columns: 1 }),
    await err({ action: 'insert', line: 3, rows: 2, columns: 2, cells: [['a'], ['b'], ['c']] }),
    await err({ action: 'insert', line: 3, rows: 2, columns: 2, cells: [['a', 'b', 'c']] }),
    await err({ action: 'insert', line: 3, rows: 1, columns: 1, cells: 'a' }),
    await err({ action: 'insert', line: 5, rows: 1, columns: 1 }),
    await err({ action: 'add_row', table: 'T1', row: 1, cells: [['a'], ['b']] }),
    await err({ action: 'add_column', table: 'T1', column: 1, cells: [['a', 'b', 'c']] }),
    await err({ action: 'set_width', table: 'T1', column: 1, width: 3 }),
    await err({ action: 'set_width', table: 'T1', column: 3, width: 50 }),
  ], [
    'Error: action must be one of insert, add_row, add_column, delete_row, delete_column, set_width',
    'Error: table is required for add_row, e.g. "T1"; the document has table T1 (read_lines shows each as a [table Tn …] line)',
    'Error: there is no table T5; the document has table T1 (read_lines shows each as a [table Tn …] line)',
    'Error: table T1 has 2 rows; row must be 1-2',
    'Error: table T1 has 2 rows; row must be 0-2 (the new row goes after it; 0 = above row 1)',
    'Error: table T1 has 2 columns; column must be 1-2',
    'Error: rows must be 1-20 and columns 1-10',
    'Error: rows must be 1-20 and columns 1-10',
    'Error: line must be an integer from 0 to 9',
    'Error: cells has 3 rows but the table has 2; pass at most one list of texts per row',
    'Error: cells row 1 has 3 texts but the table has 2 columns',
    'Error: cells must be a list of rows, each a list of plain texts, e.g. [["A","B"],["C","D"]], or null',
    'Error: line 5 is inside table T1; tables cannot be nested. Insert after line 8 or another line outside a table',
    'Error: cells must hold one row: the new row\'s texts, e.g. [["E","F"]]',
    'Error: cells has 3 texts but the table has 2 rows',
    'Error: width must be 5-600 pt, or 0 for an automatic width (Google Docs refuses columns narrower than 5 pt)',
    'Error: table T1 has 2 columns; column must be 1-2',
  ]);
  assert.strictEqual(posts().length, 0);
  // the only row or column: the whole table would go
  await fresh(docSpec({ items: [{ p: 'Top' }, { table: [[[{ p: 'a' }], [{ p: 'b' }]]] }, { p: 'End' }] }));
  assert.strictEqual(await err({ action: 'delete_row', table: 'T1', row: 1 }), 'Error: row 1 is the only row of table T1; deleting it would delete the whole table. Tell the user to delete the table in Google Docs');
  // no tables at all
  await fresh(docSpec({ items: [{ p: 'Top' }] }));
  assert.strictEqual(await err({ action: 'set_width', table: 'T1', column: 1, width: 50 }), 'Error: there is no table T1; the document has no tables');
  // a second line-number write in the same response
  await fresh(spec());
  pushTool(await exec('insert_after_line', { line: 1, text: 'x' }));
  const r = await exec('table', tb({ action: 'insert', line: 1, rows: 1, columns: 1 }), null, true);
  assert.ok(!r._ok && r.content.startsWith('Error: line numbers changed after the previous edit in this response'), r.content);
});

test('nested tables and merged cells are refused (plan on a model with both)', () => {
  const srv = fakeDocsServer({ documentId: 'DOC123', title: 'X', tabs: [{ id: 't.0', title: 'Main',
    items: [{ p: 'Top' }, { table: [[[{ p: 'Outer' }], [{ p: 'Wide' }]], [[{ p: 'L' }], [{ p: 'R' }]]], spans: [[0, 1, 1, 2]] }, { p: 'End' }] }] });
  const doc = srv.render(true);
  const cell = doc.tabs[0].documentTab.body.content[2].table.tableRows[1].tableCells[1];
  cell.content.push({ startIndex: 90, endIndex: 99, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 93, endIndex: 96, paragraph: { elements: [{ startIndex: 93, endIndex: 96, textRun: { content: 'In\n' } }] } }] }] }] } },
    { startIndex: 99, endIndex: 100, paragraph: { elements: [{ startIndex: 99, endIndex: 100, textRun: { content: '\n' } }] } });
  const m = T.buildLineModel(doc, 't.0', 'DOC123');
  const plan = (args) => T.planTable(m, tb(args)).error;
  deq([
    plan({ action: 'insert', line: 6, rows: 1, columns: 1 }),
    plan({ action: 'add_row', table: 'T2', row: 1 }),
    plan({ action: 'delete_row', table: 'T1', row: 1 }),
    plan({ action: 'delete_column', table: 'T1', column: 2 }),
  ], [
    'line 6 is inside table T2; tables cannot be nested. Insert after line 8 or another line outside a table',
    'table T2 is inside a cell of another table; nested tables can only be changed in Google Docs',
    'the table has merged cells in row 1; Google Docs would delete every row they span. Unmerge them in Google Docs first',
    'the table has merged cells in column 2; Google Docs would delete every column they span. Unmerge them in Google Docs first',
  ]);
  assert.ok(!T.planTable(m, tb({ action: 'delete_row', table: 'T1', row: 2 })).error);
});

test('fake table plugin: a partial table range and a width under 5 pt are refused like the API', async () => {
  const srv = fakeDocsServer(spec());
  const post = (requests) => srv.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate',
    { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
  let r = await post([{ deleteContentRange: { range: { startIndex: 17, endIndex: 25, tabId: 't.0' } } }]);
  deq([r.status, r.error && r.error.message], [400, 'Invalid deletion range: a table can only be deleted whole.']);
  r = await post([{ updateTableColumnProperties: { tableStartLocation: loc(18), columnIndices: [0], tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: 4, unit: 'PT' } }, fields: 'widthType,width' } }]);
  deq([r.status, r.error && r.error.message], [400, 'The column width must be at least 5 points.']);
  r = await post([{ updateTableColumnProperties: { tableStartLocation: loc(18), columnIndices: [0], tableColumnProperties: { widthType: 'FIXED_WIDTH' }, fields: 'widthType,minWidth' } }]);
  assert.strictEqual(r.status, 400);
  r = await post([{ insertTableRow: { tableCellLocation: cellLoc(17, 0, 0), insertBelow: true } }]);
  deq([r.status, r.error && r.error.message], [400, 'Invalid table start location: no table starts at index 17']);
  // a whole table without the newline before it: the paragraphs around it stay apart
  r = await post([{ deleteContentRange: { range: { startIndex: 18, endIndex: 33, tabId: 't.0' } } }]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(srv.text('t.0'), 'Title\nAlpha\nBeta\nAfter\nLast');
  deq(srv.tables('t.0'), []);
});
