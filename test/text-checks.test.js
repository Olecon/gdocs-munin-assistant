'use strict';
// The deterministic text checks of src/text-checks.js and the wordy table of src/concision.js, as pure functions:
// metrics against the document, the churn of a fix request, abbreviations, number-unit spacing, figure/table/equation
// numbers, meaning drift, claim strength, statistics and wordy phrases (mechanical vs judgment), English and Russian;
// the hook itself (notes only, never a refusal; the author's own findings and prose-lint's tells not repeated; the cap).
// The hook on the write path (the notes on a real tool result) is in test/prose-lint.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let T, env;
before(async () => { env = await load(); ({ T } = env); });

const DOC = 'We went to the lab on Monday. The cells grew well there. We counted the cells twice. They looked healthy and fine. '
  + 'We wrote notes in a book. The team met after lunch. We measured them all again. It went fine for us. The pumps ran all day. We cleaned up late.';
const WORDY = 'The optimization of the implementation of the measurement procedure was performed by the investigators in accordance with the '
  + 'established requirements of the institution and the documentation. The determination of the concentration was carried out after the '
  + 'preparation of the solutions was completed by the technicians in the department of chemistry.';

test('textMetrics: sentence lengths, passive share and nominalizations; short texts give null', () => {
  const d = T.textMetrics(DOC, 5);
  deq([d.lang, d.sentences, d.mean, d.passive], ['en', 10, 5, 0]);
  const n = T.textMetrics(WORDY);
  deq([n.sentences, n.mean, n.min, n.max, n.passive], [2, 25, 24, 26, 1]);
  assert.ok(n.nominal > 15, String(n.nominal));
  assert.strictEqual(T.textMetrics('One sentence only here.'), null);
  assert.strictEqual(T.textMetrics(DOC.slice(0, 60), 5), null);
  // Russian: short passive participles (not "мембраны"), -ние/-ция/-ость nouns
  const ru = T.textMetrics('Образцы были измерены дважды. Результаты получены быстро. Мембраны остались целыми. Мы считали клетки вечером.');
  deq([ru.lang, ru.sentences, Math.round(ru.passive * 4)], ['ru', 4, 2]);
  assert.ok(T.textMetrics('Определение концентрации и оптимизация реализации процедуры заняли время. Стабильность и активность измерения важны.').nominal > 30);
});

test('metricsNote: only a clear difference, in the owner\'s format; the old text\'s own style is not flagged', () => {
  const doc = T.textMetrics(DOC, 5);
  const neu = T.textMetrics(WORDY);
  assert.strictEqual(T.metricsNote(neu, doc, null),
    'your text averages 25 words per sentence (24–26; document: 5), is 100% passive (document: 0%) and has 24 -tion/-ment nouns per 100 words (document: 0).');
  // like the document: nothing
  assert.strictEqual(T.metricsNote(T.textMetrics(DOC + ' ' + DOC), doc, null), '');
  // under 40 words: nothing
  assert.strictEqual(T.metricsNote(T.textMetrics('The sample was measured by us. The data were recorded by them.'), doc, null), '');
  // the old text was as long and passive already: the author's style
  assert.strictEqual(T.metricsNote(neu, doc, neu), '');
  // only the passive share differs: "is … passive"
  const base = { mean: 24, passive: 0.1, nominal: 30 };
  assert.strictEqual(T.metricsNote(neu, base, null), 'your text is 100% passive (document: 10%).');
});

test('asksFix and churnShare: fix requests in English and Russian; the threshold', () => {
  deq(['Please fix the typos', 'Polish this paragraph', 'tighten it up', 'Исправь ошибки', 'улучши абзац', 'вычитай текст'].map((m) => T.asksFix(m)), [true, true, true, true, true, true]);
  deq(['Rewrite and fix this', 'перепиши и исправь', 'Add a paragraph about methods', 'Переведи на английский'].map((m) => T.asksFix(m)), [false, false, false, false]);
  const old = 'We measured the membrane order of 24 samples at 37 °C using Laurdan spectroscopy today.';
  assert.strictEqual(T.churnShare(old, 'Membrane order was assessed in two dozen specimens by fluorescence methods at body temperature.'), 1);
  assert.ok(T.churnShare(old, old.replace('using', 'with')) < 0.1);
  assert.strictEqual(T.churnShare('Too short to judge.', 'Entirely different words.'), null);
  // paragraph by paragraph when both have as many
  const two = `${old}\n${old}`;
  assert.ok(T.churnShare(two, `${old}\n${old.replace('today', 'yesterday')}`) < 0.1);
});

test('abbreviationIssues: undefined ones flagged; definitions, the document, emphasis and well-known ones pass', () => {
  deq(T.abbreviationIssues('We measured MSD values. The radial distribution function (RDF) was flat. ATP and DNA were added.', 'Plain text.'), ['MSD']);
  // defined after its first use: still flagged; "ABC (long form …)" defines it
  deq(T.abbreviationIssues('The RDF was flat. The radial distribution function (RDF) was flat.', ''), ['RDF']);
  deq(T.abbreviationIssues('The MSD (mean squared displacement) grew.', ''), []);
  // the document uses or defines it; "GAMMA" for a "gamma" of the document is emphasis
  deq(T.abbreviationIssues('The MSD grew and GAMMA rose.', 'The mean squared displacement (MSD) and gamma.'), []);
  // headings (no lowercase), Roman numerals, mutations, formulas
  deq(T.abbreviationIssues('RESULTS AND DISCUSSION\nCopper(II) with C87S in H2O, step IV.', ''), []);
  // Russian
  deq(T.abbreviationIssues('Спектры ЯМР сняли дважды. Метод молекулярной динамики (МД) применили.', 'Текст.'), ['ЯМР']);
});

test('unitSpacingIssues: the minority form against the document\'s dominant one', () => {
  const doc = 'We used 5 mM salt, 10 mg of drug, 2 mL water and 4 mm beads at 37 °C, then 25 °C, 30 °C and 4 °C; 5% and 10% loss, 2% and 3% more.';
  const habits = T.spacingHabits(doc);
  deq(habits, { unit: 'spaced', degree: 'spaced', percent: 'tight' });
  deq(T.unitSpacingIssues('We added 5mM salt at 37°C, 10 mg of drug and 5 % more.', habits),
    [{ text: '5mM', want: '5 mM' }, { text: '37°C', want: '37 °C' }, { text: '5 %', want: '5%' }]);
  // no dominant form (too few, or mixed): nothing
  deq(T.unitSpacingIssues('We added 5mM salt.', T.spacingHabits('We used 5 mM and 10mg.')), []);
  // Russian units
  deq(T.unitSpacingIssues('Добавили 5мг соли.', { unit: 'spaced' }), [{ text: '5мг', want: '5 мг' }]);
});

test('figureRefIssues: numbers past the document\'s highest mention or caption; captions of the new text count', () => {
  const max = T.figureMaxima('See Figure 1 and Fig. 2.\nFigure 3. Caption\nTable 1. Data\nE = mc2 (1)\nСм. рис. 2.');
  deq(max, { figure: 3, table: 1, equation: 1 });
  deq(T.figureRefIssues('As Figure 5 shows, and Table 2, Eq. (2), Figure 3.', max).map((r) => [r.text, r.max]),
    [['Figure 5', 3], ['Table 2', 1], ['Eq. (2)', 1]]);
  deq(T.figureRefIssues('Figure 4. A new caption.\nFigure 4 shows it.', max), []); // the new text captions it
  deq(T.figureRefIssues('Как видно на рис. 4 и в табл. 1.', max).map((r) => r.text), ['рис. 4']);
  // a document without targets: only when it is long enough to have them
  deq(T.figureRefIssues('See Figure 2.', { figure: 0, table: 0, equation: 0 }, 50), []);
  deq(T.figureRefIssues('See Figure 2.', { figure: 0, table: 0, equation: 0 }, 400).map((r) => [r.text, r.max]), [['Figure 2', 0]]);
});

test('meaningDrift: negation, modality, comparatives and quantifiers, quoted as pairs; English and Russian', () => {
  deq(T.meaningDrift('The drug may reduce pain and had no effect on sleep. Levels were higher in group A.',
    'The drug reduces pain and had an effect on sleep. Levels were lower in group A.').map((d) => [d.kind, d.pair, d.lost]), [
    ['modality', '"may reduce" → "reduces"', ['may']],
    ['negation', '"no effect" → "an effect"', []],
    ['comparative', '"higher in" → "lower in"', []],
  ]);
  deq(T.meaningDrift('Cells grew in most cases.', 'Cells grew in all cases.').map((d) => d.kind), ['quantifier']);
  deq(T.meaningDrift('The results show a shift.', 'The results suggest a shift.').map((d) => d.kind), ['modality']);
  deq(T.meaningDrift('Препарат, возможно, снижает боль. Уровень был выше.', 'Препарат снижает боль. Уровень был ниже.').map((d) => [d.kind, d.pair]), [
    ['modality', '"возможно снижает" → "снижает"'], ['comparative', '"был выше" → "был ниже"'], // no word after: the one before
  ]);
  deq(T.meaningDrift('Эффект не наблюдался.', 'Эффект наблюдался.').map((d) => d.kind), ['negation']);
  // wording changes without a shift; a long rewrite has no quotable pair
  deq(T.meaningDrift('The samples were measured twice.', 'We measured the samples twice.'), []);
  deq(T.meaningDrift('It may work in a few of the tested conditions and settings.', 'Every single approach that we tried across these varied settings always works fine.'), []);
  deq(T.driftQualifiers('The drug may reduce pain.', 'The drug reduces pain.'), ['may']);
});

test('claimLint: hype, "significant" without a test, stacked hedges, universal claims, unattributed claims', () => {
  deq(T.claimLint('This novel method proves the point. The difference was significant. Studies show that cells grow. It is known that X. '
    + 'The effect was significant (p < 0.01). This could potentially help. It always works. Research suggests growth [4].').map((c) => c.label), [
    '"novel" (hype)', '"proves" (hype)', '"significant" without a test', '"Studies show" without a citation', '"It is known that" without a citation',
    '"could potentially" (one hedge is enough)', '"always" (universal claim)',
  ]);
  deq(T.claimLint('Известно, что клетки растут. Мы впервые показали эффект. Различие статистически значимо. Различие значимо (p < 0,05). Иванов (2020) показал, что исследования показывают рост.').map((c) => c.label), [
    '"Известно, что" without a citation', '"впервые" (hype)', '"статистически значимо" without a test',
  ]);
  deq(T.claimLint('The membrane order increased from 0.21 to 0.34 after cholesterol loading.'), []);
});

test('statsLint: p = 0.000, p forms against the document, ranges, ±, data, numeral starts, means without dispersion', () => {
  const h = { pSpaced: true, pCase: 'p', ranges: 'en', dataPlural: true };
  deq(T.statsLint('We found p = 0.000 and P<0.05 here. Values were 5-10 mg and 3 +/- 1 mg. The data is clear. 12 samples were run. The mean was 5.2 mg.', h)
    .map((x) => x.label), [
    '"p = 0.000" (write p < 0.001)', '"P<0.05" (the document writes "p < 0.05")', '"5-10" (an en dash: 5–10)', '"+/-" (write ±)',
    '"The data is" (the document treats data as plural)', 'a sentence starts with "12"', '"mean" without SD, SE or CI',
  ]);
  // without habits only the absolute rules; a mean with SD, a numbered list item, "m = 5 kg" are fine
  deq(T.statsLint('The mean was 5.2 ± 0.3 mg; the average was 4 mg (SD 1). 1. Mix the samples. The mass m = 5 kg. p=0.03 and 5-10 mg. The data is new.', {})
    .map((x) => x.kind), []);
  deq(T.statsLint('В среднем 5,2 мг на образец.', {}).map((x) => x.kind), ['mean']);
  // sentence starts after a pointer abbreviation or in a list are not flagged; Russian ones are
  deq(T.statsLint('As shown in Fig. 3 cells grew. See p. 12 for more.\n2.1 Methods\n1) Mix the samples.', {}), []);
  deq(T.statsLint('Опыт прошёл быстро. 15 образцов разрушились.', {}).map((x) => x.label), ['a sentence starts with "15"']);
  const habits = T.statsHabits('Results: p < 0.05, p < 0.01 and p = 0.03. Ranges 5–10, 10–20 and 3–4 mg. These data are new.');
  deq(habits, { pSpaced: true, pCase: 'p', ranges: 'en', dataPlural: true });
});

test('concisionHits: wordy phrases with their concise form, mechanical vs judgment, English and Russian', () => {
  deq(T.concisionHits('In order to test it, a number of cells were used prior to the run. It should be noted that we utilized a large number of tubes.')
    .map((h) => [h.match, h.to, h.mechanical]), [
    ['In order to', 'to', true], ['a number of', 'several', false], ['prior to', 'before', true], ['It should be noted that', '', true],
    ['utilized', 'used', true], ['a large number of', 'many', true],
  ]);
  deq(T.concisionHits('В настоящее время данный метод является основным в целях контроля, в связи с тем что он прост.').map((h) => [h.match, h.to, h.mechanical]), [
    ['В настоящее время', 'сейчас', false], ['данный', 'этот', false], ['является', '=a dash or the verb', false], ['в целях', 'чтобы', false],
    ['в связи с тем что', 'потому что', true],
  ]);
  deq(T.concisionHits('The membrane order increased after cholesterol loading.'), []);
  deq(T.wordyNoteItems(T.concisionHits('In order to go, it should be noted that we take into account a lot.')),
    ['"In order to" → "to"', '"it should be noted that" → drop it', '"take into account" → consider']);
  assert.ok(T.CONCISION_PAIRS.length >= 80);
  for (const [src, to, tag] of T.CONCISION_PAIRS) {
    assert.ok(['mechanical', 'judgment'].includes(tag), src);
    assert.strictEqual(typeof to, 'string', src);
  }
});

// A snapshot for the hook alone: the document text and the user's message.
const snapOf = (docText, user = '') => ({ docText, chatCtx: { messages: user ? [{ role: 'user', content: user }] : [] } });

test('hook: notes only, never a refusal; old findings and prose-lint tells are not repeated; nothing for other tools', () => {
  const doc = DOC + '\nSee Figure 1.\nFigure 1. Setup.';
  let r = T.textChecks('replace_text', null, { old_text: 'The cells grew well there.', new_text: 'The cells grew well there, as Figure 4 shows, and this novel result proves it.' }, snapOf(doc));
  deq(r, { notes: ['claims: "novel" (hype); "proves" (hype).', 'not in the document: "Figure 4" (figures end at 1); a caption inside an image is not seen.'] });
  assert.ok(!('refuse' in r));
  // the old text had them: the author's own
  r = T.textChecks('replace_text', null, { old_text: 'This novel result proves it.', new_text: 'This novel result proves it again.' }, snapOf(doc));
  assert.strictEqual(r, null);
  // prose-lint reports "in order to" and "clearly" (its tells): not again here
  r = T.textChecks('insert_after_line', null, { line: 1, text: 'In order to see it, we clearly looked; a total of 5 runs.' }, snapOf(doc));
  deq(r, { notes: ['wordy: "a total of" → drop it.'] });
  deq(T.textChecks('delete_lines', null, { start: 1, end: 1 }, snapOf(doc)), null);
  deq(T.textChecks('remember', null, { text: 'This novel thing proves it.' }, snapOf(doc)), null);
  deq(T.TEXT_CHECK_TOOLS, T.PROSE_TOOLS);
});

test('hook: no abbreviation note for a heading or a title (style, outline marks, a paper title above the text, a heading line replaced)', () => {
  const abbr = (r) => ((r && r.notes) || []).filter((n) => n.startsWith('abbreviations not defined'));
  const body = 'EPR spectra of all samples were recorded twice at room temperature.';
  // an outline: the # heading and the paper title under it (normal text, no sentence end) head; the body line does not
  const outline = `# Supporting Information\n\nCW EPR of spin-labelled membranes\n\n## Methods\n${body}`;
  let r = T.textChecks('insert_after_line', { insertedText: outline.replace(/^#+ /gm, '') }, { line: 1, text: outline, style: 'outline' }, snapOf(DOC));
  deq(abbr(r), ['abbreviations not defined: "EPR" (write the full term at first use: "… (EPR)").']);
  r = T.textChecks('insert_after_line', null, { line: 1, text: 'CW EPR of spin-labelled membranes\n\n## Methods\nThe samples were measured twice.', style: 'outline' }, snapOf(DOC));
  deq(abbr(r), []);
  r = T.textChecks('insert_after_line', null, { line: 1, text: 'DEER and CW EPR of membranes', style: 'h2' }, snapOf(DOC));
  deq(abbr(r), []);
  // one line, no heading style: a list item or a caption is still checked
  r = T.textChecks('insert_after_line', null, { line: 1, text: 'DEER and CW EPR of membranes', style: null }, snapOf(DOC));
  deq(abbr(r), ['abbreviations not defined: "DEER"; "CW"; "EPR" (write the full term at first use: "… (DEER)").']);
  // a replace inside a heading or title line of the model; the same replace in body text is checked
  const model = { lines: [{ line: 1, text: 'Report', heading: 1 }, { line: 2, text: 'Body text here.', heading: 0 }] };
  r = T.textChecks('replace_text', { region: [1, 1] }, { old_text: 'Report', new_text: 'CW EPR report' }, { ...snapOf(DOC), model });
  deq(abbr(r), []);
  r = T.textChecks('replace_text', { region: [2, 2] }, { old_text: 'Body text', new_text: 'CW EPR text' }, { ...snapOf(DOC), model });
  deq(abbr(r).length, 1);
  // edit_document: an insert's lines by their styles, a replace by its line
  const plan = { ops: [{ op: 'insert', raw: '## DEER results\nDEER traces were fitted with one Gaussian.', n: 2, wants: ['HEADING_2', 'NORMAL_TEXT'] },
    { op: 'replace', given: { old_text: 'Report', new_text: 'PMF report' }, region: [1, 1] }] };
  r = T.textChecks('edit_document', plan, {}, { ...snapOf(DOC), model });
  deq(abbr(r), ['abbreviations not defined: "DEER" (write the full term at first use: "… (DEER)").']);
  deq(T.abbreviationIssues('MSD title\nThe MSD rose.', '', [true, false]), ['MSD']);
});

test('hook: churn only for a fix request on a replacement with old text; not for a translation', () => {
  const old = 'We measured the membrane order of 24 samples at 37 °C using Laurdan spectroscopy today.';
  const neu = 'Membrane order was assessed in two dozen specimens by fluorescence at 37 °C and 24 °C.';
  const note = 'this rewrote 81% of the paragraph for a fix request; keep edits minimal unless asked to rewrite.';
  assert.ok(T.textChecks('replace_text', null, { old_text: old, new_text: neu }, snapOf(DOC, 'Fix the typos here')).notes.includes(note));
  assert.ok(!(T.textChecks('replace_text', null, { old_text: old, new_text: neu }, snapOf(DOC, 'Rewrite this paragraph')) || { notes: [] }).notes.includes(note));
  assert.ok(!(T.textChecks('replace_all', null, { old_text: old, new_text: neu }, snapOf(DOC, 'Fix the typos here')) || { notes: [] }).notes.includes(note));
  const ru = 'Мы измерили упорядоченность мембран в 24 образцах при 37 °C методом спектроскопии лаурдана сегодня.';
  assert.ok(!(T.textChecks('replace_text', null, { old_text: old, new_text: ru }, snapOf(DOC, 'улучши абзац')) || { notes: [] }).notes.includes(note));
  // edit_document: per replace operation
  const plan = { ops: [{ op: 'replace', given: { old_text: old, new_text: neu }, region: [3, 3] }, { op: 'insert', raw: 'New line.', n: 4 }] };
  assert.ok(T.textChecks('edit_document', plan, {}, snapOf(DOC, 'Polish the methods')).notes.includes(note));
});

test('hook: the notes are capped at 400 characters with "+N more"; the ignore hook point is called per finding', () => {
  const text = 'This novel, groundbreaking result proves it. It is known that X. Studies indicate Y. It always works and never fails. '
    + 'It was significant. A mean of 5 mg. 12 runs were made. Values were 3 +/- 1 and p = 0.000. In excess of 5 runs, by means of a pump, '
    + 'with the exception of one, in the vicinity of the lab, a great deal of noise. MSD, RDF, VACF and PMF rose, see Figures 7, 8 and Table 9.';
  const r = T.textChecks('insert_after_line', null, { line: 1, text }, snapOf(DOC));
  const total = r.notes.join('').length;
  assert.ok(total <= 400, String(total));
  assert.ok(r.notes[0].startsWith('claims: ') && /; \+\d+ more\.$/.test(r.notes[0]), r.notes[0]);
  assert.strictEqual(T.textCheckIgnored('claims', 'novel'), false);
  // the hook point: an ignored kind leaves its line out
  const seen = [];
  const orig = T.textCheckIgnored;
  env.ctx.__seen = seen;
  env.run('textCheckIgnored = (kind) => { __seen.push(kind); return kind === "claims"; }');
  try {
    const r2 = T.textChecks('insert_after_line', null, { line: 1, text }, snapOf(DOC));
    assert.ok(!r2.notes.some((n) => n.startsWith('claims')), r2.notes.join('\n'));
    assert.ok(seen.includes('claims') && seen.includes('statistics') && seen.includes('wordy'), seen.join());
  } finally { env.ctx.__orig = orig; env.run('textCheckIgnored = __orig'); }
});
