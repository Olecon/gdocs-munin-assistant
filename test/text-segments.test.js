'use strict';
// Sentence and word segmentation (src/text-segments.js): Intl.Segmenter plus the abbreviation merge pass in
// English and Russian (titles, pointers, end-type abbreviations, initials, decimals, units after numbers), mixed
// scientific paragraphs, word counts (hyphenated words, numbers, Cyrillic), the regex fallback without
// Intl.Segmenter, and the language guess.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, SCRIPTS } = require('./lib/sandbox');

// The module alone in a fresh context; noSegmenter: as in an old jsdom without Intl.Segmenter.
function loadSegments({ noSegmenter = false } = {}) {
  const ctx = vm.createContext({});
  if (noSegmenter) vm.runInContext('delete Intl.Segmenter', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/text-segments.js'), 'utf8'), ctx, { filename: 'src/text-segments.js' });
  return new Proxy({}, { get: (_, name) => vm.runInContext(String(name), ctx) });
}
const S = loadSegments();
const split = (text, lang) => JSON.parse(JSON.stringify(S.splitSentences(text, lang)));

test('the module loads before the modules that use it', () => {
  const at = SCRIPTS.indexOf('src/text-segments.js');
  assert.ok(at > 0 && at < SCRIPTS.indexOf('src/request.js') && at < SCRIPTS.indexOf('src/prose-lint.js'));
});

test('English: titles and pointers continue the sentence, decimals and thousands do not split it', () => {
  assert.deepStrictEqual(split('Dr. Smith and Prof. Jones met. Mr. Brown left.'), ['Dr. Smith and Prof. Jones met.', 'Mr. Brown left.']);
  assert.deepStrictEqual(split('Fig. 3A shows the trace. See Fig. 2 and Eq. 4. Figs. 5 and 6 agree. Ref. 12 and Tab. 1 differ. Sect. 2 explains it.'),
    ['Fig. 3A shows the trace.', 'See Fig. 2 and Eq. 4.', 'Figs. 5 and 6 agree.', 'Ref. 12 and Tab. 1 differ.', 'Sect. 2 explains it.']);
  assert.deepStrictEqual(split('The mean was 3.5 mM in 1,000 cells. It fell.'), ['The mean was 3.5 mM in 1,000 cells.', 'It fell.']);
  assert.deepStrictEqual(split('Salts, e.g. NaCl, i.e. the cheap ones, cf. Smith, A vs. B. Next.'), ['Salts, e.g. NaCl, i.e. the cheap ones, cf. Smith, A vs. B.', 'Next.']);
  assert.deepStrictEqual(split('On p. 5 and in Vol. 3 it was approx. 50% lower. Done.'), ['On p. 5 and in Vol. 3 it was approx. 50% lower.', 'Done.']);
});

test('English: end-type abbreviations continue only before a lowercase word (UAX #29 SB8 already keeps that)', () => {
  assert.deepStrictEqual(split('Salts, acids etc. were used. Smith et al. (2020) agreed. Smith et al. reported it.'),
    ['Salts, acids etc. were used.', 'Smith et al. (2020) agreed.', 'Smith et al. reported it.']);
  assert.deepStrictEqual(split('We used salts, acids, etc. Then we heated them.'), ['We used salts, acids, etc.', 'Then we heated them.']);
  assert.deepStrictEqual(split('This was shown by Smith et al. The next study disagreed.'), ['This was shown by Smith et al.', 'The next study disagreed.']);
});

test('Russian: titles, pointers, initials, end-type abbreviations and units after numbers', () => {
  assert.deepStrictEqual(split('Проф. Иванов и акад. Петров пришли. См. рис. 3 и табл. 2. Рис. 3А показывает спектр.'),
    ['Проф. Иванов и акад. Петров пришли.', 'См. рис. 3 и табл. 2.', 'Рис. 3А показывает спектр.']);
  assert.deepStrictEqual(split('Ур. 4 и гл. 2, разд. 3, ср. Рис. 5. Далее.'), ['Ур. 4 и гл. 2, разд. 3, ср. Рис. 5.', 'Далее.']);
  assert.deepStrictEqual(split('А. С. Пушкин писал. Соли, кислоты и т. д. использовали. Белки и т. п. Затем, т. е. позже, мы ушли.'),
    ['А. С. Пушкин писал.', 'Соли, кислоты и т. д. использовали.', 'Белки и т. п.', 'Затем, т. е. позже, мы ушли.']);
  assert.deepStrictEqual(split('Иванов и др. (2020) показали это. На с. 12 видно. Это 3,5 и 1,000 единиц.'),
    ['Иванов и др. (2020) показали это.', 'На с. 12 видно.', 'Это 3,5 и 1,000 единиц.']);
  // a unit after a number ends the sentence: "см" is a centimetre there, "с" a second, "г." a year
  assert.deepStrictEqual(split('Длина 5 см. Затем 10 с. Потом в 2020 г. Было тепло.'), ['Длина 5 см.', 'Затем 10 с.', 'Потом в 2020 г.', 'Было тепло.']);
});

test('lines never share a sentence; a heading is a segment that endsSentence rejects', () => {
  const spans = JSON.parse(JSON.stringify(S.sentenceSpans('Results\nThe yield rose. It fell.\vNext line')));
  assert.deepStrictEqual(spans.map((s) => s.text), ['Results', 'The yield rose.', 'It fell.', 'Next line']);
  assert.deepStrictEqual(spans.map((s) => s.start), [0, 8, 24, 33]);
  assert.deepStrictEqual(spans.map((s) => S.endsSentence(s.text)), [false, true, true, false]);
  assert.ok(S.endsSentence('It is "done."') && S.endsSentence('Так ли?»') && S.endsSentence('Ну…'));
});

test('a mixed scientific paragraph in each language', () => {
  const en = 'Membrane order was measured as in Ref. 12 (see Fig. 3A and Eq. 2). At 37 °C the GP rose from 0.21 to 0.34, i.e. by 62%, in 1,000 cells; Smith et al. (2020) found 0.30. Dr. Lee repeated it in Jan. 2021 with approx. 2.5 mM cholesterol, salts, buffers etc. The effect vanished at pH 9.';
  assert.deepStrictEqual(split(en), [
    'Membrane order was measured as in Ref. 12 (see Fig. 3A and Eq. 2).',
    'At 37 °C the GP rose from 0.21 to 0.34, i.e. by 62%, in 1,000 cells; Smith et al. (2020) found 0.30.',
    'Dr. Lee repeated it in Jan. 2021 with approx. 2.5 mM cholesterol, salts, buffers etc.',
    'The effect vanished at pH 9.',
  ]);
  const ru = 'Упорядоченность мембран измеряли, как описано в работе проф. Иванова (см. рис. 2 и табл. 1). При 37 °C она выросла с 0,21 до 0,34, т. е. на 62 %, что согласуется с данными Петрова и др. (2020). Измерения на с. 14 повторил А. В. Сидоров, использовав соли, буферы и т. д. Эффект исчез при pH 9.';
  assert.deepStrictEqual(split(ru), [
    'Упорядоченность мембран измеряли, как описано в работе проф. Иванова (см. рис. 2 и табл. 1).',
    'При 37 °C она выросла с 0,21 до 0,34, т. е. на 62 %, что согласуется с данными Петрова и др. (2020).',
    'Измерения на с. 14 повторил А. В. Сидоров, использовав соли, буферы и т. д.',
    'Эффект исчез при pH 9.',
  ]);
});

test('word counts: word-like segments; hyphenated words, numbers and Cyrillic count as one word', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.textWords("well-known 3.5 1,000 don't по-видимому methyl-β-cyclodextrin 1–3 a - b pre- and post-test"))),
    ['well-known', '3.5', '1,000', "don't", 'по-видимому', 'methyl-β-cyclodextrin', '1', '3', 'a', 'b', 'pre', 'and', 'post-test']);
  assert.strictEqual(S.countWords('Мы измерили 3,5 единицы — дважды.'), 5);
  assert.strictEqual(S.countWords('At 37 °C, H2O (n = 24).'), 6); // At 37 C H2O n 24
  assert.strictEqual(S.countWords(''), 0);
});

test('without Intl.Segmenter the regex fallback still splits sentences and counts words', () => {
  const F = loadSegments({ noSegmenter: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.splitSentences('Dr. Smith came. See Fig. 3A here. The mean was 3.5 mM. Last'))),
    ['Dr. Smith came.', 'See Fig. 3A here.', 'The mean was 3.5 mM.', 'Last']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.splitSentences('Проф. Иванов пришёл. См. рис. 3.'))), ['Проф. Иванов пришёл.', 'См. рис. 3.']);
  assert.strictEqual(F.countWords("well-known 3.5 1,000 don't по-видимому"), 5);
});

test('textLang: Russian by the share of Cyrillic letters', () => {
  assert.strictEqual(S.textLang('Мы измерили GP методом Laurdan в клетках HeLa.'), 'ru');
  assert.strictEqual(S.textLang('We measured the Иванов effect.'), 'en');
  assert.strictEqual(S.textLang('123'), 'en');
});
