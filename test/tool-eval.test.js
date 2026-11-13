'use strict';
// The tool-behaviour eval harness (test/lib/tool-eval.js) in its dry mode: recorded rounds instead of a provider, two
// cases (the Docs API with a terminology change whose two recordings differ; the export path with a write the request
// did not ask for), the expectations, the flip rate, the degraded and recovery counts and the token total.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// The case file of the live eval (test/fixtures/tool-eval-cases.json). The language and format cases: every recorded
// script passes, and a script that breaks the rule fails on the expectation that guards it, so a loosened regex shows here.
const ALL = E.loadCases();
const LANG_IDS = ['ru-request-en-doc', 'numbered-list-section', 'side-no-markdown', 'ru-dash-typography', 'add-sentence-plain', 'cite-claim-search'];
const LANG = LANG_IDS.map((id) => ALL.find((c) => c.id === id));

test('language and format cases: the recorded scripts pass dry, every paraphrase', async () => {
  const r = await E.runEval(LANG, { provider: 'munin', dry: true, repeats: 1 });
  for (const c of r.cases) for (const run of c.runs) assert.ok(run.pass, `${c.id} p${run.paraphrase}: ${run.failures.join('; ')}`);
  assert.deepStrictEqual(r.cases.map((c) => c.stats.runs), [3, 3, 3, 3, 3, 3]);
});

test('language and format cases: a script that breaks the rule fails on its expectation', async () => {
  const bad = {
    'ru-request-en-doc': [[{ calls: [['replace_selection', { text: 'Мы нагревали фермент при 50, 60 и 70 °C; через час при 60 °C он сохранил 74 % активности.' }]] }, { text: 'Done.' }]],
    'numbered-list-section': [[{ calls: [['insert_after_line', { line: 12, text: '## 5. Limitations\n1. One enzyme batch.\n2. Two buffers.\n3. Nothing above 70 °C.', style: 'outline' }]] }, { text: 'Added.' }]],
    'side-no-markdown': [[{ text: 'Rewritten:\n<replacement>At 60 °C the half-life was **42 min** (p = 0.02).</replacement>' }]],
    'ru-dash-typography': [[{ calls: [['replace_text', { old_text: 'сорбента - 1,85', new_text: 'сорбента — 1,85' }]] }, { text: 'Готово.' }]],
    'add-sentence-plain': [[{ calls: [['replace_text', { old_text: 'after one hour at 60 °C.', new_text: 'after one hour at 60 °C. The enzyme came from a `soil isolate`.' }]] }, { text: 'Added.' }]],
    'cite-claim-search': [[{ calls: [['replace_selection', { text: 'Lipases are the second most widely used enzymes in household detergents after proteases (doi:10.5555/eval.lipase.2010).' }]] }, { text: 'Cited.' }]],
  };
  const r = await E.runEval(LANG.map((c) => ({ ...c, dry: bad[c.id] })), { provider: 'munin', dry: true, repeats: 1, paraphrases: [0] });
  const failures = Object.fromEntries(r.cases.map((c) => [c.id, c.runs[0].failures]));
  assert.deepStrictEqual(failures, {
    // the language check (src/lang-check.js) refuses the Russian replacement of the English paragraph, so the write never
    // lands: the case fails on the missing write and on the English answer
    'ru-request-en-doc': ['missing replace_selection|replace_text|edit_document', 'answer does not match /[А-Яа-яЁё]/'],
    'numbered-list-section': ['document matches /(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*[.)]|[-*•])\\s/'],
    'side-no-markdown': ['answer matches /<replacement>(?:(?!</replacement>)[\\s\\S])*\\*\\*/'],
    'ru-dash-typography': ['document matches / - /'],
    'add-sentence-plain': ['document matches /\\*\\*|`|#/'],
    'cite-claim-search': ['missing search', 'document does not match /10\\.\\d{4,}//'], // the DOI without a search is refused (provenance)
  });
});

// The other recorded cases: their scripts still play through the turn loop (the first paraphrase), with the verdicts the
// recordings were made for (term-replace-all alternates a passing script and one without the search step; fix-typo misses its first
// old_text, recovers and passes).
const CHAT_IDS = E.loadSets()['saved-chats'];
const PRECEDENCE_IDS = E.loadSets().precedence;
// The Manual cases' second scripts (Manual edits and asks on a card before every write): one call per change, a retry
// after a denied card with a claim, the read-only chat turn's block instead of the paste, a list request fixed.
const MANUAL_FAILURES = {
  'manual-groups-edits': ['write called 3 times (max 1)'],
  'manual-denied-edit': ['write called 2 times (max 1)', `answer matches /${ALL.find((c) => c.id === 'manual-denied-edit').expect.answerNot}/`],
  'manual-export-selection': ['missing replace_selection', `document matches /${ALL.find((c) => c.id === 'manual-export-selection').expect.finalTextNot}/`],
  'manual-list-every-typo': ['called edit_document (forbidden: write)', `answer does not match /${ALL.find((c) => c.id === 'manual-list-every-typo').expect.answer}/`,
    'rewrote when only asked to check (edit_document)'],
};
test('case file: the recorded scripts of the other cases play dry with their expected verdicts', async () => {
  const rest = ALL.filter((c) => !LANG_IDS.includes(c.id) && !CHAT_IDS.includes(c.id) && !PRECEDENCE_IDS.includes(c.id) && Array.isArray(c.dry) && c.dry.length);
  const r = await E.runEval(rest, { provider: 'munin', dry: true, repeats: 2, paraphrases: [0] });
  const got = Object.fromEntries(r.cases.map((c) => [c.id, c.runs.map((x) => (x.outcome === 'done' ? (x.pass ? 'pass' : 'fail') : x.outcome))]));
  assert.deepStrictEqual(got, {
    'term-replace-all': ['pass', 'fail'], 'short-selection': ['pass', 'pass'], 'fix-typo': ['pass', 'pass'], 'remember-explicit': ['pass', 'pass'],
    'check-only': ['pass', 'pass'], 'manual-groups-edits': ['pass', 'fail'], 'manual-denied-edit': ['pass', 'fail'], 'export-selection': ['pass', 'pass'],
    'manual-export-selection': ['pass', 'fail'], 'copy-heavy-edit': ['pass', 'pass'], 'refs-then-plain-edit': ['pass', 'pass'], 'highlight-repeated-doi': ['pass', 'pass'],
    'manual-list-every-typo': ['pass', 'fail'], 'section-heading-outline': ['pass', 'fail'], 'grey-headings-black': ['pass', 'fail'],
  });
  for (const [id, failures] of Object.entries(MANUAL_FAILURES)) assert.deepStrictEqual(r.cases.find((c) => c.id === id).runs[1].failures, failures, id);
  // the saved chat's script: the sentence made a heading fails on its style, and its result names the way out
  const bad = r.cases.find((c) => c.id === 'section-heading-outline').runs[1];
  assert.deepStrictEqual(bad.failures, ['line /enzyme batch/: style HEADING_2, expected NORMAL_TEXT'], bad.failures.join('; '));
  // black on headings that show black already: no note of a miss, but the grey h4 lines stay grey
  const grey = r.cases.find((c) => c.id === 'grey-headings-black').runs[1];
  assert.deepStrictEqual(grey.failures, [`formatting does not match /${byId('grey-headings-black').expect.finalFormatting}/`], grey.failures.join('; '));
  const once = await dryOne(byId('section-heading-outline'), byId('section-heading-outline').dry[1]);
  assert.ok(once.results.some((x) => x.includes('Note: line 5 reads like body text, yet h2 now: format_lines style normal, or undo_last_edit and insert with style outline.')), once.results.join('\n'));
});

// The precedence cases (set precedence, audit A19, A37): requests that a rule of the head would block, which the
// user's explicit request now outranks. The first script obeys the user (every paraphrase passes; plan-no-questions runs
// in Plan mode), the second follows the rule against the order and fails on the expectation that guards it. (A34's
// manual-list-every-typo left the set with w19: the read-only Manual's rule it outranked is now only in /side.)
const PRECEDENCE_FAILURES = {
  'separate-edits-undo': ['called edit_document (forbidden: edit_document)', 'write succeeded 1 times (min 2)'],
  'plan-no-questions': ['called ask_user (forbidden: ask_user)'],
};
test('precedence cases: the script that obeys the user passes, the one that follows the rule against the order fails', async () => {
  const cases = PRECEDENCE_IDS.map((id) => byId(id)); // byId, dryOne: below (defined before any test runs)
  const good = await E.runEval(cases.map((c) => ({ ...c, dry: [c.dry[0]] })), { provider: 'munin', dry: true, repeats: 1 });
  for (const c of good.cases) for (const run of c.runs) assert.ok(run.pass, `${c.id} p${run.paraphrase}: ${run.failures.join('; ')}`);
  assert.deepStrictEqual(good.cases.map((c) => c.stats.runs), [3, 3]);
  const bad = await E.runEval(cases.map((c) => ({ ...c, dry: [c.dry[1]] })), { provider: 'munin', dry: true, repeats: 1, paraphrases: [0] });
  assert.deepStrictEqual(Object.fromEntries(bad.cases.map((c) => [c.id, c.runs[0].failures])), PRECEDENCE_FAILURES);
  // the Plan case runs in Plan mode
  const plan = await dryOne(byId('plan-no-questions'), byId('plan-no-questions').dry[0]);
  assert.strictEqual(plan.messages[0]._mode, 'plan');
});

// The 2026-11-01 incident replayed: five format_text operations, the first a DOI cited twice, refused; the model gave up.
test('highlight-repeated-doi: the incident script fails on the refused write, the unhighlighted DOIs and the answer', async () => {
  const c = ALL.find((x) => x.id === 'highlight-repeated-doi');
  const ops = ['[10.1016/j.bpj.2022.08.002]', '[10.1021/acs.jpcb.1c01234]', '[10.1063/5.0012345]', '[10.1103/PhysRevE.99.012345]', '[10.1039/c8cp01234a]']
    .map((t) => ({ op: 'format_text', old_text: t, highlight: 'green' }));
  const dry = [[{ calls: [['edit_document', { operations: ops }]] }, { text: 'The DOI occurs twice, so please highlight them manually.' }]];
  const r = await E.runEval([{ ...c, dry }], { provider: 'munin', dry: true, repeats: 1, paraphrases: [0] });
  const run = r.cases[0].runs[0];
  assert.strictEqual(run.trajectory, 'edit_document!');
  assert.deepStrictEqual(run.failures, ['missing format_text|edit_document', 'formatting does not match /bg=#/', 'formatting matches /\\[10\\.\\d{4,}/[^\\]\\s]+\\](?!\\}\\()/', 'answer matches /manually|by hand|вручную/']);
});

test('requirements: a case whose requirement is not met is skipped live, run otherwise; the dry run ignores them', async () => {
  const cite = ALL.find((c) => c.id === 'cite-claim-search');
  assert.deepStrictEqual(cite.requires, ['munin-key']);
  assert.deepStrictEqual(E.unmetRequirements(cite, { 'munin-key': false }), ['munin-key']);
  // the panel's searchAccount decides: a keyed Munin account, as the chat's provider or beside another one
  assert.deepStrictEqual(await E.requirementsMet({ provider: 'openai', apiKey: 'sk-T' }), { 'munin-key': false, 'web-search': true });
  assert.deepStrictEqual(await E.requirementsMet({ provider: 'openai', apiKey: 'sk-T', muninKey: 'k-T' }), { 'munin-key': true, 'web-search': true });
  assert.deepStrictEqual(await E.requirementsMet({ provider: 'munin', apiKey: 'k-T' }), { 'munin-key': true, 'web-search': false });
  // hosted web search: OpenAI and Anthropic only, so the web case is skipped on Munin
  const web = ALL.find((c) => c.id === 'web-text-no-links');
  assert.deepStrictEqual(E.unmetRequirements(web, await E.requirementsMet({ provider: 'munin', apiKey: 'k-T' })), ['web-search']);
  assert.deepStrictEqual(E.unmetRequirements(web, await E.requirementsMet({ provider: 'anthropic', apiKey: 'sk-ant-T' })), []);
  const skipped = await E.runEval([cite, TERM], { provider: 'openai', dry: true, repeats: 1, paraphrases: [0], met: { 'munin-key': false } });
  assert.deepStrictEqual(skipped.cases.map((c) => [c.id, c.unmet || null, c.runs.length]), [['cite-claim-search', ['munin-key'], 0], ['term', null, 1]]);
  // with a Munin key the case runs on OpenAI and Anthropic too: the Munin account offers the search tool
  for (const provider of ['openai', 'anthropic']) {
    const r = await E.runEval([cite], { provider, dry: true, repeats: 1, paraphrases: [0], met: { 'munin-key': true } });
    assert.ok(r.cases[0].runs[0].pass, `${provider}: ${r.cases[0].runs[0].failures.join('; ')}`);
  }
  // without the requirement there is no Munin account on OpenAI, so no search tool: the recorded search call fails
  const bare = await E.runEval([{ ...cite, requires: [] }], { provider: 'openai', dry: true, repeats: 1, paraphrases: [0] });
  assert.ok(bare.cases[0].runs[0].failures.includes('missing search'), bare.cases[0].runs[0].failures.join('; '));
  // a misspelt requirement is an error when the file loads, not a case that silently always runs
  const file = path.join(os.tmpdir(), `tool-eval-req-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ cases: [{ ...TERM, requires: ['munin_key'] }] }));
  try { assert.throws(() => E.loadCases(file), /unknown requirement munin_key/); } finally { fs.unlinkSync(file); }
});

// ---- The cases of the two saved chats (set saved-chats; their notes name the findings: "alignment F1", "plans F4") ---
// Each has two recorded scripts: the expected behaviour first, the saved chat's second. The second fails on the
// expectation that guards the finding. The first passes, except where the code has the defect itself: those fail dry with
// the failures listed in KNOWN_DEFECTS ({ id: [failures] }, with the reason in a comment). When a fix lands, this test
// fails here: delete the entry, and the case then guards the fix. The four entries of the first recording (alignment
// F2-F5: the format overlap, numbering under a title and its 14 pt, provenance of an earlier message, superscript digits)
// were closed by their fixes.
const KNOWN_DEFECTS = {};
// Where a defect was in the code, the saved chat's script replays the model's reaction to it: on the fixed code its
// retry is a second write (heading-bold-spacing: a no-op; numbers-from-earlier-message: the sentence twice) or a failed
// call (superscript-affiliations: the old text is gone), which the guards still catch.
const SAVED_CHAT_FAILURES = {
  'cite-plain-doi': ['missing replace_text|edit_document|replace_all', 'called cite (forbidden: cite)', '1 failed or refused calls (max 0): cite',
    'document does not match /bilayer\\.?\\s?\\[10\\.5555/eval\\.transport\\.2021\\]/', 'answer refuses ("не могу")'],
  'cite-after-not-now': ['message 2: missing replace_text|edit_document|replace_all', 'message 2: called find_reference (forbidden: find_reference)',
    'message 2: 1 failed or refused calls (max 0): find_reference', 'message 2: document does not match /bilayer\\.?\\s?\\[10\\.5555/eval\\.transport\\.2021\\]/',
    'message 2: answer refuses ("не могу")'],
  'heading-indent-like-this': ['line /^Sample preparation$/: indent 72/54 pt, line /^Software$/ has 28.5/21.26',
    'line /^Spectra$/: indent 72/54 pt, line /^Software$/ has 28.5/21.26'],
  // (the typed numbers take the headings' 12 pt, as inserted text takes its neighbour's style in Docs: no size failure)
  'number-sections': [...['Software', 'Sample preparation', 'Spectra'].flatMap((h) => [`line /${h}$/: text does not match /^${h}$/`,
    `line /${h}$/: numbered false, expected true`, `line /${h}$/: list level null, expected 0`]), 'lines /Software$/, /Sample preparation$/, /Spectra$/ are not items of one list'],
  'number-sections-si-prefix': ['document does not match /^Supplementary material\\nS1 Software\\n[^\\n]*\\nS2 Sample preparation\\n[^\\n]*\\nS3 Spectra\\n/'],
  'heading-bold-spacing': ['write called 2 times (max 1)'],
  'numbers-from-earlier-message': ['write called 2 times (max 1)'],
  'superscript-affiliations': ['1 failed or refused calls (max 0): edit_document'],
  'improve-one-paragraph': ['document does not match /calorimetr[^\\n]*fluorescen[^\\n]*spin.label/', 'answer matches /criteri|критери/'],
  'remember-in-english': ['remember arguments match /[А-Яа-яЁё]/'],
  'selection-twice': ['find_in_document called 1 times (max 0)'],
  'side-whole-selection': ['answer does not match /<replacement>[\\s\\S]*mean distance grew[\\s\\S]*washed out[\\s\\S]*</replacement>/'],
  // (Manual edits since w19: the saved chat's link is written into the document)
  'web-text-no-links': ['document matches /\\]\\(https?:|utm_source/'],
  'fix-after-user-fact': ['missing replace_text|replace_all|edit_document', 'document does not match /0\\.74[^\\n]*1\\.01/', 'document matches /0\\.47|1\\.10/'],
  // (message 2 may read again with style_map, which now reads the inherited indent: the headings' end state fails it)
  'headings-still-differ': ['Sample preparation', 'Spectra'].map((h) => `message 2: line /^${h}$/: indent 72/54 pt, line /^Software$/ has 28.5/21.26`),
  'side-template-no-translation': ['answer matches /перевод|translation|<(insertion|replacement)>(?:(?!</(?:insertion|replacement)>)[\\s\\S])*[А-Яа-яЁё]{3}/',
    'answer outside edit blocks has 336 characters (max 300)'],
  'translate-paragraph': ['document does not match /[А-Яа-яЁё]{4}[^\\n]*\\nMethods\\n/', 'document matches /Here we combine/'],
};
const byId = (id) => ALL.find((c) => c.id === id);
const dryOne = (c, script, opts = {}) => E.runOnce({ ...c, dry: [script] }, c.prompts[0], { provider: 'munin', dry: true, runIndex: 0, paraphrase: 0, ...opts });

test('chat cases: the expected script passes dry (or fails as a known defect), the saved chat\'s script fails on its guard', async () => {
  assert.deepStrictEqual(CHAT_IDS.filter((id) => !byId(id) || byId(id).dry.length !== 2), []);
  // two repeats of the first paraphrase: runs alternate the two scripts
  const r = await E.runEval(CHAT_IDS.map(byId), { provider: 'munin', dry: true, repeats: 2, paraphrases: [0] });
  for (const c of r.cases) {
    const [good, bad] = c.runs;
    assert.strictEqual(good.outcome, 'done', c.id);
    if (KNOWN_DEFECTS[c.id]) assert.deepStrictEqual(good.failures, KNOWN_DEFECTS[c.id], `${c.id}: the expected script no longer fails as recorded: if the defect is fixed, remove it from KNOWN_DEFECTS`);
    else assert.ok(good.pass, `${c.id}: ${good.failures.join('; ')}`);
    assert.deepStrictEqual(bad.failures, SAVED_CHAT_FAILURES[c.id], c.id);
  }
});

// What the code shows the model in three of the cases (the read side of the findings): style_map reads the selected
// heading's indent as Docs draws it, its named style's, marked inherited, and no list-level value (alignment F1; the
// formatting view tags it "indent style"), the turn context names both lines of a
// text that occurs twice and shows the short selection's text, so a get_selection the model still makes gets a pointer
// to it (alignment F7), and a vague improve request on one paragraph of a longer section gets no criteria line (plans
// F6). When a change alters what the model sees, update the pin.
test('chat cases: what the code shows the model (alignment F1, F7; plans F6)', async () => {
  const indent = await dryOne(byId('heading-indent-like-this'), byId('heading-indent-like-this').dry[0]);
  const seen = indent.messages.find((m) => m.role === 'tool'); // the full text the model saw (folded after the turn)
  const NOTE = 'To make a line match an inherited one, set its indent_start and indent_first_line to "style", not the numbers.';
  assert.strictEqual(seen._log || seen.content, ['indent (lines 1–7):', '- none: lines 1, 3, 5, 7', '- start 36, first line 18 pt: lines 4, 6',
    '- start 28.5, first line 21.26 pt, inherited (h2 style): line 2', '', NOTE].join('\n'));
  // the live Qwen's narrow call on the selected heading alone: the sides named (it read "28.5/21.26" as left/right) and the note
  const narrow = await dryOne(byId('heading-indent-like-this'), [{ calls: [['style_map', { property: 'indent', scope: { start: 2, end: 2 } }]] }, { text: '.' }]);
  assert.strictEqual(narrow.results[0], ['indent (line 2):', '- start 28.5, first line 21.26 pt, inherited (h2 style): line 2', '', NOTE].join('\n'));
  // the expected script removes the other headings' own indents (indent "style"): all three draw the named style's
  assert.match(indent.turns[0].results[1], /own indent removed, own first-line indent removed/);
  assert.deepStrictEqual(indent.lines.filter((l) => l.style === 'HEADING_2').map((l) => [l.text, l.indent, l.ownIndent, l.listLevel, l.numbered]),
    ['Software', 'Sample preparation', 'Spectra'].map((t) => [t, [28.5, 21.26], null, 1, true]));
  const sel = await dryOne(byId('selection-twice'), byId('selection-twice').dry[1]); // the saved chat's: get_selection first
  // and that any edit but replace_selection goes to the place meant or a question (the live Qwen italicised both, all: true)
  assert.match(String(sel.messages[0]._context), /the same text is on lines 3 and 5[^\n]* Other edits: only the place the request means \("this heading": the heading line\), or ask the user; never all of them\.\nIts text \(no need for get_selection\):\n<selection>\nSample preparation\n<\/selection>/);
  assert.strictEqual(sel.results[0], 'The selection is in the user message, in full (<selection>).');
  const imp = await dryOne(byId('improve-one-paragraph'), byId('improve-one-paragraph').dry[0]);
  assert.doesNotMatch(String(imp.messages[0]._context), /Criteria for improving/);
});

// headings-still-differ, message 2: "they are equal" again without a new reading or a question fails on both counts; the
// saved chat's own script (it read with style_map) fails on the end state alone.
test('headings-still-differ: message 2 needs a new reading or a question, and the headings drawn alike after it', async () => {
  const c = byId('headings-still-differ');
  const run = await dryOne(c, [c.dry[1][0], [{ text: 'Отступы одинаковые: текст 72 пт, первая строка 54 пт.' }]]);
  assert.deepStrictEqual(E.evaluateRun(c, run).failures, ['message 2: missing read_document|ask_user|style_map',
    ...['Sample preparation', 'Spectra'].map((h) => `message 2: line /^${h}$/: indent 72/54 pt, line /^Software$/ has 28.5/21.26`)]);
});

// ---- What the code tells the model after a refusal or a fix ----------------------------------------------------------
// The saved chat's edit_document retry that carried half of the refused call's operations without a word: the retry's
// result names the ones left out (the code says it; the prompt rule alone did not work), the model sends them next; a
// complete retry gets no note. A plain text fix in a document whose named styles differ from the sheet gets no
// named-styles note (it would invite an ask_user about styles); an insert does.
const FL1 = (n) => ({ op: 'format_lines', start: n, end: n, style: 'h1' });
const DROPPED = {
  id: 'dropped-ops', mode: 'auto', docsApi: true,
  doc: ['Report', 'Alpha beta.', '## Methods', 'Gamma delta.', '## Results', 'Epsilon.'],
  prompts: ['Make the two section headings Heading 1, "Alpha" bold, and change "Gamma" to "Omega".'],
  expect: { finalText: 'Omega delta', failedMax: 1 },
};
const REFUSED = { calls: [['edit_document', { operations: [FL1(3), FL1(5), { op: 'replace', old_text: 'Gama', new_text: 'Omega' }, { op: 'format_text', old_text: 'Alpha', bold: true }] }]] };
const RETRY_HALF = { calls: [['edit_document', { operations: [{ op: 'replace', old_text: 'Gamma', new_text: 'Omega' }, { op: 'format_text', old_text: 'Alpha', bold: true }] }]] };
test('dropped operations: the retry\'s result names what the refused call had; the model sends it next; a complete retry gets no note', async () => {
  const half = await E.runOnce({ ...DROPPED, dry: [[REFUSED, RETRY_HALF, { calls: [['edit_document', { operations: [FL1(3), FL1(5)] }]] }, { text: 'Done.' }]] },
    DROPPED.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(half.calls.map((x) => [x.name, x.ok]), [['edit_document', false], ['edit_document', true], ['edit_document', true]]);
  assert.match(half.results[1], /\nNote: not in this call, from the refused one: format_lines 3; format_lines 5\. Send them in another call or tell the user they were left out\.$/);
  assert.doesNotMatch(half.results[2], /not in this call/);
  assert.deepStrictEqual(E.evaluateRun(DROPPED, half), { pass: true, failures: [] });
  assert.deepStrictEqual(half.lines.filter((l) => l.style === 'HEADING_1').map((l) => l.text), ['Methods', 'Results']);
  const whole = await E.runOnce({ ...DROPPED, dry: [[REFUSED, { calls: [['edit_document', { operations: [FL1(3), FL1(5), ...RETRY_HALF.calls[0][1].operations] }]] }, { text: 'Done.' }]] },
    DROPPED.prompts[0], { provider: 'munin', dry: true });
  assert.ok(whole.results.every((r) => !/not in this call/.test(r)), whole.results.join('\n---\n'));
});

// The saved chat's reading loop (five identical reads of the headings until the round budget ran out): a script that
// repeats one read five times gets the result once, then pointers, and the third repeat ends the rounds with the wrap-up
// (a request without tools: the dry harness answers it as a side request), so the loop costs four rounds.
const LOOP = { id: 'read-loop', mode: 'auto', docsApi: true, doc: ['Report', '## Methods', 'Gamma delta.', '## Results', 'Epsilon.'],
  prompts: ['Set every font to Times New Roman.'], expect: { max: { read_document: 4 }, roundsMax: 4 } };
test('read loop: a script that repeats one read five times ends after the third repeat with an answer', async () => {
  const read = { calls: [['read_document', { scope: { start: 1, end: 5 }, include: ['text'], doc: null }]] };
  const run = await E.runOnce({ ...LOOP, dry: [[read, read, read, read, read, { text: 'Not reached.' }]] }, LOOP.prompts[0], { provider: 'munin', dry: true });
  assert.strictEqual(run.outcome, 'done', run.errors.join('; '));
  assert.deepStrictEqual(run.calls.map((x) => [x.name, x.ok]), Array.from({ length: 4 }, () => ['read_document', true]));
  const stop = 'You already have this result; the document has not changed. Do not read it again: go on with the task or answer the user.';
  assert.deepStrictEqual(run.results.slice(1), ['Already read in this message; the document has not changed since: see the earlier result.', stop, stop]);
  assert.deepStrictEqual(run.requests.map((r) => r.side), [false, false, false, false, true]);
  assert.strictEqual(run.answer, 'OK'); // the wrap-up's answer
  assert.deepStrictEqual(E.evaluateRun(LOOP, run), { pass: true, failures: [] });
});

test('named-styles note: none after a plain text fix, one after an insert (the document\'s styles differ from the sheet)', async () => {
  const c = { id: 'styles-note', mode: 'auto', docsApi: true, doc: ['Report', 'The sorbent was dryed.', 'It was weighed.'],
    prompts: ['Fix the typo in line 2, then add the sentence "It was stored dry." after line 3.'],
    expect: { forbid: ['ask_user', 'document_styles'] },
    dry: [[{ calls: [['replace_text', { old_text: 'dryed', new_text: 'dried' }]] }, { calls: [['insert_after_line', { line: 3, text: 'It was stored dry.', style: null }]] }, { text: 'Done.' }]] };
  const run = await E.runOnce(c, c.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(run.calls.map((x) => [x.name, x.ok]), [['replace_text', true], ['insert_after_line', true]]);
  assert.doesNotMatch(run.results[0], /named styles differ/);
  assert.match(run.results[1], /\nNote: the document's named styles differ from the formatting sheet \(/);
  assert.deepStrictEqual(E.evaluateRun(c, run), { pass: true, failures: [] });
});

// ---- Harness features ----------------------------------------------------------------------------------------------
const SPIN = byId('cite-plain-doi').doc;
test('later messages: the chat carries over, each message has its own cards, trajectory, expectations and requests', async () => {
  const c = byId('cite-after-not-now');
  const run = await dryOne(c, c.dry[0]);
  assert.deepStrictEqual(run.turns.map((x) => [x.prompt, x.outcome, x.requests.length]), [[c.prompts[0], 'done', 2], [c.turns[0].prompts[0], 'done', 2]]);
  assert.strictEqual(E.trajectoryKey(run), 'find_reference! || replace_text');
  assert.deepStrictEqual(run.cards, [{ turn: 0, kind: 'access', decision: 'reject' }]);
  assert.deepStrictEqual(run.calls.map((x) => [x.name, x.turn, x.round]), [['find_reference', 0, 0], ['replace_text', 1, 0]]);
  // the second message's history holds the first one's exchange
  assert.deepStrictEqual(run.messages.filter((m) => m.role === 'user').map((m) => m.content), [c.prompts[0], c.turns[0].prompts[0]]);
  // a later message takes the paraphrase of the run (its index modulo its own count)
  assert.deepStrictEqual(E.caseTurns(c, c.prompts[1], 1).map((t) => t.prompt), [c.prompts[1], c.turns[0].prompts[1]]);
  assert.deepStrictEqual(E.caseTurns(c, c.prompts[0], 2)[1].prompt, c.turns[0].prompts[0]);
  // a message's own expect: the first message's empty expect passes although it has a failed call
  assert.deepStrictEqual(E.evaluateRun(c, run), { pass: true, failures: [] });
  assert.deepStrictEqual(E.evaluateRun({ ...c, expect: { failedMax: 0 } }, run).failures, ['message 1: 1 failed or refused calls (max 0): find_reference']);
});

// A side question (/side): the read-only turn with the edit-block rules, on the side thread, not in the chat; a later
// message of the same chat is a normal turn again.
test('side questions: a "/side" message runs the read-only side turn, read from the side thread; the next message edits', async () => {
  const c = byId('side-whole-selection');
  const run = await dryOne(c, c.dry[0]);
  const user = run.messages[0];
  assert.deepStrictEqual([user.role, user.content, user._mode, !!user._asks], ['user', c.prompts[0].slice('/side '.length), 'manual', false]);
  assert.match(run.answer, /^<replacement>The mean distance grew/);
  assert.ok(E.evaluateRun(c, run).pass, E.evaluateRun(c, run).failures.join('; '));
  const two = { ...c, turns: [{ prompt: 'Remove the word "usually" from the second sentence.', expect: { order: ['replace_text'], finalTextNot: 'usually' } }] };
  const both = await dryOne(two, [[{ calls: [['replace_text', { old_text: 'which usually points', new_text: 'which points', line: null }]] }, { text: 'Proposed.' }],
    [{ calls: [['replace_text', { old_text: 'which usually points', new_text: 'which points', line: null }]] }, { text: 'Done.' }]]);
  // a write in the side question is refused (no writing tools there); the chat's next message is an Auto turn and edits
  assert.deepStrictEqual(both.turns.map((x) => [x.messages[0]._mode, x.calls.map((k) => [k.name, k.ok])]),
    [['manual', [['replace_text', false]]], ['edit', [['replace_text', true]]]]);
  assert.match(both.turns[0].results[0], /cannot be modified here/);
  assert.match(both.turns[0].finalText, /which usually points/);
  assert.deepStrictEqual(E.evaluateRun(two, both).failures, ['message 1: called replace_text (forbidden: write)',
    'message 1: answer does not match /<replacement>[\\s\\S]*mean distance grew[\\s\\S]*washed out[\\s\\S]*</replacement>/']);
});

// Manual since w19: the editing turn of Auto, every write on a card (the eval allows it unless the case denies it).
test('Manual cases: each write asks on a card, allowed by default and denied when the case says so; the message is sent in Manual', async () => {
  const groups = await dryOne(byId('manual-groups-edits'), byId('manual-groups-edits').dry[0]);
  assert.deepStrictEqual([groups.messages[0]._mode, groups.messages[0]._asks, groups.cards], ['edit', true, [{ turn: 0, kind: 'edit', decision: 'accept' }]]);
  const denied = await dryOne(byId('manual-denied-edit'), byId('manual-denied-edit').dry[0]);
  assert.deepStrictEqual(denied.cards, [{ turn: 0, kind: 'edit', decision: 'reject' }]);
  assert.strictEqual(denied.results[0], 'The user did not allow this edit. Do not retry it; ask what they want instead or propose an alternative in the chat.');
  assert.match(denied.finalText, /was recieved as the mean/);
  // the answer guard: a claimed change fails, the same words negated pass
  const claim = (answer) => E.evaluate({ answerNot: byId('manual-denied-edit').expect.answerNot }, { ...denied, answer }).pass;
  assert.deepStrictEqual(['Done.', 'Fixed the typo.', 'Опечатка исправлена.', 'I have not changed the Methods.', 'Хорошо, не исправил: текст как был.', 'The Methods stay unchanged.']
    .map(claim), [false, false, false, true, true, true]);
});

// The catalog follows the product: a Manual message is an editing turn (no expectation of the read-only Manual's edit
// block), and a case's paraphrases are all side questions or none.
test('case file: no Manual message expects an edit block; a case asks side questions in every paraphrase or in none', () => {
  for (const c of ALL) {
    const msgs = [{ mode: c.mode, prompts: c.prompts, expect: c.expect }, ...(c.turns || []).map((t) => ({ mode: t.mode || c.mode, prompts: t.prompts || [t.prompt], expect: t.expect }))];
    for (const m of msgs) {
      const side = m.prompts.filter((p) => /^\/side\s/.test(p)).length;
      assert.ok(side === 0 || side === m.prompts.length, `${c.id}: some paraphrases are side questions, some not`);
      const e = m.expect || {};
      if (m.mode === 'manual' && !side) assert.ok(!/replacement|insertion/.test(JSON.stringify([e.answer || '', e.answerNot || ''])) && e.answerOutsideMax == null, `${c.id}: a Manual message expects an edit block`);
    }
  }
});

test('scripted cards: an allowed access card grants the lookups, a denied edit card refuses the write, ask_user takes the scripted answer', async () => {
  const base = { id: 'cards', doc: SPIN, mode: 'auto', docsApi: true, prompts: ['Look up DOI 10.5555/eval.x, then shorten the Methods, asking me first.'] };
  const allow = await E.runOnce({ ...base, cards: { access: 'allow' }, dry: [[{ calls: [['find_reference', { query: '10.5555/eval.x' }]] }, { text: 'Not found.' }]] },
    base.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(allow.cards, [{ turn: 0, kind: 'access', decision: 'accept' }]);
  assert.ok(!/did not allow reference lookups/.test(allow.results[0]), allow.results[0]);
  // in Manual every write asks (after the read the write guard wants)
  const deny = await E.runOnce({ ...base, mode: 'manual', cards: { edit: 'deny' }, dry: [[{ calls: [['read_document', { scope: { start: 6, end: 8 }, include: ['text'], doc: null }]] },
    { calls: [['replace_section', { heading: 'Methods', new_text: 'The protein was labelled and reconstituted.' }]] }, { text: 'Not changed.' }]] },
    base.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(deny.cards, [{ turn: 0, kind: 'edit', decision: 'reject' }]);
  assert.deepStrictEqual(deny.calls.map((x) => [x.name, x.ok]), [['read_document', true], ['replace_section', false]]);
  assert.match(deny.finalText, /labelled at two cysteines/);
  const ask = await E.runOnce({ ...base, cards: { ask: 'option:1' }, dry: [[{ calls: [['ask_user', { questions: [{ question: 'Which part?', options: ['Methods', 'Results'], multiple: false }] }]] }, { text: 'OK.' }]] },
    base.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(ask.cards, [{ turn: 0, kind: 'ask', decision: 'option:1' }]);
  assert.match(ask.results[0], /Which part\? — Results/);
  // the defaults: edits allowed, lookups not allowed, ask_user's first option (or the case's answer), documents not opened
  assert.deepStrictEqual(['edit', 'access', 'ask', 'open'].map((k) => E.cardDecision(k, { cards: {} })), ['accept', 'reject', 'option:0', 'reject']);
  assert.strictEqual(E.cardDecision('ask', { cards: {}, answer: 'option:2' }), 'option:2');
  assert.strictEqual(E.cardDecision('edit', { cards: { edit: 'allow-all' } }), 'accept-all');
});

test('ask cards answered as a user would: the option that names what is meant, else typed in Other; selection-twice may ask', async () => {
  const html = (opts) => opts.map((o, i) => `<button class="btn small ask-option" type="button" data-ask="${i}" data-preview="p1" aria-pressed="false">${i + 1}. ${o}</button>`).join('');
  const want = byId('selection-twice').cards.ask;
  assert.strictEqual(E.askDecision(want, html(['Строка 3 (оглавление)', 'Строка 5 (заголовок раздела)'])), 'option:1');
  assert.strictEqual(E.askDecision(want, html(['The section heading', 'The contents entry'])), 'option:0');
  // the line number wins over a "heading" in the other answer
  assert.strictEqual(E.askDecision(want, html(['Заголовок в оглавлении, строка 3', 'Line 5'])), 'option:1');
  assert.strictEqual(E.askDecision(want, ''), 'answers:["The heading, line 5."]');
  assert.strictEqual(E.askDecision('Results &amp; more', ''), 'answers:["Results &amp; more"]'); // a plain text is typed in Other
  assert.deepStrictEqual(['option:2', 'answers:["x"]'].map((d) => E.askDecision(d, '')), ['option:2', 'answers:["x"]']);
  // the case: asking which place is meant, then formatting the heading, passes; formatting the contents line fails
  const c = byId('selection-twice');
  const fmtLine = (line) => ['format_text', { old_text: 'Sample preparation', line, all: null, bold: null, italic: true, underline: null, font: null, size: null, color: null, highlight: null, link: null }];
  const ask = { calls: [['ask_user', { questions: [{ question: 'Which «Sample preparation»?', options: ['Line 3 (contents)', 'Line 5 (the heading)'], multiple: false }] }]] };
  const asked = await dryOne(c, [ask, { calls: [fmtLine(5)] }, { text: 'Done.' }]);
  assert.deepStrictEqual(asked.cards, [{ turn: 0, kind: 'ask', decision: 'option:1' }]);
  assert.match(asked.results[0], /Line 5 \(the heading\)/);
  assert.ok(E.evaluateRun(c, asked).pass, E.evaluateRun(c, asked).failures.join('; '));
  const typed = await dryOne(c, [{ calls: [['ask_user', { questions: [{ question: 'Which line did you select?', options: [], multiple: false }] }]] }, { calls: [fmtLine(5)] }, { text: 'Done.' }]);
  assert.match(typed.results[0], /The heading, line 5\./);
  assert.ok(E.evaluateRun(c, typed).pass, E.evaluateRun(c, typed).failures.join('; '));
  const wrong = await dryOne(c, [{ calls: [fmtLine(3)] }, { text: 'Done.' }]);
  assert.ok(!E.evaluateRun(c, wrong).pass);
});

test('side requests (the connectivity check) play no recorded round and are not counted as rounds', async () => {
  const c = { id: 'side', doc: SPIN, mode: 'auto', docsApi: true, prompts: ['Add two paragraphs after line 3.'],
    dry: [[{ calls: [['insert_after_line', { line: 3, text: 'Earlier work followed such changes mostly in detergent micelles rather than in membranes.\nThe membrane itself can shift the balance between the states of a transporter.', style: null, fill: null }]] },
      { text: 'Added two paragraphs.' }]] };
  const run = await E.runOnce(c, c.prompts[0], { provider: 'munin', dry: true });
  assert.deepStrictEqual(run.requests.map((r) => r.side), [false, true, false]);
  assert.strictEqual(run.answer, 'Added two paragraphs.');
  assert.deepStrictEqual(E.runMetrics(run), { calls: 1, failed: 0, rounds: 2, prompt: run.usage.prompt, completion: 40, refusals: 0 });
});

test('metrics: calls, failed calls, rounds, tokens and user-visible refusals per run, summed per case', async () => {
  const c = byId('cite-plain-doi');
  const r = await E.runEval([c], { provider: 'munin', dry: true, repeats: 2, paraphrases: [0] });
  const [good, bad] = r.cases[0].runs;
  assert.deepStrictEqual([good.metrics.calls, good.metrics.failed, good.metrics.rounds, good.metrics.refusals], [1, 0, 2, 0]);
  assert.deepStrictEqual([bad.metrics.calls, bad.metrics.failed, bad.metrics.rounds, bad.metrics.refusals], [1, 1, 2, 1]);
  assert.ok(good.metrics.prompt > 5000 && good.metrics.completion === 40, JSON.stringify(good.metrics));
  const m = r.cases[0].stats.metrics;
  assert.deepStrictEqual([m.calls, m.failed, m.rounds, m.refusals, m.prompt + m.completion], [2, 1, 4, 1, r.tokens]);
});

test('expectations: counts, results, arguments, answer language and length, refusals, lines and lists', () => {
  const run = { outcome: 'done', errors: [], messages: [], finalText: '', requests: [{ side: false }, { side: true }, { side: false }, { side: false }],
    answer: 'Не могу это сделать.\n<replacement>Long English text here.</replacement>', results: ['Refused by a check: the new text drops 1.', 'Done.'],
    cards: [{ kind: 'access', decision: 'reject' }],
    calls: [{ name: 'remember', args: { text: 'Пиши кратко' }, ok: true, round: 0 }, { name: 'replace_text', args: { old_text: 'a' }, ok: false, round: 1 }, { name: 'replace_text', args: { old_text: 'a' }, ok: true, round: 2 }],
    rounds: [['remember'], ['replace_text'], ['replace_text']],
    lines: [{ text: 'Title', style: 'HEADING_1', indent: [0, 0], spaceAbove: 20, size: 20, bold: false, italic: false, listLevel: null, listId: null, numbered: false },
      { text: 'Methods', style: 'HEADING_2', indent: [72, 54], spaceAbove: 18, size: 14, bold: true, italic: false, listLevel: 1, listId: 'k1', numbered: true },
      { text: 'Results', style: 'HEADING_2', indent: [28.5, 21.26], spaceAbove: 18, size: 12, bold: false, italic: false, listLevel: 0, listId: 'k2', numbered: true }] };
  assert.deepStrictEqual(E.evaluate({ min: { write: 2 }, failedMax: 0, roundsMax: 2, cardsMax: { access: 0 }, args: { remember: 'English' }, argsNot: { remember: '[А-Яа-я]' },
    results: 'Done', resultsNot: 'Refused by a check', answerLang: 'en', answerOutsideMax: 10, noRefusal: true }, run).failures, [
    'write succeeded 1 times (min 2)', '1 failed or refused calls (max 0): replace_text', '3 responses (max 2)', '1 access cards (max 0)',
    'no remember call with arguments matching /English/', 'remember arguments match /[А-Яа-я]/', 'results match /Refused by a check/',
    'answer language ru, expected en', 'answer outside edit blocks has 20 characters (max 10)', 'answer refuses ("Не могу")']);
  assert.deepStrictEqual(E.evaluate({ lines: [{ match: '^Methods$', indent: [28.5, 21.26], size: 12, bold: false, listLevel: 0, numbered: true, style: 'h2' },
    { match: 'Results', nth: 2, bold: true }, { line: 3, text: 'Result', textNot: 'Res', spaceAbove: 18.4, italic: false }], sameList: ['Methods', 'Results'] }, run).failures, [
    'line /^Methods$/: indent 72/54 pt, expected 28.5/21.26', 'line /^Methods$/: size 14, expected 12', 'line /^Methods$/: bold true, expected false',
    'line /^Methods$/: list level 1, expected 0', 'line /Results/ #2: not in the document', 'line 3: text matches /Res/',
    'lines /Methods/, /Results/ are not items of one list']);
  // indentLike compares the effective indent (the one Docs draws: own, else the named style's): inheriting (B) and the
  // same own values (D) pass, the list level's (C) does not; ownIndent the line's own values (null: none)
  const inherit = { text: 'A', indent: [28.5, 21.26], ownIndent: null };
  const indents = { ...run, lines: [inherit, { ...inherit, text: 'B' }, { ...inherit, text: 'C', indent: [72, 54], ownIndent: [72, 54] }, { ...inherit, text: 'D', ownIndent: [28.5, 21.26] }] };
  assert.deepStrictEqual(E.evaluate({ lines: [{ match: '^B$', indentLike: '^A$', ownIndent: null }, { match: '^C$', indentLike: '^A$' }, { match: '^D$', indentLike: '^A$', ownIndent: [28.5, 21.26] },
    { match: '^A$', ownIndent: [1, 2], indentLike: '^Z$' }] }, indents).failures, [
    'line /^C$/: indent 72/54 pt, line /^A$/ has 28.5/21.26',
    'line /^A$/: no line /^Z$/ to compare the indent with', 'line /^A$/: own indent none, expected 1/2 pt']);
  assert.deepStrictEqual(E.evaluate({ lines: [{ line: 1 }] }, { ...run, lines: null }).failures, ['lines expected, but the case has no Docs API document']);
  assert.deepStrictEqual(['Готово, абзац улучшен.', 'Done: the paragraph is shorter.', '<insertion>Только блок</insertion>', ''].map(E.answerLang), ['ru', 'en', '', '']);
  assert.ok(E.REFUSAL_RE.test('I cannot insert it as plain text.') && E.REFUSAL_RE.test('Не могу вставить ссылку.') && !E.REFUSAL_RE.test('Done: I inserted the citation.'));
});

test('case file: later messages need a prompt, formatted lines need the Docs API, sets name known cases', () => {
  const file = path.join(os.tmpdir(), `tool-eval-cases-${process.pid}.json`);
  const write = (data) => fs.writeFileSync(file, JSON.stringify(data));
  try {
    write({ cases: [{ ...TERM, turns: [{ expect: {} }] }] });
    assert.throws(() => E.loadCases(file), /case term: message 2 has no prompt/);
    write({ cases: [{ ...TERM, docsApi: false, doc: [{ p: 'Heading', style: 'HEADING_2' }] }] });
    assert.throws(() => E.loadCases(file), /formatted lines need docsApi/);
    write({ cases: [{ ...TERM, turns: [{ prompt: 'More.', selection: 'not in the document' }] }] });
    assert.throws(() => E.loadCases(file), /the selection is not in the document/);
    write({ sets: { mine: ['term', 'nope'] }, cases: [TERM] });
    assert.throws(() => E.loadSets(file), /set mine: unknown case nope/);
  } finally { fs.unlinkSync(file); }
  // the tracked file's sets and its formatted documents load
  assert.ok(E.loadSets().controls.every((id) => byId(id)));
  assert.deepStrictEqual(E.caseLines(byId('number-sections'))[1], { p: 'Software', style: 'HEADING_2', fmt: [[0, 8, { size: 12 }]] });
});

// ---- A Custom (OpenAI-compatible) account ---------------------------------------------------------------------------
// The eval runs a case on a Custom account the way the panel runs one: the server URL, the extra headers and the
// Advanced reply length of the account's settings row, its model list loaded first (Check provider) so the short id is
// chosen and the request body gets the full one. Here the live path talks to a fake server.
const CUSTOM_BASE = 'https://llm.example/v1';
const CUSTOM_MODEL = 'gpt://F123456/qwen3.6-35b-a3b/latest';
const CUSTOM_SERVER = { baseUrl: CUSTOM_BASE, headers: { 'OpenAI-Project': 'F123456' }, params: { maxTokens: 16384 } };
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
// A Chat Completions stream of one round ({ text } or { calls }) with its usage.
function chatStream(round, id, usage) {
  const end = cc({ choices: [], usage: { prompt_tokens: usage[0], completion_tokens: usage[1], total_tokens: usage[0] + usage[1] } }) + 'data: [DONE]\n\n';
  if (!round.calls) return cc({ choices: [{ index: 0, delta: { content: round.text } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + end;
  return round.calls.map(([name, args], i) => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `${id}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })).join('') +
    cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + end;
}
// A fake OpenAI-compatible server: GET /models lists two ids under one folder; a chat request with tools gets the
// script's next round (1,000 prompt and 50 completion tokens), one without tools (a side request) "OK" (111 and 7).
function customServer(script) {
  const seen = { models: [], chats: [] };
  let at = 0;
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (!init.body) {
      seen.models.push({ url, headers });
      return new Response(JSON.stringify({ data: [{ id: CUSTOM_MODEL }, { id: 'gpt://F123456/other/latest' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = JSON.parse(init.body);
    const side = !Array.isArray(body.tools) || !body.tools.length;
    seen.chats.push({ url, headers, body, side });
    const text = side ? chatStream({ text: 'OK' }, 's', [111, 7]) : chatStream(script[Math.min(at++, script.length - 1)], `c${at}`, [1000, 50]);
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { seen, fetchImpl };
}

test('custom provider: the account\'s server URL, extra headers, full model id and reply length; side requests\' tokens counted', async () => {
  const c = { id: 'side', doc: SPIN, mode: 'auto', docsApi: true, prompts: ['Add two paragraphs after line 3.'] };
  const script = [{ calls: [['insert_after_line', { line: 3, text: 'Earlier work followed such changes mostly in detergent micelles rather than in membranes.\nThe membrane itself can shift the balance between the states of a transporter.', style: null, fill: null }]] },
    { text: 'Added two paragraphs.' }];
  const srv = customServer(script);
  const run = await E.runOnce(c, c.prompts[0], { provider: 'custom', model: CUSTOM_MODEL, apiKey: 'key-T', server: CUSTOM_SERVER, dry: false, fetchImpl: srv.fetchImpl });
  assert.strictEqual(run.outcome, 'done', run.errors.join('; '));
  assert.strictEqual(run.answer, 'Added two paragraphs.');
  // the model list once, as Check provider loads it, with the account's headers; not a request of the run
  assert.deepStrictEqual(srv.seen.models.map((m) => [m.url, m.headers['OpenAI-Project'], m.headers.Authorization]), [[`${CUSTOM_BASE}/models`, 'F123456', 'Bearer key-T']]);
  assert.deepStrictEqual(srv.seen.chats.map((x) => x.side), [false, true, false]);
  assert.deepStrictEqual(run.requests.map((r) => r.side), [false, true, false]);
  for (const x of srv.seen.chats) {
    assert.strictEqual(x.url, `${CUSTOM_BASE}/chat/completions`);
    assert.deepStrictEqual([x.headers['OpenAI-Project'], x.headers.Authorization], ['F123456', 'Bearer key-T']);
    // the full id (the account keeps the short one), no Munin fields
    assert.strictEqual(x.body.model, CUSTOM_MODEL);
    assert.ok(!('persona' in x.body) && !('chat_template_kwargs' in x.body), Object.keys(x.body).join(','));
  }
  assert.strictEqual(srv.seen.chats[0].body.max_tokens, 16384);
  // the chat's two responses in usage and metrics, the side request's tokens in the run's total only
  assert.deepStrictEqual([run.usage, run.sideUsage], [{ prompt: 2000, completion: 100 }, { prompt: 111, completion: 7 }]);
  assert.deepStrictEqual(E.runMetrics(run), { calls: 1, failed: 0, rounds: 2, prompt: 2000, completion: 100, refusals: 0 });
  assert.strictEqual(E.runTokens(run), 2218);
});

test('custom provider dry: Chat Completions rounds, the model list from the run\'s model; the eval\'s tokens include side requests', async () => {
  assert.deepStrictEqual(E.dryModelList(CUSTOM_MODEL).data.map((m) => m.id), [CUSTOM_MODEL, 'gpt://F123456/dry-other/latest']);
  assert.deepStrictEqual(E.dryModelList('qwen3:8b').data.map((m) => m.id), ['qwen3:8b', 'dry-other/latest']);
  const r = await E.runEval([TERM], { provider: 'custom', model: CUSTOM_MODEL, server: CUSTOM_SERVER, dry: true, repeats: 2 });
  assert.deepStrictEqual(r.cases[0].runs.map((x) => [x.pass, x.trajectory]), [[true, 'find_in_document | replace_all'], [false, 'replace_all']]);
  // dry, a side request plays no round and costs nothing; live its stream's usage counts
  assert.strictEqual(E.runTokens({ usage: { prompt: 10, completion: 2 } }), 12);
  assert.strictEqual(E.runTokens({ usage: { prompt: 10, completion: 2 }, sideUsage: { prompt: 5, completion: 1 } }), 18);
  assert.deepStrictEqual(E.streamUsage(chatStream({ text: 'OK' }, 's', [111, 7])), { prompt: 111, completion: 7 });
  // a Responses or Messages stream: input and output tokens, the largest counts
  assert.deepStrictEqual(E.streamUsage('event: message_start\ndata: {"usage":{"input_tokens":40,"output_tokens":1}}\n\ndata: {"usage":{"output_tokens":9}}\n\n'), { prompt: 40, completion: 9 });
});
