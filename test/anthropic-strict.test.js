'use strict';
// Anthropic's strict tools against the limits its documentation states for one request (structured outputs, "Explicit
// limits": 20 strict tools; 24 optional parameters and 16 parameters with a union type, anyOf or a type array, across
// all strict schemas; no numerical or string constraints, minItems only 0 or 1; tool names ^[a-zA-Z0-9_-]{1,128}$): a
// fixed set stays strict (request.js ANTHROPIC_STRICT_TOOLS), every other tool goes compact and without the strict
// field, the same in every turn and for every model. The counts come from the schemas themselves. The tools that left
// strict mode still refuse wrong-typed arguments without writing.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, makeSnapFor } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
require('./lib/fake-tables');

const LIMITS = { strictTools: 20, optional: 24, unions: 16 };
const SPARE = 4; // union parameters the set leaves free under the limit (a nullable field added to a strict tool)
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems',
  'uniqueItems', 'minProperties', 'maxProperties', 'patternProperties', 'pattern', 'not', 'if', 'then', 'else'];

let env, T, state, snapFor, exec, fresh;
let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  snapFor = makeSnapFor(env);
  await fresh(docSpec()); // headings, a table, an image: every Docs API feature tool is offered
  state.applyMode = 'auto'; state.googleConnected = true;
});

// Every schema node (properties' values, items, anyOf / allOf members), not the property maps themselves.
function walk(s, fn) {
  if (!s || typeof s !== 'object') return;
  fn(s);
  if (s.properties) for (const p of Object.values(s.properties)) walk(p, fn);
  if (s.items) walk(s.items, fn);
  for (const k of ['anyOf', 'allOf', 'oneOf']) for (const x of s[k] || []) walk(x, fn);
}
const unionCount = (schema) => { let n = 0; walk(schema, (s) => { if (Array.isArray(s.anyOf) || Array.isArray(s.type) || Array.isArray(s.oneOf)) n++; }); return n; };
const optionalCount = (schema) => { let n = 0; walk(schema, (s) => { if (s.properties) n += Object.keys(s.properties).filter((k) => !(s.required || []).includes(k)).length; }); return n; };
const unsupported = (schema) => { const out = []; walk(schema, (s) => { out.push(...UNSUPPORTED.filter((k) => k in s)); if (s.minItems > 1) out.push('minItems ' + s.minItems); }); return out; };
// Every definition a request may carry: the built-in and registered tools, the read-only variants of Manual and Plan.
const allDefs = () => [...Object.values(T.TOOL_DEFS), ...T.EXTRA_TOOLS.flatMap((t) => t.defs), T.PAGE_PARTS_READ_DEF, T.DOCUMENT_STYLES_READ_TOOL, T.DELEGATE_READ_TOOL,
  ...['edit', 'manual', 'plan'].flatMap((mode) => T.toolsFor(mode, snapFor('anthropic')))];

test('the strict set: at most 20 tools, its union and optional parameters counted from the schemas, under the limits with room to spare', () => {
  const names = T.ANTHROPIC_STRICT_TOOLS;
  deq(names, ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'delete_lines', 'replace_selection',
    'read_document', 'style_map', 'document_styles', 'remember', 'ask_user']);
  assert.ok(names.length <= LIMITS.strictTools);
  const defs = allDefs();
  // per tool the largest count of any of its definitions (a read-only variant of Manual and Plan included)
  const most = (count) => Object.fromEntries(names.map((n) => {
    const own = defs.filter((d) => d.function.name === n);
    assert.ok(own.length, `${n}: defined`);
    return [n, Math.max(...own.map((d) => count(d.function.parameters)))];
  }));
  const unions = most(unionCount);
  deq(unions, { replace_text: 1, replace_all: 0, replace_section: 0, insert_after_line: 2, delete_lines: 0, replace_selection: 0,
    read_document: 3, style_map: 1, document_styles: 1, remember: 1, ask_user: 1 });
  const total = Object.values(unions).reduce((a, b) => a + b, 0);
  assert.ok(total <= LIMITS.unions - SPARE, `${total} union parameters across the strict tools`);
  deq(Object.values(most(optionalCount)).reduce((a, b) => a + b, 0), 0); // every property required (limit 24)
  for (const d of defs.filter((x) => names.includes(x.function.name))) deq(unsupported(d.function.parameters), [], d.function.name);
  // what the whole set would cost: the reason it is not strict (about 60 union parameters)
  const every = new Map(defs.map((d) => [d.function.name, unionCount(d.function.parameters)]));
  assert.ok([...every.values()].reduce((a, b) => a + b, 0) > 3 * LIMITS.unions);
  deq(['format_text', 'format_lines', 'table'].map((n) => every.get(n)), [11, 14, 10]);
  for (const d of defs) assert.match(d.function.name, /^[a-zA-Z0-9_-]{1,128}$/);
});

test('an Anthropic request: the strict set strict, every other tool compact without the strict field, the same in every turn and for every model', () => {
  const client = (body) => body.tools.filter((t) => t.input_schema);
  const defOf = (name) => T.toolsFor('edit', snapFor('anthropic')).find((t) => t.function.name === name).function.parameters;
  let first = null;
  for (const model of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
    state.selection = '';
    const body = T.buildRequest('edit', snapFor('anthropic', { model })).body;
    const tools = client(body);
    assert.ok(tools.length >= 25, `${model}: ${tools.length} tools`);
    const strict = tools.filter((t) => t.strict === true);
    deq(strict.map((t) => t.name), tools.map((t) => t.name).filter((n) => T.ANTHROPIC_STRICT_TOOLS.includes(n)), model);
    for (const t of tools.filter((x) => x.strict !== true)) {
      assert.ok(!('strict' in t), `${model}: ${t.name}`);
      deq(t.input_schema, T.compactSchema(defOf(t.name)), t.name);
    }
    for (const t of strict) deq(t.input_schema, defOf(t.name), t.name);
    assert.ok(strict.length <= LIMITS.strictTools);
    assert.ok(strict.reduce((n, t) => n + unionCount(t.input_schema), 0) <= LIMITS.unions);
    assert.strictEqual(strict.reduce((n, t) => n + optionalCount(t.input_schema), 0), 0);
    // at most 4 cache breakpoints (the system prompt, the last block, the previous turn's start)
    assert.ok((JSON.stringify(body).match(/"cache_control"/g) || []).length <= 4);
    // another turn (another selection, so another turn context) serialises the tools the same way
    state.selection = 'Intro';
    deq(client(T.buildRequest('edit', snapFor('anthropic', { model })).body), tools, model);
    if (first) deq(tools, first, model); else first = tools;
  }
  state.selection = '';
  // the tool block, every client tool: shorter than with every tool strict (the form before)
  const all = allDefs().filter((d, i, a) => a.findIndex((x) => x.function.name === d.function.name) === i);
  const sent = JSON.stringify(all.map((t) => T.toAnthropicTool(t)));
  const before = JSON.stringify(all.map((t) => ({ name: t.function.name, description: t.function.description,
    input_schema: t.function.name === 'edit_document' ? T.compactSchema(t.function.parameters) : t.function.parameters, strict: t.function.name !== 'edit_document' })));
  assert.ok(sent.length < before.length * 0.9, `${sent.length} vs ${before.length}`);
  // loose: no strict tool at all, every schema compact
  for (const t of all.map((x) => T.toAnthropicTool(x, true))) assert.ok(!('strict' in t) && !JSON.stringify(t.input_schema).includes('"additionalProperties"'), t.name);
});

test('OpenAI keeps every tool strict but edit_document', () => {
  const tools = T.buildRequest('edit', snapFor('openai')).body.tools.filter((t) => t.type === 'function');
  assert.ok(tools.length >= 25);
  deq(tools.filter((t) => t.strict !== true).map((t) => [t.name, t.strict]), [['edit_document', false]]);
});

// The writing tools that left strict mode on Anthropic, with a wrong type: an error result and no write.
test('format_text, format_lines, table and page_parts refuse wrong-typed arguments without writing', async () => {
  const calls = [
    ['format_text', { old_text: 'Intro', size: 'big' }, 'size must be a number'],
    ['format_text', { old_text: 5, bold: true }, 'invalid arguments'],
    ['format_lines', { start: 'two', end: 'three', align: 'center' }, 'start and end must be integers'],
    ['format_lines', { start: 2, end: 2, align: 5 }, 'align must be'],
    ['format_lines', { start: 2, end: 2, space_above: 'lots' }, 'space_above must be a number'],
    ['format_lines', { start: 2, end: 2, indent_start: 'deep' }, 'indent_start must be a number'],
    ['table', { action: 'insert', line: 'end', rows: 2, columns: 2 }, 'line must be an integer'],
    ['table', { action: 'insert', line: 3, rows: 'two', columns: 2 }, 'rows must be'],
    ['page_parts', { action: 'read', part: 7 }, 'part must be'],
    ['page_parts', { action: 'add_footnote', after_text: 5, text: 'x' }, 'after_text is required'],
  ];
  for (const [name, args, words] of calls) {
    await fresh(docSpec());
    const posts = () => fake.log.filter((x) => x.method === 'POST').length;
    const n = posts();
    const r = await exec(name, args);
    assert.strictEqual(r._ok, false, `${name} ${JSON.stringify(args)}: ${r.content}`);
    assert.ok(r.content.includes(words), r.content);
    assert.strictEqual(posts(), n, name);
  }
});
