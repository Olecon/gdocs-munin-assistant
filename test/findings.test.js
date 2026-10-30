'use strict';
// Anchored findings (src/findings.js): the tolerant parser (a fenced block, text around it, a bare array, missing
// fields, trailing commas, an answer cut off mid-way, a Munin-style sloppy answer), quote verification with the
// normalized matching of replace_text (real line numbers, the hit nearest the claimed line, elisions, look-alike
// letters, unverified quotes), the order by group, the Markdown and the findings that Fix flagged may address.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let T;
before(async () => { ({ T } = await load()); });

const DOC = [
  '# Fatigue trial',
  'The treatment cures fatigue in all patients.',
  '## Methods',
  'We enrolled 40 patients with "chronic fatigue".',
  '## Results',
  'The response rate was 42 % and fatigue scores fell by 12% (Table 1).',
  'The response rate was 42 % in the second cohort too.',
].join('\n');

// What Munin (qwen, raw mode) sends back when it half-follows the schema: prose around a fence, capitalized and
// unusual severities, a line given as "L6", typographic quotes inside the quote, trailing commas, an absence without
// "checked", a claim check with a long status.
const MUNIN_SLOPPY = `Here is my review of the document:
\`\`\`json
{
  "criteria": {"claims": "FAIL", "methods": "pass", "numbers": "Fail",},
  "findings": [
    {"severity": "Major", "criterion": "Numbers", "quote": "“response rate was 42 %”", "line": "L6", "detail": "The abstract gives 40%.", "action": "Use one value."},
    {"severity": "high", "criterion": "methods", "absence": {"where": "Methods", "expected": "a sample size calculation"}},
    {"criterion": "support", "quote": "The treatment cures fatigue", "line": 2, "status": "stronger than the results", "evidence": {"quote": "fatigue scores fell by 12%", "line": 6}},
    {"severity": "minor", "criterion": "terms", "quote": "an invented sentence nobody wrote", "line": 3, "detail": "x"},
  ],
}
\`\`\`
Hope this helps!`;

test('parseJsonLoose: whole text, a fence, text around it, a bare array, trailing commas, a cut-off answer', () => {
  deq(T.parseJsonLoose('{"a":1}'), { a: 1 });
  deq(T.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  deq(T.parseJsonLoose('Sure! {"a": [1, 2,],} and that is all {"b":2}'), { a: [1, 2] });
  deq(T.parseJsonLoose('Result:\n[{"quote":"x"}]\nDone.'), [{ quote: 'x' }]);
  // cut off by the length limit: the complete elements are kept
  deq(T.parseJsonLoose('{"findings":[{"quote":"a","line":1},{"quote":"b","li'), { findings: [{ quote: 'a', line: 1 }] });
  deq(T.parseJsonLoose('{"criteria":{"claims":"PASS"},"findings":[{"quote":"a {b}","line":1}'), { criteria: { claims: 'PASS' }, findings: [{ quote: 'a {b}', line: 1 }] });
  assert.strictEqual(T.parseJsonLoose('no json here'), null);
  assert.strictEqual(T.parseJsonLoose(''), null);
  assert.strictEqual(T.parseJsonLoose('42'), null);
});

test('parseFindings: the Munin-style sloppy answer is read field by field', () => {
  const r = T.parseFindings(MUNIN_SLOPPY);
  assert.strictEqual(r.ok, true);
  deq(r.criteria, { claims: 'FAIL', methods: 'PASS', numbers: 'FAIL' });
  assert.strictEqual(r.findings.length, 4);
  deq(r.findings[0], { severity: 'major', criterion: 'numbers', quote: 'response rate was 42 %', line: 6, detail: 'The abstract gives 40%.', action: 'Use one value.' });
  deq(r.findings[1], { severity: 'critical', criterion: 'methods', quote: '', line: null, detail: '', action: '', absence: { where: 'Methods', expected: 'a sample size calculation', checked: '' } });
  assert.strictEqual(r.findings[2].status, 'stronger');
  deq(r.findings[2].evidence, { quote: 'fatigue scores fell by 12%', line: 6 });
});

test('parseFindings: a bare array, missing fields, aliases, one finding alone, empty lists; nothing parses: the error', () => {
  const bare = T.parseFindings('[{"quote":"The treatment cures fatigue","problem":"overstated","fix":"Say: reduced"}, "Define LF early", {"foo":1}]');
  assert.strictEqual(bare.ok, true);
  deq(bare.findings.map((f) => [f.severity, f.quote, f.detail, f.action]), [['minor', 'The treatment cures fatigue', 'overstated', 'Say: reduced'], ['minor', '', 'Define LF early', '']]);
  deq(T.parseFindings('{"issues":[{"text":"a b c","line":"line 7","level":"medium"}]}').findings.map((f) => [f.quote, f.line, f.severity]), [['a b c', 7, 'major']]);
  deq(T.parseFindings('{"quote":"x y","detail":"d"}').findings.map((f) => f.quote), ['x y']);
  const none = T.parseFindings('{"criteria":[{"criterion":"claims","result":"pass"},{"id":"refs","verdict":false}],"findings":[]}');
  assert.strictEqual(none.ok, true);
  deq(none.criteria, { claims: 'PASS', refs: 'FAIL' });
  deq(none.findings, []);
  const bad = T.parseFindings('I could not review this document, sorry.');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'The review did not come back as findings.');
  assert.strictEqual(bad.raw, 'I could not review this document, sorry.');
  assert.strictEqual(T.parseFindings('{"summary":"fine"}').ok, false);
});

test('verifyFindings: the real line from the hit, normalized matching, elisions, look-alike letters, unverified quotes', () => {
  const list = T.parseFindings(MUNIN_SLOPPY).findings;
  const v = T.verifyFindings(list, DOC);
  // "response rate was 42 %" is on lines 6 and 7: the one nearest the claimed line wins
  deq([v[0].verified, v[0].line, v[0].claimedLine], [true, 6, 6]);
  assert.strictEqual(v[1].verified, undefined); // an absence has no quote
  deq([v[2].verified, v[2].line, v[2].evidence.verified, v[2].evidence.line], [true, 2, true, 6]);
  deq([v[3].verified, v[3].line], [false, 3]);
  const one = (quote, line = null) => T.verifyFindings([{ severity: 'minor', criterion: '', quote, line, detail: '', action: '' }], DOC)[0];
  // a wrong line number is corrected; the other occurrence is taken when it is nearer
  deq([one('response rate was 42 %', 1).line, one('response rate was 42 %', 9).line], [6, 7]);
  // typographic quotes, dashes and runs of spaces; a Cyrillic look-alike letter; an elided middle
  deq([one('with «chronic fatigue»').line, one('We  enrolled 40 patients').line, one('The trеatment cures').line], [4, 4, 2]);
  assert.strictEqual(one('The response rate was 42 % and … fell by 12% (Table 1).').verified, true);
  assert.strictEqual(one('fatigue scores rose by 12%').verified, false);
});

test('sortFindings and findingGroup: critical, major, minor, supported, unverified; by line inside a group', () => {
  const f = (severity, line, extra = {}) => ({ severity, criterion: 'x', quote: 'q', line, detail: '', action: '', verified: true, ...extra });
  const sorted = T.sortFindings([f('minor', 3), f('major', 9), { ...f('critical', 5), verified: false }, f('major', 2), f('minor', 1, { status: 'supported' }), f('critical', 8)]);
  deq(sorted.map((x) => [T.findingGroup(x), x.line]), [['critical', 8], ['major', 2], ['major', 9], ['minor', 3], ['ok', 1], ['unverified', 5]]);
  const flagged = T.flaggedFindings(sorted);
  deq(flagged.map((x) => x.line), [8, 2, 9, 3]);
  // an absence (no quote) is not flagged for a fix
  assert.strictEqual(T.flaggedFindings([{ severity: 'major', quote: '', absence: { where: 'Methods', expected: 'x', checked: '' } }]).length, 0);
});

test('findingsMarkdown: counts, criteria, groups, quotes, claim checks, absences, unverified lines', () => {
  const list = T.sortFindings(T.verifyFindings(T.parseFindings(MUNIN_SLOPPY).findings, DOC));
  const md = T.findingsMarkdown({ findings: list, criteria: { claims: 'FAIL', methods: 'PASS' } }, { title: 'Review', labels: { claims: 'Claims vs evidence', numbers: 'Numbers', methods: 'Methods', support: 'Support' } });
  const lines = md.split('\n');
  assert.strictEqual(lines[0], '**Review**: 1 critical, 1 major, 1 minor, 1 unverified');
  assert.strictEqual(lines[1], 'Criteria: Claims vs evidence: FAIL; Methods: PASS');
  assert.ok(md.includes('**Critical**\n1. Methods: Missing: a sample size calculation; looked in Methods'));
  assert.ok(md.includes('Numbers, line 6: «response rate was 42 %» The abstract gives 40%. Fix: Use one value.'));
  assert.ok(md.includes('Support, line 2: «The treatment cures fatigue» Stronger than the results. Checked against line 6: «fatigue scores fell by 12%»'));
  assert.ok(md.includes('**Unverified: quote not found**\n4. terms, line 3?: «an invented sentence nobody wrote» x'));
  assert.strictEqual(T.findingsMarkdown({ findings: [], criteria: {} }), '**Findings**: no findings');
});
