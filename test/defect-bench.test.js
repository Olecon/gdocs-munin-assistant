'use strict';
// The seeded-defect benchmark (test/fixtures/bench, test/lib/defect-bench.js): every planted defect of an implemented
// check is found, the known misses are still missed, the clean control gives no finding, and the transcript graders.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, deq } = require('./lib/sandbox');
const B = require('./lib/defect-bench');

let T, bench, findings, result;

before(async () => {
  ({ T } = await load({ settle: 0 }));
  bench = B.loadBench();
  findings = B.runChecks(T, bench);
  result = B.score(bench, findings);
});

const where = (d) => `${d.file} ${d.kind}: ${d.quote}${d.foundAs && d.foundAs.length ? ` (found as ${d.foundAs.join(', ')})` : ''}`;

test('fixtures: four documents in English and Russian, every check planted', () => {
  assert.strictEqual(bench.documents.length, 4);
  assert.strictEqual(bench.documents.filter((d) => d.control).length, 1);
  for (const check of B.CHECKS) assert.ok(bench.defects.some((d) => d.check === check && !d.planned), check);
  for (const kind of ['acronym-before-definition', 'acronym-undefined', 'dangling-figure', 'dangling-table', 'uncited-reference']) {
    assert.ok(bench.defects.some((d) => d.kind === kind && d.check === 'check'), kind);
  }
});

test('every planted defect of an implemented check is found', () => {
  const missed = result.misses.filter((d) => !d.knownMiss);
  assert.deepStrictEqual(missed.map(where), []);
});

test('the known misses are still missed (a fixed check: drop knownMiss from defects.json)', () => {
  const known = bench.defects.filter((d) => d.knownMiss);
  for (const d of known) assert.ok(result.misses.some((m) => m.file === d.file && m.quote === d.quote && m.kind === d.kind), `now found: ${where(d)}`);
});

test('the control document and its revision give no finding', () => {
  const control = result.falsePositives.filter((f) => f.control);
  assert.deepStrictEqual(control.map((f) => `${f.file} ${f.kind} ${f.text}`), []);
  assert.strictEqual(findings.filter((f) => f.file.startsWith('control-')).length, 0);
});

test('the unplanted text of the other documents gives no finding either', () => {
  assert.deepStrictEqual(result.falsePositives.map((f) => `${f.file} ${f.kind} ${f.text}`), []);
});

test('/check: the acronym, pointer and reference-list defects are scored and all found', () => {
  const want = { 'acronym-before-definition': 2, 'acronym-undefined': 4, 'dangling-figure': 2, 'dangling-table': 1, 'uncited-reference': 3 };
  for (const [kind, n] of Object.entries(want)) {
    deq([result.kinds[kind].planted, result.kinds[kind].found, result.kinds[kind].planned], [n, n, 0]);
  }
  assert.strictEqual(result.planned, 0);
  // the unknown citations the citation check plants are found by /check too (same kind: not counted twice)
  const cites = bench.defects.filter((d) => d.kind === 'unknown-citation' && !/doi:/.test(d.quote));
  for (const d of cites) assert.ok(findings.some((f) => f.check === 'check' && f.kind === 'unknown-citation' && f.file === d.file && f.start < d.end && f.end > d.start), d.quote);
});

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('grader "rewrote when only asked to check": a write or a Manual edit block after a check-only request', () => {
  const rewrote = [
    { role: 'user', content: 'Check the numbers in the Results section.' },
    { role: 'assistant', content: null, tool_calls: [call('a', 'read_lines', { start: 1, end: 20 })] },
    { role: 'tool', tool_call_id: 'a', content: '1: Results', _ok: true },
    { role: 'assistant', content: null, tool_calls: [call('b', 'replace_text', { old_text: '42', new_text: '24' })] },
    { role: 'tool', tool_call_id: 'b', content: 'Replaced', _ok: true },
    { role: 'assistant', content: 'Fixed one number.' },
  ];
  let g = B.gradeTranscript({ messages: rewrote })[0].rewrote;
  assert.deepStrictEqual([g.applies, g.pass, g.writes], [true, false, ['replace_text']]);
  g = B.gradeTranscript([{ role: 'user', content: 'Проверь ссылки в тексте' }, { role: 'assistant', content: 'Вот так:\n<replacement>Новый текст</replacement>' }])[0].rewrote;
  assert.deepStrictEqual([g.applies, g.pass, g.block], [true, false, true]);
  g = B.gradeTranscript([{ role: 'user', content: 'Check the numbers and fix them.' }, ...rewrote.slice(1)])[0].rewrote;
  assert.deepStrictEqual([g.applies, g.pass], [false, true]);
  g = B.gradeTranscript([rewrote[0], rewrote[1], rewrote[2], { role: 'assistant', content: 'Line 3 says 42, the table says 24.' }])[0].rewrote;
  assert.deepStrictEqual([g.applies, g.pass], [true, true]);
});

test('grader "claimed checks it never ran": a claim without a reading call fails; turns are split at user messages', () => {
  const t = [
    { role: 'user', content: 'Are the citations all in the reference list?' },
    { role: 'assistant', content: 'I checked every citation: all citations are in the list.' },
    { role: 'user', content: 'И цифры тоже?' },
    { role: 'assistant', content: null, tool_calls: [call('c', 'find_in_document', { query: '%' })] },
    { role: 'tool', tool_call_id: 'c', content: '3 matches', _ok: true },
    { role: 'user', content: 'continue', _auto: true },
    { role: 'assistant', content: 'Я проверил все числа: все числа совпадают.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'You are welcome.' },
  ];
  const g = B.gradeTranscript(t, { T });
  assert.strictEqual(g.length, 3);
  assert.deepStrictEqual([g[0].claimed.applies, g[0].claimed.pass, g[0].claimed.reads], [true, false, 0]);
  assert.deepStrictEqual([g[1].claimed.applies, g[1].claimed.pass, g[1].claimed.reads], [true, true, 1]);
  assert.deepStrictEqual([g[2].claimed.applies, g[2].claimed.pass], [false, true]);
});
