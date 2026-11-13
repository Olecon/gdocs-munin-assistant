'use strict';
// Compact tool schemas for the providers without strict mode (Munin, a custom server; tools.js compactSchema): a nullable
// property becomes its base type and leaves required, additionalProperties goes; OpenAI and Anthropic keep the strict
// schemas, except edit_document's (compact, not strict). Only the schema text changes: every write tool, every edit_document operation and the reading tools run with
// their nullable fields left out (the handlers read a missing field as null).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, makeSnapFor } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh, pushTool;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Every schema node, depth first.
function* nodes(s) {
  if (Array.isArray(s)) { for (const x of s) yield* nodes(x); return; }
  if (!s || typeof s !== 'object') return;
  yield s;
  for (const v of Object.values(s)) yield* nodes(v);
}
const isNullable = (p) => Array.isArray(p.anyOf) && p.anyOf.some((x) => x.type === 'null');

test('compactSchema: nullable fields become their base type and leave required; no additionalProperties; real unions stay', () => {
  const ed = T.compactSchema(T.TOOL_DEFS.edit_document.function.parameters);
  const item = ed.properties.operations.items;
  deq(item.required, ['op']);
  deq(item.properties.old_text, { type: 'string' });
  deq(item.properties.align, { type: 'string', enum: ['left', 'center', 'right', 'justify'] });
  deq(item.properties.style, { type: 'string', description: 'insert: h1-h6, title, subtitle (every line), outline; format_lines: also normal' });
  // the union of the strict operations is merged into the loose object of earlier versions: every field once, op's enum joined
  deq(item.properties.op, { type: 'string', enum: ['replace', 'insert', 'delete', 'format_text', 'format_lines', 'number_headings'] });
  deq(Object.keys(item.properties), ['op', 'old_text', 'new_text', 'line', 'text', 'style', 'fill', 'start', 'end', 'all', 'bold', 'italic', 'underline', 'font', 'size',
    'color', 'highlight', 'script', 'link', 'align', 'list', 'indent_start', 'indent_first_line', 'space_above', 'space_below', 'line_spacing', 'indent_end', 'box',
    'page_break_before', 'numbers', 'prefix']);
  deq(item.properties.fill, { type: 'boolean' }); // insert: into the empty line
  // format_text's superscript / subscript and number_headings' typed-number letters: no descriptions (Munin's budget)
  deq([item.properties.script, item.properties.prefix], [{ type: 'string', enum: ['super', 'sub', 'none'] }, { type: 'string' }]);
  // an indent (a number or "style") keeps its number, optional; format_lines' own definition says "style" in its description
  deq(item.properties.indent_start, { type: 'number' });
  const fl = T.compactSchema(T.TOOL_DEFS.format_lines.function.parameters);
  deq(fl.properties.indent_first_line, { type: 'number', description: 'pt; "style" = inherit' });
  deq(fl.required, ['start', 'end']);
  deq(item.properties.line, { type: 'integer', description: 'replace, format_text: picks the occurrence on it; insert: after it, 0 = at the start' });
  assert.ok(!('anyOf' in item));
  const rd = T.compactSchema(T.TOOL_DEFS.read_document.function.parameters);
  deq(rd.required, ['scope']);
  assert.strictEqual(rd.properties.scope.anyOf.length, 2, 'object or string: kept');
  deq(rd.properties.include, { type: 'array', items: { type: 'string', enum: ['text', 'headings', 'lists', 'formatting', 'comments'] } });
  deq(T.compactSchema(T.TOOL_DEFS.undo_last_edit.function.parameters), { type: 'object', properties: {} });
  // the strict definitions themselves are untouched
  assert.strictEqual(T.TOOL_DEFS.edit_document.function.parameters.properties.operations.items.anyOf.length, 6);
});

test('the read-only definitions of Plan and the read-only chat turn compact like the others: only action stays required', () => {
  deq(T.compactSchema(T.PAGE_PARTS_READ_DEF.function.parameters), { type: 'object', properties: {
    action: { type: 'string', enum: ['read'] }, part: { type: 'string', enum: ['header', 'footer', 'footnote', 'toc', 'sections'], description: 'read: null = all' },
    number: { type: 'integer', description: 'footnote or section number' } }, required: ['action'] });
  deq(T.compactSchema(T.DOCUMENT_STYLES_READ_TOOL.function.parameters), { type: 'object', properties: { action: { type: 'string', enum: ['read'] } }, required: ['action'] });
  deq(T.compactSchema(T.DELEGATE_READ_TOOL.function.parameters).required, ['task', 'search']);
});

test('the request: compact schemas for Munin and a custom server, strict ones for OpenAI and Anthropic', () => {
  const snapFor = makeSnapFor(env);
  const strictCount = (tools) => [...nodes(tools)].filter((n) => n.additionalProperties === false || (n.properties && Object.values(n.properties).some(isNullable))).length;
  for (const prov of ['munin', 'custom']) {
    const s = snapFor('munin');
    if (prov === 'custom') s.prov = { ...s.prov, id: 'custom', sampling: undefined, toolSampling: undefined, summarySampling: undefined };
    const tools = T.buildRequest('edit', s).body.tools;
    assert.ok(tools.length > 5, prov);
    assert.strictEqual(strictCount(tools), 0, `${prov}: no strict-mode residue`);
    assert.ok(JSON.stringify(tools).length < JSON.stringify(T.toolsFor('edit', s)).length, prov);
  }
  const a = T.buildRequest('edit', snapFor('anthropic')).body.tools;
  assert.ok(a.some((t) => t.input_schema && t.input_schema.additionalProperties === false));
  const o = T.buildRequest('edit', snapFor('openai')).body.tools;
  assert.ok(o.some((t) => t.parameters && t.parameters.additionalProperties === false));
});

// edit_document on OpenAI and Anthropic (request.js LOOSE_TOOLS): compact and not strict, so an operation carries only the
// fields it sets; every other tool strict on OpenAI, the fixed set on Anthropic (ANTHROPIC_STRICT_TOOLS, whose tools that
// are not strict go without the field). The same batch as a strict provider writes it is more than twice as long, and
// so is the strict definition. The estimate of the request (sentTools) counts the compact one.
test('edit_document: compact and not strict on OpenAI and Anthropic; the other tools strict (Anthropic: its fixed set); the batch and the definition shorter', async () => {
  await fresh(spec()); // a document read through the Docs API: the writing tools are offered
  const snapFor = makeSnapFor(env);
  const compact = T.compactSchema(T.TOOL_DEFS.edit_document.function.parameters);
  for (const prov of ['openai', 'anthropic']) {
    const tools = T.buildRequest('edit', snapFor(prov)).body.tools.filter((t) => t.type !== 'web_search' && !/^web_search/.test(String(t.type || '')));
    const ed = tools.find((t) => t.name === 'edit_document');
    assert.strictEqual(ed.strict, prov === 'openai' ? false : undefined, prov);
    deq(ed.parameters || ed.input_schema, compact);
    for (const t of tools.filter((x) => x.name && x.name !== 'edit_document')) {
      assert.strictEqual(t.strict, prov === 'openai' || T.ANTHROPIC_STRICT_TOOLS.includes(t.name) ? true : undefined, `${prov}: ${t.name}`);
    }
    const sent = T.sentTools(T.toolsFor('edit', snapFor(prov)), snapFor(prov).prov);
    deq(sent.find((t) => t.function.name === 'edit_document').function.parameters, compact);
    assert.ok(sent.find((t) => t.function.name === 'replace_text').function.parameters.additionalProperties === false, prov);
    // what goes out is what the estimate counts
    deq(sent.map((t) => t.function.parameters), tools.map((t) => t.parameters || t.input_schema));
  }
  const strictDef = JSON.stringify(T.TOOL_DEFS.edit_document.function.parameters).length;
  assert.ok(JSON.stringify(compact).length * 2 < strictDef, `${JSON.stringify(compact).length} vs ${strictDef}`);
  // one format_lines operation that sets one property: all 14 fields of its variant strict, 4 compact
  const variant = T.TOOL_DEFS.edit_document.function.parameters.properties.operations.items.anyOf.find((v) => v.properties.op.enum[0] === 'format_lines');
  const given = { op: 'format_lines', start: 6, end: 6, space_above: 12 };
  const strictOp = Object.fromEntries(Object.keys(variant.properties).map((k) => [k, given[k] === undefined ? null : given[k]]));
  assert.strictEqual(Object.keys(strictOp).length, 14);
  assert.ok(JSON.stringify(given).length * 3 < JSON.stringify(strictOp).length);
});

// Lines: 1 Report (title), 2 Intro, 3 Alpha, 4 Methods, 5 Beta, 6 Results, 7 Gamma, 8 Delta.
const spec = () => docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: 'Intro', style: 'HEADING_1' }, { p: 'Alpha one two' }, { p: 'Methods', style: 'HEADING_1' },
  { p: 'Beta three four' }, { p: 'Results', style: 'HEADING_1' }, { p: 'Gamma five six' }, { p: 'Delta seven' }] });
const ok = (r, what) => { pushTool(r); assert.ok(r._ok !== false && !/^Error/.test(r.content), `${what}: ${r.content}`); return r; };

test('every write tool and every edit_document operation runs with the nullable fields omitted', async () => {
  await fresh(spec());
  ok(await exec('read_document', { scope: 'all' }), 'read_document, no include or doc');
  ok(await exec('find_in_document', { query: 'Beta' }), 'find_in_document, no doc');
  ok(await exec('replace_text', { old_text: 'Alpha one', new_text: 'Alpha 1' }), 'replace_text');
  ok(await exec('replace_all', { old_text: 'five', new_text: '5' }), 'replace_all');
  ok(await exec('format_text', { old_text: 'Beta', bold: true }), 'format_text with one property');
  ok(await exec('format_lines', { start: 3, end: 3, align: 'center' }), 'format_lines with one property');
  ok(await exec('format_lines', { start: 2, end: 6, numbers: 'typed' }), 'format_lines numbers alone');
  ok(await exec('insert_after_line', { line: 8, text: 'Epsilon eight' }), 'insert_after_line, no style');
  ok(await exec('read_document', { scope: { start: 1, end: 9 } }), 'read again');
  ok(await exec('delete_lines', { start: 9, end: 9 }), 'delete_lines');
  ok(await exec('read_document', { scope: 'all' }), 'read again');
  const ops = [
    { op: 'replace', old_text: 'Delta seven', new_text: 'Delta 7' },
    { op: 'insert', line: 8, text: 'Zeta' },
    { op: 'format_text', old_text: 'Gamma', italic: true },
    { op: 'format_lines', start: 3, end: 3, align: 'left' },
  ];
  ok(await exec('edit_document', { operations: ops }), 'edit_document without nulls');
  ok(await exec('read_document', { scope: 'all' }), 'read again');
  ok(await exec('edit_document', { operations: [{ op: 'delete', start: 9 }] }), 'edit_document delete, no end');
  ok(await exec('read_document', { scope: 'all' }), 'read again');
  ok(await exec('edit_document', { operations: [{ op: 'number_headings', numbers: 'clear' }] }), 'edit_document number_headings, no range');
  const text = fake.text('t.0');
  assert.ok(text.includes('Alpha 1 two') && text.includes('Gamma 5 six') && text.includes('Delta 7') && !text.includes('Zeta'), text);
  // replace_section has no nullable field (not run here); undo takes no arguments
  ok(await exec('undo_last_edit', {}), 'undo_last_edit');
});

test('trim_to_words and phrase_usage (src/prose-tools.js): strict for OpenAI and Anthropic, compact for Munin and custom servers', () => {
  deq(T.TRIM_DEF.function.parameters.required, ['line_start', 'line_end', 'words', 'keep']);
  deq(T.compactSchema(T.TRIM_DEF.function.parameters), { type: 'object', properties: {
    line_start: { type: 'integer' }, line_end: { type: 'integer' }, words: { type: 'integer', description: 'The target word count.' },
    keep: { type: 'string', description: 'Short text that must stay word for word; null: none.' } }, required: ['line_start', 'line_end', 'words'] });
  deq(T.compactSchema(T.PHRASE_DEF.function.parameters), { type: 'object', properties: { phrase: { type: 'string', description: '3 to 8 words.' } }, required: ['phrase'] });
  // lean: the compact definition of trim_to_words under 600 characters (about 150 tokens), phrase_usage under 360
  deq([JSON.stringify(T.compactTool(T.TRIM_DEF)).length < 600, JSON.stringify(T.compactTool(T.PHRASE_DEF)).length < 360], [true, true]);
});
