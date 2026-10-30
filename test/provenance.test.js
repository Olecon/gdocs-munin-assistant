'use strict';
// The provenance check (src/provenance.js): which items of a new text are checked (numbers, DOIs, citation markers in
// English and Russian; not years, small integers or the numbers of places), the sources (the document, the user's
// message, this turn's tool results, the document instructions; not the check's own refusal), refuse once and let the
// identical retry pass, the prompt line, the number ripple, the placeholder count and the unbacked check claim.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, exec, fresh;

const REF_RU = 'Иванов И. И., Петрова А. Б. Липидные мембраны // Биофизика. 2020. Т. 65. doi:10.1134/S0006350920010012';
const spec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: 'Abstract', style: 'HEADING_1' },
  { p: 'We enrolled 48 patients; order rose by 12.5% (Smith, 2020).' },
  { p: 'Methods', style: 'HEADING_1' },
  { p: 'The cohort had n = 48 at 37 °C.' },
  { p: 'Conclusions', style: 'HEADING_1' },
  { p: 'All 48 patients improved [3].' },
  { p: 'References', style: 'HEADING_1' },
  { p: REF_RU },
] });
const texts = (t) => T.provItems(t).map((it) => `${it.kind}:${it.text}`);
const refused = (r) => !r._ok && r.content.startsWith('Refused by a check: these are not in the document');
const user = (content) => ({ role: 'user', content });
const withTurn = (...msgs) => { as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: msgs }; };

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

test('provItems: numbers with units and percent, DOIs, citation markers (English, Russian); not years, small integers or places', () => {
  deq(texts('Order rose by 48% at 37 °C, n = 152 (Smith, 2021); Smith et al. (2019) and (Иванов и др., 2020) [14], doi 10.1000/xyz.1.'), [
    'number:48%', 'number:37 °C', 'number:152', 'doi:10.1000/xyz.1', 'bracket:[14]', 'author:Smith et al. (2019)', 'author:(Smith, 2021)', 'author:(Иванов и др., 2020)',
  ]);
  deq(texts('In 2019 we ran 3 trials over 12 days with 5 mg; see Fig. 14, Table 22, Eq. (31), line 140, section 2.3, p. 45, рис. 15, табл. 16 и раздел 4.2.'), []);
  deq(texts('2.1 Results\n3. Item'), []);
  deq(texts('Значение 0,75 и 1 250 клеток; 13 образцов.'), ['number:0,75', 'number:250', 'number:13']);
});

test('hook: known items pass; unknown ones are refused once with the placeholder advice; the identical retry passes', async () => {
  await fresh(spec());
  withTurn(user('Add a sentence; the 48 in Methods may go.')); // prose-lint.js refuses a write that drops a number the user did not name
  let r = await exec('insert_after_line', { line: 3, text: 'Again, 48 patients and 12,50 % (Smith, 2020) [3].' });
  assert.ok(r._ok, r.content);
  const args = { line: 3, text: 'Order rose by 48% (Smith, 2021), n = 52.' };
  r = await exec('insert_after_line', args);
  assert.strictEqual(r.content, "Refused by a check: these are not in the document, your message or this turn's results: 52, (Smith, 2021). Use them only if the user gave them (then call the tool again unchanged); otherwise write the placeholder [[?]] in their place and say what is missing.");
  assert.strictEqual(T.pendingPreviews.size, 0); // no card: refused before it
  as.chatCtx.messages.push({ role: 'tool', tool_call_id: 'x', content: r.content, _ok: false });
  // a changed call is checked again, and the refusal itself is no source
  r = await exec('insert_after_line', { ...args, text: args.text + ' Done.' });
  assert.ok(refused(r), r.content);
  r = await exec('insert_after_line', args);
  assert.ok(r._ok, r.content); // the identical retry: the model's decision
  // the placeholder instead of the unknown items passes
  r = await exec('replace_text', { old_text: 'n = 48 at', new_text: 'n = [[?]] at' });
  assert.ok(r._ok, r.content);
});

test('hook: Russian references are known by surname and year near each other; an unknown one is refused', async () => {
  await fresh(spec());
  withTurn(user('Добавь ссылку.'));
  let r = await exec('insert_after_line', { line: 5, text: 'Мембраны упорядочены (Иванов и др., 2020), doi 10.1134/S0006350920010012.' });
  assert.ok(r._ok, r.content);
  r = await exec('insert_after_line', { line: 5, text: 'Ранее это показали Петров и др. (2019).' });
  assert.ok(refused(r) && r.content.includes(': Петров и др. (2019).'), r.content);
});

test('sources: the user\'s message, this turn\'s tool results and the document instructions', async () => {
  await fresh(spec());
  withTurn(user('Change n from 48 to 52 and say it rose by 61%.'));
  let r = await exec('replace_text', { old_text: 'n = 48 at', new_text: 'n = 52 at' });
  assert.ok(r._ok, r.content);
  r = await exec('insert_after_line', { line: 5, text: 'It rose by 61%.' });
  assert.ok(r._ok, r.content);
  // a find_reference result of this turn (after the user's message; an older turn's results do not count)
  await fresh(spec());
  withTurn(user('Old turn with 2.71 in it.'), { role: 'assistant', content: null, tool_calls: [{ id: 'f0', function: { name: 'find_reference', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'f0', content: 'Jones, A. (2018). Old. 99.9%' },
    user('Cite the paper.'), { role: 'assistant', content: null, tool_calls: [{ id: 'f1', function: { name: 'find_reference', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'f1', content: '1. doi:10.1000/abc.7 — Brown, K.; Lee, M. (2021). Membrane order in yeast. J. Lipids 14: 210–219. Effect 33.3%.' });
  r = await exec('insert_after_line', { line: 7, text: 'Brown and Lee (2021) saw 33.3% (doi 10.1000/abc.7).' });
  assert.ok(r._ok, r.content);
  r = await exec('insert_after_line', { line: 7, text: 'Jones (2018) saw 99.9% and 2.71.' });
  assert.ok(refused(r) && r.content.includes(': 99.9%, 2.71, Jones (2018).'), r.content);
  // the document instructions
  await fresh(spec());
  withTurn(user('Add the target.'));
  as.docInstructions = 'The target response rate is 75%.';
  r = await exec('insert_after_line', { line: 3, text: 'The target was 75%.' });
  assert.ok(r._ok, r.content);
});

test('years, small integers and the numbers of places are never refused; tools without new text are not checked', async () => {
  await fresh(spec());
  withTurn(user('Add a note.'));
  let r = await exec('insert_after_line', { line: 3, text: 'In 2019 we ran 3 trials over 12 days; see Table 14, Fig. 22 and line 140, section 2.3.' });
  assert.ok(r._ok, r.content);
  deq(T.provenanceCheck('delete_lines', null, { start: 1, end: 2 }, as), null);
  deq(T.provenanceCheck('format_text', null, { old_text: '48', bold: true }, as), null);
  deq(T.provenanceCheck('remember', null, { action: 'add', text: 'Use 77%.' }, as), null);
  deq(T.PROV_TOOLS, ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection']);
});

test('the prompt line: in Auto with the Docs API only', async () => {
  await fresh(spec());
  const head = T.buildSystemParts('edit', 1e5, as).head;
  assert.ok(head.includes('\n' + T.PROV_PROMPT_LINE + '\n'), 'in the edit rules');
  assert.ok(!T.buildSystemParts('manual', 1e5, as).head.includes(T.PROV_PROMPT_LINE));
  assert.ok(T.PROV_PROMPT_LINE.length <= 180); // about 40 tokens
});

test('ripplePairs: a changed number with the same unit; not when the old value stays, not for years', () => {
  deq(T.ripplePairs('n = 48 at 37 °C', 'n = 52 at 37 °C'), [{ old: '48', unit: '', to: '52', oldText: '48' }]);
  deq(T.ripplePairs('rose by 48%', 'rose by 0,52%'), [{ old: '48', unit: '%', to: '0.52', oldText: '48%' }]);
  deq(T.ripplePairs('from 48 to 60', 'from 48 to 52'), [{ old: '60', unit: '', to: '52', oldText: '60' }]);
  deq(T.ripplePairs('n = 48', 'n = 48 of 52'), []);
  deq(T.ripplePairs('in 2019', 'in 2020'), []);
  deq(T.ripplePairs('5 mg', '7 mg'), []); // small integers
  deq(T.ripplePairs('48 mg', '52 kg'), []); // another unit
});

test('numbers by value; a statistic\'s comparator is part of the item (provItems, ripplePairs)', () => {
  const known = (text, source) => T.provItems(text).map((it) => T.provKnown(it, [T.provIndex(source)]));
  deq(known('at 0.50 mM and 1,250 cells', 'at 0,5 mM and 1250 cells'), [true, true]);
  deq(known('(p < 0.01)', 'significant (p = 0.01)'), [false]);
  deq(known('(p = 0.01)', 'significant (p < 0.01)'), [true]); // a plain value is known by its value
  deq(known('(p < 0.01)', 'significant (p < 0.01)'), [true]);
  deq(T.provItems('at 0.50 mM').map((it) => it.key), ['0.5']);
  deq(T.provItems('(p < 0.01), n > 30, p = 0.04').map((it) => it.key), ['<0.01', '>30', '0.04']);
  deq(T.ripplePairs('at 0.5 mM', 'at 0.50 mM'), []);
  deq(T.ripplePairs('significant (p < 0.01)', 'significant (p = 0.01)'), [{ old: '<0.01', unit: '', to: '0.01', oldText: 'p < 0.01' }]);
  deq(T.ripplePairs('significant (p < 0.01)', 'clearly significant (p < 0.01)'), []);
});

// The finish notices of a turn on the snapshot as: the turn's messages are the user's message and the results.
const finish = (...results) => { const u = user('Go.'); return T.provFinish(u, as, { messages: [u, ...results] }); };

test('ripple: a changed number still standing elsewhere is reported with its lines and headings', async () => {
  await fresh(spec());
  withTurn(user('Set n from 48 to 52.'));
  const r = await exec('replace_text', { old_text: 'n = 48 at', new_text: 'n = 52 at' });
  assert.ok(r._ok && r._edit, r.content);
  deq(finish(r), ['Line 3 (Abstract) and line 7 (Conclusions) still say 48.']);
  // the old value kept in the new text: no pair, no notice
  await fresh(spec());
  withTurn(user('Say 48 then 52.'));
  const k = await exec('replace_text', { old_text: 'n = 48 at', new_text: 'n = 48, later 52, at' });
  assert.ok(k._ok, k.content);
  deq(finish(k), []);
  // a year changed: never a pair
  await fresh(docSpec({ items: [{ p: 'T', style: 'TITLE' }, { p: 'Since 2019 we tested it.' }, { p: 'In 2019 it began.' }] }));
  withTurn(user('Change the year from 2019 to 2020.'));
  const y = await exec('replace_text', { old_text: 'Since 2019', new_text: 'Since 2020' });
  assert.ok(y._ok, y.content);
  deq(finish(y), []);
});

test('finish: placeholders left after an editing turn; nothing without an edit', async () => {
  await fresh(spec());
  withTurn(user('Replace the 48 in Methods with placeholders.'));
  const r = await exec('replace_text', { old_text: 'n = 48 at', new_text: 'n = [[?]] at [[?]]' });
  assert.ok(r._ok, r.content);
  deq(finish(r), ['2 placeholders [[?]] remain in the document.']);
  deq(finish(), []); // a turn without an edit says nothing
  assert.strictEqual(T.placeholderCount('a [[?]] b'), 1);
});

test('finish: an answer that claims a check no tool call made gets a notice', async () => {
  await fresh(spec());
  const answer = (content, calls = []) => ({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map((n, i) => ({ id: 'k' + i, function: { name: n, arguments: '{}' } })) } : {}) });
  const NOTE = 'The answer claims a check that no tool call made.';
  deq(finish(answer('I verified the DOI against Crossref.')), [NOTE]);
  deq(finish(answer(null, ['read_lines']), { role: 'tool', content: 'x' }, answer('I checked it against Crossref.')), [NOTE]); // a read is no Crossref check
  deq(finish(answer(null, ['find_reference']), { role: 'tool', content: 'x' }, answer('Verified against Crossref.')), []);
  deq(finish(answer('Я проверил по Crossref, всё верно.')), [NOTE]);
  deq(finish(answer('Сверил с документом: цифры совпадают.')), [NOTE]);
  deq(finish(answer(null, ['read_lines']), { role: 'tool', content: 'x' }, answer('Сверил с документом: цифры совпадают.')), []);
  deq(finish({ role: 'assistant', content: 'Verified against the web sources.', _toolActivity: [{ name: 'web_search', text: 'q' }] }), []);
  deq(finish(answer('Here is the summary you asked for.')), []);
});

test('a chat turn: refusal, placeholder and the sticky notices after the turn', async () => {
  fake = fakeDocsServer(spec());
  await T.createChat();
  T.el.chat.children.length = 0;
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
  const bad = { old_text: 'n = 48 at', new_text: 'n = 64 at' };
  const fix = { old_text: 'n = 48 at', new_text: 'n = [[?]] at' };
  const rounds = [msgStart + tu(0, 'toolu_1', 'replace_text', bad) + stopTool, msgStart + tu(0, 'toolu_2', 'replace_text', fix) + stopTool,
    textRound('I verified the numbers against Crossref.')];
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = 'Update the cohort size 48 in Methods';
  await T.sendMessage();
  const results = state.messages.filter((m) => m.role === 'tool');
  assert.ok(refused(results[0]) && results[0].content.includes(': 64.'), results[0].content);
  assert.ok(results[1]._ok, results[1].content);
  assert.ok(JSON.stringify(bodies[1]).includes('write the placeholder [[?]]'));
  const notices = () => T.el.chat.children.filter((c) => c.className.includes('notice')).map((c) => c.innerHTML);
  await waitFor(() => notices().some((t) => t.includes('placeholder')), 'the notices');
  assert.ok(notices().includes('1 placeholder [[?]] remains in the document.'), notices().join('|'));
  assert.ok(notices().includes('The answer claims a check that no tool call made.'), notices().join('|'));
});
