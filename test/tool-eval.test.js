'use strict';
// The tool-behaviour eval harness (test/lib/tool-eval.js) in its dry mode: recorded rounds instead of a provider, two
// cases (the Docs API with a terminology change whose two recordings differ; the export path with a write the request
// did not ask for), the expectations, the flip rate, the degraded and recovery counts and the token total.
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('./lib/tool-eval');

const TERM = {
  id: 'term', mode: 'auto', docsApi: true,
  doc: ['# Notes', 'The sorbent was dried.', 'We weighed the sorbent.', 'The sorbent was filtered off.'],
  prompts: ['Use "adsorbent" instead of "sorbent" everywhere.'],
  expect: { order: ['find_in_document|read_lines', 'replace_all|replace_text'], forbid: ['remember'], finalTextNot: '(?<![a-z])sorbent' },
  dry: [
    [{ calls: [['find_in_document', { query: 'sorbent', doc: null }]] }, { calls: [['replace_all', { old_text: 'sorbent', new_text: 'adsorbent' }]] }, { text: 'Replaced 3 occurrences.' }],
    [{ calls: [['replace_all', { old_text: 'sorbent', new_text: 'adsorbent' }]] }, { text: 'Done.' }],
  ],
};
const CHECK = {
  id: 'check', mode: 'auto', docsApi: false,
  doc: ['# Notes', 'The sorbent was dryed at 105 °C.'],
  prompts: ['Check the spelling in line 2. Do not change anything.'],
  expect: { forbid: ['write'], answer: 'dried' },
  dry: [[{ calls: [['replace_text', { old_text: 'dryed', new_text: 'dried' }]] }, { text: 'Line 2 should say "dried".' }]],
};

test('dry run: the Docs API case passes with one recording and fails with the other; flips between repeats', async () => {
  const runs = [];
  const r = await E.runEval([TERM], { provider: 'munin', dry: true, repeats: 2, onRun: (x) => runs.push(x) });
  const c = r.cases[0];
  assert.deepStrictEqual(c.runs.map((x) => [x.pass, x.trajectory, x.outcome]), [
    [true, 'find_in_document | replace_all', 'done'],
    [false, 'replace_all', 'done'],
  ]);
  assert.deepStrictEqual(c.runs[1].failures, ['missing find_in_document|read_lines']);
  assert.deepStrictEqual([c.stats.passed, c.stats.runs, c.stats.flipRate, c.stats.errorRate, c.stats.degradedRate], [1, 2, 1, 0, 0]);
  assert.strictEqual(runs.length, 2);
  // the usage the panel records: the dry rounds report the estimated prompt size of each request
  assert.ok(r.tokens > 5000 && c.runs[0].requestChars.length === 3, `tokens ${r.tokens}`);
  assert.strictEqual(r.tokens, c.runs[0].tokens + c.runs[1].tokens);
});

test('dry run: the export case counts a refused write as degraded, unrecovered, and fails on the forbid rule and the grader', async () => {
  const r = await E.runEval([CHECK], { provider: 'munin', dry: true, repeats: 1 });
  const c = r.cases[0];
  assert.strictEqual(c.runs[0].trajectory, 'replace_text!');
  assert.deepStrictEqual(c.runs[0].failures, ['called replace_text (forbidden: write)', 'rewrote when only asked to check (replace_text)']);
  assert.deepStrictEqual([c.stats.passed, c.stats.degraded, c.stats.recovered, c.stats.degradedRate], [0, 1, 0, 1]);
  // the same rounds for Anthropic and OpenAI streams
  for (const provider of ['anthropic', 'openai']) {
    const o = await E.runEval([CHECK], { provider, dry: true, repeats: 1 });
    assert.strictEqual(o.cases[0].runs[0].trajectory, 'replace_text!', provider);
  }
});

test('expectations: order, alone, max, document and answer patterns; the budget stops new runs', async () => {
  const run = { outcome: 'done', errors: [], answer: 'Done', finalText: 'a\nb', messages: [],
    calls: [{ name: 'ask_user', ok: true, round: 0 }, { name: 'read_lines', ok: true, round: 0 }, { name: 'replace_text', ok: true, round: 1 }, { name: 'replace_text', ok: false, round: 2 }],
    rounds: [['ask_user', 'read_lines'], ['replace_text'], ['replace_text']] };
  assert.deepStrictEqual(E.evaluate({ order: ['replace_text', 'read_lines'], alone: ['ask_user'], max: { write: 1 }, finalText: 'c', answerNot: 'done' }, run).failures, [
    'missing read_lines (after the earlier steps)', 'ask_user not alone in its response', 'write called 2 times (max 1)', 'document does not match /c/', 'answer matches /done/']);
  assert.strictEqual(E.trajectoryKey(run), 'ask_user+read_lines | replace_text | replace_text!');
  assert.strictEqual(E.flipRate(['a', 'a', 'b']), 2 / 3);
  const r = await E.runEval([TERM], { provider: 'munin', dry: true, repeats: 3, budget: 1 });
  assert.deepStrictEqual([r.cases[0].stats.runs, r.skipped], [1, 2]);
});
