'use strict';
// Russian typography in the writing check (src/prose-lint.js with vendor/typograf.min.js in check mode): the
// issues of a text (quotes, hyphens for dashes, en/em against the document, minus signs, no-break spaces), the one
// "Typography: …" note with the document's habits, Typograf's dash classification in the dash rate, the hook (the
// note reaches the tool result, the written text is exactly the model's), and the skip without the global.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh;

const NB = ' ';
// Straight quotes and two hyphens standing for dashes.
const BAD = 'Мы назвали метод "быстрым" - он прост и дёшев. Спектры снимали при 37 °C - так требует протокол.';
// The same paragraph set by the rules: «» quotes, em dashes, no-break spaces where Typograf puts them.
const CLEAN = `Мы${NB}назвали метод «быстрым»${NB}— он${NB}прост и${NB}дёшев. Спектры снимали при 37${NB}°C${NB}— так требует протокол.`;
const filler = 'клетки росли в чашке и затем погибли в среде без сыворотки';
// Three typographic dashes (direct speech twice, a range of years, a range of numbers) and one style dash.
const RANGES = `— ${filler}, — сказал он. В 1990 — 2000 годах ${filler}, и было 10 — 15 мг. Итог ${filler} — плохой.`;
const ZERO = { quotes: 0, hyphenDash: 0, enDash: 0, emDash: 0, minus: 0, nbsp: 0 };

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

test('Typograf is vendored, loaded before prose-lint.js, and is a function', () => {
  assert.strictEqual(typeof T.Typograf, 'function');
  assert.strictEqual(env.run('typeof Typograf.version === "string" || typeof Typograf.version === "function"'), true);
});

test('typographyIssues: straight quotes and hyphens in a Russian paragraph; a clean one has none; other languages are not checked', () => {
  const bad = T.typographyIssues(BAD);
  assert.strictEqual(bad.quotes, 2);
  assert.strictEqual(bad.hyphenDash, 2);
  assert.ok(bad.nbsp > 0);
  deq(T.typographyIssues(CLEAN), { ...ZERO, emDash: 2 });
  assert.strictEqual(T.typographyIssues('We called the method "fast" - it is simple.'), null);
  deq(T.typographyIssues('Температура упала до -5 °C, а затем до -12 °C.').minus, 2);
  deq(T.typographyIssues('Это – так, и то – тоже.').enDash, 2);
});

test('typographyNote: the note for a new text, nothing for a clean one or for what the old text had already', () => {
  assert.strictEqual(T.typographyNote('', BAD, {}), 'Typography: «» quotes expected; a hyphen stands for a dash in 2 places.');
  assert.strictEqual(T.typographyNote('', CLEAN, { nbsp: true, minus: true, dash: 'em' }), null);
  assert.strictEqual(T.typographyNote(BAD, BAD + ' Ещё раз.', {}), null); // the author's own habits
  assert.strictEqual(T.typographyNote('Старый текст.', BAD, {}), 'Typography: «» quotes expected; a hyphen stands for a dash in 2 places.');
  assert.strictEqual(T.typographyNote('', 'We said "yes" - twice.', {}), null);
});

test('typographyNote follows the document: its quotes, its dash, its minus signs and no-break spaces', () => {
  // a document with straight quotes keeps them; the hyphens are still wrong
  assert.strictEqual(T.typographyNote('', BAD, { quotes: '"straight"' }), 'Typography: a hyphen stands for a dash in 2 places.');
  assert.strictEqual(T.typographyNote('', 'Это – так, и то – тоже.', { dash: 'em' }), 'Typography: an en dash where the document uses — in 2 places.');
  assert.strictEqual(T.typographyNote('', 'Это — так, и то — тоже.', { dash: 'en' }), 'Typography: an em dash where the document uses – in 2 places.');
  assert.strictEqual(T.typographyNote('', 'Это — так, и то — тоже.', {}), null);
  assert.strictEqual(T.typographyNote('', 'Температура упала до -5 °C.', { minus: true }), 'Typography: a hyphen stands for a minus sign (−) in 1 place.');
  assert.strictEqual(T.typographyNote('', 'Температура упала до -5 °C.', {}), null);
  assert.ok(/^Typography: no-break spaces missing in \d+ places \(after short words, before units, in "рис\. 3"\)\.$/.test(T.typographyNote('', 'См. рис. 3 и табл. 2 в статье.', { nbsp: true })));
  // the habits measured from a document
  deq(T.typoHabits(`Он сказал «да»${NB}— и ушёл. Это${NB}— так. Ещё — раз. Минус: −5. А${NB}б${NB}в.`), { quotes: '«guillemets»', dash: 'em', nbsp: true, minus: true });
  deq(T.typoHabits('Он сказал "да" – и ушёл. Это – так. Ещё – раз.'), { quotes: '"straight"', dash: 'en', nbsp: false, minus: false });
  deq(T.typoHabits('Без тире.'), { quotes: null, dash: null, nbsp: false, minus: false });
});

test('the dash rate: ranges and direct-speech dashes are typography (Typograf), not style', () => {
  assert.strictEqual(T.proseDashes(RANGES), 5);
  assert.strictEqual(T.typographicDashes(RANGES), 4);
  deq(T.proseTells(RANGES, { dashesPer1000: 5 }), []); // one style dash: under the two the rate check needs
});

test('the hook: the typography note reaches the tool result; the written text is exactly the model\'s', async () => {
  await fresh(docSpec({ items: [{ p: 'Отчёт', style: 'TITLE' }, { p: 'Метод описан ниже; спектры снимали при 37 °C.' }] }));
  const r = await exec('insert_after_line', { line: 2, text: BAD });
  assert.ok(r._ok, r.content);
  assert.ok(r.content.endsWith('\nNote: Typography: «» quotes expected; a hyphen stands for a dash in 2 places.'), r.content);
  const doc = await T.fetchDocModel('DOC123', 't.0');
  assert.ok(doc.text.includes(BAD), doc.text); // Typograf only checked a copy
  // a clean paragraph: no typography note
  await fresh(docSpec({ items: [{ p: 'Отчёт', style: 'TITLE' }, { p: 'Метод описан ниже; спектры снимали при 37 °C.' }] }));
  const r2 = await exec('insert_after_line', { line: 2, text: CLEAN });
  assert.ok(r2._ok && !r2.content.includes('Typography'), r2.content);
});

test('without the Typograf global the typography check is skipped, the rest of the check works', async () => {
  const e2 = await load();
  e2.run('delete globalThis.Typograf');
  assert.strictEqual(e2.run('typeof Typograf'), 'undefined');
  assert.strictEqual(e2.T.typographyIssues(BAD), null);
  assert.strictEqual(e2.T.typographyNote('', BAD, {}), null);
  assert.strictEqual(e2.T.typographicDashes(BAD), 0);
  deq(e2.T.proseTells('Данный метод прост.', null).map((t) => t.kind), ['filler']);
  // without the classification every dash counts towards the rate
  deq(e2.T.proseTells(RANGES, { dashesPer1000: 5 }).map((t) => t.kind), ['dashes']);
});
