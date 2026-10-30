'use strict';
// What the model reads must not change for documents the line model already handled: read_lines,
// read_formatting, find_in_document, get_outline, the edit reports, the turn context and the static system
// prompt of the standard fixtures are compared byte for byte with test/fixtures/reading-golden.json, recorded
// before the table / segment foundation (P0). Regenerate only on purpose: GOLDEN=write node --test <this file>.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./lib/sandbox');
const { fakeDocsServer, docSpec, OC, VT } = require('./lib/fake-docs');

const GOLDEN = path.join(__dirname, 'fixtures', 'reading-golden.json');
let T;
before(async () => { T = (await load()).T; });

const LISTS = { 'kix.n': 'NUMBERED_DECIMAL_ALPHA_ROMAN', 'kix.c': 'BULLET_CHECKBOX' };
const A11 = { font: 'Arial', size: 11 };
const FIXTURES = {
  standard: docSpec(),
  formatting: { documentId: 'DOC1', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', lists: LISTS, items: [
    { p: 'Report', style: 'TITLE', fmt: [[0, 6, A11]] },
    { p: 'Methods', style: 'HEADING_1', fmt: [[0, 7, A11]] },
    { p: 'Alpha beta gamma.', fmt: [[0, 17, A11], [6, 10, { bold: true }]], bullet: { listId: 'kix.n' } },
    { p: 'Sub-item', fmt: [[0, 8, A11]], bullet: { listId: 'kix.n', level: 1 } },
    { p: 'Plain centered text', fmt: [[0, 19, A11], [6, 14, { size: 14, color: '#FF0000' }]], pstyle: { alignment: 'CENTER', lineSpacing: 150 } },
    { p: 'Buy milk', fmt: [[0, 8, A11], [4, 8, { link: 'https://x.org' }]], bullet: { listId: 'kix.c' } },
    { p: 'Soft' + VT + 'break and ' + OC + ' object', suggest: true },
    { table: [[[{ p: 'R1C1' }, { p: 'second para' }], [{ p: 'R1C2', style: 'HEADING_3' }]], [[{ p: 'R2C1' }], [{ p: '' }]]] },
    { p: 'After the table', fmt: [[0, 5, { italic: true, underline: true }]] },
  ] }] },
};

function outputs(spec, tabId) {
  const fake = fakeDocsServer(spec);
  const model = T.buildLineModel(fake.render(true), tabId, spec.documentId);
  const snap = { ...T.takeSnapshot(), docText: model.text, docFormat: 'docs-api', docTitle: spec.title, model, lines: null, selection: '', docId: spec.documentId, googleConnected: true };
  const n = model.lines.length;
  const out = {
    read_lines: T.runReadingTool('read_lines', { start: 1, end: n }, snap),
    read_lines_part: T.runReadingTool('read_lines', { start: 2, end: 4 }, snap, { chars: 40, lines: 2 }),
    read_formatting: T.runReadingTool('read_formatting', { start: 1, end: n }, snap),
    find: T.runReadingTool('find_in_document', { query: 'a' }, snap),
    find_cell: T.runReadingTool('find_in_document', { query: 'C1' }, snap),
    outline: T.runReadingTool('get_outline', {}, snap),
    report: T.linesReport(model, 1, n),
    report_marked: T.linesReport(model, 1, n, T.markedText),
    changed: T.changedLinesReport(model, [1, Math.max(1, n - 1)]),
    region: T.regionNote(model, 3, 4),
    tools_edit: T.toolsFor('edit', snap).map((t) => t.function.name),
    tools_manual: T.toolsFor('manual', snap).map((t) => t.function.name),
    context: T.buildTurnContext('edit', snap, null),
  };
  for (const mode of ['edit', 'manual']) out['system_' + mode] = T.buildSystemParts(mode, 100000, snap).head;
  return out;
}

function all() {
  const out = {};
  for (const [name, spec] of Object.entries(FIXTURES)) for (const tab of spec.tabs) out[`${name}/${tab.id}`] = outputs(spec, tab.id);
  return out;
}

test('reading tools, reports and prompts of the existing fixtures are byte-identical to the recorded output', () => {
  const now = JSON.parse(JSON.stringify(all())); // values from the vm realm
  if (process.env.GOLDEN === 'write') fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
  const was = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(Object.keys(now), Object.keys(was));
  for (const key of Object.keys(was)) {
    for (const k of Object.keys(was[key])) assert.deepStrictEqual(now[key][k], was[key][k], `${key} ${k}`);
  }
});
