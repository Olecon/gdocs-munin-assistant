'use strict';
// Reporting-guideline coverage (src/guidelines.js): the item lists and their licences, the batches, the parsing and the
// quote check, and the tool against recorded provider streams and the fake Docs API: a 6-item guideline in one batch,
// the table inserted with the right cells and the caption under it, undo removes both, the numbers-only form of a
// guideline whose licence is unclear (CARE), Stop between batches, and the offer.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
const { sseResponse, textRound } = require('./lib/streams');
require('./lib/fake-tables');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ctx, fresh, exec, pushTool, routeDocs;

before(async () => {
  env = await load();
  ({ T, state, ctx } = env);
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, routeDocs } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  state.settings.providers.anthropic.apiKey = 'sk-ant-T';
  state.googleConnected = true;
});

// Lines: 1 Title, 2 Methods, 3 the design sentence, 4 the sample sentence, 5 Results, 6 the result sentence.
const ITEMS = [{ p: 'Trial of X', style: 'TITLE' }, { p: 'Methods', style: 'HEADING_1' },
  { p: 'This was a randomised, double-blind trial with a 1:1 allocation.' }, { p: 'We enrolled 120 adults aged 18 to 65 years.' },
  { p: 'Results', style: 'HEADING_1' }, { p: 'The primary outcome improved by 12 points.' }];
const TEXT0 = ITEMS.map((x) => x.p).join('\n');
const FAKE = {
  name: 'FAKE 1.0', scope: 'test studies', form: 'paraphrase', url: 'https://example.org/fake', source: 'Doe et al. FAKE. J Test 2020;1:1', licence: 'CC BY 4.0',
  items: [['1', 'Design', 'trial design and allocation ratio'], ['2a', 'Participants', 'eligibility criteria'], ['2b', 'Participants', 'number enrolled'],
    ['3', 'Outcome', 'primary outcome result'], ['4', 'Registration', 'trial registry and number'], ['5', 'Funding', 'funding sources']],
};
const ANSWER = JSON.stringify({ items: [
  { id: '1', status: 'covered', line: 3, quote: 'randomised, double-blind trial with a 1:1 allocation', note: '' },
  { id: '2a', status: 'partly', line: 4, quote: 'adults aged 18 to 65 years', note: 'no exclusion criteria' },
  { id: '2b', status: 'covered', line: 9, quote: 'We enrolled 120 adults', note: '' }, // a wrong line: corrected to 4
  { id: '3', status: 'covered', line: 6, quote: 'improved by 40 points', note: '' }, // a quote that is not in the document
  { id: '4', status: 'missing', note: 'no registration' },
] }); // item 5 is not answered

// The provider: answers[i] for the i-th request (recorded); every request body is kept.
function provider(answers, hook = () => {}) {
  const bodies = [];
  ctx.fetch = routeDocs(async (url, init) => {
    if (!/api\.anthropic\.com/.test(String(url))) throw new Error('unexpected fetch ' + url);
    bodies.push(JSON.parse(init.body));
    await hook(bodies.length, init);
    return sseResponse(textRound(answers[Math.min(bodies.length - 1, answers.length - 1)]));
  });
  return bodies;
}
async function start(message = 'Check the CONSORT coverage, please.') {
  await fresh(docSpec({ items: ITEMS }));
  as.chatCtx = { docId: 'DOC123', chatId: 'c1', messages: [{ role: 'user', content: message }] };
  as.signal = new AbortController().signal;
}
const userText = (body) => body.messages[0].content.map((b) => b.text || '').join('');
const posts = () => fake.log.filter((x) => x.method === 'POST');

test('the lists: six guidelines with their sources and licences; ids unique; paraphrases of at most 12 words; CARE topics only', () => {
  const G = T.GUIDELINES;
  deq(Object.keys(G).filter((k) => k !== 'FAKE'), ['CONSORT', 'PRISMA', 'STROBE', 'ARRIVE', 'CARE', 'TRIPOD+AI']);
  deq(['CONSORT', 'PRISMA', 'STROBE', 'ARRIVE', 'CARE', 'TRIPOD+AI'].map((k) => G[k].items.length), [37, 42, 34, 38, 13, 52]);
  deq(['CONSORT', 'PRISMA', 'STROBE', 'ARRIVE', 'TRIPOD+AI'].map((k) => G[k].licence), ['CC BY 2.0', 'CC BY 4.0', 'CC BY', 'CC0', 'CC BY 4.0']);
  for (const [k, g] of Object.entries(G)) {
    assert.strictEqual(new Set(g.items.map((it) => it[0])).size, g.items.length, k);
    assert.ok(g.source && g.url.startsWith('https://'), k);
    for (const it of g.items) {
      if (g.form === 'topics') assert.strictEqual(it.length, 2, `${k} ${it[0]}`);
      else assert.ok(it[2].split(/\s+/).length <= 12, `${k} ${it[0]}: ${it[2]}`);
    }
  }
  assert.strictEqual(G.CARE.form, 'topics');
  deq(T.guidelineBatches(G.CONSORT).map((b) => b.length), [8, 8, 8, 8, 5]);
  assert.ok(T.DOC_PASS_MODES.includes('coverage') && T.DOC_PASS_TASKS.coverage === T.COVERAGE_TASK);
});

test('parsing: fences and extra text tolerated, ids of the batch only, statuses normalized', () => {
  const batch = FAKE.items.slice(0, 3);
  const m = T.parseCoverage('Here:\n```json\n{"items":[{"id":"1","status":"Covered","line":"3","quote":"q"},{"id":"2A","status":"partial"},{"id":"9","status":"covered"},{"id":"2b","status":"maybe"}]}\n```', batch);
  deq([...m.keys()], ['1', '2a']);
  deq(m.get('1'), { status: 'Covered', line: 3, quote: 'q', note: '' });
  assert.strictEqual(m.get('2a').status, 'Partly');
  assert.strictEqual(T.parseCoverage('no json', batch).size, 0);
});

test('offer: Auto with the Docs API, only when the message names a guideline or asks for a reporting checklist', async () => {
  await start('Hello there');
  const tool = T.extraTool('guideline_coverage');
  assert.ok(!T.offered(tool, 'edit', as));
  for (const msg of ['Is my paper CONSORT-compliant?', 'check PRISMA', 'Run the TRIPOD+AI items', 'a reporting checklist for my case report', 'проверь по чек-листу ARRIVE']) {
    as.chatCtx.messages = [{ role: 'user', content: msg }];
    assert.ok(T.offered(tool, 'edit', as), msg);
  }
  assert.ok(!T.offered(tool, 'manual', as));
  assert.ok(!T.offered(tool, 'edit', { ...as, docFormat: 'markdown', model: null }));
  as.chatCtx.messages = [{ role: 'user', content: 'I care about the tone' }]; // "care" is not CARE
  assert.ok(!T.offered(tool, 'edit', as));
  assert.match(tool.defs[0].function.description, /about 150 tokens per item/);
});

test('a 6-item guideline in one batch: quiet request, the table with the right cells and its caption, one undoable edit', async () => {
  T.GUIDELINES.FAKE = FAKE;
  await start('Check FAKE coverage (a reporting checklist).');
  const bodies = provider([ANSWER]);
  const r = await exec('guideline_coverage', { guideline: 'FAKE', line: 4 });
  delete T.GUIDELINES.FAKE;
  assert.strictEqual(r._ok, true, r.content);
  assert.strictEqual(bodies.length, 1);
  // a document pass: no chat history, the whole numbered document and the task, then the items
  const b = bodies[0];
  assert.strictEqual(b.messages.length, 1);
  assert.ok(!b.tools || !b.tools.length); // the document is inline: no tools
  const sys = (Array.isArray(b.system) ? b.system.map((x) => x.text).join('\n') : b.system);
  assert.ok(sys.startsWith('You check whether a document the user writes in Google Docs reports the items of a reporting guideline.'));
  const u = userText(b);
  assert.ok(u.includes('3: This was a randomised, double-blind trial with a 1:1 allocation.'), u);
  assert.ok(u.includes(T.COVERAGE_TASK));
  assert.ok(u.endsWith('Guideline: FAKE 1.0 (test studies). Items:\n1 Design: trial design and allocation ratio\n2a Participants: eligibility criteria\n2b Participants: number enrolled\n3 Outcome: primary outcome result\n4 Registration: trial registry and number\n5 Funding: funding sources'), u);
  // the document: the table after line 4, the caption under it
  const tables = fake.tables('t.0');
  assert.strictEqual(tables.length, 1);
  deq(tables[0].rows, [
    ['Item', 'Topic', 'Status', 'Where (line)', 'Note'],
    ['1', 'Design', 'Covered', '3', '«randomised, double-blind trial with a 1:1 allocation»'],
    ['2a', 'Participants', 'Partly', '4', '«adults aged 18 to 65 years» no exclusion criteria'],
    ['2b', 'Participants', 'Covered', '4', '«We enrolled 120 adults»'],
    ['3', 'Outcome', 'Covered', '', 'Quote not found in the document.'],
    ['4', 'Registration', 'Missing', '', 'no registration'],
    ['5', 'Funding', 'Not checked', '', 'No answer for this item.'],
  ]);
  const caption = 'FAKE 1.0 coverage (test studies): 3 of 6 items covered, 1 partly, 1 missing, 1 not checked. Coverage shows only whether an item is reported, not how well. Checklist: Doe et al. FAKE. J Test 2020;1:1 (CC BY 4.0).';
  const lines = fake.text('t.0').split('\n');
  assert.strictEqual(lines[4 + 35], caption); // lines 1-4, the 35 cell lines of the 7×5 table, then the caption
  assert.strictEqual(lines.slice(0, 4).join('\n'), TEXT0.split('\n').slice(0, 4).join('\n'));
  assert.strictEqual(lines[lines.length - 1], 'The primary outcome improved by 12 points.');
  assert.strictEqual(r._edit.kind, 'coverage');
  assert.match(r.content, /^Done: inserted the FAKE 1\.0 coverage table T1 \(6 items\) after line 4, with its caption below it\./);
  assert.ok(r.content.includes('\nFAKE 1.0: 3 of 6 items covered, 1 partly, 1 missing, 1 not checked. Missing: 4 Registration.\n'));
  assert.strictEqual(r._message, 'FAKE 1.0: 3 of 6 items covered, 1 partly, 1 missing, 1 not checked.');
  assert.strictEqual(posts().length, 3); // insert, fill, caption
  // undo removes the table and the caption
  pushTool(r);
  const u2 = await exec('undo_last_edit', {});
  assert.strictEqual(u2._ok, true, u2.content);
  assert.strictEqual(fake.text('t.0'), TEXT0);
  deq(fake.tables('t.0'), []);
});

test('a guideline whose licence is unclear (CARE): item numbers and topics only, said in the table caption and the result', async () => {
  await start('Check my case report against CARE.');
  const bodies = provider([JSON.stringify({ items: [{ id: '1', status: 'covered', line: 1, quote: 'Trial of X' }] }), '{"items":[]}']);
  const r = await exec('guideline_coverage', { guideline: 'care', line: null });
  assert.strictEqual(r._ok, true, r.content);
  assert.strictEqual(bodies.length, 2); // 13 items: 8 + 5
  const u = userText(bodies[0]);
  assert.ok(u.includes('Guideline: CARE (case reports). Only the item topics are given; judge by the usual content of such a section. Items:\n1 Title\n2 Key words\n3 Abstract\n'), u);
  assert.ok(userText(bodies[1]).endsWith('Items:\n9 Therapeutic intervention\n10 Follow-up and outcomes\n11 Discussion\n12 Patient perspective\n13 Informed consent'));
  assert.ok(r.content.includes("The CARE checklist's wording is not licensed for redistribution, so only item numbers and topics were used; the full items are at https://www.care-statement.org/checklist."));
  const lines = fake.text('t.0').split('\n');
  assert.ok(lines[lines.length - 1].endsWith('; item topics only, full items at https://www.care-statement.org/checklist.'), lines[lines.length - 1]);
  assert.strictEqual(fake.tables('t.0')[0].rows.length, 14);
});

test('Stop between batches: no table, the result says how far it got; an unknown guideline and a bad line are errors', async () => {
  await start('CONSORT please');
  const abort = new AbortController();
  as.signal = abort.signal;
  const bodies = provider(['{"items":[]}'], (n) => { if (n === 2) { abort.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
  const r = await exec('guideline_coverage', { guideline: 'CONSORT', line: null });
  deq([r._ok, r.content], [false, 'Error: stopped after 1 of 5 batches of CONSORT 2010 items; nothing was inserted.']);
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(posts().length, 0);
  assert.strictEqual(fake.text('t.0'), TEXT0);
  as.signal = new AbortController().signal;
  const bad = await exec('guideline_coverage', { guideline: 'MOOSE', line: null });
  assert.strictEqual(bad.content, 'Error: guideline must be one of CONSORT, PRISMA, STROBE, ARRIVE, CARE, TRIPOD+AI.');
  const far = await exec('guideline_coverage', { guideline: 'PRISMA', line: 99 });
  assert.strictEqual(far.content, 'Error: line must be an integer from 0 to 6, or null for the end.');
});
