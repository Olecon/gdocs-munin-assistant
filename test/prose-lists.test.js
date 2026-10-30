'use strict';
// The tell lists (src/prose-lists.js) through proseTells: the shape of every entry, one hit per category in
// English and in Russian (fillers are Russian only), the sentence-start entries, and normal scientific paragraphs
// in both languages that produce no tell.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let T;
const tells = (text) => T.proseTells(text, null).map((t) => `${t.kind}: ${t.match}`);

before(async () => {
  ({ T } = await load());
});

test('every list entry: a known category, a compiling pattern, a plain alternative, known flags', () => {
  const order = JSON.parse(JSON.stringify(T.PROSE_TELL_ORDER));
  deq(order, ['chat', 'staging', 'tail', 'opener', 'stock', 'filler', 'hedge', 'wordy', 'redundant']);
  deq(Object.keys(T.PROSE_TELLS).sort(), [...order].sort());
  for (const kind of order) {
    for (const entry of T.PROSE_TELLS[kind]) {
      const [src, hint, flags = ''] = entry;
      assert.ok(entry.length <= 3 && typeof src === 'string' && src, `${kind}: ${src}`);
      assert.doesNotThrow(() => new RegExp(src, 'giu'), `${kind}: ${src}`);
      assert.ok(typeof hint === 'string' && hint.length && hint.length < 60, `${kind}: ${src}`);
      assert.ok(/^s?$/.test(flags), `${kind}: ${src}`);
      assert.ok(!new RegExp(`^(?:${src})$`, 'iu').test(''), `${kind}: ${src} matches the empty string`);
    }
  }
});

test('one hit per category in English', () => {
  deq(tells('The yield rose. I hope this helps!'), ['chat: I hope this helps']);
  deq(tells('It is more than just a buffer.'), ['staging: more than just']);
  deq(tells('The yield rose by 4%, cementing the method.'), ['tail: , cementing']);
  deq(tells('Notably, the yield rose by 4%.'), ['opener: Notably,']);
  deq(tells('The yield sheds light on the mechanism.'), ['stock: sheds light on']);
  deq(tells('Studies show that the yield rose by 4%.'), ['hedge: Studies show']);
  deq(tells('The yield rose due to the fact that the heat was higher.'), ['wordy: due to the fact that']);
  deq(tells('We mixed together the two buffers.'), ['redundant: mixed together']);
});

test('one hit per category in Russian', () => {
  deq(tells('Выход вырос. Надеюсь, это поможет!'), ['chat: Надеюсь, это поможет']);
  deq(tells('Речь идёт не о скорости, а о точности.'), ['staging: Речь идёт не о скорости, а о']);
  deq(tells('Выход вырос на 4 %, свидетельствуя о пользе нагрева.'), ['tail: , свидетельствуя о']);
  deq(tells('Нельзя не отметить, что выход вырос на 4 %.'), ['opener: Нельзя не отметить, что']);
  deq(tells('Этот результат проливает свет на механизм.'), ['stock: проливает свет на']);
  deq(tells('Нагрев осуществляли в течение 5 мин.'), ['filler: осуществляли']);
  deq(tells('Как известно, выход растёт при нагреве.'), ['hedge: Как известно,']);
  deq(tells('Выход вырос в связи с тем, что нагрев был сильнее.'), ['wordy: в связи с тем, что']);
  deq(tells('Мы повторили снова оба опыта.'), ['redundant: повторили снова']);
});

test('"play a vital role" and its family, and the near-misses of the stock and wordy lists', () => {
  deq(tells('Mountain soils play a vital role in the carbon balance.'), ['stock: play a vital role in']);
  deq(tells('The lid played an important role.'), ['stock: played an important role']);
  deq(tells('Cholesterol is playing a central role in membrane order.'), ['stock: playing a central role in']);
  deq(tells('The lid has a key role.'), ['stock: key role']);
  deq(tells('This is of paramount importance for the assay.'), ['stock: of paramount importance']);
  deq(tells('Lipases have attracted considerable attention.'), ['stock: have attracted considerable attention']);
  deq(tells('Heat has a strong impact on the rate.'), ['wordy: has a strong impact on']);
  deq(tells('Heat had a significant effect on the rate.'), []);
  deq(tells('It goes without saying that the rate rose.'), ['opener: It goes without saying that']);
  deq(tells('Белок играет важную роль в стабильности.'), ['stock: играет важную роль']);
  deq(tells('Белок, играющий центральную роль, связывает ион.'), ['stock: играющий центральную роль']);
  deq(tells('Температура оказывает влияние на скорость.'), ['wordy: оказывает влияние на']);
  deq(tells('Температура оказывает существенное влияние на скорость.'), ['wordy: оказывает существенное влияние на']);
  deq(tells('Скорость в значительной степени зависит от температуры.'), ['wordy: в значительной степени']);
  deq(tells('Этот вопрос привлекает пристальное внимание.'), ['stock: привлекает пристальное внимание']);
  // a role that is described, not inflated
  deq(tells('The lid plays a role in substrate binding, as Fig. 3 shows.'), []);
});

test('"данный" the demonstrative is a filler; the noun "данные" (data) is not', () => {
  for (const t of ['Данный метод прост.', 'Данная работа посвящена сорбции.', 'В данном случае сорбция быстрее.', 'В данной статье описан метод.',
    'Данные образцы прокаливали при 300 °C.', 'В данных условиях обмен идёт быстрее.', 'Данным методом получены цеолиты.',
    'Для данных условий константа выше.', 'Данные характеристики сорбента приведены ниже.', 'С данными образцами работали отдельно.']) {
    deq(tells(t).map((x) => x.split(':')[0]), ['filler'], t);
  }
  for (const t of ['По нашим данным, модификация сокращает время.', 'Данные показывают рост ёмкости.', 'Данные свидетельствуют о росте.',
    'Данные получены на образцах 2020 года.', 'Экспериментальные данные согласуются с моделью.', 'Набор данных включает 40 образцов.',
    'Для этого цеолита данные о кинетике отсутствуют.', 'Согласно данным опроса, рост слабый.', 'Данные эксперимента приведены в табл. 2.',
    'Данные экспериментов приведены в табл. 2.', 'Анализ данных занял неделю.', 'Мы сравнили данные с литературой.', 'В данной выборке эффект слабее.']) {
    deq(tells(t), [], t);
  }
});

test('sentence-start entries match only at the start of a sentence (after quotes or a list dash)', () => {
  deq(tells('The yield rose. Overall, the rate fell.'), ['opener: Overall,']);
  deq(tells('The overall, slow rate fell.'), []);
  deq(tells('Мы поступили таким образом, чтобы сравнить группы.'), []);
  deq(tells('Опыт прост. «Таким образом, вывод ясен».'), ['opener: Таким образом']);
  deq(tells('Results\n- Additionally, the rate fell.'), ['opener: Additionally,']);
  // an abbreviation does not start a new sentence: "Fig. 3. Overall" does, "Fig. Overall" (a title) does not
  deq(tells('See Fig. 3. Overall, it fell.'), ['opener: Overall,']);
});

test('normal scientific paragraphs in English and in Russian have no tells', () => {
  const en = 'Liposomes were prepared by extrusion through 100 nm filters and labelled with 0.5 mol% Laurdan (Fig. 2A). However, the generalized polarization did not change between 20 and 37 °C, which suggests that cholesterol, not temperature, set the order of the bilayer. Several samples were measured twice, and the two series agreed within 0.02 GP units. These values are lower than those reported by Smith et al. (2020) for erythrocyte membranes, probably because their vesicles contained sphingomyelin [14]. Therefore, we used the same lipid mixture in all further experiments, e.g. in the titrations of Section 3.';
  const ru = 'Липосомы получали экструзией через фильтры 100 нм и метили лаурданом (0,5 мол. %; рис. 2А). Однако обобщённая поляризация не менялась в интервале от 20 до 37 °C, что указывает на роль холестерина, а не температуры, в упорядоченности бислоя. Часть образцов измеряли дважды; две серии совпали с точностью до 0,02 единицы GP. Эти значения ниже, чем у Иванова и др. (2020) для мембран эритроцитов, вероятно, потому что их везикулы содержали сфингомиелин [14]. Поэтому во всех дальнейших опытах, т. е. в титрованиях разд. 3, использовали ту же смесь липидов.';
  deq(tells(en), []);
  deq(tells(ru), []);
  // a term that is precise in a paper is not a tell
  deq(tells('The difference was significant (p = 0.01), and facilitated diffusion was ruled out.'), []);
});
