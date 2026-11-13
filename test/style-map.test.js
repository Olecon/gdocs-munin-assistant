'use strict';
// style_map (src/style-map.js): where each value of a style parameter occurs, on a small mixed document (two fonts, a
// partial-line bold run, a justified range, numbered headings with indents, a list, a table cell, empty lines): every
// property, the ranges merged, the character spans read against read_document's text, the caps, the scope and the cut
// at the per-call limit, all, the fallback without the Docs API, the strict schema and where the tool is offered.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

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

const TNR = { font: 'Times New Roman', size: 12 };
const J = { alignment: 'JUSTIFIED' };
const H = { indentStart: 17, indentFirstLine: 0 };
const HEAD = { listId: 'kix.h', preset: 'NUMBERED_DECIMAL_NESTED' };
const mixed = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'Intro', style: 'HEADING_1', bullet: HEAD, pstyle: H },
  { p: 'Alpha beta gamma delta.', fmt: [[0, 23, TNR], [6, 10, { bold: true }]], pstyle: J },
  { p: 'Second line here.', fmt: [[0, 17, TNR]], pstyle: J },
  { p: '' },
  { p: 'Arial words in TNR.', fmt: [[0, 5, { font: 'Arial', size: 12 }], [5, 19, TNR]], pstyle: J },
  { p: 'Methods', style: 'HEADING_1', bullet: HEAD, pstyle: H },
  // the indents Docs writes onto a paragraph when it makes the bullet (createParagraphBullets: the level's own)
  { p: 'Item one', bullet: { listId: 'kix.b' }, pstyle: { indentStart: 36, indentFirstLine: 18 } },
  { p: 'Item two', bullet: { listId: 'kix.b', level: 1 }, pstyle: { indentStart: 72, indentFirstLine: 54 } },
  { table: [[[{ p: 'Cell text', fmt: [[0, 4, { color: '#FF0000' }]] }], [{ p: '' }]]] },
  { p: 'Last line', pstyle: { lineSpacing: 115, spaceAbove: 6, spaceBelow: 0 } },
] });
const map = async (property, scope = null) => {
  const r = await exec('style_map', { property, scope });
  assert.ok(r._ok && r._reading, r.content);
  return r.content;
};

const SECTIONS = {
  font: ['font (lines 1–12):', '- (default: Arial 11): lines 5, 8–12', '- Times New Roman: lines 3–4, 6 (chars 6–19)',
    '- (h1 style: Arial 20): lines 2, 7', '- (title style: Arial 26): line 1', '- Arial: line 6 (chars 1–5)'],
  size: ['size (lines 1–12):', '- (default: Arial 11): lines 5, 8–12', '- 12: lines 3–4, 6', '- (h1 style: Arial 20): lines 2, 7',
    '- (title style: Arial 26): line 1'],
  bold: ['bold (lines 1–12):', '- (none): lines 1–2, 3 (chars 1–6, 11–23), 4–12', '- bold: line 3 (chars 7–10)'],
  italic: ['italic (lines 1–12):', '- (none): lines 1–12'],
  underline: ['underline (lines 1–12):', '- (none): lines 1–12'],
  // the named styles are read: Title and Heading 1 show Normal text's black, as unset colour on body text does
  color: ['color (lines 1–12):', '- (none): lines 1–9, 10 (chars 5–9), 11–12', '- #FF0000: line 10 (chars 1–4)'],
  background: ['background (lines 1–12):', '- (none): lines 1–12'],
  align: ['align (lines 1–12):', '- left (style): lines 1–2, 5, 7–12', '- justify (= body sheet): lines 3–4, 6'],
  style: ['style (lines 1–12):', '- normal: lines 3–6, 8–12', '- h1: lines 2, 7', '- title: line 1'],
  list: ['list (lines 1–12):', '- none: lines 1, 3–6, 10–12', '- number: lines 2, 7', '- bullet: line 8', '- bullet L2: line 9'],
  // the headings set their own indent; the list items their level's (as Docs writes it); the sides named as format_lines'
  indent: ['indent (lines 1–12):', '- none: lines 1, 3–6, 10–12', '- start 17, first line 0 pt: lines 2, 7', '- start 36, first line 18 pt: line 8',
    '- start 72, first line 54 pt: line 9'],
  // unset spacing reads the named style's values where the style has them (the fake's Normal text has none)
  space: ['space (lines 1–12):', '- (style): lines 3–6, 8–11', '- 20/6 pt (style): lines 2, 7', '- 0/3 pt (style): line 1', '- 6/0 pt: line 12'],
  line_spacing: ['line_spacing (lines 1–12):', '- (style): lines 1–11', '- 1.15 (= normal style): line 12'],
};

test('style_map: every property on a mixed document (fonts, a partial bold run, justified lines, numbered headings, a list, a table, empty lines)', async () => {
  await fresh(mixed());
  for (const [prop, lines] of Object.entries(SECTIONS)) assert.strictEqual(await map(prop), lines.join('\n'), prop);
});

test('style_map all: the uniform properties on one line, then each property in turn; properties on the same places merged', async () => {
  await fresh(mixed());
  const out = await map('all', 'all');
  const merged = ['list, indent (lines 1–12):', '- none / none: lines 1, 3–6, 10–12', '- number / start 17, first line 0 pt: lines 2, 7',
    '- bullet / start 36, first line 18 pt: line 8', '- bullet L2 / start 72, first line 54 pt: line 9'];
  assert.strictEqual(out, ['Same throughout (lines 1–12): italic (none); underline (none); background (none)',
    ...['font', 'size', 'bold', 'color', 'align', 'style'].map((p) => SECTIONS[p].join('\n')), merged.join('\n'),
    ...['space', 'line_spacing'].map((p) => SECTIONS[p].join('\n'))].join('\n\n'));
  deq(T.STYLE_MAP_PROPS, ['font', 'size', 'bold', 'italic', 'underline', 'color', 'background', 'align', 'style', 'list', 'indent', 'space', 'line_spacing']);
});

test('style_map: the character spans are the positions of read_document\'s text (code points; an emoji counts once)', async () => {
  await fresh(docSpec({ items: [
    { p: 'Alpha beta gamma delta.', fmt: [[6, 10, { bold: true }]] },
    { p: 'Smile 😀 bold end', fmt: [[9, 13, { bold: true }]] }, // UTF-16: the emoji is two units
  ] }));
  const out = await map('bold', { start: 1, end: 2 });
  assert.strictEqual(out, ['bold (lines 1–2):', '- (none): lines 1 (chars 1–6, 11–23), 2 (chars 1–8, 13–16)', '- bold: lines 1 (chars 7–10), 2 (chars 9–12)'].join('\n'));
  const view = T.runReadingTool('read_document', { scope: 'all', include: ['text'], doc: null }, as).split('\n');
  const text = (n) => Array.from(view.find((l) => l.startsWith(`${n}: `)).slice(`${n}: `.length));
  assert.strictEqual(text(1).slice(6, 10).join(''), 'beta');
  assert.strictEqual(text(2).slice(8, 12).join(''), 'bold');
});

test('style_map: whole lines merge into ranges; a partial line breaks a range', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ p: `Line ${i + 1}`, fmt: [[0, 4, { font: 'Georgia' }], [4, 6, { font: i === 4 ? 'Lora' : 'Georgia' }]] }));
  await fresh(docSpec({ items }));
  assert.strictEqual(await map('font'), ['font (lines 1–9):', '- Georgia: lines 1–4, 5 (chars 1–4), 6–9', '- Lora: line 5 (chars 5–6)'].join('\n'));
});

test('style_map caps: 12 values per property, 8 places per value', async () => {
  const fonts = ['Arial', 'Calibri', 'Cambria', 'Georgia', 'Lato', 'Lora', 'Merriweather', 'Montserrat', 'Roboto', 'Tahoma', 'Verdana', 'Inter', 'Consolas', 'Raleway'];
  await fresh(docSpec({ items: fonts.map((f) => ({ p: f + ' text', fmt: [[0, f.length + 5, { font: f }]] })) }));
  const out = (await map('font')).split('\n');
  deq(out.length, 1 + 12 + 1);
  deq(out[1], '- Arial: line 1');
  deq(out[12], '- Inter: line 12');
  deq(out[13], '- … and 2 more values');
  // one value on ten separate lines: eight places, then the count of the rest
  await fresh(docSpec({ items: Array.from({ length: 20 }, (_, i) => ({ p: `L${i + 1}`, pstyle: i % 2 ? J : {} })) }));
  assert.strictEqual(await map('align'), ['align (lines 1–20):', '- left (style): lines 1, 3, 5, 7, 9, 11, 13, 15, … and 2 more places',
    '- justify (= body sheet): lines 2, 4, 6, 8, 10, 12, 14, 16, … and 2 more places'].join('\n'));
});

test('style_map scope: lines, all or null; outline and lines past the end are errors; the result is cut at the per-call limit', async () => {
  await fresh(mixed());
  assert.strictEqual(await map('style', { start: 2, end: 3 }), ['style (lines 2–3):', '- h1: line 2', '- normal: line 3'].join('\n'));
  assert.strictEqual(await map('style', { start: 11, end: 50 }), ['style (lines 11–12):', '- normal: lines 11–12'].join('\n'));
  assert.strictEqual(await map('style', '4-4'), ['style (line 4):', '- normal: line 4'].join('\n'));
  assert.strictEqual(await map('style', 'all'), await map('style', null));
  const bad = await exec('style_map', { property: 'style', scope: 'outline' });
  assert.match(bad.content, /^Error: scope must be/);
  assert.strictEqual((await exec('style_map', { property: 'style', scope: { start: 40, end: 50 } })).content, 'Error: the document has only 12 lines.');
  assert.match((await exec('style_map', { property: 'weight', scope: null })).content, /^Error: property must be one of font, size/);
  // the per-call limit: whole lines up to it, then how to narrow the call
  const full = T.styleMap(as.model, { property: 'all', scope: null }, 100000);
  const cut = T.styleMap(as.model, { property: 'all', scope: null }, 300);
  const kept = cut.split('\n').slice(0, -1).join('\n');
  assert.ok(full.startsWith(kept) && kept.length <= 300, cut);
  assert.strictEqual(cut.split('\n').pop(), '[Cut at the limit per call. Narrow the scope ({"start":N,"end":M}) or ask for one property.]');
  // the tool uses the provider's read_document limit
  assert.strictEqual(T.readLimits({ readMaxChars: 8000 }).chars, 8000);
});

test('style_map without the Docs API: the export carries no formatting', async () => {
  await fresh(mixed());
  const snap = { ...as, docFormat: 'markdown', model: null };
  assert.strictEqual(await T.runStyleMap('style_map', { property: 'font', scope: null }, snap), 'Not available without the Google Docs API: the export carries no formatting.');
  // not offered on the export (no prompt tokens for a tool that cannot answer); a stray call is refused
  assert.ok(!T.toolsFor('edit', snap).some((t) => t.function.name === 'style_map'));
  const r = await T.executeTool({ id: 'sm1', function: { name: 'style_map', arguments: '{"property":"font","scope":null}' } }, 'edit', snap);
  assert.strictEqual(r.content, 'Error: style_map is not offered now; use the tools you were given.');
});

test('style_map: a strict, short definition; a reading call offered wherever read_document is with the Docs API (read-only agents too)', async () => {
  await fresh(mixed());
  const def = T.EXTRA_TOOLS.find((t) => t.names.includes('style_map')).defs[0].function;
  deq(Object.keys(def.parameters.properties), ['property', 'scope']);
  deq(def.parameters.required, ['property', 'scope']);
  assert.strictEqual(def.parameters.additionalProperties, false);
  deq(def.parameters.properties.property.enum, [...T.STYLE_MAP_PROPS, 'all']);
  deq(def.parameters.properties.scope.anyOf.map((a) => a.type), ['object', 'string', 'null']);
  assert.ok(def.description.length < 260, def.description);
  assert.ok(T.isExtraReading('style_map', { property: 'font', scope: null }));
  const has = (mode, snap) => T.toolsFor(mode, snap).some((t) => t.function.name === 'style_map');
  for (const mode of ['edit', 'manual', 'plan']) assert.ok(has(mode, as), mode);
  assert.ok(has('edit', { ...as, agent: { id: 'A1', access: 'read' } }));
  // a reading call: runs in Manual and Plan, writes nothing
  const r = await T.executeTool({ id: 'sm2', function: { name: 'style_map', arguments: '{"property":"style","scope":{"start":1,"end":1}}' } }, 'plan', as);
  assert.strictEqual(r.content, 'style (line 1):\n- title: line 1');
  deq(fake.log.filter((x) => x.method === 'POST').length, 0);
});
