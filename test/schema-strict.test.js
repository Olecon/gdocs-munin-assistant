'use strict';
// Every tool schema must satisfy OpenAI's strict mode: each object (including array items) lists every property in
// required and sets additionalProperties: false. A schema that breaks this is refused by the API with HTTP 400 and
// the fake streams of the other tests never notice.
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');

function checkObject(schema, path, problems) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties || {});
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const req = schema.required || [];
    for (const k of keys) if (!req.includes(k)) problems.push(`${path}.${k}: missing from required`);
    for (const k of keys) checkObject(schema.properties[k], `${path}.${k}`, problems);
  }
  if (schema.type === 'array') checkObject(schema.items, `${path}[]`, problems);
  for (const alt of schema.anyOf || []) checkObject(alt, path, problems);
}

test('tool schemas satisfy OpenAI strict mode (required lists every property, additionalProperties false, array items too)', async () => {
  const env = await load();
  const { T } = env;
  const problems = [];
  // Every registered tool, offered in this turn or not (search needs a keyed Munin account).
  const defs = [...Object.values(T.TOOL_DEFS), ...T.EXTRA_TOOLS.flatMap((t) => t.defs)];
  assert.ok(defs.some((d) => d.function.name === 'search'));
  for (const d of defs) checkObject(d.function.parameters, d.function.name, problems);
  assert.deepStrictEqual(problems, []);
  env.close && env.close();
});
