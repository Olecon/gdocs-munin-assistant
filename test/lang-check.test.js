'use strict';
// The language check (src/lang-check.js): the classifier and its thresholds (langCounts, langOf, langOddSentences,
// asksTranslation), the beforeWrite hook on every write path through the fake Docs API (a whole paragraph translated
// without a request is refused every time, an insert or a sentence in the other language is a note, mixed scientific
// content passes silently, a Russian document edited in Russian gets nothing), whole turns with Anthropic and Munin,
// and an agent's write. Also the Markdown note of the writing check (src/prose-lists.js) on every write path.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
const { muTool, muText, oaTool, oaText, providerRouter } = require('./lib/context');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, exec, fresh;

const EN1 = 'Soil respiration was measured at five sites along the slope during two growing seasons. Respiration fell with elevation, and its temperature sensitivity rose toward the highest site. Smith et al. (2020) reported the same pattern on a southern slope.';
const RU1 = 'Дыхание почвы измеряли на пяти участках вдоль склона в течение двух вегетационных сезонов. Дыхание снижалось с высотой, а его температурная чувствительность росла к самому высокому участку. Smith et al. (2020) описали ту же картину на южном склоне.';
const EN2 = 'Collars were inserted into the soil at every plot and left to settle before the first measurement was taken.';
const EN3 = 'Respiration was highest in July at the lowest site and lowest in October at the highest site.';
const RU_SENT = 'Повреждённые коллары переустанавливали на прежнем месте через два дня после обнаружения.';
const LANG_NOTE = 'Note: the new text is in Russian; the surrounding text is in English. Keep the document\'s language unless the user asked for a translation.';
const REFUSAL = 'Refused by a check: this would replace an English paragraph with Russian text. If the user asked for a translation in this chat, call the tool again unchanged; otherwise keep the paragraph\'s language.';
// Lines: 1 title, 2 Methods (h1), 3 EN1, 4 EN2, 5 Results (h1), 6 EN3, 7 a short label.
const spec = () => docSpec({ items: [
  { p: 'Soil report', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' }, { p: EN1 }, { p: EN2 },
  { p: 'Results', style: 'HEADING_1' }, { p: EN3 }, { p: 'Figure 2' },
] });
const RU_A = 'Мы измерили дыхание почвы на пяти участках вдоль склона в течение двух сезонов вегетации.';
const RU_B = 'Дыхание снижалось с высотой, а температурная чувствительность росла к вершине склона.';
const ruSpec = () => docSpec({ items: [{ p: 'Дыхание почвы', style: 'TITLE' }, { p: 'Методика', style: 'HEADING_1' }, { p: RU_A }, { p: RU_B }] });
const user = (content) => { as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content }] }; };
const langNotes = (r) => r.content.split('\n').filter((l) => l.includes('the surrounding text is in'));

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

// ---- The classifier ------------------------------------------------------------------------------------------------
test('langOf: at least 40 letters of one alphabet and at least 75% of the Cyrillic and Latin letters', () => {
  deq([T.LANG_MIN_LETTERS, T.LANG_SHARE], [40, 0.75]);
  const ru = (n) => 'а'.repeat(n);
  const en = (n) => 'b'.repeat(n);
  deq([T.langOf(ru(40)), T.langOf(ru(39)), T.langOf(en(40)), T.langOf(en(39))], ['ru', null, 'en', null]);
  deq([T.langOf(`${ru(60)} ${en(20)}`), T.langOf(`${ru(60)} ${en(21)}`)], ['ru', null]); // 75% exactly, then just under
  deq([T.langOf(EN1), T.langOf(RU1), T.langOf(EN3)], ['en', 'ru', 'en']);
  // a Russian sentence keeps its Latin terms
  assert.strictEqual(T.langOf('Экспрессию оценивали методом ПЦР в реальном времени с красителем SYBR Green I и праймерами к гену GAPDH.'), 'ru');
});

test('langCounts: quotes, brackets, URLs and DOIs do not count; reference entries and formula lines are skipped', () => {
  deq(T.langCounts('As Ivanov (2019) showed in «Сорбция тяжёлых металлов на цеолитах», uptake rises.'), { ru: 0, en: 27 });
  deq(T.langCounts('Дыхание (soil respiration, Rs) росло; см. https://example.org/soil и doi 10.1000/abc.def.'), { ru: 15, en: 3 });
  for (const line of ['[3] Иванов И. И. Дыхание почв горных лесов // Почвоведение. 2019. Т. 52. С. 101–110.',
    '3. Ivanov I. I. Soil respiration in mountain forests. Soil Science 52 (2019) 101–110.',
    'Иванов И. И. Дыхание почв горных лесов // Почвоведение. 2019. Т. 52.', 'Smith, J. (2020). Soil respiration of mountain forests. Soil Biology 4, 1–9.',
    'ΔG = −RT ln K = −8.314 × 298 × ln(3.2) = −2.88 kJ/mol', '0.21 ± 0.03; 0.34 ± 0.05; 1,840; 12.5 %']) {
    deq(T.langCounts(line), { ru: 0, en: 0 }, line);
  }
  // a line without a year is no reference entry
  assert.strictEqual(T.langOf('1. Дыхание почвы измеряли на пяти участках вдоль склона в течение двух сезонов.'), 'ru');
});

test('langOddSentences and asksTranslation', () => {
  deq(T.langOddSentences(`${EN2} ${RU_SENT} ${EN3}`, 'en').map((s) => [s.lang, s.text]), [['ru', RU_SENT]]);
  deq(T.langOddSentences(`${EN2} Рис. 2. ${EN3}`, 'en'), []); // too short to judge
  deq(T.langOddSentences(RU_SENT, null), []);
  for (const t of ['Translate this paragraph', 'a translation, please', 'переведи этот абзац на русский', 'нужен перевод', 'напиши это по-русски',
    'по-английски, пожалуйста', 'Write it in Russian', 'put it into English', 'перепиши на английский', 'сделай на русском']) assert.ok(T.asksTranslation(t), t);
  for (const t of ['улучши этот абзац', 'Improve this paragraph', 'сократи раздел', 'Russian authors', '']) assert.ok(!T.asksTranslation(t), t);
});

// ---- The hook on the write paths -------------------------------------------------------------------------------------
test('a whole English paragraph replaced with Russian on a Russian request: refused once per call, the identical retry passes with the note', async () => {
  await fresh(spec());
  user('улучши этот абзац');
  const posts = () => fake.log.filter((x) => x.method === 'POST').length;
  let r = await exec('replace_text', { old_text: EN1, new_text: RU1 });
  deq([r._ok, r._message, r.content], [false, 'Refused by a check', REFUSAL]);
  // replace_section and edit_document the same
  r = await exec('replace_section', { heading: 'Methods', new_text: `${RU1}\n${RU_A}` });
  assert.strictEqual(r.content, REFUSAL);
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: EN2, new_text: RU_A }] });
  assert.strictEqual(r.content, REFUSAL, r.content);
  assert.strictEqual(posts(), 0);
  assert.ok(fake.text('t.0').includes(EN1) && fake.text('t.0').includes(EN2));
  // the identical call again is the model's decision (snap.langRefused): applied, the language note on its result
  r = await exec('replace_text', { old_text: EN1, new_text: RU1 });
  assert.ok(r._ok && r.content.endsWith('\n' + LANG_NOTE), r.content);
  assert.ok(fake.text('t.0').includes(RU1));
  // the reverse: a Russian paragraph replaced with English
  await fresh(ruSpec());
  user('improve this paragraph');
  r = await exec('replace_text', { old_text: RU_A, new_text: 'We measured soil respiration at five sites along the slope during two growing seasons.' });
  assert.strictEqual(r.content, 'Refused by a check: this would replace a Russian paragraph with English text. If the user asked for a translation in this chat, call the tool again unchanged; otherwise keep the paragraph\'s language.');
});

test('a translation the user asked for (message or ask_user answer, in this chat) passes without a note', async () => {
  await fresh(spec());
  user('переведи этот абзац на русский');
  const r = await exec('replace_text', { old_text: EN1, new_text: RU1 });
  assert.ok(r._ok && !langNotes(r).length, r.content);
  assert.ok(fake.text('t.0').includes(RU1));
  // the answer to an ask_user question counts as the request
  await fresh(spec());
  as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content: 'улучши абзац' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'q1', type: 'function', function: { name: 'ask_user', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'q1', content: 'The user chose: Translate it into Russian', _ok: true }] };
  deq(T.langCheck('replace_text', { region: [3, 3] }, { old_text: EN1, new_text: RU1 }, as), null);
  // a translation continued over later messages: the earlier request still counts
  as.chatCtx.messages = [{ role: 'user', content: 'переведи первый абзац на русский' }, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'теперь второй' }];
  deq(T.langCheck('replace_text', { region: [3, 3] }, { old_text: EN1, new_text: RU1 }, as), null);
  // the panel's own messages and a summary (the model's words) do not count
  as.chatCtx.messages = [{ role: 'user', content: 'Continue: translate it into Russian', _auto: true }, { role: 'user', content: 'The user asked to translate the abstract.', _summary: true },
    { role: 'user', content: 'улучши второй абзац' }];
  assert.strictEqual(T.langCheck('replace_text', { region: [3, 3] }, { old_text: EN1, new_text: RU1 }, as).refuse.slice(0, 40), 'this would replace an English paragraph ');
});

test('notes: an insert or a part of a paragraph in the other language, a sentence of it inside the right one', async () => {
  await fresh(spec());
  user('Add a sentence about the reinstalled collars');
  let r = await exec('insert_after_line', { line: 4, text: RU_SENT });
  assert.ok(r._ok && r.content.endsWith('\n' + LANG_NOTE), r.content);
  // a sentence, not the whole paragraph: a note, not a refusal
  const first = EN1.split('. ')[0] + '.';
  r = await exec('replace_text', { old_text: first, new_text: 'Дыхание почвы измеряли на пяти участках вдоль склона в течение двух сезонов.' });
  assert.ok(r._ok && r.content.endsWith('\n' + LANG_NOTE), r.content);
  // a Russian sentence added to an English paragraph
  r = await exec('replace_text', { old_text: EN2, new_text: `${EN2} ${RU_SENT}` });
  assert.ok(r._ok && r.content.endsWith(`\nNote: a sentence of the new text is in Russian ("${RU_SENT.slice(0, 40)}…"); the surrounding text is in English. Keep the document's language unless the user asked for a translation.`), r.content);
  // edit_document: an insert of its own
  await fresh(spec());
  r = await exec('edit_document', { operations: [{ op: 'insert', line: 6, text: RU_SENT }, { op: 'replace', old_text: 'highest in July', new_text: 'at its highest in July' }] });
  assert.ok(r._ok && langNotes(r).length === 1 && r.content.endsWith('\n' + LANG_NOTE), r.content);
});

test('mixed scientific content passes silently: a Russian title, a term, a reference entry, formulas and numbers, a short label', async () => {
  await fresh(spec());
  user('Improve the Methods paragraph');
  let r = await exec('replace_text', { old_text: EN2, new_text: 'Collars were inserted as described in «Методы полевых измерений дыхания почвы» and left to settle before the first measurement was taken.' });
  assert.ok(r._ok && !langNotes(r).length, r.content);
  r = await exec('replace_text', { old_text: 'Respiration was highest', new_text: 'Respiration (дыхание почвы, по Иванову) was highest' });
  assert.ok(r._ok && !langNotes(r).length, r.content);
  const insert = (text, line = 7) => T.langCheck('insert_after_line', {}, { line, text }, as);
  deq(insert('Иванов И. И. Дыхание почв горных лесов // Почвоведение. 2019. Т. 52. С. 101–110.'), null);
  deq(insert('[4] Петров П. П., Сидоров С. С. Температурная чувствительность дыхания почв. Почвоведение, 2021, 54, 12–20.'), null);
  deq(insert('ΔG = −RT ln K = −8.314 × 298 × ln(3.2) = −2.88 kJ/mol'), null);
  deq(insert('Рис. 2'), null);
  deq(insert('Таблица 1. Скорость дыхания'), null);
});

test('a Russian document edited in Russian gets nothing; the tools without new text are not checked', async () => {
  await fresh(ruSpec());
  user('улучши абзац');
  let r = await exec('replace_text', { old_text: RU_A, new_text: 'Дыхание почвы мы измерили на пяти участках вдоль склона за два сезона вегетации.' });
  assert.ok(r._ok && !langNotes(r).length, r.content);
  r = await exec('insert_after_line', { line: 4, text: RU_SENT });
  assert.ok(r._ok && !langNotes(r).length, r.content);
  for (const name of ['delete_lines', 'format_text', 'format_lines', 'remember', 'table']) deq(T.langCheck(name, {}, { text: 'English text '.repeat(10) }, as), null);
  deq(T.LANG_TOOLS, ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection', 'edit_document']);
});

// ---- Markdown in document text (the writing check), on every write path ----------------------------------------------
test('Markdown in new text is a note on every write path; an outline\'s # marks and markers stripped from old_text are not', async () => {
  const BOLD = "Note: '**first measurement**' → plain text; bold with format_text.";
  await fresh(spec());
  user('Improve the text');
  let r = await exec('replace_text', { old_text: 'first measurement', new_text: '**first measurement**' });
  assert.ok(r._ok && r.content.endsWith('\n' + BOLD), r.content);
  r = await exec('replace_all', { old_text: 'lowest', new_text: '**lowest**' });
  assert.ok(r._ok && r.content.endsWith("\nNote: '**lowest**' → plain text; bold with format_text."), r.content);
  r = await exec('insert_after_line', { line: 6, text: 'The fitted curves are in `q10_fits.csv` of the supplement.' });
  assert.ok(r._ok && r.content.endsWith("\nNote: '`q10_fits.csv`' → plain text, no backticks."), r.content);
  r = await exec('replace_section', { heading: 'Results', new_text: `## Results\n${EN3}\nFigure 2` }); // Auto: no card
  assert.ok(r._ok && r.content.includes("\nNote: '## Results' → plain text; a heading with format_lines."), r.content);
  await fresh(spec());
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: 'first measurement', new_text: '**first measurement**' }, { op: 'insert', line: 6, text: '# Discussion' }] });
  assert.ok(r._ok && r.content.includes('\n' + BOLD) && r.content.includes("\nNote: '# Discussion' → plain text; a heading with format_lines."), r.content);
  // style "outline": the # marks make the headings and never reach the document
  await fresh(spec());
  r = await exec('insert_after_line', { line: 7, text: '# Discussion\nThe slope matters.', style: 'outline' });
  assert.ok(r._ok && !r.content.includes('Note:'), r.content);
  // markers around old_text are stripped from new_text too, so none reach the document
  r = await exec('replace_text', { old_text: '**first measurement**', new_text: '**last measurement**' });
  assert.ok(r._ok && !r.content.includes("'**last measurement**'"), r.content);
});

// ---- Whole turns ---------------------------------------------------------------------------------------------------
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
  const call = (i, name, args) => (prov === 'munin' ? muTool('c' + i, name, args) : msgStart + tu(0, 'toolu_' + i, name, args) + stopTool);
  const say = (t) => (prov === 'munin' ? muText(t) : textRound(t));

  test(`a turn with ${prov}: "улучши этот абзац" translated is refused, the model sees it; a changed call is refused again`, async () => {
    const bodies = await turn(prov, [call(1, 'replace_text', { old_text: EN1, new_text: RU1 }), call(2, 'replace_text', { old_text: EN1, new_text: RU1 + ' ' }),
      say('Абзац написан по-английски; я его не переводил.')], 'улучши этот абзац');
    assert.strictEqual(bodies.length, 3);
    const results = state.messages.filter((m) => m.role === 'tool');
    deq(results.map((m) => [m._ok, m.content]), [[false, REFUSAL], [false, REFUSAL]]);
    assert.ok(JSON.stringify(bodies[1]).includes('this would replace an English paragraph with Russian text'));
    assert.ok(fake.text('t.0').includes(EN1) && !fake.text('t.0').includes(RU1));
  });

  test(`a turn with ${prov}: "переведи этот абзац на русский" is applied without a note; an inserted Russian sentence gets the note`, async () => {
    let bodies = await turn(prov, [call(1, 'replace_text', { old_text: EN1, new_text: RU1 }), say('Готово.')], 'переведи этот абзац на русский');
    assert.strictEqual(bodies.length, 2);
    let res = state.messages.filter((m) => m.role === 'tool');
    assert.ok(res[0]._ok && !res[0].content.includes(LANG_NOTE) && !/Note: (?!Section «)/.test(res[0].content), res[0].content); // only the section note
    assert.ok(fake.text('t.0').includes(RU1));
    // Anthropic: the connectivity check of the inserted paragraph answers OK in between (src/prose-tools.js; on Munin a
    // one-paragraph insert is not checked)
    bodies = await turn(prov, [call(1, 'insert_after_line', { line: 4, text: RU_SENT }), ...(prov === 'anthropic' ? [say('OK')] : []), say('Added.')], 'Add a sentence about the reinstalled collars');
    res = state.messages.filter((m) => m.role === 'tool');
    assert.ok(res[0]._ok && res[0].content.includes('\n' + LANG_NOTE), res[0].content);
    assert.ok(JSON.stringify(bodies[bodies.length - 1]).includes('the new text is in Russian; the surrounding text is in English'));
    assert.ok(fake.text('t.0').includes(RU_SENT));
  });
}

test('an agent\'s write: the translated paragraph is refused, its Markdown gets the note (OpenAI main, Munin agent)', async () => {
  for (const id of ['munin', 'openai', 'anthropic']) state.settings.providers[id].apiKey = '';
  state.settings.providers.openai.apiKey = 'sk-T'; state.settings.providers.munin.apiKey = 'k-munin'; state.settings.provider = 'openai';
  fake = fakeDocsServer(spec());
  fake.token = ident.token = 'tok-1'; ident.granted = true;
  delete env.storage['muninAgents:DOC123']; state.agents = [];
  await T.createChat();
  state.googleConnected = true; state.applyMode = 'auto';
  const { bodies, fetch } = providerRouter({
    openai: [oaTool('c_ed', 'delegate', { task: 'Improve the Methods paragraphs.', context: 'The user asked to improve them.', model: 'munin', search: false }),
      oaText('An agent edits.'), oaText('The agent reported.')],
    munin: [muTool('m1', 'replace_text', { old_text: EN1, new_text: RU1 }), muTool('m2', 'replace_text', { old_text: 'first measurement', new_text: '**first measurement**' }),
      muText('Edits made: line 4.')],
  });
  env.ctx.fetch = routeDocs(fetch);
  T.el.chat.children.length = 0;
  T.el.input.value = 'улучши раздел Methods';
  await T.sendMessage();
  await T.agentsSettled();
  assert.strictEqual(bodies.munin.length, 3);
  const sent = (i) => JSON.stringify(bodies.munin[i]);
  assert.ok(sent(1).includes('this would replace an English paragraph with Russian text'), sent(1).slice(-600));
  assert.ok(sent(2).includes("Note: '**first measurement**' → plain text; bold with format_text."), sent(2).slice(-600));
  assert.ok(fake.text('t.0').includes(EN1) && fake.text('t.0').includes('**first measurement**'));
});
