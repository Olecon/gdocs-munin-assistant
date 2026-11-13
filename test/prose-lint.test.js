'use strict';
// The prose check (src/prose-lint.js): proseTells per category in English and Russian (normal scientific prose
// gives none), the dash rate, claimDrift (numbers, citations, qualifiers), and the beforeWrite hook: a lost
// number or citation refuses once and a later write dropping the same items passes (any tool), a typed section number
// is no data number, notes on the tool result, the tools it skips; through whole turns with Anthropic and Munin.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
const { muTool, muText } = require('./lib/context');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, exec, fresh;

const EN = 'We measured the membrane order of 24 samples at 37 °C using Laurdan spectroscopy. The generalized polarization increased from 0.21 to 0.34 after cholesterol loading (p = 0.03), which suggests tighter lipid packing. Smith et al. (2020) reported a similar shift in erythrocytes. The effect was smaller in cells treated with methyl-β-cyclodextrin, as expected from earlier work [12]. The features of the spectrum did not change.';
const RU = 'Мы измерили упорядоченность мембран в 24 образцах при 37 °C методом спектроскопии лаурдана. После насыщения холестерином обобщённая поляризация выросла с 0,21 до 0,34 (p = 0,03), что указывает на более плотную упаковку липидов. Сходный сдвиг описали Иванов и др. (2020) для эритроцитов. В клетках, обработанных метил-β-циклодекстрином, эффект был слабее, как и ожидалось по ранним работам [12]. В данной выборке спектр не изменился.';
const tells = (text, stats) => T.proseTells(text, stats).map((t) => `${t.kind}: ${t.match}`);

// The test document: 1 title, 2 Methods, 3 a paragraph with numbers, a citation and a hedge, 4 Results,
// 5 a paragraph with a numeric citation, 6 a plain line.
const P3 = 'We used 5 mg of the drug (Smith, 2020), and the effect may be small.';
const P5 = 'Membrane order rose by 12% in treated cells [3].';
const spec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: P3 },
  { p: 'Results', style: 'HEADING_1' }, { p: P5 }, { p: 'Last line' },
] });

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ routeDocs, exec, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

test('proseTells: a normal scientific paragraph in English and in Russian has none', () => {
  deq(tells(EN, { dashesPer1000: 2 }), []);
  deq(tells(RU, { dashesPer1000: 12 }), []);
  deq(tells('The features of the spectrum and the key results; we certainly did not delve deeper than needed.'.replace('delve', 'look'), null), []);
});

test('proseTells: stock words and phrases (English, Russian)', () => {
  deq(tells('This pivotal study plays a key role, is crucial and underscores the landscape. It highlights the robust, seamless, vibrant and comprehensive setup; we delve into it, showcase it, foster it and leverage it. It serves as a test, stands as proof, boasts a lab and features a pump. A testament.'), [
    'stock: pivotal', 'stock: plays a key role', 'stock: crucial', 'stock: underscores', 'stock: landscape', 'stock: highlights the', 'stock: robust',
    'stock: seamless', 'stock: vibrant', 'stock: comprehensive', 'stock: delve', 'stock: showcase', 'stock: foster', 'stock: leverage',
    'stock: serves as', 'stock: stands as', 'stock: boasts', 'stock: features a', 'stock: testament',
  ]);
  // Russian bureaucratic words are their own category (filler); "Следует отметить" and "Таким образом" are run-ups
  deq(tells('Данный метод является основным. Белок играет ключевую роль в рамках модели, и в целом всё так. Следует отметить, что опыт прост. Важно отметить рост. Таким образом, вывод ясен.'), [
    'filler: Данный', 'filler: является', 'stock: играет ключевую роль', 'filler: в рамках', 'filler: в целом', 'opener: Следует отметить, что',
    'opener: Важно отметить', 'opener: Таким образом',
  ]);
  // "таким образом" inside a sentence is an ordinary phrase; "в данной выборке" is a qualifier
  deq(tells('Мы поступили таким образом, чтобы сравнить группы. В данной выборке эффект слабее.'), []);
});

test('proseTells: staging, run-ups, tails, chat residue', () => {
  deq(tells('The method is not just fast but accurate. It is not only cheap, but also simple.'), ['staging: not just fast but', 'staging: not only cheap, but']);
  deq(tells('Это не просто метод, а подход.'), ['staging: не просто метод, а']);
  deq(tells('Это не только метод, но и подход.'), []); // ordinary Russian
  // "In order to" is wordiness, not a run-up
  deq(tells('It is worth noting that the yield rose. Importantly, the rate fell. In order to test it, we heated it. It should be noted that it failed.'),
    ['opener: It is worth noting that', 'opener: Importantly,', 'wordy: In order to', 'opener: It should be noted that']);
  deq(tells('Стоит отметить, что выход вырос. Важно подчеркнуть рост.'), ['opener: Стоит отметить, что', 'opener: Важно подчеркнуть']);
  deq(tells('The yield rose, highlighting the role of heat. The rate fell, ensuring stability, reflecting the design.'),
    ['tail: , highlighting', 'tail: , ensuring', 'tail: , reflecting']);
  deq(tells('Выход вырос, подчёркивая роль нагрева. Скорость упала, отражая состав.'), ['tail: , подчёркивая', 'tail: , отражая']);
  deq(tells("Here's the revised paragraph:\nThe yield rose. I hope this helps!"), ["chat: Here's the", 'chat: I hope this helps']);
  deq(tells('Certainly! The yield rose.'), ['chat: Certainly']);
  deq(tells('Конечно, вот переписанный абзац: выход вырос.'), ['chat: Конечно', 'chat: вот переписанный']);
  deq(tells('The yield certainly rose. Here is where it fell. Это, конечно, так.'), []); // not chat residue inside the text
  // the hint travels with the hit
  deq(T.proseTells('This is crucial.').map((t) => t.hint), ['say what it does']);
});

test('proseTells: dash rate above three times the document', () => {
  const words = Array.from({ length: 36 }, (_, i) => `word${i}`);
  const text = words.slice(0, 9).join(' ') + ' — ' + words.slice(9, 18).join(' ') + ' — ' + words.slice(18, 27).join(' ') + ' – ' + words.slice(27).join(' ') + '.';
  deq(T.proseTells(text, { dashesPer1000: 20 }).map((t) => t.match), ['83.3 dashes per 1,000 words (the document: 20)']);
  deq(T.proseTells(text, { dashesPer1000: 30 }), []); // 83.3 is not above 90
  deq(T.proseTells(text, null), []); // no stats: no dash check
  deq(T.proseTells('A short — text — here.', { dashesPer1000: 0 }), []); // under 30 words
  deq(T.proseTells(text.replace(/ [—–] /g, ' '), { dashesPer1000: 0 }), []);
  assert.strictEqual(T.proseDashes('a — b – c - d 1–3 e-f'), 3);
});

test('claimDrift: numbers with units and percent, order ignored, decimal comma = point', () => {
  deq(T.claimDrift(EN, 'We measured membrane order at 37 °C. The polarization increased after cholesterol loading. A similar shift was reported (Smith et al., 2020) [12].'),
    { numbers: ['24', '0.21', '0.34', 'p = 0.03'], citations: [], qualifiers: ['suggests'] });
  deq(T.claimDrift('In 1,000 cells, 12.5% responded at 5 mg and 20 °C.', 'At 20 °C and 5 mg, 12.5 % of 1000 cells responded.'), { numbers: [], citations: [], qualifiers: [] });
  deq(T.claimDrift('Doses: 5 mg, 5 mg and 10 mg.', 'Doses: 5 mg and 10 mg.').numbers, ['5 mg']); // a repeated number counts twice
  deq(T.claimDrift('It rose by 12%.', 'It rose by 12.').numbers, ['12%']);
  deq(T.claimDrift('H2O and CO2 at 3 mM.', 'H2O and CO2.').numbers, ['3 mM']); // digits inside words are not numbers
  deq(T.claimDrift(RU, 'Мы измерили упорядоченность мембран при 37 °C. Поляризация выросла с 0.21 до 0.34. Сходный сдвиг описан (Иванов и др., 2020).'),
    { numbers: ['24', 'p = 0,03'], citations: ['[12]'], qualifiers: ['в данной выборке'] });
});

test('claimDrift: numbers compared by value; a unit change and a statistic\'s comparator change are lost', () => {
  const lost = (a, b) => T.claimDrift(a, b).numbers;
  deq(lost('induced with 0.5 mM IPTG', 'induced with 0.50 mM IPTG'), []);
  deq(lost('In 1,000 cells', 'In 1000 cells'), []);
  deq(lost('В 1 000 клеток', 'В 1000 клеток'), []);
  deq(lost('Доля 0,500.', 'Доля 0.5.'), []); // a thousands group never starts with 0
  deq(lost('at 0.5 mM', 'at 0.05 mM'), ['0.5 mM']);
  deq(lost('rose by 12.5%', 'rose by 12.50 %'), []);
  deq(lost('a range of 5–10 mg', 'a range of 5.0–10 mg'), []);
  deq(lost('a range of 5–10 mg', 'a range of 5–12 mg'), ['10 mg']);
  deq(lost('at 37 °C', 'at 37 K'), ['37 °C']);
  deq(lost('for 10 min', 'for 10 minutes'), []); // a unit on one side only
  deq(lost('5 мг на 2,5 мл', '5 mg in 2.5 mL'), []); // a translation keeps the units
  deq(lost('significant (p < 0.01)', 'significant (p = 0.01)'), ['p < 0.01']);
  deq(lost('significant (p < 0.01)', 'clearly significant (p < 0.01)'), []);
  deq(lost('significant (p<0.01)', 'significant (p ≤ 0.01)'), ['p<0.01']);
  deq(lost('p <= 0.05', 'p ≤ 0.05'), []);
  deq(lost('n > 30 patients', 'n = 30 patients'), ['n > 30']);
  deq(lost('a p-value < 0.05 and OR ≈ 2.4', 'OR ≈ 2.4 and a p-value < 0.05'), []);
  deq(lost('p = 0.03', 'P = 0.03'), []);
  deq(lost('(n = 48)', 'of 48 patients'), []); // "=" is no comparator
});

test('claimDrift: a superscript or subscript digit is the same digit; powers, units and formulas stay uncounted', () => {
  const lost = (a, b) => T.claimDrift(a, b).numbers;
  // affiliation and footnote markers that only changed their form (the reported "drops 1, 2, 3")
  deq(lost('1Institute of Physics\n2Department of Chemistry\n3Clinic', '¹ Institute of Physics\n² Department of Chemistry\n³ Clinic'), []);
  deq(lost('¹ Institute; ₂ note', '1 Institute; 2 note'), []);
  deq(lost('Yushin1,2 and Lee3', 'Yushin¹,² and Lee³'), []);
  // a real loss beside a folded marker is still a loss
  deq(lost('1Institute, 48 patients', '¹ Institute, patients'), ['48']);
  // a power, a unit's exponent or a formula is not a number of its own (as before): rewriting its form drops nothing
  deq(lost('k = 5.2 s⁻¹ in 10⁵ cells of 2 m²', 'k = 5.2 per second in 10^5 cells of 2 square metres'), []);
  deq(lost('H₂O and CO₂ at 3 mM', 'water and carbon dioxide at 3 mM'), []);
});

test('claimDrift: citation markers in both forms and DOIs; qualifiers in English and Russian', () => {
  deq(T.claimDrift('A dose (Smith, 2020; Jones & Lee, 2021) may help [1–3], doi 10.1000/xyz123.', 'A dose helps (Jones and Lee (2021)) [1, 2].'),
    { numbers: [], citations: ['10.1000/xyz123', '[3]', '(Smith, 2020)'], qualifiers: ['may'] });
  deq(T.claimDrift('Smith (2020) and Brown et al. (2019) agree [4, 5].', 'They agree (Smith, 2020; Brown et al., 2019) [4], [5].').citations, []);
  deq(T.claimDrift('Как показали Петров и др. (2018), эффект есть (Иванов, 2020).', 'Эффект есть.').citations, ['Петров и др. (2018)', '(Иванов, 2020)']);
  deq(T.claimDrift('Over 6 weeks (n = 2020) it held.', 'Over 6 weeks it held.'), { numbers: ['2020'], citations: [], qualifiers: [] }); // not a citation
  deq(T.claimDrift('This may, and might, suggest a preliminary trend in this sample; it tends to rise and is likely real; values could differ.', 'This is a trend.').qualifiers,
    ['may', 'might', 'suggest', 'preliminary', 'in this sample', 'tends to', 'likely', 'could']);
  deq(T.claimDrift('Это, возможно и вероятно, по-видимому предварительный результат в данной выборке; как правило, эффект слабее.', 'Это результат.').qualifiers,
    ['возможно', 'вероятно', 'по-видимому', 'предварительный', 'в данной выборке', 'как правило']);
  deq(T.claimDrift('Since May 2020 it holds.', 'It holds.').qualifiers, []); // the month
  deq(T.claimDrift('Nothing here.', 'Nothing here at all.'), { numbers: [], citations: [], qualifiers: [] });
});

const DROP_REFUSAL = 'the new text drops 5 mg, (Smith, 2020). Keep them or, if that is intended, tell the user and send the edit again: it will pass.';
test('hook: a write that drops a number or citation is refused once, naming them; a later write that drops only those passes, whatever its tool', async () => {
  await fresh(spec());
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  const args = { old_text: P3, new_text: 'We used the drug, and the effect may be small and clear.' };
  let r = await exec('replace_text', args);
  deq([r._ok, r._message, r.content], [false, 'Refused by a check', `Refused by a check: ${DROP_REFUSAL}`]);
  assert.strictEqual(r._detail, DROP_REFUSAL); // the card's reason
  assert.strictEqual(posts(), 0);
  // the identical retry passes, as before
  r = await exec('replace_text', args);
  assert.ok(r._ok, r.content);
  assert.strictEqual(posts(), 1);
  // the saved chat: told about the items, the model sent the edit through another tool (other arguments) and met the same
  // refusal again; now the items were named in this turn, so it passes
  await fresh(spec());
  r = await exec('replace_text', args);
  assert.ok(!r._ok && r._detail === DROP_REFUSAL, r.content);
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: P3, new_text: args.new_text + ' Done.', line: 3 }] });
  assert.ok(r._ok, r.content);
  // an item not named yet is refused, and the refusal names only it
  r = await exec('replace_all', { old_text: 'rose by 12% in', new_text: 'rose sharply in' });
  assert.strictEqual(r._detail, 'the new text drops 12%. Keep it or, if that is intended, tell the user and send the edit again: it will pass.');
  // a new turn (new snapshot) starts with an empty set
  await fresh(spec());
  r = await exec('replace_text', { old_text: 'We used 5 mg of', new_text: 'We used some of' });
  assert.ok(!r._ok && r.content.includes('drops 5 mg'), r.content);
});

test('hook: a typed section number renumbered or removed is no dropped number; a data number at a line start still is', async () => {
  const NUMBERED = () => docSpec({ items: [{ p: 'Report', style: 'TITLE' }, { p: '2 Methods', style: 'HEADING_1' },
    { p: '2.1 Model objects' }, { p: 'We used 5 mg of the drug.' }, { p: '2.3 Molecular dynamics', style: 'HEADING_2' },
    { p: '2.3.1. Partial atomic charges' }, { p: '12 samples were measured.' }, { p: '2.5 M NaCl was added.' }] });
  // a heading renumbered and renamed (replace_text), a body line's number changed with the rest kept (replace_all)
  await fresh(NUMBERED());
  let r = await exec('replace_text', { old_text: '2.3 Molecular dynamics', new_text: '2.2 MD simulations' });
  assert.ok(r._ok, r.content);
  r = await exec('replace_all', { old_text: '2.3.1. Partial', new_text: '2.2.1. Partial' });
  assert.ok(r._ok, r.content);
  r = await exec('replace_all', { old_text: '2 Methods', new_text: '3 Methods' }); // a heading through replace_all
  assert.ok(r._ok, r.content);
  // several lines in one edit_document: renumbered, a number removed, and a body line's number typed alone
  await fresh(NUMBERED());
  r = await exec('edit_document', { operations: [
    { op: 'replace', old_text: '2.3 Molecular dynamics\n2.3.1. Partial atomic charges', new_text: '2.4 Molecular dynamics\nPartial atomic charges' },
    { op: 'replace', old_text: '2.1', new_text: '2.2', line: 3 }] });
  assert.ok(r._ok, r.content);
  // a data number at the start of a line (lower case after it), a number with a unit, a real drop beside a renumbering
  await fresh(NUMBERED());
  r = await exec('replace_text', { old_text: '12 samples were measured.', new_text: '14 samples were measured.' });
  assert.ok(!r._ok && r._detail.includes('the new text drops 12.'), r.content);
  r = await exec('replace_text', { old_text: '2.5 M NaCl was added.', new_text: 'NaCl was added.' });
  assert.ok(!r._ok && r._detail.includes('the new text drops 2.5 M.'), r.content);
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: '2.1 Model objects\nWe used 5 mg of the drug.', new_text: '2.2 Model objects\nWe used the drug.' }] });
  assert.ok(!r._ok && r._detail.includes('the new text drops 5 mg.'), r.content);
  // a number in the middle of a line is not a section number
  await fresh(NUMBERED());
  r = await exec('replace_text', { old_text: 'Model objects', new_text: 'Model objects (see 2.3)' });
  assert.ok(r._ok, r.content);
  deq(T.proseCheck('replace_text', null, { old_text: 'see 2.3 Molecular', new_text: 'see 2.4 Molecular' }, as).refuse, 'the new text drops 2.3. Keep it or, if that is intended, tell the user and send the edit again: it will pass.');
});

test('hook: no refusal for a big cut, kept items, items the user named, tracked-free inserts and the tools it skips', async () => {
  await fresh(spec());
  // the new text is under 40% of the old one: an intentional cut
  let r = await exec('replace_text', { old_text: P3, new_text: 'We used the drug.' });
  assert.ok(r._ok, r.content);
  // numbers and citations kept, order changed
  await fresh(spec());
  r = await exec('replace_text', { old_text: P3, new_text: 'In this work (Smith, 2020), 5 mg of the drug was used; the effect may be small.' });
  assert.ok(r._ok && !r.content.includes('Note:'), r.content);
  // the user's message names the number: they asked to change it
  await fresh(spec());
  as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content: 'Change 5 mg to 10 mg, please.' }] };
  r = await exec('replace_text', { old_text: 'We used 5 mg of the drug', new_text: 'We used 10 mg of the drug' });
  assert.ok(r._ok, r.content);
  // the tools without old text or new text: insert, delete_lines, format_text
  await fresh(spec());
  r = await exec('delete_lines', { start: 5, end: 5 });
  assert.ok(r._ok, r.content);
  r = await exec('format_text', { old_text: 'Last line', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null });
  assert.ok(r._ok && !r.content.includes('Note:'), r.content);
  r = await exec('insert_after_line', { line: 1, text: 'We dosed 7 mg [3].' }); // [3] is in the document (provenance.js)
  assert.ok(r._ok && !r.content.includes('Note:'), r.content);
  deq(T.proseCheck('delete_lines', null, {}, as), null);
  deq(T.proseCheck('remember', null, { action: 'add', text: 'This is crucial.' }, as), null);
  deq(T.PROSE_TOOLS, ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection', 'edit_document']);
});

test('hook: a correction the user gives passes at once (each lost number has a number the user names in its place); other drops are still refused', async () => {
  const RATIOS = 'The mean ratio of the two distance peaks was 0.47 in the control and 1.10 after the substrate was added.';
  const doc = () => docSpec({ items: [{ p: 'Results', style: 'HEADING_1' }, { p: RATIOS }, { p: 'We used 5 mg and 5 mg in 10 mM buffer.' }] });
  const says = (content) => { as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content }] }; };
  const fix = { old_text: 'was 0.47 in the control and 1.10 after', new_text: 'was 0.74 in the control and 1.01 after', line: 2 };
  // the eval's case: the user's values replace the old ones in place; the first call goes through
  await fresh(doc());
  says('Mine shows 0.74 and 1.01.');
  let r = await exec('replace_text', fix);
  assert.ok(r._ok, r.content);
  // in Russian, in an edit_document replace
  await fresh(doc());
  says('У меня в таблице 0,74 и 1,01.');
  r = await exec('edit_document', { operations: [{ op: 'replace', ...fix }] });
  assert.ok(r._ok, r.content);
  // one value named, two replaced: the one with no named value in its place is still a drop
  await fresh(doc());
  says('Mine shows 0.74.');
  r = await exec('replace_text', fix);
  assert.ok(!r._ok && r.content.includes('the new text drops 1.10.'), r.content); // (and 1.01 is unknown: provenance.js)
  // a lost number with nothing in its place
  await fresh(doc());
  says('Mine shows 0.74 and 1.01.');
  r = await exec('replace_text', { old_text: 'was 0.47 in the control and 1.10 after', new_text: 'was 0.74 in the control and rose after', line: 2 });
  assert.ok(!r._ok && r.content.startsWith('Refused by a check: the new text drops 1.10.'), r.content);
  // the named number goes in by another replace of the batch: not in the lost number's place
  await fresh(doc());
  says('Mine shows 0.74.');
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: 'was 0.47 in the control', new_text: 'was lower in the control', line: 2 },
    { op: 'replace', old_text: 'We used 5 mg and 5 mg', new_text: 'We used 5 mg and 5 mg (ratio 0.74)', line: 3 }] });
  assert.ok(!r._ok && r.content.startsWith('Refused by a check: the new text drops 0.47.'), r.content);
  // another kind (a unit) in its place, or a number the user did not name: refused as before
  await fresh(doc());
  says('Use 20 mg.');
  r = await exec('replace_text', { old_text: 'in 10 mM buffer', new_text: 'in 20 mg buffer', line: 3 });
  assert.ok(!r._ok && r.content.startsWith('Refused by a check: the new text drops 10 mM.'), r.content);
  await fresh(doc()); // (in the same turn the item, named once, would pass)
  says('Fix the buffer.');
  r = await exec('replace_text', { old_text: 'in 10 mM buffer', new_text: 'in 20 mM buffer', line: 3 });
  assert.ok(!r._ok && r.content.includes('the new text drops 10 mM.'), r.content);
  // one named value stands in for one of two equal numbers
  await fresh(doc());
  says('It was 7 mg.');
  r = await exec('replace_text', { old_text: 'We used 5 mg and 5 mg in', new_text: 'We used 7 mg in', line: 3 });
  assert.ok(!r._ok && r.content.startsWith('Refused by a check: the new text drops 5 mg.'), r.content);
  r = await exec('replace_text', { old_text: 'We used 5 mg and 5 mg in', new_text: 'We used 7 mg and 7 mg in', line: 3 });
  assert.ok(r._ok, r.content);
});

test('hook: notes for new tells and lost qualifiers reach the tool result (at most 5); the old text\'s own tells are not flagged', async () => {
  await fresh(spec());
  // a qualifier lost inside a short change is quoted by the meaning-drift note of src/text-checks.js instead
  let r = await exec('replace_text', { old_text: 'the effect may be small', new_text: 'the effect is small' });
  assert.ok(r._ok, r.content);
  assert.ok(r.content.endsWith('\nNote: meaning may have shifted: "may be" → "is".') && !r.content.includes('qualifier'), r.content);
  // in a longer rewrite (no quotable pair) the qualifier note stays
  await fresh(spec());
  r = await exec('replace_text', { old_text: 'and the effect may be small', new_text: 'and the measured response of the treated cultures stayed modest throughout' });
  assert.ok(r._ok && r.content.includes("Note: the new text drops the qualifier 'may'; keep it unless the evidence changed."), r.content);
  await fresh(spec());
  r = await exec('insert_after_line', { line: 6, text: 'This crucial step underscores a pivotal and robust landscape, highlighting a key role.' });
  assert.ok(r._ok, r.content);
  const notes = r.content.split('\n').filter((l) => l.startsWith('Note: '));
  deq(notes, ["Note: 'crucial' → say what it does.", "Note: 'underscores' → \"shows\".", "Note: 'pivotal' → say what it does.",
    "Note: 'robust' → name the property.", "Note: 'landscape' → name the field."]);
  // a tell that the old text has already is the author's own wording
  await fresh(docSpec({ items: [{ p: 'T', style: 'TITLE' }, { p: 'This crucial step works.' }] }));
  r = await exec('replace_text', { old_text: 'This crucial step works.', new_text: 'This crucial step works well.' });
  assert.ok(r._ok && !r.content.includes('Note:'), r.content);
  r = await exec('replace_all', { old_text: 'step', new_text: 'pivotal step' });
  assert.ok(r._ok && r.content.endsWith("\nNote: 'pivotal' → say what it does."), r.content);
});

test('hook: replace_section is refused before its card; replace_all per occurrence', async () => {
  await fresh(spec());
  let r = await exec('replace_section', { heading: 'Results', new_text: 'Membrane order rose in treated cells, as expected.' });
  assert.strictEqual(T.pendingPreviews.size, 0); // no card: refused before it
  assert.ok(!r._ok && r.content.startsWith('Refused by a check: the new text drops 12%, [3].'), r.content);
  await fresh(docSpec({ items: [{ p: 'T', style: 'TITLE' }, { p: 'At 5 mg it held.' }, { p: 'At 5 mg it fell.' }] }));
  r = await exec('replace_all', { old_text: 'At 5 mg', new_text: 'At a low dose' });
  assert.ok(!r._ok && r.content.includes('drops 5 mg'), r.content);
});

test('text checks (src/text-checks.js): their notes reach the tool result after the prose notes, never refuse, and stay under 400 characters', async () => {
  await fresh(spec());
  // a meaning shift and a claim: notes on a successful write
  let r = await exec('replace_text', { old_text: 'Membrane order rose by 12% in treated cells [3].', new_text: 'Membrane order never rose by 12% in treated cells [3], which proves the model.' });
  assert.ok(r._ok, r.content);
  const notes = r.content.split('\n').filter((l) => l.startsWith('Note: '));
  deq(notes, ['Note: meaning may have shifted: "rose" → "never rose"; added "which proves the model".', 'Note: claims: "proves" (hype); "never" (universal claim).']);
  // a figure the document does not have, an undefined abbreviation and a wordy phrase on an insert
  await fresh(spec());
  r = await exec('insert_after_line', { line: 5, text: 'In excess of 5 mg was used [3]; the MSD grew, as Figure 2 shows.' });
  assert.ok(r._ok, r.content);
  assert.ok(r.content.includes('Note: abbreviations not defined: "MSD"') && r.content.includes('Note: wordy: "In excess of" → "more than".'), r.content);
  // churn on a fix request
  await fresh(spec());
  as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content: 'Fix the grammar in the Methods paragraph' }] };
  r = await exec('replace_text', { old_text: P3, new_text: 'As (Smith, 2020) advised, patients received 5 mg; any resulting response may stay small.' });
  assert.ok(r._ok && r.content.includes('Note: this rewrote 72% of the paragraph for a fix request; keep edits minimal unless asked to rewrite.'), r.content);
  // many findings: the text checks' notes together stay within 400 characters
  await fresh(spec());
  const many = 'This novel, groundbreaking result proves it [3]. It is known that X. It always works and never fails. It was significant. '
    + 'A mean of 5 mg [3]. Values were 3 +/- 1 and p = 0.000. In excess of 5 runs by means of a pump with the exception of one, in the vicinity of the lab. '
    + 'MSD, RDF, VACF and PMF rose, see Figures 7, 8 and Table 9.';
  r = await exec('insert_after_line', { line: 6, text: many });
  assert.ok(r._ok, r.content);
  const own = ['meaning', 'claims', 'statistics', 'not in the document', 'abbreviations', 'unit spacing', 'this rewrote', 'your text', 'wordy']
    .flatMap((k) => r.content.split('\n').filter((l) => l.startsWith('Note: ' + k)));
  assert.ok(own.length >= 3 && own.join('').length - 6 * own.length <= 400 && own.some((l) => /\+\d+ more\.$/.test(l)), r.content);
});

// One chat turn on the fake document with provider prov; rounds: the SSE texts. Returns the request bodies.
async function turn(prov, rounds, text) {
  fake = fakeDocsServer(spec());
  await T.createChat();
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = prov;
  Object.assign(state.settings.providers[prov], { apiKey: 'k-T' });
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = text;
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  return bodies;
}

for (const prov of ['anthropic', 'munin']) {
  test(`a turn with ${prov}: the refusal reaches the model, the identical retry is applied, notes follow the result`, async () => {
    const drop = { old_text: P3, new_text: 'We used the drug, and the effect may be small but clear.' };
    const ins = { line: 6, text: 'This crucial result is clear in the samples we measured last week.' }; // a sentence of prose: the section note
    const call = (i, name, args) => (prov === 'munin' ? muTool('c' + i, name, args) : msgStart + tu(0, 'toolu_' + i, name, args) + stopTool);
    // anthropic: the connectivity check of the one-paragraph insert answers OK (Munin checks 2+ paragraphs only)
    const bodies = await turn(prov, [call(1, 'replace_text', drop), call(2, 'replace_text', drop), call(3, 'insert_after_line', ins),
      ...(prov === 'munin' ? [muText('Done.')] : [textRound('OK'), textRound('Done.')])], 'Simplify the Methods paragraph');
    assert.strictEqual(bodies.length, prov === 'munin' ? 4 : 5);
    const results = state.messages.filter((m) => m.role === 'tool');
    assert.ok(results[0].content.startsWith('Refused by a check: the new text drops 5 mg, (Smith, 2020).'), results[0].content);
    assert.ok(results[1]._ok && results[1]._edit, results[1].content);
    // the prose note, then the section note of the first write into «Results» (src/prose-tools.js)
    assert.ok(results[2]._ok && results[2].content.includes("\nNote: 'crucial' → say what it does.\nNote: Section «Results»: continue its register;"), results[2].content);
    // what the provider received
    const sent = JSON.stringify(bodies[bodies.length - 1]);
    assert.ok(sent.includes('Refused by a check: the new text drops 5 mg') && sent.includes("Note: 'crucial' → say what it does."));
    assert.ok(fake.text('t.0').includes('the effect may be small but clear.') && fake.text('t.0').includes(ins.text));
  });
}
