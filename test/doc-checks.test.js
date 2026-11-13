'use strict';
// The document-wide passes of /check (src/doc-checks.js): variant consistency (UK/US spelling, -ise/-ize, hyphenation,
// numerals 1–9, p/P, % / percent, ± / +/-) with the majority form and the fix edits, accepted terms, the Apply batch
// (checkFixOps), leftovers (placeholders, marks, highlights, double spaces and punctuation), the abstract (limit,
// citations, abbreviations), the limitations sentence, the density block, the DOC.md "Checks:" line (checkIgnores,
// textCheckIgnored), and the journal limits (parsing, the stored record and its refresh, the comparison).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, deq } = require('./lib/sandbox');

let T; let chrome; let state; let run;
before(async () => { ({ T, chrome, state, run } = await load({ settle: 0 })); });

const doc = (lines, format = 'text') => T.ckDocument({ text: lines.join('\n'), format });
const byRule = (list, rule) => list.find((f) => f.rule === rule);
const rules = (list) => list.map((f) => `${f.rule}@${f.line}`);

test('UK/US spelling: the majority side wins; the minority occurrence is rewritten with its case; -ise/-ize is a group of its own', () => {
  const d = doc(['A study', 'Introduction', 'The colour of the centre was analysed and we organise and realise data.',
    'The colour changed; the behaviour was modelled and we characterize it.', 'Color differs here.']);
  const g = T.dcVariants(d);
  const sp = byRule(g, 'variant-spelling');
  assert.strictEqual(sp.text, 'UK and US spelling: UK 6 times, US 1 time; unify to UK (line 5).');
  deq(sp.fix.edits, [{ line: 5, at: 0, len: 5, to: 'Colour' }]);
  assert.strictEqual(sp.fix.label, 'the spelling to UK');
  assert.strictEqual(sp.severity, 'note');
  deq(sp.detail, ['line 5: Color → Colour']);
  const ize = byRule(g, 'variant-ize');
  assert.strictEqual(ize.text, '-ise and -ize: -ise 2 times, -ize 1 time; unify to -ise (line 4).');
  deq(ize.fix.edits, [{ line: 4, at: 54, len: 12, to: 'characterise' }]);
  // words that end in -ise in both spellings are no variant
  assert.strictEqual(byRule(T.dcVariants(doc(['T', 'Intro', 'We advise, revise, exercise, promise and surprise; we organize it.'])), 'variant-ize'), undefined);
});

test('hyphenation, numerals, p-values, percent and plus-minus: one group each with the majority form', () => {
  const d = doc(['T', 'Methods',
    'The time-resolved data and time-resolved spectra and time resolved fits.',
    'We used three samples and two columns. Then 4 runs were made, see Figure 3 with 5 mm and 2% and [3] and n = 4.',
    'Values were p < 0.05 and p < 0.01 but P < 0.001; 5% and 7 % and 10 percent; 3 ± 1 and 4 +/- 2 and 5 ± 1.']);
  const g = T.dcVariants(d);
  deq(rules(g), ['variant-hyphen@3', 'variant-numeral@4', 'variant-p@5', 'variant-percent@5', 'variant-plusminus@5']);
  assert.strictEqual(byRule(g, 'variant-hyphen').text, '«time-resolved» 2 times, «time resolved» 1 time; unify to «time-resolved» (line 3).');
  deq(byRule(g, 'variant-hyphen').fix.edits, [{ line: 3, at: 53, len: 13, to: 'time-resolved' }]);
  // Figure 3, 5 mm, 2%, [3], n = 4 and the numbers around ± are not running-text numbers
  assert.strictEqual(byRule(g, 'variant-numeral').text, 'Numbers 1–9 in running text: words 2 times, numerals 1 time; unify to words (line 4).');
  deq(byRule(g, 'variant-numeral').fix.edits, [{ line: 4, at: 44, len: 1, to: 'four' }]);
  deq(byRule(g, 'variant-p').fix.edits.map((e) => e.to), ['p']);
  deq(byRule(g, 'variant-percent').fix.edits.map((e) => e.to), ['%']);
  deq(byRule(g, 'variant-plusminus').fix.edits.map((e) => [e.len, e.to]), [[3, '±']]);
  // a tie goes to the form used first; a sentence-initial "Three" is required, not counted
  const t = T.dcVariants(doc(['T', 'Intro', 'Three samples were used. We had 2 sets and five runs.']));
  assert.strictEqual(byRule(t, 'variant-numeral').text, 'Numbers 1–9 in running text: numerals 1 time, words 1 time; unify to numerals (line 3).');
  // Russian lines do not count numerals
  assert.strictEqual(byRule(T.dcVariants(doc(['T', 'Введение', 'Мы взяли 3 образца, two of them.'])), 'variant-numeral'), undefined);
});

test('variants skip code spans, URLs, DOIs and citations; accepted terms are never rewritten but still vote', () => {
  const g = T.dcVariants(doc(['T', 'Intro', 'The colour and the colour, see `color` and https://x.org/color and (Color, 2020).']));
  assert.strictEqual(byRule(g, 'variant-spelling'), undefined);
  const lines = ['T', 'Intro', 'The colour, the colour and the colour.', 'The color is fine.'];
  assert.ok(byRule(T.dcVariants(doc(lines)), 'variant-spelling'));
  assert.strictEqual(byRule(T.dcVariants(doc(lines), { terms: new Set(['color']) }), 'variant-spelling'), undefined);
  // an accepted majority form still wins: the other form is rewritten
  const acc = byRule(T.dcVariants(doc(lines), { terms: new Set(['colour']) }), 'variant-spelling');
  deq(acc.fix.edits.map((e) => e.to), ['colour']);
});

test('the Apply batch: one replace per line with the whole line, all fixes of that line applied, a changed line refused', () => {
  const lines = ['T', 'Intro', 'The color and the color.', 'The colour, the colour, the colour, the colour.', 'A color.'];
  const d = doc(lines);
  const f = byRule(T.dcVariants(d), 'variant-spelling');
  deq(f.fix.edits.map((e) => e.line), [3, 3, 5]);
  const model = { lines: lines.map((text, i) => ({ line: i + 1, text })) };
  const lineText = new Map(d.lines.map((l) => [l.line, l.text]));
  const r = T.checkFixOps(model, f.fix, lineText);
  deq(r.ops, [
    { op: 'replace', old_text: 'The color and the color.', new_text: 'The colour and the colour.', line: 3 },
    { op: 'replace', old_text: 'A color.', new_text: 'A colour.', line: 5 },
  ]);
  assert.strictEqual(r.count, 3);
  deq(r.lines, [3, 5]);
  const changed = { lines: model.lines.map((l) => (l.line === 5 ? { ...l, text: 'A colored thing.' } : l)) };
  assert.strictEqual(T.checkFixOps(changed, f.fix, lineText).error, 'Line 5 changed since the check. Run /check again.');
  // a soft break in the Docs line is a space in the report's text: offsets stay valid, the break stays
  const soft = { lines: model.lines.map((l) => (l.line === 3 ? { ...l, text: 'The color\u000band the color.' } : l)) };
  const lt = new Map(lineText); lt.set(3, 'The color and the color.');
  assert.strictEqual(T.checkFixOps(soft, f.fix, lt).ops[0].new_text, 'The colour\u000band the colour.');
});

test('leftovers: placeholders, TODO marks, ?? and XX (not the XX century), double spaces and punctuation; highlighted text of the model', () => {
  const d = doc(['Title', 'Intro', 'TODO fix [ref] and [citation needed] and [insert figure] ?? XX mg in the XX century.', 'Double  space here,, and.. there.',
    'See https://a.org/??x and e.g., i.e., etc. and [[TODO later]].']);
  const g = T.dcLeftovers(d);
  deq(g.map((f) => `${f.rule}:${f.severity}@${f.line}`), ['leftover-citation:error@3', 'leftover-citation:error@3', 'leftover-todo:error@3',
    'leftover-insert:error@3', 'leftover-marks:warning@3', 'leftover-marks:warning@3', 'double-space:note@4', 'double-punct:note@4']);
  assert.strictEqual(g[0].text, 'Citation placeholder [ref].');
  assert.strictEqual(g[5].text, 'Placeholder mark XX.');
  // accepted terms are silent
  assert.ok(!T.dcLeftovers(d, { terms: new Set(['xx']) }).some((f) => f.text === 'Placeholder mark XX.'));
  // the Docs API model's highlight runs (white is no highlight)
  const model = { lines: [{ line: 1, text: 'Title', runs: [] }, { line: 2, text: 'Yield was N mg here.', runs: [{ s: 10, e: 11, bg: '#ffff00' }, { s: 11, e: 14, bg: '#ffff00' }, { s: 15, e: 19, bg: '#ffffff' }] }] };
  const h = T.dcLeftovers(T.ckDocument({ model }), { model }).filter((f) => f.rule === 'leftover-highlight');
  deq(h.map((f) => [f.line, f.at, f.len, f.text]), [[2, 10, 4, 'Highlighted text «N mg».']]);
});

test('leftovers: more than 10 double spaces end in one "and N more" note', () => {
  const lines = ['T', 'Intro', ...Array.from({ length: 13 }, (_, i) => `Line  ${i} text.`)];
  const g = T.dcLeftovers(doc(lines)).filter((f) => f.rule === 'double-space');
  assert.strictEqual(g.length, 11);
  assert.strictEqual(g[10].text, 'Double spaces on 3 more lines: 13, 14, 15.');
});

test('the abstract: over 250 words, citations, abbreviations not defined in it; the journal limit replaces the default; an inline "Abstract:" paragraph', () => {
  const words = Array.from({ length: 260 }, (_, i) => 'word' + (i % 7)).join(' ');
  const d = doc(['Title', 'Abstract', `We measured XRD and soil organic carbon (SOC) in soils [3]. SOC rose. ${words}.`, 'Introduction', 'Text.']);
  const g = T.dcSections(d);
  deq(rules(g), ['abstract-length@2', 'abstract-citation@3', 'abstract-abbreviation@3']);
  assert.strictEqual(g[0].text, 'Abstract: 273 words, 23 over 250 (a common limit).');
  assert.strictEqual(g[2].text, 'The abstract uses XRD without defining it there.');
  const lim = T.dcSections(d, { limits: { title: 'guide.pdf', limits: { abstract_words: 270 } } });
  assert.strictEqual(lim[0].text, 'Abstract: 273 words, 3 over 270 (the limit of guide.pdf).');
  assert.strictEqual(T.dcSections(d, { limits: { title: 'g', limits: { abstract_words: 300 } } }).filter((f) => f.rule === 'abstract-length').length, 0);
  // a budget line for the abstract: the budgets group reports it, not this one
  assert.strictEqual(T.dcSections(d, { budget: T.ckBudgetLine('budget: abstract 200') }).filter((f) => f.rule === 'abstract-length').length, 0);
  const inline = doc(['Title', 'Ann Lee, Bob Ray', 'Abstract: We used NMR here.', 'Introduction', 'Text.']);
  deq(rules(T.dcSections(inline)), ['abstract-abbreviation@3']);
});

test('limitations: a Discussion or Conclusions section without a limitations sentence is flagged; Russian; a Limitations heading counts', () => {
  deq(rules(T.dcSections(doc(['T', 'Introduction', 'Text.', 'Discussion', 'It works.', 'Conclusions', 'It works well.']))), ['limitations-missing@4']);
  assert.strictEqual(T.dcSections(doc(['T', 'Discussion', 'It works.', 'Conclusions', 'It works.']))[0].text,
    "Discussion and Conclusions: no sentence on the study's limitations (limitation, caveat, shortcoming).");
  deq(rules(T.dcSections(doc(['T', 'Discussion', 'One limitation is the sample size.']))), []);
  deq(rules(T.dcSections(doc(['T', 'Обсуждение', 'Ограничения работы связаны с выборкой.']))), []);
  deq(rules(T.dcSections(doc(['T', 'Заключение', 'Всё хорошо.']))), ['limitations-missing@2']);
  deq(rules(T.dcSections(doc(['T', 'Discussion', 'It works.', 'Limitations', 'Small n.']))), []);
  deq(rules(T.dcSections(doc(['T', 'Methods', 'No discussion section here.']))), []);
  // a heading counts only as a whole: a topical heading that mentions the word is not a limitations section
  deq(rules(T.dcSections(doc(['T', 'Existing approaches and their limitations', 'Older probes were bulky.', 'Discussion', 'It works.']))), ['limitations-missing@4']);
  deq(rules(T.dcSections(doc(['T', 'Обзор методов и их ограничений', 'Старые зонды громоздки.', 'Обсуждение', 'Всё хорошо.']))), ['limitations-missing@4']);
  for (const h of ['4.3 Limitations of this study', 'Strengths and limitations', 'Ограничения исследования']) {
    deq(rules(T.dcSections(doc(['T', 'Discussion', 'It works.', h, 'Small n.']))), [], h);
  }
});

test('density per section: long-sentence share, glue words, nominalizations, passive; the worst section quotes its longest sentences', () => {
  const d = doc(['Title', 'Introduction',
    'This is a sentence that is of the kind that is very long and that has a lot of words in it so that it is over the limit of thirty words for sure and then some more.',
    'The determination of the concentration was performed. It was measured by the instrument. Short one here.',
    'Methods', 'Short.']);
  const r = T.dcDensity(d);
  assert.strictEqual(r.rows.length, 1); // Methods has fewer than 40 words
  const row = r.rows[0];
  assert.strictEqual(row.words, 54);
  assert.strictEqual(row.longShare, 0.25);
  assert.ok(row.glue > 0.45);
  assert.strictEqual(row.nominal.toFixed(1), '7.4'); // determination, concentration, sentence, instrument of 54
  assert.strictEqual(row.passive, 0.5);
  deq(row.high, ['glue']);
  deq(r.worst.sentences.map((s) => [s.words, s.line]), [[38, 3], [7, 4], [6, 4]]);
  const lines = T.dcDensityLines(r);
  assert.strictEqual(lines[0].text, 'Introduction: 54 words · over 30 words 25% · glue 72% (high) · nominalizations 7.4/100 · passive 50%');
  assert.strictEqual(lines[1].text, 'Longest sentences in Introduction:');
  assert.match(lines[2].text, /^«This is a sentence .*…» \(38 words\)$/);
  // Russian: 35 words per long sentence
  const ru = T.dcDensity(doc(['T', 'Введение', Array.from({ length: 45 }, () => 'слово').join(' ') + '.']));
  assert.strictEqual(ru.rows[0].longLimit, 35);
});

test('the DOC.md Checks line: ignore rule ids (a prefix too), accept terms; several lines add up; textCheckIgnored for the per-write notes', () => {
  const ig = T.checkIgnores('Style: formal\nChecks: ignore variant-numeral, leftover; accept time-resolved, «Colour»\n- checks: ignore double-space; accept in vivo');
  deq([...ig.rules], ['variant-numeral', 'leftover', 'double-space']);
  deq([...ig.terms], ['time-resolved', 'colour', 'in vivo']);
  assert.ok(T.checkRuleIgnored(ig.rules, 'leftover-todo'));
  assert.ok(T.checkRuleIgnored(ig.rules, 'variant-numeral'));
  assert.ok(!T.checkRuleIgnored(ig.rules, 'variant-p'));
  assert.ok(!T.checkRuleIgnored(ig.rules, 'leftovers'));
  deq([...T.checkIgnores('').rules], []);
  const md = 'Checks: ignore wordy-phrase; accept in order to';
  assert.ok(T.textCheckIgnored('wordy-phrase', 'anything', md));
  assert.ok(T.textCheckIgnored('wordy-other', 'In order to', md));
  assert.ok(T.textCheckIgnored('wordy-other', 'we did it in order to see', md));
  assert.ok(!T.textCheckIgnored('wordy-other', 'in order', md));
  state.docInstructions = 'Checks: ignore hedge';
  assert.ok(T.textCheckIgnored('hedge-may', 'may'));
  state.docInstructions = '';
  assert.ok(!T.textCheckIgnored('hedge-may', 'may'));
});

test('journal limits: the model answer parsed tolerantly (fences, strings with units, synonyms, nulls); nothing stated is null', () => {
  deq(T.parseJournalLimits('```json\n{"abstract_words": "250 words", "figures": 6, "tables": null, "references": "1,000", "keywords": 0}\n```'),
    { abstract_words: 250, figures: 6, references: 1000 });
  deq(T.parseJournalLimits('Here: {"limits": {"abstract": 200, "title": 120}}'), { abstract_words: 200, title_characters: 120 });
  assert.strictEqual(T.parseJournalLimits('{"abstract_words": null}'), null);
  assert.strictEqual(T.parseJournalLimits('no idea'), null);
});

test('journal limits: the guidelines file by name or first lines; one extraction, stored with the file signature, read again when the file changes; a failure is not stored', async () => {
  const docId = 'DOCLIM';
  const set = (o) => chrome.storage.local.set(o);
  await set({ [T.attachKey(docId, 'doc2')]: { name: 'notes.md', format: 'text', text: 'My notes\n1. nothing' } });
  await set({ [T.attachKey(docId, 'doc3')]: { name: 'journal.pdf', format: 'pdf', text: '[page 1]\nInstructions for Authors\nThe abstract must not exceed 200 words.\nUp to 6 figures.' } });
  const files = [{ alias: 'doc2', title: 'notes.md', size: 10, addedAt: 1 }, { alias: 'doc3', title: 'journal.pdf', size: 99, addedAt: 2, pages: 1 }];
  assert.strictEqual(await T.journalLimitsFor({ docId, files: [files[0]], extract: async () => '{}' }), null);
  const asked = [];
  const extract = async (material) => { asked.push(material); return '{"abstract_words": 200, "figures": 6}'; };
  const rec = await T.journalLimitsFor({ docId, files, extract });
  deq(rec, { alias: 'doc3', title: 'journal.pdf', limits: { abstract_words: 200, figures: 6 } });
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0], /must not exceed 200 words/);
  assert.ok(!/My notes/.test(asked[0]));
  // stored: the next /check asks nothing
  deq(await T.journalLimitsFor({ docId, files, extract }), rec);
  assert.strictEqual(asked.length, 1);
  const stored = (await chrome.storage.local.get(T.journalLimitsKey(docId)))[T.journalLimitsKey(docId)];
  deq(stored.limits, rec.limits);
  // the file was replaced (another addedAt): read again
  const files2 = [files[0], { ...files[1], addedAt: 3 }];
  await T.journalLimitsFor({ docId, files: files2, extract });
  assert.strictEqual(asked.length, 2);
  // a failed extraction: limits null, nothing stored, so the next /check asks again
  const files3 = [files[0], { ...files[1], addedAt: 4 }];
  deq(await T.journalLimitsFor({ docId, files: files3, extract: async () => 'sorry' }), { alias: 'doc3', title: 'journal.pdf', limits: null });
  assert.strictEqual((await chrome.storage.local.get(T.journalLimitsKey(docId)))[T.journalLimitsKey(docId)].sig.includes('|3|'), true);
  // no provider that can be asked and no stored record: limits null without a request
  deq(await T.journalLimitsFor({ docId, files: files3, snap: null }), { alias: 'doc3', title: 'journal.pdf', limits: null });
});

test('journal limits: the comparison per limit (over, within, not found) and the failure line', () => {
  const words = Array.from({ length: 30 }, () => 'word').join(' ');
  const d = doc(['A short title', 'Abstract', `${words}.`, 'Keywords: soil; carbon; lipase', 'Results', 'Figure 1. A.', 'Figure 2. B.', 'Table 1. C.',
    'References', 'Smith J. (2020). A title. Journal 1, 2.', 'Lee K. (2019). B title. Journal 3, 4.']);
  const entries = T.ckEntries(d);
  const rec = { alias: 'doc3', title: 'guide.pdf', limits: { title_characters: 10, abstract_words: 25, keywords: 6, figures: 2, tables: 0, references: 50, highlights_words: 85 } };
  const g = T.dcLimits(d, rec, { entries });
  deq(g.map((f) => `${f.severity}: ${f.text}`), [
    'warning: Title: 13 characters, 3 over the limit of 10.',
    'warning: Abstract: 30 words, 5 over the limit of 25.',
    'note: Keywords: 3 of at most 6 keywords.',
    'note: Highlights: at most 85 words; not found in the document.',
    'note: Figures: 2 of at most 2 figures.',
    'note: References: 2 of at most 50 references.',
    'note: Limits from guide.pdf (doc3).',
  ]);
  deq(T.dcLimits(d, { alias: 'doc3', title: 'guide.pdf', limits: null }).map((f) => f.text), ['Journal limits: not extracted from guide.pdf; attach the author guidelines as text.']);
  assert.strictEqual(T.dcLimits(d, null), null);
});

test('wordy phrases: no group without concisionHits; with it, hits as rows and Apply only for the mechanical ones', () => {
  const d = doc(['T', 'Intro', 'In order to see it, we did it due to the fact that it rained.']);
  // the real concisionHits (src/concision.js) is loaded: the group exists; without the function there is no group
  run('globalThis.__realConcision = globalThis.concisionHits; globalThis.concisionHits = undefined;');
  assert.strictEqual(T.dcWordy(d), null);
  // a stand-in with the field names the group accepts besides concision.js's own
  run(`globalThis.concisionHits = (t) => {
    const out = [];
    const a = t.indexOf('In order to'); if (a >= 0) out.push({ phrase: 'In order to', suggestion: 'to', at: a, mechanical: true, id: 'in-order-to' });
    const b = t.indexOf('due to the fact that'); if (b >= 0) out.push({ phrase: 'due to the fact that', suggestion: 'because', mechanical: false });
    return out;
  };`);
  const g = T.dcWordy(d);
  deq(g.map((f) => [f.rule, f.line, f.at, f.text]), [['wordy-in-order-to', 3, 0, '«In order to» → «to».'], ['wordy-phrase', 3, 30, '«due to the fact that» → «because».']]);
  deq(g[0].fix.edits, [{ line: 3, at: 0, len: 11, to: 'To' }]);
  assert.strictEqual(g[1].fix, undefined);
  deq(T.dcWordy(d, { terms: new Set(['in order to']) }).map((f) => f.rule), ['wordy-phrase']);
  run('globalThis.concisionHits = globalThis.__realConcision; delete globalThis.__realConcision;');
  // concision.js's own shape: `to` ('' drops the phrase, a leading = is an instruction)
  const real = T.dcWordy(doc(['T', 'Intro', 'In order to see it, a total of nine runs.']));
  assert.ok(real.some((f) => f.text === '«In order to» → «to».' && f.fix), JSON.stringify(real));
});
