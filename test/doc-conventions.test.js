'use strict';
// The measured lines of the turn context (src/doc-conventions.js): the conventions (figure and table pointers,
// citations, ranges, unit spacing, the Oxford comma, spelling, the Russian decimal separator) on English and Russian
// samples, the glossary (term variants, abbreviations both ways), the hedge and passive counters, sectionExpectation
// with and without a classic heading, sectionKind on whole headings and sectionKindAt through enclosing sections,
// textExcerpt, the per-text cache, and where the lines go in the turn context.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, deq, load, makeSnapFor, installDocTab } = require('./lib/sandbox');

// The two modules alone in a fresh context (doc-conventions needs only the segmentation helpers).
function loadModules() {
  const ctx = vm.createContext({});
  for (const f of ['src/text-segments.js', 'src/doc-conventions.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return new Proxy({}, { get: (_, name) => vm.runInContext(String(name), ctx) });
}
const C = loadModules();

const EN = 'Figure 1. The set-up.\n' +
  'The spin labels were attached at the sites shown in Fig. 2, and the spin-label rotamers were modelled with molecular dynamics (MD) ' +
  'at 25 °C in 50 mM phosphate (Smith, 2020). Double electron–electron resonance (DEER) gave distances of 2–6 nm (Fig. 3). ' +
  'The colour of the samples, the buffer, and the temperature were kept constant (Jones and Lee, 2019). Distances of 3–5 nm were ' +
  'found for 10% of the spin labels (Fig. 4), and the analysed traces, fits, and residuals are given in Table 1 (Brown, 2018).\n';
const RU = 'Метод молекулярной динамики (МД) широко применяется для изучения белков [1, 2]. Расстояния 2–6 нм измерены (рис. 2). ' +
  'Концентрация белка составляла 0,5 мМ при 25 °C [3]. Значение 3,5 нм получено для позиции 45 (рис. 3). Траектории МД длиной ' +
  '100 нс показали, что петля подвижна [4–6]. Разница составила 1,2 нм [7].\n';

test('conventions: English pointers, author-year citations, ranges, units, the Oxford comma, British spelling', () => {
  deq({ ...C.docConventions(EN) }, {
    figures: '(Fig. 2)', tables: null, citations: '(Author, Year)', ranges: '5–10', units: '"50 mM"', degrees: null,
    percent: null, oxford: 'Oxford comma', spelling: 'British spelling', decimal: null,
  });
  // a caption at the start of a line is not a pointer; "Figure 2" mid-sentence is
  assert.strictEqual(C.docConventions('Figure 1. A.\nFigure 2. B.\nAs Figure 3 shows, and Figure 4 too.').figures, 'Figure 2');
  // two forms without a clear majority: nothing
  assert.strictEqual(C.docConventions('See Fig. 1 and Figure 2, then Fig. 3 and Figure 4.').figures, null);
  // one occurrence is not a convention
  assert.strictEqual(C.docConventions('As in Fig. 2.').figures, null);
  // numeric citations; bracketed citation ranges are not number ranges; hyphen and "to" ranges
  const num = C.docConventions('A [1]. B [2, 3]. C [4-6]. D [7–9]. E 5-10 mM and 20-30 mM.');
  assert.strictEqual(num.citations, '[n]');
  assert.strictEqual(num.ranges, '5-10');
  assert.strictEqual(C.docConventions('From 5 to 10 min and from 20 to 30 min.').ranges, '"5 to 10"');
  // dates and identifiers are not ranges
  assert.strictEqual(C.docConventions('On 2020-01-05 and 2021-02-03, COVID-19 and SARS-CoV-2.').ranges, null);
  // unit spacing: tight; °C and % apart; a figure panel ("Fig. 2h") is not a unit
  const tight = C.docConventions('We used 5mM salt, 10mg protein and 2h at 25°C and 37°C; 5% and 10% (Fig. 2h, Fig. 3h).');
  deq([tight.units, tight.degrees, tight.percent], ['"5mM"', '"25°C"', '"5%"']);
  // no Oxford comma; a sentence opener is not a list
  assert.strictEqual(C.docConventions('We bought apples, pears and plums. They sold eggs, milk and bread. However, salt and pepper.').oxford, 'no Oxford comma');
  // spelling: American; -ize with British words is Oxford spelling; mixed: nothing
  assert.strictEqual(C.docConventions('The color and behavior were analyzed.').spelling, 'American spelling');
  assert.strictEqual(C.docConventions('The colour and behaviour were optimized and characterized.').spelling, 'British spelling with -ize');
  assert.strictEqual(C.docConventions('The colour and the color.').spelling, null);
  // the References list is not measured
  assert.strictEqual(C.docConventions('Text.\nReferences\nSmith (2020) [1] [2] [3].').citations, null);
  // DOIs in brackets, with or without "doi:", one or several in a bracket; against a minority of numbers
  assert.strictEqual(C.docConventions('A [10.1021/acs.jpcb.0c01234]. B [doi:10.1038/s41598-017-01886-y]. C [10.1007/x.1; 10.1016/j.bpj.2020.01.001]. D [4].').citations, '[doi]');
  assert.strictEqual(C.docConventions('A [10.1021/acs.jpcb.0c01234]. B [10.1021/x.2]. C [4]. D [5].').citations, null); // no clear majority
  assert.strictEqual(C.conventionsLine({ docText: 'A [10.1021/x.1]. B [10.1021/x.2]. C [10.1021/x.3].' }), 'Conventions: citations [doi].');
});

test('conventions: Russian pointers, numeric citations, the decimal comma; no Oxford comma or spelling', () => {
  const c = C.docConventions(RU);
  deq({ ...c }, {
    figures: '(рис. 2)', tables: null, citations: '[n]', ranges: null, units: '"6 нм"', degrees: null, percent: null,
    oxford: null, spelling: null, decimal: 'decimal comma',
  });
  // section and figure numbers are not decimals
  assert.strictEqual(C.docConventions('См. раздел 2.3 и рис. 1.2, табл. 3.1. Значения 0,5 и 1,5.').decimal, 'decimal comma');
  assert.strictEqual(C.docConventions('Значения 0.5 и 1.5 и 2.5.').decimal, 'decimal point');
  assert.strictEqual(C.docConventions('Как видно на рисунке 2 и на рисунке 3.').figures, 'рисунок 2');
});

test('conventionsLine: only what was detected, one line', () => {
  assert.strictEqual(C.conventionsLine({ docText: EN }),
    'Conventions: figures "(Fig. 2)"; citations (Author, Year); ranges 5–10; units "50 mM"; Oxford comma; British spelling.');
  assert.strictEqual(C.conventionsLine({ docText: 'Plain words only.' }), '');
  assert.strictEqual(C.conventionsLine({ docText: null }), '');
});

test('docGlossary: term variants without case, hyphens and plurals; abbreviations both ways', () => {
  const g = C.docGlossary(EN + 'Two spin labels and one spin label. RMSD (root mean square deviation) was small.');
  deq(JSON.parse(JSON.stringify(g)), {
    terms: [{ canonical: 'spin label', variants: ['spin-label'], count: 5 }],
    abbreviations: [
      { abbr: 'MD', expansion: 'molecular dynamics' },
      { abbr: 'DEER', expansion: 'double electron–electron resonance' }, // the sentence's capital goes
      { abbr: 'RMSD', expansion: 'root mean square deviation' },
    ],
  });
  // a pair under three times is not a term; an adverb or a participle at either end is not one either
  deq(JSON.parse(JSON.stringify(C.docGlossary('Described previously. Described previously. Described previously. Red fox. Red fox.').terms)), []);
  // a name keeps its capital; a bracket that is not an expansion is ignored
  deq(JSON.parse(JSON.stringify(C.docGlossary('We ran Monte Carlo (MC) runs. The MD (see Fig. 2) and XYZ (2020).').abbreviations)), [{ abbr: 'MC', expansion: 'Monte Carlo' }]);
  // Russian abbreviations as written
  deq(JSON.parse(JSON.stringify(C.docGlossary(RU).abbreviations)), [{ abbr: 'МД', expansion: 'молекулярной динамики' }]);
  // a shorter term inside a longer one of about the same count is left out
  const nested = C.docGlossary('The spin label distance. A spin-label distance. The spin label distance again. Spin label distances.');
  deq(JSON.parse(JSON.stringify(nested.terms)), [{ canonical: 'spin label distance', variants: ['spin-label distance'], count: 4 }]);
});

test('glossaryLine: the terms with variants and the abbreviations within 200 characters', () => {
  const line = C.glossaryLine({ docText: EN });
  assert.strictEqual(line, 'Terms: spin label (also spin-label); MD = molecular dynamics; DEER = double electron–electron resonance.');
  // a term without variants stays out of the line
  assert.strictEqual(C.glossaryLine({ docText: 'Heat shock. Heat shock. Heat shock proteins.' }), '');
  // twelve abbreviations: only as many as fit
  const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    .map((w) => `We used ${w} measurement method (${w[0].toUpperCase()}MM).`).join(' ');
  assert.strictEqual(C.docGlossary(many).abbreviations.length, 6);
  assert.ok(C.glossaryLine({ docText: many }).length <= 200);
});

test('hedges and the passive: rates and the counters', () => {
  assert.strictEqual(C.hedgeCount('This may suggest that it could, possibly, be so. In May it seems likely.'), 6); // "May" the month is not counted
  assert.strictEqual(C.hedgeCount('Возможно, это так; по-видимому, метка может быть подвижной, вероятно.'), 4);
  assert.strictEqual(C.hedgeRate('word '.repeat(98) + 'may might'), 2);
  assert.strictEqual(C.hedgeRate(''), null);
  for (const s of ['The samples were analysed twice.', 'It was used before.', 'The data are not shown.', 'It has been carefully written.']) assert.ok(C.isPassive(s), s);
  for (const s of ['We analysed the samples.', 'There is a need for speed.', 'It was indeed red.', 'The cells grew.']) assert.ok(!C.isPassive(s), s);
  assert.strictEqual(C.passiveRate('The cells were grown. We measured them. The data are shown. It works.'), 50);
  assert.strictEqual(C.passiveRate('Клетки были выращены. Мы их измерили.'), null); // Russian: not measured
  assert.strictEqual(C.passiveRate('A heading'), null);
});

test('sectionExpectation: the heading, its first sentence and the classic type\'s clause', () => {
  const model = { lines: [
    { line: 1, text: 'Paper', heading: 0 },
    { line: 2, text: '2.3 Torsional fitting', heading: 2 },
    { line: 3, text: 'We fitted the torsional terms of the force field to quantum chemical scans of the dihedral angles. The fit used ten points.', heading: 0 },
    { line: 4, text: 'Short.', heading: 0 },
    { line: 5, text: 'Results', heading: 1 },
    { line: 6, text: '', heading: 0 },
    { line: 7, text: 'Обсуждение', heading: 1 },
    { line: 8, text: 'Подвижность метки ограничена в петле, что согласуется с данными МД. '.repeat(3), heading: 0 },
  ] };
  const says = 'Section «2.3 Torsional fitting»: continue its register; it so far says: "We fitted the torsional terms of the force field to quantum chemical scans of the dihedral angles."';
  assert.strictEqual(C.sectionExpectation(model, 1), ''); // no heading above
  for (const n of [2, 3, 4]) assert.strictEqual(C.sectionExpectation(model, n), says, String(n));
  // the line itself skipped (revise_section sends it anyway): only short lines left
  assert.strictEqual(C.sectionExpectation(model, 3, { skipLine: true }), 'Section «2.3 Torsional fitting».');
  assert.strictEqual(C.sectionExpectation(model, 6), `Section «Results»: empty so far. ${C.SECTION_HINTS.results}.`);
  assert.strictEqual(C.sectionExpectation(model, 6, { hint: false }), 'Section «Results»: empty so far.');
  const ru = C.sectionExpectation(model, 8);
  assert.ok(ru.startsWith('Section «Обсуждение»: continue its register; it so far says: "Подвижность метки ограничена в петле, что согласуется с данными МД."'), ru);
  assert.ok(ru.endsWith(` ${C.SECTION_HINTS.discussion}.`));
  // a first sentence over 120 characters is cut at a word and marked as cut, never mid-word
  model.lines[2].text = 'Word '.repeat(60).trim() + '.';
  const cut = C.sectionExpectation(model, 3);
  assert.ok(/: "(?:Word )+\[…\]"\.$/.test(cut) && cut.length < says.length + 40, cut);
  assert.strictEqual(C.sectionExpectation(null, 3), '');
  // the classic types, English and Russian; the first match wins
  deq(['Abstract', 'Введение', 'Materials and methods', 'Results and discussion', 'Conclusions', 'Limitations of the study', 'Data availability',
    'Доступность данных', 'Acknowledgements'].map((h) => C.sectionKind(h)),
  ['abstract', 'introduction', 'methods', 'results', 'discussion', 'limitations', 'data', 'data', null]);
  for (const h of Object.values(C.SECTION_HINTS)) assert.ok(h.length < 110 && !h.endsWith('.'), h); // one clause each
});

test('sectionKind: a heading is a classic section only as a whole (a number, a final colon and the common variants allowed)', () => {
  const kinds = {
    limitations: ['Limitations', 'Study limitations', 'Limitations of the study', 'Strengths and limitations', '4.3 Limitations and uncertainty',
      'LIMITATIONS', 'Ограничения', 'Ограничения исследования'],
    methods: ['Methods', 'Materials and Methods', '2. Materials and methods:', 'Computational methods', 'Experimental section', 'Methodology',
      'A. Methods', 'Методы', 'Материалы и методы', 'Методы исследования', 'Экспериментальная часть', 'Глава 2. Материалы и методы'],
    results: ['Results', 'Results and Discussion', 'II. RESULTS AND DISCUSSION', 'Findings', 'Результаты', 'Результаты и обсуждение'],
    discussion: ['Discussion', 'Conclusions', 'Discussion and conclusions', 'Concluding remarks', 'Summary and conclusions',
      'Обсуждение', 'Обсуждение результатов', 'Заключение', 'Выводы'],
    introduction: ['Introduction', '1 Introduction', '1. Introduction', 'Chapter 1: Introduction', 'Background', 'Введение', 'Актуальность темы'],
    abstract: ['Abstract', 'Summary', 'Аннотация', 'Реферат'],
    data: ['Data availability', 'Data availability statement', 'Availability of data and materials', 'Code availability', 'Доступность данных'],
  };
  for (const [kind, list] of Object.entries(kinds)) for (const h of list) assert.strictEqual(C.sectionKind(h), kind, h);
  // the word inside a longer topical heading: no type
  for (const h of ['Existing approaches and their limitations', 'Limitations of earlier force fields', 'Methods for labelling proteins',
    'Results of earlier studies', 'Background noise in the spectra', 'A summary of the dyes', 'Обзор методов и их ограничений', 'Новые результаты',
    'Acknowledgements', 'Related work', '', null]) assert.strictEqual(C.sectionKind(h), null, String(h));
  // a request names a section by a word anywhere in it
  deq(['Improve the introduction', 'улучши введение', 'make the methods better', 'Polish the limitations paragraph'].map((t) => C.namedSectionKind(t)),
    ['introduction', 'introduction', 'methods', 'limitations']);
});

test('sectionKindAt: a subsection takes the type of the classic section it sits under; a topical section without one has none', () => {
  const H = (line, text, heading) => ({ line, text, heading });
  const P = (line) => ({ line, text: 'Order rose in the treated cells and fell again after washing.', heading: 0 });
  const model = { lines: [
    H(1, 'Membrane order', 1), P(2),
    H(3, 'Introduction', 1), P(4),
    H(5, 'Existing approaches and their limitations', 2), P(6),
    H(7, 'Probes that report order', 3), P(8),
    H(9, 'Results', 1), P(10),
    H(11, 'Summary', 2), P(12),
    H(13, 'Discussion', 1),
    H(14, 'Limitations', 2), P(15),
    H(16, 'Data availability', 2), P(17),
    H(18, 'Abstract', 1), P(19),
    H(20, 'Supporting figures', 1),
    H(21, 'Results of the control runs', 2), P(22),
  ] };
  deq([4, 6, 8, 10, 12, 15, 17, 19, 22, 2, 5].map((n) => C.sectionKindAt(model, n)),
    ['introduction', 'introduction', 'introduction', 'results', 'results', 'limitations', 'data', 'abstract', null, null, 'introduction']);
  // the section note's type clause follows it: an introduction write, not a limitations one
  const note = C.sectionExpectation(model, 6);
  assert.ok(note.startsWith('Section «Existing approaches and their limitations»: continue its register; it so far says: "Order rose') &&
    note.endsWith(` ${C.SECTION_HINTS.introduction}.`), note);
  assert.ok(!C.sectionExpectation(model, 22).includes(C.SECTION_HINTS.results), C.sectionExpectation(model, 22));
  assert.ok(C.sectionExpectation(model, 15).endsWith(` ${C.SECTION_HINTS.limitations}.`));
});

test('textExcerpt: whole sentences from the start or the end, both ends, a marked gap; a long sentence cut at a word', () => {
  const S = ['Lipid rafts gather cholesterol into ordered patches.', 'Their size has been debated for two decades.',
    'Probes that report on local order gave the first evidence.', 'The same probes now follow how drugs change order.'];
  const para = S.join(' ');
  assert.strictEqual(C.textExcerpt(para, para.length), para); // fits: whole
  assert.strictEqual(C.textExcerpt(`  ${S[0]}\n ${S[1]} `, 500), `${S[0]} ${S[1]}`);
  assert.strictEqual(C.textExcerpt(para, 110), `${S[0]} ${S[1]} […]`);
  assert.strictEqual(C.textExcerpt(para, 100, 'end'), `[…] ${S[3]}`);
  assert.strictEqual(C.textExcerpt(para, 120, 'end'), `[…] ${S[2]} ${S[3]}`);
  assert.strictEqual(C.textExcerpt(para, 160, 'end'), `[…] ${S[1]} ${S[2]} ${S[3]}`);
  assert.strictEqual(C.textExcerpt(para, 120, 'both'), `${S[0]} […] ${S[3]}`);
  // one sentence longer than the room: its start (or its end) at a word boundary
  const long = `${'alpha '.repeat(40)}omega ends here.`;
  assert.strictEqual(C.textExcerpt(long, 40), `${'alpha '.repeat(6).trim()} […]`);
  assert.strictEqual(C.textExcerpt(long, 40, 'end'), `[…] alpha alpha alpha omega ends here.`);
  const both = C.textExcerpt(long, 60, 'both');
  assert.ok(/^(?:alpha )+\[…\] (?:alpha )+omega ends here\.$/.test(both) && both.length <= 60, both);
  // the last sentences of a paragraph whose first sentence is long: the end is still whole sentences
  assert.strictEqual(C.textExcerpt(`${long} ${S[3]}`, 80, 'end'), `[…] ${S[3]}`);
  assert.strictEqual(C.textExcerpt('', 10), '');
});

test('the cache: one result per text, recomputed when the text changes', () => {
  let calls = 0;
  const f = C.memoByText((t) => { calls++; return { t }; });
  const a = f('x'); const b = f('x');
  assert.strictEqual(a, b);
  f('y'); f('y');
  assert.strictEqual(calls, 2);
  f('y', 'other key');
  assert.strictEqual(calls, 3);
  assert.strictEqual(C.docConventions(EN), C.docConventions(EN.slice(0)));
  assert.strictEqual(C.docGlossary(EN), C.docGlossary(EN));
});

let T, state, snapFor;
before(async () => {
  const env = await load();
  ({ T, state } = env);
  snapFor = makeSnapFor(env);
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.docFormat = 'markdown'; state.docModel = null; state.selection = ''; state.docTitle = 'Paper';
});

test('the turn context: the conventions and terms lines follow the style line; older Munin turns drop them; persona turns get them once', () => {
  state.docText = EN.repeat(6); // over 400 words (about 100 each)
  const ctx = T.buildTurnContext('edit', snapFor('anthropic'));
  const style = T.styleLine({ docText: state.docText });
  const conv = T.conventionsLine({ docText: state.docText });
  const terms = T.glossaryLine({ docText: state.docText });
  assert.ok(style.startsWith('Style of the document: average sentence') && style.includes('hedges 0/100 words; passive '), style);
  assert.ok(ctx.includes(`</document>\n${style}\n${conv}\n${terms}\nCurrent selection`), ctx);
  const short = T.shortContext(ctx);
  for (const s of ['Style of the document', 'Conventions:', 'Terms:']) assert.ok(!short.includes(s), s);
  assert.ok(short.includes('Current selection'));
  // a short document: none of the three
  state.docText = EN;
  const small = T.buildTurnContext('edit', snapFor('anthropic'));
  for (const s of ['Style of the document', 'Conventions:', 'Terms:']) assert.ok(!small.includes(s), s);
  // a Munin persona turn: after the excerpt, once
  state.docText = EN.repeat(6);
  state.messages = [{ role: 'user', content: 'Is this clear?' }];
  const body = JSON.stringify(T.buildRequest('chat', snapFor('munin')).body);
  assert.strictEqual(body.split('Conventions: ').length, 2);
  assert.strictEqual(body.split('Terms: ').length, 2);
  state.messages = [];
});
