'use strict';
// /check (src/check-text.js): the deterministic checks on plain text, the export's Markdown and the Docs API line
// model: acronyms (Schwartz–Hearst definitions, before the definition, twice, never; the allowlist and the
// instructions line; Cyrillic), pointers (dangling figures, tables, equations, sections; captions never mentioned or
// out of order), citations against the parsed reference list (numbered and author-year, English and Russian),
// word budgets (the instructions line, over and under), placeholders, blind-review leftovers, readability numbers,
// and the parse command.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, deq } = require('./lib/sandbox');
const { fakeDocsServer } = require('./lib/fake-docs');

let T;
before(async () => { ({ T } = await load({ settle: 0 })); });

const doc = (lines, format = 'text') => T.ckDocument({ text: Array.isArray(lines) ? lines.join('\n') : lines, format });
const kinds = (list) => list.map((f) => `${f.kind}@${f.line}`);
const run = (lines, opts) => T.checkDocument(doc(lines), opts).groups;

test('parseSlashCommand: /check is the built-in report (any case, text after it ignored); /checks is ordinary text', () => {
  deq(T.parseSlashCommand('/check'), { persona: null, check: true, text: '' });
  deq(T.parseSlashCommand('  /CHECK now please'), { persona: null, check: true, text: '' });
  assert.strictEqual(T.parseSlashCommand('/checks this').check, undefined);
  assert.strictEqual(T.parseSlashCommand('/test').selftest, true);
  assert.ok(T.CHECK_COMMANDS.check.desc.length > 10);
});

test('document structure: the plain-text title, headings and the reference list; Markdown headings and markup', () => {
  const d = doc(['A study of things', 'Abstract', 'Text of the abstract.', 'Introduction', 'Body text here.', 'References', 'Smith J. (2020). A title. Journal 1, 2.']);
  deq(d.sections.map((s) => [s.title, s.line, s.from, s.to]), [['Abstract', 2, 3, 3], ['Introduction', 4, 5, 5], ['References', 6, 7, 7]]);
  deq(d.titleBlock, [1, 1]);
  assert.strictEqual(d.bib.line, 6);
  deq(d.body.map((l) => l.line), [2, 3, 4, 5]);
  assert.ok(d.inAbstract(3) && !d.inAbstract(5));
  const m = doc(['# Title', '', 'Ann Lee, Bob Ray', '', '## Methods', 'We used **bold** and [a link](https://x.org).', '## References', '1. Smith J. (2020). T. J 1.'], 'markdown');
  assert.ok(m.lines[0].title);
  deq(m.sections.map((s) => s.title), ['Methods', 'References']);
  assert.strictEqual(m.lines[5].text, 'We used bold and a link.');
  deq(m.titleBlock, [1, 4]);
});

test('acronyms: Schwartz–Hearst definitions, used before the definition, never defined (with the count), defined twice', () => {
  const g = run([
    'Title',
    'Abstract',
    'We measured PNPB hydrolysis and SOC in soil organic carbon (SOC) plots.',
    'Introduction',
    'Activity towards p-nitrophenyl butyrate (PNPB) was measured; PNPB is cheap.',
    'The XRD data and XRD peaks were recorded.',
    'Soil organic carbon (SOC) was measured again.',
    'Polymerase chain reaction (PCR) and DNA, the mutants C87S and A112C, copper(II) and H2O, MRI.',
  ]).acronyms;
  // SOC: used before its definition in the same line, then defined in the abstract and again in the main text (allowed)
  deq(kinds(g), ['acronym-before-definition@3', 'acronym-before-definition@3', 'acronym-undefined@6', 'acronym-undefined@8']);
  const pnpb = g.find((f) => /^PNPB/.test(f.text));
  assert.strictEqual(pnpb.text, 'PNPB is used before its definition on line 5 (p-nitrophenyl butyrate).');
  assert.strictEqual(g.find((f) => /^SOC/.test(f.text)).text, 'SOC is used before its definition on line 3 (soil organic carbon).');
  assert.strictEqual(g[2].text, 'XRD is never defined (used 2 times).');
  assert.strictEqual(g[3].text, 'MRI is never defined (used once).');
  assert.strictEqual('We measured PNPB hydrolysis and SOC in soil organic carbon (SOC) plots.'.substr(pnpb.at, pnpb.len), 'PNPB');
  // SOC: defined in the abstract and again in the main text (allowed once), a third time is a note
  const twice = run(['T', 'Abstract', 'Soil organic carbon (SOC) fell.', 'Methods', 'Soil organic carbon (SOC) was sampled.', 'Results', 'Again soil organic carbon (SOC) rose.']).acronyms;
  deq(kinds(twice), ['acronym-twice@7']);
  assert.strictEqual(twice[0].text, 'SOC is defined again (first on line 3).');
  const twiceBody = run(['T', 'Methods', 'Soil organic carbon (SOC) was sampled.', 'Results', 'Soil organic carbon (SOC) rose.']).acronyms;
  deq(kinds(twiceBody), ['acronym-twice@5']);
});

test('acronyms: Cyrillic definitions and uses, a Latin acronym of a Russian long form, the instructions line extends the allowlist', () => {
  const g = run([
    'Заголовок',
    'Методика',
    'Величину ЕКО определяли позже. Ёмкость катионного обмена (ЕКО) измеряли по методу.',
    'Площадь поверхности (BET) и ДНК, РНК, СССР не требуют определения; ПАВ тоже.',
    'Данные РФА не приводятся, а XYZ и QQQ — внутренние коды.',
  ], { instructions: 'British English.\nacronyms: XYZ, QQQ' }).acronyms;
  deq(kinds(g), ['acronym-before-definition@3', 'acronym-undefined@4', 'acronym-undefined@5']);
  assert.match(g[0].text, /^ЕКО is used before its definition on line 3 \(Ёмкость катионного обмена\)/);
  assert.match(g[1].text, /^ПАВ is never defined/);
  assert.match(g[2].text, /^РФА is never defined/);
  deq([...T.ckAllowLine('acronyms: abc, ЁЖ;  XY')], ['ABC', 'ЕЖ', 'XY']);
});

test('pointers: dangling figures, tables, equations and sections; supplementary ones skipped; ranges expanded', () => {
  const g = run([
    'T',
    '1. Introduction',
    'As Fig. 1 and Figs. 2–3 show, and Figure S4 (supplementary) too; see Table 1, Table 2 and Eq. (1), Eq. (5).',
    'Section 2 and Section 4 describe the rest; рис. 7 и табл. 3 тоже.',
    '2. Methods',
    'E = mc2 (1)',
    'Figure 1. The setup.',
    'Figure 2: Results.',
    'Figure 3 – More results.',
    'Table 1. Data.',
  ]).pointers;
  deq(kinds(g).sort(), ['dangling-equation@3', 'dangling-figure@4', 'dangling-section@4', 'dangling-table@3', 'dangling-table@4'].sort());
  const fig = g.find((f) => f.kind === 'dangling-figure');
  assert.strictEqual(fig.text, 'Figure 7 is mentioned but there is no caption "Рис. 7." at a line start.');
  assert.strictEqual(g.find((f) => f.kind === 'dangling-section').text, 'Section 4 is mentioned but there is no heading numbered 4.');
  assert.strictEqual(g.find((f) => f.kind === 'dangling-equation').text, 'Equation 5 is mentioned but there is no equation numbered (5).');
});

test('pointers: captions never mentioned, numbered out of order or twice; a caption does not mention itself', () => {
  const g = run(['T', 'Results', 'See Figure 1 and Figure 3.', 'Figure 1. One.', 'Figure 3. Three.', 'Figure 2. Two.', 'Figure 2. Again.', 'Table 2. First table.']).pointers;
  deq(kinds(g), ['caption-order@5', 'figure-unmentioned@6', 'caption-order@6', 'figure-unmentioned@7', 'caption-order@7', 'table-unmentioned@8', 'caption-order@8']);
  assert.strictEqual(g[0].text, 'Figure 3 follows Figure 1: captions out of order.');
  assert.strictEqual(g[2].text, 'Figure 2 follows Figure 3: captions out of order.');
  assert.strictEqual(g[4].text, 'Figure 2 has a second caption.');
  assert.strictEqual(g[6].text, 'The first table caption is Table 2, not Table 1.');
});

test('reference entries: numbered and author-year, English and Russian, Vancouver and IEEE; DOIs; books', () => {
  const e = (t) => { const x = T.ckParseEntry(t); return { n: x.n, surname: x.surname, year: x.year, key: x.key, title: x.title, venue: x.venue, doi: x.doi, notIndexed: x.notIndexed }; };
  deq(e('[3] Brandt K. and Holm T. (2011). A global record of soil respiration. Journal of Soil Carbon 12, 101–114.'),
    { n: 3, surname: 'Brandt', year: '2011', key: 'brandt 2011', title: 'A global record of soil respiration', venue: 'Journal of Soil Carbon', doi: null, notIndexed: false });
  deq(e('Smith, J., & Lee, K. (2020b). Lipid rafts in membranes. Cell Biology, 4(2), 1–9. https://doi.org/10.1000/ABC.1'),
    { n: null, surname: 'Smith', year: '2020', key: 'smith 2020b', title: 'Lipid rafts in membranes', venue: 'Cell Biology', doi: '10.1000/abc.1', notIndexed: false });
  deq(e('Ковалёв Д. И. (2014). Кислотная обработка клиноптилолита. Химия в интересах устойчивого развития 22, 341–348.'),
    { n: null, surname: 'Ковалёв', year: '2014', key: 'ковалев 2014', title: 'Кислотная обработка клиноптилолита', venue: 'Химия в интересах устойчивого развития', doi: null, notIndexed: false });
  deq(e('12. Smith J, Lee KM. Interfacial activation of lipases. J Mol Catal. 2019;18:45-58.'),
    { n: 12, surname: 'Smith', year: '2019', key: 'smith 2019', title: 'Interfacial activation of lipases', venue: 'J Mol Catal', doi: null, notIndexed: false });
  deq(e('[7] J. Smith and K. Lee, “Deep nets for soil,” IEEE Trans. Geosci., vol. 3, 2018.').title, 'Deep nets for soil');
  assert.strictEqual(T.ckParseEntry('[7] J. Smith and K. Lee, “Deep nets for soil,” IEEE Trans. Geosci., vol. 3, 2018.').surname, 'Smith');
  assert.strictEqual(e('Иванов И. И. Цеолиты. М.: Наука, 2001. 300 с.').notIndexed, true);
  assert.strictEqual(e('Doe J. (2019). Soil models. PhD thesis, University of Leeds.').notIndexed, true);
});

test('citations: markers without an entry, entries never cited; numbered and author-year lists; no reference list', () => {
  const g = run([
    'T', 'Introduction',
    'Respiration [1] and warming [2, 3] were studied [9]; see also [4–5].',
    'References',
    '[1] Brandt K. (2011). One. J 1.', '[2] Ferreira L. (2007). Two. J 2.', '[3] Hale R. (2009). Three. J 3.', '[4] Mbeki S. (2012). Four. J 4.',
    '[5] Varga A. (1998). Five. J 5.', '[6] Schatz W. (2013). Six. J 6.',
  ]).references;
  deq(kinds(g), ['unknown-citation@3', 'uncited-reference@10']);
  assert.strictEqual(g[0].text, '[9] matches no entry of the reference list.');
  assert.strictEqual(g[1].text, '[6] Schatz (2013) is never cited in the text.');
  const ay = run([
    'T', 'Введение',
    'Обмен ускоряется (Смирнова, 2017; Lee and Park, 2019), как и у морденита (Петров и др., 2016); Okafor et al. (2021) спорят.',
    'Список литературы',
    'Смирнова Е. А. (2017). Ионный обмен. Журнал 90, 1.', 'Lee S. and Park J. (2019). Sodium. Materials 278, 77.',
    'Okafor C. (2021a). Lid. Protein 34, 2.', 'Ковалёв Д. И. (2014). Кислотная обработка. Химия 22, 341.',
  ]).references;
  deq(kinds(ay), ['unknown-citation@3', 'uncited-reference@8']);
  assert.strictEqual(ay[0].text, 'Петров и др., 2016 matches no entry of the reference list.');
  assert.strictEqual(ay[1].text, 'Ковалёв (2014) is never cited in the text.');
  const none = run(['T', 'Introduction', 'As shown before (Smith, 2020).']).references;
  deq(kinds(none), ['no-reference-list@3']);
});

test('word budgets: the instructions line, over and within the budget, the total, a name that matches no section', () => {
  deq(JSON.parse(JSON.stringify(T.ckBudgetLine('Use British English.\nbudget: abstract 25, introduction 1 000 words, methods: 5, total 6000 (source: https://journal.org/guide)'))),
    { limits: [{ name: 'abstract', words: 25 }, { name: 'introduction', words: 1000 }, { name: 'methods', words: 5 }], total: 6000, source: 'https://journal.org/guide' });
  assert.strictEqual(T.ckBudgetLine('no budget here'), null);
  const words = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ') + '.';
  const g = run(['T', 'Abstract', words(30), '1. Introduction', words(10), '1.1 Background', words(5), 'References', 'Smith J. (2020). T. J 1.'],
    { instructions: 'budget: abstract 25, introduction 20, discussion 100, total 40 (source: https://journal.org/guide)' }).budgets;
  deq(g.map((f) => [f.kind, f.line, f.text]), [
    ['over-budget', 0, 'Whole document (without the title block and the reference list): 45 words, 5 over the budget of 40 (source: https://journal.org/guide).'],
    ['over-budget', 2, 'Abstract: 30 words, 5 over the budget of 25 (source: https://journal.org/guide).'],
    ['budget-no-section', 0, 'No section matches "discussion" of the budget line.'],
    ['within-budget', 4, '1. Introduction: 15 of 20 words.'],
  ]);
  deq(kinds(run(['T', 'Abstract', 'x.']).budgets), ['no-budget@0']);
});

test('placeholders: [[?]] and [[TODO …]] with their lines', () => {
  const g = run(['T', 'Intro', 'The yield was [[?]] mg.', 'Plain [[not a placeholder]] text.', 'More [[TODO: add the 2019 data]] here and [[ todo ]].']).placeholders;
  deq(kinds(g), ['placeholder@3', 'placeholder@5', 'placeholder@5']);
  assert.strictEqual(g[1].text, 'Open placeholder [[TODO: add the 2019 data]].');
});

test('blind review: self-identifying phrases, acknowledgements and funding, author names of the title block, the export note', () => {
  const g = run([
    'Soil respiration on slopes',
    'Ivan Iushin, Anna Smith',
    'Department of Soil Science, University of Leeds, UK',
    'Abstract',
    'As in our previous work, our group at the institute measured it.',
    'We sampled the slope near the University of Leeds campus.',
    'В нашей лаборатории ранее нами было показано то же самое.',
    'Iushin collected the samples.',
    'Acknowledgements',
    'This work was supported by grant No. 123.',
    'References',
    'Smith A. (2020). T. J 1.',
  ]).blind;
  deq(kinds(g).sort(), ['blind-ack@10', 'blind-ack@9', 'blind-author@8', 'blind-self@5', 'blind-self@5', 'blind-self@6', 'blind-self@7', 'blind-self@7', 'no-api@0'].sort());
  assert.ok(g.some((f) => f.text === 'Author name «Iushin» (title block, line 2) appears in the text.'));
  assert.ok(g.some((f) => f.text === 'Self-identifying phrase «our previous work».'));
  assert.ok(!g.some((f) => /«Smith»/.test(f.text)), 'Smith only in the reference list');
});

test('blind review on the Docs API model: suggested changes and open comments; a comments error is a note', () => {
  const srv = fakeDocsServer({ tabs: [{ id: 't.0', title: 'Tab', items: [
    { p: 'Paper', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: 'Plain line.' }, { p: 'Changed line.', suggest: { insert: [0, 7] } },
  ] }] });
  const model = T.buildLineModel(srv.render(true), 't.0', 'DOC123');
  const d = T.ckDocument({ model });
  assert.strictEqual(d.format, 'docs-api');
  assert.ok(d.lines[0].title && d.lines[3].suggested);
  let g = T.ckBlind(d, { comments: [{ line: 3, text: 'Too vague' }, { line: 0, text: 'Elsewhere', where: 'in tab "Notes"' }] });
  deq(g.map((f) => [f.kind, f.line, f.text]), [
    ['suggestion', 4, 'Unresolved suggested change.'],
    ['open-comment', 3, 'Open comment: «Too vague».'],
    ['open-comment', 0, 'Open comment: «Elsewhere» (in tab "Notes").'],
  ]);
  g = T.ckBlind(d, { comments: { error: 'HTTP 403' } });
  deq(kinds(g), ['suggestion@4', 'comments-unread@0']);
});

test('readability: Flesch for English and Oborneva for Russian, per section with a band; syllables', () => {
  const en = T.ckFlesch('The cat sat on the mat. The dog ran.');
  deq(JSON.parse(JSON.stringify(en)), { score: 117.7, words: 9, sentences: 2, lang: 'en' }); // 206.835 − 1.015·4.5 − 84.6·1
  const ru = T.ckFlesch('Мама мыла раму. Папа спал.');
  deq(JSON.parse(JSON.stringify(ru)), { score: 95.4, words: 5, sentences: 2, lang: 'ru' }); // 206.835 − 1.3·2.5 − 60.1·1.8
  deq(['table', 'reading', 'the', 'measured', 'syllable'].map((w) => T.ckSyllables(w, 'en')), [2, 2, 1, 2, 3]);
  assert.strictEqual(T.ckSyllables('определение', 'ru'), 6);
  const long = Array.from({ length: 6 }, () => 'The enzyme was measured at several temperatures in a buffer.').join(' ');
  const g = run(['T', 'Methods', long, 'Results', 'Too short.']).readability;
  deq(kinds(g), ['readability@2']);
  assert.match(g[0].text, /^Methods: -?\d+(\.\d)? \((easy|standard|difficult|dense); Flesch, 60 words, 10\.0 per sentence\)\.$/);
});

test('the Docs API model: heading styles, a numbered list as the reference list, line numbers of the model', () => {
  const srv = fakeDocsServer({ tabs: [{ id: 't.0', title: 'Tab', items: [
    { p: 'A paper', style: 'TITLE' }, { p: 'Intro', style: 'HEADING_1' }, { p: 'As [1] and [3] show.' },
    { p: 'References', style: 'HEADING_1' },
    { p: 'Brandt K. (2011). One. J 1.', bullet: { listId: 'L1', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } },
    { p: 'Hale R. (2009). Two. J 2.', bullet: { listId: 'L1', level: 0, preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } },
  ] }] });
  const model = T.buildLineModel(srv.render(true), 't.0', 'DOC123');
  const d = T.ckDocument({ model });
  deq(T.ckEntries(d).map((e) => [e.n, e.surname, e.l.line]), [[1, 'Brandt', 5], [2, 'Hale', 6]]);
  const g = T.checkDocument(d, {}).groups.references;
  deq(kinds(g), ['unknown-citation@3', 'uncited-reference@6']);
});

test('the bench fixtures: the planted /check defects are found and the control gives nothing', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'bench', f), 'utf8');
  const all = (f) => { const r = T.checkDocument(doc(read(f)), {}).groups; return Object.values(r).flat().filter((x) => x.line && !['readability', 'budgets'].includes(x.group)); };
  deq(kinds(all('control-en.txt')), []);
  deq(kinds(all('en-enzyme.txt')).sort(), ['acronym-before-definition@3', 'acronym-undefined@7', 'acronym-undefined@7', 'dangling-figure@13', 'uncited-reference@21', 'unknown-citation@5'].sort());
});
