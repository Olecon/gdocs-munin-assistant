'use strict';
// style_map (src/style-map.js): an explicit paragraph value equal to its named style's own reads "(= h2 style)", else one
// equal to the formatting sheet's entry "(= h2 sheet)", so the model can tell a heading's own spacing (written explicitly
// on insertion) from spacing added on top of it. The scenario of a real session: 6 pt above the body lines, the headings'
// 18/14 pt written by the sheet on insertion; the model read the 18/14 pt as added and zeroed them.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
const { namedIndents } = require('./lib/tool-eval');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const h1 = (p) => ({ p, style: 'HEADING_1', pstyle: { spaceAbove: 18, spaceBelow: 0 } });
const h2 = (p) => ({ p, style: 'HEADING_2', pstyle: { spaceAbove: 14, spaceBelow: 0 } });
const body = (p) => ({ p, pstyle: { spaceAbove: 6, spaceBelow: 0, alignment: 'JUSTIFIED', lineSpacing: 115 } });
// docSpec keeps only items; the named styles go on the spec itself.
const withNamed = (namedStyles, items) => ({ ...docSpec({ items }), namedStyles });
const session = () => withNamed({ HEADING_1: { spaceAbove: 18, spaceBelow: 0 }, HEADING_2: { spaceAbove: 14, spaceBelow: 0 } },
  [h1('Title'), body('B2'), h2('One'), body('B4'), body('B5'), h2('Two'), body('B7'), body('B8'), body('B9'),
    h2('Three'), body('B11'), body('B12')]);
const map = async (property) => {
  const r = await exec('style_map', { property, scope: 'all' });
  assert.ok(r._ok && r._reading, r.content);
  return r.content;
};

test('style_map space: the headings\' spacing equal to their styles\' own is marked, the 6 pt added to the body is not', async () => {
  await fresh(session());
  assert.strictEqual(await map('space'), ['space (lines 1–12):', '- 6/0 pt: lines 2, 4–5, 7–9, 11–12',
    '- 14/0 pt (= h2 style): lines 3, 6, 10', '- 18/0 pt (= h1 style): line 1'].join('\n'));
});

test('style_map: the same raw value with and without the marker are two groups; align and line_spacing are marked too', async () => {
  // Normal text: left, 1.15 (the fake's defaults); a body line at 1.15 matches it, its justify does not
  await fresh(withNamed({ HEADING_2: { spaceAbove: 14, spaceBelow: 0 } }, [
    h2('Head'), { p: 'Body at 14', pstyle: { spaceAbove: 14, spaceBelow: 0 } }, body('B3'), { p: 'Left', pstyle: { alignment: 'START' } }]));
  assert.strictEqual(await map('space'), ['space (lines 1–4):', '- 14/0 pt (= h2 style): line 1', '- 14/0 pt: line 2',
    '- 6/0 pt: line 3', '- (style): line 4'].join('\n'));
  // the default sheet's body is justify: matched by the sheet, not by Normal text (left)
  assert.strictEqual(await map('align'), ['align (lines 1–4):', '- left (style): lines 1–2', '- justify (= body sheet): line 3',
    '- left (= normal style): line 4'].join('\n'));
  assert.strictEqual(await map('line_spacing'), ['line_spacing (lines 1–4):', '- (style): lines 1–2, 4', '- 1.15 (= normal style): line 3'].join('\n'));
  // one side set and equal (the other inherited) is marked; one side differing is not
  await fresh(withNamed({ HEADING_2: { spaceAbove: 14, spaceBelow: 0 } }, [
    { p: 'A', style: 'HEADING_2', pstyle: { spaceAbove: 14 } }, { p: 'B', style: 'HEADING_2', pstyle: { spaceAbove: 14, spaceBelow: 6 } }]));
  assert.strictEqual(await map('space'), ['space (lines 1–2):', '- 14/- pt (= h2 style): line 1', '- 14/6 pt: line 2'].join('\n'));
});

test('style_map: the logged session with Docs\' default named styles: the headings match the default sheet, the body none', async () => {
  // Heading 1 20/6 and Heading 2 18/6 pt (Docs' defaults); the sheet's 18/0 and 14/0 written explicitly on the headings
  await fresh(docSpec({ items: session().tabs[0].items }));
  as.docInstructions = ''; as.mainInstructions = '';
  assert.strictEqual(await map('space'), ['space (lines 1–12):', '- 6/0 pt: lines 2, 4–5, 7–9, 11–12',
    '- 14/0 pt (= h2 sheet): lines 3, 6, 10', '- 18/0 pt (= h1 sheet): line 1'].join('\n'));
  // DOC.md's sheet wins over the default: its h2 is 10/0, so the 14/0 headings match neither
  as.docInstructions = 'Formatting: h2 space 10/0';
  assert.strictEqual(await map('space'), ['space (lines 1–12):', '- 6/0 pt: lines 2, 4–5, 7–9, 11–12',
    '- 14/0 pt: lines 3, 6, 10', '- 18/0 pt (= h1 sheet): line 1'].join('\n'));
  // without a sheet passed (styleMap's default), only the named styles count
  const named = T.namedStyleValues(await T.fetchNamedStylesRaw(as.model.docId, as.model.tabId));
  assert.strictEqual(T.styleMap(as.model, { property: 'space', scope: null }, 100000, named),
    ['space (lines 1–12):', '- 6/0 pt: lines 2, 4–5, 7–9, 11–12', '- 14/0 pt: lines 3, 6, 10', '- 18/0 pt: line 1'].join('\n'));
});

test('style_map: inherited spacing reads "(style)" with the named style\'s values; without the named styles the values print unmarked', async () => {
  await fresh(session());
  const out = T.styleMap(as.model, { property: 'space', scope: null }, 100000, null);
  assert.strictEqual(out, ['space (lines 1–12):', '- 6/0 pt: lines 2, 4–5, 7–9, 11–12', '- 14/0 pt: lines 3, 6, 10', '- 18/0 pt: line 1'].join('\n'));
  // Heading 1 inherits Docs' 20/6 pt; the fake's Normal text has no spacing, so the body stays a bare "(style)"
  await fresh(docSpec({ items: [{ p: 'Head', style: 'HEADING_1' }, { p: 'Body' }] }));
  assert.strictEqual(await map('space'), ['space (lines 1–2):', '- 20/6 pt (style): line 1', '- (style): line 2'].join('\n'));
  // a named style that sets one side shows the other as "-"; unread named styles leave the bare "(style)"
  await fresh(withNamed({ NORMAL_TEXT: { spaceAbove: 4 } }, [{ p: 'Body' }]));
  assert.strictEqual(await map('space'), ['space (line 1):', '- 4/- pt (style): line 1'].join('\n'));
  assert.strictEqual(T.styleMap(as.model, { property: 'space', scope: null }, 100000, null), ['space (line 1):', '- (style): line 1'].join('\n'));
});

test('style_map indent: a value the line does not set is its named style\'s (never its list level\'s), marked inherited; named styles unread: no number', async () => {
  // the case of a real session: the model copied the list level's 72/54 pt onto the other headings, but Docs draws a list
  // item without an own indent at its named style's indent (chrome-check line-starts), here none and then 28.5/21.26 pt
  const L = { listId: 'kix.n', preset: 'NUMBERED_DECIMAL_NESTED', level: 1 };
  await fresh(docSpec({ items: [
    { p: 'Inherits', style: 'HEADING_2', bullet: L },
    { p: 'Own, equal', style: 'HEADING_2', bullet: L, pstyle: { indentStart: 72, indentFirstLine: 54 } },
    { p: 'Own start', style: 'HEADING_2', bullet: L, pstyle: { indentStart: 28.5 } },
    { p: 'Own first line', style: 'HEADING_2', bullet: L, pstyle: { indentFirstLine: 21 } },
    { p: 'Plain', pstyle: { indentStart: 36 } },
    { p: 'None' },
  ] }));
  // the sides named as format_lines' parameters (a live model read a bare "28.5/21.26" as left/right and set indent_end)
  assert.strictEqual(await map('indent'), ['indent (lines 1–6):', '- none: lines 1, 6', '- start 72, first line 54 pt: line 2',
    '- start 28.5, first line 0 pt (first line inherited): line 3', '- start 0, first line 21 pt (start inherited): line 4',
    '- start 36, first line 0 pt (first line inherited): line 5'].join('\n'));
  // the heading style with an indent (read with the named styles): the inheriting heading reads it, marked, and the note
  // says how another line gets it (a live model copied the numbers instead, onto the title too)
  const NOTE = 'To make a line match an inherited one, set its indent_start and indent_first_line to "style", not the numbers.';
  namedIndents(fake, { HEADING_2: { indentStart: 28.5, indentFirstLine: 21.26 } });
  assert.strictEqual(await map('indent'), ['indent (lines 1–6):', '- start 28.5, first line 21.26 pt, inherited (h2 style): line 1',
    '- start 72, first line 54 pt: line 2', '- start 28.5, first line 21.26 pt (first line inherited): line 3',
    '- start 28.5, first line 21 pt (start inherited): line 4', '- start 36, first line 0 pt (first line inherited): line 5',
    '- none: line 6', '', NOTE].join('\n'));
  // a narrow call on the inheriting line alone has the note too (the live model read that line, then the others in a
  // second call, and never saw it); all has it once, at the end; no line that inherits the whole indent: no note
  const h2 = { HEADING_2: { indentStart: 28.5, indentFirstLine: 21.26 } };
  assert.strictEqual(T.styleMap(as.model, { property: 'indent', scope: { start: 1, end: 1 } }, 100000, h2),
    ['indent (line 1):', '- start 28.5, first line 21.26 pt, inherited (h2 style): line 1', '', NOTE].join('\n'));
  const all = T.styleMap(as.model, { property: 'all', scope: { start: 1, end: 1 } }, 100000, h2);
  assert.ok(all.endsWith(`\n\n${NOTE}`) && all.split(NOTE).length === 2, all);
  assert.ok(!all.includes('28.5/21.26'), all);
  assert.ok(!/To make a line/.test(T.styleMap(as.model, { property: 'indent', scope: { start: 2, end: 6 } }, 100000, h2)));
  // the named styles unread: the own values only
  assert.strictEqual(T.styleMap(as.model, { property: 'indent', scope: null }, 100000, null), ['indent (lines 1–6):', '- no own indent: lines 1, 6',
    '- start 72, first line 54 pt: line 2', '- start 28.5 pt (first line: no own indent): line 3', '- first line 21 pt (start: no own indent): line 4',
    '- start 36 pt (first line: no own indent): line 5'].join('\n'));
});
